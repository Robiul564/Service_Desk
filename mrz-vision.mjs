/**
 * Fast Computer Vision Auto-Locator & Preprocessing for ICAO TD3 Passport MRZ Scanning
 *
 * Designed for effortless, box-free mobile scanning (< 1 second lock):
 * 1. Auto-locates the 2-line MRZ block ANYWHERE in the camera frame or photo
 *    using a ~3ms downscaled horizontal gradient (Sobel-X) projection detector.
 * 2. Fast quality analysis (only blocks completely dark/blank frames; gives helpful tips for glare/blur).
 * 3. Fast skew estimation on a downscaled proxy + bilinear deskew when tilted.
 * 4. O(W * H) integral-image Bradley-Roth adaptive thresholding at optimal ~1120px width
 *    (3x faster Tesseract OCR on mobile while keeping crisp OCR-B glyphs).
 * 5. Tight vertical MRZ band crop with clean white quiet-zone padding.
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
 * - Low light ("Too dark — turn on torch")
 * - Glare / overexposure ("Reduce glare — tilt slightly")
 * - Blur ("Hold steady")
 * - Low contrast ("Move closer")
 *
 * `hardBlock` is true ONLY for unusable frames (pitch black or zero contrast),
 * so mild blur/glare still attempts fast OCR while guiding the user.
 */
export function analyzeFrameQuality(gray, width, height) {
  const n = width * height;
  if (!n || width < 32 || height < 16) {
    return {
      ok: false,
      hardBlock: true,
      issue: "too_small",
      message: "Move closer to the passport.",
      metrics: { meanLuma: 0, glareRatio: 0, laplacianVar: 0, contrastStd: 0 }
    };
  }

  let sum = 0;
  let sumSq = 0;
  let glarePixels = 0;
  const stride = n > 120000 ? 2 : 1;
  let count = 0;
  for (let i = 0; i < n; i += stride) {
    const v = gray[i];
    sum += v;
    sumSq += v * v;
    if (v >= 248) glarePixels += 1;
    count += 1;
  }
  const meanLuma = sum / count;
  const contrastStd = Math.sqrt(Math.max(0, sumSq / count - meanLuma * meanLuma));
  const glareRatio = glarePixels / count;

  // Discrete 4-neighbor Laplacian variance (focus / sharpness metric)
  const step = width > 480 ? 2 : 1;
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
      hardBlock: meanLuma < 24,
      issue: "low_light",
      message: "Too dark — turn on torch or move to brighter light.",
      metrics
    };
  }
  if (glareRatio > 0.35 && meanLuma > 210) {
    return {
      ok: false,
      hardBlock: glareRatio > 0.75,
      issue: "glare",
      message: "Reduce glare — tilt passport slightly.",
      metrics
    };
  }
  if (contrastStd < 16) {
    return {
      ok: false,
      hardBlock: contrastStd < 7,
      issue: "low_contrast",
      message: "Move closer to the passport.",
      metrics
    };
  }
  if (laplacianVar < 35) {
    return {
      ok: false,
      hardBlock: false,
      issue: "blur",
      message: "Hold steady…",
      metrics
    };
  }

  return {
    ok: true,
    hardBlock: false,
    issue: null,
    message: "Reading passport…",
    metrics
  };
}

/**
 * Auto-locate the 2-line MRZ region ANYWHERE inside a grayscale frame (no box alignment needed!).
 *
 * Uses horizontal gradient energy (|I(x+1) - I(x-1)|) per row to find the strongest
 * wide horizontal band containing two dense rows of OCR-B characters.
 * Returns normalized coordinates { x, y, w, h, confidence } in [0..1].
 */
