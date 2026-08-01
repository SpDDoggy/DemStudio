# DEM Studio 目录整理分级（2026-08-01）

## 当前边界

- 模式：Brownfield 清理，先分类、后变更。
- 当前工作树：`main`，16 个已跟踪文件有修改，66 个未跟踪入口。
- 已建立重整理前源码快照 `702e39b`，并完成第一批无损证据归档；尚未删除既有资产。
- 源码、测试、ADR、BUG 记录、验证摘要和现存 EXE 均属于保护对象。

## 目录事实分类

| 路径 | 事实分类 | 当前规模 | 处理动作 | 原因 |
| --- | --- | ---: | --- | --- |
| `.github/` | active | 1 个文件 | Keep | CI 入口 |
| `assets/` | active | 约 0.34 MiB | Keep | README 与产品视觉资产 |
| `docs/` | source-of-truth + historical | 31 个文件 | Keep / Mark | ADR、产品验证与接管记录；部分旧接管文档已过时，但不能删除 |
| `scripts/` | active | 12 个脚本 | Keep | 已按 build/verify/perf/migration 分组 |
| `src/` | active | 16 个文件 | Keep | Babylon 渲染与地形逻辑 |
| `src-tauri/src/`、`src-tauri/dem-core/src/` | source-of-truth | 源码 | Keep | Tauri 宿主与 Rust DEM Core |
| `tests/` | active | 12 个入口 | Keep | 已按 unit/contracts/perf/fixtures 分层 |
| `node_modules/` | generated | 约 123.83 MiB | Delete candidate | 可由锁文件重建；删除后需重新安装依赖 |
| `dist/` | generated | 约 5.91 MiB | Delete candidate | 可由 Vite 构建重建 |
| `src-tauri/target/` | generated + evidence-bearing | 约 14,401.76 MiB | Defer | 含多个与脏工作树对应的 EXE；证据归档前不可直接删除 |
| `src-tauri/dem-core/target/` | generated | 约 388 MiB | Delete candidate | Rust Core 编译缓存，可重建 |
| `artifacts/` | supporting + evidence | 911 个文件，约 861.96 MiB | Keep / Index | 多份 ADR 与 BUG 记录直接引用其中证据 |
| `artifacts/runtime/historical/` | reference + generated evidence | 12 个原始目录、114 个文件，约 66.54 MiB | Keep | 已由根目录整体迁入；迁移前后 114 个 SHA-256 一致 |
| `runtime-smoke.png` | generated | 约 0.67 MiB | Keep | 当前 Harness 默认输出路径 |
| `.codex-build.*.log` | cache-temp | 约 0.01 MiB | Delete candidate | 已被 `.gitignore` 忽略，且无项目引用 |

## 受保护的验证对象

以下 EXE 均来自未提交源码，不得在证据归档前随 `target/` 清理：

| 构建路径 | SHA-256 |
| --- | --- |
| `src-tauri/target/render-perf-stage3-final/release/dem-studio.exe` | `A9E2FB88E196372454533851CADF62E93CF11C2827BB90A9B0A172298A0EAAF2` |
| `src-tauri/target/release/dem-studio.exe` | `ACD5FE1BC629CFE8515C43E9D4D79A89C5E39112029FCED314FBB472C363C879` |
| `src-tauri/target/render-perf-stage3/release/dem-studio.exe` | `70B28A6AD22288445589E56A1687DE7DAD264A905DB9FAB417B2705C23F44A90` |
| `src-tauri/target/detail-shaping/release/dem-studio.exe` | `64B789BEAB0246FB70C4BDE9B6D50F34E2F81F8D790960B13D83DA6B1E2A7518` |
| `src-tauri/target/perf/release/dem-studio.exe` | `DB4E8BDC271194575AF61A038C764AF7E6A462B7C07F908E531DD65AEF3E2377` |
| `src-tauri/target/debug/dem-studio.exe` | `9F4FD185CB36165D7BD8780E4B3DF22CFF910746BA35DB2AFA2042407E5259CB` |

## 推荐执行顺序

1. 稳定：重整理前源码范围已冻结为快照 `702e39b`；最终权威 Release Candidate 仍待最新源码重建与验收。
2. 证据归档：6 个现存 EXE 与匹配 summary 已复制到 `artifacts/release-candidates/2026-08-01/`，来源和边界见 manifest。
3. 根目录收口：12 个 `runtime-*` 目录已整体迁入 `artifacts/runtime/historical/`，保留完整相对目录树与迁移前哈希。
4. Git 噪声收口：大型 `artifacts` 作为本地证据；Git 只跟踪索引和 manifests。
5. 脚本和测试：已分别按 build/verify/perf/migration 与 unit/contracts/perf/fixtures 分组，调用路径已同步。
6. 验证：Node 66/66、Python 1/1、Rust Core 25/25、Tauri 4/4、Web Production 构建与 Release EXE 静态闸门通过。
7. 缓存清理：仍需单独确认后才能删除明确可重建的 Node、Vite 和 Rust 编译缓存。

## 必须单独确认的动作

- 删除 `node_modules/`、`dist/`、Rust `target/` 或日志。
- 选择并归档权威 Release Candidate EXE。
