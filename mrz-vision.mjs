/**
 * Computer Vision Preprocessing & Quality Assessment for ICAO TD3 Passport MRZ Scanning
 *
 * Pipeline:
 * 1. Grayscale conversion (Rec. 709)
 * 2. Image quality analysis (low-light, glare/overexposure, blur via Laplacian variance, low contrast)
 * 3. Deskew estimation & bilinear rotation correction via horizontal projection variance
 * 4. 3x3 median denoising (removes glossy laminate speckles / hologram noise while preserving OCR-B edges)
 * 5. Integral-image Bradley-Roth adaptive local thresholding (handles uneven desk lighting & shadows)
 * 6. Tight MRZ vertical band localization + clean white quiet-zone padding for OCR
 */

/**
 * Convert RGBA pixel buffer to 8-bit grayscale Uint8Array using Rec. 709 luma.
 */
export function toGrayscale(rgba, width, height) {
  const n = width * height;
  const gray = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    gray[i] = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2] + 0.5) | 0;
  }
  return gray;
}

/**
 * Assess image quality on a grayscale MRZ crop to produce actionable user prompts:
 * - Low light ("Too dark — turn on torch or move to brighter light")
 * - Glare / specular reflection ("Reduce glare — tilt passport slightly")
 * - Motion / defocus blur ("Hold steady — image is blurry")
 * - Low contrast / too far ("Move closer — fit MRZ lines inside the guide")
 */
export function analyzeFrameQuality(gray, width, height) {
  const n = width * height;
  if (!n || width < 32 || height < 16) {
    return {
      ok: false,
      issue: "too_small",
      message: "Move closer — MRZ region is too small.",
      metrics: { meanLuma: 0, glareRatio: 0, laplacianVar: 0, contrastStd: 0 }
    };
  }

  let sum = 0;
  let sumSq = 0;
  let glarePixels = 0;
  for (let i = 0; i < n; i += 1) {
    const v = gray[i];
    sum += v;
    sumSq += v * v;
    if (v >= 248) glarePixels += 1;
  }
  const meanLuma = sum / n;
  const contrastStd = Math.sqrt(Math.max(0, sumSq / n - meanLuma * meanLuma));
  const glareRatio = glarePixels / n;

  // Discrete 4-neighbor Laplacian variance (focus / sharpness metric)
  // Sample every 2nd pixel on large crops for real-time mobile speed
  const step = width > 640 ? 2 : 1;
  let lapSum = 0;
  let lapSumSq = 0;
  let lapCount = 0;
  for (let y = 1; y < height - 1; y += step) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += step) {
      const idx = row + x;
      const lap = gray[idx - width] + gray[idx + width] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
      lapSum += lap;
      lapSumSq += lap * lap;
      lapCount += 1;
    }
  }
  const lapMean = lapCount ? lapSum / lapCount : 0;
  const laplacianVar = lapCount ? Math.max(0, lapSumSq / lapCount - lapMean * lapMean) : 0;

  const metrics = {
    meanLuma: Number(meanLuma.toFixed(1)),
    glareRatio: Number(glareRatio.toFixed(3)),
    laplacianVar: Number(laplacianVar.toFixed(1)),
    contrastStd: Number(contrastStd.toFixed(1))
  };

  if (meanLuma < 45) {
    return {
      ok: false,
      issue: "low_light",
      message: "Too dark — turn on torch or move to brighter light.",
      metrics
    };
  }
  if (glareRatio > 0.35 && meanLuma > 210) {
    return {
      ok: false,
      issue: "glare",
      message: "Reduce glare — tilt passport slightly away from light.",
      metrics
    };
  }
  if (contrastStd < 16) {
    return {
      ok: false,
      issue: "low_contrast",
      message: "Move closer — keep both MRZ lines crisp inside the green box.",
      metrics
    };
  }
  if (laplacianVar < 35) {
    return {
      ok: false,
      issue: "blur",
      message: "Hold steady — focus on the passport bottom lines.",
      metrics
    };
  }

  return {
    ok: true,
    issue: null,
    message: "Hold steady — reading MRZ…",
    metrics
  };
}

/**
 * 3x3 median filter for edge-preserving salt-and-pepper / hologram denoising.
 */
export function denoise3x3Median(gray, width, height) {
  const out = new Uint8Array(width * height);
  out.set(gray); // Preserve 1px border
  const win = new Uint8Array(9);

  for (let y = 1; y < height - 1; y += 1) {
    const r0 = (y - 1) * width;
    const r1 = y * width;
    const r2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x += 1) {
      win[0] = gray[r0 + x - 1]; win[1] = gray[r0 + x]; win[2] = gray[r0 + x + 1];
      win[3] = gray[r1 + x - 1]; win[4] = gray[r1 + x]; win[5] = gray[r1 + x + 1];
      win[6] = gray[r2 + x - 1]; win[7] = gray[r2 + x]; win[8] = gray[r2 + x + 1];
      // Partial insertion sort up to index 4 (median of 9)
      for (let i = 1; i < 9; i += 1) {
        const key = win[i];
        let j = i - 1;
        while (j >= 0 && win[j] > key) {
          win[j + 1] = win[j];
          j -= 1;
        }
        win[j + 1] = key;
      }
      out[r1 + x] = win[4];
    }
  }
  return out;
}

