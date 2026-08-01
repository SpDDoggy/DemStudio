# DEM Studio 目录整理分级（2026-08-01）

## 当前边界

- 模式：Brownfield 清理，先分类、后变更。
- 当前工作树：`main`，16 个已跟踪文件有修改，66 个未跟踪入口。
- 本文件只记录整理边界；尚未删除、移动、覆盖或归档既有资产。
- 源码、测试、ADR、BUG 记录、验证摘要和现存 EXE 均属于保护对象。

## 目录事实分类

| 路径 | 事实分类 | 当前规模 | 处理动作 | 原因 |
| --- | --- | ---: | --- | --- |
| `.github/` | active | 1 个文件 | Keep | CI 入口 |
| `assets/` | active | 约 0.34 MiB | Keep | README 与产品视觉资产 |
| `docs/` | source-of-truth + historical | 31 个文件 | Keep / Mark | ADR、产品验证与接管记录；部分旧接管文档已过时，但不能删除 |
| `scripts/` | active | 12 个文件 | Keep | 构建、发布与 Harness 入口 |
| `src/` | active | 16 个文件 | Keep | Babylon 渲染与地形逻辑 |
| `src-tauri/src/`、`src-tauri/dem-core/src/` | source-of-truth | 源码 | Keep | Tauri 宿主与 Rust DEM Core |
| `tests/` | active | 12 个入口 | Keep | 当前回归契约 |
| `node_modules/` | generated | 约 123.83 MiB | Delete candidate | 可由锁文件重建；删除后需重新安装依赖 |
| `dist/` | generated | 约 5.91 MiB | Delete candidate | 可由 Vite 构建重建 |
| `src-tauri/target/` | generated + evidence-bearing | 约 14,401.76 MiB | Defer | 含多个与脏工作树对应的 EXE；证据归档前不可直接删除 |
| `src-tauri/dem-core/target/` | generated | 约 388 MiB | Delete candidate | Rust Core 编译缓存，可重建 |
| `artifacts/` | supporting + evidence | 911 个文件，约 861.96 MiB | Keep / Index | 多份 ADR 与 BUG 记录直接引用其中证据 |
| 根目录 12 个 `runtime-*` 目录 | reference + generated evidence | 114 个文件，约 66.54 MiB | Archive candidate | 旧运行时截图与摘要散落根目录；移动会改变记录路径 |
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

1. 稳定：冻结当前源码范围，明确哪一个 EXE 是当前 Release Candidate。
2. 证据归档：复制需保留的 EXE、对应 summary、截图与源码状态清单到统一证据目录，并生成 SHA-256 清单。
3. 根目录收口：把 12 个 `runtime-*` 目录整体迁入 `artifacts/legacy-root-runtime/`，同步修正文档引用；保留完整相对目录树。
4. Git 噪声收口：决定 `artifacts/` 是本地证据还是需要纳入版本库，再修改 `.gitignore`。
5. 缓存清理：在证据与源码可恢复后，删除明确可重建的 Node、Vite 和 Rust 编译缓存。
6. 验证：重新检查 Git 状态、引用路径、关键文件哈希和开发/验证入口。

## 必须单独确认的动作

- 移动根目录 `runtime-*` 证据目录。
- 修改 `.gitignore` 对 `artifacts/` 和 `runtime-*` 的策略。
- 删除 `node_modules/`、`dist/`、Rust `target/` 或日志。
- 选择并归档权威 Release Candidate EXE。

