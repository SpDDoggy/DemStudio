# 三端发布矩阵

## 当前状态

| 平台 | 架构 | 构建产物 | 当前证据 |
| --- | --- | --- | --- |
| Windows | x64 | 独立 EXE、NSIS Setup | 已在 Windows 11 实机编译、启动和运行时冒烟 |
| macOS | Apple Silicon | App、DMG | 工程与 CI 已配置，等待 macOS runner 和实机验证 |
| macOS | Intel | App、DMG | 工程与 CI 已配置，等待 macOS runner 和实机验证 |
| Linux | x64 | AppImage、Deb | 工程与 CI 已配置，等待 WebKitGTK runner 和实机验证 |

## 共同闸门

每个平台必须通过：

1. `npm ci`
2. `npm run verify`
3. 平台 Tauri Release 构建
4. 应用启动且无启动错误
5. ASC 基线样本导入
6. GeoTIFF、HGT、图像高度图样本回归
7. PNG、GeoTIFF、World File 导出回归
8. 设置与自定义预设重启恢复

Windows 的 `npm run verify:runtime:windows` 已自动覆盖第 4、5 项。其余平台应使用同一 DOM 断言迁入对应自动化驱动。

## 发布约束

- Windows 安装包正式分发前需要代码签名。
- macOS 正式分发需要 Developer ID 签名和 notarization。
- Linux 需要明确最低发行版/WebKitGTK 基线。
- CI 产物在未配置证书时属于 unsigned validation artifact，不等于正式发布包。
- macOS 和 Linux 必须在对应操作系统构建；Windows 本地成功不能替代平台验证。

## 当前 CI

`.github/workflows/desktop-ci.yml` 为四目标执行独立构建：

- `x86_64-pc-windows-msvc`
- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-unknown-linux-gnu`
