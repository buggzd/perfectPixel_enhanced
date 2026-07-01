"""
Export processed frame sequences to user-chosen locations.

The export layer reads the already-processed PNG frames written by
:func:`perfect_pixel.video.process_video` (``frame_{idx:06d}.png``) and
re-emits them in one of four formats:

* ``png_sequence``     — PNG sequence + ``manifest.json`` into a directory.
* ``gif``              — animated GIF file.
* ``sprite_sheet_4x4`` — single 4×4 PNG atlas.
* ``single_png``       — one PNG.

Exporting never re-runs the pixel-perfect pipeline; it only selects, resizes
(named via ``cv2.INTER_NEAREST``) and writes. All resizing is nearest-neighbour
so the pixel art stays crisp.

See ``docs/EXPORT_BACKEND_DESIGN.md`` for the full specification.
"""

from __future__ import annotations

import os
import string
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

__all__ = [
    "VALID_EXPORT_FORMATS",
    "ExportError",
    "select_frames",
    "compute_export_size",
    "resize_frame",
    "render_filename",
    "validate_filename_template",
    "export_png_sequence",
    "export_gif",
    "export_sprite_sheet_4x4",
    "export_single_png",
]

ProgressCallback = Callable[[int, int], None]

VALID_EXPORT_FORMATS = {
    "png_sequence",
    "gif",
    "sprite_sheet_4x4",
    "single_png",
}

_FRAME_SELECTION_MODES = {"all", "range", "indices", "current"}
_SIZE_MODES = {"source", "scale", "custom"}
_FIT_MODES = {"fit", "exact"}
_SPRITE_PAD_MODES = {"repeat_last", "transparent", "error"}

# Filename template variables understood by :func:`render_filename`.
_TEMPLATE_VARS = {"project", "index", "source_index", "source", "fps", "width", "height"}
# A template must use at least one of these to guarantee unique filenames.
_UNIQUENESS_VARS = {"index", "source_index"}


class ExportError(Exception):
    """Raised for user-facing export failures (bad params, conflicts, IO).

    The message is safe to return verbatim as an HTTP ``detail`` string.
    """


# ---------------------------------------------------------------------------
# Frame selection
# ---------------------------------------------------------------------------

def select_frames(
    frame_selection: Dict[str, Any],
    *,
    total_frames: int,
    processed_fps: Optional[float],
) -> List[int]:
    """Resolve a ``frame_selection`` spec to a list of source-frame indices.

    ``total_frames`` is the number of processed frames available (len of the
    job's ``output_frames``). Returned indices are 0-based positions into that
    sequence. Raises :class:`ExportError` on an empty/invalid selection.
    """
    if not isinstance(frame_selection, dict):
        raise ExportError("frame_selection must be an object")
    mode = frame_selection.get("mode", "all")
    if mode not in _FRAME_SELECTION_MODES:
        raise ExportError(
            f"frame_selection.mode must be one of {sorted(_FRAME_SELECTION_MODES)}"
        )
    if total_frames <= 0:
        raise ExportError("no processed frames to export")

    every_n = int(frame_selection.get("every_n_frames", 1) or 1)
    if every_n < 1:
        raise ExportError("every_n_frames must be >= 1")

    # 1. base list from mode
    if mode == "all":
        base = list(range(total_frames))
    elif mode == "range":
        start = int(frame_selection.get("start", 0))
        end = int(frame_selection.get("end", total_frames - 1))
        if start < 0 or end >= total_frames or start > end:
            raise ExportError(
                f"frame range [{start},{end}] out of bounds for {total_frames} frames"
            )
        base = list(range(start, end + 1))
    elif mode == "indices":
        raw = frame_selection.get("indices")
        if not isinstance(raw, list) or not raw:
            raise ExportError("frame_selection.indices must be a non-empty list")
        base = []
        for i in raw:
            try:
                idx = int(i)
            except (TypeError, ValueError):
                raise ExportError(f"invalid frame index: {i!r}")
            if idx < 0 or idx >= total_frames:
                raise ExportError(
                    f"frame index {idx} out of bounds for {total_frames} frames"
                )
            base.append(idx)
    else:  # current
        start = int(frame_selection.get("start", 0))
        if start < 0 or start >= total_frames:
            raise ExportError(
                f"current frame index {start} out of bounds for {total_frames} frames"
            )
        base = [start]

    # 2. apply every_n_frames
    if every_n > 1:
        base = base[::every_n]

    if not base:
        raise ExportError("frame selection resolved to zero frames")

    # 3. target_fps time-axis resampling
    target_fps = frame_selection.get("target_fps")
    eff_fps = (processed_fps / every_n) if processed_fps else None
    if target_fps is not None:
        try:
            target_fps = float(target_fps)
        except (TypeError, ValueError):
            raise ExportError("target_fps must be a number")
        if target_fps <= 0:
            raise ExportError("target_fps must be > 0")
        if eff_fps and eff_fps > target_fps:
            step = eff_fps / target_fps
            resampled: List[int] = []
            k = 0
            while True:
                pos = round(k * step)
                if pos >= len(base):
                    break
                resampled.append(base[pos])
                k += 1
            base = resampled if resampled else base

    # 4. max_frames cap
    max_frames = frame_selection.get("max_frames")
    if max_frames is not None:
        try:
            max_frames = int(max_frames)
        except (TypeError, ValueError):
            raise ExportError("max_frames must be an integer")
        if max_frames < 1:
            raise ExportError("max_frames must be >= 1")
        base = base[:max_frames]

    if not base:
        raise ExportError("frame selection resolved to zero frames")
    return base