export function locateMrzInGrayscale(gray, width, height) {
  if (width < 40 || height < 40) {
    return { x: 0, y: 0.55, w: 1, h: 0.35, confidence: 0 };
  }

  const rowEnergy = new Float32Array(height);
  const rowSpan = new Float32Array(height);
  const rowLeft = new Int32Array(height);
  const rowRight = new Int32Array(height);

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    let active = 0;
    let firstX = width;
    let lastX = 0;
    for (let x = 2; x < width - 2; x += 1) {
      // Horizontal gradient detects crisp vertical strokes of OCR-B glyphs
      const gx = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
      if (gx >= 20) {
        active += 1;
        if (x < firstX) firstX = x;
        if (x > lastX) lastX = x;
      }
    }
    const density = active / width;
    const span = lastX > firstX ? (lastX - firstX) / width : 0;
    // MRZ lines have high stroke density (10%..65%) spanning a wide horizontal width (>= 35%)
    rowEnergy[y] = density >= 0.06 && density <= 0.75 ? density * (0.4 + span) : 0;
    rowSpan[y] = span;
    rowLeft[y] = firstX;
    rowRight[y] = lastX;
  }

  // Smooth row energy slightly with a 3-row box filter
  const smooth = new Float32Array(height);
  for (let y = 1; y < height - 1; y += 1) {
    smooth[y] = (rowEnergy[y - 1] + rowEnergy[y] + rowEnergy[y + 1]) / 3;
  }

  // Prefix sum for O(1) window scoring
  const pref = new Float64Array(height + 1);
  for (let y = 0; y < height; y += 1) pref[y + 1] = pref[y] + smooth[y];

  // Search candidate MRZ band heights (from 12% to 34% of frame height)
  const heights = [0.14, 0.20, 0.26, 0.32].map(f => Math.max(12, Math.round(height * f)));
  let bestScore = -1;
  let bestTop = Math.round(height * 0.55);
  let bestH = Math.round(height * 0.30);

  for (const winH of heights) {
    const half = Math.max(4, Math.floor(winH / 2));
    for (let y = 2; y <= height - winH - 2; y += 2) {
      const upperAvg = (pref[y + half] - pref[y]) / half;
      const lowerAvg = (pref[y + winH] - pref[y + half]) / (winH - half);
      // Both halves must have text strokes (signature of 2 parallel MRZ lines!)
      const minHalf = Math.min(upperAvg, lowerAvg);
      const avg = (upperAvg + lowerAvg) * 0.5;
      // Subtle preference for bands where text spans widely across X
      const score = minHalf * 0.7 + avg * 0.3;
      if (score > bestScore) {
        bestScore = score;
        bestTop = y;
        bestH = winH;
      }
    }
  }

  // Compute horizontal extent of the detected MRZ band with generous padding
  let minX = width;
  let maxX = 0;
  for (let y = bestTop; y < Math.min(height, bestTop + bestH); y += 1) {
    if (rowSpan[y] >= 0.30) {
      if (rowLeft[y] < minX) minX = rowLeft[y];
      if (rowRight[y] > maxX) maxX = rowRight[y];
    }
  }

  let nx = 0;
  let nw = 1;
  if (maxX > minX && (maxX - minX) / width >= 0.35) {
    const padX = Math.max(width * 0.06, (maxX - minX) * 0.08);
    const x0 = Math.max(0, minX - padX);
    const x1 = Math.min(width, maxX + padX);
    nx = x0 / width;
    nw = (x1 - x0) / width;
  }

  // Generous vertical padding (+28% top/bottom) so neither MRZ line is ever clipped
  const padY = Math.round(bestH * 0.28);
  const y0 = Math.max(0, bestTop - padY);
  const y1 = Math.min(height, bestTop + bestH + padY);

  return {
    x: Number(nx.toFixed(4)),
    y: Number((y0 / height).toFixed(4)),
    w: Number(nw.toFixed(4)),
    h: Number(((y1 - y0) / height).toFixed(4)),
    confidence: Number(bestScore.toFixed(4))
  };
}

/**
 * 3x3 median filter for edge-preserving salt-and-pepper / hologram denoising.
 */
