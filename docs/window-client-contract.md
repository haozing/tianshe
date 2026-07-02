# window.client 合同

> 目标：定义猎狐通过 `liehuBridge` 必须兼容的 Electron 本地能力合同。  
> 依据：`analysis_unpack/app_asar/dist-electron/main/preload/index.js`、`work-server/*`、`main/index.js`。

## 1. 暴露方式

preload 通过 `contextBridge.exposeInMainWorld("client", {...})` 暴露能力。证据：`preload/index.js:71`。

## 2. 方法清单

| 方法 | IPC channel | 能力 | 参数摘要 | 返回/错误摘要 | 风险 |
|---|---|---|---|---|---|
| `get_cookies` | `get_cookies` | 按 partition 读取 Cookie | `{ partition, url? , domain? }` | Cookie 数组 | 敏感数据，不可打日志 |
| `set_cookies` | `set_cookies` | 批量写 Cookie | `{ partition, cookies }` | 错误或空 | 可污染会话 |
| `copy_cookies` | `copy_cookies` | 复制 partition Cookie | `{ oldPartition, newPartition }` 等旧参数 | 错误或空 | 跨会话复制 |
| `clear_session` | `clear_session` | 清理 session 数据和缓存 | `{ partition }` | 错误或空 | 会清登录态 |
| `http` | `http` | 主进程 HTTP 请求 | `{ axiosParmars, partition?, axiosParamsTimeout?, getBase64? }` | `{ data, error }` | 不自动注入 Cookie；会回写 Set-Cookie |
| `uploadFile` | `uploadFile` | 文件上传 | 旧参数透传 | 旧返回 | 文件权限 |
| `openWindow` | `openWindow` | 打开 BrowserWindow | `{ url, partition?, preload?, windowParams? }` | 窗口信息/旧返回 | raw URL |
| `closeWindow` | `closeWindow` | 关闭窗口 | `{ winId? , closeId? }` | 空 | 可能关闭主窗 |
| `editBrowserWindow` | `editBrowserWindow` | 编辑窗口或加载新 URL | `{ winId, newUrl?, ... }` | 旧返回 | raw URL |
| `getBrowserWindowInfo` | `getBrowserWindowInfo` | 读窗口状态 | `{ winId }` | 窗口信息 | 低 |
| `destroyBrowserWindow` | `destroyBrowserWindow` | 销毁窗口 | `{ winId }` | 空 | 破坏任务 |
| `executeJavaScriptBrowserWindow` | `executeJavaScriptBrowserWindow` | 执行页面 JS | `{ winId, jsContent }` | JS 结果或错误 | raw JS |
| `reloadHomeUrl` | `reloadHomeUrl` | 主窗口加载指定 URL | `{ url, isDev? }` | 空 | raw URL |
| `db` | `db` | NeDB/本地 DB | 旧参数透传 | 旧返回 | 可执行旧命令 |
| `_db` | `_db` | 另一套底层 DB | 旧参数透传 | 旧返回 | 可执行旧命令 |
| `sendNotification` | `send_notification` | 系统通知 | 旧参数透传 | 旧返回 | 低 |
| `getMainWindowInfo` | `getMainWindowInfo` | 主窗口状态 | 可空 | `{ winId, winBounds, ... }` | 低 |
| `resetMainWindow` | `resetMainWindow` | 重置主窗口引用 | `{ winId }` | 错误或空 | 高 |
| `getAllBrowserWindowInfos` | `getAllBrowserWindowInfos` | 所有窗口状态 | 可空 | 窗口数组 | 中 |
| `getAppInfo` | `app_info` | 应用版本/路径 | 可空 | app 信息 | 灰度可用 |
| `startAutoUpdate` | `startAutoUpdate` | 启动更新检查 | 旧参数透传 | 旧返回 | 不阻塞首屏 |
| `cleanInvalidPartitions` | `cleanInvalidPartitions` | 清理无效 partition | 旧参数透传 | 旧返回 | 会影响会话 |
| `minimizeWindow` | `minimizeWindow` | 最小化 | `{ winId? }` | 空 | 低 |
| `maximizeWindow` | `maximizeWindow` | 最大化/还原 | `{ winId? }` | 空 | 低 |
| `isWindowMaximized` | `isWindowMaximized` | 是否最大化 | `{ winId? }` | boolean | 低 |
| `isWindowDestroyed` | `isWindowDestroyed` | 是否销毁 | `{ winId }` | boolean | 低 |
| `getClientVersionData` | `getClientVersionData` | 客户端版本诊断 | 可空 | 旧返回 | 只做诊断 |
| `startEnumsPdd` | `startEnumsPdd` | PDD 工作台枚举 | 旧参数透传 | 旧返回 | 平台进程 |
| `cancelEnumsPdd` | `cancelEnumsPdd` | 取消 PDD 枚举 | 可空 | 旧返回 | 平台进程 |
| `checkProcessRunning` | `checkProcessRunning` | 进程检测 | `string[]` | boolean | 隐私边界 |
| `reportClientLog` | `reportClientLog` | 写客户端日志 | payload | 旧返回 | 需脱敏 |
| `getCrashLogDir` | `getCrashLogDir` | 获取日志目录 | 可空 | 路径 | 本地路径 |
| `cleanCrashLogs` | `cleanupOldCrashLogs` | 清理日志 | payload | 旧返回 | 删除日志 |
| `selectDirectory` | `selectDirectory` | 选择目录 | options | 路径 | 文件权限 |
| `downloadFileToPath` | `downloadFileToPath` | 下载到路径 | message | 任务结果 | 文件权限 |
| `cancelDownloadFileToPath` | `cancelDownloadFileToPath` | 取消下载 | message | 旧返回 | 低 |
| `saveBufferToPath` | `saveBufferToPath` | 保存 buffer | message | 旧返回 | 文件权限 |
| `openPathInExplorer` | `openPathInExplorer` | 打开目录/定位文件 | options | 旧返回 | 文件权限 |

