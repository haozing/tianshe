# Tianshe 与店汪汪登录保持机制对比审计

> 分析对象：`小抖/小抖/店汪汪登录机制分析报告.md` 及其反编译代码。  
> Tianshe 对照源码：`D:\code\tooltemp\tianshe\tianshe\src`。  
> 目标：判断店汪汪的登录保持方式是否需要照搬，以及浏览器扩展 Runtime 与 Tianshe Capability 的关系。

---

## 1. 结论

### 1.1 是否需要店汪汪这种登录保持机制

需要它的核心思想，但不需要照搬它的实现。

应该保留：

- 用户在真实浏览器页面中完成登录。
- 每个店铺有独立、持久化的浏览器登录仓。
- 任务执行前主动验证登录状态。
- 抖店、罗盘、百应等域名分别做会话激活/验证。
- 接口返回登录失效时立即标记过期，并让用户重新接管登录。

不建议照搬：

- 把完整 Cookie 字符串和 40 多个 token 字段复制到业务数据库。
- 再把同一份凭据重复保存到 LiteDB、INI、WebView2 缓存。
- WebView2 登录后把 Cookie 搬到 CefSharp/HttpClient。
- 用一个全局 `CurrentUser` 在多个店铺之间切换。

Tianshe 的 Profile 本身就是持久登录仓。我们应当让登录、业务 Capability 和页面操作复用同一个 Profile/Runtime，不做双浏览器 Cookie 搬运。

### 1.2 当前方案是不是浏览器扩展方式

不是。

当前白牌方案的 MVP 是：

```text
xzb_toolbox 插件
  -> helpers.profile.launchPopup / withLease
  -> 默认 electron-webcontents Runtime
  -> Profile 持久化 Cookie/localStorage
```

Tianshe 的默认 Runtime 在 `src/types/browser-runtime.ts:10` 明确是：

```ts
export const DEFAULT_BROWSER_RUNTIME_ID = 'electron-webcontents'
```

Tianshe 同时提供 `chromium-extension-relay`，但它是可选 Runtime，不是默认路径。

### 1.3 Capability 能否替代浏览器扩展

不能简单说替代，因为它们不是同一层。

```text
Capability = 业务调用单位
Extension/Electron = 浏览器 Runtime 和控制方式
```

正确组合是：

```text
douyin.batch_edit_title Capability
  -> ensure login
  -> 选择/复用 Profile
  -> 使用 electron-webcontents 或 chromium-extension-relay
  -> 调用抖店接口或 Site Adapter
  -> 返回结构化结果
```

因此可以采用 Tianshe Capability 方式，而且应该采用；底层仍然必须有某种浏览器 Runtime 承载登录态。

---

## 2. 店汪汪真实代码能确认什么

店汪汪关键方法体受 DNGuard HVM 保护，反编译后很多方法只有：

```csharp
throw new Exception("Error, DNGuard Runtime library not loaded!");
```

因此要区分“代码直接确认”和“根据类结构、日志、缓存推断”。

### 2.1 代码直接确认

#### WebView2 登录入口

`小抖/小抖/decompiled/douShopTool/form_login_webview2.cs` 可以确认：

- 有 `WebView2` 控件。
- 有 `_userDataFolderName` 独立用户目录字段。
- 有 `cookieCheckTimer`。
- 有 `_needClearCookieOnInit`。
- 有 `SetupLoginDetection()`、`ClearCk()`、`HandleLoginSuccessAsync()`。
- 订阅了 `CoreWebView2InitializationCompleted` 和 `NavigationCompleted`。
- 存在 `SourceChanged`、`WebResourceRequested`、`NewWindowRequested` 处理器。

登录 URL 常量也能直接确认：

```text
https://fxg.jinritemai.com/login/common
https://fxg.jinritemai.com/passport/sso/login/callback
https://fxg.jinritemai.com/ffa/chooseEntries
```

#### 登录凭据模型

