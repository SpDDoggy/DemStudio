const finiteOr = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, finiteOr(value, minimum)));

/**
 * Keep every full-frame attachment stable while the camera is manipulated.
 * Babylon may recreate render targets when samples, ratios, or enabled passes
 * change; those reallocations can expose a cleared frame on either backend.
 */
export function resolveRealtimePostProcessState(state = {}) {
  const msaaSamples = Math.round(clamp(state.msaaSamples, 1, 4));
  return {
    msaaSamples,
    fxaaEnabled: msaaSamples < 4,
    bloomEnabled: Boolean(state.bloomEnabled),
    bloomStrength: Math.max(0, finiteOr(state.bloomStrength, 0.35)),
    bloomThreshold: clamp(state.bloomThreshold, 0, 1),
    dofEnabled: Boolean(state.dofEnabled),
    dofFocus: Math.max(0.1, finiteOr(state.dofFocus, 7)),
    dofFStop: Math.max(0.1, finiteOr(state.dofFStop, 2.8)),
    sharpenEnabled: Boolean(state.sharpenEnabled),
    sharpenStrength: Math.max(0, finiteOr(state.sharpenStrength, 0.22)),
    aoEnabled: Boolean(state.aoEnabled),
    aoStrength: clamp(state.aoStrength, 0, 2),
    aoRadius: Math.max(0.0001, finiteOr(state.aoRadius, 0.08)),
    aoMaxZ: Math.max(0.0008, finiteOr(state.aoMaxZ, 100)),
    aoBase: clamp(finiteOr(state.aoBase, 0.035), 0, 0.15),
    aoEpsilon: clamp(finiteOr(state.aoEpsilon, 0.025), 0, 0.1),
    aoMinZAspect: clamp(finiteOr(state.aoMinZAspect, 0.2), 0.01, 1),
    ssaoRatio: 0.75,
    blurRatio: 1,
    ssaoSamples: 16,
    ssaoTextureSamples: 4,
    expensiveBlur: true,
    bilateralSamples: Math.round(clamp(finiteOr(state.bilateralSamples, 16), 4, 24)),
    bilateralSoften: clamp(finiteOr(state.bilateralSoften, 0.35), 0, 1),
    bilateralTolerance: clamp(finiteOr(state.bilateralTolerance, 0.2), 0, 1),
  };
}

export function realtimePostProcessTopology(state = {}) {
  const resolved = resolveRealtimePostProcessState(state);
  return {
    msaaSamples: resolved.msaaSamples,
    bloomEnabled: resolved.bloomEnabled,
    dofEnabled: resolved.dofEnabled,
    sharpenEnabled: resolved.sharpenEnabled,
    aoPipelineRequired: resolved.aoEnabled,
    ssaoRatio: resolved.ssaoRatio,
    blurRatio: resolved.blurRatio,
    ssaoSamples: resolved.ssaoSamples,
    ssaoTextureSamples: resolved.ssaoTextureSamples,
    expensiveBlur: resolved.expensiveBlur,
    bilateralSamples: resolved.bilateralSamples,
  };
}
