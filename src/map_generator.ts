/**
 * Offline PBR map generation from a diffuse texture.
 * Generates height, normal, roughness, AO, and packed ORM maps.
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import {
  RGBImage,
  createRGBImage,
  makeSeamless,
  seamError,
  delightLighting,
} from "./seamless.js";

export type AspectMode = "keep" | "crop" | "pad" | "stretch";

export interface GenerateOptions {
  height_strength?: number;
  height_blur?: number;
  height_contrast?: number;
  height_invert?: boolean;
  height_level?: number;
  normal_strength?: number;
  normal_blur?: number;
  normal_format?: "opengl" | "directx";
  normal_macro_detail?: number;
  normal_invert_x?: boolean;
  normal_invert_y?: boolean;
  roughness_method?: string;
  roughness_strength?: number;
  roughness_blur?: number;
  roughness_contrast?: number;
  roughness_invert?: boolean;
  roughness_base?: number;
  roughness_min?: number;
  roughness_max?: number;
  include_ao?: boolean;
  ao_strength?: number;
  ao_blur?: number;
  ao_exponent?: number;
  max_size?: number;
  aspect_mode?: AspectMode;
  delight?: number;
  seamless?: boolean;
  seamless_method?: string;
  seamless_blend?: number;
  seamless_equalize?: number;
  tileable?: boolean;
  orm_pack_blue?: "metallic" | "height";
}

export interface MapResult {
  diffuse: string;
  height: string;
  normal: string;
  roughness: string;
  ao?: string;
  orm?: string;
  width: number;
  height_px: number;
  aspect_ratio: number;
  seamless: boolean;
  tileable: boolean;
  seam_before: number;
  seam_after: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v: number): number {
  return Math.max(0.0, Math.min(1.0, v));
}

export async function loadRGB(
  filePath: string,
  maxSize: number = 2048,
  aspectMode: AspectMode = "keep"
): Promise<RGBImage> {
  const metadata = await sharp(filePath, { limitInputPixels: 268435456 }).metadata();
  let pipeline = sharp(filePath, { limitInputPixels: 268435456 }).rotate();

  let origW = metadata.width || 1024;
  let origH = metadata.height || 1024;

  if (aspectMode === "crop") {
    const minDim = Math.min(origW, origH);
    const left = Math.floor((origW - minDim) / 2);
    const top = Math.floor((origH - minDim) / 2);
    pipeline = pipeline.extract({ left, top, width: minDim, height: minDim });
    origW = minDim;
    origH = minDim;
  } else if (aspectMode === "stretch") {
    const targetDim = maxSize > 0 ? Math.min(maxSize, Math.max(origW, origH)) : Math.max(origW, origH);
    pipeline = pipeline.resize(targetDim, targetDim, { fit: "fill", kernel: "lanczos3" });
    origW = targetDim;
    origH = targetDim;
  } else if (aspectMode === "pad") {
    const maxDim = Math.max(origW, origH);
    const padX = Math.floor((maxDim - origW) / 2);
    const padY = Math.floor((maxDim - origH) / 2);
    pipeline = pipeline.extend({
      top: padY,
      bottom: maxDim - origH - padY,
      left: padX,
      right: maxDim - origW - padX,
      background: { r: 128, g: 128, b: 128 },
    });
    origW = maxDim;
    origH = maxDim;
  }

  // Scale down if dimensions exceed maxSize
  if (aspectMode !== "stretch" && maxSize > 0 && Math.max(origW, origH) > maxSize) {
    pipeline = pipeline.resize({
      width: origW >= origH ? maxSize : undefined,
      height: origH > origW ? maxSize : undefined,
      fit: "inside",
      kernel: "lanczos3",
    });
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const channels = info.channels;
  const numPix = w * h;

  const out = createRGBImage(w, h);

  if (channels === 4) {
    // Composite over mid-gray
    for (let i = 0; i < numPix; i++) {
      const srcIdx = i * 4;
      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];
      const a = data[srcIdx + 3] / 255.0;
      const invA = 1.0 - a;

      out.data[i * 3] = (r * a + 128 * invA) / 255.0;
      out.data[i * 3 + 1] = (g * a + 128 * invA) / 255.0;
      out.data[i * 3 + 2] = (b * a + 128 * invA) / 255.0;
    }
  } else {
    for (let i = 0; i < numPix; i++) {
      const srcIdx = i * channels;
      out.data[i * 3] = data[srcIdx] / 255.0;
      out.data[i * 3 + 1] = (channels > 1 ? data[srcIdx + 1] : data[srcIdx]) / 255.0;
      out.data[i * 3 + 2] = (channels > 2 ? data[srcIdx + 2] : data[srcIdx]) / 255.0;
    }
  }

  return out;
}

export function toGray(rgb: RGBImage): Float32Array {
  const { width: w, height: h, data } = rgb;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 3;
    gray[i] = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
  }
  return gray;
}

export function blurArray(
  arr: Float32Array,
  w: number,
  h: number,
  radius: number,
  wrap: boolean = false
): Float32Array {
  if (radius <= 0.01) {
    return new Float32Array(arr);
  }
  const r = Math.ceil(radius * 2.5);
  const size = 2 * r + 1;
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - r;
    const val = Math.exp(-(x * x) / (2 * radius * radius));
    kernel[i] = val;
    sum += val;
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const temp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  // Horizontal pass: optimized interior vs boundary
  for (let y = 0; y < h; y++) {
    const rOffset = y * w;
    // Left boundary
    const leftLimit = Math.min(r, w);
    for (let x = 0; x < leftLimit; x++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        let sx = x + (k - r);
        sx = wrap ? ((sx % w) + w) % w : clamp(sx, 0, w - 1);
        acc += arr[rOffset + sx] * kernel[k];
      }
      temp[rOffset + x] = acc;
    }
    // Interior (fast contiguous pass without bounds check)
    const rightLimit = Math.max(0, w - r);
    for (let x = leftLimit; x < rightLimit; x++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        acc += arr[rOffset + (x + k - r)] * kernel[k];
      }
      temp[rOffset + x] = acc;
    }
    // Right boundary
    for (let x = Math.max(leftLimit, rightLimit); x < w; x++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        let sx = x + (k - r);
        sx = wrap ? ((sx % w) + w) % w : clamp(sx, 0, w - 1);
        acc += arr[rOffset + sx] * kernel[k];
      }
      temp[rOffset + x] = acc;
    }
  }

  // Vertical pass: row-by-row accumulation for cache-locality and vectorization
  for (let y = 0; y < h; y++) {
    const dstOffset = y * w;
    for (let k = 0; k < size; k++) {
      let sy = y + (k - r);
      if (wrap) {
        sy = ((sy % h) + h) % h;
      } else {
        if (sy < 0) sy = 0;
        else if (sy >= h) sy = h - 1;
      }
      const kw = kernel[k];
      const srcOffset = sy * w;
      for (let x = 0; x < w; x++) {
        out[dstOffset + x] += temp[srcOffset + x] * kw;
      }
    }
  }

  return out;
}

export function normalize01(arr: Float32Array): Float32Array {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  const out = new Float32Array(arr.length);
  if (max - min < 1e-8) {
    out.fill(0.5);
    return out;
  }
  const range = max - min;
  for (let i = 0; i < arr.length; i++) {
    out[i] = (arr[i] - min) / range;
  }
  return out;
}

export function applyContrast(arr: Float32Array, contrast: number): Float32Array {
  const c = Math.max(0.05, contrast);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = clamp01((arr[i] - 0.5) * c + 0.5);
  }
  return out;
}

export function generateHeightMap(
  gray: Float32Array,
  w: number,
  h: number,
  opts: {
    strength?: number;
    blur?: number;
    contrast?: number;
    invert?: boolean;
    level?: number;
    wrap?: boolean;
  }
): Float32Array {
  const strength = opts.strength ?? 1.0;
  const blur = opts.blur ?? 0.5;
  const contrast = opts.contrast ?? 1.0;
  const invert = opts.invert ?? false;
  const level = opts.level ?? 0.0;
  const wrap = opts.wrap ?? false;

  let height = blurArray(gray, w, h, blur, wrap);
  height = normalize01(height);
  height = applyContrast(height, contrast);

  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let val = 0.5 + (height[i] - 0.5) * strength + level;
    if (invert) val = 1.0 - val;
    out[i] = clamp01(val);
  }
  return out;
}

function computeSobel(
  data: Float32Array,
  w: number,
  h: number,
  wrap: boolean
): { dx: Float32Array; dy: Float32Array } {
  const dx = new Float32Array(w * h);
  const dy = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const rOffset = y * w;
    const yPlus = wrap ? (y + 1) % h : Math.min(h - 1, y + 1);
    const yMinus = wrap ? (y - 1 + h) % h : Math.max(0, y - 1);
    const yPlusOffset = yPlus * w;
    const yMinusOffset = yMinus * w;

    // Interior points (fast, 99.8% of pixels)
    for (let x = 1; x < w - 1; x++) {
      dx[rOffset + x] = (data[rOffset + x + 1] - data[rOffset + x - 1]) * 0.5;
      dy[rOffset + x] = (data[yPlusOffset + x] - data[yMinusOffset + x]) * 0.5;
    }

    // Left border (x = 0)
    if (wrap) {
      dx[rOffset] = (data[rOffset + 1] - data[rOffset + w - 1]) * 0.5;
    } else {
      dx[rOffset] = data[rOffset + 1] - data[rOffset];
    }
    dy[rOffset] = (data[yPlusOffset] - data[yMinusOffset]) * 0.5;

    // Right border (x = w - 1)
    if (w > 1) {
      if (wrap) {
        dx[rOffset + w - 1] = (data[rOffset] - data[rOffset + w - 2]) * 0.5;
      } else {
        dx[rOffset + w - 1] = data[rOffset + w - 1] - data[rOffset + w - 2];
      }
      dy[rOffset + w - 1] = (data[yPlusOffset + w - 1] - data[yMinusOffset + w - 1]) * 0.5;
    }
  }
  return { dx, dy };
}

export function generateNormalMap(
  height: Float32Array,
  w: number,
  h: number,
  opts: {
    strength?: number;
    blur?: number;
    normal_format?: "opengl" | "directx";
    macro_detail?: number;
    invert_x?: boolean;
    invert_y?: boolean;
    wrap?: boolean;
  }
): Float32Array {
  const strength = opts.strength ?? 2.0;
  const blur = opts.blur ?? 0.0;
  const invertX = opts.invert_x ?? false;
  // OpenGL default is invert_y: true (+Y green up); DirectX is invert_y: false (-Y green down)
  let invertY = opts.invert_y ?? true;
  if (opts.normal_format === "directx") {
    invertY = false;
  } else if (opts.normal_format === "opengl") {
    invertY = true;
  }
  const wrap = opts.wrap ?? false;
  const macroDetail = clamp01(opts.macro_detail ?? 0.35);

  const microBlurred = blurArray(height, w, h, blur, wrap);
  const microGrad = computeSobel(microBlurred, w, h, wrap);

  // Macro detail gradient from broader blur
  const macroBlurRadius = Math.max(2.0, blur + 3.5);
  const macroBlurred = blurArray(height, w, h, macroBlurRadius, wrap);
  const macroGrad = computeSobel(macroBlurred, w, h, wrap);

  const normalRGB = new Float32Array(w * h * 3);
  const s = Math.max(0.01, strength);

  for (let i = 0; i < w * h; i++) {
    const combinedDx = (1.0 - macroDetail) * microGrad.dx[i] + macroDetail * macroGrad.dx[i] * 1.5;
    const combinedDy = (1.0 - macroDetail) * microGrad.dy[i] + macroDetail * macroGrad.dy[i] * 1.5;

    let nx = -combinedDx * s;
    let ny = -combinedDy * s;
    if (invertX) nx = -nx;
    if (invertY) ny = -ny;
    const nz = 1.0;

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-8;
    nx /= len;
    ny /= len;
    const normalizedNz = nz / len;

    const idx = i * 3;
    normalRGB[idx] = clamp01(nx * 0.5 + 0.5);
    normalRGB[idx + 1] = clamp01(ny * 0.5 + 0.5);
    normalRGB[idx + 2] = clamp01(normalizedNz * 0.5 + 0.5);
  }

  return normalRGB;
}

export function generateRoughnessMap(
  rgb: RGBImage,
  gray: Float32Array,
  opts: {
    method?: string;
    strength?: number;
    blur?: number;
    contrast?: number;
    invert?: boolean;
    base?: number;
    roughness_min?: number;
    roughness_max?: number;
    detail_scale?: number;
    wrap?: boolean;
  }
): Float32Array {
  const { width: w, height: h } = rgb;
  const method = (opts.method || "variance").toLowerCase();
  const strength = opts.strength ?? 1.0;
  const blur = opts.blur ?? 1.5;
  const contrast = opts.contrast ?? 1.0;
  const invert = opts.invert ?? false;
  const base = opts.base ?? 0.5;
  const minVal = clamp01(opts.roughness_min ?? 0.0);
  const maxVal = clamp01(opts.roughness_max ?? 1.0);
  const detailScale = opts.detail_scale ?? 3.0;
  const wrap = opts.wrap ?? false;

  let detail = new Float32Array(w * h);

  if (method === "luminance") {
    for (let i = 0; i < w * h; i++) {
      detail[i] = 1.0 - gray[i];
    }
  } else if (method === "edges") {
    for (let y = 0; y < h; y++) {
      const rOffset = y * w;
      for (let x = 0; x < w; x++) {
        let dx: number;
        let dy: number;
        if (wrap) {
          dx = Math.abs(gray[rOffset + ((x + 1) % w)] - gray[rOffset + ((x - 1 + w) % w)]) * 0.5;
          dy = Math.abs(gray[((y + 1) % h) * w + x] - gray[((y - 1 + h) % h) * w + x]) * 0.5;
        } else {
          const xPlus = Math.min(w - 1, x + 1);
          const xMinus = Math.max(0, x - 1);
          dx = Math.abs(gray[rOffset + xPlus] - gray[rOffset + xMinus]) * 0.5;

          const yPlus = Math.min(h - 1, y + 1);
          const yMinus = Math.max(0, y - 1);
          dy = Math.abs(gray[yPlus * w + x] - gray[yMinus * w + x]) * 0.5;
        }
        detail[rOffset + x] = dx + dy;
      }
    }
    detail = normalize01(detail);
  } else {
    // "variance"
    const smooth = blurArray(gray, w, h, Math.max(0.5, detailScale), wrap);
    for (let i = 0; i < w * h; i++) {
      detail[i] = Math.abs(gray[i] - smooth[i]);
    }
    detail = normalize01(detail);
  }

  detail = blurArray(detail, w, h, blur, wrap);
  detail = applyContrast(detail, contrast);

  const s = clamp(strength, 0.0, 2.0);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let rough = clamp01(base + (detail[i] - 0.5) * s);
    if (invert) rough = 1.0 - rough;
    // Remap to [minVal, maxVal]
    rough = minVal + rough * Math.max(0.001, maxVal - minVal);
    out[i] = clamp01(rough);
  }
  return out;
}

export function generateAoMap(
  height: Float32Array,
  w: number,
  h: number,
  opts: {
    strength?: number;
    blur?: number;
    exponent?: number;
    invert?: boolean;
    wrap?: boolean;
  }
): Float32Array {
  const strength = opts.strength ?? 1.0;
  const blur = opts.blur ?? 2.0;
  const exponent = Math.max(0.5, opts.exponent ?? 1.2);
  const invert = opts.invert ?? false;
  const wrap = opts.wrap ?? false;

  const blurred = blurArray(height, w, h, blur, wrap);
  let ao = normalize01(blurred);

  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let val = clamp01(0.5 + (ao[i] - 0.5) * strength);
    if (invert) val = 1.0 - val;
    val = Math.pow(val, exponent);
    out[i] = clamp01(val);
  }
  return out;
}

export async function saveGrayPNG(
  outPath: string,
  arr: Float32Array,
  w: number,
  h: number
): Promise<void> {
  const buf = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    buf[i] = Math.round(clamp01(arr[i]) * 255);
  }
  await sharp(Buffer.from(buf.buffer), {
    raw: { width: w, height: h, channels: 1 },
  })
    .png({ compressionLevel: 5, effort: 1 })
    .toFile(outPath);
}

export async function saveRgbPNG(
  outPath: string,
  arr: Float32Array,
  w: number,
  h: number
): Promise<void> {
  const buf = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h * 3; i++) {
    buf[i] = Math.round(clamp01(arr[i]) * 255);
  }
  await sharp(Buffer.from(buf.buffer), {
    raw: { width: w, height: h, channels: 3 },
  })
    .png({ compressionLevel: 5, effort: 1 })
    .toFile(outPath);
}

export async function generateAllMaps(
  diffusePath: string,
  outputDir: string,
  options: GenerateOptions = {}
): Promise<MapResult> {
  await fs.mkdir(outputDir, { recursive: true });

  const maxSize = options.max_size ?? 2048;
  const aspectMode = options.aspect_mode ?? "keep";
  let rgb = await loadRGB(diffusePath, maxSize, aspectMode);

  // Apply Delighting / Shadow Removal if enabled
  if (options.delight && options.delight > 0.01) {
    rgb = await delightLighting(rgb, options.delight);
  }

  const seamBefore = seamError(rgb);
  const isSeamless = Boolean(options.seamless);

  if (isSeamless) {
    rgb = await makeSeamless(
      rgb,
      options.seamless_method ?? "smart",
      options.seamless_blend ?? 0.25,
      options.seamless_equalize ?? 0.0
    );
  }

  const wrap = Boolean(isSeamless || options.tileable);
  const { width: w, height: h } = rgb;
  const gray = toGray(rgb);

  const height = generateHeightMap(gray, w, h, {
    strength: options.height_strength ?? 1.0,
    blur: options.height_blur ?? 0.5,
    contrast: options.height_contrast ?? 1.0,
    invert: options.height_invert ?? false,
    level: options.height_level ?? 0.0,
    wrap,
  });

  const normal = generateNormalMap(height, w, h, {
    strength: options.normal_strength ?? 2.0,
    blur: options.normal_blur ?? 0.0,
    normal_format: options.normal_format,
    macro_detail: options.normal_macro_detail ?? 0.35,
    invert_x: options.normal_invert_x ?? false,
    invert_y: options.normal_invert_y ?? true,
    wrap,
  });

  const roughness = generateRoughnessMap(rgb, gray, {
    method: options.roughness_method ?? "variance",
    strength: options.roughness_strength ?? 1.0,
    blur: options.roughness_blur ?? 1.5,
    contrast: options.roughness_contrast ?? 1.0,
    invert: options.roughness_invert ?? false,
    base: options.roughness_base ?? 0.5,
    roughness_min: options.roughness_min ?? 0.0,
    roughness_max: options.roughness_max ?? 1.0,
    wrap,
  });

  const includeAo = options.include_ao !== false;
  let ao: Float32Array;
  if (includeAo) {
    ao = generateAoMap(height, w, h, {
      strength: options.ao_strength ?? 1.0,
      blur: options.ao_blur ?? 2.0,
      exponent: options.ao_exponent ?? 1.2,
      wrap,
    });
  } else {
    ao = new Float32Array(w * h).fill(1.0);
  }

  // Generate Packed ORM texture (R: AO, G: Roughness, B: Metallic or Height)
  const orm = new Float32Array(w * h * 3);
  const packBlueWithHeight = options.orm_pack_blue === "height";
  for (let i = 0; i < w * h; i++) {
    const idx = i * 3;
    orm[idx] = ao[i]; // Red: Ambient Occlusion
    orm[idx + 1] = roughness[i]; // Green: Roughness
    orm[idx + 2] = packBlueWithHeight ? height[i] : 0.0; // Blue: Metallic (0 default) or Height
  }

  // Save diffuse, height, normal, roughness, ao, orm
  const diffuseOut = path.join(outputDir, "diffuse.png");
  const heightOut = path.join(outputDir, "height.png");
  const normalOut = path.join(outputDir, "normal.png");
  const roughnessOut = path.join(outputDir, "roughness.png");
  const ormOut = path.join(outputDir, "orm.png");

  await saveRgbPNG(diffuseOut, rgb.data, w, h);
  await saveGrayPNG(heightOut, height, w, h);
  await saveRgbPNG(normalOut, normal, w, h);
  await saveGrayPNG(roughnessOut, roughness, w, h);
  await saveRgbPNG(ormOut, orm, w, h);

  const seamAfter = seamError(rgb);

  const result: MapResult = {
    diffuse: "diffuse.png",
    height: "height.png",
    normal: "normal.png",
    roughness: "roughness.png",
    orm: "orm.png",
    width: w,
    height_px: h,
    aspect_ratio: Math.round((w / h) * 1000) / 1000,
    seamless: isSeamless,
    tileable: wrap,
    seam_before: Math.round(seamBefore * 100) / 100,
    seam_after: Math.round(seamAfter * 100) / 100,
  };

  if (includeAo) {
    const aoOut = path.join(outputDir, "ao.png");
    await saveGrayPNG(aoOut, ao, w, h);
    result.ao = "ao.png";
  }

  return result;
}