`DouYinLoginedCurrentUser.cs` 能直接确认大量字段存在，包括：

- `phpsessid`
- `sessionid`
- `ttwid`
- `ms_token`
- `fxg_csrf_session_id`
- `fxg_x_secsdk_csrf_token`
- `compass_csrf_session_id`
- `compass_x_secsdk_csrf_token`
- `ucas_c0_buyin`
- `luopan_dt`
- `sessionIsInvalid`

并且确实存在这些方法：

```text
CheckLogin
PHPSESSIDIsInvalid
accountIsInvalid
autoLogin
ActivePhpSession
AuthenticateBuyinSession
AuthenticateCompassSession
```

#### LiteDB + INI 恢复

`loginInfo.cs:258-377` 能直接确认：

- `ShopInfoCol` 和 `ShopGroupCol` 使用 LiteDB 集合。
- 进程启动时读取 INI 值。
- INI 值经过 Base64 解码和 `DecryptBytsDataToString()`。
- 反序列化成 `SeriralizeInfo`。
- 同时从 LiteDB 读取全部店铺并执行同步。

### 2.2 强推断，但方法体不可直接验证

以下结论与类名、字段、异步状态机、WebView2 缓存和日志一致，但关键方法体被保护：

- `HandleLoginSuccessAsync()` 是否逐个调用 `CookieManager.GetCookies()`。
- Cookie 具体如何从 WebView2 注入 CefSharp。
- `cookieCheckTimer` 的检测频率和判定条件。
- `autoLogin()` 的完整分支。
- CSRF token 的具体刷新请求和过期算法。

因此我们可以借鉴架构行为，但不能把报告中的伪代码当成可直接复用源码。

---

## 3. 店汪汪实际属于什么方式

店汪汪不是浏览器扩展架构。

它更接近：

```text
WebView2 登录浏览器
  -> 提取/保存 Cookie 与 token
  -> CefSharp 或 HttpClient 执行业务
```

也就是“双浏览器 + 显式凭据同步”。

这种方式在传统桌面软件里有实际价值：

- 登录页面交给 WebView2。
- 后台 HttpClient 可以高并发调用接口。
- CefSharp 可以继续做页面操作。
- 程序可以明确读取和刷新 token。

代价也很明显：

- 登录仓出现多份副本。
- WebView2、CefSharp、HttpClient 三边状态可能不一致。
- 平台新增 Cookie/token 后需要同步改模型。
- 跨抖店、罗盘、百应的会话刷新逻辑大量硬编码。
- a_bogus、msToken、CSRF 等机制变化后维护成本高。

---

## 4. Tianshe 当前真实实现

### 4.1 Profile 已经是持久登录仓

`src/main/duckdb/profile-service.ts:186-189` 创建 Profile 时会生成：

```ts
const partition = `persist:profile-${id}`
```

`electron-webcontents` 的 runtime descriptor 明确是：

```text
profileMode: persistent
visibilityMode: embedded-view
cookies.read/write/clear/filter: true
storage.dom: true
```

浏览器 Session 还支持：

- `getCookies()`
- `setCookie()` / `setCookies()`
- `clearAllCookies()`
- `flushCookies()`
- `clearStorageData()`

所以 Tianshe 不需要额外把完整 Cookie 再保存到插件表或配置文件。

### 4.2 登录弹窗复用同一个 Profile

`src/main/ipc-handlers/account-ipc-handler.ts:254-346` 的流程是：

1. 读取 Account 绑定的 Profile。
2. 获取 Profile live-session lease。
3. 从 BrowserPool acquire 浏览器。
4. 导航到登录 URL。
5. Electron Runtime 用应用内弹窗显示。
6. 关闭弹窗时释放 handle，但 Profile 持久存储不会删除。

这与店汪汪“WebView2 用户目录保持登录”的核心效果一致，但不需要提取并复制 Cookie。

### 4.3 `profile_ensure_logged_in` 目前只是状态编排

这是一个需要特别注意的真实缺口。

