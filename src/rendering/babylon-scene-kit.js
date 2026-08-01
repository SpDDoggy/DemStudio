import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import {
  DirectionalLight as BabylonDirectionalLight,
} from "@babylonjs/core/Lights/directionalLight.js";
import {
  HemisphericLight as BabylonHemisphericLight,
} from "@babylonjs/core/Lights/hemisphericLight.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import {
  ShaderMaterial as BabylonShaderMaterial,
} from "@babylonjs/core/Materials/shaderMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import {
  DynamicTexture,
} from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Frustum as BabylonFrustum } from "@babylonjs/core/Maths/math.frustum.js";
import { Plane } from "@babylonjs/core/Maths/math.plane.js";
import {
  Matrix,
  Quaternion,
  Vector2 as BabylonVector2,
  Vector3 as BabylonVector3,
} from "@babylonjs/core/Maths/math.vector.js";
import { Mesh as BabylonMesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";

import { attachDemTerrainMaterialPlugin } from "./babylon-material-plugin.js";

let activeRuntime = null;
let sequence = 0;

if (!BabylonVector2.prototype.copy) {
  BabylonVector2.prototype.copy = BabylonVector2.prototype.copyFrom;
}
if (!BabylonVector2.prototype.lengthSq) {
  BabylonVector2.prototype.lengthSq = BabylonVector2.prototype.lengthSquared;
}
if (!BabylonVector3.prototype.copy) {
  BabylonVector3.prototype.copy = BabylonVector3.prototype.copyFrom;
}
if (!BabylonVector3.prototype.sub) {
  BabylonVector3.prototype.sub = BabylonVector3.prototype.subtractInPlace;
}
if (!BabylonVector3.prototype.addScaledVector) {
  BabylonVector3.prototype.addScaledVector = function addScaledVector(value, scale) {
    this.x += value.x * scale;
    this.y += value.y * scale;
    this.z += value.z * scale;
    return this;
  };
}
if (!BabylonVector3.prototype.multiplyScalar) {
  BabylonVector3.prototype.multiplyScalar = BabylonVector3.prototype.scaleInPlace;
}
if (!BabylonVector3.prototype.lengthSq) {
  BabylonVector3.prototype.lengthSq = BabylonVector3.prototype.lengthSquared;
}

export function setBabylonRenderingContext(runtime) {
  activeRuntime = runtime;
}

export function decorateBabylonCamera(camera) {
  if (!camera || camera.__demStudioDecorated) return camera;
  camera.__demStudioDecorated = true;
  camera.metadata ||= {};
  camera.userData = camera.metadata;
  camera.updateMatrixWorld = () => camera.getViewMatrix(true);
  camera.updateProjectionMatrix = () => {
    activeRuntime?.updateCameraProjection();
    return camera.getProjectionMatrix(true);
  };
  camera.lookAt = (x, y, z) => {
    const target = typeof x === "object"
      ? x
      : new BabylonVector3(x, y, z);
    camera.setTarget(target);
    return camera;
  };
  Object.defineProperties(camera, {
    isPerspectiveCamera: {
      configurable: true,
      get: () => camera.mode === 0,
    },
    isOrthographicCamera: {
      configurable: true,
      get: () => camera.mode === 1,
    },
    zoom: {
      configurable: true,
      get: () => Number(camera.metadata.zoom || 1),
      set: value => {
        camera.metadata.zoom = Math.max(0.01, Number(value) || 1);
        activeRuntime?.updateCameraProjection();
      },
    },
    projectionMatrix: {
      configurable: true,
      get: () => camera.getProjectionMatrix(),
    },
    matrixWorldInverse: {
      configurable: true,
      get: () => camera.getViewMatrix(),
    },
    left: {
      configurable: true,
      get: () => camera.orthoLeft,
      set: value => {
        camera.orthoLeft = Number(value);
      },
    },
    right: {
      configurable: true,
      get: () => camera.orthoRight,
      set: value => {
        camera.orthoRight = Number(value);
      },
    },
    top: {
      configurable: true,
      get: () => camera.orthoTop,
      set: value => {
        camera.orthoTop = Number(value);
      },
    },
    bottom: {
      configurable: true,
      get: () => camera.orthoBottom,
      set: value => {
        camera.orthoBottom = Number(value);
      },
    },
    up: {
      configurable: true,
      get: () => camera.upVector,
      set: value => {
        camera.upVector = value;
      },
    },
  });
  return camera;
}

function scene() {
  if (!activeRuntime?.scene) {
    throw new Error("Babylon 渲染上下文尚未初始化");
  }
  return activeRuntime.scene;
}

function colorFrom(value, fallback = 0xffffff) {
  if (value instanceof Color3) return value.clone();
  let gammaColor;
  if (typeof value === "string") {
    const normalized = value.startsWith("#") ? value : `#${value}`;
    gammaColor = Color3.FromHexString(normalized);
  } else {
    const numeric = Number.isFinite(value) ? value : fallback;
    gammaColor = Color3.FromHexString(`#${Math.max(0, Math.min(0xffffff, numeric))
      .toString(16).padStart(6, "0")}`);
  }
  // CSS/hex colors are authored in sRGB. Three.js converted them into its
  // linear working space before shading; Babylon Color3.FromHexString does
  // not. Preserve that rendering semantic explicitly.
  return gammaColor.toLinearSpace(true);
}

if (!Color3.prototype.setHex) {
  Color3.prototype.setHex = function setHex(value) {
    return this.copyFrom(colorFrom(value));
  };
}
if (!Color3.prototype.set) {
  Color3.prototype.set = Color3.prototype.setHex;
}
if (!Color3.prototype.lerp) {
  Color3.prototype.lerp = function lerp(value, amount) {
    Color3.LerpToRef(this, colorFrom(value), Number(amount) || 0, this);
    return this;
  };
}
if (!Color3.prototype.multiplyScalar) {
  Color3.prototype.multiplyScalar = Color3.prototype.scaleInPlace;
}

if (!BabylonVector3.prototype.copy) {
  BabylonVector3.prototype.copy = function copy(value) {
    return this.copyFrom(value);
  };
}
if (!BabylonVector3.prototype.sub) {
  BabylonVector3.prototype.sub = function sub(value) {
    return this.subtractInPlace(value);
  };
}
if (!BabylonVector3.prototype.addScaledVector) {
  BabylonVector3.prototype.addScaledVector = function addScaledVector(value, scale) {
    this.x += value.x * scale;
    this.y += value.y * scale;
    this.z += value.z * scale;
    return this;
  };
}
if (!BabylonVector3.prototype.multiplyScalar) {
  BabylonVector3.prototype.multiplyScalar = BabylonVector3.prototype.scaleInPlace;
}
if (!BabylonVector3.prototype.lengthSq) {
  BabylonVector3.prototype.lengthSq = BabylonVector3.prototype.lengthSquared;
}
if (!BabylonVector3.prototype.distanceTo) {
  BabylonVector3.prototype.distanceTo = function distanceTo(value) {
    return BabylonVector3.Distance(this, value);
  };
}
const nativeBabylonVector3ToArray = BabylonVector3.prototype.toArray;
BabylonVector3.prototype.toArray = function toThreeCompatibleArray(array = [], offset = 0) {
  return nativeBabylonVector3ToArray.call(this, array, offset);
};

export class Vector2 extends BabylonVector2 {
  copy(value) {
    return this.copyFrom(value);
  }

  lengthSq() {
    return this.lengthSquared();
  }

  multiplyScalar(scale) {
    return this.scaleInPlace(scale);
  }

  toArray(array = [], offset = 0) {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    return array;
  }

  clone() {
    return new Vector2(this.x, this.y);
  }
}

export class Vector3 extends BabylonVector3 {
  copy(value) {
    return this.copyFrom(value);
  }

  sub(value) {
    return this.subtractInPlace(value);
  }

  add(value) {
    return this.addInPlace(value);
  }

  addScaledVector(value, scale) {
    this.x += value.x * scale;
    this.y += value.y * scale;
    this.z += value.z * scale;
    return this;
  }

  multiplyScalar(scale) {
    return this.scaleInPlace(scale);
  }

  lengthSq() {
    return this.lengthSquared();
  }

  applyQuaternion(quaternion) {
    quaternion.rotateVectorToRef(this, this);
    return this;
  }

  project(camera) {
    const projected = BabylonVector3.TransformCoordinates(
      this,
      camera.getTransformationMatrix(),
    );
    return this.copyFrom(projected);
  }

  toArray(array = [], offset = 0) {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    array[offset + 2] = this.z;
    return array;
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
}

export class Color extends Color3 {
  constructor(value = 0xffffff) {
    const parsed = colorFrom(value);
    super(parsed.r, parsed.g, parsed.b);
  }

  set(value) {
    return this.copyFrom(colorFrom(value));
  }

  setHex(value) {
    return this.set(value);
  }

  lerp(value, amount) {
    Color3.LerpToRef(this, colorFrom(value), Number(amount) || 0, this);
    return this;
  }

  multiplyScalar(scale) {
    return this.scaleInPlace(Number(scale) || 0);
  }

  clone() {
    const color = new Color();
    color.copyFrom(this);
    return color;
  }
}

export class Matrix4 extends Matrix {
  multiplyMatrices(left, right) {
    Matrix.MultiplyToRef(left, right, this);
    return this;
  }
}

export class Box3 {
  constructor(minimum = new Vector3(), maximum = new Vector3()) {
    this.min = minimum;
    this.max = maximum;
  }

  getCenter(target = new Vector3()) {
    target.x = (this.min.x + this.max.x) * 0.5;
    target.y = (this.min.y + this.max.y) * 0.5;
    target.z = (this.min.z + this.max.z) * 0.5;
    return target;
  }
}

export class Frustum {
  constructor() {
    this.planes = [];
  }

  setFromProjectionMatrix(matrix) {
    this.planes = BabylonFrustum.GetPlanes(matrix);
    return this;
  }

  intersectsBox(box) {
    for (const plane of this.planes) {
      const point = new BabylonVector3(
        plane.normal.x >= 0 ? box.max.x : box.min.x,
        plane.normal.y >= 0 ? box.max.y : box.min.y,
        plane.normal.z >= 0 ? box.max.z : box.min.z,
      );
      if (plane.dotCoordinate(point) < 0) {
        return false;
      }
    }
    return true;
  }
}

function typedAttributeArray(values, itemSize) {
  if (ArrayBuffer.isView(values)) return values;
  if (itemSize === 1 && values.some?.(value => value > 65535)) {
    return Uint32Array.from(values);
  }
  return Float32Array.from(values || []);
}

export class BufferAttribute {
  constructor(array, itemSize, normalized = false) {
    this.array = typedAttributeArray(array, itemSize);
    this.itemSize = Math.max(1, Number(itemSize) || 1);
    this.normalized = Boolean(normalized);
    this.count = Math.floor(this.array.length / this.itemSize);
    this._needsUpdate = false;
    this._onUpdate = null;
  }

  get needsUpdate() {
    return this._needsUpdate;
  }

  set needsUpdate(value) {
    this._needsUpdate = Boolean(value);
    if (this._needsUpdate) this._onUpdate?.(this);
  }

  getX(index) {
    return this.array[index * this.itemSize];
  }

  getY(index) {
    return this.array[index * this.itemSize + 1];
  }

  getZ(index) {
    return this.array[index * this.itemSize + 2];
  }

  setX(index, value) {
    this.array[index * this.itemSize] = value;
    return this;
  }

  setY(index, value) {
    this.array[index * this.itemSize + 1] = value;
    return this;
  }

  setZ(index, value) {
    this.array[index * this.itemSize + 2] = value;
    return this;
  }

  setXYZ(index, x, y, z) {
    const offset = index * this.itemSize;
    this.array[offset] = x;
    if (this.itemSize > 1) this.array[offset + 1] = y;
    if (this.itemSize > 2) this.array[offset + 2] = z;
    return this;
  }
}

export class Float32BufferAttribute extends BufferAttribute {
  constructor(array, itemSize, normalized = false) {
    super(array instanceof Float32Array ? array : Float32Array.from(array), itemSize, normalized);
  }
}

const ATTRIBUTE_KINDS = {
  position: VertexBuffer.PositionKind,
  normal: VertexBuffer.NormalKind,
  color: VertexBuffer.ColorKind,
  uv: VertexBuffer.UVKind,
};

export function toBabylonVertexColorData(attribute) {
  if (!attribute?.array || attribute.itemSize === 4) {
    return attribute?.array || new Float32Array();
  }
  if (attribute.itemSize !== 3) {
    throw new Error(
      `Babylon vertex colors require RGB or RGBA data; received itemSize=${attribute.itemSize}`,
    );
  }
  const colors = new Float32Array(attribute.count * 4);
  for (let index = 0; index < attribute.count; index++) {
    const source = index * 3;
    const target = index * 4;
    colors[target] = attribute.array[source];
    colors[target + 1] = attribute.array[source + 1];
    colors[target + 2] = attribute.array[source + 2];
    colors[target + 3] = 1;
  }
  return colors;
}

function babylonAttributeData(name, attribute) {
  return name === "color"
    ? toBabylonVertexColorData(attribute)
    : attribute.array;
}

function indexArray(values) {
  const array = values instanceof BufferAttribute ? values.array : values;
  if (array instanceof Uint32Array || array instanceof Uint16Array) return array;
  const maximum = Array.from(array || []).reduce(
    (result, value) => Math.max(result, Number(value) || 0),
    0,
  );
  return maximum > 65535
    ? Uint32Array.from(array || [])
    : Uint16Array.from(array || []);
}

export class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.index = null;
    this.groups = [];
    this._mesh = null;
    this._disposed = false;
  }

  setAttribute(name, attribute) {
    const safe = attribute instanceof BufferAttribute
      ? attribute
      : new BufferAttribute(attribute, 1);
    this.attributes[name] = safe;
    safe._onUpdate = () => this.#updateAttribute(name, safe);
    this.#updateAttribute(name, safe);
    return this;
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  setIndex(values) {
    this.index = values instanceof BufferAttribute
      ? values
      : new BufferAttribute(indexArray(values), 1);
    this.index.array = indexArray(this.index.array);
    this.index.count = this.index.array.length;
    this.index._onUpdate = () => this.#updateIndices();
    this.#updateIndices();
    return this;
  }

  getIndex() {
    return this.index;
  }

  addGroup(start, count, materialIndex = 0) {
    this.groups.push({
      start: Number(start) || 0,
      count: Number(count) || 0,
      materialIndex: Number(materialIndex) || 0,
    });
    this.#updateSubMeshes();
  }

  clearGroups() {
    this.groups.length = 0;
    this.#updateSubMeshes();
  }

  computeVertexNormals() {
    const position = this.attributes.position;
    if (!position || !this.index) return this;
    const normals = new Float32Array(position.count * 3);
    VertexData.ComputeNormals(position.array, this.index.array, normals);
    this.setAttribute("normal", new BufferAttribute(normals, 3));
    return this;
  }

  rotateX(angle) {
    const position = this.attributes.position;
    if (!position) return this;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let index = 0; index < position.count; index++) {
      const y = position.getY(index);
      const z = position.getZ(index);
      position.setY(index, y * cosine - z * sine);
      position.setZ(index, y * sine + z * cosine);
    }
    position.needsUpdate = true;
    const normal = this.attributes.normal;
    if (normal) {
      for (let index = 0; index < normal.count; index++) {
        const y = normal.getY(index);
        const z = normal.getZ(index);
        normal.setY(index, y * cosine - z * sine);
        normal.setZ(index, y * sine + z * cosine);
      }
      normal.needsUpdate = true;
    }
    return this;
  }

  applyToMesh(mesh) {
    this._mesh = mesh;
    const vertexData = new VertexData();
    vertexData.positions = this.attributes.position?.array || [];
    vertexData.indices = this.index?.array || [];
    if (this.attributes.normal) vertexData.normals = this.attributes.normal.array;
    if (this.attributes.uv) vertexData.uvs = this.attributes.uv.array;
    if (this.attributes.color) {
      vertexData.colors = toBabylonVertexColorData(this.attributes.color);
    }
    vertexData.applyToMesh(mesh, true);
    for (const [name, attribute] of Object.entries(this.attributes)) {
      if (ATTRIBUTE_KINDS[name]) continue;
      mesh.setVerticesData(
        name,
        attribute.array,
        true,
        attribute.itemSize,
      );
    }
    this.#updateSubMeshes();
    return this;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const mesh = this._mesh;
    this._mesh = null;
    if (mesh && !mesh.isDisposed()) {
      activeRuntime?.unregisterShadowCaster(mesh);
      mesh.dispose(false, false);
    }
  }

  #updateAttribute(name, attribute) {
    if (!this._mesh || this._mesh.isDisposed()) return;
    const kind = ATTRIBUTE_KINDS[name] || name;
    const data = babylonAttributeData(name, attribute);
    const itemSize = name === "color" ? 4 : attribute.itemSize;
    if (this._mesh.isVerticesDataPresent(kind)) {
      this._mesh.updateVerticesData(kind, data, false, false);
    } else {
      this._mesh.setVerticesData(kind, data, true, itemSize);
    }
  }

  #updateIndices() {
    if (!this._mesh || this._mesh.isDisposed() || !this.index) return;
    this._mesh.updateIndices(this.index.array, 0, true);
    this.#updateSubMeshes();
  }

  #updateSubMeshes() {
    const mesh = this._mesh;
    if (!mesh || mesh.isDisposed() || !this.index) return;
    mesh.subMeshes = [];
    const positionCount = this.attributes.position?.count || 0;
    const groups = this.groups.length
      ? this.groups
      : [{ start: 0, count: this.index.count, materialIndex: 0 }];
    for (const group of groups) {
      if (group.count <= 0) continue;
      new SubMesh(
        group.materialIndex,
        0,
        positionCount,
        group.start,
        group.count,
        mesh,
        mesh,
        true,
        true,
      );
    }
  }
}

