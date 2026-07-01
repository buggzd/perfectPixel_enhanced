"""Background-removal post-processing for processed PNG frame sequences."""

from __future__ import annotations

import os
from typing import Callable, Optional, Sequence, Tuple

import cv2
import numpy as np

ProgressCallback = Callable[[int, int], None]

__all__ = ["remove_background_from_frames", "remove_background_bgra", "parse_bgr_color"]


def _ensure_bgra(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        return np.dstack([bgr, np.full(img.shape, 255, dtype=np.uint8)])
    if img.shape[2] == 4:
        return img.copy()
    return np.dstack([img, np.full(img.shape[:2], 255, dtype=np.uint8)])


def _estimate_background_bgr(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    border = max(1, min(h, w, 4))
    samples = np.concatenate(
        [
            bgr[:border, :, :].reshape(-1, 3),
            bgr[-border:, :, :].reshape(-1, 3),
            bgr[:, :border, :].reshape(-1, 3),
            bgr[:, -border:, :].reshape(-1, 3),
        ],
        axis=0,
    )
    return np.median(samples, axis=0).astype(np.float32)


def parse_bgr_color(hex_color: str) -> np.ndarray:
    """Parse ``#RRGGBB`` / ``#RGB`` into a BGR float color."""
    if not isinstance(hex_color, str) or not hex_color.startswith("#"):
        raise ValueError("background_color must be a hex color")
    h = hex_color[1:]
    if len(h) == 3:
        r, g, b = (int(c * 2, 16) for c in h)
    elif len(h) == 6:
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    else:
        raise ValueError("background_color must be #RGB or #RRGGBB")
    return np.array([b, g, r], dtype=np.float32)


def _border_connected_mask(candidate: np.ndarray) -> np.ndarray:
    h, w = candidate.shape
    flood = np.zeros((h + 2, w + 2), dtype=np.uint8)
    work = candidate.astype(np.uint8).copy()

    for x in range(w):
        if work[0, x] == 1:
            cv2.floodFill(work, flood, (x, 0), 2)
        if work[h - 1, x] == 1:
            cv2.floodFill(work, flood, (x, h - 1), 2)
    for y in range(h):
        if work[y, 0] == 1:
            cv2.floodFill(work, flood, (0, y), 2)
        if work[y, w - 1] == 1:
            cv2.floodFill(work, flood, (w - 1, y), 2)

    return work == 2


def _block_mean_bgr(bgr: np.ndarray, block_size: int) -> np.ndarray:
    """Collapse an image into pixel-art cells, averaging each block's BGR colour."""
    block = max(1, int(block_size))
    if block <= 1:
        return bgr.astype(np.float32)

    h, w = bgr.shape[:2]
    cells_h = (h + block - 1) // block
    cells_w = (w + block - 1) // block
    y0 = np.arange(cells_h) * block
    x0 = np.arange(cells_w) * block
    y1 = np.minimum(y0 + block, h)
    x1 = np.minimum(x0 + block, w)

    sat = bgr.astype(np.float32).cumsum(axis=0).cumsum(axis=1)
    sat = np.pad(sat, ((1, 0), (1, 0), (0, 0)), mode="constant")
    sums = (
        sat[y1[:, None], x1[None, :]]
        - sat[y0[:, None], x1[None, :]]
        - sat[y1[:, None], x0[None, :]]
        + sat[y0[:, None], x0[None, :]]
    )
    areas = ((y1 - y0)[:, None] * (x1 - x0)[None, :]).astype(np.float32)
    return sums / areas[..., None]


def _expand_block_mask(mask: np.ndarray, shape: Tuple[int, int], block_size: int) -> np.ndarray:
    """Expand a block-cell mask back to image pixels."""
    block = max(1, int(block_size))
    if block <= 1:
        return mask
    h, w = shape
    expanded = np.repeat(np.repeat(mask, block, axis=0), block, axis=1)
    return expanded[:h, :w]


def remove_background_bgra(
    img: np.ndarray,
    *,
    background_color: Optional[str] = None,
    threshold: float = 30.0,
    feather: int = 0,
    block_size: int = 1,
    edge_connected: bool = True,
) -> np.ndarray:
    """Return a BGRA image with background removed by pixel-art cells.

    The mask is calculated on ``block_size`` cells and then expanded back to the
    rendered frame. Only colour-matched cells connected to the image border are
    removed, so interior details that match the background colour (white eyes,
    highlights, etc.) remain opaque instead of becoming holes.
    """
    bgra = _ensure_bgra(img)

    # 1. Already-keyed input — leave it alone.
    if bgra.shape[2] == 4:
        alpha_in = bgra[:, :, 3]
        if float(np.mean(alpha_in < 255)) > 0.02:
            return bgra.copy()

    bgr = bgra[:, :, :3]
    bg = parse_bgr_color(background_color) if background_color else _estimate_background_bgr(bgr)

    block_bgr = _block_mean_bgr(bgr, block_size)
    diff = np.linalg.norm(block_bgr - bg[None, None, :], axis=2)
    matched_blocks = diff <= max(0.0, float(threshold))
    bg_blocks = _border_connected_mask(matched_blocks) if edge_connected else matched_blocks
    bg_mask = _expand_block_mask(bg_blocks, bgra.shape[:2], block_size)

    alpha = np.full(bgra.shape[:2], 255, dtype=np.uint8)
    alpha[bg_mask] = 0

    # 7. Optional extra edge softening.
    if feather > 0:
        k = int(feather) * 2 + 1
        alpha = cv2.GaussianBlur(alpha, (k, k), 0)

    out = bgra.copy()
    out[:, :, 3] = alpha
    return out


def remove_background_from_frames(
    frames_dir: str,
    output_frames: Sequence[str],
    *,
    background_color: Optional[str] = None,
    threshold: float = 30.0,
    feather: int = 0,
    block_size: int = 1,
    edge_connected: bool = True,
    progress_callback: Optional[ProgressCallback] = None,
) -> None:
    """Overwrite processed PNG frames in place with transparent-background BGRA PNGs."""
    total = len(output_frames)
    for i, name in enumerate(output_frames):
        path = os.path.join(frames_dir, name)
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise FileNotFoundError(f"Cannot read frame for background removal: {name}")
        out = remove_background_bgra(
            img,
            background_color=background_color,
            threshold=threshold,
            feather=feather,
            block_size=block_size,
            edge_connected=edge_connected,
        )
        if not cv2.imwrite(path, out):
            raise OSError(f"Cannot write background-removed frame: {name}")
        if progress_callback is not None:
            progress_callback(i + 1, total)
