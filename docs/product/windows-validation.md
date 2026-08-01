# Windows 验证记录

- 日期：2026-07-27
- 系统：Windows 11 x64
- WebView2：150.0.4078.83
- Rust：1.96.0
- Tauri CLI：2.11.4
- Tauri crate：2.11.5

## 已通过

- npm 依赖安装，审计结果 0 vulnerability。
- Vite Production 构建，240 个模块。
- Three.js 与 GeoTIFF 本地打包。
- Rust Release 构建。
- NSIS x64 安装包生成。
- Release EXE 创建窗口、持续响应并正常退出。
- Tauri Store、Dialog/FS 兼容层在页面中可用。
- Three.js 创建两个 Canvas。
- 示例地形正常渲染。
- ASC 4 × 4 样本通过 Tauri 路径读取、Rust 解析和地形重建。
- 页面启动状态无错误。
- Lens 设置和 5 条最近文件记录迁入独立版 Store。
- WebView2 Crashpad 未生成崩溃报告。
- 真实 762 × 762 PNG 高程图完成 512 × 319、256 spp 成片路径追踪输出。
- 历史基线中的 20,000 × 20,000 Float32 分块压缩 GeoTIFF 完成文件后备导入、128 × 128 首屏和旧版 512 × 512 全幅精化；当前按视口窗口 LOD 的实现仍需重新采集运行时证据。

## Rust Core 与 Fluent 壳

- Rust Core 9 个单元测试通过。
- ASC、HGT、TIFF 解码与 GeoTIFF 仿射变换测试通过。
- 网格抽样、NoData 邻近填充和平滑测试通过。
- RGBA GeoTIFF 编码和回读测试通过。
- 运行时确认 `hostCore = rust-dem-core`。
- 4 × 4 ASC 经 Rust 解析与抽样后完成 Three.js 渲染。
- 运行时生成 439 字节测试 GeoTIFF，字节序和 TIFF 魔数正确。
- 无边框标题栏高度为 52 px，系统窗口 API 可调用。
- Fluent 工作区通过 1440 × 900 截图检查。
- 产品源码中不存在浏览器 `alert`、`confirm`、`prompt` 或文件输入；提示、确认和命名操作使用 DEM Studio 对话框。
- DEM 与纹理导入使用 Tauri 桌面文件选择器；读取权限收窄为用户选择的单文件。
- 最近文件保存源路径并可通过 Rust Core 直接重开；旧版无路径记录会进入应用内提示。
- 分辨率、顶点数和显示模式已并入资源卡片。
- 左右卡片收起为具名胶囊，运行时验证收起状态并完成 1440 × 900 视觉检查。
- 世界坐标网格随镜头移动并按距离、视线夹角渐隐，运行时确认使用无限网格着色器。
- 正交与透视切换同时验证设置值、真实相机类型和按钮状态，状态不一致时自动重建相机。
- 资源面板不存在与顶部“导入 DEM”重复的导入入口。
- 标题栏计算样式为完全透明、无 `backdrop-filter`，52 px 拖拽区域仍可接收指针事件。
- 最小化、最大化/还原和关闭为三枚 28 × 28 px 圆形按钮，右上功能岛无遮挡。
- Windows Release EXE 的 PE Subsystem 为 `WINDOWS_GUI (2)`，启动时不创建控制台窗口。
- 顶部重复的保存/导出功能岛已移除，地形设置内的“保存当前”和导出入口保持可用。
- 左下 GPU/FPS 状态与右下帮助/设置操作已移除，运行时不再执行无展示用途的 FPS 统计。
- 运行时断言确认重复功能岛和工作区页脚不存在，同时面板保存/导出节点存在。
- ASC 冒烟入口改为异常直通，只有出现 `Rust Core` 导入完成状态才允许通过。
- 冷启动后的最近文件条目通过真实坐标点击一次打开，验证事件委托与 ID 归一化修复。
- Core v2 通过二进制 Float32 IPC 返回预览；历史 20,000 × 20,000 验收时前端 `rawLength=0`，Core 仅保留 1 个 file-backed 句柄。
- 旧全幅精化路径的大栅格验收中，Tauri 父进程峰值工作集为 115,261,440 bytes，总耗时 81.24 秒；该数字不是当前窗口 LOD 路径或完整 WebView2 进程树的性能结论。
- 成片通道使用独立环境、三点面光、8 次反弹、256 spp 与边缘保持降噪；真实样本输出非空 PNG。

