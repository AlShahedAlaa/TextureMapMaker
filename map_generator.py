"""Offline PBR map generation from a diffuse texture (no API)."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional, Tuple, Union

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from seamless import make_seamless, seam_error


PathLike = Union[str, Path]


def _load_rgb(path: PathLike) -> Tuple[np.ndarray, Image.Image]:
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA"):
        # composite on mid-gray for transparency
        bg = Image.new("RGBA", img.size, (128, 128, 128, 255))
        img = Image.alpha_composite(bg, img.convert("RGBA")).convert("RGB")
    else:
        img = img.convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return arr, img


def _to_gray(rgb: np.ndarray) -> np.ndarray:
    # Rec. 709 luminance
    return (
        0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    ).astype(np.float32)


def _blur_array(arr: np.ndarray, radius: float, wrap: bool = False) -> np.ndarray:
    """Gaussian blur. wrap=True blurs across the edges as if the image were
    tiled, so blurred maps stay seamless."""
    if radius <= 0.01:
        return arr
    pad = 0
    if wrap:
        pad = int(np.ceil(radius * 3)) + 1
        arr = np.pad(arr, pad, mode="wrap")
    img = Image.fromarray(
        np.clip(arr * 255.0, 0, 255).astype(np.uint8), mode="L"
    )
    img = img.filter(ImageFilter.GaussianBlur(radius=float(radius)))
    out = np.asarray(img, dtype=np.float32) / 255.0
    if pad:
        out = out[pad:-pad, pad:-pad]
    return out


def _normalize01(arr: np.ndarray) -> np.ndarray:
    mn, mx = float(arr.min()), float(arr.max())
    if mx - mn < 1e-8:
        return np.full_like(arr, 0.5)
    return (arr - mn) / (mx - mn)


def _apply_contrast(arr: np.ndarray, contrast: float) -> np.ndarray:
    """contrast: 1 = none, >1 more, <1 less. Around mid 0.5."""
    c = max(0.05, float(contrast))
    return np.clip((arr - 0.5) * c + 0.5, 0.0, 1.0)


def generate_height_map(
    gray: np.ndarray,
    *,
    strength: float = 1.0,
    blur: float = 0.5,
    contrast: float = 1.0,
    invert: bool = False,
    level: float = 0.0,
    wrap: bool = False,
) -> np.ndarray:
    """
    Height/displacement map (grayscale).
    strength: amplify height variation
    blur: smooth before export
    contrast: contrast around mid-gray
    invert: flip high/low
    level: add constant bias (-0.5..0.5)
    """
    h = _blur_array(gray, blur, wrap)
    h = _normalize01(h)
    h = _apply_contrast(h, contrast)
    # center around 0.5 then scale
    h = 0.5 + (h - 0.5) * float(strength)
    h = h + float(level)
    if invert:
        h = 1.0 - h
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def generate_normal_map(
    height: np.ndarray,
    *,
    strength: float = 2.0,
    blur: float = 0.0,
    invert_x: bool = False,
    invert_y: bool = True,
    wrap: bool = False,
) -> np.ndarray:
    """
    Tangent-space normal map RGB from height.
    invert_y=True → OpenGL style (green up); False often used for DirectX.
    strength: slope intensity
    """
    h = _blur_array(height, blur, wrap)
    # Sobel-like gradients
    if wrap:
        dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
        dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    else:
        dx = np.zeros_like(h)
        dy = np.zeros_like(h)
        dx[:, 1:-1] = (h[:, 2:] - h[:, :-2]) * 0.5
        dy[1:-1, :] = (h[2:, :] - h[:-2, :]) * 0.5
        dx[:, 0] = h[:, 1] - h[:, 0]
        dx[:, -1] = h[:, -1] - h[:, -2]
        dy[0, :] = h[1, :] - h[0, :]
        dy[-1, :] = h[-1, :] - h[-2, :]

    s = max(0.01, float(strength))
    nx = -dx * s
    ny = -dy * s
    if invert_x:
        nx = -nx
    if invert_y:
        ny = -ny
    nz = np.ones_like(h)

    length = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-8
    nx, ny, nz = nx / length, ny / length, nz / length

    # Map [-1,1] → [0,1]
    r = nx * 0.5 + 0.5
    g = ny * 0.5 + 0.5
    b = nz * 0.5 + 0.5
    return np.stack([r, g, b], axis=-1).astype(np.float32)


def generate_roughness_map(
    rgb: np.ndarray,
    gray: np.ndarray,
    *,
    method: str = "variance",
    strength: float = 1.0,
    blur: float = 1.5,
    contrast: float = 1.0,
    invert: bool = False,
    base: float = 0.5,
    detail_scale: float = 3.0,
    wrap: bool = False,
) -> np.ndarray:
    """
    Roughness map (grayscale). White = rough, black = smooth (standard).
    methods:
      - variance: local detail high → rougher
      - luminance: darker → rougher (or invert)
      - edges: edge density → rougher
    base: base roughness (0-1)
    strength: mix amount of computed detail into base
    """
    method = (method or "variance").lower()
    g = gray

    if method == "luminance":
        detail = 1.0 - g  # darker = rougher by default
    elif method == "edges":
        # simple edge magnitude
        if wrap:
            dx = np.abs(np.roll(g, -1, axis=1) - np.roll(g, 1, axis=1)) * 0.5
            dy = np.abs(np.roll(g, -1, axis=0) - np.roll(g, 1, axis=0)) * 0.5
        else:
            dx = np.zeros_like(g)
            dy = np.zeros_like(g)
            dx[:, 1:-1] = np.abs(g[:, 2:] - g[:, :-2]) * 0.5
            dy[1:-1, :] = np.abs(g[2:, :] - g[:-2, :]) * 0.5
        detail = _normalize01(dx + dy)
    else:
        # local variance via blur difference
        smooth = _blur_array(g, max(0.5, detail_scale), wrap)
        detail = np.abs(g - smooth)
        detail = _normalize01(detail)

    detail = _blur_array(detail, blur, wrap)
    detail = _apply_contrast(detail, contrast)
    # mix with base
    s = float(np.clip(strength, 0.0, 2.0))
    rough = np.clip(float(base) + (detail - 0.5) * s, 0.0, 1.0)
    if invert:
        rough = 1.0 - rough
    return rough.astype(np.float32)


def generate_ao_map(
    height: np.ndarray,
    *,
    strength: float = 1.0,
    blur: float = 2.0,
    invert: bool = False,
    wrap: bool = False,
) -> np.ndarray:
    """Simple AO from height (optional bonus map)."""
    h = _blur_array(height, blur, wrap)
    # lower height → more occlusion
    ao = _normalize01(h)
    ao = np.clip(0.5 + (ao - 0.5) * float(strength), 0.0, 1.0)
    if invert:
        ao = 1.0 - ao
    # darken cavities more
    ao = np.power(ao, 1.2)
    return ao.astype(np.float32)


def _save_gray(path: Path, arr: np.ndarray) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(arr * 255.0, 0, 255).astype(np.uint8), mode="L").save(
        path, format="PNG"
    )
    return path


def _save_rgb(path: Path, arr: np.ndarray) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(
        np.clip(arr * 255.0, 0, 255).astype(np.uint8), mode="RGB"
    ).save(path, format="PNG")
    return path


def generate_all_maps(
    diffuse_path: PathLike,
    output_dir: PathLike,
    *,
    # height
    height_strength: float = 1.0,
    height_blur: float = 0.5,
    height_contrast: float = 1.0,
    height_invert: bool = False,
    height_level: float = 0.0,
    # normal
    normal_strength: float = 2.0,
    normal_blur: float = 0.0,
    normal_invert_x: bool = False,
    normal_invert_y: bool = True,
    # roughness
    roughness_method: str = "variance",
    roughness_strength: float = 1.0,
    roughness_blur: float = 1.5,
    roughness_contrast: float = 1.0,
    roughness_invert: bool = False,
    roughness_base: float = 0.5,
    # ao optional
    include_ao: bool = True,
    ao_strength: float = 1.0,
    ao_blur: float = 2.0,
    max_size: int = 2048,
    # seamless
    seamless: bool = False,
    seamless_method: str = "smart",
    seamless_blend: float = 0.25,
    seamless_equalize: float = 0.0,
    tileable: bool = False,
    **_ignored,
) -> Dict[str, str]:
    """
    Generate maps and save as PNG. Returns dict of relative filenames.
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    rgb, pil = _load_rgb(diffuse_path)
    # optional downscale for performance
    h, w = rgb.shape[:2]
    if max(h, w) > max_size > 0:
        scale = max_size / max(h, w)
        nw, nh = int(w * scale), int(h * scale)
        pil = pil.resize((nw, nh), Image.Resampling.LANCZOS)
        rgb = np.asarray(pil, dtype=np.float32) / 255.0

    seam_before = seam_error(rgb)
    if seamless:
        rgb = make_seamless(
            rgb,
            method=seamless_method,
            blend=seamless_blend,
            equalize=seamless_equalize,
        )
        pil = Image.fromarray(np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8), mode="RGB")
    # wrap-aware processing so every map tiles like the diffuse does
    wrap = bool(seamless or tileable)

    gray = _to_gray(rgb)

    height = generate_height_map(
        gray,
        strength=height_strength,
        blur=height_blur,
        contrast=height_contrast,
        invert=height_invert,
        level=height_level,
        wrap=wrap,
    )
    normal = generate_normal_map(
        height,
        strength=normal_strength,
        blur=normal_blur,
        invert_x=normal_invert_x,
        invert_y=normal_invert_y,
        wrap=wrap,
    )
    roughness = generate_roughness_map(
        rgb,
        gray,
        method=roughness_method,
        strength=roughness_strength,
        blur=roughness_blur,
        contrast=roughness_contrast,
        invert=roughness_invert,
        base=roughness_base,
        wrap=wrap,
    )

    # save diffuse copy + maps
    diffuse_out = out / "diffuse.png"
    pil.save(diffuse_out, format="PNG")
    height_out = _save_gray(out / "height.png", height)
    normal_out = _save_rgb(out / "normal.png", normal)
    rough_out = _save_gray(out / "roughness.png", roughness)

    result = {
        "diffuse": diffuse_out.name,
        "height": height_out.name,
        "normal": normal_out.name,
        "roughness": rough_out.name,
        "width": pil.size[0],
        "height_px": pil.size[1],
        "seamless": bool(seamless),
        "tileable": wrap,
        "seam_before": round(seam_before, 2),
        "seam_after": round(seam_error(rgb), 2),
    }

    if include_ao:
        ao = generate_ao_map(height, strength=ao_strength, blur=ao_blur, wrap=wrap)
        ao_out = _save_gray(out / "ao.png", ao)
        result["ao"] = ao_out.name

    return result
