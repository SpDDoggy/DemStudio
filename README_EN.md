# DEM Studio

[中文](README.md) | [English](README_EN.md)

[![Desktop CI](https://github.com/SpDDoggy/DemStudio/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/SpDDoggy/DemStudio/actions/workflows/desktop-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

DEM Studio is a local-first desktop application for terrain visualization and DEM rendering. It uses Tauri 2 to host a shared Three.js frontend and aims to provide a consistent terrain viewing, adjustment, and export workflow across Windows, macOS, and Linux.

This version is the standalone product migration of the DEM Studio previously embedded in Lens. DEM parsing, NoData handling, statistics, terrain sampling, and smoothing now live in an independent Rust Core, while Three.js remains responsible for real-time terrain rendering. Tauri provides file access, settings storage, system dialogs, and the frameless window shell. The core workflow does not depend on a CDN.

## Features

- Import GeoTIFF/TIFF, SRTM HGT, ASCII Grid (ASC), and PNG/JPG/WebP heightmaps
- Read coordinate and georeferencing sidecars such as PRJ, AUX.XML, TFW, TIFW, and WLD
- Explore terrain interactively and adjust elevation, camera, lighting, materials, and post-processing
- Export PNG, PNG + World File, GeoTIFF, and TIFF + World File
- Persist application settings, custom presets, and recent-file history locally
- Keep rendering and file processing on the local machine without a cloud dependency
- Use a Windows 11 Fluent frameless workspace with system window controls

## Platform Status

| Platform | Architecture | Target artifacts | Validation status |
| --- | --- | --- | --- |
| Windows | x64 | Standalone EXE, NSIS installer | Release build, launch, and ASC runtime smoke test completed |
| macOS | Apple Silicon | App, DMG | Project and CI configured; runner and real-device validation pending |
| macOS | Intel | App, DMG | Project and CI configured; runner and real-device validation pending |
| Linux | x64 | AppImage, Deb | Project and CI configured; WebKitGTK environment and real-device validation pending |

Artifacts produced without signing credentials are unsigned validation artifacts, not production releases. See the [cross-platform release matrix](docs/product/release-matrix.md) for the complete acceptance boundaries.

## Local Development

Prerequisites:

- Node.js 18 or later
- The stable Rust toolchain
- The [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your operating system

```bash
git clone https://github.com/SpDDoggy/DemStudio.git
cd DemStudio
npm install
npm run verify
npm run desktop:dev
```

## Build and Validation

Build the desktop application for the current platform:

```bash
npm run desktop:build
```

On Windows, run the automated runtime smoke test to verify application startup, the Tauri host bridge, and ASC fixture import and rendering:

```powershell
npm run verify:runtime:windows
```

Desktop packages must be built on their target operating system. A successful Windows build does not replace macOS or Linux platform validation.

## Project Layout

```text
.
├─ index.html               # DEM Studio frontend and current rendering logic
├─ src/host-bridge.js       # Bridge between the web UI, Tauri, and Rust Core
├─ src-tauri/dem-core/      # Independent Rust DEM core
├─ src-tauri/               # Tauri host, permissions, and packaging configuration
├─ scripts/                 # Baseline checks, runtime smoke test, and state migration
├─ tests/fixtures/          # Reproducible test fixtures
└─ docs/                    # Architecture decisions, migration contract, and release evidence
```

## Migrating Lens Data

If an earlier Lens DEM Studio data file exists, pass it explicitly:

```bash
npm run migrate:lens -- "path/to/db.json"
```

The script migrates application state such as settings, presets, and recent files without modifying the source file. Exit DEM Studio before migration so a running application cannot overwrite the destination store.

## Current Roadmap

- Establish cross-platform golden regressions with real GeoTIFF, HGT, and image heightmaps
- Split the current single-file frontend into scene, settings, and export workflow modules
- Tighten the content security policy and host permissions
- Complete Windows signing, macOS signing and notarization, and the production update path
- Complete runtime and export acceptance on real macOS and Linux environments

## Design and Validation Documents

- [Migration contract](docs/product/migration-contract.md)
- [Cross-platform release matrix](docs/product/release-matrix.md)
- [Windows validation record](docs/product/windows-validation.md)
- [Tauri cross-platform architecture decision](docs/adr/0001-tauri-cross-platform-host.md)
- [Rust Core and Fluent desktop shell decision](docs/adr/0002-rust-dem-core-and-fluent-shell.md)
- [Fluent design system](docs/design/brand-spec.md)

## License

This project is licensed under the [MIT License](LICENSE).
