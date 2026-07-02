# Electron Client Migration Map

| 旧编译产物 | 新源码位置 | 状态 |
|---|---|---|
| `dist-electron/main/index.js` | `src/main/index.js` | 已整理主窗口、单实例、窗口控制 IPC |
| `dist-electron/main/config.js` | `src/main/config.js` | 已整理入口 URL、preload、partition |
| `dist-electron/main/preload/index.js` | `src/preload/index.js` | 已完整暴露 `window.client` 方法名 |
| `work-server/app.js` | `src/main/ipc/app-info.js` | 已迁移 `app_info` |
| `work-server/cookie.js` | `src/main/ipc/cookies.js` | 已迁移 Cookie/session 基础行为 |
| `work-server/http.js` | `src/main/ipc/http.js` | 已迁移 `axiosParmars`、Base64、`Set-Cookie` 回写 |
| `work-server/window.js` | `src/main/ipc/windows.js` | 已迁移 raw URL、raw JS、窗口信息和编辑能力 |
| `work-server/data_server/db.js` | `src/main/ipc/db.js` | 已迁移 NeDB `db` 基础命令 |
| `work-server/data_server/bs_db.js` | `src/main/ipc/db.js` | 已迁移 SQLite `_db` 基础命令和 `selfSql` |
| `work-server/self_save.js` | `src/main/ipc/files.js` | 已迁移下载、保存、目录选择、资源管理器打开 |
| `work-server/file.js` | `src/main/ipc/files.js` | 已迁移 `uploadFile` 基础行为 |
| `work-server/notification.js` | `src/main/ipc/notifications.js` | 已迁移通知点击事件 |
| `work-server/clear_partitions.js` | `src/main/ipc/partitions.js` | 已迁移分区清理 |
| `work-server/pdd_workbench.js` | `src/main/ipc/pdd.js` | 已迁移进程检测、EnumsPdd 下载/缓存/提权启动/读取 PASS_ID/取消 |
| `main_update_version.js` | `src/main/ipc/updates.js` | 已接入 `electron-updater` 基础检查、下载进度事件和版本检测 |
| `crash_logger.js` | `src/main/ipc/logs.js` | 已迁移基础日志、脱敏和日志目录 |

## Phase 0 保留原则

- 保留 raw URL：`openWindow` / `editBrowserWindow` 不限制 URL。
- 保留 raw JS：`executeJavaScriptBrowserWindow` 不限制 JS 内容。
- 保留 raw DB：`_db.selfSql` 继续允许自定义 SQL。
- 不要求用户更新线上客户端；这个目录用于后续新客户端源码化开发和本地真实验证。
