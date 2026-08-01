import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const bridge = await readFile(new URL("../src/host-bridge.js", import.meta.url), "utf8");
const tauriConfig = JSON.parse(
  await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
);
const tauriDevConfig = JSON.parse(
  await readFile(new URL("../src-tauri/tauri.dev.conf.json", import.meta.url), "utf8")
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const releaseExeVerifier = await readFile(
  new URL("./verify-release-exe.ps1", import.meta.url),
  "utf8"
);
const capability = JSON.parse(
  await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8")
);
const tauriMain = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const tauriLib = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const demCore = await readFile(new URL("../src-tauri/dem-core/src/lib.rs", import.meta.url), "utf8");
const runtimeSmoke = await readFile(new URL("./runtime-smoke.ps1", import.meta.url), "utf8");
const lightingProfile = await readFile(
  new URL("../src/lighting-profile.js", import.meta.url),
  "utf8"
);
const studioLightingRig = await readFile(
  new URL("../src/studio-lighting-rig.js", import.meta.url),
  "utf8"
);
const studioEnvironment = await readFile(
  new URL("../src/studio-environment.js", import.meta.url),
  "utf8"
);
const studioShadowFrustum = await readFile(
  new URL("../src/studio-shadow-frustum.js", import.meta.url),
  "utf8"
);
const terrainNormalLod = await readFile(
  new URL("../src/terrain-normal-lod.js", import.meta.url),
  "utf8"
);
const gypsumMaterialPolicy = await readFile(
  new URL("../src/gypsum-material-policy.js", import.meta.url),
  "utf8"
);
const gypsumBlackFrameBug = await readFile(
  new URL("../docs/product/BUG-2026-07-31-WEBGPU-GYPSUM-BLACK-FRAME.md", import.meta.url),
  "utf8"
);
const lightingControlsBug = await readFile(
  new URL("../docs/product/BUG-2026-07-31-LIGHTING-CONTROLS-NOT-PHYSICAL.md", import.meta.url),
  "utf8"
);
const contactOcclusionBug = await readFile(
  new URL("../docs/product/BUG-2026-07-31-SSAO-CONTACT-OCCLUSION-CONTRAST.md", import.meta.url),
  "utf8"
);
const codeAudit = await readFile(
  new URL("../docs/product/CODE-AUDIT-2026-07-31.md", import.meta.url),
  "utf8"
);
const babylonRuntime = await readFile(
  new URL("../src/rendering/babylon-runtime.js", import.meta.url),
  "utf8"
);
const realtimePostProcessPolicy = await readFile(
  new URL("../src/rendering/realtime-postprocess-policy.js", import.meta.url),
  "utf8"
);
const babylonSceneKit = await readFile(
  new URL("../src/rendering/babylon-scene-kit.js", import.meta.url),
  "utf8"
);
const babylonMaterialPlugin = await readFile(
  new URL("../src/rendering/babylon-material-plugin.js", import.meta.url),
  "utf8"
);
const babylonEngineRegistration = await readFile(
  new URL("../src/rendering/babylon-engine-registration.js", import.meta.url),
  "utf8"
);
const viteConfig = await readFile(
  new URL("../vite.config.js", import.meta.url),
  "utf8"
);
const terrainResidency = await readFile(
  new URL("../src/rendering/terrain-residency.js", import.meta.url),
  "utf8"
);
const realTifHarness = await readFile(new URL("./verify-frmm-real-tif.ps1", import.meta.url), "utf8");
const synthetic307kPerf = await readFile(
  new URL("./perf-synthetic-307k-foreground.ps1", import.meta.url),
  "utf8"
);
const realInputPerformanceBug = await readFile(
  new URL("../docs/product/BUG-2026-07-29-REAL-INPUT-PERFORMANCE-FALSE-GREEN.md", import.meta.url),
  "utf8"
);
const geotiffTopologyBug = await readFile(
  new URL("../docs/product/BUG-2026-07-30-GEOTIFF-OVERVIEW-LOD-TOPOLOGY.md", import.meta.url),
  "utf8"
);
const gridQualityBug = await readFile(
  new URL("../docs/product/BUG-2026-07-30-GRID-QUALITY-FALSE-ENTITLEMENT.md", import.meta.url),
  "utf8"
);
const demSignalBug = await readFile(
  new URL("../docs/product/BUG-2026-07-30-DEM-SIGNAL-NORMAL-LIGHTING-COUPLING.md", import.meta.url),
  "utf8"
);
const webGpuFrameSubmissionBug = await readFile(
  new URL("../docs/product/BUG-2026-07-30-WEBGPU-ON-DEMAND-FRAME-SUBMISSION.md", import.meta.url),
  "utf8"
);
const babylonCameraFeedbackBug = await readFile(
  new URL("../docs/product/BUG-2026-07-31-BABYLON-CAMERA-MATRIX-LOD-FEEDBACK.md", import.meta.url),
  "utf8"
);
const babylonVisualSemanticBug = await readFile(
  new URL("../docs/product/BUG-2026-07-31-BABYLON-VISUAL-SEMANTIC-DRIFT.md", import.meta.url),
  "utf8"
);
const baseTransitionBug = await readFile(
  new URL("../docs/product/BUG-2026-07-31-TIFF-BASE-LEVEL-TRANSITION-ORPHAN-MESHES.md", import.meta.url),
  "utf8"
);
const interactionHarnessAllocationBug = await readFile(
  new URL("../docs/product/BUG-2026-07-31-INTERACTION-HARNESS-ALLOCATION-SPIKE.md", import.meta.url),
  "utf8"
);
const runRenderFrameMatch = html.match(
  /function\s+runRenderFrame\s*\(\)\s*\{([\s\S]*?)\n    \}\n\n    function\s+updateInfiniteGrid/
);
const runRenderFrameBody = runRenderFrameMatch?.[1] ?? "";

const checks = [
  [
    "production Tauri config cannot fall back to a development server",
    tauriConfig.build?.devUrl === undefined
      && tauriConfig.build?.beforeDevCommand === undefined
      && tauriConfig.build?.frontendDist === "../dist"
  ],
  [
    "development server is isolated behind an explicit dev-only config",
    tauriDevConfig.build?.devUrl === "http://127.0.0.1:1420"
      && packageJson.scripts?.["desktop:dev"]?.includes("tauri.dev.conf.json")
  ],
  [
    "release EXE gate rejects embedded localhost entrypoints",
    releaseExeVerifier.includes("[System.Text.Encoding]::Unicode")
      && releaseExeVerifier.includes("https?://localhost")
      && releaseExeVerifier.includes("https?://127")
      && releaseExeVerifier.includes("https?://0\\.0\\.0\\.0")
      && releaseExeVerifier.includes("https?://\\[::1\\]")
      && releaseExeVerifier.includes("tauri://localhost")
  ],
  [
    "all user-facing production build commands enforce the release EXE gate",
    packageJson.scripts?.["desktop:build"]?.includes("build-release-exe.ps1")
      && packageJson.scripts?.["desktop:build:exe"]?.includes("build-release-exe.ps1")
      && packageJson.scripts?.["desktop:build:windows"]?.includes("build-release-exe.ps1")
      && packageJson.scripts?.["desktop:build:windows"]?.includes("-BundleNsis")
  ],
  ["host bridge is imported", html.includes('import "./src/host-bridge.js";')],
  [
    "Babylon renderer is exact-pinned and the retired renderer dependencies are absent",
    packageJson.dependencies?.["@babylonjs/core"] === "9.18.0"
      && !["three", "three-gpu-pathtracer", "three-mesh-bvh", "xatlas-web"]
        .some(name => Object.hasOwn(packageJson.dependencies || {}, name))
      && html.includes('from "@babylonjs/core/Cameras/camera.js"')
      && babylonRuntime.includes('from "./babylon-engine-registration.js"')
      && babylonRuntime.includes(
        "@babylonjs/core/assets/glslang/glslang.wasm?url",
      )
      && babylonRuntime.includes(
        "@babylonjs/core/assets/twgsl/twgsl.wasm?url",
      )
      && babylonRuntime.includes('shaderCompilerAssets: this.backend === BACKEND_WEBGPU ? "local"')
      && babylonEngineRegistration.includes(
        "@babylonjs/core/Engines/webgpuEngine.pure.js",
      )
      && !babylonEngineRegistration.includes("abstractEngine.textureLoaders.js")
      && viteConfig.includes("dem-studio-offline-renderer-bundle")
      && viteConfig.includes("CDN URL emitted")
      && viteConfig.includes("sourcemap: false")
      && html.includes('from "./src/rendering/babylon-runtime.js"')
      && !html.includes('from "three"')
      && !html.includes("three-gpu-pathtracer")
  ],
  [
    "on-demand Babylon rendering submits explicit WebGPU frame boundaries",
    babylonRuntime.includes("this.runtime.engine.beginFrame()")
      && babylonRuntime.includes("this.runtime.engine.endFrame()")
      && html.includes("renderRuntime.engine.beginFrame()")
      && html.includes("renderRuntime.engine.endFrame()")
      && webGpuFrameSubmissionBug.includes("beginFrame/endFrame")
      && webGpuFrameSubmissionBug.includes("可见像素")
  ],
  ["GeoTIFF stays local", html.includes('import("geotiff")')],
  [
    "rendering and GeoTIFF production imports contain no CDN",
    !/(?:unpkg|jsdelivr|cdnjs|esm\.sh)/i.test(html)
      && !/(?:unpkg|jsdelivr|cdnjs|esm\.sh)/i.test(babylonRuntime)
      && !html.includes("https://cdn.jsdelivr.net/npm/geotiff")
  ],
  ["settings compatibility exists", bridge.includes("dem-studio.json") && bridge.includes("pluginId, key")],
  ["binary export bridge exists", bridge.includes("writeBlob")],
  ["Rust DEM Core is wired", bridge.includes('invoke("parse_dem"') && html.includes('startsWith("rust-dem-core")')],
  ["Rust terrain sampling is wired", bridge.includes('invoke("sample_dem"') && html.includes("coreApi.sampleDem")],
  [
    "DEM signal, gradient normal, and split-light regression contract is permanent",
    demSignalBug.includes("归一化前保持 `f64`")
      && demSignalBug.includes("lod_prefilter_suppresses_checkerboard_aliasing")
      && demSignalBug.includes("normalSource=dem-gradient")
      && demCore.includes("filtered_memory_value")
      && demCore.includes("read_filtered_file_value")
      && html.includes("computeDemGradientNormals")
      && html.includes("precisionClass: \"preview-8bit\"")
      && runtimeSmoke.includes('$lightingState.projection.terrainInfluence')
  ],
  [
    "Rust Core v2 uses file-backed lifecycle and binary preview sampling",
    bridge.includes('invokeBinarySample("sample_dem_binary"')
      && bridge.includes('invokeBinarySample("sample_dem_overview_binary"')
      && bridge.includes('invoke("release_dem"')
      && bridge.includes('invoke("core_stats"')
      && html.includes("sampleDemBinary")
      && html.includes("releaseCoreDataset")
  ],
  [
    "windowed DEM binary sampling is wired end to end",
    bridge.includes('invoke("sample_dem_window_binary"')
      && bridge.includes("sampleDemWindowBinary")
      && html.includes("sampleDemWindowBinary")
      && tauriLib.includes("fn sample_dem_window_binary")
      && /generate_handler!\s*\[[\s\S]*\bsample_dem_window_binary\s*,/m.test(tauriLib)
  ],
  [
    "file-backed GeoTIFF keeps display overview separate from bounded statistics",
    demCore.includes("MAX_STATS_GRID_SIDE")
      && demCore.includes("read_embedded_display_overview")
      && demCore.includes("companion_display_overview")
      && demCore.includes('appended_sidecar_path(path, ".ovr")')
      && demCore.includes('appended_sidecar_path(path, ".aux.xml")')
      && demCore.includes("MAX_AUX_XML_BYTES")
      && demCore.includes("STATISTICS_MINIMUM")
      && demCore.includes("STATISTICS_MAXIMUM")
      && demCore.includes("file_backed_geotiff_auto_discovers_exact_pam_and_ovr_sidecars")
  ],
  [
    "streaming LOD owns a complete persistent base and removes overview only after base completion",
    html.includes("function setTerrainRootTopCovered")
      && html.includes("setTerrainRootTopCovered(coverageComplete)")
      && html.includes("requiredBaseTiles")
      && html.includes("readyBaseTiles")
      && html.includes("desiredRefinementTiles")
      && html.includes("residentRefinementTiles")
      && html.includes("TERRAIN_BASE_MAX_LEVEL,")
      && html.includes("terrainResidency.baseComplete")
      && terrainResidency.includes("enumerateLevelTiles(this.baseLevel)")
      && terrainResidency.includes("TERRAIN_BASE_MAX_LEVEL = 3")
      && terrainResidency.includes("emptyBaseTileCount")
      && terrainResidency.includes("adoptCompatibleResidency(previous)")
      && html.includes("clearTerrainResourcesForBaseLevelChange")
      && html.includes("terrainBaseLifecycleSignature(baseLevel)")
      && html.includes("function getTerrainRootCoverageDiagnostics()")
      && html.includes("if (ENABLE_STREAMING_TERRAIN_LOD)")
      && html.includes("rootTopVisible: rootTopIndexCount > 0")
      && html.includes("rootBaseRequired")
      && html.includes("const retainedBaseIndices = baseIndices")
      && html.includes("rootCoverageExact:")
      && html.includes("coverageComplete: terrainResidency.baseComplete")
      && html.includes("const streamingTile = Number.isInteger(windowRequest.level)")
      && /const edgeMorphWidth = streamingTile\s*\?\s*0/.test(html)
      && html.includes("edgeMorphWidths:")
      && html.includes('horizonLightingSource = "root-interpolated"')
  ],
  [
    "real GeoTIFF runtime Harness fails closed on mask and parent coverage",
    runtimeSmoke.includes("ExpectedOverviewValidCount")
      && runtimeSmoke.includes("ExpectedOverviewMaskHash")
      && runtimeSmoke.includes("sampledMaskHash")
      && runtimeSmoke.includes("coverageComplete")
      && runtimeSmoke.includes("rootTopVisible")
      && runtimeSmoke.includes("rootTopIndexCount")
      && runtimeSmoke.includes("rootBaseRequired")
      && runtimeSmoke.includes("rootCoverageExact")
      && runtimeSmoke.includes("rootIndexCount")
      && runtimeSmoke.includes("focusLodActive")
      && runtimeSmoke.includes("edgeMorphWidths")
      && runtimeSmoke.includes("queuedUploadCount")
      && runtimeSmoke.includes("ExpectedReadyTriangles")
      && runtimeSmoke.includes("ExpectedMinimumTargetLevelTiles")
      && runtimeSmoke.includes("MaxProcessTreeWorkingSetBytes")
      && runtimeSmoke.includes("Frame p99")
      && runtimeSmoke.includes("Maximum frame")
      && runtimeSmoke.includes("Long-task count")
      && runtimeSmoke.includes("chunkCacheCapacityBytes -ne 67108864")
      && runtimeSmoke.includes("hudTopologyText")
      && runtimeSmoke.includes("readyDesiredHorizonVertexCount")
      && realTifHarness.includes("EB5FEDDF70C0333629DF6BC622A9B001379278F372884B90B7C9D547E7A721BC")
      && realTifHarness.includes('"-ExpectedOverviewMaskHash", 986830350')
      && realTifHarness.includes("Triangles = 750000")
      && realTifHarness.includes("Dimension = 2048")
      && realTifHarness.includes("Dimension = 4096")
      && realTifHarness.includes("MinimumTargetTiles = 3")
      && realTifHarness.includes('"-MaxProcessTreeWorkingSetBytes", 1610612736')
      && demCore.includes("DEFAULT_CHUNK_CACHE_BYTES: usize = 64 * 1024 * 1024")
      && realTifHarness.includes("0x897F")
      && realTifHarness.includes("0x6EC7")
      && realTifHarness.includes("runtime.log")
      && realTifHarness.includes("summary.json")
      && runtimeSmoke.includes("dem-studio-runtime-smoke-v1")
      && runtimeSmoke.includes("executableSha256")
  ],
  [
    "GeoTIFF topology BUG records source fingerprint and structural Oracle",
    geotiffTopologyBug.includes("EB5FEDDF70C0333629DF6BC622A9B001379278F372884B90B7C9D547E7A721BC")
      && geotiffTopologyBug.includes("IoU：0.6549")
      && geotiffTopologyBug.includes("coverageComplete=true")
      && geotiffTopologyBug.includes("rootTopVisible=false")
      && geotiffTopologyBug.includes("edgeMorphWidths=[0]")
      && geotiffTopologyBug.includes("986,830,350")
  ],
  [
    "grid quality BUG forbids settings-only precision and monolithic 4096",
    gridQualityBug.includes("BUG-2026-07-30：大范围网格质量虚标与顶点不足")
      && gridQualityBug.includes("maximumReadyLevel == targetMaxLevel")
      && gridQualityBug.includes("readyDesiredVertexCount > sampledLength")
      && gridQualityBug.includes("4096² 单网格")
  ],
  [
    "Synthetic 307K foreground performance Harness covers real input and recovery",
    synthetic307kPerf.includes('"Input.dispatchMouseEvent"')
      && synthetic307kPerf.includes("event.isTrusted")
      && synthetic307kPerf.includes("TRUSTED_CDP_POINTER_AND_WHEEL")
      && synthetic307kPerf.includes('[data-quick-preset="white"]')
      && synthetic307kPerf.includes('[data-camera-mode="orthographic"]')
      && synthetic307kPerf.includes('[data-view="iso"]')
      && synthetic307kPerf.includes('$datasetState.sampledLength -eq 307200')
      && synthetic307kPerf.includes('$rendererState.terrainVertices -eq 316148')
      && synthetic307kPerf.includes('$rendererState.terrainTriangles -eq 616636')
      && synthetic307kPerf.includes('setPhase("dragRecovery")')
      && synthetic307kPerf.includes('setPhase("wheelRecovery")')
      && synthetic307kPerf.includes('"longtask"')
      && synthetic307kPerf.includes("drawingBufferSize")
      && synthetic307kPerf.includes("p99Ms")
      && synthetic307kPerf.includes("maxMs")
      && synthetic307kPerf.includes("over25Ms")
      && synthetic307kPerf.includes("over50Ms")
      && synthetic307kPerf.includes("$ActiveMaxP95FrameMilliseconds = 16.7")
      && synthetic307kPerf.includes("$ActiveMaxP99FrameMilliseconds = 25")
      && synthetic307kPerf.includes("$RecoveryMaxP95FrameMilliseconds = 16.7")
      && synthetic307kPerf.includes("$RecoveryMaxP99FrameMilliseconds = 33.4")
      && synthetic307kPerf.includes("Test-FullQualityRecovery")
      && synthetic307kPerf.includes("Test-FullInteractionGeometry")
      && synthetic307kPerf.includes("$wheelActiveState.interactionActive")
      && synthetic307kPerf.includes("ACTIVE_GEOMETRY_FULL")
      && synthetic307kPerf.includes("ACTIVE_DRAG")
      && synthetic307kPerf.includes("ACTIVE_WHEEL")
      && synthetic307kPerf.includes("FULL_QUALITY_RESTORED")
      && synthetic307kPerf.includes("Test-RenderSchedulerSnapshot")
      && synthetic307kPerf.includes("RENDER_SCHEDULER_CONSERVATION")
      && synthetic307kPerf.includes("start = $schedulerStart")
      && synthetic307kPerf.includes("mid = $schedulerMid")
      && synthetic307kPerf.includes("end = $schedulerEnd")
      && synthetic307kPerf.includes("scheduledCallbackDeltaConserved")
  ],
  [
    "interaction changes post-processing cost but never terrain geometry",
    html.includes("const USE_LEGACY_TERRAIN_INTERACTION_PROXY = false")
      && !html.includes('get("legacyTerrainInteractionProxy")')
      && /function\s+createTerrainInteractionProxyMesh\s*\(\)\s*\{\s*if\s*\(\s*!USE_LEGACY_TERRAIN_INTERACTION_PROXY/.test(html)
      && html.includes('mode: terrainInteractionProxyMesh?.visible ? "proxy" : "full"')
      && html.includes("fullVisible: Boolean(terrainBaseMesh?.visible)")
      && html.includes("legacyProxyEnabled: USE_LEGACY_TERRAIN_INTERACTION_PROXY")
      && !html.includes('rollbackQuery: "legacyTerrainInteractionProxy=1"')
  ],
  [
    "real-input performance BUG keeps phase-specific non-diluting Oracle",
    realInputPerformanceBug.includes("Active drag / wheel")
      && realInputPerformanceBug.includes("Full-quality recovery")
      && realInputPerformanceBug.includes("p99 ≤ 25 ms")
      && realInputPerformanceBug.includes("p99 ≤ 33.4 ms")
      && realInputPerformanceBug.includes("最大帧 ≤ 50 ms")
      && realInputPerformanceBug.includes("Long Task 大于 50 ms 的数量为 0")
      && realInputPerformanceBug.includes("不通过延长样本稀释尖峰")
  ],
  [
    "render scheduler has one requestAnimationFrame owner and conserved tail scheduling",
    (html.match(/function\s+scheduleRenderFrame\s*\(/g) || []).length === 1
      && (html.match(/requestAnimationFrame\s*\(\s*runRenderFrame\s*\)/g) || []).length === 1
      && /function\s+scheduleRenderFrame\s*\(\)\s*\{[\s\S]*?raf\s*=\s*requestAnimationFrame\s*\(\s*runRenderFrame\s*\)/.test(html)
      && Boolean(runRenderFrameMatch)
      && runRenderFrameBody.includes("scheduleRenderFrame();")
      && !/requestAnimationFrame\s*\(/.test(runRenderFrameBody)
  ],
  ["Rust GeoTIFF export is wired", bridge.includes('invoke("encode_geotiff"') && html.includes("coreApi.encodeGeoTiff")],
  ["Fluent frameless shell exists", html.includes('class="titlebar"') && html.includes('id="windowClose"')],
  ["Windows GUI subsystem hides the console window", tauriMain.includes('windows_subsystem = "windows"')],
  ["reference workspace composition exists", html.includes('class="viewport-expand"') && html.includes("viewport-focused")],
  ["resource panel has no duplicate import action", !html.includes('id="dropzone"') && !html.includes("添加 DEM 或影像")],
  ["duplicate header actions are absent", !html.includes('<header class="topbar">') && !html.includes('id="btnSavePreset"') && !html.includes('id="btnExport"')],
  ["workspace status and footer actions are absent", !html.includes('class="workspace-footer"') && !html.includes('id="runtimeStatus"') && !html.includes('id="fpsStatus"') && !html.includes('id="btnHelp"') && !html.includes('id="btnOpenInspector"')],
  ["panel save and export actions remain", html.includes('id="btnSavePresetPanel"') && html.includes('id="btnExportPanel"')],
  [
    "terrain inspector uses four task-led tabs",
    ["terrain", "appearance", "lighting", "export"].every((tab) => html.includes(`data-tab="${tab}"`))
      && !html.includes('data-tab="advanced"')
      && !html.includes('data-tab="visual"')
  ],
  [
    "quick styles are limited to three distinct intents",
    (html.match(/data-quick-preset=/g) || []).length === 3
      && html.includes('data-quick-preset="white"')
      && html.includes('data-quick-preset="clay"')
      && html.includes('data-quick-preset="relief"')
  ],
  [
    "fixed gypsum surface uses one complete studio lighting path",
    html.includes('const QUICK_LIGHTING_PRESET_KEYS = new Set(["white", "clay", "relief"])')
      && html.includes("LIGHTING_PRESET_SETTING_KEYS")
      && html.includes('new StudioLightingRig({')
      && lightingProfile.includes("WHITE_STUDIO_LIGHTING_PROFILE")
      && lightingProfile.includes("GYPSUM_LIGHTING_SCHEMES")
      && ["sculpting", "softness", "shadowLift", "valleyDepth", "microDetail", "floatDepth", "exposureBias"]
        .every((key) => lightingProfile.includes(`${key}:`))
      && lightingProfile.includes("deriveGypsumStudioLighting")
      && !lightingProfile.includes("stepAutoExposure")
      && studioLightingRig.includes("sunAzimuth: state.sunAzimuth")
      && studioLightingRig.includes("sunElevation: state.sunElevation")
      && terrainNormalLod.includes("computeTerrainNormalLod")
      && html.includes('? B.NeutralToneMapping')
      && html.includes('renderer.toneMappingExposure = Number(settings.exposure)')
      && !html.includes("sampleWhiteStudioLuminance")
      && babylonRuntime.includes("TONEMAPPING_KHR_PBR_NEUTRAL")
      && babylonRuntime.includes('const normalized = value === "neutral" ? "neutral" : "aces"')
      && babylonSceneKit.includes("return gammaColor.toLinearSpace(true)")
      && html.includes('const PERMANENT_GYPSUM_SURFACE = GYPSUM_SURFACE')
      && gypsumMaterialPolicy.includes('export const GYPSUM_SURFACE = Object.freeze({')
      && html.includes('surfaceMaterial: PERMANENT_GYPSUM_SURFACE.id')
      && html.includes('<strong><i></i>石膏</strong>')
      && gypsumMaterialPolicy.includes('whiteModel: true')
      && html.includes('const nextTerrainNormalTexture = null')
      && html.includes('const customTextureActive = false')
      && !html.includes('new B.RectAreaLight')
      && !html.includes('new B.HemisphereLight')
      && html.includes('keyLight: sunLight')
      && html.includes('emissive: gypsum.emissive')
      && gypsumMaterialPolicy.includes('emissive: 0x000000')
      && gypsumMaterialPolicy.includes('environmentIntensity: 1')
      && gypsumMaterialPolicy.includes('vertexColors: false')
      && babylonSceneKit.includes('material.userData.useVertexColors')
      && html.includes('roughness: gypsum.roughness')
      && html.includes('setEnhancedUniform(gl, program, "uGrainEnabled", "uniform1i", 0)')
      && html.includes('setEnhancedUniform(gl, program, "uHasCustomTexture", "uniform1i", 0)')
      && html.includes('sunLight = new B.DirectionalLight(0xfffdf8, 1)')
      && html.includes('sources: ["directional-key", "environment-diffuse-irradiance"]')
      && html.includes('"dem-gradient-multiscale"')
      && html.includes("function materialModeLabel(mode)")
      && html.includes('button.dataset.quickPreset === activeFamily')
  ],
  [
    "studio environment, floor, fixed exposure, fitted shadow, and real SSAO2 are wired",
    studioEnvironment.includes("STUDIO_ENVIRONMENT_FACE_SIZE = 32")
      && studioEnvironment.includes("createStudioEnvironmentCube")
      && babylonRuntime.includes("updateStudioEnvironment")
      && studioShadowFrustum.includes("fitDirectionalShadowFrustum")
      && studioLightingRig.includes("fitDirectionalShadowFrustum")
      && html.includes('data-key="studioFloorEnabled"')
      && html.includes('data-key="studioFloorColor"')
      && html.includes("function createStudioFloor")
      && html.includes("studioFloor.receiveShadow = true")
      && html.includes("aoEnabled: Boolean(settings.aoEnabled)")
      && !html.includes("gtaoPass.enabled = !whiteStudio")
      && lightingControlsBug.includes("terrainBuildGeneration")
      && lightingControlsBug.includes("SSAO2RenderingPipeline")
  ],
  [
    "SSAO contact occlusion uses bounded contrast and explicit bilateral calibration",
    lightingProfile.includes("mapContactOcclusionStrength")
      && lightingProfile.includes("diagonal * 0.035")
      && html.includes("contactOcclusionStrength")
      && realtimePostProcessPolicy.includes("bilateralSoften")
      && realtimePostProcessPolicy.includes("bilateralTolerance")
      && babylonRuntime.includes("this.ssaoPipeline.base = resolved.aoBase")
      && babylonRuntime.includes("this.ssaoPipeline.epsilon = resolved.aoEpsilon")
      && babylonRuntime.includes("this.ssaoPipeline.bilateralSamples = resolved.bilateralSamples")
      && contactOcclusionBug.includes("0.8%–3.5%")
      && contactOcclusionBug.includes("WebGPU")
      && contactOcclusionBug.includes("WebGL2")
  ],
  [
    "Babylon render pipeline includes backend fallback, PBR, PCSS, SSAO2, TAA, and dual shader languages",
    babylonRuntime.includes("new WebGPUEngine")
      && babylonRuntime.includes("await webgpu.initAsync(")
      && babylonRuntime.includes("new Engine(")
      && babylonRuntime.includes("webGLVersion")
      && babylonRuntime.includes("scene.useRightHandedSystem = true")
      && babylonRuntime.includes("new ArcRotateCamera")
      && babylonRuntime.includes("new ShadowGenerator")
      && babylonRuntime.includes("useContactHardeningShadow = true")
      && babylonRuntime.includes("new SSAO2RenderingPipeline")
      && babylonRuntime.includes("new DefaultRenderingPipeline")
      && babylonRuntime.includes("new TAARenderingPipeline")
      && babylonSceneKit.includes("class MeshStandardMaterial extends PBRMaterial")
      && babylonSceneKit.includes("material.twoSidedLighting = Boolean(options.twoSidedLighting)")
      && babylonSceneKit.includes("new VertexData()")
      && babylonMaterialPlugin.includes("ShaderLanguage.GLSL")
      && babylonMaterialPlugin.includes("ShaderLanguage.WGSL")
      && !babylonMaterialPlugin.includes("finalColor.rgb *= demVisibility")
      && babylonMaterialPlugin.includes("demRelightGain")
      && html.includes("createTerrainDetailNormalTexture")
      && html.includes("terrainNormalTexture = null")
      && html.includes("const focusNormalTexture = null")
      && html.includes("compositeRenderCanvas")
  ],
  [
    "gypsum black-frame regression has unit, lifecycle, and dual-backend runtime gates",
    gypsumMaterialPolicy.includes("classifyTerrainAppearance")
      && gypsumMaterialPolicy.includes("shouldUseCompatibilityPlanarShadow")
      && html.includes("studioSoftShadowFallbackTexture")
      && html.includes("terrainCommittedGeneration = generation")
      && runtimeSmoke.includes("[switch]$SyntheticDemo")
      && runtimeSmoke.includes("[switch]$PresetRoundTripProbe")
      && runtimeSmoke.includes("PRESET_ROUND_TRIP=")
      && gypsumBlackFrameBug.includes("white → clay → relief → white → relief")
      && codeAudit.includes("H1 WebGPU 资源绑定非法")
  ],
  [
    "camera interaction keeps Babylon post-process attachments and terrain geometry stable",
    html.includes("msaaSamples: 4")
      && html.includes("studioLightingQualityTarget = 1")
      && !html.includes("msaaSamples: renderInteractionActive ? 1 : 4")
      && babylonRuntime.includes("resolveRealtimePostProcessState")
      && babylonRuntime.includes("_postProcessTopologyChangeCount")
      && !babylonRuntime.includes("state.interactionActive\n        ? 1")
      && !babylonRuntime.includes("!state.interactionActive && Boolean(state.bloomEnabled)")
      && babylonRuntime.includes("this.defaultPipeline = new DefaultRenderingPipeline")
      && html.includes("if (renderInteractionActive || controlsChanged")
      && html.includes("const USE_LEGACY_TERRAIN_INTERACTION_PROXY = false;")
  ],
  [
    "Babylon camera input and terrain settings have live runtime effects",
    babylonRuntime.includes('camera.inputs.removeByType("ArcRotateCameraPointersInput")')
      && babylonRuntime.includes('camera.inputs.removeByType("ArcRotateCameraMouseWheelInput")')
      && babylonRuntime.includes('canvas.addEventListener("pointermove", this._pointerMove')
      && babylonRuntime.includes('canvas.addEventListener("wheel", this._wheel')
      && babylonRuntime.includes("this.object.alpha -= deltaX / sensitivityX")
      && babylonRuntime.includes("this.object.target.addInPlace(right).addInPlace(up)")
      && html.includes("function createAdjustedCustomTextureCanvas")
      && html.includes("function refreshCustomTextureAppearance")
      && html.includes('"aoEnabled", "aoStrength",')
      && /setView\("iso"\);[\s\S]{0,500}?setupComposer\(\);/.test(html)
      && runtimeSmoke.includes("[switch]$CameraControlProbe")
      && runtimeSmoke.includes("[switch]$TerrainSettingsProbe")
      && runtimeSmoke.includes("[switch]$VisualAppearanceProbe")
      && runtimeSmoke.includes("Babylon real rotate, pan, and wheel camera input probe failed")
      && runtimeSmoke.includes('$cameraAfterWheel.orthoHeight')
      && babylonRuntime.includes("orthoHeight: this.camera.mode === Camera.ORTHOGRAPHIC_CAMERA")
      && runtimeSmoke.includes("Babylon terrain setting runtime effect probe failed")
      && runtimeSmoke.includes("White visual appearance is gray, clipped, flat, or semantically mislabeled")
      && runtimeSmoke.includes("Natural gypsum appearance is dark, clipped, flat, or semantically mislabeled")
      && runtimeSmoke.includes('([string]$appearance.surfaceMaterial -eq "gypsum")')
      && runtimeSmoke.includes("([double]$appearance.luminanceP10 -ge 0.55)")
      && runtimeSmoke.includes("([double]$appearance.luminanceP50 -ge 0.80)")
      && runtimeSmoke.includes("([double]$appearance.luminanceP90 -ge 0.82)")
      && runtimeSmoke.includes("([double]$appearance.luminanceP50 -ge 0.22)")
      && babylonVisualSemanticBug.includes("sRGB 到线性空间")
      && babylonVisualSemanticBug.includes("真实画布像素")
  ],
  [
    "terrain quality exposes five bounded adaptive LOD profiles",
    html.includes('<option value="2048">超清 · 2048</option>')
      && html.includes('<option value="4096">极致 · 4096</option>')
      && /2048:\s*Object\.freeze\(\{[\s\S]*?maxLevel:\s*4[\s\S]*?settledMaxTiles:\s*96/.test(html)
      && /4096:\s*Object\.freeze\(\{[\s\S]*?maxLevel:\s*5[\s\S]*?settledMaxTiles:\s*128/.test(html)
      && html.includes("terrainTileRefinementPriority(")
      && html.includes("const focusBoost = 1 + 3 /")
      && html.includes('targetMaxDimension: Number(settings.resolution)')
      && html.includes('activeVertexCount')
      && html.includes('readyDesiredVertexCount')
      && html.includes('desiredRefinementLevelHistogram')
      && html.includes('gpuBudgetBytes: TERRAIN_TILE_GPU_BUDGET_BYTES')
      && html.includes('const TERRAIN_TILE_MAX_CONCURRENT_REQUESTS = 2')
      && html.includes('setTerrainResolution(resolution)')
      && runtimeSmoke.includes('[int]$ExpectedLodTargetDimension = 0')
      && runtimeSmoke.includes('readyDesiredVertexCount -gt $focusState.sampledLength')
  ],
  [
    "Babylon camera notifications ignore view-matrix recomputation feedback",
    babylonRuntime.includes("function updateCameraState(camera, target)")
      && babylonRuntime.includes("new Float64Array(11)")
      && babylonRuntime.includes("if (!updateCameraState(camera, this._lastCameraState)) return;")
      && !babylonRuntime.includes("cameraSignature")
      && html.includes('terrainTileRequestQueue.sort((left, right) => {')
      && html.includes('if (terrainResidency.baseComplete) {')
      && babylonCameraFeedbackBug.includes("矩阵计算通知")
      && babylonCameraFeedbackBug.includes("terrainBuildGeneration")
  ],
  [
    "base-level transitions have an ownership signature and permanent BUG record",
    html.includes("function terrainBaseLifecycleSignature(baseLevel)")
      && html.includes("clearTerrainResourcesForBaseLevelChange()")
      && terrainResidency.includes("canAdoptCompatibleBase(previous)")
      && terrainResidency.includes("previous.baseSignature === this.baseSignature")
      && baseTransitionBug.includes("baseSignature")
      && baseTransitionBug.includes("L2→L3")
  ],
  [
    "Release Harness proves refinement residency survives a real camera round trip",
    html.includes("probeRefinementCacheReturn(")
      && html.includes("desiredRefinementKeys")
      && html.includes("residentRefinementKeys")
      && html.includes("returnedIdsStable")
      && html.includes("after.refinementSamples === away.refinementSamples")
      && html.includes("after.refinementBuilds === away.refinementBuilds")
      && html.includes("after.refinementUploads === away.refinementUploads")
      && runtimeSmoke.includes("[switch]$RefinementCacheProbe")
      && runtimeSmoke.includes("REFINEMENT_CACHE_RETURN=")
      && realTifHarness.includes('if ($qualityCase.Dimension -gt 1024)')
      && realTifHarness.includes('$runtimeArguments += "-RefinementCacheProbe"')
  ],
  [
    "15-minute interaction Harness requires viewport churn and bounded memory trend",
    html.includes("interactionViewportChangeCount: viewportChangeCount")
      && html.includes("const keepInteractionActive = Boolean(options?.keepInteractionActive)")
      && html.includes("await new Promise(resolve => {")
      && html.includes("requestAnimationFrame(sampleFrame)")
      && !html.includes("await new Promise(resolve => requestAnimationFrame(resolve))")
      && runtimeSmoke.includes("[switch]$MemoryTrendProbe")
      && runtimeSmoke.includes("{ keepInteractionActive: $keepInteractionActiveJson }")
      && runtimeSmoke.includes("MEMORY_TREND=")
      && runtimeSmoke.includes("$FrameSampleMilliseconds -lt 900000")
      && runtimeSmoke.includes("$interactionViewportChangeCount -ge $MinimumViewportChanges")
      && runtimeSmoke.includes("$steadyGrowthBytes -le $allowedSteadyGrowthBytes")
      && realTifHarness.includes("[switch]$Soak1024")
      && realTifHarness.includes("if ($soakProbe)")
      && realTifHarness.includes('$runtimeArguments += "-MemoryTrendProbe"')
      && realTifHarness.includes(
        "$frameSampleMilliseconds = if ($soakProbe) { 900000 } else { 60000 }"
      )
      && interactionHarnessAllocationBug.includes("一个 Promise")
      && interactionHarnessAllocationBug.includes("不得把 50 ms 改大")
  ],
  [
    "cinematic export uses Babylon high-quality raster with 32-frame TAA and bounded MSAA",
    html.includes("new RenderTargetTexture")
      && html.includes("cinematicTarget.render(true, false)")
      && html.includes("cinematicTarget.readPixels")
      && html.includes("const accumulationFrames = 32")
      && html.includes("renderRuntime.createTaaPipeline")
      && html.includes('renderer: "babylon-high-quality-raster"')
      && html.includes("msaaSamples")
      && !html.includes("three-gpu-pathtracer")
      && !/\bspp\b/i.test(html)
      && html.includes('id="btnCinematicRender"')
  ],
  [
    "redundant preset and camera controls are absent from inspector",
    !html.includes('id="btnApplyPreset"')
      && !/<select[^>]+data-key=["']cameraMode["']/i.test(html)
  ],
  [
    "niche post effects and GeoTIFF expert controls are removed from primary UI",
    !/<input[^>]+data-key=["'](?:bloomEnabled|dofEnabled|bakeLighting)["']/i.test(html)
      && !html.includes('id="enhancedExportControls"')
  ],
  [
    "conditional lighting inspector controls exist",
    html.includes('id="directShadowControls"')
      && html.includes('id="aoStrengthControl"')
      && html.includes('id="fogControls"')
      && html.includes("updateInspectorControlsUI")
  ],
  ["transparent titlebar has no retained blur", /[.]titlebar\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;/s.test(html)],
  ["window controls are three circular buttons", (html.match(/class="caption-button(?: close)?"/g) || []).length === 3 && html.includes("border-radius: 50%")],
  ["browser dialogs and file inputs are absent", !/<input[^>]+type=["']file["']/i.test(html) && !/\b(?:alert|confirm|prompt)\s*\(/.test(html)],
  [
    "in-app dialog system exists and hidden actions stay hidden",
    html.includes('id="appDialogLayer"')
      && html.includes("showAppDialog")
      && /\.app-dialog-actions\s+\.btn\[hidden\]\s*\{\s*display:\s*none/.test(html)
  ],
  [
    "recent files can reopen source paths without silent first-click loss",
    bridge.includes("openDemPath")
      && html.includes("openRecentFile")
      && html.includes("companionPaths")
      && html.includes("normalizeRecentFiles")
      && html.includes('el.recentList?.addEventListener("click"')
      && html.includes("String(row.id) === String(button.dataset.recentId)")
      && html.includes('toast("正在导入，请稍候")')
  ],
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