`src/core/ai-dev/capabilities/profile-catalog.ts:834-900` 当前实现会：

- 解析 Profile。
- 查询 `ProfileLoginState`。
- 必要时准备可见 session。
- 返回 `needs_manual_login` 或已保存的 `logged_in`。
- 写回登录状态记录。

但它没有主动访问目标网站，也没有调用站点接口验证 Cookie 是否仍有效。

代码中的关键判断是：

```ts
state?.status === 'logged_in' && state.verified === true
```

所以它更像：

```text
登录状态登记与人工接管编排
```

而不是店汪汪 `CheckLogin()` 那种主动站点验证。

我们仍然需要一个抖店专项 verifier/Capability。

### 4.4 ProfileLoginState 只保存健康状态

`profile-login-state-service.ts` 已经有：

- `profile_id`
- `account_id`
- `site`
- `runtime_id`
- `status`
- `verified`
- `last_checked_at`
- `verified_at`
- `evidence`
- `reason`

这正适合保存登录健康状态，而不是保存完整 Cookie/token 副本。

---

## 5. Electron Runtime 与扩展 Runtime 的真实区别

### 5.1 `electron-webcontents`

代码事实：

- Tianshe 默认 Runtime。
- 每 Profile 一个持久 partition。
- 应用内嵌可见登录窗口。
- 支持 Cookie、DOM storage、页面 snapshot、截图、下载、原生输入。
- 支持网络捕获，但当前 descriptor 明确说明不保存 response body。
- 不支持统一接口下的请求拦截控制。

优点：

- 首版最简单，和小尊宝桌面客户端形态一致。
- 登录页可直接嵌入应用。
- 不需要额外启动 Chrome 和控制扩展。
- 登录后可隐藏运行。
- `browser.evaluate(fetch)` 可以直接复用当前页面 Cookie。

缺点：

- 某些站点会识别 Electron 环境。
- 不方便抓取完整接口响应体。
- 不适合依赖 Chrome 扩展注入的功能。
- 当平台签名依赖实际页面请求链时，调试能力弱于 extension relay。

### 5.2 `chromium-extension-relay`

`browser-pool-integration-extension.ts` 可以确认它会：

- 启动独立 Chrome 进程。
- 每个 Profile 使用独立 `userDataDir`。
- 加载 Tianshe 内部控制扩展。
- 加载绑定到 Profile 的 managed extensions。
- 通过 `ExtensionControlRelay` 控制浏览器。

runtime descriptor 显示它支持：

- Cookie 和 DOM storage。
- 页面 snapshot、原生输入、标签页。
- `network.responseBody`。
- `intercept.observe` / `intercept.control`。
- 扩展包注入。

优点：

- 更接近真实 Chrome。
- 适合抓接口 JSON 和动态请求参数。
- 更适合平台页面注入按钮或辅助脚本。
- 对 a_bogus、msToken、请求头等问题更容易观察和诊断。

缺点：

- 是外部窗口，不能像 Electron 一样自然嵌入工具箱。
- 启动链包含 Chrome、控制扩展、relay，组件更多。
- 需要管理 Chrome 版本、路径和扩展绑定。
- 原来在 Electron Profile 里的登录态不能直接拿来使用。

### 5.3 不能在 Runtime 之间随意搬登录态

Tianshe 的登录健康模型包含 `runtimeId`，`evaluateSiteLoginHealth()` 会检查 `runtime_mismatch`。

所以不要设计成：

```text
Electron 登录 -> Extension 执行
```

除非重新登录或显式迁移完整浏览器存储。推荐：

```text
一个 Profile 固定一种 Runtime
登录和业务执行始终使用该 Runtime
```

---

## 6. Capability 与浏览器扩展的优缺点

