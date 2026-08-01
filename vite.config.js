import { defineConfig } from "vite";

const RETIRED_RENDERER_PATTERN =
  /three-gpu-pathtracer|three-mesh-bvh|xatlas-web|three\/addons|from\s+["']three["']/i;
const CDN_PATTERN =
  /https?:\/\/(?:cdn\.babylonjs\.com|unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|esm\.sh)/i;

function enforceOfflineRendererBundle() {
  return {
    name: "dem-studio-offline-renderer-bundle",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/node_modules/@babylonjs/core/")) return null;
      const transformed = code
        .replaceAll(
          "https://cdn.babylonjs.com",
          "about:blank#dem-studio-offline",
        )
        .replaceAll(
          "https://unpkg.com/fflate@0.8.2",
          "about:blank#dem-studio-offline",
        );
      return transformed === code ? null : { code: transformed, map: null };
    },
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith(".map")) continue;
        const source = output.type === "chunk"
          ? output.code
          : (typeof output.source === "string" ? output.source : "");
        if (RETIRED_RENDERER_PATTERN.test(source)) {
          this.error(`Retired renderer identifier emitted in ${fileName}`);
        }
        if (CDN_PATTERN.test(source)) {
          this.error(`CDN URL emitted in ${fileName}`);
        }
      }
    },
  };
}

export default defineConfig({
  base: "./",
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  plugins: [enforceOfflineRendererBundle()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    sourcemap: false
  }
});
