# DEM Studio

DEM Studio 是面向桌面的跨平台地形可视化与 DEM 渲染产品。项目使用同一套 Web 前端和 Tauri 2 宿主，目标平台为 Windows、macOS 和 Linux。

## 当前迁移边界

- 保留 Lens 版已有的 DEM 解析、Three.js 场景、材质、相机和导出行为。
- 用 Tauri Store、Dialog、File System 替换 Lens 宿主能力。
- Three.js 与 GeoTIFF 进入本地构建产物，核心功能不依赖 CDN。
- 第一阶段不重写 DEM 算法，不引入 React，不改变数据语义。

## 开发

```bash
npm install
npm run verify
npm run desktop:dev
```

## 构建

```bash
npm run desktop:build
```

Windows 运行时冒烟使用专用调试配置，不把远程调试端口带入正式安装包：

```bash
npm run verify:runtime:windows
```

桌面安装包必须分别在对应操作系统上构建：

- Windows：NSIS/MSI
- macOS：App/DMG，并完成签名与公证
- Linux：AppImage/Deb/RPM

## 文档

- [迁移契约](docs/product/migration-contract.md)
- [三端发布矩阵](docs/product/release-matrix.md)
- [Windows 验证记录](docs/product/windows-validation.md)
- [三端架构决策](docs/adr/0001-tauri-cross-platform-host.md)
- [接管快照](docs/governance/adoption/adoption-snapshot.md)
- [未知项登记](docs/governance/adoption/unknowns-register.md)
