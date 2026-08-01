import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SKY_DIRECTIONS,
  aggregateDirectionalSkyVisibility,
  computeTerrainSkyVisibility,
} from "../../src/terrain-lighting.js";
import {
  GYPSUM_LIGHTING_SCHEMES,
  HIGH_KEY_GYPSUM_RESPONSE,
  WHITE_STUDIO_LIGHTING_PROFILE,
  deriveGypsumStudioLighting,
  deriveWhiteStudioLighting,
  mapContactOcclusionStrength,
} from "../../src/lighting-profile.js";
import {
  computeTerrainDetailCurvature,
  computeTerrainNormalLod,
} from "../../src/terrain-normal-lod.js";
import { StudioLightingRig } from "../../src/studio-lighting-rig.js";
import {
  ArcRotateCamera,
  DirectionalLight,
  NullEngine,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { decorateBabylonCamera } from "../../src/rendering/babylon-scene-kit.js";

const westOnly = [
  { azimuthDeg: 270, sourceColStep: -1, sourceRowStep: 0, weight: 1 },
];

function computeLine(elevations, overrides = {}) {
  return computeTerrainSkyVisibility({
    elevations: Float32Array.from(elevations),
    width: elevations.length,
    height: 1,
    cellSizeX: 1,
    cellSizeY: 1,
    directions: westOnly,
    skyElevations: [{ elevationDeg: 10, weight: 1 }],
    includeDirectionalBasis: true,
    ...overrides,
  });
}

test("flat terrain has full deterministic sky visibility and RGBA basis", () => {
  const options = {
    elevations: new Float32Array(12).fill(100),
    width: 4,
    height: 3,
    cellSizeX: 5,
    cellSizeY: 8,
    includeDirectionalBasis: true,
  };

  const first = computeTerrainSkyVisibility(options);
  const second = computeTerrainSkyVisibility(options);

  assert.deepEqual(first.skyVisibility, new Float32Array(12).fill(1));
  assert.deepEqual(first.directionalBasis, new Float32Array(48).fill(1));
  assert.equal(first.directionalVisibility.length, 8);
  for (const channel of first.directionalVisibility) {
    assert.deepEqual(channel, new Float32Array(12).fill(1));
  }
  assert.deepEqual(first.skyVisibility, second.skyVisibility);
  assert.deepEqual(first.directionalBasis, second.directionalBasis);
  assert.equal(DEFAULT_SKY_DIRECTIONS.length, 8);
  assert.deepEqual(
    aggregateDirectionalSkyVisibility({
      directionalVisibility: first.directionalVisibility,
      sunAzimuthDeg: 123,
      sunElevationDeg: 45,
      balance: 0,
      validMask: first.validMask,
    }),
    first.skyVisibility,
    "balance=0 must reproduce the diffuse scalar without a horizon rescan",
  );
});

test("a western ridge blocks low western sky without shared-direction accumulation", () => {
  const result = computeLine([20, 0, 0, 0]);

  assert.equal(result.skyVisibility[0], 1);
  assert.equal(result.skyVisibility[1], 0);
  assert.equal(result.skyVisibility[2], 0);
  assert.equal(result.skyVisibility[3], 0);
  assert.equal(result.directionalBasis[3], 1);
  assert.equal(result.directionalBasis[7], 0);
});

test("NoData is masked and resets rather than becoming a zero-height occluder", () => {
  const elevations = Float32Array.from([20, -9999, 0]);
  const before = elevations.slice();
  const result = computeTerrainSkyVisibility({
    elevations,
    width: 3,
    height: 1,
    cellSizeX: 1,
    cellSizeY: 1,
    noDataValue: -9999,
    directions: westOnly,
    skyElevations: [10],
  });

  assert.deepEqual(result.validMask, Uint8Array.from([1, 0, 1]));
  assert.deepEqual(result.skyVisibility, Float32Array.from([1, 0, 1]));
  assert.deepEqual(elevations, before, "input elevations must not be mutated");
});

test("an explicit validity mask overrides otherwise finite elevations", () => {
  const result = computeLine([20, 5000, 0], {
    validMask: Uint8Array.from([1, 0, 1]),
  });

  assert.deepEqual(result.validMask, Uint8Array.from([1, 0, 1]));
  assert.deepEqual(result.skyVisibility, Float32Array.from([1, 0, 1]));
});

test("non-square cell dimensions change physical horizon attenuation", () => {
  const narrowPixels = computeLine([10, 0], { cellSizeX: 1 });
  const widePixels = computeLine([10, 0], { cellSizeX: 100 });

  assert.equal(narrowPixels.skyVisibility[1], 0);
  assert.equal(widePixels.skyVisibility[1], 1);
});

test("multiple elevation samples produce a normalized soft visibility scalar", () => {
  const result = computeLine([10, 0], {
    cellSizeX: 10,
    skyElevations: [
      { elevationDeg: 10, weight: 1 },
      { elevationDeg: 60, weight: 3 },
    ],
    includeDirectionalBasis: false,
  });

  assert.equal(result.skyVisibility[0], 1);
  assert.equal(result.skyVisibility[1], 0.75);
  assert.equal(result.directionalBasis, null);
});

test("sun changes only aggregate the retained eight-direction basis", () => {
  const pixelCount = 3;
  const directionalVisibility = DEFAULT_SKY_DIRECTIONS.map(
    (_, directionIndex) => new Float32Array(pixelCount).fill(directionIndex === 0 ? 1 : 0),
  );
  const northSun = aggregateDirectionalSkyVisibility({
    directionalVisibility,
    sunAzimuthDeg: 0,
    sunElevationDeg: 20,
    balance: 1,
  });
  const southSun = aggregateDirectionalSkyVisibility({
    directionalVisibility,
    sunAzimuthDeg: 180,
    sunElevationDeg: 20,
    balance: 1,
  });
  const zenithNorth = aggregateDirectionalSkyVisibility({
    directionalVisibility,
    sunAzimuthDeg: 0,
    sunElevationDeg: 90,
    balance: 1,
  });
  const zenithSouth = aggregateDirectionalSkyVisibility({
    directionalVisibility,
    sunAzimuthDeg: 180,
    sunElevationDeg: 90,
    balance: 1,
  });

  assert.ok(northSun[0] > southSun[0]);
  assert.deepEqual(zenithNorth, zenithSouth, "zenith illumination must be azimuth invariant");
  assert.equal(northSun.length, pixelCount);
});

test("aggregate preserves invalid pixels and rejects channel shape drift", () => {
  const output = aggregateDirectionalSkyVisibility({
    directionalVisibility: [
      Float32Array.from([1, 1]),
      Float32Array.from([0, 0]),
    ],
    directions: [
      { azimuthDeg: 0, sourceColStep: 0, sourceRowStep: -1 },
      { azimuthDeg: 180, sourceColStep: 0, sourceRowStep: 1 },
    ],
    sunAzimuthDeg: 0,
    sunElevationDeg: 45,
    balance: 0,
    validMask: Uint8Array.from([1, 0]),
  });

  assert.equal(output[0], 0.5);
  assert.equal(output[1], 0);
  assert.throws(
    () => aggregateDirectionalSkyVisibility({
      directionalVisibility: [new Float32Array(2), new Float32Array(3)],
      directions: westOnly.concat(westOnly),
      sunAzimuthDeg: 0,
      sunElevationDeg: 45,
    }),
    /equal length/,
  );
});

test("rejects malformed raster geometry before scanning", () => {
  assert.throws(
    () => computeTerrainSkyVisibility({
      elevations: [0, 1],
      width: 2,
      height: 1,
      cellSizeX: 0,
      cellSizeY: 1,
    }),
    /cellSizeX/,
  );
  assert.throws(
    () => computeTerrainSkyVisibility({
      elevations: [0],
      width: 2,
      height: 1,
      cellSizeX: 1,
      cellSizeY: 1,
    }),
    /elevations length/,
  );
});

test("white studio lighting is scale invariant and suppresses sub-pixel micro normals", () => {
  const base = deriveWhiteStudioLighting({
    xyDiagonal: 10,
    terrainRelief: 2,
    normalizedRelief: 0.2,
    gridSpacing: 0.01,
    projectedTerrainSize: 900,
    worldUnitsPerPixel: 0.006,
    cameraDistance: 12,
    orthographicScale: 8,
    viewportWidth: 1200,
    viewportHeight: 800,
    verticalExaggeration: 2,
  }, WHITE_STUDIO_LIGHTING_PROFILE);
  const scaled = deriveWhiteStudioLighting({
    xyDiagonal: 1000,
    terrainRelief: 200,
    normalizedRelief: 0.2,
    gridSpacing: 1,
    projectedTerrainSize: 900,
    worldUnitsPerPixel: 0.6,
    cameraDistance: 1200,
    orthographicScale: 800,
    viewportWidth: 1200,
    viewportHeight: 800,
    verticalExaggeration: 2,
  }, WHITE_STUDIO_LIGHTING_PROFILE);
  const distant = deriveWhiteStudioLighting({
    ...base.metrics,
    worldUnitsPerPixel: 0.08,
    projectedTerrainSize: 180,
  }, WHITE_STUDIO_LIGHTING_PROFILE);

  assert.ok(Math.abs(base.microDetailWeight - scaled.microDetailWeight) < 1e-6);
  assert.ok(Math.abs(base.shadowExtent / 10 - scaled.shadowExtent / 1000) < 1e-6);
  assert.ok(Math.abs(base.gtaoRadiusWorld / 10 - scaled.gtaoRadiusWorld / 1000) < 1e-6);
  assert.ok(base.gtaoRadiusWorld >= base.metrics.xyDiagonal * 0.008);
  assert.ok(base.gtaoRadiusWorld <= base.metrics.xyDiagonal * 0.035);
  assert.ok(distant.microDetailWeight < base.microDetailWeight);
  assert.ok(base.gtaoIntensity <= 0.12);
  assert.ok(base.horizonStrength <= 0.16);
});

test("contact occlusion uses a monotonic saturating contrast curve", () => {
  const disabled = mapContactOcclusionStrength(1.5, false);
  const zero = mapContactOcclusionStrength(0, true);
  const balanced = mapContactOcclusionStrength(0.42, true);
  const sculpted = mapContactOcclusionStrength(0.62, true);
  const maximum = mapContactOcclusionStrength(1.5, true);

  assert.equal(disabled, 0);
  assert.equal(zero, 0);
  assert.ok(balanced > 0 && balanced < sculpted);
  assert.ok(sculpted < maximum && maximum < 0.64);
  assert.ok(
    (maximum - sculpted) / (1.5 - 0.62) <
      (sculpted - balanced) / (0.62 - 0.42),
  );
});

test("gypsum AO response is independent from key light, environment, and exposure", () => {
  const metrics = {
    xyDiagonal: 10,
    terrainRelief: 2,
    normalizedRelief: 0.2,
    gridSpacing: 0.01,
    projectedTerrainSize: 900,
    worldUnitsPerPixel: 0.006,
    viewportWidth: 1200,
    viewportHeight: 800,
  };
  const base = deriveGypsumStudioLighting(metrics, { aoStrength: 0.48 });
  const relit = deriveGypsumStudioLighting(metrics, {
    aoStrength: 0.48,
    shadowIntensity: 2.2,
    ambientIntensity: 1.8,
    exposure: 0.72,
  });
  const disabled = deriveGypsumStudioLighting(metrics, {
    aoEnabled: false,
    aoStrength: 1.5,
  });

  assert.equal(base.contactOcclusionStrength, relit.contactOcclusionStrength);
  assert.equal(base.gtaoRadiusWorld, relit.gtaoRadiusWorld);
  assert.equal(disabled.contactOcclusionStrength, 0);
});

test("multi-scale DEM normals keep unit length and reduce checkerboard response", () => {
  const width = 9;
  const height = 9;
  const heights = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      heights[row * width + col] = (col + row) * 0.02 + ((col + row) % 2 ? 0.08 : -0.08);
    }
  }
  const result = computeTerrainNormalLod({
    heights,
    width,
    height,
    worldWidth: 8,
    worldDepth: 8,
    verticalScale: 1,
    validMask: new Uint8Array(width * height).fill(1),
    coarseIterations: 3,
  });
  const center = (4 * width + 4) * 3;
  const fineHorizontal = Math.hypot(
    result.fineNormals[center],
    result.fineNormals[center + 2],
  );
  const coarseHorizontal = Math.hypot(
    result.coarseNormals[center],
    result.coarseNormals[center + 2],
  );
  const coarseLength = Math.hypot(
    result.coarseNormals[center],
    result.coarseNormals[center + 1],
    result.coarseNormals[center + 2],
  );
  assert.ok(coarseHorizontal <= fineHorizontal + 1e-6);
  assert.ok(Math.abs(coarseLength - 1) < 1e-5);
});

