import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import glslangJsUrl from "@babylonjs/core/assets/glslang/glslang.js?url";
import glslangWasmUrl from "@babylonjs/core/assets/glslang/glslang.wasm?url";
import twgslJsUrl from "@babylonjs/core/assets/twgsl/twgsl.js?url";
import twgslWasmUrl from "@babylonjs/core/assets/twgsl/twgsl.wasm?url";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import {
  ImageProcessingConfiguration,
} from "@babylonjs/core/Materials/imageProcessingConfiguration.js";
import { RawCubeTexture } from "@babylonjs/core/Materials/Textures/rawCubeTexture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import {
  CubeMapToSphericalPolynomialTools,
} from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial.js";
import {
  DefaultRenderingPipeline,
} from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js";
import {
  SSAO2RenderingPipeline,
} from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js";
import {
  TAARenderingPipeline,
} from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline.js";
import { Scene } from "@babylonjs/core/scene.js";
import {
  realtimePostProcessTopology,
  resolveRealtimePostProcessState,
} from "./realtime-postprocess-policy.js";
import {
  Engine,
  WebGPUEngine,
} from "./babylon-engine-registration.js";
import {
  createStudioEnvironmentCube,
  STUDIO_ENVIRONMENT_FACE_SIZE,
} from "../studio-environment.js";

const BACKEND_WEBGPU = "webgpu";
const BACKEND_WEBGL2 = "webgl2";
export function createLocalPbrEnvironment(scene, options = {}) {
  const cube = createStudioEnvironmentCube({
    size: STUDIO_ENVIRONMENT_FACE_SIZE,
    floorColor: options.floorColor,
  });
  const texture = new RawCubeTexture(
    scene,
    [cube.right, cube.left, cube.up, cube.down, cube.front, cube.back],
    cube.size,
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    true,
    false,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
  );
  texture.name = "dem-studio-diffuse-irradiance-environment";
  texture.gammaSpace = true;
  texture.sphericalPolynomial =
    CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
      ...cube,
      format: Constants.TEXTUREFORMAT_RGBA,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      gammaSpace: true,
    });
  return texture;
}

function stringifyFailure(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return error.stack || error.message || String(error);
}

function requestedBackendFromLocation() {
  const requested = (
    new URLSearchParams(globalThis.location?.search || "").get("renderBackend")
    || globalThis.sessionStorage?.getItem?.("dem-studio-render-backend")
    || ""
  ).toLowerCase();
  if (requested === BACKEND_WEBGL2 || requested === BACKEND_WEBGPU) {
    return requested;
  }
  return BACKEND_WEBGPU;
}

function shouldForceWebGpuInitFailure() {
  return globalThis.sessionStorage?.getItem?.(
    "dem-studio-force-webgpu-init-failure",
  ) === "true";
}

function createCanvas(container) {
  const canvas = document.createElement("canvas");
  canvas.className = "babylon-render-surface";
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  container.appendChild(canvas);
  return canvas;
}

async function createEngine(canvas, requestedBackend) {
  let fallbackReason = "";
  if (requestedBackend !== BACKEND_WEBGL2) {
    try {
      if (shouldForceWebGpuInitFailure()) {
        throw new Error("Harness injected WebGPU initialization failure");
      }
      const supported = await WebGPUEngine.IsSupportedAsync;
      if (!supported) throw new Error("当前设备或 WebView 不支持 WebGPU");
      const webgpu = new WebGPUEngine(canvas, {
        antialias: true,
        adaptToDeviceRatio: false,
        powerPreference: "high-performance",
      });
      await webgpu.initAsync(
        {
          jsPath: glslangJsUrl,
          wasmPath: glslangWasmUrl,
        },
        {
          jsPath: twgslJsUrl,
          wasmPath: twgslWasmUrl,
        },
      );
      return {
        engine: webgpu,
        backend: BACKEND_WEBGPU,
        requestedBackend,
        fallbackReason,
      };
    } catch (error) {
      fallbackReason = stringifyFailure(error);
      console.warn("Babylon WebGPU 初始化失败，回退 WebGL2", error);
    }
  }

  const engine = new Engine(
    canvas,
    true,
    {
      alpha: true,
      antialias: true,
      audioEngine: false,
      depth: true,
      disableWebGL2Support: false,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "high-performance",
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: true,
    },
    true,
  );
  const version = Number(engine.webGLVersion || 0);
  if (version < 2) {
    engine.dispose();
    throw new Error(`Babylon WebGL2 初始化失败：实际 WebGL ${version || "未知"}`);
  }
  return {
    engine,
    backend: BACKEND_WEBGL2,
    requestedBackend,
    fallbackReason,
  };
}

