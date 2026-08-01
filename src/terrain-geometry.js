export function computeDemGradientNormals(
  heights,
  cols,
  rows,
  worldW,
  worldD,
  heightScale,
  validMask = null,
) {
  if (!heights || heights.length !== cols * rows || cols < 2 || rows < 2) {
    throw new Error("Invalid DEM gradient grid");
  }
  const normals = new Float32Array(cols * rows * 3);
  const cellX = Math.max(1e-8, worldW / Math.max(1, cols - 1));
  const cellZ = Math.max(1e-8, worldD / Math.max(1, rows - 1));
  const isValid = index =>
    !validMask || validMask.length !== heights.length || validMask[index] !== 0;
  const valueAt = (x, y, fallback) => {
    const safeX = Math.max(0, Math.min(cols - 1, x));
    const safeY = Math.max(0, Math.min(rows - 1, y));
    const index = safeY * cols + safeX;
    return isValid(index) ? heights[index] : fallback;
  };

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      const offset = index * 3;
      if (!isValid(index)) {
        normals[offset + 1] = 1;
        continue;
      }
      const center = heights[index];
      const left = valueAt(x - 1, y - 1, center)
        + 2 * valueAt(x - 1, y, center)
        + valueAt(x - 1, y + 1, center);
      const right = valueAt(x + 1, y - 1, center)
        + 2 * valueAt(x + 1, y, center)
        + valueAt(x + 1, y + 1, center);
      const up = valueAt(x - 1, y - 1, center)
        + 2 * valueAt(x, y - 1, center)
        + valueAt(x + 1, y - 1, center);
      const down = valueAt(x - 1, y + 1, center)
        + 2 * valueAt(x, y + 1, center)
        + valueAt(x + 1, y + 1, center);
      const dx = (right - left) * heightScale / (8 * cellX);
      const dz = (down - up) * heightScale / (8 * cellZ);
      const inverseLength = 1 / Math.hypot(dx, 1, dz);
      normals[offset] = -dx * inverseLength;
      normals[offset + 1] = inverseLength;
      normals[offset + 2] = -dz * inverseLength;
    }
  }
  return normals;
}