## 构建产物

### 独立 EXE

- 路径：`src-tauri/target/release/dem-studio.exe`
- 大小：13,509,120 bytes
- SHA-256：`7B1911050A804D7CF90FB7CD1E152D22DA0AC53F27EF1154EDB2CA75925E3815`

### NSIS 安装包

- 路径：`src-tauri/target/release/bundle/nsis/DEM Studio_0.12.1_x64-setup.exe`
- 大小：3,918,675 bytes
- SHA-256：`71E27ACFF4478FF6355C4BEA30AD9E2B82E50413CDD2B69ED7B14A4036C3BD94`

## 尚未通过

- HGT 真实样本回归；GeoTIFF 与 PNG 已有本轮真实样本运行时证据，但尚未形成跨平台金样集。
- PNG/GeoTIFF/World File 自动导出回归。
- 大栅格全分辨率增强导出、BigTIFF/COG 与多尺寸基准矩阵。
- 大 DEM 已有单个 20k tiled Float32 GeoTIFF 的分阶段证据，但尚未覆盖 4k/10k/30k、strip/tile、无压缩/LZW/Deflate 和多 NoData 比例矩阵。
- 内存 Harness 已能聚合根进程和 WebView2 后代；GPU dedicated/shared、JS heap 与跨平台峰值仍未进入同一 Oracle。
- 窗口抽样和 focus LOD 已运行通过；真正可取消的 Rust 解码、跨窗口持久 LRU、完整四叉树和自动瓦片接缝轨迹测试尚未完成。
- 安装、卸载、覆盖升级回归。
- Windows 代码签名。

## 2026-07-30 Release EXE 离线入口修复

- 发现旧的 `src-tauri/target/release/dem-studio.exe` 实际包含
  `http://127.0.0.1:1420`；`release` 目录名不能证明它使用了 Tauri
  生产构建上下文。
- 生产基础配置已移除 `devUrl`；开发服务器入口隔离到
  `src-tauri/tauri.dev.conf.json`，仅 `desktop:dev` 显式使用。
- 正式独立 EXE 改由 `scripts/build/build-release-exe.ps1` 调用 Tauri CLI
  `build --no-bundle` 生成。
- `scripts/verify/verify-release-exe.ps1` 会拒绝任何仍包含 1420 开发入口的
  成品，并要求存在内嵌生产源 `tauri://localhost`。
- 本机确认端口 1420 无监听后冷启动新 EXE：进程持续存活 8 秒，随后通过
  主窗口正常关闭。
- 新 EXE 大小：13,812,224 bytes。
- 新 EXE SHA-256：
  `F5BB7292BD6CCA99E505E753F7E48FD4233B041D521C927EA1EEB6B7A920B8C5`。

## 2026-07-29 窗口 LOD 与多方向天空光照

