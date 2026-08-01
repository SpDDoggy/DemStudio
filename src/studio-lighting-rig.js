import {
  Vector2,
  Vector3,
} from "./rendering/babylon-scene-kit.js";
import { fitDirectionalShadowFrustum } from "./studio-shadow-frustum.js";

const safeNormalize = (vector, fallback) => {
  if (vector.lengthSq() < 1e-10) return vector.copy(fallback);
  return vector.normalize();
};

export class StudioLightingRig {
  constructor({
    scene,
    keyLight,
  }) {
    this.scene = scene;
    this.keyLight = keyLight;
    this.target = keyLight.target || null;
    this.projectionDirection = new Vector2(1, 1).normalize();
    this.lastState = null;
    if (this.target) scene.add?.(this.target);
  }

  update(camera, center, state) {
    if (!camera || !center || !state) return null;
    camera.updateMatrixWorld?.(true);
    const viewOut = safeNormalize(
      camera.position.clone().sub(center),
      new Vector3(0, 1, 1),
    );
    const screenRight = safeNormalize(
      Vector3.Cross(camera.upVector || new Vector3(0, 1, 0), viewOut),
      new Vector3(1, 0, 0),
    );
    const screenUp = safeNormalize(
      Vector3.Cross(viewOut, screenRight),
      new Vector3(0, 1, 0),
    );
    const azimuth = Number(state.sunAzimuth ?? 315) * Math.PI / 180;
    const elevation = Number(state.sunElevation ?? 48) * Math.PI / 180;
    const horizontal = Math.cos(elevation);
    const keyDirection = safeNormalize(
      new Vector3(
        Math.sin(azimuth) * horizontal,
        Math.sin(elevation),
        Math.cos(azimuth) * horizontal,
      ),
      new Vector3(-0.5, 0.8, 0.3),
    );
    const sourcePosition = center.clone().addScaledVector(
      keyDirection,
      state.keyDistance,
    );
    this.keyLight.position.copy(sourcePosition);
    if (this.target?.position) this.target.position.copy(center);
    if (this.keyLight.direction) {
      this.keyLight.direction.copy(center).sub(sourcePosition).normalize();
    }
    this.keyLight.intensity = state.mainLightIntensity;
    this.keyLight.castShadow = true;

    const shadowCamera = this.keyLight.shadow?.camera;
    const extent = state.shadowExtent;
    const fitted = fitDirectionalShadowFrustum({
      bounds: state.metrics?.bounds,
      lightDirection: this.keyLight.direction?.asArray?.(),
      mapSize: state.shadowMapSize,
    });
    // Babylon's DirectionalLight owns the native shadow projection. Keep its
    // automatic caster fit disabled so the fitted, texel-snapped bounds are
    // not overwritten on every camera frame.
    this.keyLight.autoUpdateExtends = false;
    this.keyLight.autoCalcShadowZBounds = false;
    this.keyLight.orthoLeft = fitted.left;
    this.keyLight.orthoRight = fitted.right;
    this.keyLight.orthoTop = fitted.top;
    this.keyLight.orthoBottom = fitted.bottom;
    this.keyLight.shadowMinZ = fitted.near;
    this.keyLight.shadowMaxZ = Math.max(fitted.far, state.shadowFar);
    this.keyLight.forceProjectionMatrixCompute?.();
    if (shadowCamera) {
      shadowCamera.left = Number.isFinite(fitted.left) ? fitted.left : -extent;
      shadowCamera.right = Number.isFinite(fitted.right) ? fitted.right : extent;
      shadowCamera.top = Number.isFinite(fitted.top) ? fitted.top : extent;
      shadowCamera.bottom = Number.isFinite(fitted.bottom) ? fitted.bottom : -extent;
      shadowCamera.near = fitted.near;
      shadowCamera.far = Math.max(fitted.far, state.shadowFar);
      shadowCamera.updateProjectionMatrix?.();
      this.keyLight.shadow.mapSize?.set?.(state.shadowMapSize, state.shadowMapSize);
      this.keyLight.shadow.radius = state.shadowRadius;
      this.keyLight.shadow.blurSamples = state.qualityMix > 0.55 ? 8 : 4;
      this.keyLight.shadow.bias = state.shadowBias;
      this.keyLight.shadow.normalBias = state.shadowNormalBias;
      this.keyLight.shadow.needsUpdate = true;
    }

    const screenDownRight = screenRight.clone().sub(screenUp);
    const planar = new Vector2(screenDownRight.x, screenDownRight.z);
    if (planar.lengthSq() > 1e-8) {
      this.projectionDirection.copy(planar.normalize());
    }

    this.lastState = {
      center: center.asArray(),
      keyLightPosition: this.keyLight.position.asArray(),
      keyLightDirection: this.keyLight.direction?.asArray?.() || null,
      projectionDirection: this.projectionDirection.asArray(),
      sunAzimuth: state.sunAzimuth,
      sunElevation: state.sunElevation,
      shadowMapSize: state.shadowMapSize,
      shadowExtent: state.shadowExtent,
      shadowFrustum: fitted,
      microDetailWeight: state.microDetailWeight,
      qualityMix: state.qualityMix,
    };
    return this.lastState;
  }

  getDiagnostics() {
    return this.lastState ? { ...this.lastState } : null;
  }
}