function writeCameraState(camera, target = new Float64Array(11)) {
  target[0] = Number(camera.alpha) || 0;
  target[1] = Number(camera.beta) || 0;
  target[2] = Number(camera.radius) || 0;
  target[3] = Number(camera.target.x) || 0;
  target[4] = Number(camera.target.y) || 0;
  target[5] = Number(camera.target.z) || 0;
  target[6] = Number(camera.mode) || 0;
  target[7] = Number(camera.orthoLeft) || 0;
  target[8] = Number(camera.orthoRight) || 0;
  target[9] = Number(camera.orthoTop) || 0;
  target[10] = Number(camera.orthoBottom) || 0;
  return target;
}

function updateCameraState(camera, target) {
  const alpha = Number(camera.alpha) || 0;
  const beta = Number(camera.beta) || 0;
  const radius = Number(camera.radius) || 0;
  const targetX = Number(camera.target.x) || 0;
  const targetY = Number(camera.target.y) || 0;
  const targetZ = Number(camera.target.z) || 0;
  const mode = Number(camera.mode) || 0;
  const orthoLeft = Number(camera.orthoLeft) || 0;
  const orthoRight = Number(camera.orthoRight) || 0;
  const orthoTop = Number(camera.orthoTop) || 0;
  const orthoBottom = Number(camera.orthoBottom) || 0;
  const changed =
    Math.abs(alpha - target[0]) > 1e-7
    || Math.abs(beta - target[1]) > 1e-7
    || Math.abs(radius - target[2]) > 1e-7
    || Math.abs(targetX - target[3]) > 1e-7
    || Math.abs(targetY - target[4]) > 1e-7
    || Math.abs(targetZ - target[5]) > 1e-7
    || Math.abs(mode - target[6]) > 1e-7
    || Math.abs(orthoLeft - target[7]) > 1e-7
    || Math.abs(orthoRight - target[8]) > 1e-7
    || Math.abs(orthoTop - target[9]) > 1e-7
    || Math.abs(orthoBottom - target[10]) > 1e-7;
  target[0] = alpha;
  target[1] = beta;
  target[2] = radius;
  target[3] = targetX;
  target[4] = targetY;
  target[5] = targetZ;
  target[6] = mode;
  target[7] = orthoLeft;
  target[8] = orthoRight;
  target[9] = orthoTop;
  target[10] = orthoBottom;
  return changed;
}

