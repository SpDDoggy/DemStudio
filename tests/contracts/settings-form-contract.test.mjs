import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
const babylonRuntime = await readFile(
  new URL("../../src/rendering/babylon-runtime.js", import.meta.url),
  "utf8",
);

test("settings form separates model, lighting, scene, and output tasks", () => {
  const tabs = [...html.matchAll(
    /<button class="tab-btn[^"]*"[^>]*data-tab="([^"]+)"[^>]*>([^<]+)<\/button>/g,
  )].map(([, id, label]) => [id, label.trim()]);
  assert.deepEqual(tabs, [
    ["terrain", "模型"],
    ["lighting", "光照"],
    ["appearance", "场景"],
    ["export", "输出"],
  ]);
});

test("fixed gypsum form exposes no retired material or texture controls", () => {
  assert.match(html, /<strong><i><\/i>石膏<\/strong>/);
  for (const key of [
    "materialMode",
    "lowColor",
    "highColor",
    "roughness",
    "snowLine",
    "textureMode",
    "textureStrength",
    "textureScale",
  ]) {
    assert.doesNotMatch(html, new RegExp(`data-key="${key}"`));
  }
});

test("quick lighting schemes cannot mutate geometry, camera, or export settings", () => {
  assert.match(html, /LIGHTING_PRESET_SETTING_KEYS/);
  assert.match(html, /QUICK_LIGHTING_PRESET_KEYS\.has\(key\)/);
  const lightingKeyBlock = html.match(
    /const LIGHTING_PRESET_SETTING_KEYS = Object\.freeze\(\[([\s\S]*?)\]\);/,
  )?.[1] || "";
  for (const forbidden of [
    "resolution",
    "heightScale",
    "baseThickness",
    "smoothSteps",
    "terrainStyle",
    "cameraMode",
    "exportFormat",
    "exportScale",
  ]) {
    assert.doesNotMatch(lightingKeyBlock, new RegExp(`"${forbidden}"`));
  }
});

test("new scenes preserve source elevation by default", () => {
  const defaultSettings = html.match(
    /const DEFAULT_SETTINGS = \{([\s\S]*?)\n\s*\};/,
  )?.[1] || "";
  assert.match(defaultSettings, /smoothSteps:\s*0,/);
  assert.doesNotMatch(html, /data-key="smoothSteps"/);
  assert.match(html, /settings\.smoothSteps = 0;/);
});

test("model tab exposes scale-selective detail shaping instead of fullscreen sharpen", () => {
  assert.match(html, /表面细节[\s\S]*细节塑形[\s\S]*data-key="detailShapingEnabled"/);
  assert.match(html, /塑形强度[\s\S]*data-key="detailShapingStrength"/);
  assert.match(html, /detailShapingEnabled:\s*true/);
  assert.match(html, /detailShapingStrength:\s*0\.65/);
  assert.match(html, /settings\.sharpenEnabled = false;/);
  assert.doesNotMatch(html, /data-key="sharpenEnabled"|data-key="sharpenStrength"/);
});

test("the single natural terrain path has no redundant terrain type control", () => {
  assert.doesNotMatch(html, /data-key="terrainStyle"/);
  assert.match(html, /settings\.terrainStyle = "smooth";/);
});

test("all quality choices remain selectable while high quality stays budgeted", () => {
  for (const resolution of [2048, 4096]) {
    assert.match(html, new RegExp(`<option value="${resolution}">`));
  }
  assert.match(html, /option\.disabled = false;/);
  assert.match(html, /const TERRAIN_TILE_GPU_BUDGET_BYTES = 192 \* 1024 \* 1024;/);
});

test("lighting controls name the physical quantity they actually change", () => {
  assert.match(html, /主光强度[\s\S]*data-key="shadowIntensity"/);
  assert.match(html, /环境漫反射[\s\S]*data-key="ambientIntensity"/);
  assert.match(html, /曝光[\s\S]*data-key="exposure"/);
  assert.match(html, /光源尺寸[\s\S]*data-key="shadowBlurRadius"/);
  const lightingPanel = html.match(
    /data-panel="lighting"[\s\S]*?data-panel="export"/,
  )?.[0] || "";
  assert.doesNotMatch(lightingPanel, /塑形强度|暗部提亮|边缘锐化/);
});

test("studio floor and fixed exposure are first-class compatible settings", () => {
  assert.match(html, /无限地面[\s\S]*data-key="studioFloorEnabled"/);
  assert.match(html, /地面颜色[\s\S]*data-key="studioFloorColor"/);
  assert.match(html, /exposure:\s*1\.16/);
  assert.match(html, /studioFloorEnabled:\s*true/);
  assert.match(html, /studioFloorColor:\s*"#d3dbe5"/);
  assert.doesNotMatch(html, /sampleWhiteStudioLuminance|studioAutoExposure/);
  assert.match(html, /new B\.PlaneGeometry\(4096, 4096, 1, 1\)/);
  assert.match(html, /floor\.userData\.infiniteGround = true/);
  assert.match(html, /studioFloor\.position\.x = Math\.round\(camera\.position\.x \/ 64\) \* 64/);
});

test("infinite grid suppresses sub-pixel frequencies before they form moire", () => {
  assert.match(html, /float pixelFootprint = max\(derivative\.x, derivative\.y\)/);
  assert.match(html, /float frequencyVisibility = 1\.0 - smoothstep/);
  assert.match(html, /\* frequencyVisibility/);
  assert.match(html, /material\.zOffset = -2/);
});

test("resource telemetry uses a vertical stack without horizontal overflow", () => {
  const telemetryCss = html.match(
    /\.resource-telemetry\s*\{([\s\S]*?)\n\s*\}/,
  )?.[1] || "";
  assert.match(telemetryCss, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.doesNotMatch(telemetryCss, /repeat\(2/);
});

test("contact occlusion drives Babylon SSAO even for permanent gypsum", () => {
  assert.match(
    html,
    /aoEnabled:\s*Boolean\(settings\.aoEnabled\)\s*&&\s*Number\(settings\.aoStrength\)\s*>\s*0\.001/,
  );
  assert.doesNotMatch(html, /gtaoPass\.enabled\s*=\s*!whiteStudio/);
});

test("camera motion does not invalidate the world-space PCSS shadow map", () => {
  const shadowSignature = html.match(
    /const shadowSignature = \[([\s\S]*?)\]\.join\("\|"\);/,
  )?.[1] || "";
  assert.match(shadowSignature, /bounds\?\.min/);
  assert.match(shadowSignature, /settings\.sunAzimuth/);
  assert.doesNotMatch(shadowSignature, /camera|cameraSignature/);
  assert.match(html, /if \(shadowProjectionChanged\) markShadowMapDirty\(\)/);
});

test("camera change detection reuses numeric state without per-frame strings", () => {
  assert.match(babylonRuntime, /function updateCameraState\(camera, target\)/);
  assert.match(babylonRuntime, /new Float64Array\(11\)/);
  assert.doesNotMatch(babylonRuntime, /cameraSignature|toFixed\(7\).*join/);
  assert.match(html, /if \(!studioLightingInputDirty && !qualityNeedsUpdate\) return false/);
});

test("legacy persisted states normalize onto the single gypsum surface path", () => {
  assert.match(html, /migrated\.materialMode = "white"/);
  assert.match(html, /settings\.materialMode = "white"/);
  assert.match(html, /settings\.textureMode = "none"/);
  assert.match(html, /const whiteModel = true/);
  assert.doesNotMatch(
    html,
    /function updateStudioLightingForFrame[\s\S]{0,180}materialMode/,
  );
  assert.match(html, /Number\(settings\.sunAzimuth\)\.toFixed\(2\)/);
  assert.match(html, /Number\(settings\.sunElevation\)\.toFixed\(2\)/);
});
