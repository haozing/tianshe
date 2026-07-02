# 小尊宝 Electron Client Source

这个目录是新的可读 Electron 客户端源码目录，用来替代直接阅读 `analysis_unpack/app_asar/dist-electron/main/*.js` 那种编译产物的工作方式。

## 目标

- 保留旧客户端的 `window.client` 合同。
- 默认加载 Phase 0 旧入口：`http://127.0.0.1:4173/old-entry/`。
- 可通过环境变量切到线上旧入口或任意新入口。
- 按源码模块整理主窗口、preload、Cookie、HTTP、窗口、DB、文件、日志、通知等能力。
- Phase 0 不收紧 raw URL、raw JS、raw DB / SQL 能力。

## 目录

| 路径 | 说明 |
|---|---|
| `src/main/index.js` | Electron 主进程入口和主窗口生命周期 |
| `src/main/config.js` | 入口 URL、partition、preload、图标等配置 |
| `src/preload/index.js` | 暴露 `window.client` |
| `src/main/ipc/*.js` | `window.client` 背后的 IPC 实现 |
| `src/main/window/scheme-blocker.js` | 特殊 scheme 拦截 |
| `scripts/run-dev.js` | 清理 `ELECTRON_RUN_AS_NODE` 后启动 Electron |
| `scripts/run-smoke.js` | Electron 真实窗口冒烟验证 |
| `scripts/check-syntax.js` | 源码语法检查 |
| `scripts/check-contract.js` | `window.client` 合同检查 |

## 开发运行

先启动远程 Web 静态服务：

```powershell
node ..\remote-web\scripts\serve-static.mjs
```

再启动 Electron：

```powershell
cd electron-client
npm install
npm run dev
```

`npm run dev` 会主动清理当前 shell 中可能残留的 `ELECTRON_RUN_AS_NODE`，避免 Electron 被当成普通 Node 进程启动。

默认会加载：

```text
http://127.0.0.1:4173/old-entry/
```

切换入口：

```powershell
$env:XZB_HOME_URL="https://apptool.zzbtool.com"
npm run dev
```

或：

```powershell
$env:XZB_HOME_URL="http://127.0.0.1:4173/new-remote-web/"
npm run dev
```

## 保留的旧合同

`src/preload/index.js` 暴露以下 `window.client` 方法：

```text
get_cookies, set_cookies, copy_cookies, clear_session, http, uploadFile,
openWindow, closeWindow, editBrowserWindow, getBrowserWindowInfo,
destroyBrowserWindow, executeJavaScriptBrowserWindow, reloadHomeUrl,
db, _db, sendNotification, getMainWindowInfo, resetMainWindow,
getAllBrowserWindowInfos, getAppInfo, startAutoUpdate, cleanInvalidPartitions,
minimizeWindow, maximizeWindow, isWindowMaximized, isWindowDestroyed,
getClientVersionData, startEnumsPdd, cancelEnumsPdd, checkProcessRunning,
reportClientLog, getCrashLogDir, cleanCrashLogs, selectDirectory,
downloadFileToPath, cancelDownloadFileToPath, saveBufferToPath,
openPathInExplorer
```

## Phase 0 差异

- `startAutoUpdate` 已接入 `electron-updater`，开发态可通过 `XZB_DEV_UPDATE_CONFIG` 指定更新配置。
- `startEnumsPdd` 已迁移旧逻辑：下载/缓存 `EnumsPdd.exe`、提权启动、等待临时文件、读取 PASS_ID、支持取消。
- `assets/icon.png` 暂用现有截图资源占位，后续替换正式图标。
- DB、HTTP、窗口和下载能力已按旧行为优先迁移。

## 校验

```powershell
npm run check
```

真实窗口冒烟验证：

```powershell
npm run smoke
```

冒烟会加载 `http://127.0.0.1:4173/old-entry/`，确认旧入口跳到新远程 Web，并检查 `window.client` 至少暴露 30 个方法。
同时会调用一组低风险 IPC：`getAppInfo`、`getMainWindowInfo`、`getAllBrowserWindowInfos`、`isWindowMaximized`、`isWindowDestroyed`、`getCrashLogDir`，并创建一个隐藏子窗口验证 `openWindow`、`getBrowserWindowInfo`、`executeJavaScriptBrowserWindow`、`destroyBrowserWindow`。

Cookie/session 专项验证：

```powershell
npm run smoke:cookie
```

该专项使用随机临时 partition，覆盖 `set_cookies`、`get_cookies`、`copy_cookies`、`clear_session`，并在结束前清理测试分区。

HTTP 代理专项验证：

```powershell
npm run smoke:http
```

该专项会临时启动本机 HTTP 测试服务，覆盖 `window.client.http` 的 GET、POST JSON、错误响应、`getBase64`、`Set-Cookie` 回写到 partition。

DB 专项验证：

```powershell
npm run smoke:db
```

该专项使用临时 `userData` 目录，覆盖 `db` 的 NeDB 增删改查、排序/分页/计数，以及 `_db` 的 SQLite 增删改查、计数和 `selfSql`。

文件能力专项验证：

```powershell
npm run smoke:files
```

该专项使用临时 `userData` 和本机测试服务，覆盖 `saveBufferToPath`、`downloadFileToPath`、`cancelDownloadFileToPath`、`uploadFile`，以及 `openPathInExplorer` 的缺失路径错误返回。

`better-sqlite3` 是原生模块，安装后需要按 Electron ABI 重建；`npm install` 会通过 `postinstall` 自动执行：

```powershell
npm rebuild better-sqlite3 --runtime=electron --target=31.7.7 --dist-url=https://electronjs.org/headers
```

也可以从仓库根目录执行：

```powershell
node .\electron-client\scripts\check-syntax.js
```
