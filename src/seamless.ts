/**
 * Make a texture seamless (tileable) — offline, in TypeScript.
 * Mirrors Python seamless.py logic.
 */
import sharp from "sharp";

export interface RGBImage {
  width: number;
  height: number;
  // Float32 array of shape (height, width, 3), values in [0, 1]
  data: Float32Array;
}

export function createRGBImage(width: number, height: number): RGBImage {
  return {
    width,
    height,
    data: new Float32Array(width * height * 3),
  };
}

export function cloneRGBImage(src: RGBImage): RGBImage {
  const dest = createRGBImage(src.width, src.height);
  dest.data.set(src.data);
  return dest;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Separable Gaussian blur on RGB image with symmetric/reflect padding.
 */
function gaussBlurRGB(src: RGBImage, radius: number): RGBImage {
  if (radius <= 0.01) return cloneRGBImage(src);
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
  for (let i = 0; i < size; i++) {
    kernel[i] /= sum;
  }

  const { width: w, height: h, data } = src;
  const temp = new Float32Array(w * h * 3);
  const out = new Float32Array(w * h * 3);

  // Horizontal pass (symmetric padding)
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 3;
    for (let x = 0; x < w; x++) {
      let rSum = 0, gSum = 0, bSum = 0;
      for (let k = 0; k < size; k++) {
        let sx = x + (k - r);
        if (sx < 0) sx = -sx - 1;
        else if (sx >= w) sx = 2 * w - 1 - sx;
        sx = clamp(sx, 0, w - 1);
        const idx = rowOffset + sx * 3;
        const kw = kernel[k];
        rSum += data[idx] * kw;
        gSum += data[idx + 1] * kw;
        bSum += data[idx + 2] * kw;
      }
      const outIdx = rowOffset + x * 3;
      temp[outIdx] = rSum;
      temp[outIdx + 1] = gSum;
      temp[outIdx + 2] = bSum;
    }
  }

  // Vertical pass (symmetric padding)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let rSum = 0, gSum = 0, bSum = 0;
      for (let k = 0; k < size; k++) {
        let sy = y + (k - r);
        if (sy < 0) sy = -sy - 1;
        else if (sy >= h) sy = 2 * h - 1 - sy;
        sy = clamp(sy, 0, h - 1);
        const idx = (sy * w + x) * 3;
        const kw = kernel[k];
        rSum += temp[idx] * kw;
        gSum += temp[idx + 1] * kw;
        bSum += temp[idx + 2] * kw;
      }
      const outIdx = (y * w + x) * 3;
      out[outIdx] = rSum;
      out[outIdx + 1] = gSum;
      out[outIdx + 2] = bSum;
    }
  }

  return { width: w, height: h, data: out };
}

/**
 * Lighting equalization: flattens large-scale brightness/color drift.
 */
