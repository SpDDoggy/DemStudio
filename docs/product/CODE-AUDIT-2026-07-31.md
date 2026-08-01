# DEM Studio 代码审计（2026-07-31）

> 更新：后续真实截图再次出现纯黑石膏地形，原“已修复”结论已撤回。复发根因及
> 新的单一石膏灯光状态机见
> `BUG-2026-07-31-WEBGPU-GYPSUM-BLACK-FRAME.md`。本文件中早于该复发审计的
> 绿色结果只代表当时的静态/单元闸门，不再作为最终运行时通过证据。
>
> 第二次更新：灯光审计发现“四灯 + IBL + 自发光”与表单的“两类光照”语义
> 不一致。现已收敛为方向主光 + PBR 环境漫反射，并取消石膏自发光及最终色
> horizon 乘法，并阻止旧高度顶点色染入固定石膏。当前新增证据为静态闸门、
> 39 个 Node 测试、生产构建，以及 Windows debug-host 的 WebGPU/WebGL2
> 双后端像素消融；Release EXE 与真实 TIFF 仍需单独验收。

## 审计结论

本轮覆盖前端业务编排、Babylon 渲染运行时、材质插件、相机输入、地形构网与
驻留、Tauri 命令边界、Rust DEM Core、依赖和 Windows Runtime Harness。

发现并修复 3 项高风险问题：

1. **H1 地形提交非原子**：异步重建期间先销毁旧模型，可产生黑帧/空帧。
2. **H1 WebGPU 资源绑定非法**：声明的软阴影 sampler 允许为 `null`。
3. **H1 测试假绿**：4 × 4 fixture、固定延时和状态值检查未覆盖真实画布。

历史双后端预设往返曾通过，但不作为本次灯光重构后的运行时证据。Rust 测试、
Clippy 和依赖审计结论也只代表各自执行时点；完成结论以本文末尾最新证据边界
为准。

## 已核验的边界

### 渲染与生命周期

- WebGPU 初始化失败可重建为 WebGL2，实际后端由 Runtime Harness 读取。
- 主循环保持按需渲染；交互只降低 MSAA/后处理，不替换地形几何。
- 新地形在材质预编译后提交，旧资源在 GPU idle 后释放。
- 石膏材质策略是唯一表面材质；预设只保留不同灯光、色调和构图语义。
- WebGPU 使用 Babylon PCSS，WebGL2 才可使用兼容平面软阴影。

### 数据与宿主

- GeoTIFF 仍由 Rust Core、二进制 IPC、NoData mask、PAM/OVR 和窗口采样负责。
- Tauri 文件读取保持扩展名与路径作用域限制；请求取消和数据集锁释放有测试。
- 未发现 Three.js、路径追踪包、渲染 CDN 或生产 localhost 入口。

### 依赖与构建

- `@babylonjs/core` 精确锁定 9.18.0。
- `npm audit --omit=dev`：0 个已知生产依赖漏洞。
- Vite 生产构建通过；主 JS chunk 约 2.14 MB，属于性能债务而非正确性阻断。

## 保留问题

### M1 前端编排仍高度集中

`index.html` 仍同时承担 UI、数据集生命周期、设置、副作用和大量 Harness
适配。纯函数已开始迁入 `src/`，但异步提交状态机尚未成为独立可测模块。

建议后续将 dataset session、terrain build transaction、preset transaction
分别抽成模块；这是可维护性改造，不应与本轮缺陷修复混做。

### M2 单元测试不能替代真实 GPU 验收

Node 单测可证明策略、构网和驻留算法，但无法证明 WebGPU bind group、相机输入
和最终像素。当前以双后端 Runtime Harness 补足，后续 CI 需要保留 Windows GPU
Runner；macOS/Linux 仍需实机结论。

### M2 “全部设置有效”仍需持续扩充矩阵

当前 Runtime Harness 实证了相机旋转/平移/缩放、高度夸张、AO 开关与强度、
纹理强度和色彩变换；静态闸门覆盖其余控件绑定。尚未对每个组合做全排列视觉
测试，尤其是 NoData、切片形态、透明导出和 4096 精化的组合爆炸。

建议以设置的副作用类型分组做 pairwise 矩阵，而不是穷举所有组合。

### M3 包体积

Babylon shader 与加载器使单一入口 chunk 超过 Vite 500 kB 警戒线。它不导致
当前桌面运行错误，但会增加启动解析成本。应在渲染稳定后按导出、GeoTIFF 解码、
高质量管线拆分动态入口。

## 证据与未覆盖项

- 已通过：Node 静态闸门与单测、Vite build、Rust Core 24 tests、Tauri 4
  tests、Clippy、npm 生产依赖审计、Debug EXE 的 WebGPU/WebGL2 预设往返。
- 已通过：WebGPU 真实 pointer rotate/pan/wheel。
- Release EXE 已成功构建并通过“无开发服务器入口”静态闸门；生产配置没有暴露
  CDP 调试目标，因此本轮双后端画布证据来自同源 Debug Smoke EXE，不把它冒充
  Release Runtime 证据。
- 本轮未宣称：31,984 × 18,495 金样、15 分钟 soak、macOS/Linux 实机。
  这些仍属于发布验收，不应由 Debug/Windows 证据替代。
