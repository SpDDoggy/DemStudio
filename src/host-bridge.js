import { save } from "@tauri-apps/plugin-dialog";
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

window.lens = {
  db: {
    load: loadValue,
    save: saveValue
  },
  fs: {
    selectDialog,
    writeBlob,
    writeBuffer
  }
};

window.demStudioHost = Object.freeze({
  runtime: "tauri",
  platform: navigator.platform
});
