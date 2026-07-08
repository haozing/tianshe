# Window Client Contract

The clean foundation exposes generic desktop capabilities only. Platform-specific
probes, old enum methods, local DB helpers, and the legacy Doudian store bridge
are not exposed by the active preload.

The final target is tracked in
[`../electron-client/REMOTE_BUSINESS_ORCHESTRATION_MIGRATION_PLAN.md`](../electron-client/REMOTE_BUSINESS_ORCHESTRATION_MIGRATION_PLAN.md):
remote-web owns DouDian business orchestration, while Electron exposes
platform-neutral native capabilities through `window.chihuNative`.

## `window.chihuNative`

- `app.getInfo`
- `windows.open`, `windows.eval`, `windows.destroy`
- `cookies.get`, `cookies.set`, `cookies.copy`, `cookies.getHeader`, `cookies.clear`
- `http.request`
- `files.selectFile`, `files.readFile`, `files.download`
- `notifications.send`
- `updates.start`, `updates.getVersionData`
- `logs.report`, `logs.getDir`, `logs.clean`
- `partitions.cleanInvalid`

## Raw `window.client` Methods

- `get_cookies`, `set_cookies`, `copy_cookies`, `clear_session`
- `http`, `uploadFile`
- `openWindow`, `closeWindow`, `editBrowserWindow`, `getBrowserWindowInfo`, `destroyBrowserWindow`, `executeJavaScriptBrowserWindow`, `reloadHomeUrl`
- `sendNotification`
- `getMainWindowInfo`, `resetMainWindow`, `getAllBrowserWindowInfos`, `getAppInfo`
- `startAutoUpdate`, `cleanInvalidPartitions`
- `minimizeWindow`, `maximizeWindow`, `isWindowMaximized`, `isWindowDestroyed`
- `getClientVersionData`
- `reportClientLog`, `getCrashLogDir`, `cleanCrashLogs`
- `selectDirectory`, `downloadFileToPath`, `cancelDownloadFileToPath`, `saveBufferToPath`, `openPathInExplorer`

DouDian business pages use `remote-web/client-shell/src/domain/doudian/*` and
`window.chihuNative` primitives. Electron does not expose `window.chihu.stores`,
`window.client.stores*`, `window.client.db`, or `window.client._db`.
