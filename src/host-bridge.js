import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { load } from "@tauri-apps/plugin-store";

const STORE_FILE = "dem-studio.json";
const storePromise = load(STORE_FILE, {
  autoSave: 250
});

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
  const primary = paths.find(path => ["tif", "tiff", "hgt", "asc"].includes(pathExtension(path)));
  if (!primary) {
    return { paths };
  }
  return invoke("parse_dem_path", {
    request: {
      path: primary,
      companionPaths: paths.filter(path => path !== primary)
    }
  });
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
    sampleDem,
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
