"""
Video → Perfect Pixel.

Reads a video frame-by-frame, locks the pixel grid size on the first frame
(auto-detected via :func:`detect_grid_scale`) and reuses it for every
subsequent frame so the output frame sequence stays temporally stable
(no per-frame grid-size flicker). Each frame is refined with
:func:`get_perfect_pixel` and written to ``output_dir`` as a PNG.

The channel-order convention follows ``example.py``: frames are read as BGR,
converted to RGB before processing, and converted back to BGR before writing.
"""

from __future__ import annotations

import os
from typing import Callable, Optional, Sequence, Tuple

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

__all__ = ["process_frame", "process_video"]


ProgressCallback = Callable[[int, int], None]
GridCoords = Tuple[Sequence[int], Sequence[int]]


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
    """Sample a frame using precomputed grid coordinates.

    Video needs temporal stability more than per-frame local refinement. Reusing
    the first frame's refined coordinates prevents gradient noise/compression
    artifacts from moving grid lines by a pixel on later frames.
    """
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
) -> dict:
    """Process a video into a sequence of pixel-perfect PNG frames.

    Args:
        video_path: Path to the input video (anything cv2 can decode).
        output_dir: Directory to write ``frame_{idx:06d}.png`` into (created
            if missing).
        grid_size: Optional ``(w, h)`` override. If None, the grid is
            auto-detected from the first frame and locked for all frames.
        output_scale: Nearest-neighbour upscale factor applied to each refined
            frame before writing (1 = native refined size).
        every_n_frames: Frame stride. 1 = every frame, 2 = every other, ...
        progress_callback: Called as ``callback(current, total)`` after each
            written frame; ``total`` is the number of frames that will be
            written (0 if the video length is unknown).

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

    locked_grid: Optional[Tuple[int, int]] = grid_size
    locked_coords: Optional[GridCoords] = None
    written: list[str] = []
    out_index = 0

    try:
        frame_pos = 0
        while True:
            ok, bgr = cap.read()
            if not ok:
                break

            if frame_pos % every_n_frames == 0:
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

                # First frame: lock the grid if not overridden.
                if locked_grid is None:
                    locked_grid = _detect_grid(rgb, peak_width, min_size)
                    # If detection fails on the first frame we leave it None;
                    # get_perfect_pixel will then auto-detect per-frame as a
                    # best-effort fallback (less stable).

                if locked_grid is not None and locked_coords is None:
                    locked_coords = refine_grids(
                        rgb,
                        int(round(locked_grid[0])),
                        int(round(locked_grid[1])),
                        refine_intensity,
                    )

                w, h, out_rgb = process_frame(
                    rgb,
                    locked_grid,
                    grid_coords=locked_coords,
                    sample_method=sample_method,
                    refine_intensity=refine_intensity,
                    fix_square=fix_square,
                    min_size=min_size,
                    peak_width=peak_width,
                )

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

            frame_pos += 1
    finally:
        cap.release()

    grid_result = {"w": locked_grid[0], "h": locked_grid[1]} if locked_grid else None
    return {
        "grid_size": grid_result,
        "total_frames": len(written),
        "output_frames": written,
        "output_dir": output_dir,
    }
