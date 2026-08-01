import assert from "node:assert/strict";
import test from "node:test";

import {
  TerrainResidency,
  enumerateLevelTiles,
  tileCoordinateKey,
} from "../src/rendering/terrain-residency.js";

test("1024 quality owns exactly 64 persistent level-3 base tiles", () => {
  const residency = new TerrainResidency({
    datasetRevision: 7,
    targetMaxLevel: 3,
  });
  assert.equal(residency.baseLevel, 3);
  assert.equal(residency.requiredBaseTiles.size, 64);

  const tiles = enumerateLevelTiles(3);
  for (const tile of tiles) {
    residency.markBaseReady(tile.coordinateKey, {
      empty: tile.x === 0 && tile.y === 0,
      gpuBytes: tile.x === 0 && tile.y === 0 ? 0 : 1024,
      mesh: tile.x === 0 && tile.y === 0 ? null : { uniqueId: tile.x + tile.y * 8 },
    });
  }

  const diagnostics = residency.diagnostics();
  assert.equal(diagnostics.readyBaseTileCount, 64);
  assert.equal(diagnostics.emptyBaseTileCount, 1);
  assert.equal(diagnostics.baseComplete, true);
  assert.equal(diagnostics.baseBuilds, 64);
  assert.equal(diagnostics.baseUploads, 63);
  assert.equal(diagnostics.baseDisposals, 0);
});

test("camera refinement selection never mutates completed base counters", () => {
  const residency = new TerrainResidency({ targetMaxLevel: 5 });
  for (const tile of enumerateLevelTiles(3)) {
    residency.markBaseReady(tile.coordinateKey, {
      gpuBytes: 128,
      mesh: { uniqueId: tile.x + tile.y * 8 },
    });
  }
  const before = residency.diagnostics();

  residency.setDesiredRefinements([
    { level: 4, x: 4, y: 5 },
    { level: 5, x: 9, y: 10 },
  ]);
  residency.markRefinementResident(tileCoordinateKey(4, 4, 5), {
    key: "refine-a",
    gpuBytes: 64,
    mesh: { uniqueId: 1001 },
  });
  residency.setDesiredRefinements([{ level: 5, x: 9, y: 10 }]);
  residency.setDesiredRefinements([{ level: 4, x: 4, y: 5 }]);
  const after = residency.diagnostics();

  assert.equal(after.readyBaseTileCount, before.readyBaseTileCount);
  assert.equal(after.baseSamples, before.baseSamples);
  assert.equal(after.baseBuilds, before.baseBuilds);
  assert.equal(after.baseUploads, before.baseUploads);
  assert.equal(after.baseDisposals, before.baseDisposals);
  assert.ok(after.refinementCacheHits >= 1);
});

test("GPU pressure evicts only hidden refinement LRU entries", () => {
  const residency = new TerrainResidency({
    targetMaxLevel: 5,
    gpuBudgetBytes: 300,
    overviewGpuBytes: 100,
  });
  const hiddenKey = tileCoordinateKey(4, 1, 1);
  const visibleKey = tileCoordinateKey(4, 2, 2);
  residency.setDesiredRefinements([{ level: 4, x: 2, y: 2 }]);
  residency.markRefinementResident(hiddenKey, {
    gpuBytes: 120,
    mesh: { uniqueId: 1 },
  });
  residency.markRefinementResident(visibleKey, {
    gpuBytes: 120,
    mesh: { uniqueId: 2 },
  });

  const disposed = [];
  const evicted = residency.evictRefinements(record => {
    disposed.push(record.coordinateKey);
  });

  assert.deepEqual(evicted, [hiddenKey]);
  assert.deepEqual(disposed, [hiddenKey]);
  assert.equal(residency.residentRefinementTiles.has(visibleKey), true);
  assert.equal(residency.counters.baseDisposals, 0);
  assert.ok(residency.totalGpuBytes <= residency.gpuBudgetBytes);
});

test("compatible L3 quality changes preserve base identity and resident refinements", () => {
  const previous = new TerrainResidency({
    datasetRevision: 7,
    targetMaxLevel: 4,
    baseSignature: "7:3:same-geometry",
  });
  const baseKey = tileCoordinateKey(3, 2, 5);
  const baseMesh = { uniqueId: 91 };
  previous.markBaseReady(baseKey, {
    mesh: baseMesh,
    gpuBytes: 128,
  });
  const refinementKey = tileCoordinateKey(4, 4, 10);
  const refinementMesh = { uniqueId: 92 };
  previous.markRefinementResident(refinementKey, {
    tile: { level: 4, x: 4, y: 10 },
    mesh: refinementMesh,
    gpuBytes: 64,
  });

  const next = new TerrainResidency({
    datasetRevision: 7,
    targetMaxLevel: 5,
    baseSignature: "7:3:same-geometry",
  });
  assert.equal(next.adoptCompatibleResidency(previous), true);
  assert.equal(next.readyBaseTiles.get(baseKey).mesh, baseMesh);
  assert.equal(
    next.residentRefinementTiles.get(refinementKey).mesh,
    refinementMesh,
  );
  assert.equal(next.baseGpuBytes, 128);
  assert.equal(next.refinementGpuBytes, 64);
});

test("base level changes cannot adopt meshes from the previous quality", () => {
  const previous = new TerrainResidency({
    datasetRevision: 7,
    targetMaxLevel: 2,
    baseSignature: "7:2:same-geometry",
  });
  const next = new TerrainResidency({
    datasetRevision: 7,
    targetMaxLevel: 3,
    baseSignature: "7:3:same-geometry",
  });
  assert.equal(next.adoptCompatibleResidency(previous), false);
  assert.equal(next.readyBaseTiles.size, 0);
});