class ArcRotateControlsFacade {
  constructor(camera, canvas, runtime) {
    this.object = camera;
    this.domElement = canvas;
    this.runtime = runtime;
    this.enableDamping = true;
    this.screenSpacePanning = false;
    this._listeners = new Map();
    this._lastCameraState = writeCameraState(camera);
    this._interactionDepth = 0;
    this._wheelEndTimer = null;
    this.inputEventCounts = {
      pointerdown: 0,
      pointermove: 0,
      pointerup: 0,
      wheel: 0,
    };
    this._activePointer = null;
    this._pointerDown = event => {
      this.inputEventCounts.pointerdown++;
      this._activePointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        pan: event.button === 2 || (event.button === 0 && event.ctrlKey),
      };
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can be unavailable for synthetic or interrupted input.
      }
      this.#start();
    };
    this._pointerMove = event => {
      const active = this._activePointer;
      if (!active || active.id !== event.pointerId) return;
      this.inputEventCounts.pointermove++;
      const deltaX = event.clientX - active.x;
      const deltaY = event.clientY - active.y;
      active.x = event.clientX;
      active.y = event.clientY;
      if (!deltaX && !deltaY) return;

      if (active.pan) {
        const scale = Math.max(0.0001, this.object.radius) / 1400;
        const right = this.object.getDirection(Vector3.Right()).scaleInPlace(
          -deltaX * scale,
        );
        const up = this.object.getDirection(Vector3.Up()).scaleInPlace(
          deltaY * scale,
        );
        this.object.target.addInPlace(right).addInPlace(up);
      } else {
        const sensitivityX = Math.max(
          1,
          Number(this.object.angularSensibilityX) || 1000,
        );
        const sensitivityY = Math.max(
          1,
          Number(this.object.angularSensibilityY) || 1000,
        );
        this.object.alpha -= deltaX / sensitivityX;
        this.object.beta -= deltaY / sensitivityY;
        this.object.beta = Math.max(
          this.object.lowerBetaLimit ?? 0.01,
          Math.min(this.object.upperBetaLimit ?? Math.PI - 0.01, this.object.beta),
        );
      }
      this.#changed();
    };
    this._pointerUp = event => {
      if (
        this._activePointer
        && event?.pointerId != null
        && event.pointerId !== this._activePointer.id
      ) {
        return;
      }
      this.inputEventCounts.pointerup++;
      this._activePointer = null;
      this.#end();
    };
    this._wheel = event => {
      this.inputEventCounts.wheel++;
      if (this._interactionDepth === 0) this.#start();
      const factor = Math.exp(-Number(event.deltaY || 0) * 0.0015);
      if (this.object.mode === Camera.ORTHOGRAPHIC_CAMERA) {
        this.object.metadata.zoom = Math.max(
          0.05,
          Math.min(20, Number(this.object.metadata.zoom || 1) * factor),
        );
        this.runtime.updateCameraProjection();
      } else {
        const minimum = Number(this.object.lowerRadiusLimit) || 0.01;
        const maximum = Number(this.object.upperRadiusLimit) || Number.MAX_VALUE;
        this.object.radius = Math.max(
          minimum,
          Math.min(maximum, this.object.radius / factor),
        );
      }
      this.#changed();
      clearTimeout(this._wheelEndTimer);
      this._wheelEndTimer = setTimeout(() => this.#end(), 140);
    };
    this._contextMenu = event => event.preventDefault();
    canvas.addEventListener("pointerdown", this._pointerDown, { passive: true });
    canvas.addEventListener("pointermove", this._pointerMove, { passive: true });
    canvas.addEventListener("wheel", this._wheel, { passive: true });
    canvas.addEventListener("contextmenu", this._contextMenu);
    globalThis.addEventListener("pointerup", this._pointerUp, { passive: true });
    globalThis.addEventListener("pointercancel", this._pointerUp, { passive: true });
    this._observer = camera.onViewMatrixChangedObservable.add(() => {
      if (!updateCameraState(camera, this._lastCameraState)) return;
      this.#emit("change");
    });
  }

  get target() {
    return this.object.target;
  }

  set target(value) {
    this.object.setTarget(value);
  }

  get dampingFactor() {
    return 1 - this.object.inertia;
  }

  set dampingFactor(value) {
    this.object.inertia = Math.max(0, Math.min(0.99, 1 - Number(value)));
  }

  get minDistance() {
    return this.object.lowerRadiusLimit;
  }

  set minDistance(value) {
    this.object.lowerRadiusLimit = Number(value);
  }

  get maxDistance() {
    return this.object.upperRadiusLimit;
  }

  set maxDistance(value) {
    this.object.upperRadiusLimit = Number(value);
  }

  addEventListener(type, callback) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this._listeners.get(type)?.delete(callback);
  }

  update() {
    return updateCameraState(this.object, this._lastCameraState);
  }

  dispose() {
    clearTimeout(this._wheelEndTimer);
    this.domElement.removeEventListener("pointerdown", this._pointerDown);
    this.domElement.removeEventListener("pointermove", this._pointerMove);
    this.domElement.removeEventListener("wheel", this._wheel);
    this.domElement.removeEventListener("contextmenu", this._contextMenu);
    globalThis.removeEventListener("pointerup", this._pointerUp);
    globalThis.removeEventListener("pointercancel", this._pointerUp);
    this.object.onViewMatrixChangedObservable.remove(this._observer);
    this._listeners.clear();
  }

  #emit(type) {
    for (const callback of this._listeners.get(type) || []) {
      callback({ type, target: this });
    }
  }

  #changed() {
    writeCameraState(this.object, this._lastCameraState);
    this.#emit("change");
  }

  #start() {
    this._interactionDepth++;
    if (this._interactionDepth === 1) this.#emit("start");
  }

  #end() {
    if (this._interactionDepth <= 0) return;
    this._interactionDepth = 0;
    this.#emit("end");
  }
}