- `sample_dem_window_binary` 已完成 Rust Core、Tauri、Host Bridge 和页面端到端接入；旧采样 API 保留。
- file-backed 20k GeoTIFF 首屏保持 128×128 overview，未再自动执行整幅 512×512 解码；相机拉近后请求 257×257 focus LOD。
- 父级网格在 focus 窗口内移除对应三角形，子级边缘向父级高度渐变；运行时截图未再出现父子面穿插形成的碎片扇面。
- 实时循环使用按需重绘，静止时 `continuousLoop=false`；交互期暂停高成本后处理，结束后恢复。
- 20k 窗口 LOD 基线证据：首帧 1,407 ms，focus LOD 2,980 ms；5 秒真实相机环绕与正交缩放共 376 帧，交互帧间隔 p95 13.6 ms（约 73.5 FPS），进程树峰值工作集约 613 MB。该大文件已不在工作区，本轮最终光照校准后没有伪造“重跑”结论。
- 运行时读取到 overview 天空可见度范围 0.853–1.000、focus LOD 范围 0.153–1.000；focus 使用真实窗口世界跨度计算像元步长。天空可见度现在通过独立 `horizonVisibility` attribute 只调制间接漫反射，不再乘入白模底色或主光。
- focus 窗口扩大为当前视域周边约 20% 的源范围，父级挖洞与子级边界共用同一组 root-grid 坐标，并使用最多 96 圈的宽渐变带吸收粗细层级的低频差异；Harness 分别保存 focus 生效和回到 overview 后的截图。
- 运行时回归同时断言 focus 网格索引数等于规则网格理论值，且父级索引缓冲长度严格等于当前材质组索引总数。禁止复用较长旧索引缓冲并仅覆盖前缀；该做法曾造成旧索引尾部参与绘制，形成放射状破面。
- 多方向天空光照纯函数测试 9/9；Rust Core 15/15；静态基线全通过；Windows debug Tauri 构建通过。
- 尚未完成完整四叉树、跨窗口持久 CPU/GPU LRU、真正可取消的 Rust 解码、瓦片化全分辨率导出及跨平台实机。

## 2026-07-29 最近图片重开、NoData 轮廓与白模对标

- PNG/JPG/WebP 最近记录不再依赖文件选择器的临时前端权限。宿主新增仅允许图片高程扩展名、仅读取所给单文件路径的 `read_heightmap_path`；两进程 Harness 在第一个桌面进程写入真实 PNG 最近记录并退出，第二个全新进程以真实坐标点击一次打开，复核 762×762、有效采样网格和无错误框后通过。
- 对话框按钮遵循原生 `hidden` 语义，单操作错误框不会再显示空白次按钮；拒绝值即使是字符串也会进入可读错误信息。
- 二进制地形采样升级为 DMT3 v2，除高度外携带等长有效区掩膜；Host Bridge 继续兼容 DMT2 v1。根网格和 focus 网格均跳过无效三角形，根网格只沿有效区边界建立侧壁。
- `nodata-island.asc` 运行时截图确认地形轮廓不再退化为整块矩形；focus 索引 Oracle 改为比较实际有效三角形期望值，允许含 NoData 的窗口被正确验证。
- 白模实时渲染已改为分层能量结构：单一 Directional 主光建立大形体，低强度环境/半球/面光只补暗部；16-sample GTAO 负责窄沟接触，8 方位 × 5 仰角天空可见度只压间接漫反射，Directional shadow 只保留少量自遮挡与工作室投影。历史最终证据已整体迁入 `artifacts/runtime/historical/runtime-lighting-final/`，其中 `all.png` 及同目录五层消融图保持原始哈希。
- Harness 会等待天空可见度 worker 真正写回，实切 AO 并断言 GTAO 与 horizon 同时归零/恢复；六种消融结果必须生成六个不同的解码像素签名，防止“文件存在但分层无效”的错误绿灯。
- 独立视觉 Agent 对最终候选复核为 PASS：主光方向明确，亮坡与背光坡形成体积，沟谷保持可读，左下 shadow acne 已消除；横贯上部的结构经与原始 PNG 对照确认是天然主脊，不是 LOD 接缝。
- 性能 Harness 不再把静止 WebView RAF 当作渲染 FPS；当前会在交互质量模式下连续驱动真实相机环绕和正交缩放，并同时读取实际 renderFrame 时间与帧间隔。
- 当前最终白模配置在同一 762×762 真实山区全量网格上完成 5 秒真实相机环绕与正交缩放：375 个交互帧，帧间隔 p95 13.5 ms（约 74.07 FPS），完整进程树峰值工作集约 919 MB。交互期间按设计暂停 GTAO，结束后恢复；该证据不与 20k file-backed overview/focus 基线混写。

## 2026-07-30 五档 LOD、真实顶点与白模标杆