test("lighting normals suppress quantized terraces without changing DEM heights", () => {
  const width = 17;
  const height = 9;
  const heights = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      heights[row * width + col] = Math.floor(col * 0.63 + row * 0.21) * 0.08;
    }
  }
  const authoritative = Float32Array.from(heights);
  const result = computeTerrainNormalLod({
    heights,
    width,
    height,
    worldWidth: 16,
    worldDepth: 8,
    verticalScale: 1,
    validMask: new Uint8Array(width * height).fill(1),
    coarseIterations: 3,
  });
  const normalVariation = normals => {
    let variation = 0;
    const row = 4;
    for (let col = 1; col < width; col++) {
      const previous = (row * width + col - 1) * 3;
      const current = previous + 3;
      variation += Math.hypot(
        normals[current] - normals[previous],
        normals[current + 1] - normals[previous + 1],
        normals[current + 2] - normals[previous + 2],
      );
    }
    return variation;
  };
  assert.deepEqual(heights, authoritative);
  assert.deepEqual(result.shadingNormals, result.coarseNormals);
  assert.ok(normalVariation(result.shadingNormals) < normalVariation(result.fineNormals));
  for (let offset = 0; offset < result.shadingNormals.length; offset += 3) {
    const length = Math.hypot(
      result.shadingNormals[offset],
      result.shadingNormals[offset + 1],
      result.shadingNormals[offset + 2],
    );
    assert.ok(Math.abs(length - 1) < 1e-5);
  }
});

