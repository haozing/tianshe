# Window Client Contract

The clean foundation exposes generic local capabilities plus the current Doudian store-account bridge. Platform-specific probes and old enum methods are archived, not exposed by the active preload.

## Raw `window.client` Methods

- `get_cookies`, `set_cookies`, `copy_cookies`, `clear_session`
- `http`, `uploadFile`
- `openWindow`, `closeWindow`, `editBrowserWindow`, `getBrowserWindowInfo`, `destroyBrowserWindow`, `executeJavaScriptBrowserWindow`, `reloadHomeUrl`
- `db`, `_db`
- `sendNotification`
- `getMainWindowInfo`, `resetMainWindow`, `getAllBrowserWindowInfos`, `getAppInfo`
- `startAutoUpdate`, `cleanInvalidPartitions`
- `minimizeWindow`, `maximizeWindow`, `isWindowMaximized`, `isWindowDestroyed`
- `getClientVersionData`
- `reportClientLog`, `getCrashLogDir`, `cleanCrashLogs`
- `selectDirectory`, `downloadFileToPath`, `cancelDownloadFileToPath`, `saveBufferToPath`, `openPathInExplorer`
- `storesList`, `storesFetch`, `storesRefreshStatus`, `storesCancel`, `storesOpen`, `storesDelete`, `storesUpdateGroup`

## Store Facade

Business pages should prefer `window.chihu.stores`:

- `list`
- `fetch`
- `refreshStatus`
- `cancel`
- `open`
- `delete`
- `updateGroup`

The facade is the recommended business entry. The raw `window.client.stores*` methods remain part of the contract for diagnostics, emergency remote fixes, and future modules.