class RendererFacade {
  constructor(runtime) {
    this.runtime = runtime;
    this.domElement = runtime.canvas;
    this._pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    this._clearColor = new Color4(0, 0, 0, 0);
    this.shadowMap = {
      enabled: true,
      type: "PCSS",
      autoUpdate: false,
      needsUpdate: true,
    };
    this.capabilities = {
      maxTextureSize: runtime.engine.getCaps().maxTextureSize,
      getMaxAnisotropy: () => runtime.engine.getCaps().maxAnisotropy || 1,
    };
    this.info = {
      render: {
        calls: 0,
        triangles: 0,
      },
    };
    this.outputColorSpace = "srgb";
    this._toneMapping = "aces";
    this.toneMapping = "aces";
    this.setPixelRatio(this._pixelRatio);
  }

  get toneMapping() {
    return this._toneMapping;
  }

  set toneMapping(value) {
    const normalized = value === "neutral" ? "neutral" : "aces";
    this._toneMapping = normalized;
    this.runtime.scene.imageProcessingConfiguration.toneMappingType =
      normalized === "neutral"
        ? ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL
        : ImageProcessingConfiguration.TONEMAPPING_ACES;
  }

  get toneMappingExposure() {
    return this.runtime.scene.imageProcessingConfiguration.exposure;
  }

  set toneMappingExposure(value) {
    this.runtime.scene.imageProcessingConfiguration.exposure = Number(value) || 1;
  }

  setPixelRatio(value) {
    this._pixelRatio = Math.max(0.25, Math.min(4, Number(value) || 1));
    this.runtime.engine.setHardwareScalingLevel(1 / this._pixelRatio);
  }

  getPixelRatio() {
    return this._pixelRatio;
  }

  setSize(width, height, updateStyle = false) {
    const safeWidth = Math.max(2, Math.floor(Number(width) || 2));
    const safeHeight = Math.max(2, Math.floor(Number(height) || 2));
    if (updateStyle) {
      this.domElement.style.width = `${safeWidth}px`;
      this.domElement.style.height = `${safeHeight}px`;
    }
    this.runtime.engine.setSize(safeWidth, safeHeight);
  }

  getSize(target = { x: 0, y: 0 }) {
    target.x = this.runtime.engine.getRenderWidth();
    target.y = this.runtime.engine.getRenderHeight();
    return target;
  }

  getDrawingBufferSize(target = { x: 0, y: 0 }) {
    return this.getSize(target);
  }

  setClearColor(color, alpha = 1) {
    const color3 = typeof color === "number"
      ? Color3.FromHexString(`#${color.toString(16).padStart(6, "0")}`)
      : (color?.r != null ? color : Color3.Black());
    this._clearColor = new Color4(color3.r, color3.g, color3.b, alpha);
    this.runtime.scene.clearColor = this._clearColor;
  }

  clear() {
    this.runtime.engine.clear(this._clearColor, true, true, true);
  }

  render(scene, camera) {
    if (camera) scene.activeCamera = camera;
    this.runtime.engine.beginFrame();
    try {
      scene.render(false, false);
    } finally {
      this.runtime.engine.endFrame();
    }
    this.info.render.calls = scene.getActiveMeshes().length;
    this.info.render.triangles = scene.getActiveIndices() / 3;
    this.shadowMap.needsUpdate = false;
  }

  setRenderTarget() {
    // Offscreen rendering is handled through Babylon render targets.
  }
}

export class BabylonRenderRuntime {
  constructor(container, canvas, engineState) {
    this.container = container;
    this.canvas = canvas;
    this.engine = engineState.engine;
    this.backend = engineState.backend;
    this.requestedBackend = engineState.requestedBackend;
    this.fallbackReason = engineState.fallbackReason;
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.imageProcessingConfiguration.isEnabled = true;
    this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    this.scene.imageProcessingConfiguration.toneMappingType =
      ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.scene.imageProcessingConfiguration.exposure = 1.08;
    this.scene.imageProcessingConfiguration.contrast = 1.02;
    this.scene.environmentIntensity = 0.52;
    this.scene.environmentTexture = createLocalPbrEnvironment(this.scene);
    this._environmentFloorColor = "#d3dbe5";
    this.scene.add = node => {
      if (node && "setEnabled" in node) node.setEnabled(true);
      return node;
    };
    this.scene.remove = node => {
      if (node && "parent" in node) node.parent = null;
      if (node && "setEnabled" in node) node.setEnabled(false);
      return node;
    };
    this.renderer = new RendererFacade(this);
    this.camera = null;
    this.controls = null;
    this.defaultPipeline = null;
    this.ssaoPipeline = null;
    this.taaPipeline = null;
    this.shadowGenerator = null;
    this.sunLight = null;
    this._postProcessState = {};
    this._postProcessSignature = "";
    this._postProcessTopologySignature = "";
    this._postProcessConfigurationCount = 0;
    this._postProcessTopologyChangeCount = 0;
    this._disposed = false;
    this.contextLossCount = 0;
    this.contextRestoreCount = 0;
    this.effectErrors = [];
    this._effectErrorObserver = this.engine.onEffectErrorObservable?.add?.(
      ({ effect, errors }) => {
        this.effectErrors.push({
          name: effect?.name || null,
          errors: String(
            errors || effect?.getCompilationError?.() || "unknown shader error",
          ),
        });
        if (this.effectErrors.length > 8) this.effectErrors.shift();
      },
    ) || null;
    this._contextLostObserver = this.engine.onContextLostObservable?.add?.(() => {
      this.contextLossCount++;
      console.error("Babylon 渲染上下文丢失", {
        backend: this.backend,
        count: this.contextLossCount,
      });
    }) || null;
    this._contextRestoredObserver = this.engine.onContextRestoredObservable?.add?.(() => {
      this.contextRestoreCount++;
      console.warn("Babylon 渲染上下文已恢复", {
        backend: this.backend,
        count: this.contextRestoreCount,
      });
    }) || null;
  }