export class PlaneGeometry extends BufferGeometry {
  constructor(width = 1, height = 1) {
    super();
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    this.setAttribute("position", new Float32BufferAttribute([
      -halfWidth, -halfHeight, 0,
      halfWidth, -halfHeight, 0,
      halfWidth, halfHeight, 0,
      -halfWidth, halfHeight, 0,
    ], 3));
    this.setAttribute("normal", new Float32BufferAttribute([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ], 3));
    this.setAttribute("uv", new Float32BufferAttribute([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ], 2));
    this.setIndex([0, 1, 2, 0, 2, 3]);
    this.addGroup(0, 6, 0);
  }
}

function installMaterialAliases(material, options) {
  material.userData = material.metadata || {};
  material.metadata = material.userData;
  material.userData.useVertexColors = Boolean(options.vertexColors);
  material.wireframe = Boolean(options.wireframe);
  material.backFaceCulling = options.side !== DoubleSide;
  // Terrain indices retain the established DEM winding while the Babylon
  // scene is right-handed. Disabling culling is sufficient for boundary
  // walls; twoSidedLighting would additionally flip authored upward normals
  // on back-facing top triangles and make the directional key contribute 0.
  material.twoSidedLighting = Boolean(options.twoSidedLighting);
  material.alpha = options.opacity == null ? 1 : Number(options.opacity);
  material.transparencyMode = material.alpha < 1 || options.transparent
    ? PBRMaterial.PBRMATERIAL_ALPHABLEND
    : PBRMaterial.PBRMATERIAL_OPAQUE;
  material.zOffset = options.polygonOffsetFactor || 0;
  Object.defineProperties(material, {
    color: {
      configurable: true,
      get: () => material.albedoColor || material.diffuseColor,
      set: value => {
        const parsed = colorFrom(value);
        if ("albedoColor" in material) material.albedoColor = parsed;
        else material.diffuseColor = parsed;
      },
    },
    map: {
      configurable: true,
      get: () => material.albedoTexture || material.diffuseTexture,
      set: value => {
        if ("albedoTexture" in material) material.albedoTexture = value;
        else material.diffuseTexture = value;
      },
    },
    normalMap: {
      configurable: true,
      get: () => material.bumpTexture,
      set: value => {
        material.bumpTexture = value;
      },
    },
    opacity: {
      configurable: true,
      get: () => material.alpha,
      set: value => {
        material.alpha = Number(value);
      },
    },
    needsUpdate: {
      configurable: true,
      get: () => false,
      set: value => {
        if (value) material.markDirty();
      },
    },
  });
  material.normalScale = new Vector2(1, 1);
  return material;
}

