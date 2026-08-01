# ADR-0004：成片渲染通道与文件后备大栅格

- 状态：已被 ADR-0006 取代；以下保留为历史实现与证据
- 日期：2026-07-27
- 决策来源：用户确认 2026-07-27 高风险影响评估

> 2026-07-30 起，实时与成片渲染统一迁移到 Babylon.js。本文中的 Three.js
> 和路径追踪决定不再代表当前产品实现；文件后备 Rust Core 决定继续有效。

## 背景

现有 Three.js 栅格渲染即使加入环境光、接影、GTAO、HDR 和高频法线，仍只能近似直接光与屏幕空间遮蔽，无法形成稳定的多次反弹、软阴影和成片级光能分布。

原 Rust Core 将整幅 DEM 解码为 `Vec<Option<f32>>`，再以 JSON 返回 WebView。Rust 状态、IPC、JavaScript 数组、单体网格和导出缓存会重复持有数据；提高尺寸上限只会把失败推迟到运行时。

## 决定

### 双渲染通道

- 实时预览继续使用现有 Three.js 栅格管线，保证相机与参数交互。
- 新增独立“成片渲染”通道，锁定 `three-gpu-pathtracer 0.0.23`、`three-mesh-bvh 0.9.13` 和 `xatlas-web 0.1.0`。
- 不升级当前 Three.js 0.164.1。
- 成片场景使用独立的天空环境、三点面光、白色接影地面、8 次反弹、渐进采样和边缘保持降噪。
- 正式输出目标为最多 4096 像素长边、默认 256 spp；验收使用真实 762×762 高程图在 512 像素长边完成 256 spp 输出，低采样探针仅用于兼容性检查。

### Core v2 文件后备路径

- `parse_dem_path` 对 GeoTIFF 使用文件后备句柄，不再把全幅高程返回 WebView。
- 首次打开只解码最多 64 个均匀分布的栅格块估算 min/max 与 NoData 比例；`statisticsApproximate=true` 明确统计性质。
- 预览抽样按当前源块行维护有界缓存，不累计整幅解码块。
- 首屏先返回最多 128×128 的文件概览，再后台精化为当前 512×512 交互网格，避免初次可见结果等待完整预览解码。
- 新增原生二进制 `sample_dem_binary`，以固定 16 字节头和 little-endian Float32 负载返回预览。
- 新增 `release_dem` 和 `core_stats`，切换数据集时释放旧句柄，并为运行时 Harness 提供生命周期证据。
- `sample_dem` 保留为兼容入口；浏览器 File 路径和非 GeoTIFF 格式暂保留原实现。

## 非目标

- 阶段一不承诺大栅格全分辨率增强导出、BigTIFF 或 COG。
- 阶段一不把交互网格提高到 4096²，也不一次构造全幅原始分辨率网格。
- 不在本决策中迁移 WebGPU，不升级 Three.js，不改变用户设置序列化结构。

## 兼容与回滚

- 旧 `sample_dem` 命令继续存在；前端优先使用二进制命令，缺失时可回退。
- 非路径导入继续使用内存数据集。
- 成片渲染是独立按钮，不替换实时预览和原导出入口。
- 回滚时可移除新按钮和三个精确锁定依赖，并让 `parse_dem_path` 回到内存数据集；用户设置无需迁移。
- `three-gpu-pathtracer 0.0.23` 的公开 `dispose()` 引用了不存在的 `_renderQuad`。当前适配层按实际 `_quad` 和内部 renderer 释放；升级依赖时必须重新验证并删除不再需要的适配。

## 验收

- Rust 单元测试证明文件后备 GeoTIFF 的元数据不携带全幅 data，并能正确抽样。
- Tauri WebView 证明 `sampleDemBinary`、`releaseDem` 和 `coreStats` 可调用。
- 成片运行时探针必须完成真实路径追踪样本、生成非空 PNG，并报告 renderer 为 `three-gpu-pathtracer`。
- 20,000×20,000 Float32、分块压缩 GeoTIFF 必须打开并生成交互预览；前端 `rawLength=0`，Core 仅保留一个 file-backed 句柄。
- 静态验证、Web 构建、Rust 测试、Tauri 构建和 Windows 运行时必须分别报告，不能互相替代。

## 阶段一验收证据

- Rust Core 9 个单元测试全部通过，其中包含文件后备 GeoTIFF 元数据与抽样测试。
- 冷启动后的“最近使用”条目通过真实坐标点击打开数据集，未出现首次点击丢失。
- Santa Monica Mountains 真实图像高程数据完成 512×319、256 spp 路径追踪输出；白色未命中背景、主体光、环境补光、软阴影、地面接影与降噪均进入最终 PNG。
- 20,000×20,000 Float32 分块压缩 GeoTIFF 完成 128×128 首屏和 512×512 精化；`rawLength=0`、`datasetCount=1`、`fileBackedCount=1`，峰值工作集 115,261,440 bytes，总耗时 81.24 秒。

## 后续

