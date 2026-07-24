# 当前交接摘要

## 已完成

- 独立 Tauri 2 宿主。
- Windows Release EXE 和 NSIS 安装包。
- 本地 Three.js/GeoTIFF 构建，不依赖 CDN。
- Lens DB/FS 宿主兼容层。
- 直接二进制导出路径。
- Lens 状态一次性迁移工具及本机迁移。
- Windows 自动化运行时冒烟。
- Windows/macOS/Linux 构建矩阵。
- 三端图标资产。

## 当前产品边界

业务代码仍保留为可追溯的单文件迁移基线。宿主解耦已经完成，但业务模块化、严格 CSP、大栅格 Worker/Rust 下沉尚未开始。

## 不能被误报为完成的事项

- macOS 与 Linux 尚未在对应系统构建和运行。
- 真实 GeoTIFF 导出尚未形成自动化 golden test。
- 签名、公证、自动更新与正式发布渠道尚未配置。
- 当前 UI 是迁移基线，尚未进行独立产品的信息层级收口。

## 下一阶段最小工作包

1. 在 CI 跑通四目标构建。
2. 建立 GeoTIFF/HGT/PNG/HGT 样本库和导出元数据断言。
3. 把内联脚本按 dataset/formats/terrain/export/storage 分离。
4. 移除宽松 CSP。
5. 用性能基准决定 Worker 与 Rust 的下沉边界。
