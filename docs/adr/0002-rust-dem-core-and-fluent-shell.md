# ADR-0002：Rust DEM Core 与 Fluent 无边框桌面壳

- 状态：已确认并实现
- 日期：2026-07-24
- 决策来源：用户明确要求

## 背景

迁移后的 Tauri 宿主已经独立，但 DEM 解码、NoData 处理、统计、抽样和平滑仍位于单文件 JavaScript。宿主语言变为 Rust 并没有自动形成 Rust 核心；大栅格工作仍占用 WebView 主线程，地理语义也缺少可独立测试的边界。

原界面由多个漂浮式圆角卡片构成，仍保留 Lens 插件感，且使用系统装饰标题栏，不能形成独立 Windows 桌面产品的窗口体验。

## 决定

建立不依赖 Tauri 的 `dem-core` Rust crate，Tauri 仅管理窗口、文件路径、IPC 和 Core 数据集生命周期。

Rust Core 负责：

- ASCII Grid、SRTM HGT、GeoTIFF 第一波段解码；
- NoData 归一化、有效值统计和边界检查；
- GeoTIFF 仿射变换、GeoKey、CRS 和侧车信息整理；
- 面向渲染的网格抽样、NoData 填充和多步平滑；
- 带仿射变换与 GeoKey 的 RGBA GeoTIFF 编码。

Web 层继续负责：

- Three.js/WebGL 场景、材质、相机和实时交互；
- 浏览器原生图像高度图解码；
- GPU 晕渲与像素生成；
- 控件状态和用户工作流。

窗口改为 Tauri 无边框窗口，前端提供 32 px 可拖拽标题栏和真实窗口命令。视觉系统采用 Windows 11 Fluent 的层级、几何、字体、颜色与动效规则，设计令牌记录在 `docs/design/brand-spec.md`。

## API 边界

| Tauri 命令 | 责任 |
| --- | --- |
| `parse_dem` | 接收 Web 拖放字节并调用 Rust Core |
| `parse_dem_path` | 从系统文件对话框路径直接读取并调用 Rust Core |
| `sample_dem` | 对宿主持有的数据集执行抽样、填充、归一化和平滑 |
| `encode_geotiff` | 将 WebGL 生成的 RGBA 像素编码为带地理参考的 TIFF |

成功解析的数据集由宿主分配 `coreId`。前端保存显示所需数据和 `coreId`，后续网格计算以 `coreId` 调用 Rust，不重复在 JavaScript 实现相同运算。

## 兼容与回滚

- 图像高度图仍使用浏览器 Canvas，避免把 PNG/JPEG/WebP 图像编解码误当成 DEM 格式核心。
- 非 Tauri 环境保留原 JavaScript ASC/HGT/GeoTIFF 解析和 GeoTIFF 编码作为开发回退；正式桌面运行优先 Rust。
- 旧设置键、预设和导出选项不变。
- 回滚可通过撤销本 ADR 对应提交恢复装饰窗口与 JavaScript 路径，不需要迁移用户数据。

## 验证

- `dem-core` 单元测试覆盖 ASC、HGT、TIFF 解码、仿射边界、抽样平滑和 GeoTIFF 编码回读。
- Tauri 主工程执行 `cargo test`。
- Web 层执行 `npm run verify` 和 `npm run build:web`。
- Windows 运行时冒烟验证 Rust ASC 导入、Rust 网格生成、Rust GeoTIFF 编码、Fluent 标题栏和 Three.js 画布。

## 后续约束

- 超大栅格需要把当前 JSON 数组 IPC 进一步升级为分块或二进制通道。
- macOS/Linux 只能在对应 runner 与实机通过后标记为已验证。
- Rust Core 的公开数据结构发生不兼容变化时必须增加金样并更新本 ADR。
