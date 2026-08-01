const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, Number(value)));

const finiteOr = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export const HIGH_KEY_GYPSUM_RESPONSE = Object.freeze({
  // Environment irradiance is the stable white fill. The directional key
  // remains strong enough to describe slope orientation and cast shadows,
  // but it no longer has to carry the base exposure of the plaster surface.
  mainLightScale: 1.05,
  environmentDiffuseScale: 1.35,
});

/**
 * Maps the visible 0..1.5 control to a bounded SSAO contrast response.
 * The saturating curve keeps deep valleys readable instead of allowing the
 * raw control value to drive the SSAO multiplier toward solid black.
 */
export function mapContactOcclusionStrength(rawStrength, enabled = true) {
  if (!enabled) return 0;
  const strength = clamp(finiteOr(rawStrength, 0.42), 0, 1.5);
  return 0.72 * (1 - Math.exp(-1.35 * strength));
}

export const WHITE_STUDIO_LIGHTING_PROFILE = Object.freeze({
  sculpting: 0.68,
  softness: 0.82,
  shadowLift: 0.72,
  valleyDepth: 0.42,
  microDetail: 0.58,
  floatDepth: 0.48,
  exposureBias: 0,
});

export const GYPSUM_LIGHTING_SCHEMES = Object.freeze({
  white: Object.freeze({
    label: "均衡",
    sunAzimuth: 315,
    sunElevation: 48,
    shadowIntensity: 1.05,
    ambientIntensity: 0.72,
    exposure: 1.16,
    studioFloorColor: "#d3dbe5",
    shadowBlurRadius: 6,
    aoStrength: 0.42,
    backgroundColor: "#dce4ed",
  }),
  clay: Object.freeze({
    label: "柔光",
    sunAzimuth: 300,
    sunElevation: 58,
    shadowIntensity: 0.72,
    ambientIntensity: 0.96,
    exposure: 1.12,
    studioFloorColor: "#e0e4e8",
    shadowBlurRadius: 10,
    aoStrength: 0.28,
    backgroundColor: "#e7ebef",
  }),
  relief: Object.freeze({
    label: "雕刻",
    sunAzimuth: 325,
    sunElevation: 32,
    shadowIntensity: 1.58,
    ambientIntensity: 0.46,
    exposure: 1.05,
    studioFloorColor: "#cbd3dd",
    shadowBlurRadius: 4,
    aoStrength: 0.62,
    backgroundColor: "#d4dde7",
  }),
});

export function normalizeLightingProfile(profile = {}) {
  return {
    sculpting: clamp(
      finiteOr(profile.sculpting, WHITE_STUDIO_LIGHTING_PROFILE.sculpting),
      0,
      1,
    ),
    softness: clamp(
      finiteOr(profile.softness, WHITE_STUDIO_LIGHTING_PROFILE.softness),
      0,
      1,
    ),
    shadowLift: clamp(
      finiteOr(profile.shadowLift, WHITE_STUDIO_LIGHTING_PROFILE.shadowLift),
      0,
      1,
    ),
    valleyDepth: clamp(
      finiteOr(profile.valleyDepth, WHITE_STUDIO_LIGHTING_PROFILE.valleyDepth),
      0,
      1,
    ),
    microDetail: clamp(
      finiteOr(profile.microDetail, WHITE_STUDIO_LIGHTING_PROFILE.microDetail),
      0,
      1,
    ),
    floatDepth: clamp(
      finiteOr(profile.floatDepth, WHITE_STUDIO_LIGHTING_PROFILE.floatDepth),
      0,
      1,
    ),
    exposureBias: clamp(
      finiteOr(profile.exposureBias, WHITE_STUDIO_LIGHTING_PROFILE.exposureBias),
      -1,
      1,
    ),
  };
}

