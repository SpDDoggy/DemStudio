import assert from "node:assert/strict";
import test from "node:test";

import {
  toBabylonVertexColorData,
  Color,
  Vector2,
  Vector3,
} from "../src/rendering/babylon-scene-kit.js";
import { attachDemTerrainMaterialPlugin } from "../src/rendering/babylon-material-plugin.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";

test("RGB terrain colors are expanded to Babylon RGBA vertex data", () => {
  const source = {
    array: new Float32Array([
      0.2, 0.4, 0.6,
      0.8, 0.5, 0.1,
    ]),
    itemSize: 3,
    count: 2,
  };

  assert.deepEqual(
    Array.from(toBabylonVertexColorData(source)),
    [
      source.array[0], source.array[1], source.array[2], 1,
      source.array[3], source.array[4], source.array[5], 1,
    ],
  );
});

test("RGBA terrain colors retain their source buffer", () => {
  const array = new Float32Array([0.2, 0.4, 0.6, 0.75]);
  assert.equal(
    toBabylonVertexColorData({ array, itemSize: 4, count: 1 }),
    array,
  );
});

test("unsupported vertex color arity fails closed", () => {
  assert.throws(
    () => toBabylonVertexColorData({
      array: new Float32Array([0.2, 0.4]),
      itemSize: 2,
      count: 1,
    }),
    /require RGB or RGBA/,
  );
});

test("Three-compatible vectors allocate toArray results when no target is supplied", () => {
  assert.deepEqual(new Vector2(2, 4).toArray(), [2, 4]);
  assert.deepEqual(new Vector3(3, 6, 9).toArray(), [3, 6, 9]);
});

test("authored sRGB colors enter Babylon's linear PBR working space", () => {
  const middleGray = new Color("#808080");
  assert.ok(middleGray.r > 0.21 && middleGray.r < 0.22);
  assert.equal(middleGray.r, middleGray.g);
  assert.equal(middleGray.g, middleGray.b);
});

test("optional relight sampler always has a local neutral binding", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("terrain", scene);
  const plugin = attachDemTerrainMaterialPlugin(material);
  const textures = [];
  plugin.getActiveTextures(textures);
  assert.equal(textures.length, 1);
  assert.equal(textures[0].name, "dem-neutral-relight-gain");
  assert.equal(plugin.gainTexture, null);
  scene.dispose();
  engine.dispose();
});

test("terrain plugin exposes bounded curvature shaping on both shader languages", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("terrain-curvature", scene);
  const plugin = attachDemTerrainMaterialPlugin(material, {
    detailShapingStrength: 0.65,
  });
  const attributes = [];
  plugin.getAttributes(attributes);
  assert.ok(attributes.includes("studioCurvature"));
  assert.ok(attributes.includes("horizonVisibility"));
  assert.equal(plugin.detailShapingStrength, 0.65);
  const glsl = plugin._glslCode("fragment").CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR;
  const wgsl = plugin._wgslCode("fragment").CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR;
  assert.match(glsl, /demDetailShapingStrength/);
  assert.match(wgsl, /demDetailShapingStrength/);
  const glslHorizon = plugin._glslCode("fragment").CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION;
  const wgslHorizon = plugin._wgslCode("fragment").CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION;
  assert.match(glslHorizon, /finalIrradiance \*= demHorizonOcclusion/);
  assert.match(wgslHorizon, /finalIrradiance \*= demHorizonOcclusion/);
  scene.dispose();
  engine.dispose();
});
