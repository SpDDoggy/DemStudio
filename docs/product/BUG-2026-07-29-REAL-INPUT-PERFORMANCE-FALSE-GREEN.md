# BUG-2026-07-29：真实输入性能被程序化 Harness 假绿掩盖

## 状态

性能根因与交互几何回归均已修复，已加入 fail-closed Oracle，并通过严格 Windows 前台回归。

## 用户现场

- DEM：内置 Synthetic DEM，640 × 480。
- 显示口径：307,200 顶点。
- 设置：白模、精细 1024、正交、等轴测。
- 现象：鼠标拖动明显卡顿。

## 错误结论

此前将“10,000 × 10,000 源 DEM 在文件瓦片 LOD 路径通过性能测试”表述为“一亿点流畅”，并进一步外推到 307,200 顶点单网格。该推断不成立。

旧 Harness 的真实命题仅是：

- 1440 × 900 测试窗口；
- 文件后端瓦片 LOD；
- 默认自然材质与 2048 VSM 阴影；
- 程序直接修改相机；
- 交互期间关闭 GTAO、锐化等后处理并降低 DPR；
- 不计入鼠标松开后的全质量恢复帧。

它没有覆盖用户现场的白模 4096 PCFSoft 阴影、正交单网格、最大化窗口或真实 pointer/wheel 输入。

## 独立复现

同一台机器、同一 perf Release、RTX 4070 Ti、1438 × 898 Canvas：

| 路径 | p50 | p95 | p99 | 最大帧 |
|---|---:|---:|---:|---:|
| 旧程序化相机 Harness | 13.4 ms | 15.0 ms | 16.7 ms | 34.3 ms |
| CDP 真实按下并拖动 | 360 ms | 1053.8 ms | 1160 ms | 1200 ms |

真实输入 14.36 秒只处理 30 次 mouse move 和 35 个 rAF；检测到 22 个大于 50 ms 的 Long Task，总计 13,382 ms，最大 1,199 ms。

## 根因

1. `runRenderFrame()` 开头将 `raf` 清空；渲染过程中 `invalidateRender()` 已经安排下一帧，函数尾部又无条件安排一帧，导致待执行 rAF 回调倍增。
2. 5.355 秒 trace 中只有约 70 个真实主帧，却执行了 86,069 次应用渲染回调；重复 render 将 DXGI Present 队列压满，再反压主线程。
3. 白模使用 4096² PCFSoft shadow map，且旧实现每帧更新静态光源阴影，进一步放大单帧成本。
4. 交互仍经过 HDR/MSAA Composer，测试窗口又显著小于用户现场。
5. 旧 Harness 绕过真实 OrbitControls 输入链，并遗漏松手后的全质量恢复。

## 根因级修复

- 静态光源阴影改为显式失效：只有地形、瓦片、光源或阴影参数变化时更新。
- 相机交互期间复用缓存阴影并直接渲染默认帧缓冲；松手后恢复完整 Composer。
- 所有渲染帧只允许由 `scheduleRenderFrame()` 安排；任意时刻最多一个待执行回调，静止后 backlog 必须归零。
- 交互期间保留与静止时相同的完整网格和标准材质，只暂时绕过高成本后处理；松手后恢复 Composer、GTAO 与 Sharpen。
- 旧轻量代理网格仅保留为 `legacyTerrainInteractionProxy=1` 显式回滚路径，默认禁用。
- 首次交互所需的完整网格直绘与 Composer 路径在地形加载完成时预热，避免把着色器与 GPU 资源首次提交成本留到第一次拖动。
- 删除交互质量切换中的重复后处理 resize，并避免默认帧缓冲与静态 HDR target 重复 MSAA。
- 保留 `legacyInteractiveRendering=1` 回滚查询参数。
- 新 Harness 必须以真实 pointer/wheel 输入覆盖白模单网格与文件瓦片两个独立场景。

## 二次回归：拖动与静止显示不一致

第一次性能修复引入了一个错误的隐含假设：交互代理只要覆盖范围相同，就可以视为与完整地形“视觉等价”。这个假设不成立。

