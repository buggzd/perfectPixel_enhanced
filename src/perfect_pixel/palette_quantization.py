import numpy as np

try:
    import cv2
except Exception:
    cv2 = None


def load_gpl_palette(path):
    colors = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.lower().startswith("gimp palette") or s.lower().startswith("name:") or s.lower().startswith("columns:"):
                continue
            parts = s.split()
            if len(parts) < 3:
                continue
            try:
                r = int(parts[0])
                g = int(parts[1])
                b = int(parts[2])
            except ValueError:
                continue
            colors.append([r, g, b])
    if not colors:
        raise RuntimeError(f"No colors found in palette: {path}")
    return np.array(colors, dtype=np.uint8)


def to_uint8(image):
    if image.dtype == np.uint8:
        return image
    return np.clip(np.rint(image), 0, 255).astype(np.uint8)


def apply_palette(image, palette, chunk_size=65536, color_space="rgb", mask=None):
    img_u8 = to_uint8(image)
    pal_u8 = palette.astype(np.uint8, copy=False)
    if mask is not None:
        mask = mask.reshape(-1)

    if color_space == "lab":
        if cv2 is None:
            raise RuntimeError("LAB palette mapping requires opencv-python.")
        pal_lab = cv2.cvtColor(pal_u8.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.int32)
        flat = img_u8.reshape(-1, 3)
        out = np.empty_like(flat, dtype=np.uint8)
        for start in range(0, flat.shape[0], chunk_size):
            end = min(start + chunk_size, flat.shape[0])
            if mask is not None and not mask[start:end].any():
                out[start:end] = flat[start:end]
                continue
            block = flat[start:end]
            block_lab = cv2.cvtColor(block.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.int32)
            diff = block_lab[:, None, :] - pal_lab[None, :, :]
            dist = (diff * diff).sum(axis=2, dtype=np.int64)
            idx = dist.argmin(axis=1)
            out[start:end] = pal_u8[idx]
        return out.reshape(image.shape)

    img = img_u8.astype(np.int32, copy=False)
    pal = pal_u8.astype(np.int32, copy=False)
    flat = img.reshape(-1, 3)
    out = np.empty_like(flat, dtype=np.uint8)
    for start in range(0, flat.shape[0], chunk_size):
        end = min(start + chunk_size, flat.shape[0])
        if mask is not None and not mask[start:end].any():
            out[start:end] = flat[start:end]
            continue
        block = flat[start:end][:, None, :]
        diff = block - pal[None, :, :]
        dist = (diff * diff).sum(axis=2, dtype=np.int64)
        idx = dist.argmin(axis=1)
        out[start:end] = pal_u8[idx]
    return out.reshape(image.shape)


def quantize(image, palette=None, color_space="rgb", mask=None):
    if palette is None:
        return to_uint8(image)
    return apply_palette(image, palette, color_space=color_space, mask=mask)
