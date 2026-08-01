export const TERRAIN_GPU_BUDGET_BYTES = 192 * 1024 * 1024;
export const TERRAIN_BASE_MAX_LEVEL = 3;

export function tileCoordinateKey(level, x, y) {
  return `${level}/${x}/${y}`;
}

export function enumerateLevelTiles(level) {
  const safeLevel = Math.max(0, Math.trunc(Number(level) || 0));
  const side = 2 ** safeLevel;
  const tiles = [];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      tiles.push({
        level: safeLevel,
        x,
        y,
        coordinateKey: tileCoordinateKey(safeLevel, x, y),
      });
    }
  }
  return tiles;
}

export class TerrainResidency {
  constructor(options = {}) {
    this.gpuBudgetBytes = Number(options.gpuBudgetBytes)
      || TERRAIN_GPU_BUDGET_BYTES;
    this.reset(options);
  }

  reset(options = {}) {
    this.datasetRevision = Number(options.datasetRevision) || 0;
    this.baseSignature = String(options.baseSignature || "");
    this.targetMaxLevel = Math.max(0, Math.trunc(
      Number(options.targetMaxLevel) || 0,
    ));
    this.baseLevel = Math.min(TERRAIN_BASE_MAX_LEVEL, this.targetMaxLevel);
    this.requiredBaseTiles = new Map();
    this.readyBaseTiles = new Map();
    this.desiredRefinementTiles = new Map();
    this.residentRefinementTiles = new Map();
    this.inflightBaseTiles = new Set();
    this.inflightRefinementTiles = new Set();
    this.clock = 0;
    this.overviewGpuBytes = Math.max(0, Number(options.overviewGpuBytes) || 0);
    this.textureGpuBytes = Math.max(0, Number(options.textureGpuBytes) || 0);
    this.baseGpuBytes = 0;
    this.refinementGpuBytes = 0;
    this.counters = {
      baseSamples: 0,
      baseBuilds: 0,
      baseUploads: 0,
      baseDisposals: 0,
      refinementSamples: 0,
      refinementBuilds: 0,
      refinementUploads: 0,
      refinementDisposals: 0,
      refinementCacheHits: 0,
      refinementEvictions: 0,
    };
    for (const tile of enumerateLevelTiles(this.baseLevel)) {
      this.requiredBaseTiles.set(tile.coordinateKey, {
        ...tile,
        priority: 0,
        state: "required",
      });
    }
  }

  canAdoptCompatibleBase(previous) {
    return previous instanceof TerrainResidency
      && previous.baseLevel === this.baseLevel
      && previous.baseSignature === this.baseSignature;
  }

  adoptCompatibleResidency(previous) {
    if (!this.canAdoptCompatibleBase(previous)) return false;
    for (const [coordinateKey, record] of previous.readyBaseTiles) {
      if (!this.requiredBaseTiles.has(coordinateKey)) continue;
      this.readyBaseTiles.set(coordinateKey, record);
      this.baseGpuBytes += Math.max(0, Number(record.gpuBytes) || 0);
    }
    for (const [coordinateKey, record] of previous.residentRefinementTiles) {
      const level = Math.max(
        0,
        Math.trunc(Number(record?.tile?.level ?? coordinateKey.split("/")[0]) || 0),
      );
      if (level > this.targetMaxLevel) continue;
      this.residentRefinementTiles.set(coordinateKey, record);
      this.refinementGpuBytes += Math.max(0, Number(record.gpuBytes) || 0);
    }
    for (const coordinateKey of previous.inflightBaseTiles) {
      if (this.requiredBaseTiles.has(coordinateKey)) {
        this.inflightBaseTiles.add(coordinateKey);
      }
    }
    for (const coordinateKey of previous.inflightRefinementTiles) {
      const level = Math.max(
        0,
        Math.trunc(Number(coordinateKey.split("/")[0]) || 0),
      );
      if (level <= this.targetMaxLevel) {
        this.inflightRefinementTiles.add(coordinateKey);
      }
    }
    this.clock = previous.clock;
    this.counters = { ...previous.counters };
    return true;
  }

  setBasePriority(coordinateKey, priority) {
    const record = this.requiredBaseTiles.get(coordinateKey);
    if (!record || this.readyBaseTiles.has(coordinateKey)) return;
    record.priority = Number(priority) || 0;
  }

  beginSample(kind, coordinateKey) {
    const inflight = kind === "base"
      ? this.inflightBaseTiles
      : this.inflightRefinementTiles;
    if (inflight.has(coordinateKey)) return false;
    inflight.add(coordinateKey);
    if (kind === "base") this.counters.baseSamples++;
    else this.counters.refinementSamples++;
    return true;
  }

  finishSample(kind, coordinateKey) {
    const inflight = kind === "base"
      ? this.inflightBaseTiles
      : this.inflightRefinementTiles;
    inflight.delete(coordinateKey);
  }

