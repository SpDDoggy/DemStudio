# Windows 验证记录

- 日期：2026-07-24
- 系统：Windows 11 x64
- WebView2：150.0.4078.83
- Rust：1.96.0
- Tauri CLI：2.11.4
- Tauri crate：2.11.5

## 已通过

- npm 依赖安装，审计结果 0 vulnerability。
- Vite Production 构建，96 个模块。
- Three.js 与 GeoTIFF 本地打包。
- Rust Release 构建。
- NSIS x64 安装包生成。
- Release EXE 创建窗口、持续响应并正常退出。
- Tauri Store、Dialog/FS 兼容层在页面中可用。
- Three.js 创建两个 Canvas。
- 示例地形正常渲染。
- ASC 4 × 4 样本通过文件输入、解析和地形重建。
- 页面启动状态无错误。
- Lens 设置和 5 条最近文件记录迁入独立版 Store。
- WebView2 Crashpad 未生成崩溃报告。

## Rust Core 与 Fluent 壳

- Rust Core 8 个单元测试通过。
- ASC、HGT、TIFF 解码与 GeoTIFF 仿射变换测试通过。
- 网格抽样、NoData 邻近填充和平滑测试通过。
- RGBA GeoTIFF 编码和回读测试通过。
- 运行时确认 `hostCore = rust-dem-core`。
- 4 × 4 ASC 经 Rust 解析与抽样后完成 Three.js 渲染。
- 运行时生成 439 字节测试 GeoTIFF，字节序和 TIFF 魔数正确。
- 无边框标题栏高度为 32 px，系统窗口 API 可调用。
- Fluent 工作区通过 1440 × 900 截图检查。

## 构建产物

### 独立 EXE

- 路径：`src-tauri/target/release/dem-studio.exe`
- 大小：12,866,048 bytes
- SHA-256：`A8F01F35CBA3D7A3FCCEA0D1BCAE69E12601351D069E68A5F6AAF19156D7FF8B`

### NSIS 安装包

- 路径：`src-tauri/target/release/bundle/nsis/DEM Studio_0.12.1_x64-setup.exe`
- 大小：3,416,602 bytes
- SHA-256：`C4F99927571D391ED63345746BCDCE8F64D958770EBE30718AFDE1667B35D5CB`

## 尚未通过

- GeoTIFF/HGT/PNG 真实样本回归。
- PNG/GeoTIFF/World File 自动导出回归。
- 大栅格性能与内存基准。
- 安装、卸载、覆盖升级回归。
- Windows 代码签名。