export function denoise3x3Median(gray, width, height) {
  const out = new Uint8Array(width * height);
  out.set(gray);
  const win = new Uint8Array(9);

  for (let y = 1; y < height - 1; y += 1) {
    const r0 = (y - 1) * width;
    const r1 = y * width;
    const r2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x += 1) {
      win[0] = gray[r0 + x - 1]; win[1] = gray[r0 + x]; win[2] = gray[r0 + x + 1];
      win[3] = gray[r1 + x - 1]; win[4] = gray[r1 + x]; win[5] = gray[r1 + x + 1];
      win[6] = gray[r2 + x - 1]; win[7] = gray[r2 + x]; win[8] = gray[r2 + x + 1];
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
 * Fast skew angle estimation (range [-maxAngle, +maxAngle]) via horizontal ink projection variance.
 */
export function estimateSkewAngle(gray, width, height, { maxAngle = 5, stepDeg = 1.0 } = {}) {
  let mean = 0;
  const mStep = Math.max(1, Math.floor(gray.length / 4000));
  let mCount = 0;
  for (let i = 0; i < gray.length; i += mStep) {
    mean += gray[i];
    mCount += 1;
  }
  const thresh = mean / Math.max(1, mCount) - 12;

  const cx = width * 0.5;
  const cy = height * 0.5;
  const xStep = Math.max(1, Math.floor(width / 160));
  const yStep = Math.max(1, Math.floor(height / 80));

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
 * Runs in O(W * H) and cleanly eliminates uneven lighting / shadows.
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

  const isTextRow = y => rowInk[y] >= 0.025 && rowInk[y] <= 0.65;
  let top = 0;
  let bottom = height - 1;
  for (let y = 0; y < height; y += 1) {
    if (isTextRow(y)) { top = y; break; }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    if (isTextRow(y)) { bottom = y; break; }
  }

  const pad = Math.max(6, Math.round((bottom - top) * 0.14));
  top = Math.max(0, top - pad);
  bottom = Math.min(height - 1, bottom + pad);

  if (bottom - top < 18) return { top: 0, bottom: height - 1 };
  return { top, bottom };
}

/**
 * Browser helper: auto-locate MRZ ROI & corresponding VIZ ROI above it anywhere in a video/photo.
 * Runs on a fast 320px proxy canvas (~3ms).
 */
export function autoLocatePassportRois(source, srcWidth, srcHeight) {
  const pw = 320;
  const ph = Math.max(64, Math.round((srcHeight / Math.max(1, srcWidth)) * pw));
  const proxy = document.createElement("canvas");
  proxy.width = pw;
  proxy.height = ph;
  const ctx = proxy.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, srcWidth, srcHeight, 0, 0, pw, ph);
  const gray = toGrayscale(ctx.getImageData(0, 0, pw, ph).data, pw, ph);
  proxy.width = 0;
  proxy.height = 0;

  const box = locateMrzInGrayscale(gray, pw, ph);
  const mrzRoi = {
    sx: Math.round(box.x * srcWidth),
    sy: Math.round(box.y * srcHeight),
    sw: Math.max(64, Math.round(box.w * srcWidth)),
    sh: Math.max(32, Math.round(box.h * srcHeight))
  };

  // VIZ printed-name area sits directly above the detected MRZ band
  const vizHeight = Math.min(mrzRoi.sy, Math.round(mrzRoi.sh * 2.4));
  const vizRoi = {
    sx: mrzRoi.sx,
    sy: Math.max(0, mrzRoi.sy - vizHeight),
    sw: mrzRoi.sw,
    sh: Math.max(40, vizHeight)
  };

  return { mrzRoi, vizRoi, normalizedBox: box };
}

/**
 * Browser Canvas pipeline optimized for sub-second mobile OCR:
 * Crops MRZ ROI, scales to optimal ~1120px width (~25px per OCR-B glyph),
 * runs fast deskew + Bradley adaptive threshold + tight vertical crop with white quiet zone.
 */
export function preprocessMrzFromSource(source, roi, { skipQualityGate = false, tPercent = 12, fast = true } = {}) {
  const { sx, sy, sw, sh } = roi;
  // Optimal OCR-B width (~1120px = ~25px per glyph => 3x faster Tesseract than 1800px!)
  const maxW = fast ? 1120 : 1440;
  const minW = fast ? 880 : 1040;
  const targetWidth = Math.min(maxW, Math.max(minW, Math.round(sw)));
  const scale = targetWidth / Math.max(1, sw);
  const w = Math.max(64, Math.round(sw * scale));
  const h = Math.max(32, Math.round(sh * scale));

  const workCanvas = document.createElement("canvas");
  workCanvas.width = w;
  workCanvas.height = h;
  const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  workCanvas.width = 0;
  workCanvas.height = 0;

  let gray = toGrayscale(imgData.data, w, h);

  // Step 1: Assess quality — only hard-block pitch-black or zero-contrast frames so scanning feels effortless
  const quality = analyzeFrameQuality(gray, w, h);
  if (quality.hardBlock && !skipQualityGate) {
    return { canvas: null, quality, skewAngle: 0 };
  }

  // Step 2: Fast deskew estimation (±4° step 1.0° in live mode; ±5° step 0.5° in photo mode)
  const skewAngle = estimateSkewAngle(gray, w, h, {
    maxAngle: fast ? 4 : 5,
    stepDeg: fast ? 1.0 : 0.5
  });
  if (Math.abs(skewAngle) >= 0.75) {
    gray = rotateGrayscale(gray, w, h, skewAngle);
  }

  // Step 3: Light median denoise only in photo/high-quality mode (saves ~100ms/frame in live video)
  if (!fast) {
    gray = denoise3x3Median(gray, w, h);
  }

  // Step 4: Integral-image adaptive thresholding
  const binary = adaptiveThresholdBradley(gray, w, h, { tPercent });

  // Step 5: Tight vertical MRZ crop + white quiet-zone border
  const { top, bottom } = detectMrzVerticalBounds(binary, w, h);
  const cropH = bottom - top + 1;
  const border = 12;

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
 * Browser Canvas pipeline for non-blocking VIZ (Visual Inspection Zone) name cross-verification.
 */
export function preprocessVizFromSource(source, roi, skewAngle = 0) {
  const { sx, sy, sw, sh } = roi;
  if (sw < 40 || sh < 40) return null;

  const targetWidth = Math.min(1000, Math.max(640, Math.round(sw)));
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
  if (Math.abs(skewAngle) >= 0.75) {
    gray = rotateGrayscale(gray, w, h, skewAngle);
  }

  const binary = adaptiveThresholdBradley(gray, w, h, { radius: 12, tPercent: 10 });
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