def _apply_sprite_16_rule(
    indices: List[int], pad_mode: str
) -> List[Optional[int]]:
    """Pad/truncate a frame list to exactly 16 entries for a 4×4 sheet.

    Returns a 16-length list; entries are source indices or ``None`` for
    transparent padding cells.
    """
    if len(indices) >= 16:
        return indices[:16]
    out: List[Optional[int]] = list(indices)
    need = 16 - len(out)
    if pad_mode == "error":
        raise ExportError(
            f"sprite_sheet_4x4 needs 16 frames, got {len(indices)} (pad=error)"
        )
    if pad_mode == "repeat_last":
        last = indices[-1]
        out.extend([last] * need)
    else:  # transparent
        out.extend([None] * need)
    return out


# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------

def compute_export_size(
    size: Dict[str, Any],
    source_w: int,
    source_h: int,
) -> Tuple[int, int, Tuple[int, int, int, int], bool]:
    """Resolve a ``size`` spec against a source frame's dimensions.

    Returns ``(out_w, out_h, bg_bgra, has_alpha)`` where ``bg_bgra`` is the
    padding background (only relevant for ``custom`` + ``fit``) and
    ``has_alpha`` is True when that background is partially transparent.
    """
    if not isinstance(size, dict):
        raise ExportError("size must be an object")
    mode = size.get("mode", "source")
    if mode not in _SIZE_MODES:
        raise ExportError(f"size.mode must be one of {sorted(_SIZE_MODES)}")

    bg_bgra = _parse_color(size.get("background", "#00000000"))
    has_alpha = bg_bgra[3] < 255

    if mode == "source":
        return source_w, source_h, bg_bgra, False
    if mode == "scale":
        scale = int(size.get("scale", 1))
        if scale < 1 or scale > 32:
            raise ExportError("size.scale must be in [1, 32]")
        return source_w * scale, source_h * scale, bg_bgra, False

    # custom
    width = size.get("width")
    height = size.get("height")
    if width is None or height is None:
        raise ExportError("size.custom requires width and height")
    width, height = int(width), int(height)
    if not (1 <= width <= 8192) or not (1 <= height <= 8192):
        raise ExportError("size width/height must be in [1, 8192]")
    fit = size.get("fit", "fit")
    if fit not in _FIT_MODES:
        raise ExportError(f"size.fit must be one of {sorted(_FIT_MODES)}")
    keep_aspect = bool(size.get("keep_aspect", True))

    if fit == "exact" or not keep_aspect:
        return width, height, bg_bgra, has_alpha

    # fit + keep_aspect: output canvas is (width, height); the frame is scaled
    # to fit inside preserving aspect, padded with background.
    return width, height, bg_bgra, has_alpha