- 精确统计改为可取消后台任务，并将结果与近似统计分开显示。
- 第二阶段增加窗口瓦片请求、四叉树 LOD、CPU/GPU LRU 和跨瓦片法线/阴影。
- 大栅格导出改为瓦片直接流入 Rust TIFF/BigTIFF writer，禁止整幅 RGBA 聚合。

## 2026-07-29：第二阶段首个可运行切片

用户确认以外部 Python 滚动地平线算法的光线思路改善渲染，同时要求大范围 DEM 的交互流畅度。该脚本不能原样移植：方向并行累加存在共享写竞态，固定 padding 会截断远距离遮挡，NoData 被写成 0，且内存估算未覆盖每个并发方向的整块遮蔽数组。

本阶段决定：

- 实时主光仍使用 Three.js PBR、太阳直射和 VSM；新增确定性的 8 方位、5 仰角天空可见度基底，只作为低频环境遮蔽参与顶点颜色，不替代法线主光。
- 天空可见度在模块 Worker 中计算；太阳方位变化只重聚合已有方向基底，不重新扫描 DEM。
- file-backed GeoTIFF 首屏只使用 128×128 overview，不再自动触发整幅 512×512 精化。
- 新增 `sample_dem_window_binary`，按源像素窗口读取涉及的 TIFF chunks，并保持旧 `sample_dem_binary` 兼容入口。
- 相机拉近后请求一个与父级网格边界对齐的 257×257 focus LOD；父级对应三角形必须移除，子级边界向父级高度渐变，禁止以简单高度偏移掩盖层级穿插。
- 实时循环改为 invalidate-on-demand；交互期间降低 pixel ratio 并暂停 GTAO、Bloom、Bokeh 和 Sharpen，交互结束后恢复精渲。
- 当前 focus LOD 是四叉树前的可运行切片，不得写成完整四叉树、跨级 LRU 或全分辨率大图导出已经完成。

兼容与回滚：

- 删除 focus LOD 调用即可回到 128×128 overview；DMT3 v2 在高度数据后增加有效区掩膜，前端解析器继续兼容旧 DMT2 v1。
- 删除天空可见度 Worker 调用即可回到原 PBR/GTAO，不影响数据集和设置序列化。
- 未增加依赖、未升级 Three.js、未修改用户设置 schema。

新增 Harness：

- 纯函数测试覆盖平面、单脊遮挡、NoData 中断、非方形像元、方向重聚合和输入拒绝。
- Rust 测试覆盖内存/文件后备窗口、窗口越界和窗口比例。
- Windows Harness 区分 open、overview、first frame 与 focus LOD，并汇总 Tauri 与 WebView2 进程树内存。

本机 20,000×20,000 Float32 tiled GeoTIFF 证据：

- `rawLength=0`，Core 保持一个 file-backed 句柄。
- 当前最终源状态严格探针：首帧 1,407 ms、focus LOD 2,980 ms；5 秒真实相机环绕与正交缩放共 376 帧，交互帧间隔 p95 13.6 ms（约 73.5 FPS），完整进程树峰值工作集约 613 MB。
- overview 天空可见度范围为 0.853–1.000；257×257 focus LOD 为 0.153–1.000。focus 光照使用窗口实际世界跨度计算像元步长；Worker 结果写入独立 `horizonVisibility` attribute，并在材质 shader 中只调制间接漫反射，不再污染顶点底色或 Directional 主光。
- focus 窗口与父级挖洞必须共享 root-grid 边界坐标，子级使用最多 96 圈的宽渐变带吸收 6×6 粗 overview 与窗口实采之间的低频差异；窄至 3 圈的融合会把差异压成陡壁，不得恢复。
- 父级挖洞必须创建与当前三角形集合精确等长的索引缓冲。只覆盖旧缓冲前缀会让尾部旧索引在实时或成片链路重新参与，形成放射状破面；Windows Harness 固化了 `root index count = group index count` 与 focus 有效三角形索引数断言。
- 进程树峰值工作集约 868 MB，其中 WebView2 子进程约 836 MB；旧 115 MB 数字只统计父进程，已废止为产品总内存证据。

## 最近图片与有效区边界补充决定

- 文件选择器授权不是可持久化最近记录的权限模型。图片高程重开必须走 Rust 宿主的窄命令：扩展名白名单、单路径读取、普通文件检查；禁止为修复最近记录而扩大前端文件系统 scope。
- NoData 不能在抽样后降格为高度 0。内存、overview、窗口和二进制 IPC 都必须保留等长有效区掩膜；渲染端只为三点均有效的三角形建面，并沿有效/无效交界生成侧壁。
- 白模效果的最低 Oracle 同时包含完整构图、不过曝、可读的沟谷层次、局部法线、天空可见度和直接投影。验收必须等待 worker 写回、实切 AO 开关，并证明 base/slope/SSAO/horizon/cast/all 六个消融结果像素签名各不相同；单独提高 AO、锐化或曝光不能作为达到参考效果的证据。
