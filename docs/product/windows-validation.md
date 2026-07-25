# Windows 验证记录

- 日期：2026-07-25
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
- ASC 4 × 4 样本通过 Tauri 路径读取、Rust 解析和地形重建。
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
- 无边框标题栏高度为 52 px，系统窗口 API 可调用。
- Fluent 工作区通过 1440 × 900 截图检查。
- 产品源码中不存在浏览器 `alert`、`confirm`、`prompt` 或文件输入；提示、确认和命名操作使用 DEM Studio 对话框。
- DEM 与纹理导入使用 Tauri 桌面文件选择器；读取权限收窄为用户选择的单文件。
- 最近文件保存源路径并可通过 Rust Core 直接重开；旧版无路径记录会进入应用内提示。
- 分辨率、顶点数和显示模式已并入资源卡片。
- 左右卡片收起为具名胶囊，运行时验证收起状态并完成 1440 × 900 视觉检查。
- 世界坐标网格随镜头移动并按距离、视线夹角渐隐，运行时确认使用无限网格着色器。
- 正交与透视切换同时验证设置值、真实相机类型和按钮状态，状态不一致时自动重建相机。

## 构建产物

### 独立 EXE

- 路径：`src-tauri/target/release/dem-studio.exe`
- 大小：12,882,944 bytes
- SHA-256：`8543A823464A6ACB6F9E39708C37ED9C0456E55C33D1710B20F7D78F89888BD2`

### NSIS 安装包

- 路径：`src-tauri/target/release/bundle/nsis/DEM Studio_0.12.1_x64-setup.exe`
- 大小：3,431,728 bytes
- SHA-256：`178ECBCAA89AB9AD5AA8B3EF229DCC9911CAD2E81DD2DA234D45FC2F50EFAE7A`

## 尚未通过

- GeoTIFF/HGT/PNG 真实样本回归。
- PNG/GeoTIFF/World File 自动导出回归。
- 大栅格性能与内存基准。
- 安装、卸载、覆盖升级回归。
- Windows 代码签名。
