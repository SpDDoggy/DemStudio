import assert from "node:assert/strict";
import test from "node:test";

import { computeDemGradientNormals } from "../src/terrain-geometry.js";

test("DEM gradient normals match an analytic plane independently of triangulation", () => {
  const cols = 9;
  const rows = 7;
  const worldW = 8;
  const worldD = 6;
  const slopeX = 0.12;
  const slopeZ = -0.08;
  const heights = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      heights[y * cols + x] = 0.2 + slopeX * x + slopeZ * y;
    }
  }

  const normals = computeDemGradientNormals(heights, cols, rows, worldW, worldD, 1);
  const inverseLength = 1 / Math.hypot(slopeX, 1, slopeZ);
  const expected = [-slopeX * inverseLength, inverseLength, -slopeZ * inverseLength];
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const offset = (y * cols + x) * 3;
      const dot = normals[offset] * expected[0]
        + normals[offset + 1] * expected[1]
        + normals[offset + 2] * expected[2];
      const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
      assert.ok(dot >= 0.99999, `normal dot ${dot} drifted from the DEM plane`);
      assert.ok(Math.abs(length - 1) <= 1e-5);
    }
  }
});

test("NoData samples do not inject artificial zero-height gradients", () => {
  const cols = 5;
  const rows = 5;
  const heights = new Float32Array(cols * rows).fill(0.4);
  heights[2 * cols + 1] = -9999;
  const mask = new Uint8Array(cols * rows).fill(1);
  mask[2 * cols + 1] = 0;

  const normals = computeDemGradientNormals(heights, cols, rows, 4, 4, 1, mask);
  for (let index = 0; index < cols * rows; index++) {
    assert.ok(Math.abs(normals[index * 3]) <= 1e-7);
    assert.ok(Math.abs(normals[index * 3 + 1] - 1) <= 1e-7);
    assert.ok(Math.abs(normals[index * 3 + 2]) <= 1e-7);
  }
});

test("invalid grid shape fails closed", () => {
  assert.throws(
    () => computeDemGradientNormals(new Float32Array(3), 2, 2, 1, 1, 1),
    /Invalid DEM gradient grid/,
  );
});
