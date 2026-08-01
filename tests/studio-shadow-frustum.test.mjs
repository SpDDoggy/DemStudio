import assert from "node:assert/strict";
import test from "node:test";

import { fitDirectionalShadowFrustum } from "../src/studio-shadow-frustum.js";

test("directional shadow fit is finite, ordered, and texel aligned", () => {
  const fit = fitDirectionalShadowFrustum({
    bounds: {
      min: [-4, 0, -3],
      max: [4, 1.8, 3],
    },
    lightDirection: [-0.45, -0.82, -0.36],
    mapSize: 2048,
  });
  for (const key of [
    "left", "right", "bottom", "top", "near", "far",
    "texelX", "texelY", "centerX", "centerY",
  ]) {
    assert.ok(Number.isFinite(fit[key]), `${key} must be finite`);
  }
  assert.ok(fit.left < fit.right);
  assert.ok(fit.bottom < fit.top);
  assert.ok(fit.near > 0 && fit.far > fit.near);
  assert.ok(Math.abs(fit.centerX / fit.texelX - Math.round(fit.centerX / fit.texelX)) < 1e-9);
  assert.ok(Math.abs(fit.centerY / fit.texelY - Math.round(fit.centerY / fit.texelY)) < 1e-9);
});