def _parse_color(hex_str: str) -> Tuple[int, int, int, int]:
    """Parse ``#RRGGBBAA`` / ``#RRGGBB`` / ``#RGB`` → BGRA tuple."""
    if not isinstance(hex_str, str) or not hex_str.startswith("#"):
        raise ExportError(f"invalid background color: {hex_str!r}")
    h = hex_str[1:]
    if len(h) == 3:
        r, g, b = (int(c * 2, 16) for c in h)
        a = 255
    elif len(h) == 6:
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        a = 255
    elif len(h) == 8:
        r, g, b, a = (int(h[i:i + 2], 16) for i in (0, 2, 4, 6))
    else:
        raise ExportError(f"invalid background color: {hex_str!r}")
    return b, g, r, a  # BGRA


def resize_frame(
    img: np.ndarray,
    size: Dict[str, Any],
    source_w: int,
    source_h: int,
) -> np.ndarray:
    """Resize a single BGR frame per a ``size`` spec (nearest-neighbour).

    Returns BGR for opaque outputs or BGRA when the ``custom``+``fit`` padding
    background has alpha.
    """
    out_w, out_h, bg_bgra, has_alpha = compute_export_size(size, source_w, source_h)
    has_alpha = has_alpha or (img.ndim == 3 and img.shape[2] == 4)
    mode = size.get("mode", "source")

    if mode == "source":
        return img
    if mode == "scale":
        scale = int(size.get("scale", 1))
        return cv2.resize(img, (source_w * scale, source_h * scale),
                          interpolation=cv2.INTER_NEAREST)

    # custom
    fit = size.get("fit", "fit")
    keep_aspect = bool(size.get("keep_aspect", True))
    if fit == "exact" or not keep_aspect:
        return cv2.resize(img, (out_w, out_h), interpolation=cv2.INTER_NEAREST)

    # fit + keep_aspect: scale to fit inside (out_w, out_h), center on canvas.
    src_h, src_w = img.shape[:2]
    scale = min(out_w / src_w, out_h / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    scaled = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_NEAREST)

    channels = 4 if has_alpha else 3
    canvas = np.full((out_h, out_w, channels), bg_bgra[:channels], dtype=np.uint8)
    x0 = (out_w - new_w) // 2
    y0 = (out_h - new_h) // 2
    if channels == 4 and scaled.shape[2] == 3:
        # promote scaled BGR to BGRA, fully opaque, then blit
        scaled = np.dstack([scaled, np.full(scaled.shape[:2], 255, dtype=np.uint8)])
    canvas[y0:y0 + new_h, x0:x0 + new_w] = scaled
    return canvas


# ---------------------------------------------------------------------------
# Filename template
# ---------------------------------------------------------------------------

class _SafeFormatDict(dict):
    """dict for str.format_map that leaves unknown placeholders untouched."""

    def __missing__(self, key: str) -> str:  # type: ignore[override]
        return "{" + key + "}"


def validate_filename_template(template: str) -> None:
    """Raise :class:`ExportError` if ``template`` is not a valid filename template."""
    if not isinstance(template, str) or not template.strip():
        raise ExportError("filename_template must be a non-empty string")
    if "/" in template or "\\" in template or os.sep in template:
        raise ExportError("filename_template must not contain path separators")
    if any(ord(c) < 32 for c in template):
        raise ExportError("filename_template must not contain control characters")

    fields = set()
    for _literal, field_name, _spec, _conv in string.Formatter().parse(template):
        if field_name is None:
            continue
        # field_name may be "index" or "index.attr"; take the base name.
        name = field_name.split(".", 1)[0].split("[", 1)[0]
        if name:
            fields.add(name)
            if name not in _TEMPLATE_VARS:
                raise ExportError(
                    f"filename_template uses unknown variable '{{{name}}}'"
                )

    if not (fields & _UNIQUENESS_VARS):
        raise ExportError(
            "filename_template must contain {index} or {source_index} for uniqueness"
        )