export function normalizeSceneLightingMetrics(metrics = {}) {
  const xyDiagonal = Math.max(1e-4, finiteOr(metrics.xyDiagonal, 1));
  const terrainRelief = Math.max(0, finiteOr(metrics.terrainRelief, 0));
  const viewportWidth = Math.max(2, finiteOr(metrics.viewportWidth, 2));
  const viewportHeight = Math.max(2, finiteOr(metrics.viewportHeight, 2));
  const gridSpacing = Math.max(1e-6, finiteOr(metrics.gridSpacing, xyDiagonal / 256));
  const worldUnitsPerPixel = Math.max(
    1e-7,
    finiteOr(metrics.worldUnitsPerPixel, xyDiagonal / viewportHeight),
  );
  return {
    xyDiagonal,
    terrainRelief,
    normalizedRelief: clamp(
      finiteOr(metrics.normalizedRelief, terrainRelief / xyDiagonal),
      0,
      8,
    ),
    gridSpacing,
    projectedTerrainSize: Math.max(
      1,
      finiteOr(metrics.projectedTerrainSize, xyDiagonal / worldUnitsPerPixel),
    ),
    worldUnitsPerPixel,
    cameraDistance: Math.max(1e-4, finiteOr(metrics.cameraDistance, xyDiagonal)),
    orthographicScale: Math.max(1e-4, finiteOr(metrics.orthographicScale, 1)),
    viewportWidth,
    viewportHeight,
    viewportResolution: Math.max(
      4,
      finiteOr(metrics.viewportResolution, viewportWidth * viewportHeight),
    ),
    verticalExaggeration: Math.max(
      0.001,
      finiteOr(metrics.verticalExaggeration, 1),
    ),
    bounds: metrics.bounds || null,
  };
}

export function deriveWhiteStudioLighting(
  rawMetrics,
  rawProfile = WHITE_STUDIO_LIGHTING_PROFILE,
  quality = 1,
) {
  const metrics = normalizeSceneLightingMetrics(rawMetrics);
  const profile = normalizeLightingProfile(rawProfile);
  const qualityMix = clamp(finiteOr(quality, 1), 0, 1);
  const diagonal = metrics.xyDiagonal;
  const relativeFootprint = metrics.worldUnitsPerPixel / metrics.gridSpacing;
  const samplingVisibility = 1 / (1 + Math.max(0, relativeFootprint - 0.72) * 0.92);
  const distanceVisibility = clamp(
    metrics.projectedTerrainSize / Math.max(420, metrics.viewportHeight * 0.62),
    0.18,
    1,
  );
  const reliefDamping = 1 / (1 + Math.max(0, metrics.normalizedRelief - 0.24) * 0.82);
  const microDetailWeight = clamp(
    profile.microDetail *
      samplingVisibility *
      (0.58 + 0.42 * distanceVisibility) *
      reliefDamping,
    0.08,
    0.82,
  );

  const shadowMapSize = metrics.projectedTerrainSize > 1500 && qualityMix > 0.72
    ? 4096
    : (metrics.projectedTerrainSize > 620 ? 2048 : 1024);
  const contactRadiusWorld = clamp(
    Math.max(
      metrics.gridSpacing * 3.5,
      metrics.worldUnitsPerPixel * 5.5,
      diagonal * 0.01,
    ),
    diagonal * 0.008,
    diagonal * 0.035,
  );
  const keyDistance = diagonal * (1.16 + metrics.normalizedRelief * 0.18);
  const softness = profile.softness;
  const derivedShadowNormalBias = clamp(
    Math.max(metrics.gridSpacing, metrics.worldUnitsPerPixel) * 0.18,
    diagonal * 0.00008,
    diagonal * 0.0032,
  );

  return {
    profile,
    metrics,
    qualityMix,
    keyDistance,
    keyHeight: diagonal * (0.74 + 0.18 * profile.sculpting),
    keyLateral: diagonal * (0.52 + 0.12 * profile.sculpting),
    keyForward: diagonal * 0.34,
    horizonStrength: clamp(
      profile.valleyDepth * (0.22 - profile.shadowLift * 0.065),
      0.035,
      0.16,
    ),
    microDetailWeight,
    shadowExtent: diagonal * (0.56 + metrics.normalizedRelief * 0.28),
    shadowNear: Math.max(0.01, diagonal * 0.015),
    shadowFar: diagonal * (3.2 + metrics.normalizedRelief * 1.4),
    shadowMapSize,
    shadowRadius: 2.2 + softness * 3.8,
    shadowBias: -clamp(
      metrics.worldUnitsPerPixel * 0.0008,
      diagonal * 0.000002,
      diagonal * 0.000045,
    ),
    shadowNormalBias: clamp(
      finiteOr(rawProfile.shadowNormalBias, derivedShadowNormalBias),
      diagonal * 0.00008,
      diagonal * 0.0064,
    ),
    gtaoRadiusWorld: contactRadiusWorld,
    gtaoThickness: clamp(
      contactRadiusWorld * (1.1 + metrics.normalizedRelief * 0.5),
      diagonal * 0.003,
      diagonal * 0.04,
    ),
    gtaoIntensity: clamp(
      profile.valleyDepth * (0.16 - profile.shadowLift * 0.055),
      0.025,
      0.12,
    ),
    gtaoSamples: qualityMix > 0.72 ? 16 : (qualityMix > 0.3 ? 8 : 6),
    gtaoDenoiseSamples: qualityMix > 0.72 ? 8 : 4,
    gtaoBase: 0.035,
    gtaoEpsilon: 0.025,
    gtaoMinZAspect: 0.2,
    gtaoBilateralSamples: 16,
    gtaoBilateralSoften: 0.35,
    gtaoBilateralTolerance: 0.2,
    floatOffset: diagonal * (0.035 + profile.floatDepth * 0.045),
    floatFeather: diagonal * (0.04 + profile.softness * 0.035),
    floatReach: diagonal * (0.035 + profile.floatDepth * 0.035),
    floatOpacity: 0.08 + profile.floatDepth * 0.075,
    baseExposure: clamp(1.12 + profile.exposureBias * 0.22, 0.88, 1.38),
    targetMedianLuminance: clamp(0.76 + profile.exposureBias * 0.08, 0.68, 0.84),
    targetHighlightLuminance: clamp(0.94 + profile.exposureBias * 0.025, 0.89, 0.97),
  };
}

