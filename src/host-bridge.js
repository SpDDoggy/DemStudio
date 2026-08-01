import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { load } from "@tauri-apps/plugin-store";

const STORE_FILE = "dem-studio.json";
const storePromise = load(STORE_FILE, {
  autoSave: 250
});
const demWindowRequests = new Map();
const cancelledDemWindowRequests = new Set();
let demWindowRequestSequence = 0;
let demWindowCancellationCount = 0;
let demWindowNativeCancellationRequested = 0;
let demWindowNativeCancellationSucceeded = 0;
let demWindowNativeCancellationFailed = 0;

function storageKey(pluginId, key) {
  return `${pluginId}:${key}`;
}

async function loadValue(pluginId, key, fallback) {
  const store = await storePromise;
  const value = await store.get(storageKey(pluginId, key));
  return value ?? fallback;
}

async function saveValue(pluginId, key, value) {
  const store = await storePromise;
  await store.set(storageKey(pluginId, key), value);
  await store.save();
  return true;
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function selectDialog(mode, options = {}) {
  if (mode !== "save_file") {
    throw new Error(`Unsupported dialog mode: ${mode}`);
  }

  return save({
    defaultPath: options.saveFilename,
    filters: (options.fileTypes || []).map((item) => ({
      name: item.description || "File",
      extensions: item.extensions || []
    }))
  });
}

async function writeBuffer(path, base64) {
  await writeFile(path, decodeBase64(base64));
  return { success: true };
}

async function writeBlob(path, blob) {
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return { success: true };
}

async function serializeCoreFile(file) {
  return {
    name: file.name,
    bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
  };
}

async function parseDem(file, companionFiles = []) {
  const companions = [];
  for (const companion of companionFiles) {
    if (companion !== file) {
      companions.push(await serializeCoreFile(companion));
    }
  }
  return invoke("parse_dem", {
    request: {
      ...(await serializeCoreFile(file)),
      companions
    }
  });
}

function pathExtension(path) {
  return String(path || "").split(/[\\/]/).pop().split(".").pop().toLowerCase();
}

const CORE_DEM_EXTENSIONS = new Set(["tif", "tiff", "hgt", "asc"]);
const IMAGE_HEIGHTMAP_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

function fileNameFromPath(path) {
  return String(path || "").split(/[\\/]/).pop() || "terrain";
}

function imageMime(path) {
  const ext = pathExtension(path);
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

async function imageFileFromPath(path, sourcePaths = [path]) {
  const response = await invoke("read_heightmap_path", { path });
  const bytes = response instanceof Uint8Array
    ? response
    : response instanceof ArrayBuffer
      ? new Uint8Array(response)
      : ArrayBuffer.isView(response)
        ? new Uint8Array(response.buffer, response.byteOffset, response.byteLength)
        : new Uint8Array(response);
  const file = new File([bytes], fileNameFromPath(path), {
    type: imageMime(path),
    lastModified: Date.now()
  });
  Object.defineProperties(file, {
    sourcePath: {
      value: path,
      enumerable: true
    },
    sourcePaths: {
      value: [...sourcePaths],
      enumerable: true
    }
  });
  return file;
}

async function openDem() {
  const selected = await open({
    title: "导入 DEM",
    multiple: true,
    directory: false,
    filters: [{
      name: "DEM 与地理参考文件",
      extensions: ["tif", "tiff", "hgt", "asc", "png", "jpg", "jpeg", "webp", "prj", "xml", "tfw", "tifw", "wld"]
    }]
  });
  if (!selected) return null;
  const paths = Array.isArray(selected) ? selected : [selected];
  const primary = paths.find(path => {
    const ext = pathExtension(path);
    return CORE_DEM_EXTENSIONS.has(ext) || IMAGE_HEIGHTMAP_EXTENSIONS.has(ext);
  });
  if (!primary) {
    return { paths };
  }
  if (IMAGE_HEIGHTMAP_EXTENSIONS.has(pathExtension(primary))) {
    return {
      kind: "image-heightmap",
      file: await imageFileFromPath(primary, paths),
      sourcePath: primary,
      sourcePaths: paths
    };
  }
  const parsed = await invoke("parse_dem_path", {
    request: {
      path: primary,
      companionPaths: paths.filter(path => path !== primary)
    }
  });
  return {
    ...parsed,
    sourcePath: primary,
    sourcePaths: paths
  };
}

async function openDemPath(path, companionPaths = []) {
  if (!path) throw new Error("Missing DEM source path.");
  const sourcePaths = [
    path,
    ...(Array.isArray(companionPaths) ? companionPaths.filter(item => item && item !== path) : [])
  ];
  if (IMAGE_HEIGHTMAP_EXTENSIONS.has(pathExtension(path))) {
    return {
      kind: "image-heightmap",
      file: await imageFileFromPath(path, sourcePaths),
      sourcePath: path,
      sourcePaths
    };
  }
  const parsed = await invoke("parse_dem_path", {
    request: {
      path,
      companionPaths: Array.isArray(companionPaths)
        ? companionPaths.filter(item => item && item !== path)
        : []
    }
  });
  return {
    ...parsed,
    sourcePath: path,
    sourcePaths
  };
}

async function openTexture() {
  const selected = await open({
    title: "导入地形贴图",
    multiple: false,
    directory: false,
    filters: [{
      name: "地形贴图",
      extensions: ["png", "jpg", "jpeg", "webp"]
    }]
  });
  if (!selected || Array.isArray(selected)) return null;
  return imageFileFromPath(selected, [selected]);
}

async function sampleDem(coreId, options) {
  return invoke("sample_dem", {
    request: {
      coreId,
      maxDimension: options.maxDimension,
      noDataFill: options.noDataFill,
      smoothSteps: options.smoothSteps
    }
  });
}

function parseBinaryTerrainSample(response, engine) {
  const bytes = response instanceof ArrayBuffer
    ? new Uint8Array(response)
    : ArrayBuffer.isView(response)
      ? new Uint8Array(response.buffer, response.byteOffset, response.byteLength)
      : new Uint8Array(response);
  const magic = bytes.byteLength >= 4
    ? String.fromCharCode(...bytes.subarray(0, 4))
    : "";
  if (bytes.byteLength < 16 || !["DMT2", "DMT3"].includes(magic)) {
    throw new Error("Invalid DEM Core binary sample.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const headerSize = view.getUint16(6, true);
  const cols = view.getUint32(8, true);
  const rows = view.getUint32(12, true);
  const valueCount = cols * rows;
  const maskLength = magic === "DMT3" && headerSize >= 20
    ? view.getUint32(16, true)
    : 0;
  const expectedLength = headerSize + valueCount * 4 + maskLength;
  if (
    !((magic === "DMT2" && version === 1) || (magic === "DMT3" && version === 2)) ||
    headerSize < (magic === "DMT3" ? 20 : 16) ||
    expectedLength !== bytes.byteLength ||
    (maskLength !== 0 && maskLength !== valueCount)
  ) {
    throw new Error("Unsupported DEM Core binary sample.");
  }
  const heights = new Float32Array(valueCount);
  for (let index = 0; index < valueCount; index += 1) {
    heights[index] = view.getFloat32(headerSize + index * 4, true);
  }
  const validMask = maskLength
    ? bytes.slice(headerSize + valueCount * 4, expectedLength)
    : new Uint8Array(valueCount).fill(1);
  return { cols, rows, heights, validMask, engine };
}

async function invokeBinarySample(command, coreId, options) {
  const response = await invoke(command, {
    request: {
      coreId,
      maxDimension: options.maxDimension,
      noDataFill: options.noDataFill,
      smoothSteps: options.smoothSteps
    }
  });
  return parseBinaryTerrainSample(response, "rust-dem-core-v3-binary");
}

async function sampleDemBinary(coreId, options) {
  return invokeBinarySample("sample_dem_binary", coreId, options);
}

async function sampleDemOverviewBinary(coreId, options) {
  return invokeBinarySample("sample_dem_overview_binary", coreId, options);
}

async function sampleDemWindowBinary(coreId, options) {
  const requestId = String(
    options.requestId || `dem-window-${Date.now()}-${++demWindowRequestSequence}`
  );
  const cancelledError = () => {
    const error = new DOMException("DEM window request was cancelled.", "AbortError");
    Object.defineProperty(error, "requestId", { value: requestId });
    return error;
  };
  if (cancelledDemWindowRequests.has(requestId)) {
    cancelledDemWindowRequests.delete(requestId);
    throw cancelledError();
  }
  demWindowRequests.set(requestId, {
    requestId,
    coreId,
    startedAt: performance.now()
  });
  try {
    const response = await invoke("sample_dem_window_binary", {
      request: {
        coreId,
        requestId,
        x: options.x,
        y: options.y,
        width: options.width,
        height: options.height,
        outputCols: options.outputCols,
        outputRows: options.outputRows,
        maxDimension: options.maxDimension,
        noDataFill: options.noDataFill,
        smoothSteps: options.smoothSteps
      }
    });
    if (cancelledDemWindowRequests.has(requestId)) throw cancelledError();
    return parseBinaryTerrainSample(response, "rust-dem-core-v3-window-binary");
  } finally {
    demWindowRequests.delete(requestId);
    cancelledDemWindowRequests.delete(requestId);
  }
}

function cancelDemWindowRequest(requestId) {
  const key = String(requestId || "");
  if (!key || !demWindowRequests.has(key)) return false;
  cancelledDemWindowRequests.add(key);
  demWindowCancellationCount++;
  demWindowNativeCancellationRequested++;
  void invoke("cancel_dem_request", { requestId: key })
    .then(() => {
      demWindowNativeCancellationSucceeded++;
    })
    .catch(error => {
      demWindowNativeCancellationFailed++;
      console.warn("Native DEM request cancellation failed", key, error);
    });
  return true;
}

function getDemWindowRequestStats() {
  return {
    activeCount: demWindowRequests.size,
    cancelledCount: demWindowCancellationCount,
    nativeCancellation: demWindowNativeCancellationSucceeded > 0,
    nativeCancellationRequested: demWindowNativeCancellationRequested,
    nativeCancellationSucceeded: demWindowNativeCancellationSucceeded,
    nativeCancellationFailed: demWindowNativeCancellationFailed,
    cancellationMode: demWindowNativeCancellationSucceeded > 0
      ? "native-and-discard"
      : "native-requested-with-local-discard"
  };
}

async function releaseDem(coreId) {
  if (!coreId) return false;
  return invoke("release_dem", { coreId });
}

async function coreStats() {
  return invoke("core_stats");
}

async function encodeGeoTiff(width, height, rgba, geo, embedCrs) {
  const sourceTags = geo?.sourceGeoTiffTags || {};
  return invoke("encode_geotiff", {
    request: {
      width,
      height,
      rgba: Array.from(rgba),
      geoTransform: Array.from(geo?.geoTransform || []),
      geoKeyDirectory: Array.from(sourceTags.geoKeyDirectory || []),
      geoDoubleParams: Array.from(sourceTags.geoDoubleParams || []),
      geoAsciiParams: sourceTags.geoAsciiParams || null,
      embedCrs: embedCrs !== false
    }
  });
}

const appWindow = getCurrentWindow();

async function toggleMaximize() {
  await appWindow.toggleMaximize();
  return appWindow.isMaximized();
}

window.lens = {
  db: {
    load: loadValue,
    save: saveValue
  },
  fs: {
    selectDialog,
    writeBlob,
    writeBuffer
  },
  core: {
    parseDem,
    openDem,
    openDemPath,
    openTexture,
    sampleDem,
    sampleDemBinary,
    sampleDemOverviewBinary,
    sampleDemWindowBinary,
    cancelDemWindowRequest,
    getDemWindowRequestStats,
    releaseDem,
    coreStats,
    encodeGeoTiff
  },
  window: {
    minimize: () => appWindow.minimize(),
    toggleMaximize,
    close: () => appWindow.close(),
    isMaximized: () => appWindow.isMaximized()
  }
};

window.demStudioHost = Object.freeze({
  runtime: "tauri",
  platform: navigator.platform,
  core: "rust-dem-core"
});