  static async create(container, options = {}) {
    if (!container) throw new Error("Babylon 渲染容器不存在");
    const canvas = createCanvas(container);
    const requestedBackend = options.requestedBackend
      || requestedBackendFromLocation();
    try {
      const engineState = await createEngine(canvas, requestedBackend);
      const runtime = new BabylonRenderRuntime(container, canvas, engineState);
      runtime.resize();
      runtime.createCamera("perspective");
      console.info("DEM Studio Babylon renderer", runtime.getDiagnostics());
      return runtime;
    } catch (error) {
      canvas.remove();
      throw error;
    }
  }

  createCamera(mode = "perspective", state = {}) {
    const previous = this.camera;
    const position = state.position?.clone?.()
      || previous?.position?.clone?.()
      || new Vector3(4.2, 3.2, 4.2);
    const target = state.target?.clone?.()
      || previous?.target?.clone?.()
      || new Vector3(0, 0.25, 0);
    const camera = new ArcRotateCamera(
      "dem-studio-camera",
      Math.PI / 4,
      Math.PI / 3,
      7,
      target,
      this.scene,
    );
    camera.inertia = 0.925;
    camera.panningInertia = 0.82;
    camera.panningSensibility = 720;
    camera.wheelDeltaPercentage = 0.025;
    camera.lowerRadiusLimit = 2.4;
    camera.upperRadiusLimit = 18;
    camera.minZ = 0.01;
    camera.maxZ = 1000;
    camera.fov = 42 * Math.PI / 180;
    camera.position = position;
    camera.setTarget(target);
    camera.mode = mode === "orthographic"
      ? Camera.ORTHOGRAPHIC_CAMERA
      : Camera.PERSPECTIVE_CAMERA;
    camera.metadata = {
      ...(previous?.metadata || {}),
      cameraMode: mode === "orthographic" ? "orthographic" : "perspective",
      orthoSize: Number(previous?.metadata?.orthoSize || 6.2),
      zoom: Number(state.zoom || previous?.metadata?.zoom || 1),
    };
    camera.attachControl(this.canvas, true, true);
    // Babylon 9's pointer input is attached through the scene input manager.
    // The studio owns an on-demand frame scheduler, so mouse gestures are
    // handled by the facade and applied directly to this ArcRotateCamera.
    camera.inputs.removeByType("ArcRotateCameraPointersInput");
    camera.inputs.removeByType("ArcRotateCameraMouseWheelInput");
    this.controls?.dispose();
    this.controls = new ArcRotateControlsFacade(camera, this.canvas, this);
    this.camera = camera;
    this.scene.activeCamera = camera;
    if (previous) {
      previous.detachControl();
      previous.dispose();
    }
    this.updateCameraProjection();
    this.rebuildPostProcessing(this._postProcessState);
    return camera;
  }

