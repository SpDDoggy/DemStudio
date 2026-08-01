export const GYPSUM_SURFACE = Object.freeze({
  id: "gypsum",
  low: "#e2e4e7",
  high: "#f4f5f6",
  side: "#e8eaed",
  albedo: 0xf2f1ed,
  roughness: 0.96,
  metalness: 0,
  emissive: 0x000000,
  environmentIntensity: 1,
});

export function gypsumHeightMix(height) {
  const value = Number(height);
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.18, Math.max(0, value) * 0.18);
}

export function createGypsumMaterialPolicy() {
  return {
    ...GYPSUM_SURFACE,
    // A fixed gypsum surface must not inherit the retired elevation palette.
    // Geometry colors remain available for diagnostics, but lighting alone
    // defines the visible tonal structure.
    vertexColors: false,
    whiteModel: true,
    textureEnabled: false,
    detailNormalEnabled: false,
    relightStrength: 0,
  };
}

export function shouldUseCompatibilityPlanarShadow(backend) {
  void backend;
  return false;
}

function finiteMetric(metrics, key) {
  const value = Number(metrics?.[key]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Runtime oracle for the user-visible "terrain silhouette is completely black"
 * regression. It intentionally evaluates only a frame that contains a
 * meaningful amount of terrain; an empty/background-only frame is a separate
 * failure mode.
 */
export function classifyTerrainAppearance(metrics) {
  const foregroundPixels = finiteMetric(metrics, "foregroundPixels");
  const foregroundCoverage = finiteMetric(metrics, "foregroundCoverage");
  const luminanceP10 = finiteMetric(metrics, "luminanceP10");
  const luminanceP50 = finiteMetric(metrics, "luminanceP50");
  const luminanceP90 = finiteMetric(metrics, "luminanceP90");
  const luminanceRange = finiteMetric(metrics, "luminanceRange");

  if (
    foregroundPixels === null
    || foregroundCoverage === null
    || luminanceP10 === null
    || luminanceP50 === null
    || luminanceP90 === null
    || luminanceRange === null
  ) {
    return { passed: false, reason: "invalid-metrics" };
  }
  if (foregroundPixels < 256 || foregroundCoverage < 0.01) {
    return { passed: false, reason: "terrain-not-visible" };
  }

  const clippedBlack = luminanceP90 <= 0.025;
  const flatNearBlack = luminanceP50 <= 0.018
    && luminanceP90 <= 0.045
    && luminanceRange <= 0.02;
  if (clippedBlack || flatNearBlack) {
    return { passed: false, reason: "black-terrain-frame" };
  }

  return { passed: true, reason: "visible-tonal-response" };
}