export async function equalizeLighting(img: RGBImage, strength: number = 0.5): Promise<RGBImage> {
  const s = clamp(strength, 0.0, 1.0);
  if (s <= 0.001) return img;

  const { width: w, height: h, data } = img;
  const smallSide = 256;
  const scale = smallSide / Math.max(w, h);

  let sw = w;
  let sh = h;
  let small: RGBImage = img;

  if (scale < 1) {
    sw = Math.max(8, Math.round(w * scale));
    sh = Math.max(8, Math.round(h * scale));
    // Downscale using sharp
    const uint8 = new Uint8Array(w * h * 3);
    for (let i = 0; i < data.length; i++) {
      uint8[i] = Math.round(clamp(data[i], 0, 1) * 255);
    }
    const resizedBuffer = await sharp(Buffer.from(uint8.buffer), {
      raw: { width: w, height: h, channels: 3 },
    })
      .resize(sw, sh, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer();

    const smallImg = createRGBImage(sw, sh);
    for (let i = 0; i < resizedBuffer.length; i++) {
      smallImg.data[i] = resizedBuffer[i] / 255.0;
    }
    small = smallImg;
  }

  const lowSmall = gaussBlurRGB(small, Math.max(sw, sh) * 0.12);
  let low: RGBImage = lowSmall;

  if (sw !== w || sh !== h) {
    // Upscale blurred back to (w, h)
    const uint8 = new Uint8Array(sw * sh * 3);
    for (let i = 0; i < lowSmall.data.length; i++) {
      uint8[i] = Math.round(clamp(lowSmall.data[i], 0, 1) * 255);
    }
    const upBuffer = await sharp(Buffer.from(uint8.buffer), {
      raw: { width: sw, height: sh, channels: 3 },
    })
      .resize(w, h, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer();

    low = createRGBImage(w, h);
    for (let i = 0; i < upBuffer.length; i++) {
      low.data[i] = upBuffer[i] / 255.0;
    }
  }

  // Calculate mean per channel
  let meanR = 0, meanG = 0, meanB = 0;
  const numPixels = w * h;
  for (let i = 0; i < numPixels; i++) {
    meanR += data[i * 3];
    meanG += data[i * 3 + 1];
    meanB += data[i * 3 + 2];
  }
  meanR /= numPixels;
  meanG /= numPixels;
  meanB /= numPixels;

  const out = createRGBImage(w, h);
  for (let i = 0; i < numPixels; i++) {
    const idx = i * 3;
    const lowR = Math.max(low.data[idx], 1e-3);
    const lowG = Math.max(low.data[idx + 1], 1e-3);
    const lowB = Math.max(low.data[idx + 2], 1e-3);

    const gainR = Math.pow(meanR / lowR, s);
    const gainG = Math.pow(meanG / lowG, s);
    const gainB = Math.pow(meanB / lowB, s);

    out.data[idx] = clamp(data[idx] * gainR, 0, 1);
    out.data[idx + 1] = clamp(data[idx + 1] * gainG, 0, 1);
    out.data[idx + 2] = clamp(data[idx + 2] * gainB, 0, 1);
  }

  return out;
}

/**
 * Delighting / Shadow Removal: removes baked directional shadows and hot spots
 * using high-pass illumination equalization.
 */
export async function delightLighting(img: RGBImage, strength: number = 0.5): Promise<RGBImage> {
  const s = clamp(strength, 0.0, 1.0);
  if (s <= 0.001) return img;

  // Flatten large scale lighting gradients
  const equalized = await equalizeLighting(img, s * 0.9);
  const { width: w, height: h, data } = equalized;
  const out = createRGBImage(w, h);
  const numPixels = w * h;

  let avgLum = 0;
  for (let i = 0; i < numPixels; i++) {
    const idx = i * 3;
    const lum = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
    avgLum += lum;
  }
  avgLum /= numPixels;

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 3;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Compensate deep baked cast shadows towards baseline albedo
    const shadowDeficit = lum < avgLum ? Math.min(1.0, (avgLum - lum) / Math.max(0.01, avgLum)) : 0;
    const boost = shadowDeficit * s * 0.28;

    // Soften harsh blown specular highlights
    const highlightExcess = lum > avgLum ? Math.min(1.0, (lum - avgLum) / Math.max(0.01, 1.0 - avgLum)) : 0;
    const cut = highlightExcess * s * 0.18;

    out.data[idx] = clamp(r + boost - cut, 0, 1);
    out.data[idx + 1] = clamp(g + boost - cut, 0, 1);
    out.data[idx + 2] = clamp(b + boost - cut, 0, 1);
  }

  return out;
}

/**
 * Min-cost top->bottom path dynamic programming.
 */
function minCutPath(cost: Float32Array, rows: number, cols: number, cyclic: boolean): Int32Array {
  const BIG = 1e20;
  function run(startCol: number | null): { acc: Float32Array; back: Int8Array } {
    const acc = new Float32Array(cols);
    const back = new Int8Array(rows * cols);

    if (startCol === null) {
      for (let c = 0; c < cols; c++) acc[c] = cost[c];
    } else {
      acc.fill(BIG);
      acc[startCol] = cost[startCol];
    }

    const prevAcc = new Float32Array(cols);
    for (let r = 1; r < rows; r++) {
      prevAcc.set(acc);
      const rowOffset = r * cols;
      for (let c = 0; c < cols; c++) {
        const leftVal = c > 0 ? prevAcc[c - 1] : BIG;
        const midVal = prevAcc[c];
        const rightVal = c < cols - 1 ? prevAcc[c + 1] : BIG;

        let bestChoice = 0; // 0 = mid, -1 = left, +1 = right
        let minVal = midVal;
        if (leftVal < minVal) {
          minVal = leftVal;
          bestChoice = -1;
        }
        if (rightVal < minVal) {
          minVal = rightVal;
          bestChoice = 1;
        }

        acc[c] = cost[rowOffset + c] + minVal;
        back[rowOffset + c] = bestChoice;
      }
    }
    return { acc, back };
  }

  function trace(back: Int8Array, endCol: number): Int32Array {
    const path = new Int32Array(rows);
    path[rows - 1] = endCol;
    for (let r = rows - 1; r > 0; r--) {
      const choice = back[r * cols + path[r]];
      path[r - 1] = path[r] + choice;
    }
    return path;
  }

  const { acc, back } = run(null);
  let bestEnd = 0;
  let bestVal = acc[0];
  for (let c = 1; c < cols; c++) {
    if (acc[c] < bestVal) {
      bestVal = acc[c];
      bestEnd = c;
    }
  }

  const path = trace(back, bestEnd);
  if (!cyclic) return path;

  const start = path[0];
  const { acc: acc2, back: back2 } = run(start);
  const lo = Math.max(0, start - 1);
  const hi = Math.min(cols, start + 2);
  let endCol2 = lo;
  let minVal2 = acc2[lo];
  for (let c = lo + 1; c < hi; c++) {
    if (acc2[c] < minVal2) {
      minVal2 = acc2[c];
      endCol2 = c;
    }
  }
  return trace(back2, endCol2);
}

function feather1D(mask: Float32Array, rows: number, cols: number, radius: number): Float32Array {
  if (radius < 0.5) return mask;
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

  const out = new Float32Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    const rOffset = row * cols;
    for (let c = 0; c < cols; c++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        let sc = c + (k - r);
        sc = clamp(sc, 0, cols - 1);
        acc += mask[rOffset + sc] * kernel[k];
      }
      out[rOffset + c] = acc;
    }
  }
  return out;
}

