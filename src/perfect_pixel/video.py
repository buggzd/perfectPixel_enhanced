"""
Video → Perfect Pixel.

Reads a video frame-by-frame and writes a temporally stable sequence of
pixel-perfect PNG frames.

Temporal stability mechanisms (see the analysis report this module implements):

* **Multi-frame grid-size voting** (方案 1): the pixel grid size is locked from
  the median of the first ``vote_frames`` detections instead of a single frame,
  so a noisy first frame can't bias the whole video.
* **Per-frame adaptive grid + temporal constraint** (方案 2, default on): each
  frame re-runs :func:`refine_grids`, then the line positions are EMA-blended
  with the previous frame's positions (``grid_blend`` = previous-frame weight).
  Static scenes keep the grid nearly motionless; panning scenes track smoothly.
  The output cell count is locked from the first frame so every output frame
  has identical dimensions — a prerequisite for temporal filtering.
* **Deterministic sampling** (方案 5): :func:`sample_majority` uses
  ``KMEANS_PP_CENTERS`` + ``attempts=3`` and short-circuits near-uniform cells,
  removing per-frame clustering jitter.
* **Output temporal EMA** (方案 3, default on): each output pixel is
  exponentially smoothed across frames, with per-pixel change detection so hard
  edges / scene cuts pass through unblurred (no trailing).
* **Compression-artifact denoising** (方案 4, default off): an optional
  edge-preserving bilateral filter applied before analysis.

When ``adaptive_grid=False`` and ``temporal_smoothing=False`` the pipeline falls
back to the original "lock first-frame coordinates forever" behaviour.

The channel-order convention follows ``example.py``: frames are read as BGR,
converted to RGB before processing, and converted back to BGR before writing.
"""

from __future__ import annotations

import os
from typing import Callable, List, Optional, Sequence, Tuple

import cv2
import numpy as np

# Backend selection mirrors src/perfect_pixel/__init__.py: prefer the OpenCV
# backend (cv2 is required for VideoCapture anyway), fall back to the
# numpy-only implementation.
try:  # pragma: no cover - import-time branch depends on env
    from .perfect_pixel import (
        detect_grid_scale,
        get_perfect_pixel,
        refine_grids,
        sample_center,
        sample_majority,
        sample_median,
    )
except ImportError:  # pragma: no cover
    from .perfect_pixel_noCV2 import (
        detect_grid_scale,
        get_perfect_pixel,
        refine_grids,
        sample_center,
        sample_majority,
        sample_median,
    )

__all__ = [
    "analyze_keyframes",
    "process_frame",
    "process_video",
    "TemporalSmoother",
    "VideoGridTracker",
]


ProgressCallback = Callable[[int, int], None]
GridCoords = Tuple[Sequence[float], Sequence[float]]
# (nx, ny) — number of output cells along x / y (coords length is cells+1).
GridCount = Tuple[int, int]


def _fix_square(scaled_image: np.ndarray, fix_square: bool) -> np.ndarray:
    """Mirror get_perfect_pixel's square correction for direct grid sampling."""
    if not fix_square:
        return scaled_image

    refined_size_y, refined_size_x = scaled_image.shape[:2]
    if abs(refined_size_x - refined_size_y) != 1:
        return scaled_image

    if refined_size_x > refined_size_y:
        if refined_size_x % 2 == 1:
            return scaled_image[:, :-1]
        return np.concatenate([scaled_image[:1, :], scaled_image], axis=0)

    if refined_size_y % 2 == 1:
        return scaled_image[:-1, :]
    return np.concatenate([scaled_image[:, :1], scaled_image], axis=1)


def _sample_fixed_grid(
    rgb: np.ndarray,
    grid_coords: GridCoords,
    *,
    sample_method: str,
    fix_square: bool,
) -> Tuple[int, int, np.ndarray]:
    """Sample a frame using precomputed grid coordinates."""
    x_coords, y_coords = grid_coords
    if sample_method == "majority":
        out_rgb = sample_majority(rgb, x_coords, y_coords)
    elif sample_method == "median":
        out_rgb = sample_median(rgb, x_coords, y_coords)
    else:
        out_rgb = sample_center(rgb, x_coords, y_coords)

    out_rgb = _fix_square(out_rgb, fix_square)
    refined_h, refined_w = out_rgb.shape[:2]
    return refined_w, refined_h, out_rgb