export class MeshStandardMaterial extends PBRMaterial {
  constructor(options = {}) {
    super(`dem-pbr-${++sequence}`, scene());
    this.albedoColor = colorFrom(options.color);
    this.emissiveColor = colorFrom(options.emissive, 0x000000);
    this.roughness = Number(options.roughness ?? 0.82);
    this.metallic = Number(options.metalness ?? 0.015);
    this.environmentIntensity = Number(options.envMapIntensity ?? 0.72);
    installMaterialAliases(this, options);
  }
}

export class MeshMatcapMaterial extends MeshStandardMaterial {
  constructor(options = {}) {
    super({
      ...options,
      roughness: 0.72,
      metalness: 0,
    });
    this.unlit = false;
    this.matcap = options.matcap || null;
  }
}

export class MeshBasicMaterial extends StandardMaterial {
  constructor(options = {}) {
    super(`dem-basic-${++sequence}`, scene());
    this.diffuseColor = colorFrom(options.color);
    this.disableLighting = true;
    this.useVertexColor = Boolean(options.vertexColors);
    installMaterialAliases(this, options);
  }
}

export class ShadowMaterial extends PBRMaterial {
  constructor(options = {}) {
    super(`dem-shadow-${++sequence}`, scene());
    this.albedoColor = colorFrom(options.color, 0x545454);
    this.metallic = 0;
    this.roughness = 1;
    installMaterialAliases(this, {
      ...options,
      transparent: true,
      opacity: options.opacity ?? 0.22,
    });
  }
}

