/**
 * Deterministic terrain sky-visibility precomputation.
 *
 * The implementation deliberately keeps every direction independent and
 * reduces them serially. This avoids the shared-accumulator race in the
 * reference parallel algorithm and makes identical inputs bit-for-bit stable.
 *
 * Optional directional RGBA channel convention:
 *   R = north, G = east, B = south, A = west.
 *
 * The primary directional output keeps one Float32Array per input direction.
 * With the defaults this is eight channels (N, NE, E, SE, S, SW, W, NW), so
 * changing the sun only needs a cheap reweight and never rescans the DEM.
 */

const DEG_TO_RAD = Math.PI / 180;

export const DEFAULT_SKY_DIRECTIONS = Object.freeze([
  Object.freeze({ azimuthDeg: 0, sourceColStep: 0, sourceRowStep: -1, weight: 1 }),
  Object.freeze({ azimuthDeg: 45, sourceColStep: 1, sourceRowStep: -1, weight: Math.SQRT1_2 }),
  Object.freeze({ azimuthDeg: 90, sourceColStep: 1, sourceRowStep: 0, weight: 1 }),
  Object.freeze({ azimuthDeg: 135, sourceColStep: 1, sourceRowStep: 1, weight: Math.SQRT1_2 }),
  Object.freeze({ azimuthDeg: 180, sourceColStep: 0, sourceRowStep: 1, weight: 1 }),
  Object.freeze({ azimuthDeg: 225, sourceColStep: -1, sourceRowStep: 1, weight: Math.SQRT1_2 }),
  Object.freeze({ azimuthDeg: 270, sourceColStep: -1, sourceRowStep: 0, weight: 1 }),
  Object.freeze({ azimuthDeg: 315, sourceColStep: -1, sourceRowStep: -1, weight: Math.SQRT1_2 }),
]);

export const DEFAULT_SKY_ELEVATIONS = Object.freeze([
  Object.freeze({ elevationDeg: 6, weight: 0.08 }),
  Object.freeze({ elevationDeg: 15, weight: 0.16 }),
  Object.freeze({ elevationDeg: 30, weight: 0.24 }),
  Object.freeze({ elevationDeg: 50, weight: 0.28 }),
  Object.freeze({ elevationDeg: 72, weight: 0.24 }),
]);

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function greatestCommonDivisor(a, b) {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function normalizeDirection(direction, index) {
  const sourceColStep = Number(direction.sourceColStep);
  const sourceRowStep = Number(direction.sourceRowStep);
  if (
    !Number.isInteger(sourceColStep)
    || !Number.isInteger(sourceRowStep)
    || (sourceColStep === 0 && sourceRowStep === 0)
  ) {
    throw new TypeError(
      `directions[${index}] must have non-zero integer sourceColStep/sourceRowStep`,
    );
  }

  const divisor = greatestCommonDivisor(sourceColStep, sourceRowStep);
  const weight = direction.weight ?? 1;
  assertPositiveFinite(weight, `directions[${index}].weight`);

  let azimuthDeg = direction.azimuthDeg;
  if (azimuthDeg === undefined) {
    azimuthDeg = Math.atan2(sourceColStep, -sourceRowStep) / DEG_TO_RAD;
  }
  if (!Number.isFinite(azimuthDeg)) {
    throw new TypeError(`directions[${index}].azimuthDeg must be finite`);
  }

  return {
    azimuthDeg: ((azimuthDeg % 360) + 360) % 360,
    sourceColStep: sourceColStep / divisor,
    sourceRowStep: sourceRowStep / divisor,
    weight,
  };
}

function normalizeElevation(sample, index) {
  const elevationDeg = typeof sample === "number" ? sample : sample.elevationDeg;
  const weight = typeof sample === "number" ? 1 : (sample.weight ?? 1);
  if (!Number.isFinite(elevationDeg) || elevationDeg <= 0 || elevationDeg > 90) {
    throw new RangeError(`elevations[${index}] must be in (0, 90] degrees`);
  }
  assertPositiveFinite(weight, `elevations[${index}].weight`);
  return { elevationDeg, weight };
}

function makeValidityMask(elevations, pixelCount, suppliedMask, noDataValue) {
  if (suppliedMask !== undefined && suppliedMask.length !== pixelCount) {
    throw new RangeError("validMask length must equal width * height");
  }

  const mask = new Uint8Array(pixelCount);
  const noDataIsNaN = Number.isNaN(noDataValue);
  for (let index = 0; index < pixelCount; index += 1) {
    const elevation = elevations[index];
    const finite = Number.isFinite(elevation);
    const notSentinel = noDataValue === undefined
      || (noDataIsNaN ? !Number.isNaN(elevation) : elevation !== noDataValue);
    mask[index] = finite && notSentinel && (suppliedMask === undefined || Boolean(suppliedMask[index]))
      ? 1
      : 0;
  }
  return mask;
}

function forEachRayStart(width, height, awayColStep, awayRowStep, visit) {
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const predecessorCol = col - awayColStep;
      const predecessorRow = row - awayRowStep;
      if (
        predecessorCol < 0
        || predecessorCol >= width
        || predecessorRow < 0
        || predecessorRow >= height
      ) {
        visit(col, row);
      }
    }
  }
}

