const clamp01 = value => Math.max(0, Math.min(1, Number(value)));

export const STUDIO_ENVIRONMENT_FACE_SIZE = 32;

export function parseHexColor(value, fallback = "#d3dbe5") {
  const source = /^#[0-9a-f]{6}$/i.test(String(value || ""))
    ? String(value)
    : fallback;
  return [
    Number.parseInt(source.slice(1, 3), 16) / 255,
    Number.parseInt(source.slice(3, 5), 16) / 255,
    Number.parseInt(source.slice(5, 7), 16) / 255,
  ];
}

function normalize3([x, y, z]) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function cubeDirection(face, u, v) {
  const mappings = {
    right: [1, -v, -u],
    left: [-1, -v, u],
    up: [u, 1, v],
    down: [u, -1, -v],
    front: [u, -v, 1],
    back: [-u, -v, -1],
  };
  return normalize3(mappings[face]);
}

function mix(left, right, amount) {
  return left.map((value, index) => value * (1 - amount) + right[index] * amount);
}

function studioRadiance(direction, floorColor) {
  const [x, y, z] = direction;
  const upper = [0.88, 0.91, 0.95];
  const sideCool = [0.66, 0.71, 0.78];
  const sideWarm = [0.74, 0.72, 0.68];
  const sideDirection = clamp01(0.5 + 0.5 * (x * 0.78 + z * 0.36));
  const side = mix(sideCool, sideWarm, sideDirection);
  if (y >= 0) {
    const skyAmount = Math.pow(y, 0.72);
    const broadKey = 0.05 * Math.max(0, x * 0.7 + z * 0.3);
    return mix(side, upper, skyAmount).map(value => clamp01(value + broadKey));
  }
  const groundAmount = Math.pow(-y, 0.78);
  const groundBounce = floorColor.map(value => value * 0.56);
  return mix(side.map(value => value * 0.72), groundBounce, groundAmount);
}

export function createStudioEnvironmentCube({
  size = STUDIO_ENVIRONMENT_FACE_SIZE,
  floorColor = "#d3dbe5",
} = {}) {
  const safeSize = Math.max(4, Math.round(Number(size) || STUDIO_ENVIRONMENT_FACE_SIZE));
  const parsedFloor = parseHexColor(floorColor);
  const faces = {};
  for (const face of ["right", "left", "up", "down", "front", "back"]) {
    const pixels = new Uint8Array(safeSize * safeSize * 4);
    for (let row = 0; row < safeSize; row++) {
      for (let column = 0; column < safeSize; column++) {
        const u = ((column + 0.5) / safeSize) * 2 - 1;
        const v = ((row + 0.5) / safeSize) * 2 - 1;
        const color = studioRadiance(cubeDirection(face, u, v), parsedFloor);
        const offset = (row * safeSize + column) * 4;
        pixels[offset] = Math.round(clamp01(color[0]) * 255);
        pixels[offset + 1] = Math.round(clamp01(color[1]) * 255);
        pixels[offset + 2] = Math.round(clamp01(color[2]) * 255);
        pixels[offset + 3] = 255;
      }
    }
    faces[face] = pixels;
  }
  return { ...faces, size: safeSize };
}

export function averageFaceEnergy(face) {
  if (!face?.length) return 0;
  let energy = 0;
  for (let offset = 0; offset < face.length; offset += 4) {
    energy += (
      face[offset] * 0.2126
      + face[offset + 1] * 0.7152
      + face[offset + 2] * 0.0722
    ) / 255;
  }
  return energy / (face.length / 4);
}