/**
 * Estimate small skew angle (in degrees, range [-maxAngle, +maxAngle]) of horizontal MRZ lines
 * by maximizing variance of horizontal dark-ink projection profile.
 */
export function estimateSkewAngle(gray, width, height, { maxAngle = 5, stepDeg = 0.5 } = {}) {
  // Compute coarse threshold (global mean - 12) for fast projection scoring
  let mean = 0;
  for (let i = 0; i < gray.length; i += 1) mean += gray[i];
  const thresh = mean / Math.max(1, gray.length) - 12;

  const cx = width * 0.5;
  const cy = height * 0.5;
  const xStep = Math.max(1, Math.floor(width / 220));
  const yStep = Math.max(1, Math.floor(height / 120));

  let bestAngle = 0;
  let bestScore = -1;
  const proj = new Float64Array(height);

  for (let deg = -maxAngle; deg <= maxAngle + 1e-6; deg += stepDeg) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    proj.fill(0);

    for (let y = 0; y < height; y += yStep) {
      const dy = y - cy;
      const row = y * width;
      for (let x = 0; x < width; x += xStep) {
        if (gray[row + x] < thresh) {
          const ry = Math.round((x - cx) * sin + dy * cos + cy);
          if (ry >= 0 && ry < height) proj[ry] += 1;
        }
      }
    }

    // Projection profile variance: highest when dark MRZ lines are perfectly horizontal
    let sum = 0;
    let sumSq = 0;
    for (let y = 0; y < height; y += 1) {
      sum += proj[y];
      sumSq += proj[y] * proj[y];
    }
    const variance = sumSq / height - (sum / height) ** 2;
    if (variance > bestScore) {
      bestScore = variance;
      bestAngle = Number(deg.toFixed(2));
    }
  }

  return bestAngle;
}

/**
 * Rotate a grayscale buffer by `angleDeg` around its center (bilinear interpolation, white fill).
 */
export function rotateGrayscale(gray, width, height, angleDeg) {
  if (Math.abs(angleDeg) < 0.25) return gray;
  const out = new Uint8Array(width * height);
  out.fill(255);

  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width * 0.5;
  const cy = height * 0.5;

  for (let y = 0; y < height; y += 1) {
    const dy = y - cy;
    const outRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx;
      const sx = dx * cos - dy * sin + cx;
      const sy = dx * sin + dy * cos + cy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 >= 0 && x0 < width - 1 && y0 >= 0 && y0 < height - 1) {
        const fx = sx - x0;
        const fy = sy - y0;
        const r0 = y0 * width + x0;
        const r1 = r0 + width;
        const top = gray[r0] * (1 - fx) + gray[r0 + 1] * fx;
        const bot = gray[r1] * (1 - fx) + gray[r1 + 1] * fx;
        out[outRow + x] = (top * (1 - fy) + bot * fy + 0.5) | 0;
      }
    }
  }
  return out;
}

/**
 * Bradley-Roth Integral-Image Adaptive Local Thresholding.
 * Runs in O(W * H) regardless of window size and cleanly eliminates uneven lighting / shadows.
 * Output: Uint8Array of 0 (ink/black) and 255 (paper/white).
 */
export function adaptiveThresholdBradley(gray, width, height, { radius = null, tPercent = 12 } = {}) {
  const r = radius ?? Math.max(8, Math.round(Math.min(width, height) * 0.08));
  const integral = new Uint32Array((width + 1) * (height + 1));
  const stride = width + 1;

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const gRow = y * width;
    const iRow = (y + 1) * stride;
    const iPrev = y * stride;
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[gRow + x];
      integral[iRow + x + 1] = integral[iPrev + x + 1] + rowSum;
    }
  }

  const out = new Uint8Array(width * height);
  const factor = (100 - tPercent) / 100;

  for (let y = 0; y < height; y += 1) {
    const y1 = Math.max(0, y - r);
    const y2 = Math.min(height - 1, y + r);
    const gRow = y * width;
    const rowTop = y1 * stride;
    const rowBot = (y2 + 1) * stride;

    for (let x = 0; x < width; x += 1) {
      const x1 = Math.max(0, x - r);
      const x2 = Math.min(width - 1, x + r);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[rowBot + x2 + 1] - integral[rowTop + x2 + 1] - integral[rowBot + x1] + integral[rowTop + x1];
      out[gRow + x] = gray[gRow + x] * count < sum * factor ? 0 : 255;
    }
  }

  return out;
}

/**
 * Detect tight vertical bounds of the dense MRZ text block in a binarized image.
 * Returns { top, bottom } pixel row indices.
 */
