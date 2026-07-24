# 接管快照

## 模式

`ADOPTION_LIGHT + ZERO_START_WITH_SCAFFOLD`

## 证据

- `[USER_CONFIRMED]` DEM Studio 将发展成长期独立产品。
- `[USER_CONFIRMED]` 项目位于 `H:\DEM Studio`。
- `[USER_CONFIRMED]` 最终支持 Windows、macOS、Linux。
- `[OBSERVED]` 目标目录在接管时为空且不是 Git 仓库。
- `[OBSERVED]` 现有业务是 Lens 发布目录中的单文件 Web 插件，版本 `0.12.1`。
- `[OBSERVED]` 业务主体在 Web 端，Lens API 耦合集中在键值存储和文件保存。
- `[OBSERVED]` Windows 本机已有 Node、Rust、C++ Build Tools 和 WebView2。
- `[UNKNOWN]` 原始开发源码是否存在于当前发布目录以外的位置。

## 高稳定区

- DEM 数据解析和归一化。
- CRS、范围、GeoTransform 与 NoData 语义。
- Three.js 地形构建和导出结果。
- 现有设置键和自定义预设结构。

## 当前安全下一步

建立 Tauri 宿主兼容层和离线依赖构建，先证明现有行为能在独立进程运行，再进行源码模块化。