def process_frame(
    rgb: np.ndarray,
    grid_size: Optional[Tuple[int, int]],
    *,
    grid_coords: Optional[GridCoords] = None,
    sample_method: str = "majority",
    refine_intensity: float = 0.25,
    fix_square: bool = True,
    min_size: float = 4.0,
    peak_width: int = 6,
) -> Tuple[Optional[int], Optional[int], np.ndarray]:
    """Refine a single RGB frame using a locked ``grid_size``.

    When ``grid_size`` is None the grid is auto-detected for this frame.
    Returns ``(refined_w, refined_h, scaled_rgb)``; on failure ``(None, None,
    original_rgb)`` (matching :func:`get_perfect_pixel`'s fallback behaviour).
    """
    if grid_coords is not None:
        return _sample_fixed_grid(
            rgb,
            grid_coords,
            sample_method=sample_method,
            fix_square=fix_square,
        )

    return get_perfect_pixel(
        rgb,
        sample_method=sample_method,
        grid_size=grid_size,
        min_size=min_size,
        peak_width=peak_width,
        refine_intensity=refine_intensity,
        fix_square=fix_square,
        debug=False,
    )


def _detect_grid(rgb: np.ndarray, peak_width: int, min_size: float) -> Optional[Tuple[int, int]]:
    gw, gh = detect_grid_scale(rgb, peak_width=peak_width, min_size=min_size)
    if gw is None or gh is None or gw <= 0 or gh <= 0:
        return None
    return int(gw), int(gh)


# ---------------------------------------------------------------------------
# 方案 1 — multi-frame grid-size voting
# ---------------------------------------------------------------------------