  markBaseReady(coordinateKey, record = {}) {
    if (!this.requiredBaseTiles.has(coordinateKey)) {
      throw new Error(`未知基座瓦片：${coordinateKey}`);
    }
    const previous = this.readyBaseTiles.get(coordinateKey);
    if (previous) this.baseGpuBytes -= Number(previous.gpuBytes) || 0;
    const next = {
      ...this.requiredBaseTiles.get(coordinateKey),
      ...record,
      state: record.empty ? "empty" : "ready",
      gpuBytes: Math.max(0, Number(record.gpuBytes) || 0),
      touchedAt: ++this.clock,
    };
    this.readyBaseTiles.set(coordinateKey, next);
    this.baseGpuBytes += next.gpuBytes;
    this.counters.baseBuilds++;
    if (next.gpuBytes > 0 && next.mesh) this.counters.baseUploads++;
    return next;
  }

  setDesiredRefinements(tiles) {
    this.desiredRefinementTiles.clear();
    for (const tile of tiles || []) {
      const coordinateKey = tile.coordinateKey
        || tileCoordinateKey(tile.level, tile.x ?? tile.tileX, tile.y ?? tile.tileY);
      this.desiredRefinementTiles.set(coordinateKey, {
        ...tile,
        coordinateKey,
      });
      this.touchRefinement(coordinateKey, true);
    }
  }

  markRefinementResident(coordinateKey, record = {}) {
    const previous = this.residentRefinementTiles.get(coordinateKey);
    if (previous) this.refinementGpuBytes -= Number(previous.gpuBytes) || 0;
    const next = {
      ...record,
      coordinateKey,
      gpuBytes: Math.max(0, Number(record.gpuBytes) || 0),
      visible: this.desiredRefinementTiles.has(coordinateKey),
      touchedAt: ++this.clock,
    };
    this.residentRefinementTiles.delete(coordinateKey);
    this.residentRefinementTiles.set(coordinateKey, next);
    this.refinementGpuBytes += next.gpuBytes;
    this.counters.refinementBuilds++;
    this.counters.refinementUploads++;
    return next;
  }

  touchRefinement(coordinateKey, cacheHit = false) {
    const record = this.residentRefinementTiles.get(coordinateKey);
    if (!record) return null;
    this.residentRefinementTiles.delete(coordinateKey);
    record.touchedAt = ++this.clock;
    record.visible = this.desiredRefinementTiles.has(coordinateKey);
    this.residentRefinementTiles.set(coordinateKey, record);
    if (cacheHit) this.counters.refinementCacheHits++;
    return record;
  }

  updateRefinementVisibility() {
    for (const [coordinateKey, record] of this.residentRefinementTiles) {
      record.visible = this.desiredRefinementTiles.has(coordinateKey);
    }
  }

  evictRefinements(dispose) {
    this.updateRefinementVisibility();
    const evicted = [];
    while (this.totalGpuBytes > this.gpuBudgetBytes) {
      const candidate = [...this.residentRefinementTiles.values()]
        .filter(record => !record.visible)
        .sort((left, right) => left.touchedAt - right.touchedAt)[0];
      if (!candidate) break;
      this.residentRefinementTiles.delete(candidate.coordinateKey);
      this.refinementGpuBytes = Math.max(
        0,
        this.refinementGpuBytes - candidate.gpuBytes,
      );
      this.counters.refinementDisposals++;
      this.counters.refinementEvictions++;
      dispose?.(candidate);
      evicted.push(candidate.coordinateKey);
    }
    return evicted;
  }

  get baseComplete() {
    return this.requiredBaseTiles.size > 0
      && this.readyBaseTiles.size === this.requiredBaseTiles.size;
  }

  get totalGpuBytes() {
    return this.overviewGpuBytes
      + this.textureGpuBytes
      + this.baseGpuBytes
      + this.refinementGpuBytes;
  }

  diagnostics() {
    const emptyBaseTileCount = [...this.readyBaseTiles.values()]
      .filter(record => record.state === "empty").length;
    return {
      targetMaxLevel: this.targetMaxLevel,
      baseLevel: this.baseLevel,
      requiredBaseTileCount: this.requiredBaseTiles.size,
      readyBaseTileCount: this.readyBaseTiles.size,
      emptyBaseTileCount,
      baseComplete: this.baseComplete,
      desiredRefinementTileCount: this.desiredRefinementTiles.size,
      residentRefinementTileCount: this.residentRefinementTiles.size,
      visibleResidentRefinementTileCount: [...this.residentRefinementTiles.values()]
        .filter(record => record.visible).length,
      inflightBaseTileCount: this.inflightBaseTiles.size,
      inflightRefinementTileCount: this.inflightRefinementTiles.size,
      overviewGpuBytes: this.overviewGpuBytes,
      textureGpuBytes: this.textureGpuBytes,
      baseGpuBytes: this.baseGpuBytes,
      refinementGpuBytes: this.refinementGpuBytes,
      gpuBytes: this.totalGpuBytes,
      gpuBudgetBytes: this.gpuBudgetBytes,
      ...this.counters,
    };
  }
}
