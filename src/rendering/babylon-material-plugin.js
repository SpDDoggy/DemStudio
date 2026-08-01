import {
  MaterialPluginBase,
} from "@babylonjs/core/Materials/materialPluginBase.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";

const PLUGIN_NAME = "DemTerrainMaterial";
const neutralGainTextures = new WeakMap();

function getNeutralGainTexture(material) {
  const scene = material.getScene();
  let texture = neutralGainTextures.get(scene);
  if (texture && !texture.isDisposed) return texture;
  texture = RawTexture.CreateRGBATexture(
    new Uint8Array([128, 128, 128, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  texture.name = "dem-neutral-relight-gain";
  neutralGainTextures.set(scene, texture);
  return texture;
}

export class DemTerrainMaterialPlugin extends MaterialPluginBase {
  constructor(material, options = {}) {
    super(material, PLUGIN_NAME, 200, { DEM_TERRAIN_MATERIAL: true });
    this.horizonStrength = Number(options.horizonStrength ?? 0);
    this.relightStrength = Number(options.relightStrength ?? 0);
    this.whiteModel = options.whiteModel ? 1 : 0;
    this.detailShapingStrength = Number(options.detailShapingStrength ?? 0);
    this.gainTexture = options.gainTexture || null;
    this.neutralGainTexture = getNeutralGainTexture(material);
    this._enable(true);
  }

  isCompatible(shaderLanguage) {
    return shaderLanguage === ShaderLanguage.GLSL
      || shaderLanguage === ShaderLanguage.WGSL;
  }

  prepareDefines(defines) {
    defines.DEM_TERRAIN_MATERIAL = true;
    defines.UV1 = true;
  }

  getAttributes(attributes) {
    if (!attributes.includes("uv")) attributes.push("uv");
    if (!attributes.includes("studioCurvature")) attributes.push("studioCurvature");
    if (!attributes.includes("horizonVisibility")) attributes.push("horizonVisibility");
  }

  getSamplers(samplers) {
    samplers.push("demRelightGain");
  }

  getActiveTextures(activeTextures) {
    activeTextures.push(this.gainTexture || this.neutralGainTexture);
  }

  getUniforms() {
    return {
      ubo: [
        { name: "demRelightStrength", size: 1, type: "float" },
        { name: "demWhiteModel", size: 1, type: "float" },
        { name: "demHasRelightGain", size: 1, type: "float" },
        { name: "demDetailShapingStrength", size: 1, type: "float" },
        { name: "demHorizonStrength", size: 1, type: "float" },
      ],
    };
  }

  bindForSubMesh(uniformBuffer) {
    uniformBuffer.updateFloat(
      "demRelightStrength",
      Math.max(0, Math.min(1, Number(this.relightStrength) || 0)),
    );
    uniformBuffer.updateFloat("demWhiteModel", this.whiteModel ? 1 : 0);
    uniformBuffer.updateFloat("demHasRelightGain", this.gainTexture ? 1 : 0);
    uniformBuffer.updateFloat(
      "demDetailShapingStrength",
      Math.max(0, Math.min(1, Number(this.detailShapingStrength) || 0)),
    );
    uniformBuffer.updateFloat(
      "demHorizonStrength",
      Math.max(0, Math.min(1, Number(this.horizonStrength) || 0)),
    );
    uniformBuffer.setTexture(
      "demRelightGain",
      this.gainTexture || this.neutralGainTexture,
    );
  }

  getCustomCode(shaderType, shaderLanguage = ShaderLanguage.GLSL) {
    return shaderLanguage === ShaderLanguage.WGSL
      ? this._wgslCode(shaderType)
      : this._glslCode(shaderType);
  }

  _glslCode(shaderType) {
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
attribute float studioCurvature;
attribute float horizonVisibility;
varying vec2 vDemTerrainUv;
varying float vDemStudioCurvature;
varying float vDemHorizonVisibility;
`,
        CUSTOM_VERTEX_MAIN_END: `
vDemTerrainUv = uv;
vDemStudioCurvature = studioCurvature;
vDemHorizonVisibility = horizonVisibility;
`,
      };
    }
    if (shaderType === "fragment") {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
varying vec2 vDemTerrainUv;
varying float vDemStudioCurvature;
varying float vDemHorizonVisibility;
uniform sampler2D demRelightGain;
`,
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef REFLECTION
float demHorizonOcclusion = mix(
  1.0,
  clamp(vDemHorizonVisibility, 0.0, 1.0),
  clamp(demHorizonStrength, 0.0, 1.0)
);
finalIrradiance *= demHorizonOcclusion;
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
if (demHasRelightGain > 0.5) {
  float demGain = mix(0.65, 1.79, texture2D(demRelightGain, vDemTerrainUv).r);
  finalColor.rgb = mix(
    finalColor.rgb,
    finalColor.rgb * demGain,
    clamp(demRelightStrength, 0.0, 1.0)
  );
}
if (demWhiteModel > 0.5) {
  float demLuma = dot(finalColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  finalColor.rgb = mix(finalColor.rgb, vec3(demLuma), 0.08);
}
float demCurvature = clamp(vDemStudioCurvature, -1.0, 1.0);
float demDetailGain = demCurvature >= 0.0
  ? demCurvature * 0.035
  : demCurvature * 0.060;
finalColor.rgb *= 1.0
  + demDetailGain * clamp(demDetailShapingStrength, 0.0, 1.0);
`,
      };
    }
    return null;
  }

  _wgslCode(shaderType) {
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
attribute studioCurvature: f32;
attribute horizonVisibility: f32;
varying vDemTerrainUv: vec2f;
varying vDemStudioCurvature: f32;
varying vDemHorizonVisibility: f32;
`,
        CUSTOM_VERTEX_MAIN_END: `
vertexOutputs.vDemTerrainUv = input.uv;
vertexOutputs.vDemStudioCurvature = input.studioCurvature;
vertexOutputs.vDemHorizonVisibility = input.horizonVisibility;
`,
      };
    }
    if (shaderType === "fragment") {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
varying vDemTerrainUv: vec2f;
varying vDemStudioCurvature: f32;
varying vDemHorizonVisibility: f32;
var demRelightGain: texture_2d<f32>;
var demRelightGainSampler: sampler;
`,
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef REFLECTION
let demHorizonOcclusion: f32 = mix(
  1.0,
  clamp(fragmentInputs.vDemHorizonVisibility, 0.0, 1.0),
  clamp(uniforms.demHorizonStrength, 0.0, 1.0)
);
finalIrradiance *= demHorizonOcclusion;
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
if (uniforms.demHasRelightGain > 0.5) {
  let demGain: f32 = mix(
    0.65,
    1.79,
    textureSample(
      demRelightGain,
      demRelightGainSampler,
      fragmentInputs.vDemTerrainUv
    ).r
  );
  finalColor = vec4f(
    mix(
      finalColor.rgb,
      finalColor.rgb * demGain,
      clamp(uniforms.demRelightStrength, 0.0, 1.0)
    ),
    finalColor.a
  );
}
if (uniforms.demWhiteModel > 0.5) {
  let demLuma: f32 = dot(finalColor.rgb, vec3f(0.2126, 0.7152, 0.0722));
  finalColor = vec4f(mix(finalColor.rgb, vec3f(demLuma), 0.08), finalColor.a);
}
let demCurvature: f32 = clamp(fragmentInputs.vDemStudioCurvature, -1.0, 1.0);
let demDetailGain: f32 = select(
  demCurvature * 0.060,
  demCurvature * 0.035,
  demCurvature >= 0.0
);
finalColor = vec4f(
  finalColor.rgb * (
    1.0 + demDetailGain * clamp(uniforms.demDetailShapingStrength, 0.0, 1.0)
  ),
  finalColor.a
);
`,
      };
    }
    return null;
  }
}

export function attachDemTerrainMaterialPlugin(material, options = {}) {
  const existing = material.pluginManager?.getPlugin?.(PLUGIN_NAME);
  if (existing) {
    existing.horizonStrength = Number(
      options.horizonStrength ?? existing.horizonStrength,
    );
    existing.relightStrength = Number(
      options.relightStrength ?? existing.relightStrength,
    );
    existing.whiteModel = options.whiteModel ? 1 : 0;
    existing.detailShapingStrength = Number(
      options.detailShapingStrength ?? existing.detailShapingStrength,
    );
    existing.gainTexture = options.gainTexture || null;
    return existing;
  }
  return new DemTerrainMaterialPlugin(material, options);
}
