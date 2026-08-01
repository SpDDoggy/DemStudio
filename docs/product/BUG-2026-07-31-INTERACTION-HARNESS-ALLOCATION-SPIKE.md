# BUG-2026-07-31：交互 Harness 自身分配制造最大帧假峰值

## 症状

真实 31,984 × 18,495 TIFF 的 15 分钟交互测试中，p95、p99 与 Long Task
均通过，但 67,000 余帧中会出现单个 50.2–50.3 ms 帧间隔，导致
`最大帧 ≤ 50 ms` 硬门失败。60 秒短测通常无法稳定复现。

## 根因

旧 `runInteractionPerformanceProbe` 在每一帧执行
`await new Promise(resolve => requestAnimationFrame(resolve))`。15 分钟会创建
约 67,000 个 Promise、resolve 闭包及其短命对象。Harness 自身的分配和回收
进入被测 WebView 主线程，制造真实鼠标拖动路径不存在的 GC 峰值。

此外，长测按 15 秒分块采样进程树。旧协议在每块结束时调用
`endInteractiveRendering`，超过 220 ms 的进程树采样会触发完整后处理恢复；
下一块开始又销毁后处理，形成用户连续交互路径不存在的反复重建。

第二轮复测还发现产品侧的同类分配：Babylon 相机变化检测与摄影棚光照更新
每帧把相机状态和 16 个视图矩阵元素执行 `toFixed`、数组映射和字符串拼接。
约 67,000 帧会制造百万级短命字符串，并在长测末段触发 WebView GC。与此同时，
世界空间方向光与已拟合的 PCSS 阴影相机错误地把视图矩阵变化当成失效条件。

## 根因级修复

- 交互采样改为一个 Promise 和一个复用的 `requestAnimationFrame` 回调，
  不再每帧创建 Promise。
- 分块协议增加 `keepInteractionActive`；前 59 块保持同一次交互会话，只在
  最后一块恢复完整后处理。
- Babylon 相机变化检测改为复用一个 11 元素 `Float64Array`，原位数值比较，
  不再创建逐帧数组、格式化字符串或签名字符串。
- 摄影棚光照改为输入/质量脏标记驱动；相机移动不再重新派生世界空间光照，
  也不再刷新 PCSS 阴影深度图。
- 删除 WebGL2 平面假阴影兼容分支；WebGPU/WebGL2 都只使用同一真实 PCSS
  阴影接收路径。
- 仍记录全部帧间隔、Long Task 和每次视口变化；不删除最大值、不截尾、
  不放宽 50 ms 门槛。
- 地形网格、相机路径、渲染分辨率和交互期产品画质策略均未改变。

## 永久回归 Oracle

1. 15 分钟 Harness 必须由 60 个 15 秒块组成并采集 60 个进程树样本。
2. 非末块必须传入 `keepInteractionActive: true`；末块必须恢复完整后处理。
3. `runInteractionPerformanceProbe` 的逐帧路径只能复用同一个 rAF 回调，
   禁止在循环内创建 Promise。
4. 相机变化检测不得在逐帧路径使用 `toFixed`、`map`、`join` 或新数组；
   相机 orbit 不得使世界空间 PCSS 阴影图失效。
5. 真实 TIFF 必须同时满足 p95 ≤ 16.7 ms、p99 ≤ 25 ms、最大帧 ≤ 50 ms、
   Long Task = 0；不得用分位数替代最大帧。
6. 最终测试必须至少有 200 次视口变化，并以完整进程树的 60 个样本判断
   稳态增长与 1.5 GiB 峰值。

## 禁止的“修复”

- 不得把 50 ms 改大、忽略单个最大值或对异常帧做截尾。
- 不得用静止 RAF、纯计时器或主进程内存代替真实相机和完整进程树。
- 不得在 Harness 中切换低精度几何来获得更好数字。
- 不得把 Harness 自身制造的分配压力宣传为产品运行时泄漏。
