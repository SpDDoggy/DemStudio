# Windows 验证记录

- 日期：2026-07-27
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
- 资源面板不存在与顶部“导入 DEM”重复的导入入口。
- 标题栏计算样式为完全透明、无 `backdrop-filter`，52 px 拖拽区域仍可接收指针事件。
- 最小化、最大化/还原和关闭为三枚 28 × 28 px 圆形按钮，右上功能岛无遮挡。
- Windows Release EXE 的 PE Subsystem 为 `WINDOWS_GUI (2)`，启动时不创建控制台窗口。
- 顶部重复的保存/导出功能岛已移除，地形设置内的“保存当前”和导出入口保持可用。
- 左下 GPU/FPS 状态与右下帮助/设置操作已移除，运行时不再执行无展示用途的 FPS 统计。
- 运行时断言确认重复功能岛和工作区页脚不存在，同时面板保存/导出节点存在。
- ASC 冒烟入口改为异常直通，只有出现 `Rust Core` 导入完成状态才允许通过。

## 构建产物

### 独立 EXE

- 路径：`src-tauri/target/release/dem-studio.exe`
- 大小：12,547,072 bytes
- SHA-256：`5B0A206165F7CEB907F3EFB3D3A4DAAEE7CF0289C89C361794543DA77C4B90A5`

### NSIS 安装包

- 路径：`src-tauri/target/release/bundle/nsis/DEM Studio_0.12.1_x64-setup.exe`
- 大小：3,089,507 bytes
- SHA-256：`B76E1F408C4B068E7C3860FD04EFBEE475F77ADE638A8516C4E0934C6D9A50AC`

## 尚未通过

- GeoTIFF/HGT/PNG 真实样本回归。
- PNG/GeoTIFF/World File 自动导出回归。
- 大栅格性能与内存基准。
- 安装、卸载、覆盖升级回归。
- Windows 代码签名。
