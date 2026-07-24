import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const sourceArgument = argument("--source");
const targetArgument = argument("--target");
const force = process.argv.includes("--force");

if (!sourceArgument || !targetArgument) {
  console.error("Usage: node scripts/migrate-lens-state.mjs --source <Lens db.json> --target <Tauri store json> [--force]");
  process.exit(2);
}

const source = resolve(sourceArgument);
const target = resolve(targetArgument);

if (!force) {
  try {
    await stat(target);
    console.error(`Target already exists: ${target}`);
    console.error("Use --force only after reviewing the existing standalone state.");
    process.exit(3);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

const legacy = JSON.parse(await readFile(source, "utf8"));
if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
  throw new Error("Legacy DEM Studio database must be a JSON object.");
}

const migrated = {};
for (const key of ["settings", "customPresets", "recentFiles"]) {
  if (legacy[key] !== undefined) {
    migrated[`dem-studio:${key}`] = legacy[key];
  }
}

if (!migrated["dem-studio:settings"]) {
  throw new Error("Legacy database has no settings object; migration stopped.");
}

await mkdir(dirname(target), { recursive: true });
const temporary = `${target}.migrating`;
await writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
await rename(temporary, target);

console.log(JSON.stringify({
  source,
  target,
  keys: Object.keys(migrated),
  recentFiles: Array.isArray(legacy.recentFiles) ? legacy.recentFiles.length : 0
}));
