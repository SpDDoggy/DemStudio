# 目录重整理验证记录（2026-08-01）

## 验证对象

- 分支：`codex/reorganize-project-20260801`
- 重整前恢复点：`702e39b`
- 范围：本地证据归档、根目录收口、Git 忽略策略、脚本分组、测试分层及引用迁移。
- 非目标：业务逻辑重构、最新 Release Runtime 实机验收、缓存删除、发布。

## 文件与证据完整性

- 根目录 12 个 `runtime-*` 目录已迁入 `artifacts/runtime/historical/`。
- 迁移前后逐文件 SHA-256：114/114 一致。
- 6 个现存 EXE 已复制到 `artifacts/release-candidates/2026-08-01/`：6/6 哈希与原文件一致。
- 旧脚本、测试和 `runtime-lighting-final/all.png` 路径引用扫描：0 个残留。
- Git 忽略大型 artifacts、Python 缓存和未来根目录 Runtime 输出；保留 `artifacts/README.md` 与 `artifacts/manifests/`。

## 自动化验证

| 验证 | 结果 | 证据边界 |
| --- | --- | --- |
| `npm run verify` | PASS，静态基线全部通过，Node 66/66 | 证明脚本和测试路径迁移后静态与单元契约成立 |
| `python -m unittest tests.perf.test_perf_fixture_tools` | PASS，1/1 | 证明性能样本生成器与校验器的新路径成立 |
| PowerShell Parser + 入口存在性 | PASS | 证明全部 `.ps1` 可解析，主要重组入口存在 |
| `npm run build:web` | PASS，915 modules | 生产 Web 构建成功；主 chunk 约 2.18 MB 的既有警告仍在 |
| `cargo test --manifest-path src-tauri/dem-core/Cargo.toml` | PASS，25/25 | Rust DEM Core 自动化测试通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS，4/4 | Tauri 宿主自动化测试通过 |
| `scripts/verify/verify-release-exe.ps1` | PASS | 现存正式 EXE 无开发服务器入口；哈希仍为 `ACD5FE1B...` |

## 未验证边界

- 没有从重整理后的源码重新构建 Windows Release EXE。
- 没有执行 WebGPU、WebGL2、回退、真实 TIFF 或 15 分钟 Runtime Harness。
- 现存 `ACD5FE1B...` EXE 早于最新设置面板源码，静态闸门 PASS 不能升级为当前源码 Runtime PASS。
- 没有删除 `dist/`、`node_modules/`、Rust `target/`、日志或任何验证资产。

## 回滚

- 源码可回到快照 `702e39b`。
- Runtime 目录可按 `artifacts/manifests/root-runtime-before-2026-08-01.sha256.md` 中的原始路径整体移回根目录。
- `.gitignore`、脚本路径、测试路径和文档引用通过本次整理提交统一回滚。
