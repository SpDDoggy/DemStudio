# BUG-2026-07-30：大 GeoTIFF 概览矩形化与 LOD 父层穿透

## 状态

已完成根因修复，并通过指定真实 GeoTIFF 的 Release EXE 运行时回归。

## 复现资产

- 主文件：`F:\BaiduNetdiskDownload\西南战区\滇南\FRMM_EarthPrinter_DN_PREC_2024.tif`
- SHA256：`EB5FEDDF70C0333629DF6BC622A9B001379278F372884B90B7C9D547E7A721BC`
- 文件大小：91,521,133 bytes
- 栅格：31,984 × 18,495、Int16、NoData `-32768`、EPSG:4326
- 存储：128 × 128 tiled、LZW
- 精确同名侧车：
  - `FRMM_EarthPrinter_DN_PREC_2024.tif.ovr`
  - `FRMM_EarthPrinter_DN_PREC_2024.tif.aux.xml`

主 TIFF 的块边界高程跳变与块内对照一致，源数据不存在规则矩形接缝；截图中的方块由 DEM Studio 生成。

## 现象

- 首屏和静止精化后出现大块规则矩形地形、竖墙和错层。
- 有效区轮廓缺失，山地只在若干方块内出现。
- 高低端地形被压成平顶或平底，表现为“精度不够”。
- 子瓦片 NoData 洞中会露出粗根层。

## 根因

### 1. 统计抽样被错误复用为显示概览

`open_geotiff_path` 为控制统计成本，只读取最多 6 × 6 个源块并取每块中心像元。现有设计又把这 36 个统计点直接保存为显示概览，再最近邻放大到 128 × 74。

该文件 6 × 6 网格只有 9 个中心点有效，因此 9 个点被膨胀为规则矩形。

与 128 × 74 参考掩膜相比，旧结果：

- IoU：0.6549
- 漏失真实有效像元：917，占真实有效区 26.29%
- 错误增加有效像元：438，占粗概览 14.56%
- 共同有效区高程 MAE：94.05 m
- P95 绝对误差：261.08 m
- 最大误差：532 m

### 2. min/max 只来自 36 个抽样块

旧 Core 得到 795–1782 m，真实统计为 622–2239 m。后续窗口采样使用错误范围归一化并 clamp，约 12,695,690 个有效像元被压到 0 或 1，占有效数据 5.853%。

精确统计已经存在于同名 `.tif.aux.xml`，但路径导入没有自动发现或读取。

### 3. 外部金字塔被忽略

该数据的 2/4/8/16/32/64/128 金字塔位于同名 `.tif.ovr`，不是主 TIFF 内嵌 IFD。旧路径只打开主 TIFF，因此忽略了可直接用于 128 × 74 根概览的 250 × 145 层。

### 4. 流式瓦片向 6 × 6 根层做宽融合

129 × 129 瓦片使用 48 圈 edge morph，约 75% 横截面被重新拉向极粗根层，造成台阶和细节损失。

### 5. 根层顶面始终存在

瓦片 display set 只管理子层和祖先瓦片，没有撤下 `terrainBaseMesh` 的根层顶面。子层 NoData 不建三角形时，下方粗根层从洞中透出，形成方块与竖墙。

## 为什么现有设计允许发生

- 旧 Core 把“用于近似统计的有界抽样”和“用于显示的空间连续概览”视为同一资产。
- 文件路径导入只信任显式选择的侧车，不具备精确同名 PAM/OVR 的连续工作流。
- LOD Harness 只断言请求、上传、活动网格和预算，没有验证有效区掩膜、父子覆盖或根层可见性。
- 截图被保存但不参与 Oracle，因此规则方块仍可假绿。

## 根因级修复

- 统计网格继续保持最多 6 × 6，只用于回退统计，不再作为优先显示概览。
- 路径型 GeoTIFF 只在主文件旁精确探测 `${path}.ovr` 与 `${path}.aux.xml`：
  - 不扫描任意目录；
  - 原文件与侧车只读；
  - AUX XML 设置 16 MiB 上限；
  - 显式 companion 仍可覆盖自动发现。
- OVR/PAM 是可丢弃派生资产；缺失、损坏或统计校验失败时安全回退，不得阻止主 TIFF 打开。
- 优先从 OVR/内嵌金字塔选择长宽比一致、最大边不超过 1024、且最接近目标分辨率的 IFD。
- 优先采用 PAM/GDAL 中经过有限值和 `min < max` 校验的 `STATISTICS_MINIMUM/MAXIMUM`。
- 流式瓦片不再向根概览执行 48 圈宽 morph；旧 root+focus 路径保持原回滚语义。
- 目标瓦片全部 ready 且队列归零后，根层顶面被移除；既有 `baseIndices`（本数据对应 NoData 边界墙）原样保留。
- 选择变化或加载未完成时恢复根层顶面作为 fallback，禁止半覆盖状态露空。

## 永久回归 Oracle

### Rust Core

- 自动发现精确同名 `.ovr` 与 `.aux.xml`。
- 公开 DMT3、采样命令和设置 schema 不变。
- 测试 fixture 必须证明：
  - OVR 有效区掩膜被使用；
  - PAM min/max 被使用；
  - NoData 保持无效，不得改成 valid 或高度 0 遮挡物。

### 真实文件

- `width=31984`、`height=18495`、`rawLength=0`
- `minimum=622`、`maximum=2239`
- overview：128 × 74，共 9,472 个样点
- valid count：3,447
- FNV-1a mask hash：986,830,350
- settled：
  - `coverageComplete=true`
  - `rootTopVisible=false`
  - `rootTopIndexCount=0`
  - `rootBaseIndexCount=expectedBaseIndexCount=2970`
  - `rootIndexCount=rootGroupIndexCount=2970`
  - `focusLodActive=false`（streaming 与 legacy focus 不得同时拥有顶面）
  - `readyDesiredCount=desiredTileCount`
  - pending/request/upload queue 均为 0
  - `edgeMorphWidths=[0]`
- Core 只保持一个 file-backed dataset。
- 稀疏 NoData 回归用例必须证明：即使 6×6 统计抽样全部落空，有效的精确同名 OVR/PAM 仍可完成打开。

只检查“有网格”“请求成功”“FPS 正常”均不构成通过。

## 运行时证据

Release EXE：

- SHA256：`A5BB492DCF4D73350F54669106DFF364F8CB204636BE0B57C4C783CC3AD86F79`
- 打开：159.20 ms
- overview ready：426.36 ms
- first frame：453.37 ms
- 目标瓦片：55–56
- 请求/完成：81/81
- settled 后活动瓦片：55
- 根层顶面：关闭
- edge morph：0
- 完整进程树观测峰值工作集：938,233,856 bytes
- WebView2 观测峰值工作集：730,578,944 bytes

证据目录：`artifacts/real-tif-regression-20260730-final/`，包含 `runtime.log`、`summary.json`、`settled.png` 和 `final.png`。

## 回滚

- Core 可停止自动侧车读取并回到主 TIFF 的统计回退概览。
- 前端可通过既有 `legacyFocusLod=1` 回到旧 root+focus 路径。
- 回滚不需要迁移 DMT3、用户设置、最近文件或源 DEM。
- 不允许以“填平 NoData”作为回滚或修复手段。
