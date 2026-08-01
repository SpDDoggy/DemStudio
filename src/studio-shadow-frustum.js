const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

function normalize(vector, fallback) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-9) return [...fallback];
  return vector.map(value => value / length);
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

export function fitDirectionalShadowFrustum({
  bounds,
  lightDirection,
  mapSize = 2048,
  padding = 0.08,
} = {}) {
  const minimum = (bounds?.min || [-1, 0, -1]).map(value => finite(value));
  const maximum = (bounds?.max || [1, 1, 1]).map((value, index) =>
    Math.max(minimum[index], finite(value, minimum[index] + 1)));
  const forward = normalize(lightDirection || [-0.5, -0.8, -0.3], [-0.5, -0.8, -0.3]);
  const upReference = Math.abs(forward[1]) > 0.94 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(upReference, forward), [1, 0, 0]);
  const up = normalize(cross(forward, right), [0, 1, 0]);
  const corners = [];
  for (const x of [minimum[0], maximum[0]]) {
    for (const y of [minimum[1], maximum[1]]) {
      for (const z of [minimum[2], maximum[2]]) corners.push([x, y, z]);
    }
  }
  const projected = corners.map(point => [
    dot(point, right),
    dot(point, up),
    dot(point, forward),
  ]);
  const ranges = [0, 1, 2].map(axis => ({
    min: Math.min(...projected.map(point => point[axis])),
    max: Math.max(...projected.map(point => point[axis])),
  }));
  const spanX = Math.max(1e-4, ranges[0].max - ranges[0].min);
  const spanY = Math.max(1e-4, ranges[1].max - ranges[1].min);
  const pad = Math.max(0, finite(padding, 0.08));
  const width = spanX * (1 + pad * 2);
  const height = spanY * (1 + pad * 2);
  const safeMapSize = Math.max(1, Math.round(finite(mapSize, 2048)));
  const texelX = width / safeMapSize;
  const texelY = height / safeMapSize;
  const rawCenterX = (ranges[0].min + ranges[0].max) * 0.5;
  const rawCenterY = (ranges[1].min + ranges[1].max) * 0.5;
  const centerX = Math.round(rawCenterX / texelX) * texelX;
  const centerY = Math.round(rawCenterY / texelY) * texelY;
  const depthSpan = Math.max(1e-4, ranges[2].max - ranges[2].min);
  return {
    left: centerX - width * 0.5,
    right: centerX + width * 0.5,
    bottom: centerY - height * 0.5,
    top: centerY + height * 0.5,
    near: Math.max(0.001, depthSpan * 0.02),
    far: Math.max(0.01, depthSpan * (1.2 + pad * 2)),
    texelX,
    texelY,
    centerX,
    centerY,
    basis: { right, up, forward },
  };
}
