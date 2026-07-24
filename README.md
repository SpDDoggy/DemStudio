# DEM Studio

[中文](README.md) | [English](README_EN.md)

[![Desktop CI](https://github.com/SpDDoggy/DemStudio/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/SpDDoggy/DemStudio/actions/workflows/desktop-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

DEM Studio 是一款本地优先的桌面地形可视化与 DEM 渲染工具。它使用 Tauri 2 承载同一套 Three.js 前端，目标是在 Windows、macOS 和 Linux 上提供一致的地形查看、调节与导出体验。

当前版本源自 Lens 内置 DEM Studio 的独立产品化迁移。迁移保留了已有 DEM 解析和渲染语义，并将文件访问、设置存储和系统对话框替换为跨平台 Tauri 能力。Three.js 与 GeoTIFF 解码器均进入本地构建产物，核心流程不依赖 CDN。

## 功能

- 导入 GeoTIFF/TIFF、SRTM HGT、ASCII Grid（ASC）和 PNG/JPG/WebP 高度图
- 读取 PRJ、AUX.XML、TFW、TIFW、WLD 等坐标与地理配准侧车文件
- 交互式三维地形浏览，以及高度、相机、光照、材质和后期效果调节
- 导出 PNG、PNG + World File、GeoTIFF、TIFF + World File
- 本地保存应用设置、自定义预设和最近文件记录
- 将渲染与文件处理保留在本机，不依赖云端服务

## 平台状态

| 平台 | 架构 | 目标产物 | 验证状态 |
| --- | --- | --- | --- |
| Windows | x64 | 独立 EXE、NSIS 安装包 | 已完成 Release 构建、启动和 ASC 运行时冒烟 |
| macOS | Apple Silicon | App、DMG | 工程与 CI 已配置，等待对应 runner 与实机验证 |
| macOS | Intel | App、DMG | 工程与 CI 已配置，等待对应 runner 与实机验证 |
| Linux | x64 | AppImage、Deb | 工程与 CI 已配置，等待 WebKitGTK 环境与实机验证 |

CI 未配置签名证书时生成的是无签名验证产物，不等同于可正式分发的发行包。详细验收边界见[三端发布矩阵](docs/product/release-matrix.md)。

## 本地开发

开始前需要：

- Node.js 18 或更高版本
- Rust stable 工具链
- 当前操作系统对应的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

```bash
git clone https://github.com/SpDDoggy/DemStudio.git
cd DemStudio
npm install
npm run verify
npm run desktop:dev
```

## 构建与验证

构建当前平台的桌面应用：

```bash
npm run desktop:build
```

Windows 可执行自动化运行时冒烟，验证应用启动、Tauri 宿主桥接以及 ASC 样本导入和渲染：

```powershell
npm run verify:runtime:windows
```

桌面安装包必须在对应操作系统上构建。Windows 本地成功不能替代 macOS 或 Linux 的平台验收。

## 项目结构

```text
.
├─ index.html               # DEM Studio 前端与现有渲染逻辑
├─ src/host-bridge.js       # Web 前端与 Tauri 宿主的兼容桥
├─ src-tauri/               # Rust 宿主、权限与打包配置
├─ scripts/                 # 基线检查、运行时冒烟与状态迁移
├─ tests/fixtures/          # 可重复的测试样本
└─ docs/                    # 架构决策、迁移契约与发布证据
```

## 迁移 Lens 数据

如果本机存在旧版 Lens DEM Studio 数据，可显式传入源文件：

```bash
npm run migrate:lens -- "路径/到/db.json"
```

脚本只迁移设置、预设和最近文件等应用状态，不修改源文件。迁移前请退出 DEM Studio，避免目标存储被运行中的应用覆盖。

## 当前路线

- 用真实 GeoTIFF、HGT 和图像高度图建立跨平台金样回归
- 拆分当前单文件前端，逐步形成解析、场景、设置和导出模块
- 收紧内容安全策略与宿主权限
- 完成 Windows 签名、macOS 签名与公证，以及正式更新链路
- 在真实 macOS/Linux 环境完成运行时和导出验收

## 设计与验证文档

- [迁移契约](docs/product/migration-contract.md)
- [三端发布矩阵](docs/product/release-matrix.md)
- [Windows 验证记录](docs/product/windows-validation.md)
- [Tauri 三端架构决策](docs/adr/0001-tauri-cross-platform-host.md)

## 许可证

本项目采用 [MIT License](LICENSE)。
