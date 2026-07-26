import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const bridge = await readFile(new URL("../src/host-bridge.js", import.meta.url), "utf8");
const tauriConfig = JSON.parse(
  await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
);
const capability = JSON.parse(
  await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8")
);
const tauriMain = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

const checks = [
  ["host bridge is imported", html.includes('import "./src/host-bridge.js";')],
  ["Three.js stays local", html.includes('from "three"')],
  ["GeoTIFF stays local", html.includes('import("geotiff")')],
  ["CDN import map is removed", !html.includes("https://unpkg.com/three") && !html.includes("https://cdn.jsdelivr.net/npm/geotiff")],
  ["settings compatibility exists", bridge.includes("dem-studio.json") && bridge.includes("pluginId, key")],
  ["binary export bridge exists", bridge.includes("writeBlob")],
  ["Rust DEM Core is wired", bridge.includes('invoke("parse_dem"') && html.includes('raw.engine === "rust-dem-core"')],
  ["Rust terrain sampling is wired", bridge.includes('invoke("sample_dem"') && html.includes("coreApi.sampleDem")],
  ["Rust GeoTIFF export is wired", bridge.includes('invoke("encode_geotiff"') && html.includes("coreApi.encodeGeoTiff")],
  ["Fluent frameless shell exists", html.includes('class="titlebar"') && html.includes('id="windowClose"')],
  ["Windows GUI subsystem hides the console window", tauriMain.includes('windows_subsystem = "windows"')],
  ["reference workspace composition exists", html.includes('class="viewport-expand"') && html.includes("viewport-focused")],
  ["resource panel has no duplicate import action", !html.includes('id="dropzone"') && !html.includes("添加 DEM 或影像")],
  ["duplicate header actions are absent", !html.includes('<header class="topbar">') && !html.includes('id="btnSavePreset"') && !html.includes('id="btnExport"')],
  ["workspace status and footer actions are absent", !html.includes('class="workspace-footer"') && !html.includes('id="runtimeStatus"') && !html.includes('id="fpsStatus"') && !html.includes('id="btnHelp"') && !html.includes('id="btnOpenInspector"')],
  ["panel save and export actions remain", html.includes('id="btnSavePresetPanel"') && html.includes('id="btnExportPanel"')],
  ["transparent titlebar has no retained blur", /[.]titlebar\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;/s.test(html)],
  ["window controls are three circular buttons", (html.match(/class="caption-button(?: close)?"/g) || []).length === 3 && html.includes("border-radius: 50%")],
  ["browser dialogs and file inputs are absent", !/<input[^>]+type=["']file["']/i.test(html) && !/\b(?:alert|confirm|prompt)\s*\(/.test(html)],
  ["in-app dialog system exists", html.includes('id="appDialogLayer"') && html.includes("showAppDialog")],
  ["recent files can reopen source paths", bridge.includes("openDemPath") && html.includes("openRecentFile") && html.includes("companionPaths")],
  ["image heightmaps use the desktop path bridge", bridge.includes("IMAGE_HEIGHTMAP_EXTENSIONS") && bridge.includes('kind: "image-heightmap"') && html.includes("adoptOpenedDataset") && html.includes("parseImageHeightmap")],
  ["texture import uses Tauri file access", bridge.includes("openTexture") && capability.permissions.includes("fs:allow-read-file")],
  ["floating panels expose capsules", html.includes('id="btnOpenResources"') && html.includes('id="btnOpenSettingsCapsule"')],
  ["infinite fading grid shader exists", html.includes("createInfiniteGrid") && html.includes("uFadeStart") && !html.includes("new THREE.GridHelper")],
  ["camera projection self-reconciles", html.includes("ensureCameraProjection") && html.includes("cameraProjectionMode")],
  [
    "Linux AppImage square icon is declared",
    Array.isArray(tauriConfig.bundle?.icon)
      && tauriConfig.bundle.icon.some((icon) => /(?:^|\/)128x128(?:@2x)?\.png$/.test(icon))
  ],
  ["product UI contains no emoji terrain icon", !html.includes("⛰️")]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}
