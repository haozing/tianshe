# liehuBridge 能力和权限矩阵

> 目标：定义各 Bridge 能力范围、raw 能力保留范围和降级策略。  
> 依据：`window-client-contract.md`、`preload/index.js`、`work-server/*`。

## 1. 总原则

- `liehuBridge` 只包装，不收窄旧能力。
- raw JS、raw URL、危险 DB 命令 Phase 1 保留，后续也不作为强制治理任务。
- 审计字段只做记录，不阻断调用。

## 2. 矩阵

| Bridge | 方法 | raw 能力 | 是否允许拦截 | 降级 |
|---|---|---|---|---|
| AppBridge | `getAppInfo`、`getClientVersionData`、`getMainWindowInfo` | 无 | 不拦截 | 缺失时使用 Web 环境默认值 |
| SessionBridge | `get_cookies`、`set_cookies`、`copy_cookies`、`clear_session` | Cookie 全量读写 | 不拦截 | 返回明确错误 |
| HttpBridge | `http` | 任意 axios 参数、旧 `axiosParmars` | 不拦截 | 返回错误码，不静默重试 |
| WindowBridge | `openWindow`、`editBrowserWindow`、`executeJavaScriptBrowserWindow`、`reloadHomeUrl` | 任意 URL、任意 JS | 不拦截 | 返回错误，保留原始错误 |
| DbBridge | `db`、`_db` | 旧库、旧表、旧命令 | 不拦截 | 返回旧错误 |
| FileBridge | 下载、保存、打开目录 | 文件路径 | 不拦截 | 返回错误 |
| LogBridge | `reportClientLog`、crash log | 旧日志透传 | 不改旧能力 | 猎狐新增日志脱敏 |

## 3. 错误格式

```ts
type LiehuResult<T> = {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    retryable: boolean
    source: "bridge" | "http" | "db" | "session" | "window" | "file" | "log"
    raw?: unknown
  }
  correlationId: string
}
```

## 4. 审计字段

- `correlationId`
- `bridge`
- `method`
- `route`
- `feature`
- `shopId`，需脱敏
- `platform`
- `partition`
- `durationMs`
- `status`

不得记录 Cookie、Authorization、token、Set-Cookie、完整请求头、完整响应体。

