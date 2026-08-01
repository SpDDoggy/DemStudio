# DEM Studio 文档权威索引

## 权威顺序

1. 用户当前明确决定。
2. 根目录 `AGENTS.md` 的工程约束。
3. 已确认且未被取代的 ADR。
4. 与具体 EXE、输入和 SHA-256 绑定的验证记录。
5. 当前测试、脚本与源码可执行行为。
6. 历史接管、旧实现和实验记录。

## 当前文档

- `adr/0006-babylon-renderer-and-persistent-terrain-residency.md`：当前 Babylon 渲染与地形驻留架构。
- `adr/0005-hundred-million-point-streaming-lod.md`：一亿源高程点 LOD 方向，状态为实施中。
- `product/windows-validation.md`：Windows 验证边界和历史证据演进。
- `product/BUG-2026-07-31-WEBGPU-GYPSUM-BLACK-FRAME.md`：石膏黑帧根因与最终回归 Oracle。
- `governance/adoption/cleanup-triage-2026-08-01.md`：当前目录整理与保护边界。

## 部分有效或待刷新

- `product/CODE-AUDIT-2026-07-31.md`：审计发现仍有价值，但其中绿色结论不能替代更晚源码的 Release 验收。
- `governance/adoption/` 下 2026-07-24 接管材料：保留 Tauri 独立产品接管背景；其中 Three.js、初始未知项和早期下一步已经过时。
- `product/windows-validation.md` 中 2026-07-31 之前的 Three.js、旧 focus LOD 和旧活动集数字：仅作历史演进记录。

## 历史文档

- `adr/0004-cinematic-render-and-file-backed-raster.md`：已被 ADR-0006 取代，保留文件后备栅格的历史决策与证据。
- `adr/0001-tauri-cross-platform-host.md`、`adr/0002-rust-dem-core-and-fluent-shell.md`：仍提供宿主和 Core 背景；渲染器部分以 ADR-0006 为准。

## 证据索引

- 本地大型证据：`../artifacts/README.md`。
- 可跟踪哈希清单：`../artifacts/manifests/`。
- 证据文件存在不等于当前源码通过；必须同时核对 EXE SHA-256、输入 SHA-256、summary verdict 和生成时间。