- 网格质量现在为 256/512/1024/2048/4096 五档，并分别限制到
  streaming L1/L2/L3/L4/L5。2048/4096 只对可回读的 file-backed DEM
  开放，采用当前视图自适应精化，不构建巨型单网格；非 file-backed
  数据会禁用并钳制到 1024，避免给出无法兑现的伪高精度。
- HUD 和 Harness 读取活动瓦片真实顶点/三角形、目标/实际最大层级、层级
  直方图、覆盖状态与 GPU 字节，不再用 128 根概览冒充最终精度。
- 指定 31,984 × 18,495 TIFF 的 1024 档 settled focus 为 63 个 L3 瓦片、
  1,048,383 顶点、762,571 三角形；根层顶面关闭，NoData 边界基座保留，
  队列归零，GPU 几何 65,064,612 bytes。`baseThickness = 0` 时，根层粗糙
  顶面及粗边墙均隐藏；所有活动瓦片均继承真实 horizon 可见度。
- 文件解码并发由四路收紧为两路，Rust 窗口缓存由 128 MiB 收紧为 64 MiB，
  overview 与首批瓦片错峰启动。精确发布版的完整进程树峰值为：
  1024 档 1,543,831,552 bytes、2048 档 1,127,399,424 bytes、4096 档
  1,102,073,856 bytes，均通过 1.5 GiB 硬门；summary 同时冻结了当次
  内存阈值，避免默认关闭硬门后仍写 PASS。
- 同一真实 TIFF 的 2048 settled focus 为 96 个活动瓦片、最高 L4、
  1,597,536 顶点、902,341 三角形；4096 settled focus 为 128 个活动瓦片、
  最高 L5、2,130,048 顶点、1,550,111 三角形。两档均由精确发布版运行时
  证据确认，不以配置项或静态检查代替。
- 白模采用 225°/32° 单主光、Neutral tone mapping、近白材质、低频 horizon
  遮蔽、16-sample GTAO、真实方向光投影和 validMask 轮廓感知的宽羽化
  工作室投影；软影纹理只在地形重建时预模糊一次，运行时单采样。最终与目标图
  同区域亮度为 P1 79.9/90、P10 121.9/125、P50 193.6/194、P95 235/236、
  P99 237/248（当前/目标）；核心亮度与体积达到标杆，极少量纯白边缘的
  P99 仍低 11，作为可见残差记录，不用过曝破坏主体层次去追单一分位数。
- 最终白模 762 × 762 全量网格真实交互帧间隔 p95 为 13.6 ms
  （73.53 FPS）、p99 13.9 ms、最大 17.5 ms、Long Task 为 0；
  base/slope/SSAO/horizon/cast/all 六层在同一环境光基线下分别消融且
  像素签名互异。
- 最终优化版 EXE：
  `src-tauri/target/perf/release/dem-studio.exe`，
  SHA256
  `A1C85C93276F567E3DC103B630D09AA02967D39FA1F99078FCC2ED70B78D105C`，
  13,811,200 bytes。
- 证据目录：
  `artifacts/release-A1C85C-frmm-matrix-20260730/1024/`、
  `artifacts/release-A1C85C-frmm-matrix-20260730/2048/`、
  `artifacts/release-A1C85C-frmm-matrix-20260730/4096/` 与
  `artifacts/release-A1C85C-white-20260730/`。
- 尚未完成跨显卡、长时间连续漫游与多种超大 TIFF 的压力矩阵；本次验收
  证明的是指定真实文件与当前目标机上的 1024/2048/4096 闭环，不外推为
  所有设备、所有数据均可无条件全幅 4096。

## 2026-07-31 Babylon.js 一次性迁移最终证据

本节取代本文件中 Three.js、路径追踪、旧 focus LOD 和旧 63 瓦片/活动集
数字作为当前发布判断；历史记录保留用于说明问题演进，不能再当作当前实现。

### 验证对象

- Release Harness EXE：
  `src-tauri/target/perf/release/dem-studio.exe`
- EXE SHA-256：
  `3B95A8C50BACE3725C87677E1A24EC8CDC730F214D7D28996BFC2FCEBEED4826`
