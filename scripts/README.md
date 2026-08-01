# 脚本入口

- `build/`：生成 Release 或性能构建，并调用正式 EXE 静态闸门。
- `verify/`：执行静态基线、Release EXE 检查、Windows Runtime Smoke 和真实 TIFF 验证。
- `perf/`：生成与校验性能样本，执行 100M 或合成前台性能 Harness。
- `migration/`：执行 Lens 状态迁移。

面向用户和 CI 的稳定入口由根目录 `package.json` 提供。脚本之间必须通过当前分组后的显式相对路径调用，不能依赖旧的扁平 `scripts/` 布局。