| 维度 | Tianshe Capability | 浏览器扩展/Extension Relay |
|---|---|---|
| 定位 | 业务入口与闭环 | 浏览器控制 Runtime |
| 是否保存登录态 | 否，由 Profile/Runtime 保存 | 是，通过 Chrome userDataDir |
| 是否定义业务参数 | 是，input/output schema | 否，只提供浏览器/页面能力 |
| 是否可换 Runtime | 理论上可以，取决于 requires | 本身就是某一种 Runtime |
| 是否适合批量任务 | 适合，能统一重试、队列、结果 | 只提供执行底座 |
| 是否适合页面注入 | 通过 Site Adapter/Runtime | 很适合 content script |
| 是否能读 response body | 由所选 Runtime 决定 | extension relay 当前支持 |
| 是否能独立完成登录 | 不能，负责组织人工接管 | 可以承载登录页面 |
| 维护边界 | 业务逻辑清晰 | 页面和浏览器细节较多 |

最佳方案不是二选一，而是：

```text
Capability 管业务，Profile 管登录，Runtime 管浏览器。
```

---

## 7. 推荐的抖店登录保持设计

### 7.1 不复制 Cookie，只记录健康状态

建议数据分工：

| 数据 | 存储位置 |
|---|---|
| Cookie/localStorage/IndexedDB | Profile 对应 Runtime 的持久存储 |
| shopId/shopName | Account + 插件 shops 表 |
| 登录状态/验证时间 | ProfileLoginState |
| fxg/compass/buyin 是否激活 | 插件 session health 状态 |
| 失败原因 | ProfileLoginState reason / 任务日志 |
| 完整 Cookie 字符串 | 不持久化到业务表 |

### 7.2 新增 `douyin.verify_login` Capability

它应是真正的站点验证，不只是读缓存状态。

```text
输入 accountId/profileId
  -> 解析 Profile 和 Runtime
  -> 获取同一 Profile lease
  -> 打开 fxg 首页
  -> Login Extractor 判断登录页/验证码/店铺页
  -> 页面内请求店铺信息接口
  -> Login Verifier 确认 shopId/shopName
  -> 更新 ProfileLoginState
  -> 返回结构化状态
```

返回：

```text
logged_in
needs_manual_login
captcha
two_factor
blocked
expired
unknown
```

### 7.3 新增 `douyin.ensure_session` Capability

业务 Capability 调用前统一执行：

```text
profile_ensure_logged_in
  -> douyin.verify_login
  -> 按业务需要激活 origin
  -> 执行业务
```

参数示例：

```json
{
  "accountId": "...",
  "origins": ["fxg", "compass"]
}
```

不同功能需要的 origin：

| 功能 | origin |
|---|---|
| 商品、订单、资金、营销、违规 | `fxg` |
| 经营数据、清理滞销 | `fxg + compass` |
| 百应/达人扩展功能 | `fxg + buyin` |

### 7.4 登录失效处理

遇到以下情况立即更新状态，不盲目重试：

- 跳回登录页。
- 接口返回 401/403。
- 平台业务码表示登录失效，例如报告中的 `10008`。
- 出现扫码、短信、滑块、二次验证页面。

流程：

```text
业务 Capability 发现失效
  -> ProfileLoginState = expired/captcha/two_factor
  -> 返回 needs_manual_handoff
  -> UI 打开同一 Profile 登录窗口
  -> 用户完成登录
  -> douyin.verify_login
  -> 任务重新执行
```

### 7.5 CSRF、msToken、a_bogus 的处理

前期不要照店汪汪建立 40 多字段凭据模型。

优先顺序：

1. 在正确 origin 页面中执行 fetch，让浏览器自动携带 Cookie。
2. 能调用平台页面已有请求封装时，复用页面现成逻辑。
3. 需要观察真实请求参数时，使用 extension relay 的 network response/intercept。
4. 确认某 token 必须由插件管理后，再加单独字段和刷新逻辑。

也就是说，字段按真实需要增加，不先复制店汪汪整个 `DouYinLoginedCurrentUser`。

---

## 8. Runtime 选择建议

### 8.1 MVP 推荐

首版使用：