def _vote_grid_size(
    frames: Sequence[np.ndarray],
    n: int,
    peak_width: int,
    min_size: float,
) -> Optional[Tuple[int, int]]:
    """Lock the grid size from the median of the first ``n`` frame detections.

    A single noisy first frame can bias the whole video; taking the median over
    several detections rejects that. Returns None if every detection failed.
    """
    if n <= 0 or not frames:
        return None

    ws: List[int] = []
    hs: List[int] = []
    for frame in frames[:n]:
        g = _detect_grid(frame, peak_width, min_size)
        if g is not None:
            ws.append(g[0])
            hs.append(g[1])

    if not ws:
        return None

    ws.sort()
    hs.sort()
    return ws[len(ws) // 2], hs[len(hs) // 2]


# ---------------------------------------------------------------------------
# 方案 2 — per-frame adaptive grid + temporal constraint
# ---------------------------------------------------------------------------

def _blend_1d(prev: Sequence[float], curr: Sequence[float], prev_weight: float) -> List[float]:
    """EMA-blend two coordinate sequences: ``prev_weight * prev + (1-w) * curr``.

    Returns a list aligned to ``curr``'s length. When lengths differ (rare under
    a locked grid size) the overlap is blended and any extra ``curr`` tail is
    passed through unchanged.
    """
    curr = list(curr)
    if not prev:
        return curr
    m = min(len(prev), len(curr))
    w = float(prev_weight)
    out = [w * float(prev[i]) + (1.0 - w) * float(curr[i]) for i in range(m)]
    if len(curr) > m:
        out.extend(curr[m:])
    return out


def _fit_count(coords: Sequence[float], target: int) -> List[float]:
    """Force a coordinate sequence to span exactly ``target`` cells (len = target+1).

    Trims from the high end when too many lines were produced, or extrapolates
    using the last inter-line spacing when too few. This keeps the output frame
    dimensions identical across the whole video even if ``refine_grids``
    occasionally emits ±1 line at an edge.
    """
    coords = [float(c) for c in coords]
    need = target + 1
    if len(coords) == need:
        return coords

    if len(coords) > need:
        # Trim symmetric-ish: drop from the high end (edge cells are often partial).
        return coords[:need]

    # Too few: extrapolate at the high end using the last spacing.
    while len(coords) < need:
        if len(coords) >= 2:
            step = coords[-1] - coords[-2]
        else:
            step = 1.0
        coords.append(coords[-1] + step)
    return coords


class VideoGridTracker:
    """Per-frame grid refinement with EMA temporal constraint + locked output count."""

    def __init__(
        self,
        grid_size: Tuple[int, int],
        refine_intensity: float,
        grid_blend: float = 0.7,
    ) -> None:
        self.grid_size = grid_size
        self.refine_intensity = refine_intensity
        self.grid_blend = float(grid_blend)  # weight given to the previous frame
        self.prev_coords: Optional[GridCoords] = None
        self.locked_count: Optional[GridCount] = None

    def update(self, rgb: np.ndarray) -> GridCoords:
        gw, gh = self.grid_size
        curr_x, curr_y = refine_grids(rgb, gw, gh, self.refine_intensity)

        # First frame: record the output cell count and pass coordinates through.
        if self.prev_coords is None:
            self.locked_count = (len(curr_x) - 1, len(curr_y) - 1)
            blended = (list(curr_x), list(curr_y))
            self.prev_coords = blended
            return blended

        blended_x = _blend_1d(self.prev_coords[0], curr_x, self.grid_blend)
        blended_y = _blend_1d(self.prev_coords[1], curr_y, self.grid_blend)

        # Lock the output dimensions to the first frame's cell count.
        assert self.locked_count is not None
        blended_x = _fit_count(blended_x, self.locked_count[0])
        blended_y = _fit_count(blended_y, self.locked_count[1])

        blended = (blended_x, blended_y)
        self.prev_coords = blended
        return blended


# ---------------------------------------------------------------------------
# 方案 3 — output temporal EMA with per-pixel change detection
# ---------------------------------------------------------------------------

class TemporalSmoother:
    """Exponential moving average over output frames.

    ``alpha`` is the current frame's weight. Pixels whose colour changed by more
    than ``change_threshold`` (max channel delta on 0..255) bypass smoothing so
    hard edges and scene cuts stay sharp instead of trailing.
    """

    def __init__(self, alpha: float = 0.4, change_threshold: float = 30.0) -> None:
        self.alpha = float(alpha)
        self.change_threshold = float(change_threshold)
        self.prev: Optional[np.ndarray] = None

    def smooth(self, curr: np.ndarray) -> np.ndarray:
        if self.prev is None or self.prev.shape != curr.shape:
            self.prev = curr.astype(np.float32)
            return curr

        currf = curr.astype(np.float32)
        prev = self.prev
        diff = np.abs(currf - prev)
        changed = diff.max(axis=-1) > self.change_threshold  # (H, W) bool
        blended = self.alpha * currf + (1.0 - self.alpha) * prev
        out = np.where(changed[..., None], currf, blended)
        self.prev = out
        return np.clip(np.rint(out), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# 方案 4 — compression-artifact denoising (optional)
# ---------------------------------------------------------------------------

def _denoise(rgb: np.ndarray, strength: float) -> np.ndarray:
    """Edge-preserving bilateral filter to suppress compression block/ringing artifacts.

    Operates in BGR (matching cv2 conventions) and returns RGB.
    """
    if strength <= 0:
        return rgb
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    sigma = max(1.0, float(strength) * 6.0)
    bgr = cv2.bilateralFilter(bgr, 5, sigma, sigma)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def _keyframe_signature(rgb: np.ndarray, sample_size: int = 16) -> np.ndarray:
    small = cv2.resize(rgb, (sample_size, sample_size), interpolation=cv2.INTER_AREA)
    return small.astype(np.float32)


def _keyframe_change_score(prev_signature: np.ndarray, signature: np.ndarray) -> float:
    return float(np.mean(np.abs(prev_signature - signature)))


def _keyframe_optical_flow_score(prev_signature: np.ndarray, signature: np.ndarray) -> float:
    prev_gray = cv2.cvtColor(prev_signature.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    gray = cv2.cvtColor(signature.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    flow = cv2.calcOpticalFlowFarneback(
        prev_gray,
        gray,
        None,
        pyr_scale=0.5,
        levels=1,
        winsize=5,
        iterations=2,
        poly_n=5,
        poly_sigma=1.1,
        flags=0,
    )
    magnitude = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)
    appearance_delta = np.mean(np.abs(signature - prev_signature)) / 255.0
    return float(np.mean(magnitude) * 24.0 + appearance_delta * 40.0)


def _read_keyframe_rgb(frames_dir: str, name: str) -> np.ndarray:
    path = os.path.join(frames_dir, name)
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(f"Cannot open frame: {path}")
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2RGB)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def analyze_keyframes(
    frames_dir: str,
    output_frames: Sequence[str],
    *,
    keyframe_threshold: float = 8.0,
    keyframe_method: str = "adjacent",
) -> list[dict]:
    """Tag an existing frame sequence with keyframe metadata."""
    if keyframe_threshold < 0:
        raise ValueError("keyframe_threshold must be >= 0")
    if keyframe_method not in {"adjacent", "flow"}:
        raise ValueError("keyframe_method must be 'adjacent' or 'flow'")

    frame_metadata: list[dict] = []
    prev_signature: Optional[np.ndarray] = None
    for index, name in enumerate(output_frames):
        signature = _keyframe_signature(_read_keyframe_rgb(frames_dir, name))
        if prev_signature is None:
            change_score = 0.0
            is_keyframe = True
        elif keyframe_method == "flow":
            change_score = _keyframe_optical_flow_score(prev_signature, signature)
            is_keyframe = change_score >= keyframe_threshold
        else:
            change_score = _keyframe_change_score(prev_signature, signature)
            is_keyframe = change_score >= keyframe_threshold
        prev_signature = signature
        frame_metadata.append(
            {
                "name": name,
                "index": index,
                "is_keyframe": bool(is_keyframe),
                "change_score": round(change_score, 4),
                "keyframe_method": keyframe_method,
            }
        )

    if frame_metadata:
        frame_metadata[-1]["is_keyframe"] = True
    return frame_metadata


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------

def process_video(
    video_path: str,
    output_dir: str,
    *,
    sample_method: str = "majority",
    grid_size: Optional[Tuple[int, int]] = None,
    refine_intensity: float = 0.25,
    fix_square: bool = True,
    min_size: float = 4.0,
    peak_width: int = 6,
    output_scale: int = 1,
    every_n_frames: int = 1,
    progress_callback: Optional[ProgressCallback] = None,
    adaptive_grid: bool = True,
    grid_blend: float = 0.7,
    temporal_smoothing: bool = True,
    temporal_alpha: float = 0.4,
    scene_change_threshold: float = 30.0,
    vote_frames: int = 5,
    denoise: bool = False,
    denoise_strength: float = 5.0,
) -> dict:
    """Process a video into a sequence of pixel-perfect PNG frames.

    Args:
        video_path: Path to the input video (anything cv2 can decode).
        output_dir: Directory to write ``frame_{idx:06d}.png`` into (created
            if missing).
        grid_size: Optional ``(w, h)`` override. If None, the grid is
            auto-detected and locked (multi-frame voting by default).
        output_scale: Nearest-neighbour upscale factor applied to each refined
            frame before writing (1 = native refined size).
        every_n_frames: Frame stride. 1 = every frame, 2 = every other, ...
        progress_callback: Called as ``callback(current, total)`` after each
            written frame; ``total`` is the number of frames that will be
            written (0 if the video length is unknown).
        adaptive_grid: If True (default), re-refine the grid each frame and
            EMA-blend with the previous frame (方案 2). If False, lock the first
            frame's refined coordinates for all frames (legacy behaviour).
        grid_blend: Previous-frame weight for the grid-line EMA (方案 2).
            Higher = more stable, lower = more responsive.
        temporal_smoothing: If True (default), EMA-smooth output colours across
            frames with per-pixel change detection (方案 3).
        temporal_alpha: Current-frame weight for the output EMA (方案 3).
            Lower = smoother but slower to respond.
        scene_change_threshold: Max channel delta above which a pixel bypasses
            the temporal EMA (avoids trailing on edges / cuts).
        vote_frames: Number of leading frames used to median-vote the locked
            grid size (方案 1). Ignored when ``grid_size`` is provided.
        denoise: If True, apply edge-preserving denoising before analysis
            (方案 4). Off by default to avoid blurring clean sources.
        denoise_strength: Bilateral filter strength (方案 4).

    Returns:
        ``{grid_size:{w,h}|None, total_frames, output_frames:[...], output_dir}``
    """
    if every_n_frames < 1:
        raise ValueError("every_n_frames must be >= 1")
    if output_scale < 1:
        raise ValueError("output_scale must be >= 1")

    os.makedirs(output_dir, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Cannot open video: {video_path}")

    total_in = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # number of frames that will actually be written under the stride
    total_out = max(0, (total_in + every_n_frames - 1) // every_n_frames) if total_in > 0 else 0

    # When the caller overrides the grid size there's nothing to vote on.
    effective_vote = 0 if grid_size is not None else max(0, int(vote_frames))

    locked_grid: Optional[Tuple[int, int]] = grid_size
    locked_coords: Optional[GridCoords] = None  # legacy (adaptive_grid=False)
    tracker: Optional[VideoGridTracker] = None   # adaptive_grid=True
    smoother = TemporalSmoother(temporal_alpha, scene_change_threshold) if temporal_smoothing else None

    written: list[str] = []
    out_index = 0

    try:
        # ---- Phase 1: multi-frame voting (方案 1) --------------------------
        buffered: List[np.ndarray] = []
        frame_pos = 0
        if locked_grid is None and effective_vote > 0:
            while len(buffered) < effective_vote:
                ok, bgr = cap.read()
                if not ok:
                    break
                if frame_pos % every_n_frames == 0:
                    buffered.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                frame_pos += 1

            locked_grid = _vote_grid_size(buffered, effective_vote, peak_width, min_size)
            # Fall back to a single-frame detection if every vote failed.
            if locked_grid is None and buffered:
                locked_grid = _detect_grid(buffered[0], peak_width, min_size)

        # ---- Phase 2: process buffered frames, then the rest of the video --
        def _frame_iter():
            for fr in buffered:
                yield fr
            nonlocal frame_pos
            while True:
                ok, bgr = cap.read()
                if not ok:
                    break
                if frame_pos % every_n_frames == 0:
                    yield cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                frame_pos += 1

        for rgb in _frame_iter():
            if denoise:
                rgb = _denoise(rgb, denoise_strength)

            # Best-effort per-frame detection if we still have no locked grid.
            if locked_grid is None:
                locked_grid = _detect_grid(rgb, peak_width, min_size)

            if locked_grid is not None:
                if adaptive_grid:
                    if tracker is None:
                        tracker = VideoGridTracker(locked_grid, refine_intensity, grid_blend)
                    coords = tracker.update(rgb)
                else:
                    if locked_coords is None:
                        locked_coords = refine_grids(
                            rgb,
                            int(round(locked_grid[0])),
                            int(round(locked_grid[1])),
                            refine_intensity,
                        )
                    coords = locked_coords

                w, h, out_rgb = _sample_fixed_grid(
                    rgb,
                    coords,
                    sample_method=sample_method,
                    fix_square=fix_square,
                )
            else:
                # Detection failed entirely: fall back to per-frame auto-detect
                # (less stable, but keeps the sequence continuous).
                w, h, out_rgb = process_frame(
                    rgb,
                    None,
                    sample_method=sample_method,
                    refine_intensity=refine_intensity,
                    fix_square=fix_square,
                    min_size=min_size,
                    peak_width=peak_width,
                )

            if smoother is not None:
                out_rgb = smoother.smooth(out_rgb)

            # get_perfect_pixel falls back to returning the original image
            # (w/h None) on failure — still write it so the sequence stays
            # continuous.
            out_bgr = cv2.cvtColor(out_rgb, cv2.COLOR_RGB2BGR)
            if output_scale > 1:
                hh, ww = out_bgr.shape[:2]
                out_bgr = cv2.resize(
                    out_bgr, (ww * output_scale, hh * output_scale),
                    interpolation=cv2.INTER_NEAREST,
                )

            name = f"frame_{out_index:06d}.png"
            cv2.imwrite(os.path.join(output_dir, name), out_bgr)
            written.append(name)
            out_index += 1

            if progress_callback is not None:
                progress_callback(out_index, total_out)
    finally:
        cap.release()

    grid_result = {"w": locked_grid[0], "h": locked_grid[1]} if locked_grid else None
    return {
        "grid_size": grid_result,
        "total_frames": len(written),
        "output_frames": written,
        "output_dir": output_dir,
    }
