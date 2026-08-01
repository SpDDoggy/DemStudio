#!/usr/bin/env python3
"""Independently verify the deterministic tiled GeoTIFF performance fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import zlib
from pathlib import Path


TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


class ClassicTiff:
    def __init__(self, path: Path):
        self.path = path
        self.handle = path.open("rb")
        header = self.handle.read(8)
        if len(header) != 8 or header[:2] != b"II" or struct.unpack_from("<H", header, 2)[0] != 42:
            raise ValueError("fixture must be classic little-endian TIFF")
        ifd_offset = struct.unpack_from("<I", header, 4)[0]
        self.handle.seek(ifd_offset)
        entry_count = struct.unpack("<H", self.handle.read(2))[0]
        self.tags: dict[int, tuple[int, int, bytes]] = {}
        for _ in range(entry_count):
            raw = self.handle.read(12)
            tag, field_type, count = struct.unpack_from("<HHI", raw)
            self.tags[tag] = (field_type, count, raw[8:12])

    def close(self) -> None:
        self.handle.close()

    def values(self, tag: int):
        field_type, count, inline = self.tags[tag]
        byte_count = TYPE_SIZES[field_type] * count
        if byte_count <= 4:
            raw = inline[:byte_count]
        else:
            self.handle.seek(struct.unpack("<I", inline)[0])
            raw = self.handle.read(byte_count)
        if field_type == 2:
            return raw.rstrip(b"\0").decode("ascii")
        formats = {1: "B", 3: "H", 4: "I", 12: "d"}
        return struct.unpack(f"<{count}{formats[field_type]}", raw)

    def scalar(self, tag: int):
        value = self.values(tag)
        return value[0] if isinstance(value, tuple) else value

    def read_pixel(self, x: int, y: int) -> float:
        width = int(self.scalar(256))
        height = int(self.scalar(257))
        tile_width = int(self.scalar(322))
        tile_height = int(self.scalar(323))
        if not (0 <= x < width and 0 <= y < height):
            raise ValueError(f"pixel ({x}, {y}) is outside {width}x{height}")
        tiles_across = math.ceil(width / tile_width)
        tile_index = (y // tile_height) * tiles_across + (x // tile_width)
        offsets = self.values(324)
        byte_counts = self.values(325)
        self.handle.seek(offsets[tile_index])
        encoded = self.handle.read(byte_counts[tile_index])
        decoded = zlib.decompress(encoded)
        expected = tile_width * tile_height * 4
        if len(decoded) != expected:
            raise ValueError(
                f"tile {tile_index} decoded to {len(decoded)} bytes; expected {expected}"
            )
        local_index = (y % tile_height) * tile_width + (x % tile_width)
        return struct.unpack_from("<f", decoded, local_index * 4)[0]


def verify(path: Path, manifest_path: Path, expected_width: int, expected_height: int) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    tiff = ClassicTiff(path)
    try:
        actual = {
            "width": int(tiff.scalar(256)),
            "height": int(tiff.scalar(257)),
            "bitsPerSample": int(tiff.scalar(258)),
            "compression": int(tiff.scalar(259)),
            "samplesPerPixel": int(tiff.scalar(277)),
            "tileWidth": int(tiff.scalar(322)),
            "tileHeight": int(tiff.scalar(323)),
            "tileCount": len(tiff.values(324)),
            "sampleFormat": int(tiff.scalar(339)),
            "noData": tiff.scalar(42113),
            "fileSizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
        expected_tile_count = math.ceil(expected_width / actual["tileWidth"]) * math.ceil(
            expected_height / actual["tileHeight"]
        )
        required = {
            "width": expected_width,
            "height": expected_height,
            "bitsPerSample": 32,
            "compression": 8,
            "samplesPerPixel": 1,
            "sampleFormat": 3,
            "noData": "-9999",
            "tileCount": expected_tile_count,
        }
        for key, value in required.items():
            if actual[key] != value:
                errors.append(f"{key}: expected {value!r}, actual {actual[key]!r}")
        if actual["width"] * actual["height"] != expected_width * expected_height:
            errors.append("source cell count does not match expected dimensions")
        if actual["sha256"] != str(manifest.get("sha256", "")).upper():
            errors.append("SHA-256 does not match manifest")
        if actual["fileSizeBytes"] != manifest.get("fileSizeBytes"):
            errors.append("file size does not match manifest")
        minimum_plausible_size = min(
            5 * 1024 * 1024,
            max(64 * 1024, expected_width * expected_height * 4 // 10),
        )
        if actual["fileSizeBytes"] < minimum_plausible_size:
            errors.append("fixture is implausibly small for the non-constant terrain contract")

        probe_results = []
        for probe in manifest.get("probes", []):
            value = tiff.read_pixel(int(probe["x"]), int(probe["y"]))
            expected = float(probe["value"])
            tolerance = max(1e-5, abs(expected) * 1e-6)
            matched = abs(value - expected) <= tolerance
            if not matched:
                errors.append(
                    f"probe ({probe['x']}, {probe['y']}): expected {expected}, actual {value}"
                )
            probe_results.append({**probe, "actual": value, "matched": matched})
    finally:
        tiff.close()

    result = {
        "schema": "dem-studio-perf-fixture-verification-v1",
        "path": str(path.resolve()),
        "manifest": str(manifest_path.resolve()),
        "passed": not errors,
        "errors": errors,
        "actual": actual,
        "probes": probe_results,
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--expected-width", type=int, default=10_000)
    parser.add_argument("--expected-height", type=int, default=10_000)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()
    fixture = args.fixture.resolve()
    manifest = (args.manifest or fixture.with_suffix(fixture.suffix + ".manifest.json")).resolve()
    result = verify(fixture, manifest, args.expected_width, args.expected_height)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