旧代理存在四个结构性差异：

1. 将 762/1024 级完整采样降为 256 级，细山脊、窄沟谷和 NoData 边界会丢失；
2. 只生成顶面，不生成基座底面、外侧壁和 NoData 边界墙；
3. 将标准光照材质替换为预烘焙 `MeshBasicMaterial`，拖动时明暗模型也随之变化；
4. 大范围 edge morph 会把多数顶点拉向低精度父层，进一步改变轮廓。

因此，问题不是普通的光照闪变，而是交互 LOD 的视觉连续性与拓扑保真回归。根因级修复是默认取消几何体切换：交互和静止必须引用同一完整地形几何，只允许切换可恢复、不会改变轮廓与拓扑的后处理成本。

## 修复证据

最大化 2558 × 1390、RTX 4070 Ti、Synthetic 640 × 480、白模 1024、正交等轴测、trusted pointer/wheel：

- Drag：p50 13.3 ms，p95 13.4 ms，p99 13.4 ms，最大 13.5 ms；
- Wheel：p50 13.3 ms，p95 13.4 ms，p99 13.4 ms，最大 13.5 ms；
- 四阶段 Long Task 均为 0；
- 调度器 start/end 均满足 `scheduled = callbacks`、`backlog = pending = 0`，交互中 backlog 最大为 1；
- Drag 与 Wheel 活动阶段均满足 `interactionGeometry.mode=full`、`fullVisible=true`、`legacyProxyEnabled=false`；完整地形为 316,148 顶点、616,636 三角形，包含场景辅助面时总渲染为 616,638 三角形；
- 完整质量恢复后 `interactionActive=false`、完整网格仍可见，Composer、GTAO、Sharpen 均恢复；
- 10,000 × 10,000 源 DEM 文件瓦片路径独立回归：p95 15.3 ms（65.36 FPS），首帧 439.64 ms。

最终证据满足 `nativeForeground=true`、全部门禁为 true、总 `verdict=PASS`。证据文件为 `artifacts/perf-evidence-synthetic-307k/20260730-024808/summary.json`，对应 EXE SHA256 为 `A5BB492DCF4D73350F54669106DFF364F8CB204636BE0B57C4C783CC3AD86F79`。

## 回归 Oracle

白模单网格场景必须 fail-closed 校验：

- Synthetic DEM 640 × 480；
- sampled 640 × 480；
- 307,200 采样顶点；
- 316,148 完整几何顶点；
- 616,636 地形三角形；
- 白模、精细 1024、正交、等轴测；
- 目标最大化窗口和真实 GPU；
- 真实旋转、平移、缩放及松手恢复。

硬门槛按阶段判定，禁止用较长总采样把恢复尖峰稀释掉：

- Active drag / wheel：
  - p95 ≤ 16.7 ms；
  - p99 ≤ 25 ms；
  - 最大帧 ≤ 50 ms。
- Full-quality recovery：
  - p95 ≤ 16.7 ms；
  - p99 ≤ 33.4 ms；
  - 最大帧 ≤ 50 ms。
- 所有阶段：
  - 大于 50 ms 的帧数为 0；
  - Long Task 大于 50 ms 的数量为 0；
  - 活动阶段必须实证 `interactionGeometry.mode=full`、`fullVisible=true`、`legacyProxyEnabled=false`；
  - 活动阶段不得存在可见交互代理，且完整网格的顶点/三角形规模必须与静止阶段一致；
  - 松手恢复后必须实证 `interactionActive=false`、完整网格仍可见，并恢复 Composer、GTAO 与 Sharpen。

恢复阶段单独允许 p99 使用一个约 30 FPS 的帧预算，是因为静态 4× HDR MSAA 与 GTAO 在松手后重新进入完整渲染管线；这不是对持续交互的放宽，也不允许任何超过 50 ms 的可感知卡顿。`DragMilliseconds`、`RecoveryMilliseconds` 和 wheel 节奏保持原值，不通过延长样本稀释尖峰。

一亿源 DEM 瓦片路径必须单独回归，不能替代本场景。
