import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const bridge = await readFile(new URL("../src/host-bridge.js", import.meta.url), "utf8");

const checks = [
  ["host bridge is imported", html.includes('import "./src/host-bridge.js";')],
  ["Three.js stays local", html.includes('from "three"')],
  ["GeoTIFF stays local", html.includes('import("geotiff")')],
  ["CDN import map is removed", !html.includes("https://unpkg.com/three") && !html.includes("https://cdn.jsdelivr.net/npm/geotiff")],
  ["settings compatibility exists", bridge.includes("dem-studio.json") && bridge.includes("pluginId, key")],
  ["binary export bridge exists", bridge.includes("writeBlob")]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}