test("synthetic demo lighting normals do not retain sample-scale raster cadence", () => {
  const width = 96;
  const height = 72;
  const heights = new Float32Array(width * height);
  const peaks = [
    { x: .32, y: .42, h: 1.05, s: .065 },
    { x: .54, y: .38, h: .72, s: .11 },
    { x: .68, y: .58, h: .52, s: .13 },
    { x: .24, y: .66, h: .44, s: .12 },
  ];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const u = col / (width - 1);
      const v = row / (height - 1);
      let value = 0;
      for (const peak of peaks) {
        const dx = u - peak.x;
        const dy = v - peak.y;
        value += peak.h * Math.exp(-(dx * dx + dy * dy) / (2 * peak.s * peak.s));
      }
      value += 0.16 * Math.sin(u * Math.PI * 5.2 + v * 1.7);
      value += 0.08 * Math.cos(v * Math.PI * 8.0 + u * 2.4);
      value += 0.05 * Math.sin((u + v) * Math.PI * 13.0);
      heights[row * width + col] = value;
    }
  }
  const authoritative = Float32Array.from(heights);
  const result = computeTerrainNormalLod({
    heights,
    width,
    height,
    worldWidth: 8,
    worldDepth: 6,
    verticalScale: 1,
    coarseIterations: 4,
  });
  assert.deepEqual(heights, authoritative);
  assert.deepEqual(result.shadingNormals, result.coarseNormals);
});