function passHorizontal(img: RGBImage, method: string, blend: number, cyclic: boolean): RGBImage {
  const { width: w, height: h, data } = img;
  const halfW = Math.floor(w / 2);

  // Shifted by w/2
  const shifted = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const rOffset = y * w * 3;
    for (let x = 0; x < w; x++) {
      const srcX = (x + halfW) % w;
      const sIdx = rOffset + srcX * 3;
      const dIdx = rOffset + x * 3;
      shifted[dIdx] = data[sIdx];
      shifted[dIdx + 1] = data[sIdx + 1];
      shifted[dIdx + 2] = data[sIdx + 2];
    }
  }

  let band = Math.round(clamp(blend, 0.05, 0.45) * w);
  band = Math.max(4, Math.min(band, halfW - 2));

  if (method === "smart" && band >= 12 && h >= 4) {
    const feather = Math.max(1.5, band * 0.06);
    const margin = Math.ceil(feather * 2.5) + 1;

    // diff squared
    const diff = new Float32Array(h * w);
    for (let y = 0; y < h; y++) {
      const rOffset = y * w * 3;
      for (let x = 0; x < w; x++) {
        const idx = rOffset + x * 3;
        const dr = data[idx] - shifted[idx];
        const dg = data[idx + 1] - shifted[idx + 1];
        const db = data[idx + 2] - shifted[idx + 2];
        diff[y * w + x] = dr * dr + dg * dg + db * db;
      }
    }

    const mask = new Float32Array(h * w).fill(1.0);

    // Left band [margin, band)
    const leftCols = band - margin;
    if (leftCols > 0) {
      const leftCost = new Float32Array(h * leftCols);
      for (let y = 0; y < h; y++) {
        for (let c = 0; c < leftCols; c++) {
          leftCost[y * leftCols + c] = diff[y * w + (margin + c)];
        }
      }
      const pl = minCutPath(leftCost, h, leftCols, cyclic);
      for (let y = 0; y < h; y++) {
        const cutX = pl[y] + margin;
        for (let x = 0; x < cutX; x++) {
          mask[y * w + x] = 0.0;
        }
      }
    }

    // Right band [w - band, w - margin), mirrored horizontally
    const rightCols = band - margin;
    if (rightCols > 0) {
      const rightCost = new Float32Array(h * rightCols);
      for (let y = 0; y < h; y++) {
        for (let c = 0; c < rightCols; c++) {
          // reversed column order
          const actualX = w - margin - 1 - c;
          rightCost[y * rightCols + c] = diff[y * w + actualX];
        }
      }
      const pr = minCutPath(rightCost, h, rightCols, cyclic);
      for (let y = 0; y < h; y++) {
        const cutXFromRight = pr[y] + margin;
        const cutX = w - 1 - cutXFromRight;
        for (let x = cutX + 1; x < w; x++) {
          mask[y * w + x] = 0.0;
        }
      }
    }

    const featheredMask = feather1D(mask, h, w, feather);
    for (let y = 0; y < h; y++) {
      featheredMask[y * w] = 0.0;
      featheredMask[y * w + w - 1] = 0.0;
    }

    const out = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const m = featheredMask[i];
      const invM = 1.0 - m;
      const idx = i * 3;
      out[idx] = m * data[idx] + invM * shifted[idx];
      out[idx + 1] = m * data[idx + 1] + invM * shifted[idx + 1];
      out[idx + 2] = m * data[idx + 2] + invM * shifted[idx + 2];
    }
    return { width: w, height: h, data: out };
  }

  // Soft cross-fade (blend)
  let meanR = 0, meanG = 0, meanB = 0;
  const numPix = w * h;
  for (let i = 0; i < numPix; i++) {
    meanR += data[i * 3];
    meanG += data[i * 3 + 1];
    meanB += data[i * 3 + 2];
  }
  meanR /= numPix;
  meanG /= numPix;
  meanB /= numPix;

  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const rOffset = y * w * 3;
    for (let x = 0; x < w; x++) {
      const dist = Math.min(x, (w - 1) - x);
      const t = clamp(dist / band, 0.0, 1.0);
      const wgt = 0.5 - 0.5 * Math.cos(Math.PI * t);
      const invWgt = 1.0 - wgt;
      const norm = Math.sqrt(wgt * wgt + invWgt * invWgt);

      const idx = rOffset + x * 3;
      const ar = data[idx] - meanR;
      const ag = data[idx + 1] - meanG;
      const ab = data[idx + 2] - meanB;

      const br = shifted[idx] - meanR;
      const bg = shifted[idx + 1] - meanG;
      const bb = shifted[idx + 2] - meanB;

      const mr = wgt * ar + invWgt * br;
      const mg = wgt * ag + invWgt * bg;
      const mb = wgt * ab + invWgt * bb;

      out[idx] = clamp(meanR + mr / norm, 0.0, 1.0);
      out[idx + 1] = clamp(meanG + mg / norm, 0.0, 1.0);
      out[idx + 2] = clamp(meanB + mb / norm, 0.0, 1.0);
    }
  }

  return { width: w, height: h, data: out };
}

