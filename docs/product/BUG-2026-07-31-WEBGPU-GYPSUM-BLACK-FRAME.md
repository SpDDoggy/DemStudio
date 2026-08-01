# BUG-2026-07-31：WebGPU 石膏地形黑帧与空帧

## 2026-07-31 光照语义根因修复

用户截图进一步证明，“不黑”不等于石膏形体正确。运行时当时同时存在方向光、
半球光、两个兼容方向补光和 PBR 环境纹理，而表单只暴露“塑形强度”和“暗部
提亮”。前者同时缩放两盏不同职责的灯，后者同时改变三种环境能量；石膏材质
还带有 `0x4c4b47` 自发光，绕过主光与投影阴影。线框减少填充面后反而更像
石膏，正是表面能量被抬平的反证。

根因级修复：

- 场景收敛为一个 Babylon `DirectionalLight` 主光和一个 PBR environment
  diffuse irradiance 环境源；场景中的 Babylon Light 对象严格为 1，语义能量
  来源严格为 2；
- 主光是唯一投影源，PCSS/PCF 柔化只改变阴影核，不再用第二盏“软主光”伪造；
- “塑形强度/暗部提亮”分别改名为“主光强度/环境漫反射”，且各自只写一个
  能量通道；
- 石膏 `emissive` 归零，环境响应恢复为完整 PBR 强度；
- 固定石膏不再把旧高度色带乘入 PBR albedo；顶点色继续保留在几何数据中供
  诊断，但不参与石膏着色；
- `DoubleSide` 只关闭背面剔除，不再自动启用 `twoSidedLighting`。后者会在当前
  右手坐标场景中把地形顶面法线二次翻转，导致来自上方的方向主光贡献为 0；
- 删除 horizon visibility 对最终合成色的乘法。局部接触遮蔽只由 SSAO2
  负责，不再连直射光一起压暗。

这里的环境漫反射来自本地 cubemap 的 spherical polynomial，是实时光栅对多
方向反弹光的预计算近似，不是实时多次反弹 GI。不得把它标注为路径追踪或真实
多次反射。

最终 Windows debug-host 像素证据：

- WebGPU：实际后端 `WebGPU1`，Babylon Light 对象 1、语义光源 2、主光
  `castShadow=true`、PCSS 2048；画面亮度跨度 `0.1017`；
- WebGL2：实际后端 `WebGL2`，相同双源语义；画面亮度跨度 `0.1053`；
- 两端 `gpuVertexColor.enabled=false`、方向光/环境光/投影/完整合成的消融
  哈希互不相同，无 shader error、context loss 或黑帧；
- 以上不是 Release EXE、真实 TIFF、macOS 或 Linux 证据，不能越界替代。

## 2026-07-31 复发审计

最新截图证明本 BUG 不能保持“已修复”结论。固定石膏材质已经落地，但旧
`materialMode` 仍同时充当灯光状态机：`white` 启用棚拍灯架与自动曝光，
`custom/relief` 则退出该路径并把塑形灯强度写为 0。快速方案切换时，同一石膏
表面因此会进入两套不同的灯光、AO 和 tone-mapping 路径，并可能继承上一状态的
零强度。

本轮修复将状态收敛为单一石膏棚拍路径：

- 旧设置读取后强制迁移到 `materialMode="white"`、`textureMode="none"`；
- 均衡、柔光、雕刻三个快捷方案只修改灯光/背景键，不再修改几何、相机或导出；
- 每次环境更新同步写入主方向光和环境 irradiance 的完整安全状态，再由尺度
  自适应灯架接管；
- 主光方位角与高度角改为真实世界方向，表单滑块不再是死控件；
- 表单移除不会影响固定石膏表面的旧材质、颜色与贴图控件。

Node 回归新增设置表单契约与三方案双源全量状态测试。双后端真实像素 Harness
仍是 Release 验收闸门，不能由 Node 单测或 Web 构建替代。

## 症状

- 内置 640 × 480 示例地形在“灰阶”状态下会显示为纯黑轮廓。
- 在白模、自然、灰阶之间切换时，WebGPU 偶发只剩背景；WebGL2 较难复现。
- 旧 Smoke 使用 4 × 4 ASCII fixture，并在固定等待 750 ms 后只检查设置值，
  因而无法发现真实网格、异步编译和最终画布已经失效。

## 根因

这是四类独立缺陷叠加，不是光线数量或石膏颜色本身造成：

1. 示例地形启动构建没有被等待，预设切换又在新材质编译完成前销毁旧地形，
   因此用户可见帧处在没有可渲染地形的生命周期裂缝中。
2. 白模兼容软阴影 Shader 声明了 `uMask` sampler，却允许其值为 `null`。
   WebGL2 偶尔容忍，WebGPU 创建 bind group 时必须取得具体 GPU 资源。
3. Babylon 已提供 PCSS，但白模仍让 WebGPU 执行旧的 GLSL 平面软阴影兼容
   pass；该 pass 失效时会使整个 WebGPU 帧只剩背景。
4. 固定石膏上线后没有删除旧材质模式对光照的控制，快捷方案仍会切断棚拍灯架、
   自动曝光与单一 AO 组合，造成状态继承和多重压暗。

原设计允许问题发生，是因为“设置已写入”“材质 effect ready”和“画布真实可见”
没有组成同一个提交条件，而且 Harness 没有覆盖内置示例、预设往返及黑帧像素。

## 根因级修复

- 地形构建改为异步事务：新网格完成 Babylon 材质预编译后才原子替换旧网格，
  并记录 `terrainCommittedGeneration`。
- 所有 GPU 资源在设备队列空闲后再回收；后处理管线改为复用，不在切换中反复
  销毁。
- sampler 永久绑定 1 × 1 安全纹理；有效 mask 到达后原位更新或原子换入。
- WebGPU 白模只使用 Babylon PCSS；GLSL 平面软阴影仅作为 WebGL2 兼容层。
- 地形表面统一由 `gypsum-material-policy.js` 生成；快捷预设只改变灯光、色调和
  构图，不改变“石膏”这一表面材质。

## 永久回归 Oracle

- Node 单元测试必须覆盖石膏策略、色阶边界、黑帧分类和 WebGPU 禁止进入 GLSL
  平面阴影。
- Windows Harness 必须用真实 640 × 480 内置示例执行
  `white → clay → relief → white → relief`，每一步都要求：
  - 构建代次等于提交代次；
  - 所有 submesh/effect ready；
  - `surfaceMaterial="gypsum"`；
  - 无 runtime/effect/context-loss 错误；
  - 画布存在足量地形前景，且不属于纯黑或背景空帧。
- WebGPU 与 WebGL2 必须分别实跑，不能用配置值代替实际后端。

## 禁止的修复

- 不得以抬高背景、曝光或环境光掩盖空帧。
- 不得使用固定延时、按钮选中状态或“截图文件非空”作为通过条件。
- 不得在新网格 ready 前销毁当前可见网格。
- 不得给 WebGPU Shader 留下任何 `null` sampler。
