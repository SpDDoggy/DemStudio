# BUG-2026-07-30：TIFF 视域选择与 GPU 驻留耦合

## 用户可见症状

- 完整 TIFF 地形无法稳定建立；当前镜头外的部分会从模型中消失。
- 每次 rotate、pan 或 wheel 后都会再次出现抽样、构网和 GPU 上传。
- 返回刚访问过的区域仍会重复工作，并可能短暂闪空。

## 根因

旧调度器只有一个“当前显示瓦片”集合。镜头变化产生新集合后，
`updateTerrainTileDisplaySet` 会直接销毁未被新集合选中的网格。这个集合
同时承担了可见性、任务需求、完整度和 GPU 生命周期四种互不等价的职责。

因此问题不是 TIFF 解码器不能读取完整数据，也不是 Three.js 单独造成：
只要“未显示”等同于“应释放”，更换任何渲染引擎都会重复发生。

## 现有设计为何允许问题

1. 完整度以当前显示集覆盖判断，而不是以不可淘汰的全域基座完成状态判断。
2. 请求取消、上传拒绝和网格释放都读取同一个随相机变化的 desired 集合。
3. 没有独立的 `requiredBaseTiles`，NoData 空瓦片也没有可持久的完成状态。
4. 精化没有隐藏驻留态，离开视锥只能立即销毁。
5. 诊断只报告累计请求和活动网格，没有冻结基座对象身份与生命周期增量。

## 根因级修复

- 将状态拆成 `requiredBaseTiles`、`readyBaseTiles`、
  `desiredRefinementTiles` 和 `residentRefinementTiles`。
- 256/512/1024 枚举完整 L1/L2/L3 基座；2048/4096 固定完整 L3 基座。
- 基座请求只允许因数据集、质量或影响几何的数据设置变化而重建。镜头变化
  只能给未开始任务重新排序，不能取消、清队列或释放。
- NoData 空瓦片以 `empty` ready 记录参与基座完整度，不创建无效网格。
- overview 顶面只在所有基座（包括 empty）ready 后原子撤下。
- 精化离开视域后隐藏并保留在有界 LRU，只有 192 MiB 预算压力才淘汰最旧的
  非可见精化。
- 诊断公开构建代次、基座对象 ID、顶点/三角形及 base/refinement 分项
  sample、build、upload、dispose、cache hit、eviction。

## 永久回归 Oracle

1. 纯函数/状态测试必须证明 1024 档拥有恰好 64 个 L3 基座，empty 同样完成。
2. 改变精化选择不能改变任何已完成基座计数。
3. 超预算时只能淘汰非可见精化，基座和当前可见精化不可被牺牲。
4. Release EXE 的真实 TIFF 完成基座后执行真实 rotate、pan、wheel 60 秒：
   `terrainBuildGeneration` 不变；base sample/build/upload/dispose 增量均为
   0；基座对象 ID、顶点和三角形不变；活动网格不为 0；context loss 为 0。
5. 1024 金样必须为 64 个基座、ready=required、pending base=0。

## 禁止的“修复”

- 不得通过增大延迟、隐藏 HUD、吞掉取消或释放错误来让计数看起来稳定。
- 不得保留 overview 顶面遮盖缺失瓦片后声称完整。
- 不得在交互时换低精度几何或重新建立全域地形。
- 不得把 WebGPU/WebGL2 后端切换当作地形生命周期修复。

