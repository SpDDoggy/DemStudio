import { computeDemGradientNormals } from "./terrain-geometry.js";

function validAt(mask, index) {
  return !mask || mask.length === 0 || Boolean(mask[index]);
}

export function smoothTerrainHeights(
  heights,
  width,
  height,
  validMask = null,
  iterations = 2,
) {
  if (!heights || heights.length !== width * height) {
    throw new RangeError("heights length must equal width * height");
  }
  const passes = Math.max(0, Math.min(8, Math.round(Number(iterations) || 0)));
  if (passes === 0) return Float32Array.from(heights);
  // A repeated 3x3 binomial filter has sigma ~= sqrt(passes).  The separable
  // implementation produces the same isotropic intent with O(radius) work per
  // vertex instead of nine neighbourhood reads for every pass.
  return gaussianBlurTerrain(
    heights,
    width,
    height,
    validMask,
    Math.sqrt(passes),
  );
}

function gaussianKernel1d(sigma) {
  const finiteSigma = Math.max(0, Number(sigma) || 0);
  if (finiteSigma <= 1e-4) return Float32Array.of(1);
  const radius = Math.max(1, Math.min(12, Math.ceil(finiteSigma * 2.5)));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * finiteSigma * finiteSigma));
    kernel[offset + radius] = weight;
    total += weight;
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index] /= total;
  return kernel;
}

export function gaussianBlurTerrain(
  heights,
  width,
  height,
  validMask = null,
  sigmaSamples = 1,
) {
  if (!heights || heights.length !== width * height) {
    throw new RangeError("heights length must equal width * height");
  }
  const kernel = gaussianKernel1d(sigmaSamples);
  if (kernel.length === 1) return Float32Array.from(heights);
  const radius = (kernel.length - 1) >> 1;
  const horizontal = new Float32Array(heights.length);
  const output = new Float32Array(heights.length);

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col;
      if (!validAt(validMask, index)) {
        horizontal[index] = heights[index];
        continue;
      }
      let sum = 0;
      let weight = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleCol = col + offset;
        if (sampleCol < 0 || sampleCol >= width) continue;
        const sampleIndex = row * width + sampleCol;
        if (!validAt(validMask, sampleIndex)) continue;
        const sampleWeight = kernel[offset + radius];
        sum += heights[sampleIndex] * sampleWeight;
        weight += sampleWeight;
      }
      horizontal[index] = weight > 0 ? sum / weight : heights[index];
    }
  }

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col;
      if (!validAt(validMask, index)) {
        output[index] = heights[index];
        continue;
      }
      let sum = 0;
      let weight = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleRow = row + offset;
        if (sampleRow < 0 || sampleRow >= height) continue;
        const sampleIndex = sampleRow * width + col;
        if (!validAt(validMask, sampleIndex)) continue;
        const sampleWeight = kernel[offset + radius];
        sum += horizontal[sampleIndex] * sampleWeight;
        weight += sampleWeight;
      }
      output[index] = weight > 0 ? sum / weight : heights[index];
    }
  }
  return output;
}

export function blendTerrainNormals(
  fineNormals,
  coarseNormals,
  fineWeight = 0,
) {
  if (!fineNormals || !coarseNormals || fineNormals.length !== coarseNormals.length) {
    throw new RangeError("normal fields must have equal lengths");
  }
  const weight = Math.max(0, Math.min(1, Number(fineWeight) || 0));
  if (weight === 0) return Float32Array.from(coarseNormals);
  const coarseWeight = 1 - weight;
  const output = new Float32Array(fineNormals.length);
  for (let offset = 0; offset < output.length; offset += 3) {
    const x = fineNormals[offset] * weight + coarseNormals[offset] * coarseWeight;
    const y = fineNormals[offset + 1] * weight + coarseNormals[offset + 1] * coarseWeight;
    const z = fineNormals[offset + 2] * weight + coarseNormals[offset + 2] * coarseWeight;
    const inverseLength = 1 / Math.max(1e-8, Math.hypot(x, y, z));
    output[offset] = x * inverseLength;
    output[offset + 1] = y * inverseLength;
    output[offset + 2] = z * inverseLength;
  }
  return output;
}

