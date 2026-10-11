"""Make a texture seamless (tileable) — offline, NumPy only.

Pipeline
--------
1. Optional lighting equalisation: removes large soft gradients / hotspots
   (the #1 cause of visible repetition once a texture is tiled).
2. Horizontal pass, then vertical pass. Each pass blends the image with a
   copy of itself shifted by half its size, so the shifted copy's edges
   (which come from the image centre) wrap perfectly.

   * "smart"  – finds the least-visible cut path between the two copies
                (minimum-error boundary cut, as in image quilting) and
                feathers it by a few pixels. Keeps detail sharp; best for
                stone, bricks, wood, fabric, ground.
   * "blend"  – soft cosine cross-fade with variance-preserving mixing so
                the blend zone doesn't go flat/blurry. Best for noisy or
                organic textures (grass, sand, concrete, noise).
   * "mirror" – mirror-tiles the image (always seamless, shows symmetry).

The vertical pass constrains its cut to close on itself, so the result
tiles in both directions.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

METHODS = ("smart", "blend", "mirror")


# ── helpers ────────────────────────────────────────────────────────────
def _gauss_blur_rgb(rgb: np.ndarray, radius: float) -> np.ndarray:
    """Separable float Gaussian blur of an H×W×C array (reflected edges).
    Used on small (≤256 px) images only, so plain NumPy is fast enough."""
    r = int(np.ceil(radius * 2.5))
    xs = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(xs**2) / (2 * radius * radius))
    k /= k.sum()
    out = rgb.astype(np.float32)
    for axis in (0, 1):
        n = out.shape[axis]
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode="symmetric")
        acc = np.zeros_like(out)
        for i, kv in enumerate(k):
            acc += kv * np.take(p, np.arange(i, i + n), axis=axis)
        out = acc
    return out


def equalize_lighting(rgb: np.ndarray, strength: float = 0.5) -> np.ndarray:
    """Flatten large-scale brightness/colour drift while keeping detail."""
    s = float(np.clip(strength, 0.0, 1.0))
    if s <= 0.001:
        return rgb
    h, w = rgb.shape[:2]
    # work on a small copy for speed — the low-frequency field is smooth
    small_side = 256
    scale = small_side / max(h, w)
    if scale < 1:
        sw, sh = max(8, int(w * scale)), max(8, int(h * scale))
        small = np.asarray(
            Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize(
                (sw, sh), Image.Resampling.BILINEAR
            ),
            dtype=np.float32,
        ) / 255.0
    else:
        small, sw, sh = rgb, w, h
    low = _gauss_blur_rgb(small, radius=max(sw, sh) * 0.12)
    if (sw, sh) != (w, h):
        low = np.stack(
            [
                np.asarray(
                    Image.fromarray(low[..., c].astype(np.float32), mode="F").resize(
                        (w, h), Image.Resampling.BICUBIC
                    )
                )
                for c in range(3)
            ],
            axis=-1,
        )
    low = np.maximum(low, 1e-3)
    mean = rgb.reshape(-1, 3).mean(axis=0)
    gain = (mean / low) ** s
    return np.clip(rgb * gain, 0.0, 1.0).astype(np.float32)


def _feather_1d(mask: np.ndarray, radius: float) -> np.ndarray:
    """Gaussian blur along axis=1 only (the axis the cut crosses)."""
    if radius < 0.5:
        return mask
    r = int(np.ceil(radius * 2.5))
    xs = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(xs**2) / (2 * radius * radius))
    k /= k.sum()
    padded = np.pad(mask, ((0, 0), (r, r)), mode="edge")
    out = np.zeros_like(mask)
    w = mask.shape[1]
    for i, kv in enumerate(k):
        out += kv * padded[:, i : i + w]
    return out


def _min_cut_path(cost: np.ndarray, cyclic: bool) -> np.ndarray:
    """Min-cost top→bottom path through `cost` (rows × cols), moving at most
    one column per row. If cyclic, the last row must land within ±1 column
    of the first so the cut closes when the image wraps vertically."""

    def run(cost, start_col=None):
        h, n = cost.shape
        big = np.float32(1e20)
        acc = cost[0].copy()
        if start_col is not None:
            acc = np.full(n, big, dtype=np.float32)
            acc[start_col] = cost[0, start_col]
        back = np.zeros((h, n), dtype=np.int8)
        for i in range(1, h):
            left = np.concatenate(([big], acc[:-1]))
            right = np.concatenate((acc[1:], [big]))
            stack = np.stack([left, acc, right])
            choice = np.argmin(stack, axis=0)
            acc = cost[i] + stack[choice, np.arange(n)]
            back[i] = choice.astype(np.int8) - 1  # -1, 0, +1
        return acc, back

    def trace(acc, back, end_col):
        h = back.shape[0]
        path = np.empty(h, dtype=np.int64)
        path[-1] = end_col
        for i in range(h - 1, 0, -1):
            path[i - 1] = path[i] + back[i, path[i]]
        return path

    acc, back = run(cost)
    path = trace(acc, back, int(np.argmin(acc)))
    if not cyclic:
        return path
    start = int(path[0])
    acc, back = run(cost, start_col=start)
    n = cost.shape[1]
    lo, hi = max(0, start - 1), min(n, start + 2)
    end = lo + int(np.argmin(acc[lo:hi]))
    return trace(acc, back, end)


def _pass_horizontal(img: np.ndarray, method: str, blend: float, cyclic: bool) -> np.ndarray:
    """Make the image wrap left↔right."""
    h, w = img.shape[:2]
    shifted = np.roll(img, -(w // 2), axis=1)  # edges now come from the centre
    band = int(round(np.clip(blend, 0.05, 0.45) * w))
    band = max(4, min(band, w // 2 - 2))
    x = np.arange(w, dtype=np.float32)
    dist = np.minimum(x, (w - 1) - x)  # distance to nearest left/right edge

    if method == "smart" and band >= 12 and h >= 4:
        feather = max(1.5, band * 0.06)
        margin = int(np.ceil(feather * 2.5)) + 1
        diff = ((img - shifted) ** 2).sum(axis=-1).astype(np.float32)
        mask = np.ones((h, w), dtype=np.float32)  # 1 = keep original
        # left band: cut runs inside columns [margin, band)
        left = diff[:, margin:band]
        pl = _min_cut_path(left, cyclic) + margin
        mask[x[None, :] < pl[:, None]] = 0.0
        # right band: mirror the problem so the same solver works
        right = diff[:, w - band : w - margin][:, ::-1]
        pr = _min_cut_path(right, cyclic) + margin
        mask[x[None, :] > (w - 1 - pr)[:, None]] = 0.0
        mask = _feather_1d(mask, feather)
        mask[:, 0] = 0.0
        mask[:, -1] = 0.0
        m = mask[..., None]
        return (m * img + (1.0 - m) * shifted).astype(np.float32)

    # soft cross-fade (also the fallback for tiny images)
    t = np.clip(dist / band, 0.0, 1.0)
    wgt = (0.5 - 0.5 * np.cos(np.pi * t)).astype(np.float32)[None, :, None]
    mean = img.reshape(-1, img.shape[-1]).mean(axis=0)
    a, b = img - mean, shifted - mean
    mixed = wgt * a + (1.0 - wgt) * b
    # variance-preserving: undo the contrast loss of mixing two textures
    norm = np.sqrt(wgt**2 + (1.0 - wgt) ** 2)
    out = mean + mixed / norm
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def _mirror_tile(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    top = np.concatenate([img, img[:, ::-1]], axis=1)
    full = np.concatenate([top, top[::-1]], axis=0)
    pil = Image.fromarray((np.clip(full, 0, 1) * 255).astype(np.uint8))
    pil = pil.resize((w, h), Image.Resampling.LANCZOS)
    return np.asarray(pil, dtype=np.float32) / 255.0


def make_seamless(
    rgb: np.ndarray,
    *,
    method: str = "smart",
    blend: float = 0.25,
    equalize: float = 0.0,
) -> np.ndarray:
    """rgb: float32 H×W×3 in [0,1]. Returns a tileable image of the same size."""
    method = (method or "smart").lower()
    if method not in METHODS:
        method = "smart"
    img = rgb.astype(np.float32)
    img = equalize_lighting(img, equalize)
    if method == "mirror":
        return _mirror_tile(img)
    h, w = img.shape[:2]
    if min(h, w) < 8:
        return img
    # pass 1: left↔right (no wrap constraint needed yet)
    img = _pass_horizontal(img, method, blend, cyclic=False)
    # pass 2: top↔bottom on the transposed image; its cut must close so the
    # left↔right wrap from pass 1 is preserved
    img = _pass_horizontal(img.transpose(1, 0, 2), method, blend, cyclic=True)
    return np.ascontiguousarray(img.transpose(1, 0, 2))


def seam_error(rgb: np.ndarray) -> float:
    """Mean jump across the wrap edges relative to the image's own
    neighbour-pixel differences. ~1.0 = invisible seam; higher = visible."""
    inner_x = np.abs(np.diff(rgb, axis=1)).mean()
    inner_y = np.abs(np.diff(rgb, axis=0)).mean()
    wrap_x = np.abs(rgb[:, 0] - rgb[:, -1]).mean()
    wrap_y = np.abs(rgb[0] - rgb[-1]).mean()
    return float((wrap_x + wrap_y) / max(inner_x + inner_y, 1e-6))