function translateLegacyShaderSource(source, stage) {
  let translated = String(source || "")
    .replace(/\bmodelMatrix\b/g, "world")
    .replace(/\bviewMatrix\b/g, "view")
    .replace(/\bprojectionMatrix\b/g, "projection");
  const declarations = ["precision highp float;"];
  if (stage === "vertex") {
    declarations.push(
      "attribute vec3 position;",
      "uniform mat4 world;",
      "uniform mat4 view;",
      "uniform mat4 projection;",
    );
  } else if (/\bcameraPosition\b/.test(translated)) {
    declarations.push("uniform vec3 cameraPosition;");
  }
  return `${declarations.join("\n")}\n${translated}`;
}

function bindLegacyShaderUniform(material, name, value) {
  if (value == null) return;
  if (typeof value === "number") {
    material.setFloat(name, value);
  } else if (value instanceof Color3) {
    material.setColor3(name, value);
  } else if (value instanceof BabylonVector2) {
    material.setVector2(name, value);
  } else if (value instanceof BabylonVector3) {
    material.setVector3(name, value);
  } else if (value?.getInternalTexture || value?.isReady) {
    material.setTexture(name, value);
  }
}

export class ShaderMaterial extends BabylonShaderMaterial {
  constructor(options = {}) {
    const legacyUniforms = options.uniforms || {};
    const uniformNames = Object.keys(legacyUniforms);
    const declaredSamplers = [
      ...String(options.fragmentShader || "").matchAll(
        /\buniform\s+sampler(?:2D|Cube)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g,
      ),
    ].map(match => match[1]);
    const samplerNames = [...new Set([
      ...declaredSamplers,
      ...uniformNames.filter(name => {
      const value = legacyUniforms[name]?.value;
      return value?.getInternalTexture || value?.isReady;
      }),
    ])];
    super(
      `dem-shader-${++sequence}`,
      scene(),
      {
        vertexSource: translateLegacyShaderSource(options.vertexShader, "vertex"),
        fragmentSource: translateLegacyShaderSource(options.fragmentShader, "fragment"),
        spectorName: "dem-studio-local-shader",
      },
      {
        attributes: ["position"],
        uniforms: [
          "world",
          "view",
          "projection",
          "cameraPosition",
          ...uniformNames.filter(name => !samplerNames.includes(name)),
        ],
        samplers: samplerNames,
        needAlphaBlending: Boolean(options.transparent),
        needAlphaTesting: false,
      },
    );
    this.uniforms = legacyUniforms;
    this.isShaderMaterial = true;
    this.userData = this.metadata || {};
    this.metadata = this.userData;
    this.backFaceCulling = options.side !== DoubleSide;
    this.alphaMode = options.transparent
      ? Constants.ALPHA_COMBINE
      : Constants.ALPHA_DISABLE;
    this.disableDepthWrite = options.depthWrite === false;
    this.disableDepthTest = options.depthTest === false;
    this.userData.shaderSource = {
      vertex: options.vertexShader || "",
      fragment: options.fragmentShader || "",
    };
    this.onBindObservable.add(() => {
      for (const [name, uniform] of Object.entries(this.uniforms)) {
        bindLegacyShaderUniform(this, name, uniform?.value);
      }
    });
  }
}