/**
 * Resolves the two-source gypsum studio state from the visible form:
 * one shadow-casting directional key plus one image-based diffuse environment.
 * AO remains a separate visibility effect and is never counted as light.
 */
export function deriveGypsumStudioLighting(
  rawMetrics,
  rawSettings = {},
  quality = 1,
) {
  const shadowIntensity = clamp(finiteOr(rawSettings.shadowIntensity, 1.05), 0, 2.5);
  const ambientIntensity = clamp(finiteOr(rawSettings.ambientIntensity, 0.72), 0, 2);
  const exposure = clamp(finiteOr(rawSettings.exposure, 1.16), 0.70, 1.50);
  const blurRadius = rawSettings.shadowBlurEnabled === false
    ? 0
    : clamp(finiteOr(rawSettings.shadowBlurRadius, 6), 0, 18);
  const aoStrength = rawSettings.aoEnabled === false
    ? 0
    : clamp(finiteOr(rawSettings.aoStrength, 0.42), 0, 1.5);
  const profile = {
    ...WHITE_STUDIO_LIGHTING_PROFILE,
    sculpting: clamp(0.38 + shadowIntensity * 0.22, 0, 1),
    softness: clamp(0.42 + blurRadius / 30, 0, 1),
    shadowLift: clamp(0.48 + ambientIntensity * 0.24, 0, 1),
    valleyDepth: clamp(0.18 + aoStrength * 0.42, 0, 1),
    shadowNormalBias: rawSettings.shadowNormalBias,
  };
  const state = deriveWhiteStudioLighting(rawMetrics, profile, quality);
  return {
    ...state,
    sunAzimuth: clamp(finiteOr(rawSettings.sunAzimuth, 315), 0, 360),
    sunElevation: clamp(finiteOr(rawSettings.sunElevation, 48), 5, 85),
    mainLightIntensity:
      shadowIntensity * HIGH_KEY_GYPSUM_RESPONSE.mainLightScale,
    environmentDiffuseIntensity:
      ambientIntensity * HIGH_KEY_GYPSUM_RESPONSE.environmentDiffuseScale,
    exposure,
    // Broad terrain visibility modulates environment irradiance only. Direct
    // key light and its PCSS shadow remain physically independent.
    horizonStrength: rawSettings.aoEnabled === false
      ? 0
      : state.horizonStrength * clamp(aoStrength / 0.42, 0, 1.5),
    contactOcclusionStrength: mapContactOcclusionStrength(
      aoStrength,
      rawSettings.aoEnabled !== false,
    ),
    gtaoIntensity: rawSettings.aoEnabled === false
      ? 0
      : state.gtaoIntensity * clamp(aoStrength / 0.42, 0, 2),
  };
}
