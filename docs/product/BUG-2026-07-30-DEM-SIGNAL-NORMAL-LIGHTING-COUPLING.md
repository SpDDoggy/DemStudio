# BUG-2026-07-30：DEM 信号、法线与投影光耦合

## 永久禁令

以下行为不得再次进入正式 DEM 管线：

1. 在原始高程归一化前把 U32、I32、I64、U64 或 F64 统一降为 `f32`。
2. 先按目标网格单点抽样，再用目标网格平滑假装完成抗混叠。
3. 连续地表仅使用三角拓扑平均法线作为主法线。
4. 用 8-bit 残差 normal map 替代 DEM 全频梯度法线。
5. 用同一盏低位强方向光同时承担坡面塑形与背景投影。
6. 把 PNG Canvas 高度值标记为与 GeoTIFF 同等级的权威高程。
7. 在预滤波和重采样之后继续用 `smoothSteps` 修改顶点高程。

## 根因

- file-backed TIFF chunk 与内存数据集过早保存为 `f32`，导致大整数和 F64
  的相邻有效高程在归一化前合并。
- root/window/tile 采样均以最近邻单点抽取源像元；后置 `smoothSteps`
  无法恢复已经折叠到低频的混叠。
- 整数高程源的量化台阶在强高差和方向光下会形成梯田条带；继续模糊几何只能
  削低山脊并填平沟谷，不能作为照明伪影修复。
- smooth 网格虽然使用共享顶点平均法线，但结果仍取决于三角剖分、NoData
  缺口和瓦片边界，不是规则 DEM 邻域的连续坡面。
- 白模的低位强方向光既照亮地形又投射底板阴影；为了获得长投影而提高强度，
  会同步放大坡面高频和伪法线。

## 修复合同

正式顺序固定为：

```text
原始数值（f64 保真）
  -> 按输出 footprint 进行 NoData-aware 低通预滤波
  -> 重采样并归一化为渲染高程
  -> 原样写入顶点位置
  -> 仅为光照重建多尺度 DEM 梯度法线
  -> 网格与材质
```

历史 `smoothSteps` 字段仅用于设置与 IPC 兼容，Core、浏览器回退和增强导出均
不得消费它修改高程。界面不得再次暴露几何平滑控制。

白模照明固定拆为：

- 高位宽域 `RectAreaLight`：只负责地形塑形，不投影；
- 低强度环境填充；
- 近零表面辐射的独立 `DirectionalLight`：只负责背景投影；
- 白模地形投射阴影，但不接收投影光的自阴影。

## 自动化 Oracle

- Rust `preserves_large_integer_steps_until_normalization`：用
  `16,777,216..16,777,219` 阻止归一化前精度塌缩。
- Rust `lod_prefilter_suppresses_checkerboard_aliasing`：64×64 棋盘降到
  8×8 后全部处于 0.45–0.55。
- Rust `real_frmm_geotiff_preserves_precision_and_prefilters_when_available`：
  对 31,984×18,495 滇南正式 GeoTIFF 直接执行当前 file-backed 预滤波路径，
  并校验尺寸、高程范围、有效掩膜与归一化有限值。
- JS `terrain-geometry.test.mjs`：解析平面内区法线点积不低于
  0.99999，法线单位长度误差不高于 1e-5，NoData 不注入零高程坡度。
- Rust `legacy_smooth_steps_never_change_authoritative_elevations`：旧设置值为 3
  与值为 0 的输出高程和掩膜逐值相同。
- JS `lighting normals suppress quantized terraces without changing DEM heights`：
  不规则整数台阶的光照法线总变化下降，同时输入高程逐值不变。
- Runtime diagnostics：`normalSource=dem-gradient`；
  `shaping.type=RectAreaLight && shaping.castShadow=false`；
  `projection.terrainInfluence=false && projection.castShadow=true`；
  白模 `receiveShadow=false && normalMap=false`。
- PNG diagnostics：`precisionClass=preview-8bit`、`precisionLossy=true`、
  `precisionRole=preview`、`effectiveLevels=256`。

静态字符串检查、成功构建或单张截图均不能替代上述数值和运行时 Oracle。

## 回滚边界

- 可分别回滚 DEM 梯度法线、LOD 预滤波和灯光拆分。
- 不得回滚原始高程在归一化前保持 `f64` 的精度合同。
- 不得恢复任何对渲染顶点或增强导出高程执行的后置平滑。
- 若预滤波造成性能回退，应改用匹配的 TIFF overview/pyramid 或优化读取，
  不得退回最近邻单点抽样。