export class HemisphereLight extends BabylonHemisphericLight {
  constructor(skyColor = 0xffffff, groundColor = 0x808080, intensity = 1) {
    super(
      `dem-hemisphere-${++sequence}`,
      new BabylonVector3(0, 1, 0),
      scene(),
    );
    this.diffuse = colorFrom(skyColor);
    this.groundColor = colorFrom(groundColor);
    this.intensity = Number(intensity) || 0;
    this.color = this.diffuse;
  }
}

export class DirectionalLight extends BabylonDirectionalLight {
  constructor(color = 0xffffff, intensity = 1) {
    super(
      `dem-directional-${++sequence}`,
      new BabylonVector3(-0.45, -0.82, -0.36),
      scene(),
    );
    this.diffuse = colorFrom(color);
    this.color = this.diffuse;
    this.intensity = Number(intensity) || 0;
    this.target = new TransformNode(`dem-light-target-${sequence}`, scene());
    this.shadow = {
      mapSize: new Vector2(2048, 2048),
      camera: {
        near: 0.1,
        far: 90,
        left: -10,
        right: 10,
        top: 10,
        bottom: -10,
        updateProjectionMatrix() {},
      },
      bias: -0.00018,
      normalBias: 0.012,
      radius: 7,
      blurSamples: 8,
      needsUpdate: true,
    };
    Object.defineProperty(this, "castShadow", {
      configurable: true,
      get: () => Boolean(this.metadata?.castShadow),
      set: value => {
        this.metadata ||= {};
        this.metadata.castShadow = Boolean(value);
        this.shadowEnabled = Boolean(value);
      },
    });
  }
}

