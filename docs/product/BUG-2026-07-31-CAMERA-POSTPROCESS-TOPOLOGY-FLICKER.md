# BUG-2026-07-31：摄像机交互触发后处理拓扑闪烁

## 现象

旋转、平移或缩放摄像机时，画布偶发整屏闪烁；停止操作约 220 ms 后还可能再次闪烁。

## 根因

摄像机输入的 `start/end` 事件直接切换 Babylon 实时后处理拓扑：

- MSAA 在 4× 与 1× 之间切换；
- SSAO2 在 16/4 样本、4/1 纹理样本及两组分辨率之间切换；
- Bloom、DOF 与 Sharpen 被反复拆装；
- 后台瓦片队列同时降低摄影棚光照质量。

这些变化会要求 Babylon 重建全屏 RenderTarget、深度纹理或后处理附件。WebGPU/WebGL2 都可能在资源切换边界提交清空帧。原设计把“交互降成本”等同于“交互换管线”，因此允许画面状态随输入事件改变。

## 修复约束

- 摄像机交互不得改变实时 MSAA、SSAO2 比例/样本、Bloom、DOF 或 Sharpen 的启用拓扑。
- 摄像机交互不得改变摄影棚光照质量。
- 交互降成本仅允许使用刷新节流，不允许切换几何或全屏附件。
- 用户主动修改效果设置仍可更新管线。

## 永久回归 Oracle

- 单元测试：同一效果设置在 `interactionActive=true/false` 时必须解析为完全相同的实时后处理状态和拓扑。
- Release Harness：真实左键旋转、右键平移和滚轮缩放后：
  - `postProcessing.topologyChangeCount` 增量为 0；
  - `terrainBuildGeneration` 增量为 0；
  - ArcRotateCamera 的旋转、目标点和平移/缩放参数确实发生变化。
- WebGPU 与 WebGL2 必须分别执行同一 Oracle。

## 回滚

回滚本 BUG 涉及的 `realtime-postprocess-policy.js`、Babylon 管线解析、交互质量切换和 Harness 断言。不得恢复按摄像机事件切换全屏附件的旧路径。
