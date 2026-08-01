import { computeTerrainSkyVisibility } from "./terrain-lighting.js";

let retained = null;

function transferFloat32(type, generation, values, extra = {}) {
  self.postMessage(
    { type, generation, values, ...extra },
    [values.buffer],
  );
}

self.addEventListener("message", event => {
  const message = event.data || {};
  try {
    if (message.type === "compute") {
      const heights = new Float32Array(message.heights);
      const validMask = message.validMask
        ? new Uint8Array(message.validMask)
        : undefined;
      retained = computeTerrainSkyVisibility({
        elevations: heights,
        validMask,
        width: message.width,
        height: message.height,
        cellSizeX: message.cellSizeX,
        cellSizeY: message.cellSizeY,
        zScale: message.zScale,
      });
      const values = retained.skyVisibility.slice();
      transferFloat32("computed", message.generation, values, {
        width: message.width,
        height: message.height,
        lightingLayer: "isotropic-horizon-visibility",
      });
      return;
    }

    if (message.type === "aggregate" && retained) {
      const values = retained.skyVisibility.slice();
      transferFloat32("aggregated", message.generation, values, {
        width: retained.width,
        height: retained.height,
        lightingLayer: "isotropic-horizon-visibility",
      });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      generation: message.generation,
      message: error?.message || String(error),
    });
  }
});
