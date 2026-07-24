# Windows 验证记录

- 日期：2026-07-24
- 系统：Windows 11 x64
- WebView2：150.0.4078.83
- Rust：1.96.0
- Tauri CLI：2.11.4
- Tauri crate：2.11.5

## 已通过

- npm 依赖安装，审计结果 0 vulnerability。
- Vite Production 构建，93 个模块。
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

## 构建产物

### 独立 EXE

- 路径：`src-tauri/target/release/dem-studio.exe`
- 大小：12,140,544 bytes
- SHA-256：`233831951348035E56F05132CD38F2196F08AA4DE6E732B8803DF08A0C95FBFE`

### NSIS 安装包

- 路径：`src-tauri/target/release/bundle/nsis/DEM Studio_0.12.1_x64-setup.exe`
- 大小：3,182,687 bytes
- SHA-256：`041A92CFEF50BC2A43377AB181A37DC5664BA6D84F2629CC81138A7F9B94AE6E`

## 尚未通过

- GeoTIFF/HGT/PNG 真实样本回归。
- PNG/GeoTIFF/World File 自动导出回归。
- 大栅格性能与内存基准。
- 安装、卸载、覆盖升级回归。
- Windows 代码签名。