```text
electron-webcontents + Capability
```

原因：

- 它是 Tianshe 默认 Runtime。
- Profile partition 已持久化。
- 登录窗口可嵌入应用。
- 小尊宝首版主要是接口型批量功能，不依赖页面扩展也能起步。
- 实现成本最低。

### 8.2 何时改用 extension relay

出现以下任一情况时，为该类 Profile 选择 `chromium-extension-relay`：

- Electron 被抖店明显拦截。
- 关键接口必须读取真实页面 response body。
- a_bogus/msToken 无法通过页面内调用解决。
- 必须在抖店页面注入按钮或脚本。
- 需要请求拦截和动态修改。

不要让一个 Profile 在两个 Runtime 间临时切换。确定使用 extension relay 后，该 Profile 应在 extension Chrome 中完成登录并持续使用。

### 8.3 Capability 保持 Runtime 无关

业务 Capability 不应写死 Electron 或扩展：

```ts
requires: ["cookies.read", "snapshot.page"]
```

需要接口响应体的功能再声明：

```ts
requires: ["network.responseBody"]
```

由 runtime planner 选择满足条件的 Runtime。用户登录仍在最终选定的 Runtime 中完成。

---

## 9. 当前需要补的能力

### 9.1 Tianshe 通用能力

| 能力 | 当前状态 | 建议 |
|---|---|---|
| Profile 持久登录仓 | 已有 | 直接复用 |
| 人工登录弹窗/接管 | 已有 | 直接复用 |
| ProfileLoginState | 已有 | 给插件暴露读写 helper |
| `profile_ensure_logged_in` | 已有，但只编排缓存状态 | 增加站点 verifier 接口或由业务 Capability 补验证 |
| Profile 级 page fetch | 插件可通过 `withLease + evaluate` 实现 | 后续抽成通用 helper |
| 插件贡献 Capability | 暂无直接一等注册 | 首版内部 dispatcher，后续补框架扩展点 |

### 9.2 抖店插件内能力

| 能力 | 所属 |
|---|---|
| `douyin.verify_login` | 插件/Site Adapter |
| `douyin.ensure_session` | 插件 Capability |
| fxg/compass/buyin verifier | 插件 Site Adapter |
| 登录失效业务码映射 | 插件配置 |
| CSRF/msToken 必要刷新逻辑 | 插件 service |
| 店铺信息解析 | 插件 extractor |

---

## 10. 真实账号验证清单

在决定是否全面采用 extension relay 前，先做以下验证：

1. Electron Profile 打开抖店并人工登录。
2. 关闭窗口、重启 Tianshe，确认仍能进入店铺后台。
3. `douyin.verify_login` 能读取 shopId/shopName。
4. 同一 Profile 访问罗盘，确认 SSO 是否自动完成。
5. 页面内 fetch 一个只读商品接口。
6. 页面内 fetch 一个罗盘经营数据接口。
7. 执行一次低风险商品预览接口。
8. 主动登出，确认 Capability 能标记 `expired`。
9. 登录窗口打开时，确认同 Profile 后台任务不会无提示卡住。
10. 只有接口签名、response body 或 Electron 风控失败时，再用 extension relay 重测。

通过 1-9 后，不需要为了“看起来更像浏览器”而强制改成扩展 Runtime。

---

## 11. 最终建议

最终架构应是：

```text
xzb_toolbox Plugin UI
  -> douyin.* Capability
  -> profile_ensure_logged_in（状态与人工接管）
  -> douyin.verify_login（真实站点验证）
  -> 固定 Profile + 固定 Runtime
  -> API service / Site Adapter
```

首版选择 `electron-webcontents`。`chromium-extension-relay` 是处理真实 Chrome、response body、页面注入和 Electron 风控问题的可选 Runtime。

店汪汪的登录保持机制需要借鉴“持久登录仓和主动健康检查”，但不要复制它的“Cookie 抽取、三重存储、双浏览器同步”实现。