export function computeTerrainDetailCurvature(
  mediumHeights,
  broadHeights,
  validMask = null,
  verticalScale = 1,
  responseScale = 0.02,
) {
  if (!mediumHeights || !broadHeights || mediumHeights.length !== broadHeights.length) {
    throw new RangeError("height fields must have equal lengths");
  }
  const scale = Math.max(1e-8, Math.abs(Number(verticalScale) || 1));
  const raw = new Float32Array(mediumHeights.length);
  for (let index = 0; index < raw.length; index += 1) {
    if (!validAt(validMask, index)) continue;
    const value = (mediumHeights[index] - broadHeights[index]) * scale;
    if (!Number.isFinite(value)) continue;
    raw[index] = value;
  }
  // Never normalize against a tile-local statistic.  Local RMS made identical
  // slopes change brightness when a tile or LOD boundary was crossed.
  const stableResponseScale = Math.max(1e-8, Math.abs(Number(responseScale) || 0.02));
  for (let index = 0; index < raw.length; index += 1) {
    raw[index] = validAt(validMask, index)
      ? Math.tanh(raw[index] / stableResponseScale)
      : 0;
  }
  return raw;
}

export function computeTerrainNormalLod({
  heights,
  width,
  height,
  worldWidth,
  worldDepth,
  verticalScale,
  validMask = null,
  coarseIterations = 4,
  shadingFineWeight = 0,
  normalSigmaWorld = null,
  broadSigmaWorld = null,
  curvatureResponseScale = 0.02,
}) {
  const spacingX = Math.abs(Number(worldWidth) || 1) / Math.max(1, width - 1);
  const spacingZ = Math.abs(Number(worldDepth) || 1) / Math.max(1, height - 1);
  const spacing = Math.max(1e-8, Math.sqrt(spacingX * spacingZ));
  const fallbackSigma = Math.sqrt(Math.max(1, Number(coarseIterations) || 4));
  const mediumSigmaSamples = normalSigmaWorld == null
    ? fallbackSigma
    : Math.max(0.35, Number(normalSigmaWorld) / spacing);
  const broadSigmaSamples = broadSigmaWorld == null
    ? Math.sqrt(Math.min(8, Math.max(1, Number(coarseIterations) || 4) + 3))
    : Math.max(mediumSigmaSamples + 0.5, Number(broadSigmaWorld) / spacing);
  const coarseHeights = gaussianBlurTerrain(
    heights,
    width,
    height,
    validMask,
    mediumSigmaSamples,
  );
  const broadHeights = gaussianBlurTerrain(
    heights,
    width,
    height,
    validMask,
    broadSigmaSamples,
  );
  const fineNormals = computeDemGradientNormals(
      heights,
      width,
      height,
      worldWidth,
      worldDepth,
      verticalScale,
      validMask,
    );
  const coarseNormals = computeDemGradientNormals(
      coarseHeights,
      width,
      height,
      worldWidth,
      worldDepth,
      verticalScale,
      validMask,
    );
  return {
    fineNormals,
    coarseNormals,
    // Vertex positions retain the authoritative DEM samples. The lighting
    // normal intentionally uses only the isotropic low-frequency field: even
    // a small contribution from the sample-scale gradient reintroduces the
    // raster row/column cadence as contour-like bands on white gypsum.
    shadingNormals: blendTerrainNormals(
      fineNormals,
      coarseNormals,
      shadingFineWeight,
    ),
    coarseHeights,
    broadHeights,
    detailCurvature: computeTerrainDetailCurvature(
      coarseHeights,
      broadHeights,
      validMask,
      verticalScale,
      curvatureResponseScale,
    ),
  };
}