def render_filename(template: str, variables: Dict[str, Any]) -> str:
    """Render a filename template, forcing a ``.png`` suffix."""
    name = template.format_map(_SafeFormatDict(variables))
    if not name.lower().endswith(".png"):
        name = os.path.splitext(name)[0] + ".png"
    return name


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_frame(frames_dir: str, frame_name: str) -> np.ndarray:
    path = os.path.join(frames_dir, frame_name)
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ExportError(f"failed to read processed frame: {frame_name}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return img


def _frame_dims(frames_dir: str, frame_name: str) -> Tuple[int, int]:
    img = _read_frame(frames_dir, frame_name)
    h, w = img.shape[:2]
    return w, h


# ---------------------------------------------------------------------------
# Exporters
# ---------------------------------------------------------------------------

def export_png_sequence(
    frames_dir: str,
    output_frames: Sequence[str],
    output_path: str,
    *,
    filename_template: str,
    index_start: int,
    overwrite: bool,
    frame_selection: Dict[str, Any],
    processed_fps: Optional[float],
    size: Dict[str, Any],
    fps: Optional[float],
    project_name: str,
    source_name: str,
    on_progress: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    """Write selected frames as a PNG sequence + ``manifest.json``."""
    validate_filename_template(filename_template)
    indices = select_frames(
        frame_selection, total_frames=len(output_frames), processed_fps=processed_fps
    )

    # output_path must be a directory (create if missing); reject if a file.
    if os.path.exists(output_path) and not os.path.isdir(output_path):
        raise ExportError("output_path must be a directory for png_sequence")
    os.makedirs(output_path, exist_ok=True)

    src_w, src_h = _frame_dims(frames_dir, output_frames[indices[0]])

    # Pre-generate target paths and check for conflicts before writing anything.
    targets: List[Tuple[int, str, str]] = []  # (source_index, src_name, out_path)
    seen: set = set()
    for i, src_idx in enumerate(indices):
        src_name = output_frames[src_idx]
        variables = {
            "project": project_name,
            "source": source_name,
            "index": index_start + i,
            "source_index": src_idx,
            "fps": int(fps) if fps else 0,
            "width": src_w,
            "height": src_h,
        }
        fname = render_filename(filename_template, variables)
        if fname in seen:
            raise ExportError(f"filename_template produced duplicate name: {fname}")
        seen.add(fname)
        out_path = os.path.join(output_path, fname)
        if not overwrite and os.path.exists(out_path):
            raise ExportError(
                f"output_path already exists and overwrite=false: {out_path}"
            )
        targets.append((src_idx, src_name, out_path))

    written: List[str] = []
    total = len(targets)
    manifest_frames = []
    for i, (src_idx, src_name, out_path) in enumerate(targets):
        img = _read_frame(frames_dir, src_name)
        out = resize_frame(img, size, src_w, src_h)
        if not cv2.imwrite(out_path, out):
            raise ExportError(f"failed to write frame: {out_path}")
        written.append(out_path)
        manifest_frames.append({
            "file": os.path.basename(out_path),
            "source": src_name,
            "source_index": src_idx,
        })
        if on_progress is not None:
            on_progress(i + 1, total)

    out_w, out_h, _bg, _alpha = compute_export_size(size, src_w, src_h)
    manifest = {
        "format": "png_sequence",
        "fps": fps,
        "width": out_w,
        "height": out_h,
        "frames": manifest_frames,
    }
    manifest_path = os.path.join(output_path, "manifest.json")
    import json
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    written.append(manifest_path)

    return {"written_files": written, "manifest": manifest}


def _load_resized_frames(
    frames_dir: str,
    output_frames: Sequence[str],
    indices: Sequence[int],
    size: Dict[str, Any],
    on_progress: Optional[ProgressCallback],
    progress_scale: float = 1.0,
    progress_floor: float = 0.0,
) -> Tuple[List[np.ndarray], int, int, bool]:
    """Read + resize the selected frames into memory. Returns (frames, w, h, has_alpha)."""
    src_w, src_h = _frame_dims(frames_dir, output_frames[indices[0]])
    _out_w, _out_h, _bg, has_alpha = compute_export_size(size, src_w, src_h)
    total = len(indices)
    frames: List[np.ndarray] = []
    for i, src_idx in enumerate(indices):
        img = _read_frame(frames_dir, output_frames[src_idx])
        has_alpha = has_alpha or (img.ndim == 3 and img.shape[2] == 4)
        frames.append(resize_frame(img, size, src_w, src_h))
        if on_progress is not None:
            done = progress_floor + progress_scale * ((i + 1) / total if total else 1.0)
            _report_fraction(on_progress, done)
    return frames, src_w, src_h, has_alpha


def _report_fraction(cb: ProgressCallback, fraction: float) -> None:
    """Adapter: report fractional progress as (current=round(frac*1000), total=1000)."""
    cb(max(0, min(1000, int(round(fraction * 1000)))), 1000)


def _composite_on_background(img: np.ndarray, bg_bgra: Tuple[int, int, int, int]) -> np.ndarray:
    """Flatten a BGRA image onto an opaque background → BGR (for GIF)."""
    if img.shape[2] == 3:
        return img
    b, g, r, _a = bg_bgra
    bg = np.full(img.shape[:2] + (3,), (b, g, r), dtype=np.uint8)
    alpha = img[:, :, 3:4].astype(np.float32) / 255.0
    fg = img[:, :, :3].astype(np.float32)
    out = fg * alpha + bg.astype(np.float32) * (1.0 - alpha)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def export_gif(
    frames_dir: str,
    output_frames: Sequence[str],
    output_path: str,
    *,
    fps: float,
    loop: bool,
    overwrite: bool,
    frame_selection: Dict[str, Any],
    processed_fps: Optional[float],
    size: Dict[str, Any],
    on_progress: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    """Write selected frames as an animated GIF."""
    if not (1.0 <= float(fps) <= 60.0):
        raise ExportError("fps must be in [1, 60]")
    if os.path.exists(output_path) and not os.path.isfile(output_path):
        raise ExportError("output_path for gif must be a file path")
    if not overwrite and os.path.exists(output_path):
        raise ExportError(
            f"output_path already exists and overwrite=false: {output_path}"
        )
    parent = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(parent, exist_ok=True)

    indices = select_frames(
        frame_selection, total_frames=len(output_frames), processed_fps=processed_fps
    )
    bg_bgra = _parse_color(size.get("background", "#00000000"))

    # read + resize (progress 0 → 0.9)
    frames, _w, _h, has_alpha = _load_resized_frames(
        frames_dir, output_frames, indices, size,
        on_progress=on_progress, progress_scale=0.9, progress_floor=0.0,
    )

    # GIF has no full alpha → flatten onto background (still BGR, cv2 order).
    flat_frames = [_composite_on_background(f, bg_bgra) for f in frames]

    # imageio/pillow interpret the array as RGB, but our frames are cv2 BGR —
    # convert before encoding so red/blue aren't swapped.
    rgb_frames = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in flat_frames]

    duration_ms = max(20, int(round(1000.0 / float(fps))))
    try:
        import imageio.v3 as iio
        iio.imwrite(
            output_path,
            np.stack(rgb_frames, axis=0) if rgb_frames else np.zeros((1, 1, 3), np.uint8),
            plugin="pillow",
            duration=duration_ms,
            loop=0 if loop else 1,
            mode="RGB",
        )
    except Exception as exc:  # noqa: BLE001
        raise ExportError(f"GIF encoding failed: {exc}")

    if on_progress is not None:
        _report_fraction(on_progress, 1.0)

    return {"written_files": [output_path], "fps": fps, "loop": loop,
            "frame_count": len(rgb_frames)}


def export_sprite_sheet_4x4(
    frames_dir: str,
    output_frames: Sequence[str],
    output_path: str,
    *,
    overwrite: bool,
    frame_selection: Dict[str, Any],
    processed_fps: Optional[float],
    size: Dict[str, Any],
    fps: Optional[float],
    pad_mode: str,
    project_name: str,
    source_name: str,
    on_progress: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    """Write a 4×4 PNG sprite sheet (left-to-right, top-to-bottom)."""
    if pad_mode not in _SPRITE_PAD_MODES:
        raise ExportError(f"sprite pad mode must be one of {sorted(_SPRITE_PAD_MODES)}")
    if os.path.exists(output_path) and not os.path.isfile(output_path):
        raise ExportError("output_path for sprite_sheet must be a file path")
    if not overwrite and os.path.exists(output_path):
        raise ExportError(
            f"output_path already exists and overwrite=false: {output_path}"
        )
    parent = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(parent, exist_ok=True)

    indices = select_frames(
        frame_selection, total_frames=len(output_frames), processed_fps=processed_fps
    )
    cells = _apply_sprite_16_rule(indices, pad_mode)  # 16 entries, None=transparent

    src_w, src_h = _frame_dims(frames_dir, output_frames[indices[0]])
    out_w, out_h, bg_bgra, has_alpha = compute_export_size(size, src_w, src_h)
    first = _read_frame(frames_dir, output_frames[indices[0]])
    has_alpha = has_alpha or (first.ndim == 3 and first.shape[2] == 4)
    channels = 4 if has_alpha else 3
    canvas = np.full((out_h * 4, out_w * 4, channels), bg_bgra[:channels], dtype=np.uint8)

    manifest_frames = []
    total = len(cells)
    for i, src_idx in enumerate(cells):
        row, col = divmod(i, 4)
        x0, y0 = col * out_w, row * out_h
        if src_idx is None:
            # transparent cell — leave background
            manifest_frames.append({
                "source": None, "source_index": None,
                "x": x0, "y": y0, "w": out_w, "h": out_h,
            })
        else:
            src_name = output_frames[src_idx]
            img = _read_frame(frames_dir, src_name)
            cell = resize_frame(img, size, src_w, src_h)
            if cell.shape[2] < channels:
                cell = np.dstack([cell, np.full(cell.shape[:2], 255, dtype=np.uint8)])
            canvas[y0:y0 + out_h, x0:x0 + out_w] = cell
            manifest_frames.append({
                "source": src_name, "source_index": src_idx,
                "x": x0, "y": y0, "w": out_w, "h": out_h,
            })
        if on_progress is not None:
            _report_fraction(on_progress, (i + 1) / total if total else 1.0)

    if not cv2.imwrite(output_path, canvas):
        raise ExportError(f"failed to write sprite sheet: {output_path}")

    manifest = {
        "format": "sprite_sheet_4x4",
        "file": os.path.basename(output_path),
        "fps": fps,
        "frame_width": out_w,
        "frame_height": out_h,
        "columns": 4,
        "rows": 4,
        "frames": manifest_frames,
    }
    return {"written_files": [output_path], "manifest": manifest}


def export_single_png(
    frames_dir: str,
    output_frames: Sequence[str],
    output_path: str,
    *,
    overwrite: bool,
    frame_selection: Dict[str, Any],
    processed_fps: Optional[float],
    size: Dict[str, Any],
    on_progress: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    """Write exactly one frame as a PNG."""
    if os.path.exists(output_path) and not os.path.isfile(output_path):
        raise ExportError("output_path for single_png must be a file path")
    if not overwrite and os.path.exists(output_path):
        raise ExportError(
            f"output_path already exists and overwrite=false: {output_path}"
        )
    parent = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(parent, exist_ok=True)

    indices = select_frames(
        frame_selection, total_frames=len(output_frames), processed_fps=processed_fps
    )
    if len(indices) > 1:
        raise ExportError(
            "single_png requires exactly one frame; frame_selection resolved to "
            f"{len(indices)}"
        )
    src_idx = indices[0]
    src_name = output_frames[src_idx]
    img = _read_frame(frames_dir, src_name)
    src_h, src_w = img.shape[:2]
    out = resize_frame(img, size, src_w, src_h)
    if not cv2.imwrite(output_path, out):
        raise ExportError(f"failed to write frame: {output_path}")
    if on_progress is not None:
        _report_fraction(on_progress, 1.0)
    return {"written_files": [output_path], "source": src_name, "source_index": src_idx}