function transposeImage(img: RGBImage): RGBImage {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 3;
      const dstIdx = (x * h + y) * 3;
      out[dstIdx] = data[srcIdx];
      out[dstIdx + 1] = data[srcIdx + 1];
      out[dstIdx + 2] = data[srcIdx + 2];
    }
  }
  return { width: h, height: w, data: out };
}

async function mirrorTile(img: RGBImage): Promise<RGBImage> {
  const { width: w, height: h, data } = img;
  // 2x2 tiled: top = [img, flipX(img)], bot = [flipY(img), flipXY(img)]
  const fullW = w * 2;
  const fullH = h * 2;
  const full = new Uint8Array(fullW * fullH * 3);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 3;
      const r = Math.round(clamp(data[srcIdx], 0, 1) * 255);
      const g = Math.round(clamp(data[srcIdx + 1], 0, 1) * 255);
      const b = Math.round(clamp(data[srcIdx + 2], 0, 1) * 255);

      // Top-left
      let dstIdx = (y * fullW + x) * 3;
      full[dstIdx] = r; full[dstIdx + 1] = g; full[dstIdx + 2] = b;

      // Top-right (flip X)
      dstIdx = (y * fullW + (fullW - 1 - x)) * 3;
      full[dstIdx] = r; full[dstIdx + 1] = g; full[dstIdx + 2] = b;

      // Bottom-left (flip Y)
      dstIdx = ((fullH - 1 - y) * fullW + x) * 3;
      full[dstIdx] = r; full[dstIdx + 1] = g; full[dstIdx + 2] = b;

      // Bottom-right (flip XY)
      dstIdx = ((fullH - 1 - y) * fullW + (fullW - 1 - x)) * 3;
      full[dstIdx] = r; full[dstIdx + 1] = g; full[dstIdx + 2] = b;
    }
  }

  // Downscale back to (w, h)
  const resized = await sharp(Buffer.from(full.buffer), {
    raw: { width: fullW, height: fullH, channels: 3 },
  })
    .resize(w, h, { kernel: "lanczos3" })
    .raw()
    .toBuffer();

  const out = createRGBImage(w, h);
  for (let i = 0; i < resized.length; i++) {
    out.data[i] = resized[i] / 255.0;
  }
  return out;
}

