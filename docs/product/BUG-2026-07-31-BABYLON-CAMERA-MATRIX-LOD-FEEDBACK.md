# BUG-2026-07-31：Babylon 相机矩阵通知形成 LOD 反馈环

## 症状

- 地形已经静止，`selectionGeneration` 和 `selections` 仍快速增长。
- 每次读取或渲染相机矩阵都可能再次触发瓦片选择，表现为队列反复调度。
- 该问题会掩盖“镜头移动不重建基座”的真实生命周期结论，并增加主线程负担。

## 根因

Babylon 的 `onViewMatrixChangedObservable` 不只表示用户输入；相机矩阵被重新
计算时也会发出通知。兼容控制器把每次通知都直接转成 `change`，而 `change`
又会触发重绘和 LOD 选择。渲染读取矩阵后再次进入同一路径，构成反馈环。

问题不在 Babylon 相机本身，而在适配层把“矩阵计算通知”误当成“相机状态
发生变化”。原设计没有冻结相机位置、目标、投影和缩放的签名，因此无法区分
这两个事件。

## 根因级修复

- `ArcRotateControlsFacade` 保存最后一次相机签名。
- 收到矩阵通知后先计算新签名；签名未变立即返回，不发出 `change`。
- 真实输入更新位置、目标、投影或缩放后才更新签名并触发重绘、精化选择。
- 基座任务始终排在精化之前；L4/L5 选择只在基座 complete 后开始。

## 永久回归 Oracle

1. 适配层必须存在 `next === this._lastSignature` 的短路。
2. 真实 TIFF 静止完成后，选择代次保持个位数量级，队列归零。
3. 1024 基座完成后的 60 秒真实 rotate、pan、wheel 中，
   `terrainBuildGeneration` 不变，base sample/build/upload/dispose 增量全为 0。
4. WebGPU 与 WebGL2 均不得出现 context loss 或无输入的持续 LOD 调度。

## 禁止的修复

- 不得通过延长 debounce 隐藏反馈环。
- 不得停止读取相机矩阵或关闭真实镜头交互。
- 不得以关闭 LOD、固定视角或吞掉诊断计数换取表面稳定。
