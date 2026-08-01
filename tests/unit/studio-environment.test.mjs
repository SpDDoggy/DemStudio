import assert from "node:assert/strict";
import test from "node:test";

import {
  averageFaceEnergy,
  createStudioEnvironmentCube,
  STUDIO_ENVIRONMENT_FACE_SIZE,
} from "../../src/studio-environment.js";

test("studio cubemap has upper, side, and lower hemisphere energy hierarchy", () => {
  const cube = createStudioEnvironmentCube();
  assert.equal(cube.size, STUDIO_ENVIRONMENT_FACE_SIZE);
  const upper = averageFaceEnergy(cube.up);
  const lower = averageFaceEnergy(cube.down);
  const side = (
    averageFaceEnergy(cube.right)
    + averageFaceEnergy(cube.left)
    + averageFaceEnergy(cube.front)
    + averageFaceEnergy(cube.back)
  ) / 4;
  assert.ok(upper > side, `${upper} should exceed ${side}`);
  assert.ok(side > lower, `${side} should exceed ${lower}`);
});

test("floor color changes only lower-hemisphere reflection", () => {
  const cool = createStudioEnvironmentCube({ floorColor: "#547aa5" });
  const warm = createStudioEnvironmentCube({ floorColor: "#a57a54" });
  assert.deepEqual(cool.up, warm.up);
  assert.notDeepEqual(cool.down, warm.down);
});