// Compatibility name retained for the existing scene orchestration. Babylon's
// native RectAreaLight requires LTC data that is CDN-backed by default. The
// offline runtime uses a non-shadowing directional fill: unlike a point light,
// its illumination does not collapse with terrain scale or source distance.
export class RectAreaLight extends BabylonDirectionalLight {
  constructor(color = 0xffffff, intensity = 1, width = 1, height = 1) {
    super(
      `dem-soft-directional-${++sequence}`,
      new BabylonVector3(0, -1, 0),
      scene(),
    );
    this.diffuse = colorFrom(color);
    this.color = this.diffuse;
    this.intensity = Number(intensity) || 0;
    this.width = Number(width) || 1;
    this.height = Number(height) || 1;
    this.radius = Math.max(this.width, this.height) * 0.5;
    this.type = "DirectionalLight";
    this.castShadow = false;
  }

  lookAt(x, y, z) {
    const target = typeof x === "object"
      ? x
      : new BabylonVector3(x, y, z);
    this.direction.copyFrom(target).subtractInPlace(this.position).normalize();
    this.metadata ||= {};
    this.metadata.target = target.clone?.() || target;
  }
}

function applyMaterialToMesh(mesh, material) {
  if (!Array.isArray(material)) {
    mesh.material = material;
    mesh.userData.sourceMaterials = [material];
    return;
  }
  const multi = new MultiMaterial(`dem-multi-${++sequence}`, scene());
  multi.subMaterials = material;
  mesh.material = multi;
  mesh.userData.sourceMaterials = material;
}

