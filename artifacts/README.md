# DEM Studio 验证资产索引

`artifacts/` 保存本机 Harness、真实输入回归、性能测试和视觉消融证据。目录中的文件不等同于当前源码已通过；结论必须同时核对 summary 的 `verdict`、EXE SHA-256、输入 SHA-256 和生成时间。

大型二进制、截图、日志和 EXE 默认只保存在本机；Git 仅跟踪本索引与 `manifests/` 中的证据清单。

## 当前架构权威证据

- `real-tif-babylon-release/`：ADR-0006 对应的真实 TIFF、LOD、驻留和长时交互证据。
- `babylon-final-3b95/`：ADR-0006 对应的双后端、回退、灯光消融和成片证据。
- `release-A1C85C-frmm-matrix-20260730/`：1024/2048/4096 真实 TIFF 质量矩阵。
- `release-A1C85C-white-20260730/`：对应版本的白模验收证据。

## 2026-08-01 最新候选证据

- `render-perf-stage3-final-real-tif/`：Stage 3 真实 TIFF 2048 运行时结果。
- `render-perf-stage3-final/`：Stage 3 WebGPU 性能与 WebGL2 结果。
- `detail-shaping-real-tif/`：保留权威高程后的细节塑形真实 TIFF 结果。
- `normal-lod-fix-20260801/`：多尺度光照法线与质量档回归。
- `synthetic-stripe-ablation-20260801-run4/`：量化条带消融证据。
- `release-candidates/2026-08-01/`：重整理前 6 个现存 EXE 及其匹配 summary 的保护性复制。
- `manifests/release-candidates-2026-08-01.md`：EXE 来源、哈希、关联证据和结论边界。

这些目录晚于 ADR-0006 中记录的 `3B95...` 构建，但又早于 2026-08-01 16:53 的最新设置面板修改，因此属于候选证据，不能自动升级为当前源码最终验收。

## 大型样本与性能资产

- `perf-fixtures/`：性能样本，约 315.85 MiB；现有性能脚本直接引用。
- `runtime-300k/`：早期 300k 交互诊断资产，约 292.34 MiB；属于历史根因证据。
- `perf-evidence/`、`perf-evidence-synthetic-307k/`：性能 Harness 输出。

## 历史与实验资产

带有 `candidate`、`trial`、连续版本号、`before/after`、`audit` 或 `diagnostics` 的目录默认视为历史或诊断资产。它们可作为后续归档候选，但在对应 BUG、ADR 和哈希引用完成核对前不得删除。

原先散落项目根目录的 12 个 `runtime-*` 目录已整体迁入 `runtime/historical/`。迁移前逐文件哈希见 `manifests/root-runtime-before-2026-08-01.sha256.md`；summary 中的原始绝对路径作为历史证据保持不改写。

## 证据使用规则

1. 不以截图存在或 JSON 文件非空作为通过依据。
2. 不把 Debug、Release Harness 和正式无调试端口 EXE 混写成同一个验证对象。
3. 不把旧版本 PASS 外推到更晚的脏工作树。
4. 删除或移动前必须检查 `docs/`、`scripts/` 和 summary 内部路径引用。