## 3. HTTP 语义

证据：`work-server/http.js:207-246`。

- 参数拼写是旧接口真实拼写：`axiosParmars`。
- `http` 会把 `args.axiosParmars` 透传给 axios。
- `args.partition` 存在时，响应 `Set-Cookie` 会写回对应 partition。
- 底层不会自动从 partition 读取 Cookie，也不会自动把 Cookie 注入请求头。
- 登录态请求必须先由 `SessionBridge` 显式读取 Cookie/Header，再传给 `HttpBridge`。

## 4. Window 语义

证据：`work-server/window.js`。

- `openWindow` 支持 `args.url`、`args.partition`、`args.preload`、`args.windowParams`。
- `executeJavaScriptBrowserWindow` 执行 `args.jsContent`。
- `editBrowserWindow` 支持加载 `args.newUrl`。
- `reloadHomeUrl` 可让主窗口加载任意 `args.url`。

Phase 1 和后续均保留 raw URL / raw JS 能力。

## 5. 调用示例

```ts
const cookies = await window.client.get_cookies({
  partition: "persist:myappzzbtool",
  url: "https://fxg.jinritemai.com"
})

const res = await window.client.http({
  partition: "persist:myappzzbtool",
  axiosParmars: {
    url: "https://fxg.jinritemai.com/api/order/searchlist",
    method: "GET",
    headers: { cookie: "...", referer: "https://fxg.jinritemai.com/" }
  }
})
```

## 6. 验收

- `liehuBridge` 能探测全部方法是否存在。
- 参数名、返回形态、错误形态不改。
- 日志不得记录 Cookie、Authorization、token、Set-Cookie、完整请求头、完整响应体。
- 任一 Bridge 初始化失败，不影响 Legacy App Replica。

