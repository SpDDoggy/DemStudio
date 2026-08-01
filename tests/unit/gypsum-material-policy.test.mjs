import test from "node:test";
import assert from "node:assert/strict";

import {
  GYPSUM_SURFACE,
  classifyTerrainAppearance,
  createGypsumMaterialPolicy,
  gypsumHeightMix,
  shouldUseCompatibilityPlanarShadow,
} from "../../src/gypsum-material-policy.js";
import {
  realtimePostProcessTopology,
  resolveRealtimePostProcessState,
} from "../../src/rendering/realtime-postprocess-policy.js";

test("gypsum material policy ignores legacy surface modes and disables textures", () => {
  for (const legacyMode of ["custom", "white", "relief", "height", "matcap"]) {
    const policy = createGypsumMaterialPolicy({ materialMode: legacyMode });
    assert.equal(policy.id, "gypsum");
    assert.equal(policy.albedo, 0xf2f1ed);
    assert.equal(policy.roughness, 0.96);
    assert.equal(policy.emissive, 0x000000);
    assert.equal(policy.environmentIntensity, 1);
    assert.equal(policy.vertexColors, false);
    assert.equal(policy.whiteModel, true);
    assert.equal(policy.textureEnabled, false);
    assert.equal(policy.detailNormalEnabled, false);
    assert.equal(policy.relightStrength, 0);
  }
  assert.equal(Object.isFrozen(GYPSUM_SURFACE), true);
});

test("gypsum height tint remains finite and bounded", () => {
  assert.equal(gypsumHeightMix(Number.NaN), 0);
  assert.equal(gypsumHeightMix(-10), 0);
  assert.equal(gypsumHeightMix(0.5), 0.09);
  assert.equal(gypsumHeightMix(1), 0.18);
  assert.equal(gypsumHeightMix(10), 0.18);
});

test("no Babylon backend enters the retired planar-shadow pass", () => {
  assert.equal(shouldUseCompatibilityPlanarShadow("webgpu"), false);
  assert.equal(shouldUseCompatibilityPlanarShadow("WebGPU"), false);
  assert.equal(shouldUseCompatibilityPlanarShadow("webgl2"), false);
});

test("black-frame oracle rejects the reported solid-black terrain silhouette", () => {
  assert.deepEqual(
    classifyTerrainAppearance({
      foregroundPixels: 80_000,
      foregroundCoverage: 0.31,
      luminanceP10: 0,
      luminanceP50: 0,
      luminanceP90: 0,
      luminanceRange: 0,
    }),
    { passed: false, reason: "black-terrain-frame" },
  );
});

test("black-frame oracle accepts dark but visibly shaded gypsum", () => {
  assert.deepEqual(
    classifyTerrainAppearance({
      foregroundPixels: 35_000,
      foregroundCoverage: 0.18,
      luminanceP10: 0.12,
      luminanceP50: 0.28,
      luminanceP90: 0.55,
      luminanceRange: 0.43,
    }),
    { passed: true, reason: "visible-tonal-response" },
  );
});

test("black-frame oracle fails closed for missing terrain or invalid metrics", () => {
  assert.equal(classifyTerrainAppearance({}).passed, false);
  assert.equal(classifyTerrainAppearance({
    foregroundPixels: 0,
    foregroundCoverage: 0,
    luminanceP10: 0,
    luminanceP50: 0,
    luminanceP90: 0,
    luminanceRange: 0,
  }).reason, "terrain-not-visible");
});

test("camera interaction cannot change the realtime post-process topology", () => {
  const common = {
    msaaSamples: 4,
    aoEnabled: true,
    aoStrength: 0.42,
    aoRadius: 0.08,
    aoMaxZ: 100,
    bloomEnabled: true,
    bloomStrength: 0.25,
    bloomThreshold: 0.82,
    dofEnabled: true,
    dofFocus: 7,
    dofFStop: 2.8,
    sharpenEnabled: true,
    sharpenStrength: 0.22,
  };
  assert.deepEqual(
    realtimePostProcessTopology({ ...common, interactionActive: true }),
    realtimePostProcessTopology({ ...common, interactionActive: false }),
  );
  assert.deepEqual(
    resolveRealtimePostProcessState({ ...common, interactionActive: true }),
    resolveRealtimePostProcessState({ ...common, interactionActive: false }),
  );
});

test("realtime post-process policy clamps invalid device-facing values", () => {
  const resolved = resolveRealtimePostProcessState({
    msaaSamples: 99,
    aoEnabled: true,
    aoStrength: Number.POSITIVE_INFINITY,
    aoRadius: -10,
    aoMaxZ: Number.NaN,
    aoBase: 9,
    aoEpsilon: -1,
    aoMinZAspect: Number.NaN,
    bilateralSamples: 99,
    bilateralSoften: 9,
    bilateralTolerance: -2,
  });
  assert.equal(resolved.msaaSamples, 4);
  assert.equal(resolved.fxaaEnabled, false);
  assert.equal(resolved.aoStrength, 0);
  assert.equal(resolved.aoRadius, 0.0001);
  assert.equal(resolved.aoMaxZ, 100);
  assert.equal(resolved.aoBase, 0.15);
  assert.equal(resolved.aoEpsilon, 0);
  assert.equal(resolved.aoMinZAspect, 0.2);
  assert.equal(resolved.ssaoSamples, 16);
  assert.equal(resolved.ssaoTextureSamples, 4);
  assert.equal(resolved.bilateralSamples, 24);
  assert.equal(resolved.bilateralSoften, 1);
  assert.equal(resolved.bilateralTolerance, 0);
});

test("FXAA only remains active when 4x MSAA is unavailable", () => {
  assert.equal(resolveRealtimePostProcessState({ msaaSamples: 4 }).fxaaEnabled, false);
  assert.equal(resolveRealtimePostProcessState({ msaaSamples: 2 }).fxaaEnabled, true);
  assert.equal(resolveRealtimePostProcessState({ msaaSamples: 1 }).fxaaEnabled, true);
});

test("realtime SSAO policy keeps the calibrated bilateral response stable", () => {
  const resolved = resolveRealtimePostProcessState({
    aoEnabled: true,
    aoStrength: 0.34,
    aoRadius: 0.1,
    aoBase: 0.035,
    aoEpsilon: 0.025,
    aoMinZAspect: 0.2,
    bilateralSamples: 16,
    bilateralSoften: 0.35,
    bilateralTolerance: 0.2,
  });

  assert.equal(resolved.aoBase, 0.035);
  assert.equal(resolved.aoEpsilon, 0.025);
  assert.equal(resolved.aoMinZAspect, 0.2);
  assert.equal(resolved.bilateralSamples, 16);
  assert.equal(resolved.bilateralSoften, 0.35);
  assert.equal(resolved.bilateralTolerance, 0.2);
});