export function detectMrzVerticalBounds(binary, width, height) {
  const rowInk = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    let dark = 0;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (binary[row + x] === 0) dark += 1;
    }
    rowInk[y] = dark / width;
  }

  // MRZ rows have moderate ink density (roughly 3%..45% dark pixels; ignore solid black borders > 65%)
  const isTextRow = y => rowInk[y] >= 0.03 && rowInk[y] <= 0.65;

  let top = 0;
  let bottom = height - 1;
  for (let y = 0; y < height; y += 1) {
    if (isTextRow(y)) { top = y; break; }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    if (isTextRow(y)) { bottom = y; break; }
  }

  // Add breathing margin around detected text bands
  const pad = Math.max(6, Math.round((bottom - top) * 0.12));
  top = Math.max(0, top - pad);
  bottom = Math.min(height - 1, bottom + pad);

  if (bottom - top < 20) return { top: 0, bottom: height - 1 };
  return { top, bottom };
}

/**
 * Browser Canvas pipeline:
 * Crops MRZ ROI from HTMLVideoElement / ImageBitmap / HTMLCanvasElement,
 * checks frame quality, deskews, denoises, applies adaptive thresholding,
 * tightly trims vertical noise, and adds a clean white quiet zone for Tesseract OCR.
 */
export function preprocessMrzFromSource(source, roi, { skipQualityGate = false, tPercent = 12 } = {}) {
  const { sx, sy, sw, sh } = roi;
  // Optimal horizontal resolution for 44 OCR-B chars (~34px per glyph => ~1500px)
  const targetWidth = Math.min(1800, Math.max(1000, Math.round(sw * 1.5)));
  const scale = targetWidth / Math.max(1, sw);
  const w = Math.max(64, Math.round(sw * scale));
  const h = Math.max(32, Math.round(sh * scale));

  const workCanvas = document.createElement("canvas");
  workCanvas.width = w;
  workCanvas.height = h;
  const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  let gray = toGrayscale(imgData.data, w, h);

  // Step 1: Assess image quality (blur, glare, low light, contrast)
  const quality = analyzeFrameQuality(gray, w, h);
  if (!quality.ok && !skipQualityGate) {
    return { canvas: null, quality, skewAngle: 0 };
  }

  // Step 2: Estimate & correct skew angle (tilt up to ±5°)
  const skewAngle = estimateSkewAngle(gray, w, h, { maxAngle: 5, stepDeg: 0.5 });
  if (Math.abs(skewAngle) >= 0.5) {
    gray = rotateGrayscale(gray, w, h, skewAngle);
  }

  // Step 3: Edge-preserving 3x3 median denoise
  gray = denoise3x3Median(gray, w, h);

  // Step 4: Integral-image adaptive thresholding
  const binary = adaptiveThresholdBradley(gray, w, h, { tPercent });

  // Step 5: Tight vertical MRZ crop + white quiet-zone border (helps Tesseract segmentation)
  const { top, bottom } = detectMrzVerticalBounds(binary, w, h);
  const cropH = bottom - top + 1;
  const border = 14;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = w + border * 2;
  outCanvas.height = cropH + border * 2;
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
  outCtx.fillStyle = "#ffffff";
  outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);

  const outImg = outCtx.createImageData(w, cropH);
  for (let y = 0; y < cropH; y += 1) {
    const srcRow = (top + y) * w;
    const dstRow = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      const v = binary[srcRow + x];
      const p = dstRow + x * 4;
      outImg.data[p] = v;
      outImg.data[p + 1] = v;
      outImg.data[p + 2] = v;
      outImg.data[p + 3] = 255;
    }
  }
  outCtx.putImageData(outImg, border, border);

  return { canvas: outCanvas, quality, skewAngle };
}

/**
 * Browser Canvas pipeline for the Visual Inspection Zone (VIZ) above the MRZ:
 * Captures the upper passport bio page (where Surname / Given Names are printed)
 * with clean grayscale + contrast normalization for cross-verification OCR.
 */
export function preprocessVizFromSource(source, roi, skewAngle = 0) {
  const { sx, sy, sw, sh } = roi;
  if (sw < 40 || sh < 40) return null;

  const targetWidth = Math.min(1400, Math.max(800, Math.round(sw)));
  const scale = targetWidth / Math.max(1, sw);
  const w = Math.max(64, Math.round(sw * scale));
  const h = Math.max(64, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  let gray = toGrayscale(imgData.data, w, h);
  if (Math.abs(skewAngle) >= 0.5) {
    gray = rotateGrayscale(gray, w, h, skewAngle);
  }

  // Mild adaptive thresholding tuned for smaller VIZ labels + printed name text
  const binary = adaptiveThresholdBradley(gray, w, h, { radius: 14, tPercent: 10 });
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    const v = binary[i];
    imgData.data[p] = v;
    imgData.data[p + 1] = v;
    imgData.data[p + 2] = v;
    imgData.data[p + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}
