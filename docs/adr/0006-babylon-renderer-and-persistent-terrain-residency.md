# ADR-0006：Babylon.js 渲染器与永久地形基座

- 状态：已确认并实施；Windows Release 实机验收通过
- 日期：2026-07-30
- 决策者：用户
- 取代：ADR-0004 中的 Three.js 实时与路径追踪决定

## 背景

原渲染实现把“当前视域选择出的瓦片”同时当作“GPU 中应继续驻留的瓦片”。
镜头变化后，未被本轮选择的网格会被销毁；再次进入同一区域时，系统只能重新
抽样、构网和上传。引擎替换本身不能修复这个生命周期错误。

旧成片通道还形成了与实时预览不同的几何和材质适配面。继续维护两套渲染器会
扩大方向、相机、NoData、材质和导出结果漂移的可能性。

## 决定

1. 实时渲染一次性切换到本地 ESM `@babylonjs/core 9.18.0`，不提供 Three.js
   运行时开关，不使用 CDN。
2. 首选 `WebGPUEngine`；初始化不支持或失败时，销毁失败状态并以 WebGL2
   `Engine` 重建。诊断必须记录请求后端、实际后端和回退原因。
3. 场景使用右手坐标系，交互相机统一为 `ArcRotateCamera`。正交和透视只改变
   投影模式，不建立第二套地形逻辑。
4. 由应用现有的单一按需 `requestAnimationFrame` 调度渲染；不调用 Babylon
   持续渲染循环。交互只降低后处理成本，不能切换或重建几何。
5. 地形使用 `VertexData` 构建 Babylon 自定义网格；NoData 掩膜、边界墙、
   顶点色、法线、UV 和 horizon visibility 继续来自现有数据链。
6. PBR 材质插件同时提供 GLSL 和 WGSL 注入，承接 horizon visibility、
   贴图重照明和白模。WebGPU 与 WebGL2 共用同一材质语义。
7. `256/512/1024` 分别完整常驻 L1/L2/L3；`2048/4096` 保持完整 L3 基座，
   再选择 L4/L5 局部精化。
8. 基座以 `requiredBaseTiles` 和 `readyBaseTiles` 管理。镜头只调整未开始
   基座任务的优先级，不得取消、清空、重新抽样、重新构网或释放已完成基座。
   NoData 空瓦片同样进入 ready。
9. 精化以 `desiredRefinementTiles` 和 `residentRefinementTiles` 分离显示与
   驻留。离开视域只隐藏并进入 LRU；只有超过 192 MiB 地形 GPU 硬预算时，
   才淘汰非可见精化。
10. overview、完整基座、精化网格和关联纹理统一计入 192 MiB；完整进程树
    继续受 1.5 GiB 硬门约束。
11. 成片导出统一为 Babylon 高质量离屏光栅，使用独立相机、PBR、软阴影、
    SSAO2、设备允许的最多 4× MSAA 和 32 帧 TAA 累积。元数据固定为
    `renderer="babylon-high-quality-raster"`、`accumulationFrames=32`
    和实际 `msaaSamples`。
12. 2026-08-01 起，所有实时、瓦片、浏览器回退和增强导出路径永久保留
    重采样后的权威 DEM 高程，不再执行几何箱式模糊。历史 `smoothSteps`
    字段保留为设置与 IPC 兼容字段但运行时恒为 0；整数高程量化造成的条带
    通过独立的多尺度光照法线抑制，不修改顶点位置。

## 兼容边界

- 不修改 Rust Core、Tauri 公开命令、DMT3、NoData、OVR/PAM、设置 schema、
  最近文件、PNG、GeoTIFF 或 World File 数据格式。
- 2026-08-01 的高程保真修正不改变公开命令和设置 schema；仅停止消费历史
  `smoothSteps` 修改几何。
- 不在本次引入共享规则网格、高程纹理位移、Compute Shader 或路径追踪。
- WebGPU 与 WebGL2 是同一实现的两个图形后端，不是两个产品渲染器。

## 回滚