export class Mesh extends BabylonMesh {
  constructor(geometry, material) {
    super(`dem-mesh-${++sequence}`, scene());
    this.demGeometry = geometry;
    this.userData = this.metadata || {};
    this.metadata = this.userData;
    this.isMesh = true;
    applyMaterialToMesh(this, material);
    geometry?.applyToMesh(this);
    this.useVertexColors = Boolean(
      geometry?.attributes?.color
      && this.userData.sourceMaterials?.some(
        sourceMaterial => sourceMaterial?.userData?.useVertexColors,
      ),
    );
    Object.defineProperties(this, {
      visible: {
        configurable: true,
        get: () => this.isVisible,
        set: value => {
          this.isVisible = Boolean(value);
        },
      },
      renderOrder: {
        configurable: true,
        get: () => this.renderingGroupId,
        set: value => {
          this.renderingGroupId = Math.max(0, Math.min(3, Number(value) || 0));
        },
      },
      frustumCulled: {
        configurable: true,
        get: () => !this.alwaysSelectAsActiveMesh,
        set: value => {
          this.alwaysSelectAsActiveMesh = !value;
        },
      },
      receiveShadow: {
        configurable: true,
        get: () => this.receiveShadows,
        set: value => {
          this.receiveShadows = Boolean(value);
        },
      },
      castShadow: {
        configurable: true,
        get: () => Boolean(this.userData.castShadow),
        set: value => {
          this.userData.castShadow = Boolean(value);
          if (value) activeRuntime?.registerShadowCaster(this);
          else activeRuntime?.unregisterShadowCaster(this);
        },
      },
    });
  }