test("medium-scale curvature is bounded, signed, and leaves DEM elevations untouched", () => {
  const medium = Float32Array.from([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5, 0]);
  const broad = new Float32Array(medium.length);
  const authoritative = Float32Array.from(medium);
  const curvature = computeTerrainDetailCurvature(medium, broad, null, 2);
  assert.deepEqual(medium, authoritative);
  assert.ok(curvature[2] > 0);
  assert.ok(curvature[6] < 0);
  for (const value of curvature) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= -1 && value <= 1);
  }
});

test("normal LOD produces a stable curvature field without modifying geometry", () => {
  const width = 21;
  const height = 21;
  const heights = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const dx = (col - 10) / 5;
      const dy = (row - 10) / 5;
      heights[row * width + col] = Math.exp(-(dx * dx + dy * dy));
    }
  }
  const authoritative = Float32Array.from(heights);
  const result = computeTerrainNormalLod({
    heights,
    width,
    height,
    worldWidth: 20,
    worldDepth: 20,
    verticalScale: 1,
  });
  assert.deepEqual(heights, authoritative);
  assert.equal(result.detailCurvature.length, heights.length);
  assert.ok(result.detailCurvature[10 * width + 10] > 0);
});

test("gypsum lighting schemes produce finite directional plus environment states", () => {
  const metrics = {
    xyDiagonal: 10,
    terrainRelief: 2,
    gridSpacing: 0.02,
    projectedTerrainSize: 900,
    worldUnitsPerPixel: 0.01,
    cameraDistance: 12,
    viewportWidth: 1200,
    viewportHeight: 800,
  };
  const states = Object.fromEntries(
    Object.entries(GYPSUM_LIGHTING_SCHEMES).map(([id, scheme]) => [
      id,
      deriveGypsumStudioLighting(metrics, {
        ...scheme,
        shadowBlurEnabled: true,
        aoEnabled: true,
      }),
    ]),
  );

  for (const state of Object.values(states)) {
    for (const key of [
      "mainLightIntensity",
      "environmentDiffuseIntensity",
    ]) {
      assert.ok(Number.isFinite(state[key]), `${key} must be finite`);
      assert.ok(state[key] > 0, `${key} must retain visible energy`);
    }
    assert.ok(state.sunElevation >= 5 && state.sunElevation <= 85);
  }
  assert.ok(states.clay.environmentDiffuseIntensity > states.relief.environmentDiffuseIntensity);
  assert.ok(states.relief.mainLightIntensity > states.clay.mainLightIntensity);
  assert.ok(states.white.horizonStrength > 0);
  assert.ok(states.white.horizonStrength <= 0.16);
  assert.notEqual(states.white.sunAzimuth, states.relief.sunAzimuth);
});