/**
 * Compute visibility for one fixed azimuth over several sky elevations.
 *
 * A NoData cell resets the rolling horizon. This is intentionally fail-open
 * for rendering: unknown terrain never fabricates a shadow on known terrain.
 */
function computeDirectionVisibility({
  elevations,
  validMask,
  width,
  height,
  cellSizeX,
  cellSizeY,
  zScale,
  direction,
  skyElevations,
  horizonEpsilon,
}) {
  const pixelCount = width * height;
  const result = new Float32Array(pixelCount);
  const awayColStep = -direction.sourceColStep;
  const awayRowStep = -direction.sourceRowStep;
  const horizontalStep = Math.hypot(
    awayColStep * cellSizeX,
    awayRowStep * cellSizeY,
  );
  const totalElevationWeight = skyElevations.reduce((sum, sample) => sum + sample.weight, 0);

  for (const sample of skyElevations) {
    const verticalDrop = Math.tan(sample.elevationDeg * DEG_TO_RAD) * horizontalStep;

    forEachRayStart(width, height, awayColStep, awayRowStep, (startCol, startRow) => {
      let col = startCol;
      let row = startRow;
      let hasHorizon = false;
      let horizonHeight = 0;

      while (col >= 0 && col < width && row >= 0 && row < height) {
        const index = row * width + col;
        if (!validMask[index]) {
          hasHorizon = false;
        } else {
          const terrainHeight = elevations[index] * zScale;
          if (!hasHorizon) {
            result[index] += sample.weight;
            horizonHeight = terrainHeight;
            hasHorizon = true;
          } else {
            const propagatedHorizon = horizonHeight - verticalDrop;
            if (terrainHeight + horizonEpsilon >= propagatedHorizon) {
              result[index] += sample.weight;
            }
            horizonHeight = Math.max(terrainHeight, propagatedHorizon);
          }
        }
        col += awayColStep;
        row += awayRowStep;
      }
    });
  }

  const inverseWeight = 1 / totalElevationWeight;
  for (let index = 0; index < pixelCount; index += 1) {
    result[index] = validMask[index] ? result[index] * inverseWeight : 0;
  }
  return result;
}

function cardinalBasisWeights(azimuthDeg) {
  const azimuth = azimuthDeg * DEG_TO_RAD;
  return [
    Math.max(0, Math.cos(azimuth)),
    Math.max(0, Math.sin(azimuth)),
    Math.max(0, -Math.cos(azimuth)),
    Math.max(0, -Math.sin(azimuth)),
  ];
}