不提供用户可见或运行时 Three.js 回滚开关。失败时整体恢复迁移前源码快照或
提交；Rust Core、源 TIFF、设置和最近文件不需要数据迁移。迁移前只读快照及
SHA-256 清单位于工作区外，防止与当前脏工作区互相覆盖。

## 验收

- 生产依赖、入口和 bundle 不包含已退役的 Three.js 依赖、导入、路径追踪
  产品标识或应用提供的 CDN 地址。
- WebGPU 与强制 WebGL2 分别以同一 Release EXE 运行；WebGPU 不可用时必须
  观察到带原因的 WebGL2 回退。
- 31,984 × 18,495 金样在 1024 档完成 64 个 L3 基座、完整有效区覆盖、
  overview 顶面撤下且队列归零。
- 基座完成后真实 rotate、pan、wheel 60 秒；构建代次和基座 sample、build、
  upload、dispose 均无增量，基座对象、顶点和三角形保持不变，且没有模型
  闪空或 context loss。
- 2048/4096 只改变局部精化；未发生 LRU 淘汰时，返回已访问视角必须命中
  驻留缓存。
- 成片输出非空 PNG，完成 32 帧累积，并以新的 Babylon 视觉基线验收。

## Windows Release 实机证据

验证对象为 Release profile、启用固定调试端口以供 Harness 读取运行时状态的
同一可执行文件：

- 路径：`src-tauri/target/perf/release/dem-studio.exe`
- SHA-256：
  `3B95A8C50BACE3725C87677E1A24EC8CDC730F214D7D28996BFC2FCEBEED4826`
- 大小：13,897,216 bytes
- 输入：`FRMM_EarthPrinter_DN_PREC_2024.tif`
- 输入尺寸：31,984 × 18,495
- 输入 SHA-256：
  `EB5FEDDF70C0333629DF6BC622A9B001379278F372884B90B7C9D547E7A721BC`

通过项：

1. 1024 档完成 64 个 L3 基座，其中 42 个有效网格、22 个 NoData empty；
   698,922 顶点、769,158 三角形，overview 顶面关闭，队列归零。
2. 基座完成后的 60 秒 rotate/pan/wheel 中，
   `terrainBuildGeneration 2→2`，base sample/build/upload/dispose 增量均为
   0，对象标识、顶点和三角形保持不变，context loss 为 0。
3. 2048/4096 均保持 64 个 L3 基座；返回已访问视角时精化
   sample/build/upload/eviction 增量均为 0，分别保留 48/101 个精化驻留项。
4. 15 分钟交互共 67,551 次视口变化，p95 13.4 ms、p99 13.5 ms、
   最大帧 40.1 ms、Long Task 0。60 个进程树样本的稳态增长为
   8,716,288 bytes，峰值 1,032,650,752 bytes。
5. 原生 WebGPU、强制 WebGL2 和注入 WebGPU 初始化失败后的带原因 WebGL2
   回退均通过，context loss 为 0。
6. 成片输出 256 × 159 PNG、32 帧累积、4× MSAA、透明背景；7 组光照与
   材质消融产生 7 个不同哈希。

证据目录：

- `artifacts/real-tif-babylon-release/final-3b95-1024-stability/`
- `artifacts/real-tif-babylon-release/final-3b95-1024-perf/`
- `artifacts/real-tif-babylon-release/final-3b95-1024-soak/`
- `artifacts/real-tif-babylon-release/final-3b95-lod/`
- `artifacts/babylon-final-3b95/`

这些结论只覆盖当前 Windows 11 目标机与指定金样；macOS、Linux、其他显卡和
其他超大 TIFF 仍需各自实机验证。

正式无调试端口产物由同一源码构建：

- 路径：`src-tauri/target/release/dem-studio.exe`
- SHA-256：
  `E3E2885B755133580341F4C254A5B53A953898ED2FB99C0C658983CD683277E4`
- 大小：13,896,192 bytes

该哈希用于确认正式产物身份；上述可观测运行时结论绑定 Release Harness
产物，不能把静态产物哈希误写成运行时证据。
