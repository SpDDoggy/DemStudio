# BUG-2026-07-30：Release EXE 错误连接开发服务器

## 状态

已完成根因修复；发布二进制静态闸门与 Windows 离线冷启动均已通过。

## 用户可见现象

直接运行 `src-tauri/target/release/dem-studio.exe` 后，窗口显示：

```text
127.0.0.1 拒绝连接
ERR_CONNECTION_REFUSED
```

生产 EXE 在没有 Vite 开发服务器时无法打开。

## 根因

上一轮通过裸 `cargo build --release` 生成桌面二进制。Cargo 的 `release` 优化级别不等于 Tauri 的生产构建上下文；基础 `tauri.conf.json` 同时包含 `devUrl`，导致生成代码按开发入口构造 WebView，并且不嵌入可供离线启动的生产页面。

故障二进制的直接证据是它包含：

```text
http://127.0.0.1:1420
```

现有设计允许问题发生的原因有两个：

1. 开发服务器配置与生产资源配置共存于同一个基础配置；
2. 发布流程只检查“EXE 是否生成”，没有检查 EXE 实际加载的是开发 URL 还是内嵌资源。

## 根因级修复

1. 基础 `tauri.conf.json` 只保留生产 `frontendDist`，不再包含任何开发 URL。
2. 开发服务器配置移入 `tauri.dev.conf.json`，只有显式执行 `desktop:dev` 才会合并。
3. 正式 EXE 必须由 Tauri CLI 的 `build --no-bundle` 生成，不再用裸 Cargo 作为发布命令。
4. 发布后扫描二进制：
   - ASCII 与 UTF-16LE 均禁止包含指向 `localhost`、`127/8`、
     `0.0.0.0` 或 `[::1]` 的 HTTP/HTTPS 开发入口，不限端口；
   - 必须包含 Tauri 内嵌生产源 `tauri://localhost`。
5. `desktop:build`、`desktop:build:exe`、`desktop:build:windows` 和性能版
   Release 构建均强制经过同一个二进制闸门，禁止旁路。

## 永久回归

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build/build-release-exe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify/verify-release-exe.ps1
```

任何生产 EXE 再次携带开发入口时，构建必须失败，不得交付。

## 验收标准

- 不启动 Node、Vite 或任何本地 HTTP 服务，EXE 仍能打开 DEM Studio。
- 二进制不包含端口 `1420` 的 localhost/127.0.0.1 开发入口。
- 页面从内嵌 `frontendDist` 加载。
- `npm run verify` 继续通过。

## 2026-07-30 验证证据

- Tauri CLI `build --no-bundle`：通过。
- 生产 EXE 二进制扫描：不包含 `http://127.0.0.1:1420` 或
  `http://localhost:1420`，包含 `tauri://localhost`。
- 本机端口 `1420` 无监听时启动 EXE：进程持续存活 8 秒，并可通过主窗口正常关闭。
- 基线检查：通过。
- JavaScript 地形法线/光照回归：12/12 通过。
- Rust DEM Core：24/24 通过。
- EXE：`src-tauri/target/release/dem-studio.exe`
- 大小：`13,812,224 bytes`
- SHA-256：`F5BB7292BD6CCA99E505E753F7E48FD4233B041D521C927EA1EEB6B7A920B8C5`

## 回滚

如需回滚本次构建隔离，只恢复 `tauri.conf.json`、`tauri.dev.conf.json`、`package.json` 和两个构建校验脚本；DEM Core、渲染和文件解析代码不受影响。