/**
 * @param {object} options
 * @param {ArrayLike<number>} options.elevations Row-major DEM elevations.
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.cellSizeX Physical width of a pixel.
 * @param {number} options.cellSizeY Physical height of a pixel.
 * @param {ArrayLike<number>} [options.validMask] Non-zero means valid.
 * @param {number} [options.noDataValue] Optional exact NoData sentinel.
 * @param {number} [options.zScale=1] Vertical-unit conversion/exaggeration.
 * @param {Array<object>} [options.directions] Fixed integer-grid directions.
 * @param {Array<number|object>} [options.skyElevations] Sky elevation samples.
 * @param {boolean} [options.includeDirectionalBasis=false] Also emit optional
 * four-cardinal RGBA compression. The full per-direction channels are always
 * returned.
 * @param {number} [options.horizonEpsilon=1e-6]
 * @returns {{
 *   skyVisibility: Float32Array,
 *   directionalVisibility: Array<Float32Array>,
 *   directionalBasis: Float32Array|null,
 *   validMask: Uint8Array,
 *   width: number,
 *   height: number
 * }}
 */
export function computeTerrainSkyVisibility(options) {
  const {
    elevations,
    width,
    height,
    cellSizeX,
    cellSizeY,
    validMask: suppliedMask,
    noDataValue,
    zScale = 1,
    directions = DEFAULT_SKY_DIRECTIONS,
    skyElevations = DEFAULT_SKY_ELEVATIONS,
    includeDirectionalBasis = false,
    horizonEpsilon = 1e-6,
  } = options ?? {};

  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("width and height must be positive integers");
  }
  const pixelCount = width * height;
  if (elevations === undefined || elevations.length !== pixelCount) {
    throw new RangeError("elevations length must equal width * height");
  }
  assertPositiveFinite(cellSizeX, "cellSizeX");
  assertPositiveFinite(cellSizeY, "cellSizeY");
  assertPositiveFinite(zScale, "zScale");
  if (!Number.isFinite(horizonEpsilon) || horizonEpsilon < 0) {
    throw new RangeError("horizonEpsilon must be a non-negative finite number");
  }
  if (!Array.isArray(directions) || directions.length === 0) {
    throw new RangeError("directions must be a non-empty array");
  }
  if (!Array.isArray(skyElevations) || skyElevations.length === 0) {
    throw new RangeError("skyElevations must be a non-empty array");
  }

  const normalizedDirections = directions.map(normalizeDirection);
  const normalizedElevations = skyElevations.map(normalizeElevation);
  const validMask = makeValidityMask(elevations, pixelCount, suppliedMask, noDataValue);
  const scalarAccumulator = new Float64Array(pixelCount);
  const directionalVisibility = [];
  const directionalAccumulator = includeDirectionalBasis
    ? new Float64Array(pixelCount * 4)
    : null;
  const directionalDenominators = new Float64Array(4);
  let totalDirectionWeight = 0;

  for (const direction of normalizedDirections) {
    const directionVisibility = computeDirectionVisibility({
      elevations,
      validMask,
      width,
      height,
      cellSizeX,
      cellSizeY,
      zScale,
      direction,
      skyElevations: normalizedElevations,
      horizonEpsilon,
    });
    directionalVisibility.push(directionVisibility);
    totalDirectionWeight += direction.weight;

    const basisWeights = includeDirectionalBasis
      ? cardinalBasisWeights(direction.azimuthDeg)
      : null;
    if (basisWeights) {
      for (let channel = 0; channel < 4; channel += 1) {
        directionalDenominators[channel] += direction.weight * basisWeights[channel];
      }
    }

    for (let index = 0; index < pixelCount; index += 1) {
      const weightedVisibility = directionVisibility[index] * direction.weight;
      scalarAccumulator[index] += weightedVisibility;
      if (basisWeights) {
        const offset = index * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          directionalAccumulator[offset + channel] += weightedVisibility * basisWeights[channel];
        }
      }
    }
  }

  const skyVisibility = new Float32Array(pixelCount);
  const directionalBasis = includeDirectionalBasis
    ? new Float32Array(pixelCount * 4)
    : null;
  for (let index = 0; index < pixelCount; index += 1) {
    if (!validMask[index]) {
      continue;
    }
    skyVisibility[index] = scalarAccumulator[index] / totalDirectionWeight;
    if (directionalBasis) {
      const offset = index * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const denominator = directionalDenominators[channel];
        directionalBasis[offset + channel] = denominator > 0
          ? directionalAccumulator[offset + channel] / denominator
          : skyVisibility[index];
      }
    }
  }

  return {
    skyVisibility,
    directionalVisibility,
    directionalBasis,
    validMask,
    width,
    height,
  };
}