- EXE 大小：13,897,216 bytes
- 真实 TIFF：
  `F:\BaiduNetdiskDownload\西南战区\滇南\FRMM_EarthPrinter_DN_PREC_2024.tif`
- TIFF 尺寸：31,984 × 18,495
- TIFF SHA-256：
  `EB5FEDDF70C0333629DF6BC622A9B001379278F372884B90B7C9D547E7A721BC`
- TIFF overview：128 × 74，valid=3,447，mask hash=986830350，
  min=622，max=2,239。

### 已通过

- `@babylonjs/core` 精确锁定 9.18.0；生产源和 bundle 无 Three.js、
  three-gpu-pathtracer、three-mesh-bvh、xatlas-web 或 CDN 运行时导入。
- 原生 WebGPU、强制 WebGL2、注入 WebGPU 初始化失败后的 WebGL2 回退均以
  同一 EXE 通过；回退记录明确失败原因，三者 context loss 均为 0。
- 1024 档完成 64 个全域 L3 基座：42 个有效网格、22 个 NoData empty；
  698,922 顶点、769,158 三角形；overview 顶面关闭，覆盖完整，队列归零。
- 基座完成后的真实 rotate/pan/wheel 60 秒：
  `terrainBuildGeneration 2→2`，base sample/build/upload/dispose 增量均为
  0，基座对象 ID、顶点和三角形保持不变，context loss 为 0。
- 2048 档保持 64 个 L3 基座，目标精化 40、驻留精化 48；4096 档保持
  64 个 L3 基座，目标精化 78、驻留精化 101。两档返回已访问视角时
  refinement sample/build/upload/eviction 增量均为 0，对象 ID 保持稳定。
- 15 分钟连续交互：67,551 次视口变化，p50 13.3 ms、p95 13.4 ms、
  p99 13.5 ms、最大帧 40.1 ms、Long Task 0。
- 15 分钟完整进程树：60 个样本，去除前 20% 预热后的四个中位数为
  1,007,423,488 / 1,005,944,832 / 1,010,237,440 /
  1,016,139,776 bytes；稳态增长 8,716,288 bytes，峰值
  1,032,650,752 bytes，低于 1.5 GiB。
- 成片输出 256 × 159 PNG、16,821 bytes、32 帧累积、4× MSAA，
  `renderer="babylon-high-quality-raster"`；透明与不透明像素同时存在，
  亮度范围 61。
- base/environment/ssao/direct/floor/shadow/all 七组消融均生成非空 PNG，
  7 个 SHA-256 互不相同。

### Harness 根因修复

前两次 15 分钟测试的 p95/p99 与 Long Task 已通过，但各出现一次
50.2–50.3 ms 最大帧。根因不是通过放宽门槛处理，而是修复 Harness：

- 15 秒分块之间保持同一交互会话，避免反复恢复/销毁 Babylon 后处理。
- 逐帧采样从每帧 Promise 改为单一 Promise 加复用 rAF 回调，消除约
  67,000 次 Harness 自身短命分配。
- 最终仍使用原 p95 ≤ 16.7 ms、p99 ≤ 25 ms、最大帧 ≤ 50 ms、
  Long Task = 0 硬门。

永久记录：
`docs/product/BUG-2026-07-31-INTERACTION-HARNESS-ALLOCATION-SPIKE.md`。

### 证据边界

- 上述为 Windows 11 当前目标机的真实 Release EXE、真实 TIFF 和运行时
  Harness 证据。
- 尚未取得 macOS、Linux、其他显卡、其他编码/分块形式 TIFF 的实机结论。
- 正式无调试端口 EXE 由同一源码另行构建；其哈希只证明产物身份，运行时
  Harness 结论绑定上述可观测 Release Harness EXE。

### 正式无调试端口产物

- 路径：`src-tauri/target/release/dem-studio.exe`
- 大小：13,896,192 bytes
- SHA-256：
  `E3E2885B755133580341F4C254A5B53A953898ED2FB99C0C658983CD683277E4`
- 构建闸门确认不存在 ASCII 或 UTF-16 localhost/127.0.0.1 开发入口，并
  存在内嵌 `tauri://localhost` 生产源。
