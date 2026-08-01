# 2026-08-01 Release Candidate 归档清单

## 源码恢复点

- 整理分支：`codex/reorganize-project-20260801`
- 重整前快照：`702e39b`
- 快照性质：未宣称最新运行时验收通过，仅用于恢复重整理前源码状态。

## 可执行文件

| 归档目录 | 原始路径 | SHA-256 | 关联证据 | 结论边界 |
| --- | --- | --- | --- | --- |
| `A9E2FB88/` | `src-tauri/target/render-perf-stage3-final/release/dem-studio.exe` | `A9E2FB88E196372454533851CADF62E93CF11C2827BB90A9B0A172298A0EAAF2` | WebGPU 60 秒性能、WebGL2 Smoke | 早于 16:53 最新设置修改，不是当前源码最终 RC |
| `ACD5FE1B/` | `src-tauri/target/release/dem-studio.exe` | `ACD5FE1BC629CFE8515C43E9D4D79A89C5E39112029FCED314FBB472C363C879` | 无匹配 Runtime summary | 只证明正式 EXE 文件身份 |
| `70B28A6A/` | `src-tauri/target/render-perf-stage3/release/dem-studio.exe` | `70B28A6AD22288445589E56A1687DE7DAD264A905DB9FAB417B2705C23F44A90` | 31,984 × 18,495 TIFF、2048 LOD | 真实输入候选证据，不覆盖更晚源码 |
| `64B789BE/` | `src-tauri/target/detail-shaping/release/dem-studio.exe` | `64B789BEAB0246FB70C4BDE9B6D50F34E2F81F8D790960B13D83DA6B1E2A7518` | 保留高程的细节塑形真实 TIFF | 专项候选，不是完整发布矩阵 |
| `DB4E8BDC/` | `src-tauri/target/perf/release/dem-studio.exe` | `DB4E8BDC271194575AF61A038C764AF7E6A462B7C07F908E531DD65AEF3E2377` | 法线 LOD、WebGL2、2048/4096 | 专项回归候选，不是最新源码最终 RC |
| `9F4FD185/` | `src-tauri/target/debug/dem-studio.exe` | `9F4FD185CB36165D7BD8780E4B3DF22CFF910746BA35DB2AFA2042407E5259CB` | 无匹配 Runtime summary | Debug 身份备份，不可冒充 Release 证据 |

## 归档规则

- 各目录中的 `dem-studio.exe` 是原始 EXE 的复制件；原始 `target/` 尚未删除。
- 匹配到 EXE SHA-256 的 summary 以扁平文件名一并复制，原始证据目录保持不变。
- 归档不改变任何既有验证结论，也不选定权威 Release Candidate。
- 只有从 `702e39b` 或其明确后继源码重新构建并完成同一 EXE 的全套验收后，才能建立新的权威 RC。
