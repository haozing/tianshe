# Electron Client Regression Checklist

这份清单用于后续继续把旧客户端能力迁到新的可读源码目录时做回归。Phase 0 的原则是先保持旧行为可用，不收紧 raw URL、raw JS、raw DB / SQL。

## 已自动覆盖

运行：

```powershell
npm run check
npm run smoke
npm run smoke:cookie
npm run smoke:http
npm run smoke:db
npm run smoke:files
```

当前自动覆盖：

- 源码语法检查。
- `window.client` 暴露方法和主进程 IPC handler 合同检查。
- 旧入口 `old-entry` 跳转到新远程 Web。
- preload 注入 `window.client`。
- `getAppInfo`、`getMainWindowInfo`、`getAllBrowserWindowInfos`。
- `isWindowMaximized`、`isWindowDestroyed`。
- `getCrashLogDir`。
- 隐藏子窗口创建、信息读取、执行 JS、销毁。
- Cookie/session 专项：临时 partition 下的 `set_cookies`、`get_cookies`、`copy_cookies`、`clear_session`。
- HTTP 代理专项：本机测试服务下的 GET、POST JSON、错误响应、`getBase64`、`Set-Cookie` 回写。
- DB 专项：临时 `userData` 下的 NeDB 增删改查、排序/分页/计数，以及 SQLite 增删改查、计数和 `selfSql`。
- 文件能力专项：临时 `userData` 下的 `saveBufferToPath`、`downloadFileToPath`、`cancelDownloadFileToPath`、`uploadFile`，以及 `openPathInExplorer` 缺失路径错误返回。

## 待手动/专项覆盖

这些能力会读写用户数据、打开系统能力、访问外部服务或依赖三方程序，先不要塞进默认 smoke：

- 文件 UI 能力：`selectDirectory` 弹窗、`openPathInExplorer` 打开真实目录/文件。
- 通知：`sendNotification` 和点击事件回传。
- 分区清理：`cleanInvalidPartitions`。
- 自动更新：`startAutoUpdate`、`getClientVersionData`。
- PDD 插件：`checkProcessRunning`、`startEnumsPdd`、`cancelEnumsPdd`。
- 客户端日志：`reportClientLog`、`cleanCrashLogs`。

## 建议顺序

1. 先做通知和日志专项，覆盖事件回传与日志清理。
2. 再处理 PDD、自动更新这类外部依赖强的能力。
