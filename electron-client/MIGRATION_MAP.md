# Electron Client Migration Map

This map records how legacy desktop capabilities were moved into the readable Electron client source. It is not a promise to keep every legacy platform feature active.

The active business scope is Douyin/DouDian commerce. PDD entries are migration history only and are not part of current development, regression, or acceptance.

The final DouDian business orchestration target is
[`REMOTE_BUSINESS_ORCHESTRATION_MIGRATION_PLAN.md`](REMOTE_BUSINESS_ORCHESTRATION_MIGRATION_PLAN.md).
Electron now keeps only desktop capability IPC; remote-web owns DouDian business
rules, task orchestration, and repository storage.

| Legacy area | Current source | Status |
|---|---|---|
| `dist-electron/main/index.js` | `src/main/index.js` | Main window, single instance, window control, IPC registration |
| `dist-electron/main/config.js` | `src/main/config.js` | Entry URL, preload, partition, app icon |
| `dist-electron/main/preload/index.js` | `src/preload/index.js` | `window.client` exposure |
| `work-server/app.js` | `src/main/ipc/app-info.js` | App info IPC |
| `work-server/cookie.js` | `src/main/ipc/cookies.js` | Cookie and session helpers |
| `work-server/http.js` | `src/main/ipc/http.js` | HTTP proxy, Base64, `Set-Cookie` writeback |
| `work-server/window.js` | `src/main/ipc/windows.js` | Window operations, raw URL, raw JavaScript |
| `work-server/self_save.js` | `src/main/ipc/files.js` | Download, save, directory selection, explorer opening |
| `work-server/file.js` | `src/main/ipc/files.js` | Upload helper |
| `work-server/notification.js` | `src/main/ipc/notifications.js` | Notification click event bridge |
| `work-server/clear_partitions.js` | `src/main/ipc/partitions.js` | Partition cleanup |
| `work-server/pdd_workbench.js` | removed from active runtime | PDD legacy record only |
| `main_update_version.js` | `src/main/ipc/updates.js` | `electron-updater` checks, download progress, version data |
| `crash_logger.js` | `src/main/ipc/logs.js` | Client logs, redaction, log directory |
| Chihu store bridge | removed from Electron runtime | DouDian business orchestration lives in remote-web |

## Migration Principles

- Keep local and remote responsibilities separated: Electron owns desktop capabilities; remote-web owns visible UI, hidden task orchestration, and DouDian business rules.
- Keep raw desktop compatibility APIs where the current runtime still depends on them.
- Do not reintroduce local business DB, Excel parsing, or DouDian service IPC into Electron.
- Do not add PDD flows back into active runtime checks.
- Treat `electron-client/artifacts/` as generated evidence, not source.