  traverse(callback) {
    callback(this);
    for (const child of this.getChildren()) child.traverse?.(callback);
  }
}

export class Group extends TransformNode {
  constructor() {
    super(`dem-group-${++sequence}`, scene());
    this.userData = this.metadata || {};
    this.metadata = this.userData;
    Object.defineProperty(this, "visible", {
      configurable: true,
      get: () => this.isEnabled(),
      set: value => this.setEnabled(Boolean(value)),
    });
  }

  add(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parent = this;
      node.setEnabled?.(true);
    }
    return this;
  }

  remove(node) {
    if (node?.parent === this) node.parent = null;
    return this;
  }

  traverse(callback) {
    callback(this);
    for (const child of this.getChildren()) {
      if (typeof child.traverse === "function") child.traverse(callback);
      else callback(child);
    }
  }
}

function installTextureAliases(texture, image = null) {
  texture.image = image;
  const repeat = new Vector2(texture.uScale || 1, texture.vScale || 1);
  const offset = new Vector2(texture.uOffset || 0, texture.vOffset || 0);
  const repeatSet = repeat.set.bind(repeat);
  repeat.set = (x, y) => {
    repeatSet(x, y);
    texture.uScale = x;
    texture.vScale = y;
    return repeat;
  };
  const offsetSet = offset.set.bind(offset);
  offset.set = (x, y) => {
    offsetSet(x, y);
    texture.uOffset = x;
    texture.vOffset = y;
    return offset;
  };
  texture.repeat = repeat;
  texture.offset = offset;
  Object.defineProperty(texture, "needsUpdate", {
    configurable: true,
    get: () => false,
    set: value => {
      if (value && texture.update) texture.update(false);
    },
  });
  return texture;
}

export class DataTexture {
  constructor(data, width, height) {
    const texture = RawTexture.CreateRGBATexture(
      data,
      width,
      height,
      scene(),
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
      0,
      false,
    );
    return installTextureAliases(texture, { data, width, height });
  }
}

export class CanvasTexture {
  constructor(canvas) {
    const texture = new DynamicTexture(
      `dem-canvas-${++sequence}`,
      canvas,
      scene(),
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTUREFORMAT_RGBA,
      false,
    );
    texture.update(false);
    return installTextureAliases(texture, canvas);
  }
}

export function configureTerrainMaterial(material, options = {}) {
  return attachDemTerrainMaterialPlugin(material, options);
}

export const MathUtils = {
  degToRad(value) {
    return Number(value) * Math.PI / 180;
  },
};

export const DoubleSide = 2;
export const ClampToEdgeWrapping = Texture.CLAMP_ADDRESSMODE;
export const LinearFilter = Texture.BILINEAR_SAMPLINGMODE;
export const LinearMipmapLinearFilter = Texture.TRILINEAR_SAMPLINGMODE;
export const SRGBColorSpace = "srgb";
export const NoColorSpace = "linear";
export const RGBAFormat = Constants.TEXTUREFORMAT_RGBA;
export const UnsignedByteType = Constants.TEXTURETYPE_UNSIGNED_BYTE;
export const HalfFloatType = Constants.TEXTURETYPE_HALF_FLOAT;
export const PCFShadowMap = "PCF";
export const PCFSoftShadowMap = "PCSS";
export const VSMShadowMap = "VSM";
export const ACESToneMapping = "aces";
export const NeutralToneMapping = "neutral";

export function materialGpuTextureBytes(material) {
  let bytes = 0;
  for (const texture of material?.getActiveTextures?.() || []) {
    const size = texture.getSize?.();
    if (size?.width && size?.height) bytes += size.width * size.height * 4;
  }
  return bytes;
}

export function color4FromHex(value, alpha = 1) {
  const color = colorFrom(value);
  return new Color4(color.r, color.g, color.b, alpha);
}

export function getActiveRuntime() {
  return activeRuntime;
}

export { Quaternion };
