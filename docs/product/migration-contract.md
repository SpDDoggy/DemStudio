# DEM Studio 宿主迁移契约

## 已确认目标

- 产品根目录：`H:\DEM Studio`
- 产品形态：独立桌面应用
- 宿主：Tauri 2
- 目标平台：Windows、macOS、Linux
- 长期方向：独立产品，不依赖 Lens 才能运行

## 当前行为基线

来源文件：

`F:\BaiduSyncdisk\Lens\Lens\Plugins\addins\dem-studio.html`

迁移基线版本为 `0.12.1`，原始文件 SHA-256：

`D73FFF04901D87E22D09F6B9E7436DF56E946FF9F6D5F1DEFCB44A79FC5DA539`

## 必须保持

- 输入：GeoTIFF、HGT、ASC、PNG、JPG、WebP。
- 侧车信息：PRJ、AUX.XML、TFW、TIFW、WLD。
- 地形预览、相机、光照、材质、纹理和预设行为。
- PNG、GeoTIFF、PNG + World File、TIFF + World File 导出。
- CRS、范围、方向、NoData 与地理变换语义。
- 设置、自定义预设和最近文件的持久化能力。

## 宿主替换面

| Lens 能力 | Tauri 能力 | 兼容策略 |
| --- | --- | --- |
| `db.load/save` | Store plugin | 保持异步键值接口 |
| `fs.selectDialog` | Dialog plugin | 保持保存路径返回值 |
| `fs.writeBuffer` | File System plugin | 兼容旧 Base64，并优先直接写 Blob |
| 生命周期 freeze/resume | 独立窗口生命周期 | 删除宿主依赖，保留页面可见性优化候选 |
| snapshot message | Store 持久化 | 不再依赖父窗口通信 |

## 第一阶段非目标

- 不重新设计 UI。
- 不改变 DEM 算法结果。
- 不引入云服务和账户系统。
- 不在 Windows 上伪造 macOS/Linux 已验证结论。
- 不把没有性能证据的代码提前迁入 Rust。

## 三端数据目录

正式数据不写入安装目录，统一使用操作系统应用数据目录，由 Tauri Store/Path API 解析：

- Windows：应用数据目录
- macOS：Application Support
- Linux：XDG data/config 目录

业务层不得拼接平台专用绝对路径。

## 验收

1. 断网启动并加载所有运行时依赖。
2. 使用同一组样本比对四类导出结果。
3. CRS、GeoTransform、边界、NoData 可机器校验。
4. 设置和预设重启后恢复。
5. 大文件导出不经 Base64 IPC。
6. Windows 实机通过后，分别在 macOS 和 Linux 执行同一测试清单。

## 当前自动化样本

`tests/fixtures/smoke-terrain.asc` 用于运行时闸门，验证：

- Tauri 宿主兼容层加载；
- Three.js Canvas 创建；
- ASC 文件输入事件；
- 4 × 4 栅格解析；
- 数据集切换和地形重建；
- 页面无启动错误。

## Lens 状态迁移

迁移工具不会修改旧 Lens 数据，只把已知键转换为 Tauri Store 命名空间：

```bash
npm run migrate:lens -- --source "<Lens db.json>" --target "<Tauri dem-studio.json>"
```

默认拒绝覆盖已有独立版状态。只有人工审查目标文件后才能加 `--force`。