export async function makeSeamless(
  rgb: RGBImage,
  method: string = "smart",
  blend: number = 0.25,
  equalize: number = 0.0
): Promise<RGBImage> {
  const normMethod = (method || "smart").toLowerCase();
  let img = await equalizeLighting(rgb, equalize);

  if (normMethod === "mirror") {
    return mirrorTile(img);
  }

  if (Math.min(img.width, img.height) < 8) {
    return img;
  }

  // Pass 1: horizontal
  img = passHorizontal(img, normMethod, blend, false);

  // Pass 2: vertical (transpose -> passHorizontal -> transpose)
  let transposed = transposeImage(img);
  transposed = passHorizontal(transposed, normMethod, blend, true);
  return transposeImage(transposed);
}

export function seamError(img: RGBImage): number {
  const { width: w, height: h, data } = img;
  let innerXDiff = 0, innerYDiff = 0, countX = 0, countY = 0;
  let wrapXDiff = 0, wrapYDiff = 0;

  for (let y = 0; y < h; y++) {
    const rOffset = y * w * 3;
    for (let x = 0; x < w - 1; x++) {
      const idx1 = rOffset + x * 3;
      const idx2 = rOffset + (x + 1) * 3;
      innerXDiff += (Math.abs(data[idx1] - data[idx2]) +
                     Math.abs(data[idx1 + 1] - data[idx2 + 1]) +
                     Math.abs(data[idx1 + 2] - data[idx2 + 2])) / 3;
      countX++;
    }
    const leftIdx = rOffset;
    const rightIdx = rOffset + (w - 1) * 3;
    wrapXDiff += (Math.abs(data[leftIdx] - data[rightIdx]) +
                  Math.abs(data[leftIdx + 1] - data[rightIdx + 1]) +
                  Math.abs(data[leftIdx + 2] - data[rightIdx + 2])) / 3;
  }

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h - 1; y++) {
      const idx1 = (y * w + x) * 3;
      const idx2 = ((y + 1) * w + x) * 3;
      innerYDiff += (Math.abs(data[idx1] - data[idx2]) +
                     Math.abs(data[idx1 + 1] - data[idx2 + 1]) +
                     Math.abs(data[idx1 + 2] - data[idx2 + 2])) / 3;
      countY++;
    }
    const topIdx = x * 3;
    const botIdx = ((h - 1) * w + x) * 3;
    wrapYDiff += (Math.abs(data[topIdx] - data[botIdx]) +
                  Math.abs(data[topIdx + 1] - data[botIdx + 1]) +
                  Math.abs(data[topIdx + 2] - data[botIdx + 2])) / 3;
  }

  const avgInner = (innerXDiff / Math.max(1, countX)) + (innerYDiff / Math.max(1, countY));
  const avgWrap = (wrapXDiff / h) + (wrapYDiff / w);
  return avgWrap / Math.max(avgInner, 1e-6);
}