test("world-space gypsum rig honors authored sun azimuth and elevation while orbiting", () => {
  const engine = new NullEngine({
    renderWidth: 1200,
    renderHeight: 800,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.add = () => {};
  const keyLight = new DirectionalLight("directional-key", new Vector3(0, -1, 0), scene);
  keyLight.position = Vector3.Zero();
  keyLight.target = { position: Vector3.Zero() };
  keyLight.shadow = {
    camera: null,
    mapSize: { set() {} },
  };
  Object.defineProperty(keyLight, "castShadow", {
    configurable: true,
    writable: true,
    value: false,
  });
  const rig = new StudioLightingRig({ scene, keyLight });
  const state = deriveGypsumStudioLighting({
    xyDiagonal: 8,
    terrainRelief: 1,
    gridSpacing: 0.02,
    projectedTerrainSize: 700,
    worldUnitsPerPixel: 0.01,
    cameraDistance: 10,
    viewportWidth: 1200,
    viewportHeight: 800,
  }, GYPSUM_LIGHTING_SCHEMES.white);
  const center = new Vector3(0, 0.5, 0);

  let expectedDirection = null;
  for (const position of [
    new Vector3(6, 6, 6),
    new Vector3(-6, 6, 6),
    new Vector3(-6, 6, -6),
    new Vector3(6, 6, -6),
  ]) {
    const camera = decorateBabylonCamera(new ArcRotateCamera(
      "test-camera",
      Math.PI / 4,
      Math.PI / 3,
      10,
      center,
      scene,
    ));
    camera.setPosition(position);
    camera.setTarget(center);
    camera.getViewMatrix(true);
    camera.getProjectionMatrix(true);
    const authored = {
      ...state,
      sunAzimuth: 315,
      sunElevation: 48,
    };
    rig.update(camera, center, authored);
    const direction = keyLight.position.subtract(center).normalize();
    expectedDirection ||= direction.clone();
    assert.ok(Vector3.Distance(direction, expectedDirection) < 1e-6);
    assert.equal(rig.getDiagnostics().sunAzimuth, 315);
    assert.equal(rig.getDiagnostics().sunElevation, 48);
    camera.dispose();
  }
  const directionCamera = decorateBabylonCamera(new ArcRotateCamera(
    "direction-camera",
    Math.PI / 4,
    Math.PI / 3,
    10,
    center,
    scene,
  ));
  rig.update(directionCamera, center, { ...state, sunAzimuth: 45, sunElevation: 25 });
  const changedDirection = keyLight.position.subtract(center).normalize();
  assert.ok(Vector3.Distance(changedDirection, expectedDirection) > 0.2);
  directionCamera.dispose();
  assert.equal(keyLight.castShadow, true);
  scene.dispose();
  engine.dispose();
});

test("main light, environment diffuse, and exposure remain independent", () => {
  const metrics = {
    xyDiagonal: 10,
    terrainRelief: 2,
    gridSpacing: 0.02,
    projectedTerrainSize: 900,
    worldUnitsPerPixel: 0.01,
    cameraDistance: 12,
    viewportWidth: 1200,
    viewportHeight: 800,
  };
  const base = deriveGypsumStudioLighting(metrics, {
    shadowIntensity: 1,
    ambientIntensity: 0.7,
    exposure: 1.16,
  });
  const brighterKey = deriveGypsumStudioLighting(metrics, {
    shadowIntensity: 1.4,
    ambientIntensity: 0.7,
    exposure: 1.16,
  });
  const brighterEnvironment = deriveGypsumStudioLighting(metrics, {
    shadowIntensity: 1,
    ambientIntensity: 1.1,
    exposure: 1.16,
  });
  const changedExposure = deriveGypsumStudioLighting(metrics, {
    shadowIntensity: 1,
    ambientIntensity: 0.7,
    exposure: 1.32,
  });
  assert.ok(brighterKey.mainLightIntensity > base.mainLightIntensity);
  assert.equal(brighterKey.environmentDiffuseIntensity, base.environmentDiffuseIntensity);
  assert.equal(brighterKey.exposure, base.exposure);
  assert.ok(brighterEnvironment.environmentDiffuseIntensity > base.environmentDiffuseIntensity);
  assert.equal(brighterEnvironment.mainLightIntensity, base.mainLightIntensity);
  assert.equal(brighterEnvironment.exposure, base.exposure);
  assert.equal(changedExposure.mainLightIntensity, base.mainLightIntensity);
  assert.equal(changedExposure.environmentDiffuseIntensity, base.environmentDiffuseIntensity);
  assert.equal(changedExposure.exposure, 1.32);
});

test("authored normal bias overrides the too-small derived self-shadow bias", () => {
  const metrics = {
    xyDiagonal: 7.2,
    terrainRelief: 1,
    gridSpacing: 0.011,
    worldUnitsPerPixel: 0.006,
    projectedTerrainSize: 1000,
    viewportWidth: 1400,
    viewportHeight: 900,
  };
  const derived = deriveGypsumStudioLighting(metrics, {});
  const authored = deriveGypsumStudioLighting(metrics, { shadowNormalBias: 0.018 });
  assert.ok(authored.shadowNormalBias > derived.shadowNormalBias * 4);
  assert.equal(authored.shadowNormalBias, 0.018);
});

test("balanced gypsum uses a high-key environment fill without weakening control isolation", () => {
  const state = deriveGypsumStudioLighting({
    xyDiagonal: 10,
    terrainRelief: 2,
    gridSpacing: 0.02,
    projectedTerrainSize: 900,
    worldUnitsPerPixel: 0.01,
    viewportWidth: 1200,
    viewportHeight: 800,
  }, GYPSUM_LIGHTING_SCHEMES.white);

  assert.equal(HIGH_KEY_GYPSUM_RESPONSE.mainLightScale, 1.05);
  assert.equal(HIGH_KEY_GYPSUM_RESPONSE.environmentDiffuseScale, 1.35);
  assert.equal(state.mainLightIntensity, 1.05 * 1.05);
  assert.equal(state.environmentDiffuseIntensity, 0.72 * 1.35);
  assert.ok(state.environmentDiffuseIntensity >= 0.85);
  assert.ok(state.environmentDiffuseIntensity < state.mainLightIntensity);
  assert.ok(state.horizonStrength > 0);
  assert.ok(state.horizonStrength <= 0.16);
});

test("curvature response is stable across tiles instead of RMS-normalized per tile", () => {
  const broad = new Float32Array(9);
  const quiet = Float32Array.from([0, 0, 0, 0, 0.01, 0, 0, 0, 0]);
  const loud = Float32Array.from([0, 0, 0, 0, 0.04, 0, 0, 0, 0]);
  const quietResponse = computeTerrainDetailCurvature(quiet, broad, null, 1, 0.02);
  const loudResponse = computeTerrainDetailCurvature(loud, broad, null, 1, 0.02);
  assert.ok(quietResponse[4] > 0);
  assert.ok(loudResponse[4] > quietResponse[4]);
});
