# BUG-2026-07-30：WebGPU 按需帧未提交

## 用户可见症状

- Babylon WebGPU 初始化、地形构网和材质编译都成功，诊断中的 draw call、
  顶点和三角形也非零，但真实窗口仍为空白。
- 同一场景强制 WebGL2 时可以显示，WebGPU 成片最初只得到接近黑色的背景。

## 根因

应用保留了单一按需 `requestAnimationFrame` 调度器，却直接调用
`scene.render()`。WebGL2 命令会在该路径呈现，但 Babylon WebGPU 需要由
`engine.beginFrame()` 和 `engine.endFrame()` 明确包住每个按需帧，才能完成
命令编码、提交与呈现。持续 `runRenderLoop` 会代办这层生命周期，但本产品
明确不启动持续循环。

## 现有设计为何允许问题

1. 迁移适配层沿用了 Three.js 中“调用 render 即完成呈现”的假设。
2. 早期 Harness 只检查场景对象、draw call 和材质 ready，未检查真实可见像素。
3. WebGL2 可见让共享场景逻辑看似正确，掩盖了 WebGPU 独有的帧提交边界。
4. 离屏 32 帧累积同样缺少边界，因此元数据可成功而颜色缓冲并未正确提交。

## 根因级修复

- 所有按需屏幕帧统一由 Babylon renderer facade 执行
  `beginFrame → scene.render → endFrame`，并以 `finally` 保证结束边界。
- 每个高质量离屏累积帧同样包住 `RenderTargetTexture.render`。
- 不以启动 Babylon 持续渲染循环规避问题，继续保持相机变化只触发有限重绘。

## 永久回归 Oracle

1. 静态闸门必须同时发现屏幕和离屏路径的 `beginFrame/endFrame`。
2. WebGPU Release EXE 必须生成含地形的真实窗口截图，不能以 draw call 代替。
3. WebGPU 成片必须为非空 PNG，亮度范围大于零并完成 32 帧累积。
4. 同一输入的 WebGL2 与 WebGPU 应具有相同构图；允许后端光栅细节差异，
   不复用旧 Three 像素哈希。

## 禁止的“修复”

- 不得通过强制回退 WebGL2 隐藏 WebGPU 空白。
- 不得启动无条件持续渲染循环来换取偶然呈现。
- 不得只放宽截图或 draw-call 断言而不验证可见像素。