  updateCameraProjection(width, height) {
    const camera = this.camera;
    if (!camera) return;
    const safeWidth = Math.max(2, Number(width) || this.engine.getRenderWidth());
    const safeHeight = Math.max(2, Number(height) || this.engine.getRenderHeight());
    const aspect = safeWidth / safeHeight;
    const zoom = Math.max(0.01, Number(camera.metadata?.zoom) || 1);
    if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
      const size = Math.max(0.01, Number(camera.metadata?.orthoSize) || 6.2) / zoom;
      camera.orthoLeft = -size * aspect / 2;
      camera.orthoRight = size * aspect / 2;
      camera.orthoTop = size / 2;
      camera.orthoBottom = -size / 2;
    }
    camera.getProjectionMatrix(true);
  }

  setCameraMode(mode) {
    const safeMode = mode === "orthographic" ? "orthographic" : "perspective";
    if (!this.camera) return this.createCamera(safeMode);
    this.camera.mode = safeMode === "orthographic"
      ? Camera.ORTHOGRAPHIC_CAMERA
      : Camera.PERSPECTIVE_CAMERA;
    this.camera.metadata.cameraMode = safeMode;
    this.updateCameraProjection();
    return this.camera;
  }

  attachShadowLight(light, options = {}) {
    this.shadowGenerator?.dispose();
    this.sunLight = light;
    const mapSize = Math.max(512, Math.min(4096, Number(options.mapSize) || 2048));
    this.shadowGenerator = new ShadowGenerator(mapSize, light, true);
    this.shadowGenerator.useContactHardeningShadow = true;
    this.shadowGenerator.contactHardeningLightSizeUVRatio = Math.max(
      0.005,
      Number(options.lightSizeRatio) || 0.035,
    );
    this.shadowGenerator.usePercentageCloserFiltering = false;
    this.shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    this.shadowGenerator.bias = Number(options.bias ?? 0.00018);
    this.shadowGenerator.normalBias = Number(options.normalBias ?? 0.012);
    return this.shadowGenerator;
  }

  async updateStudioEnvironment(options = {}) {
    const floorColor = String(options.floorColor || "#d3dbe5").toLowerCase();
    if (floorColor === this._environmentFloorColor) return false;
    const previous = this.scene.environmentTexture;
    const next = createLocalPbrEnvironment(this.scene, { floorColor });
    this.scene.environmentTexture = next;
    this._environmentFloorColor = floorColor;
    await this.waitForGpuIdle();
    previous?.dispose();
    return true;
  }

  registerShadowCaster(mesh) {
    if (mesh instanceof Mesh && this.shadowGenerator) {
      this.shadowGenerator.addShadowCaster(mesh, false);
    }
  }

  unregisterShadowCaster(mesh) {
    this.shadowGenerator?.removeShadowCaster(mesh, false);
  }

  rebuildPostProcessing(state = {}) {
    this._postProcessState = { ...this._postProcessState, ...state };
    const resolved = resolveRealtimePostProcessState(this._postProcessState);
    const signature = JSON.stringify(resolved);
    if (signature === this._postProcessSignature && this.defaultPipeline) {
      return;
    }
    const topologySignature = JSON.stringify(
      realtimePostProcessTopology(this._postProcessState),
    );
    if (
      this._postProcessTopologySignature
      && topologySignature !== this._postProcessTopologySignature
    ) {
      this._postProcessTopologyChangeCount++;
    }
    this._postProcessTopologySignature = topologySignature;
    this._postProcessSignature = signature;
    this._postProcessConfigurationCount++;
    const camera = this.camera;
    if (!camera) return;
    this.scene.imageProcessingConfiguration.isEnabled = true;
    this.scene.imageProcessingConfiguration.applyByPostProcess = true;
    if (!this.defaultPipeline) {
      this.defaultPipeline = new DefaultRenderingPipeline(
        "dem-default-pipeline",
        true,
        this.scene,
        [camera],
        true,
      );
    }
    this.defaultPipeline.samples = resolved.msaaSamples;
    this.defaultPipeline.fxaaEnabled = resolved.fxaaEnabled;
    this.defaultPipeline.bloomEnabled = resolved.bloomEnabled;
    this.defaultPipeline.bloomWeight = Math.max(
      0,
      resolved.bloomStrength,
    );
    this.defaultPipeline.bloomThreshold = resolved.bloomThreshold;
    this.defaultPipeline.bloomKernel = 64;
    this.defaultPipeline.depthOfFieldEnabled = resolved.dofEnabled;
    this.defaultPipeline.depthOfField.focusDistance = Math.max(
      100,
      resolved.dofFocus * 1000,
    );
    this.defaultPipeline.depthOfField.fStop = resolved.dofFStop;
    this.defaultPipeline.depthOfField.focalLength = 50;
    this.defaultPipeline.sharpenEnabled = resolved.sharpenEnabled;
    this.defaultPipeline.sharpen.edgeAmount = Math.max(
      0,
      resolved.sharpenStrength,
    );
    this.defaultPipeline.imageProcessingEnabled = true;

    if (!this.ssaoPipeline && resolved.aoEnabled) {
      this.ssaoPipeline = new SSAO2RenderingPipeline(
        "dem-ssao2-pipeline",
        this.scene,
        {
          ssaoRatio: resolved.ssaoRatio,
          blurRatio: resolved.blurRatio,
        },
        [camera],
        true,
      );
    }
    if (this.ssaoPipeline) {
      this.ssaoPipeline.samples = resolved.ssaoSamples;
      this.ssaoPipeline.textureSamples = resolved.ssaoTextureSamples;
      this.ssaoPipeline.radius = resolved.aoRadius;
      this.ssaoPipeline.base = resolved.aoBase;
      this.ssaoPipeline.epsilon = resolved.aoEpsilon;
      this.ssaoPipeline.minZAspect = resolved.aoMinZAspect;
      this.ssaoPipeline.totalStrength = resolved.aoEnabled
        ? resolved.aoStrength
        : 0;
      this.ssaoPipeline.maxZ = Math.max(
        this.ssaoPipeline.radius * 8,
        resolved.aoMaxZ,
      );
      this.ssaoPipeline.expensiveBlur = resolved.expensiveBlur;
      this.ssaoPipeline.bilateralSamples = resolved.bilateralSamples;
      this.ssaoPipeline.bilateralSoften = resolved.bilateralSoften;
      this.ssaoPipeline.bilateralTolerance = resolved.bilateralTolerance;
    }
  }

  createTaaPipeline(camera = this.camera, options = {}) {
    this.taaPipeline?.dispose();
    this.taaPipeline = new TAARenderingPipeline(
      "dem-cinematic-taa",
      this.scene,
      [camera],
      Constants.TEXTURETYPE_HALF_FLOAT,
    );
    this.taaPipeline.samples = Math.max(1, Number(options.samples) || 32);
    this.taaPipeline.msaaSamples = Math.max(
      1,
      Math.min(4, Number(options.msaaSamples) || 4),
    );
    this.taaPipeline.factor = 1 / Math.max(2, this.taaPipeline.samples);
    this.taaPipeline.disableOnCameraMove = false;
    this.taaPipeline.clampHistory = true;
    return this.taaPipeline;
  }

  disposeTaaPipeline() {
    this.taaPipeline?.dispose();
    this.taaPipeline = null;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  async waitForGpuIdle() {
    const queue = this.backend === "webgpu"
      ? this.engine?._device?.queue
      : null;
    if (queue?.onSubmittedWorkDone) {
      await queue.onSubmittedWorkDone();
      return;
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(2, Math.floor(rect.width));
    const height = Math.max(2, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.updateCameraProjection(width, height);
  }

  getDiagnostics() {
    const caps = this.engine.getCaps();
    const defaultPipeline = this.defaultPipeline;
    const ssaoPipeline = this.ssaoPipeline;
    const taaPipeline = this.taaPipeline;
    const imageProcessing = this.scene.imageProcessingConfiguration;
    return {
      renderer: "babylon",
      backend: this.backend,
      requestedBackend: this.requestedBackend,
      fallbackReason: this.fallbackReason || null,
      rightHanded: this.scene.useRightHandedSystem,
      webGLVersion: this.backend === BACKEND_WEBGL2
        ? Number(this.engine.webGLVersion || 0)
        : null,
      description: this.engine.description || this.engine.name || null,
      maxTextureSize: caps.maxTextureSize,
      maxMSAASamples: caps.maxMSAASamples || 1,
      textureFloat: Boolean(caps.textureFloat),
      textureHalfFloat: Boolean(caps.textureHalfFloat),
      contextLossCount: this.contextLossCount,
      contextRestoreCount: this.contextRestoreCount,
      effectErrors: this.effectErrors.slice(),
      shaderCompilerAssets: this.backend === BACKEND_WEBGPU ? "local" : null,
      camera: this.camera ? {
        alpha: Number(this.camera.alpha),
        beta: Number(this.camera.beta),
        radius: Number(this.camera.radius),
        target: [
          Number(this.camera.target.x),
          Number(this.camera.target.y),
          Number(this.camera.target.z),
        ],
        mode: this.camera.metadata?.cameraMode || null,
        zoom: Number(this.camera.metadata?.zoom || 1),
        orthoHeight: this.camera.mode === Camera.ORTHOGRAPHIC_CAMERA
          ? Math.abs(Number(this.camera.orthoTop) - Number(this.camera.orthoBottom))
          : null,
        inputsAttached: Boolean(this.camera.inputs?.attachedToElement),
        inputEvents: { ...(this.controls?.inputEventCounts || {}) },
      } : null,
      postProcessing: {
        configurationCount: this._postProcessConfigurationCount,
        topologyChangeCount: this._postProcessTopologyChangeCount,
        defaultPipeline: {
          active: Boolean(defaultPipeline),
          samples: Number(defaultPipeline?.samples || 0),
          fxaa: Boolean(defaultPipeline?.fxaaEnabled),
          bloom: Boolean(defaultPipeline?.bloomEnabled),
          bloomWeight: Number(defaultPipeline?.bloomWeight || 0),
          depthOfField: Boolean(defaultPipeline?.depthOfFieldEnabled),
          sharpen: Boolean(defaultPipeline?.sharpenEnabled),
        },
        ssao2: {
          active: Boolean(ssaoPipeline),
          samples: Number(ssaoPipeline?.samples || 0),
          textureSamples: Number(ssaoPipeline?.textureSamples || 0),
          strength: Number(ssaoPipeline?.totalStrength || 0),
          radius: Number(ssaoPipeline?.radius || 0),
          base: Number(ssaoPipeline?.base || 0),
          epsilon: Number(ssaoPipeline?.epsilon || 0),
          minZAspect: Number(ssaoPipeline?.minZAspect || 0),
          expensiveBlur: Boolean(ssaoPipeline?.expensiveBlur),
          bilateralSamples: Number(ssaoPipeline?.bilateralSamples || 0),
          bilateralSoften: Number(ssaoPipeline?.bilateralSoften || 0),
          bilateralTolerance: Number(ssaoPipeline?.bilateralTolerance || 0),
        },
        taa: {
          active: Boolean(taaPipeline),
          samples: Number(taaPipeline?.samples || 0),
          msaaSamples: Number(taaPipeline?.msaaSamples || 0),
          factor: Number(taaPipeline?.factor || 0),
        },
        imageProcessing: {
          active: Boolean(defaultPipeline?.imageProcessingEnabled),
          applyByPostProcess: Boolean(imageProcessing?.applyByPostProcess),
          toneMapping: this.renderer.toneMapping,
          exposure: Number(imageProcessing?.exposure || 0),
          contrast: Number(imageProcessing?.contrast || 0),
          toneMappingEnabled: Boolean(imageProcessing?.toneMappingEnabled),
          toneMappingType: Number(imageProcessing?.toneMappingType ?? -1),
        },
      },
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.controls?.dispose();
    this.taaPipeline?.dispose();
    this.ssaoPipeline?.dispose();
    this.defaultPipeline?.dispose();
    this.shadowGenerator?.dispose();
    if (this._contextLostObserver) {
      this.engine.onContextLostObservable?.remove?.(this._contextLostObserver);
    }
    if (this._contextRestoredObserver) {
      this.engine.onContextRestoredObservable?.remove?.(
        this._contextRestoredObserver,
      );
    }
    if (this._effectErrorObserver) {
      this.engine.onEffectErrorObservable?.remove?.(this._effectErrorObserver);
    }
    this.scene.dispose();
    this.engine.dispose();
    this.canvas.remove();
  }
}

export async function createBabylonRuntime(container, options = {}) {
  return BabylonRenderRuntime.create(container, options);
}

export function createDefaultLights(scene) {
  const hemisphere = new HemisphericLight(
    "dem-hemisphere",
    new Vector3(0, 1, 0),
    scene,
  );
  hemisphere.diffuse = new Color3(0.91, 0.96, 1);
  hemisphere.groundColor = new Color3(0.36, 0.32, 0.28);
  hemisphere.intensity = 0.1;

  const sun = new DirectionalLight(
    "dem-sun",
    new Vector3(-0.45, -0.82, -0.36),
    scene,
  );
  sun.position = new Vector3(6, 8, 6);
  sun.diffuse = new Color3(1, 0.95, 0.86);
  sun.intensity = 1;
  return { hemisphere, sun };
}

export {
  BACKEND_WEBGL2,
  BACKEND_WEBGPU,
};