/**
 * Reweight precomputed directional visibility without rescanning the DEM.
 *
 * `balance=0` is an even diffuse sky (apart from direction quadrature
 * weights). Increasing balance concentrates illumination around sunAzimuth.
 * At a zenith sun, azimuth focus naturally vanishes because the horizontal
 * component of the sun vector is zero.
 *
 * Complexity: O(directionCount * pixelCount), with one Float32 output.
 */
export function aggregateDirectionalSkyVisibility(options) {
  const {
    directionalVisibility,
    directions = DEFAULT_SKY_DIRECTIONS,
    sunAzimuthDeg,
    sunElevationDeg,
    balance = 0.5,
    validMask,
  } = options ?? {};

  if (!Array.isArray(directionalVisibility) || directionalVisibility.length === 0) {
    throw new RangeError("directionalVisibility must be a non-empty array");
  }
  if (!Array.isArray(directions) || directions.length !== directionalVisibility.length) {
    throw new RangeError("directions length must equal directionalVisibility length");
  }
  if (!Number.isFinite(sunAzimuthDeg)) {
    throw new TypeError("sunAzimuthDeg must be finite");
  }
  if (
    !Number.isFinite(sunElevationDeg)
    || sunElevationDeg < 0
    || sunElevationDeg > 90
  ) {
    throw new RangeError("sunElevationDeg must be in [0, 90] degrees");
  }
  if (!Number.isFinite(balance) || balance < 0 || balance > 1) {
    throw new RangeError("balance must be in [0, 1]");
  }

  const pixelCount = directionalVisibility[0]?.length;
  if (!Number.isInteger(pixelCount)) {
    throw new TypeError("directional visibility channels must be array-like");
  }
  for (let index = 0; index < directionalVisibility.length; index += 1) {
    if (directionalVisibility[index]?.length !== pixelCount) {
      throw new RangeError("all directional visibility channels must have equal length");
    }
  }
  if (validMask !== undefined && validMask.length !== pixelCount) {
    throw new RangeError("validMask length must equal directional channel length");
  }

  const normalizedDirections = directions.map(normalizeDirection);
  const normalizedSunAzimuth = ((sunAzimuthDeg % 360) + 360) % 360;
  const horizontalSunMagnitude = Math.cos(sunElevationDeg * DEG_TO_RAD);
  const focus = 5 * balance * horizontalSunMagnitude;
  const weights = new Float64Array(normalizedDirections.length);
  let totalWeight = 0;

  for (let index = 0; index < normalizedDirections.length; index += 1) {
    const direction = normalizedDirections[index];
    const azimuthDelta = (direction.azimuthDeg - normalizedSunAzimuth) * DEG_TO_RAD;
    const weight = direction.weight * Math.exp(Math.cos(azimuthDelta) * focus);
    weights[index] = weight;
    totalWeight += weight;
  }

  const output = new Float32Array(pixelCount);
  for (let directionIndex = 0; directionIndex < directionalVisibility.length; directionIndex += 1) {
    const channel = directionalVisibility[directionIndex];
    const normalizedWeight = weights[directionIndex] / totalWeight;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      output[pixelIndex] += channel[pixelIndex] * normalizedWeight;
    }
  }

  if (validMask !== undefined) {
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (!validMask[pixelIndex]) {
        output[pixelIndex] = 0;
      }
    }
  }
  return output;
}
