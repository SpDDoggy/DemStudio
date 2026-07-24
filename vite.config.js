import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    sourcemap: true
  }
});
