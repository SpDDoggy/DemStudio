# BUG-2026-07-31：光照设置未对应真实 Babylon 光照状态

## 状态

已修复，作为永久回归记录保留。

## 现象

- “主光强度”“环境漫反射”与画面亮度互相补偿，用户无法判断实际改动了哪一层。
- “地形遮蔽”在永久石膏路径中被 `whiteStudio` 条件关闭，界面开关并未控制真实 SSAO2。
- 阴影相机参数只写入兼容外观对象，Babylon 原生 DirectionalLight 仍可自行重算投影。
- 持续读取画布亮度的自动曝光会抵消用户调光。
- 旧平面只是视觉网格或兼容阴影层，不是接收 PCSS 的实体摄影棚地面。

## 根因

现有设计把“界面显示状态”“Three 兼容外观对象”和“Babylon 原生运行时状态”
混为同一层。设置有值不等于 Babylon 管线消费了该值，因而静态表单检查和普通截图
都可能假绿。

## 修复

- 主光只写 DirectionalLight 能量，环境只写 PBR environment intensity，曝光只写
  image processing exposure。
- 删除持续画布采样与自动曝光追踪。
- 用本地 32×32 渐变 cubemap 生成 spherical polynomial 环境辐照度；地面颜色只参与
  下半球近似。
- `aoEnabled` 直接控制 Babylon `SSAO2RenderingPipeline`；摄像机交互保持同一采样与附件拓扑。
- 光空间包围盒拟合结果写入 Babylon DirectionalLight 原生正交边界，并进行 shadow-map
  texel 对齐。
- 新增粗糙度 0.96、金属度 0 的 PBR 摄影棚地面，仅接收阴影。

## 永久 Oracle

- 场景只能有一个 Babylon Light。
- 主光、环境、曝光单独变化时不得改写另外两项，且不得增加
  `terrainBuildGeneration`。
- AO 开关必须改变 SSAO2 运行时状态。
- 环境、主光、AO、地面、阴影与完整合成消融必须具有不同像素签名。
- 透明成片不得包含地面、网格或投影。
- WebGPU、WebGL2 和强制 WebGPU 失败后的 WebGL2 重建均必须通过相同 Oracle。
