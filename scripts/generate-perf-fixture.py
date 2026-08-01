#!/usr/bin/env python3
"""Stream a deterministic, tiled Float32 GeoTIFF for DEM performance tests.

The generator intentionally keeps only one TIFF tile in memory.  It writes a
classic little-endian TIFF with Adobe Deflate-compressed 512 x 512 tiles so the
runtime exercises the same random-access path used by real large DEMs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import time
import zlib
from pathlib import Path

import numpy as np


DEFAULT_WIDTH = 10_000
DEFAULT_HEIGHT = 10_000
DEFAULT_TILE_SIZE = 512
DEFAULT_SEED = 20_260_729
NODATA = -9999.0
PROBE_COORDINATES = (
    (0, 0),
    (9999, 0),
    (0, 9999),
    (9999, 9999),
    (2500, 3000),
    (5000, 5000),
    (6800, 2600),  # deterministic NoData lake
    (8123, 7456),
)


def terrain_values(x: np.ndarray, y: np.ndarray, seed: int) -> np.ndarray:
    """Return deterministic terrain values without global raster allocation."""
    phase = (seed % 10_000) / 10_000.0 * math.tau
    values = (
        920.0
        + 275.0 * np.sin(x * 0.0047 + phase) * np.cos(y * 0.0039 - phase * 0.4)
        + 145.0 * np.sin((x + y) * 0.0127 + phase * 0.7)
        + 78.0 * np.cos((x - 1.35 * y) * 0.0211)
    )
    for center_x, center_y, amplitude, sigma in (
        (2500.0, 3000.0, 720.0, 920.0),
        (7350.0, 6400.0, 540.0, 1350.0),
        (4700.0, 7900.0, -330.0, 1100.0),
    ):
        distance = ((x - center_x) ** 2 + (y - center_y) ** 2) / (2.0 * sigma**2)
        values += amplitude * np.exp(-distance)
    return values.astype("<f4", copy=False)


def nodata_mask(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    lake = ((x - 6800.0) / 620.0) ** 2 + ((y - 2600.0) / 410.0) ** 2 < 1.0
    corridor = (
        (x > 7600.0)
        & (y > 6500.0)
        & (np.abs(y - (0.43 * x + 3850.0)) < 58.0)
    )
    return lake | corridor


def scalar_value(x: int, y: int, seed: int) -> float:
    xs = np.asarray([[x]], dtype=np.float64)
    ys = np.asarray([[y]], dtype=np.float64)
    if bool(nodata_mask(xs, ys)[0, 0]):
        return NODATA
    return float(terrain_values(xs, ys, seed)[0, 0])


def _inline_short(value: int) -> bytes:
    return struct.pack("<H", value) + b"\0\0"


def _inline_long(value: int) -> bytes:
    return struct.pack("<I", value)


def _ifd_entry(tag: int, field_type: int, count: int, value_or_offset: bytes) -> bytes:
    if len(value_or_offset) != 4:
        raise ValueError("TIFF IFD values must occupy exactly four bytes")
    return struct.pack("<HHI", tag, field_type, count) + value_or_offset


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def generate(
    output: Path,
    width: int,
    height: int,
    tile_size: int,
    seed: int,
    compression_level: int,
) -> dict:
    if width < 2 or height < 2:
        raise ValueError("width and height must both be at least 2")
    if tile_size < 16 or tile_size > 4096 or tile_size & (tile_size - 1):
        raise ValueError("tile size must be a power of two between 16 and 4096")
    output.parent.mkdir(parents=True, exist_ok=True)

    tiles_across = math.ceil(width / tile_size)
    tiles_down = math.ceil(height / tile_size)
    tile_count = tiles_across * tiles_down
    nodata_ascii = b"-9999\0"

    entry_count = 15
    ifd_offset = 8
    ifd_size = 2 + entry_count * 12 + 4
    auxiliary_offset = ifd_offset + ifd_size
    tile_offsets_offset = auxiliary_offset
    tile_byte_counts_offset = tile_offsets_offset + tile_count * 4
    pixel_scale_offset = tile_byte_counts_offset + tile_count * 4
    tiepoint_offset = pixel_scale_offset + 3 * 8
    nodata_offset = tiepoint_offset + 6 * 8
    image_data_offset = (nodata_offset + len(nodata_ascii) + 7) & ~7

    entries = [
        _ifd_entry(256, 4, 1, _inline_long(width)),
        _ifd_entry(257, 4, 1, _inline_long(height)),
        _ifd_entry(258, 3, 1, _inline_short(32)),
        _ifd_entry(259, 3, 1, _inline_short(8)),  # Adobe Deflate
        _ifd_entry(262, 3, 1, _inline_short(1)),  # BlackIsZero
        _ifd_entry(277, 3, 1, _inline_short(1)),
        _ifd_entry(284, 3, 1, _inline_short(1)),
        _ifd_entry(322, 4, 1, _inline_long(tile_size)),
        _ifd_entry(323, 4, 1, _inline_long(tile_size)),
        _ifd_entry(324, 4, tile_count, _inline_long(tile_offsets_offset)),
        _ifd_entry(325, 4, tile_count, _inline_long(tile_byte_counts_offset)),
        _ifd_entry(339, 3, 1, _inline_short(3)),  # IEEE floating point
        _ifd_entry(33550, 12, 3, _inline_long(pixel_scale_offset)),
        _ifd_entry(33922, 12, 6, _inline_long(tiepoint_offset)),
        _ifd_entry(42113, 2, len(nodata_ascii), _inline_long(nodata_offset)),
    ]
    entries.sort(key=lambda entry: struct.unpack_from("<H", entry)[0])

    started = time.perf_counter()
    tile_offsets: list[int] = []
    tile_byte_counts: list[int] = []
    valid_count = 0
    min_value = math.inf
    max_value = -math.inf

    with output.open("w+b") as handle:
        handle.write(b"II")
        handle.write(struct.pack("<H", 42))
        handle.write(struct.pack("<I", ifd_offset))
        handle.write(struct.pack("<H", entry_count))
        for entry in entries:
            handle.write(entry)
        handle.write(struct.pack("<I", 0))
        handle.write(b"\0" * (tile_count * 8))
        handle.write(struct.pack("<3d", 30.0, 30.0, 0.0))
        handle.write(struct.pack("<6d", 0.0, 0.0, 0.0, 500_000.0, 4_100_000.0, 0.0))
        handle.write(nodata_ascii)
        if handle.tell() < image_data_offset:
            handle.write(b"\0" * (image_data_offset - handle.tell()))

        local_x = np.arange(tile_size, dtype=np.float64)[None, :]
        local_y = np.arange(tile_size, dtype=np.float64)[:, None]
        for tile_y in range(tiles_down):
            for tile_x in range(tiles_across):
                global_x = local_x + tile_x * tile_size
                global_y = local_y + tile_y * tile_size
                valid_extent = (global_x < width) & (global_y < height)
                values = terrain_values(global_x, global_y, seed)
                invalid = ~valid_extent | nodata_mask(global_x, global_y)
                values[invalid] = NODATA

                valid_values = values[~invalid]
                if valid_values.size:
                    valid_count += int(valid_values.size)
                    min_value = min(min_value, float(valid_values.min()))
                    max_value = max(max_value, float(valid_values.max()))

                encoded = zlib.compress(values.tobytes(order="C"), compression_level)
                tile_offsets.append(handle.tell())
                tile_byte_counts.append(len(encoded))
                handle.write(encoded)

        handle.seek(tile_offsets_offset)
        handle.write(struct.pack(f"<{tile_count}I", *tile_offsets))
        handle.seek(tile_byte_counts_offset)
        handle.write(struct.pack(f"<{tile_count}I", *tile_byte_counts))
        handle.flush()
        os.fsync(handle.fileno())

    probes = [
        {"x": x, "y": y, "value": scalar_value(x, y, seed)}
        for x, y in PROBE_COORDINATES
        if x < width and y < height
    ]
    elapsed = time.perf_counter() - started
    file_size = output.stat().st_size
    manifest = {
        "schema": "dem-studio-perf-fixture-v1",
        "path": str(output.resolve()),
        "width": width,
        "height": height,
        "cellCount": width * height,
        "sampleFormat": "Float32",
        "byteOrder": "little-endian",
        "layout": "tiled",
        "tileWidth": tile_size,
        "tileHeight": tile_size,
        "tileCount": tile_count,
        "compression": "AdobeDeflate",
        "compressionLevel": compression_level,
        "noData": NODATA,
        "seed": seed,
        "fileSizeBytes": file_size,
        "uncompressedRasterBytes": width * height * 4,
        "validCellCount": valid_count,
        "noDataCellCount": width * height - valid_count,
        "min": min_value,
        "max": max_value,
        "sha256": sha256_file(output),
        "generationSeconds": round(elapsed, 3),
        "probes": probes,
    }
    manifest_path = output.with_suffix(output.suffix + ".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts/perf-fixtures/perf-100m-mountain-f32-deflate-tiled.tif"),
    )
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--compression-level", type=int, choices=range(0, 10), default=6)
    args = parser.parse_args()
    manifest = generate(
        args.output.resolve(),
        args.width,
        args.height,
        args.tile_size,
        args.seed,
        args.compression_level,
    )
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
