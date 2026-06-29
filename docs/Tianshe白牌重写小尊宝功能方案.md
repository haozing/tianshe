# 基于 Tianshe 白牌框架重写小尊宝工具箱 V2.1.6 功能方案

> **二次审计说明：** 本文保留第一次完整推演。结合 Tianshe v4、单插件落地、UI 参考图和“先可用、少设计”的要求，后续实施应以 [Tianshe白牌重写小尊宝方案_审计修订版.md](./Tianshe白牌重写小尊宝方案_审计修订版.md) 为准。

> 分析对象：  
> - 小尊宝工具箱 V2.1.6 已解包与远程资源分析结果  
> - 白牌框架源码：`D:\code\tooltemp\tianshe\tianshe\src`  
> - 目标功能：店铺管理、经营数据、资金数据、违规管理、售中管理、限时限量购、新人礼金、通用优惠券、商机提报、清理滞销、批量上下架、批量删除、达人秀修改、批量改标题、批量改价、运费模板  
>
> 结论先行：Tianshe 可以作为白牌工具箱外壳和运行底座，但不能直接“无改造”复刻小尊宝。最关键的三块需要新增：抖店登录态/接口 SDK、浏览器会话内 HTTP 客户端、云端插件/扩展更新通道。账户登录方面，Tianshe 的 Profile + Account + BrowserPool 模型反而更适合做多店铺隔离，只是需要补一层抖店登录检测与店铺信息同步。

---

## 1. 小尊宝原实现抽象

小尊宝本质上由三层组成：

1. Electron 壳  
   负责桌面应用、浏览器会话、登录态、窗口、预加载 API。

2. 远程 Web 应用  
   主界面来自 `https://apptool.zzbtool.com`，功能路由以远程 chunk 形式加载。前面已下载并整理过相关 chunk。

3. 平台页面注入插件  
   远程 `v3_all.js` 注入抖店、拼多多、巨量罗盘等页面，在平台页面上加快捷入口或辅助按钮。它通过远程配置/脚本实现后期更新。

对应功能 chunk 和共享模块如下：

| 功能 | 小尊宝路由 | 主要 chunk/模块 |
|---|---|---|
| 店铺管理 | `/dy/shopList` | `index-R2jGZLVf.js` |
| 经营数据 | `/dy/analysis` | `index-DK98ggIw.js` |
| 资金数据 | `/dy/financial` | `index-2SfHpNxb.js` |
| 违规管理 | `/dy/managementOfViolations` | `index-DTm9nDY0.js` |
| 售中管理 | `/dy/managementOfOnSale` | `index-CDyvcjyo.js` |
| 限时限量购 | `/dy/timelimits` | `index-XGmD8C4T.js`、`base_form-BuqbgIWN.js`、`auto_renew_task-De8FwXKf.js` |
| 新人礼金 | `/dy/newGiftMoney` | `index-BKUc4sUa.js` |
| 通用优惠券 | `/dy/coupons` | `index-BgmPRA1E.js`、`coupons-BgsocAAj.js` |
| 商机提报 | `/dy/bussinessCenterSubmit` | `index-C7UgVeRp.js`、`handler-DurRwRDQ.js` |
| 清理滞销 | `/dy/clearNoSales` | `index-DirnFtOd.js`、`shop-CVJtbets.js` |
| 批量上下架 | `/dy/batchListingAndDelisting` | `index-DKxNCFOc.js`、`exportFailList-Cu2LCUMb.js` |
| 批量删除 | `/dy/batchDelete` | `index-DP2DsaL1.js`、`shop-CVJtbets.js`、`exportFailList-Cu2LCUMb.js` |
| 达人秀修改 | `/dy/gotTalentShowEdit` | `index-is6rwhFa.js`、`exportFailList-Cu2LCUMb.js` |
| 批量改标题 | `/dy/batchEditTitle` | `index-DA_7pz_z.js`、`exportFailList-Cu2LCUMb.js` |
| 批量改价 | `/dy/batchEditPrice` | `index-BHaMFwh2.js`、`exportFailList-Cu2LCUMb.js` |
| 运费模板 | `/dy/freightRateTemplate` | `index-Dd8Kn5_d.js`、`exportFailList-Cu2LCUMb.js` |

小尊宝里最值得复用的不是代码本身，而是“业务分层”：

| 层 | 小尊宝表现 | Tianshe 重写方向 |
|---|---|---|
| 店铺会话层 | Electron session + 远程 API | Tianshe Profile/Account/BrowserPool |
| 平台 HTTP 层 | 携带抖店 Cookie 请求平台接口 | 新增 `DoudianHttpClient`，在浏览器会话内 fetch |
| 批任务层 | 并发、重试、失败列表、导出 | Tianshe plugin `taskQueue` + DuckDB/Excel |
| 功能 UI 层 | 远程 Vue/React 页面 | Tianshe JS Plugin 自定义页面或远程页面 |
| 页面注入层 | 远程 Chrome extension JS | Tianshe ExtensionPackages + 云端包更新 |

---

## 2. Tianshe 框架可承接的能力

### 2.1 白牌壳

关键源码：

- `D:\code\tooltemp\tianshe\tianshe\src\shared\app-shell-config.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\renderer\App.tsx`

Tianshe 已支持通过 `tianshe-shell.config.json` 控制壳能力：

- 隐藏内置页面：Datasets、Plugin Market、Account Center、Settings。
- 控制 ActivityBar 是否显示。
- 设置默认插件 `defaultPlugin`。

建议白牌配置：

```json
{
  "pages": {
    "datasets": false,
    "marketplace": false,
    "accountCenter": false,
    "settings": false
  },
  "activityBar": {
    "visible": false
  },
  "defaultPlugin": "doudian_toolbox"
}
```

开发期可以暂时保留 `accountCenter` 和 `settings`，方便排查账户、代理、浏览器 Profile。正式白牌包建议隐藏，只露出小尊宝式工具箱主界面。

### 2.2 账户与浏览器 Profile

关键源码：

- `D:\code\tooltemp\tianshe\tianshe\src\types\profile.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\main\duckdb\account-service.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\main\duckdb\profile-service.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\main\ipc-handlers\account-ipc-handler.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\preload\api\account.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\preload\api\profile.ts`

Tianshe 的账户模型可以直接映射小尊宝的“店铺管理”：

| 小尊宝概念 | Tianshe 对应 | 说明 |
|---|---|---|
| 店铺浏览器环境 | `BrowserProfile` | 每个店铺一个独立 partition：`persist:profile-{id}` |
| 店铺账号 | `Account` | 绑定 `profileId` 和 `platformId`，内置 `shopId/shopName` 字段 |
| 平台 | `SavedSite` | 抖店、巨量罗盘等平台入口 |
| 登录状态 | `ProfileLoginState` | 可记录 `logged_in`、`captcha`、`expired`、`blocked` 等状态 |
| 店铺分组 | `Profile.groupId` 或插件表 | 简单分组可用 Profile；业务分组建议插件表 |
| 功能套餐/订购状态 | 插件自建表 | Tianshe 原生 Account 没有套餐字段 |

Tianshe Profile 默认 `quota = 1`，也就是同一个店铺环境同一时间只允许一个活跃浏览器实例。这对抖店多店铺隔离是好事，可以避免同一店铺并发窗口互相污染 Cookie 或触发平台风控。

### 2.3 浏览器池

关键源码：

- `D:\code\tooltemp\tianshe\tianshe\src\core\browser-pool\pool-manager.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\core\browser-core\browser.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\core\browser-core\session.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\core\browser-core\web-request-hub.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\types\browser-interface.ts`

可用能力：

- 使用指定 Profile 打开登录页或平台页。
- 读取/写入 Cookie。
- 执行页面内 `evaluate`。
- 监听网络请求、响应、下载、弹窗。
- 控制浏览器显示/隐藏。
- 在同一 Profile 下访问抖店、罗盘、营销中心等多个域名。

需要补的能力：

1. 插件侧缺少“抖店会话 HTTP 客户端”  
   Tianshe 的 `helpers.network` 是普通 Node HTTP，不会自动带浏览器 Cookie，也不会自然获得平台页面内的签名、token、referer、风控上下文。

2. 登录态检测没有抖店业务逻辑  
   框架只知道浏览器 Profile 和 Account，不知道怎样判断抖店是否已登录、是否需要扫码、是否滑块、是否店铺被拦截。

3. 多域名请求需要显式处理  
   经营数据大量来自 `compass.jinritemai.com`，商品/订单/营销大量来自 `fxg.jinritemai.com`。应在同一个 Profile 下切换 origin 后请求，不能假设跨域 fetch 永远可用。

### 2.4 JS Plugin 系统

关键源码：

- `D:\code\tooltemp\tianshe\tianshe\src\core\js-plugin\manager.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\core\js-plugin\loader.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\types\js-plugin.d.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\main\ipc-handlers\webcontentsview-plugin-page-controller.ts`

可用能力：

- 插件 manifest。
- 插件主进程逻辑 `main`。
- 自定义页面 `customPages`。
- ActivityBar 入口 `activityBarView`。
- 暴露 API 给插件页面：`context.exposeAPI(...)`。
- 插件存储、参数、数据库、任务队列、调度器。
- 云插件安装/更新方法在代码层存在：`installOrUpdateCloudPlugin(...)`。

限制：

- Open edition 中云认证、云插件、云扩展入口被关闭。见：
  - `D:\code\tooltemp\tianshe\tianshe\src\edition\open\index.ts`
  - `D:\code\tooltemp\tianshe\tianshe\src\preload\index.ts`
- 也就是说，当前开源/开放版本不能直接通过现成入口实现“小尊宝式线上 JS 热更新”。需要启用私有白牌 edition，或新增自己的云插件更新服务。

### 2.5 浏览器扩展包

关键源码：

- `D:\code\tooltemp\tianshe\tianshe\src\main\profile\extension-packages-manager.ts`
- `D:\code\tooltemp\tianshe\tianshe\src\preload\api\extension-packages.ts`

Tianshe 有扩展包管理、Profile 绑定、云端下载、sha256 校验等基础能力。适合重写小尊宝的 `v3_all.js` 页面注入逻辑：

- 抖店页面加按钮。
- 罗盘页面加快捷入口。
- 平台页面打开白牌工具箱对应功能。
- 运费模板页面做表单辅助。

建议不要复刻小尊宝那种远程 eval 任意 JS 的方式。更安全的做法是：

1. 扩展以版本化 zip 包发布。
2. 云端 catalog 提供 `downloadUrl`、`version`、`sha256`。
3. 客户端下载、校验、安装、绑定到指定 Profile。
4. 如需高频变更，只在线更新“规则 JSON/入口配置”，扩展代码本体仍走签名包更新。

---

## 3. 推荐整体架构

建议在 Tianshe 上新增三个核心模块。

### 3.1 `doudian_core` 插件

职责：所有业务后端逻辑。

包含：

- 账户创建、登录、校验、店铺信息同步。
- 抖店/罗盘 HTTP SDK。
- 商品、订单、资金、经营、营销、商机、违规等 API 封装。
- 批任务引擎。
- 失败列表与操作日志。
- Excel 导入导出。
- 给 UI 暴露稳定 API。

建议 API：

```ts
context.exposeAPI("account.listShops", listShops)
context.exposeAPI("account.createShop", createShop)
context.exposeAPI("account.openLogin", openLogin)
context.exposeAPI("account.verifyLogin", verifyLogin)

context.exposeAPI("analysis.sync", syncAnalysis)
context.exposeAPI("financial.sync", syncFinancial)
context.exposeAPI("goods.previewBatch", previewBatchGoods)
context.exposeAPI("goods.runBatchEdit", runBatchEdit)
context.exposeAPI("coupon.create", createCoupon)
context.exposeAPI("limitsales.renew", renewLimitSales)
```

### 3.2 `doudian_toolbox` 插件页面

职责：白牌工具箱 UI。

实现方式：

- 一个 ActivityBarView 或默认插件页。
- 左侧店铺列表，右侧功能页。
- 内部路由保持小尊宝式功能名：
  - 店铺管理
  - 经营数据
  - 资金数据
  - 违规管理
  - 售中管理
  - 限时限量购
  - 新人礼金
  - 通用优惠券
  - 商机提报
  - 清理滞销
  - 批量上下架
  - 批量删除
  - 达人秀修改
  - 批量改标题
  - 批量改价
  - 运费模板

UI 可以是本地打包页面，也可以是远程页面。

推荐策略：

- 首版本地页面，便于稳定交付。
- 后续把 UI 页面切到 `source.type = "remote"`，由线上页面调用 `window.pluginAPI.doudian_core.xxx`。
- 核心业务能力仍在本地插件中，按签名包更新，避免线上页面直接拥有过大权限。

### 3.3 `doudian_page_extension` 扩展包

职责：平台页面注入。

用途：

- 在抖店后台加“打开工具箱”按钮。
- 在商品列表、订单列表、营销页面提供快捷操作入口。
- 在运费模板页面辅助读取/填充模板。
- 在巨量罗盘导出页辅助下载或跳转。

更新策略：

- 走 Tianshe ExtensionPackages。
- 云端 catalog + sha256。
- 只对已绑定的抖店 Profile 生效。

---

## 4. 账户登录重写设计

账户登录是整个重写里最重要的一块。建议以 Tianshe 的 Profile 为核心，而不是复刻小尊宝的单 session 模式。

### 4.1 数据模型

#### SavedSite

初始化三个站点：

| 站点 | URL | 用途 |
|---|---|---|
| 抖店 | `https://fxg.jinritemai.com` | 商品、订单、资金、营销、违规 |
| 巨量罗盘 | `https://compass.jinritemai.com` | 经营数据、滞销分析 |
| 百应/精选联盟，可选 | `https://buyin.jinritemai.com` | 达人/联盟相关能力预留 |

#### BrowserProfile

每个店铺一个 Profile：

```ts
{
  name: "店铺名或未命名店铺",
  partition: "persist:profile-{id}",
  runtimeId: "electron-webcontents",
  quota: 1,
  proxy: optional,
  fingerprint: optional
}
```

#### Account

每个店铺一个 Account：

```ts
{
  profileId,
  platformId: savedSiteFxg.id,
  displayName: shopName || "未登录店铺",
  shopId,
  shopName,
  loginUrl: "https://fxg.jinritemai.com/ffa/mshop/homepage/index",
  tags: ["douyin", "shop"]
}
```

#### 插件自建表

Tianshe Account 不包含小尊宝的业务字段，建议建 `doudian_shops`：

| 字段 | 说明 |
|---|---|
| `accountId` | Tianshe Account ID |
| `profileId` | Tianshe Profile ID |
| `shopId` | 抖店店铺 ID |
| `shopName` | 店铺名称 |
| `groupName` | 店铺分组 |
| `loginStatus` | 登录状态 |
| `packageStatus` | 工具箱套餐/授权状态 |
| `orderStatus` | 订购状态 |
| `lastCheckedAt` | 最近检测时间 |
| `lastError` | 最近错误 |

### 4.2 登录流程

推荐流程：

1. 用户点击“新增店铺”。
2. `doudian_core.account.createShop()` 调用 Tianshe Account/Profile 能力：
   - 创建 Profile。
   - 创建 Account。
   - 绑定抖店 SavedSite。
3. 用户点击“登录”。
4. `doudian_core.account.openLogin(accountId)`：
   - 获取 Account 和 Profile。
   - 使用 `helpers.profile.launchPopup(profileId, { url: loginUrl })` 打开抖店登录窗口。
   - 用户扫码/验证码/滑块登录。
5. 用户点击“检测登录”或窗口回调触发检测。
6. `verifyLogin(accountId)` 在同一 Profile 内访问抖店首页或接口。
7. 检测成功后：
   - 读取 `shopId/shopName`。
   - 更新 Tianshe Account。
   - 更新 `doudian_shops`。
   - 更新 `ProfileLoginState` 为 `logged_in`。
8. 检测失败后：
   - 若跳转登录页：`needs_manual_login`。
   - 若出现滑块/验证码：`captcha`。
   - 若权限/风控拦截：`blocked`。
   - 若接口 401/403：`expired`。

### 4.3 登录检测实现

不要只看 URL 是否在后台页面。建议做三层检测：

1. Cookie 检测  
   读取 `.jinritemai.com`、`fxg.jinritemai.com` 下关键 Cookie 是否存在。

2. 页面检测  
   打开 `https://fxg.jinritemai.com/ffa/mshop/homepage/index`，判断是否仍在登录页、是否出现扫码、滑块、二次验证。

3. 接口检测  
   在页面上下文中调用抖店首页/店铺信息接口，确认返回店铺信息。

伪代码：

```ts
async function verifyDoudianLogin(account) {
  return helpers.profile.withLease(account.profileId, {
    url: "https://fxg.jinritemai.com/ffa/mshop/homepage/index",
    visible: false
  }, async ({ browser }) => {
    const result = await browser.evaluate(async () => {
      const response = await fetch("/pc/api/home/homepage", {
        credentials: "include",
        headers: {
          "accept": "application/json"
        }
      })

      const text = await response.text()
      return {
        ok: response.ok,
        status: response.status,
        url: location.href,
        text
      }
    })

    return parseShopLoginResult(result)
  })
}
```

注意：具体接口路径需要以当前平台实测为准。小尊宝分析中可见它大量依赖抖店后台接口，但平台接口会变，重写时要把 endpoint 做成可线上更新的配置。

### 4.4 多域名登录态

经营数据来自巨量罗盘，不能简单用抖店页面跨域请求罗盘接口。建议封装：

```ts
withDoudianOrigin(profileId, origin, task)
```

行为：

1. 用同一个 Profile 获取浏览器。
2. `goto(origin)`，让当前页面处在目标域。
3. 在页面内执行 `fetch(..., { credentials: "include" })`。
4. 任务结束后释放浏览器。

示例：

```ts
await withDoudianOrigin(profileId, "https://compass.jinritemai.com", async (client) => {
  return client.get("/compass_api/shop/common/homepage/core_index_v3", params)
})
```

这比 Node 直接请求更稳，因为平台签名、Cookie、referer、风控上下文更接近真实浏览器。

### 4.5 登录相关不能满足点

Tianshe 原生不能直接满足以下抖店业务需求：

| 缺口 | 影响 | 改造建议 |
|---|---|---|
| 没有抖店登录态检测器 | 无法知道店铺是否真的登录 | 新增 `DoudianLoginVerifier` |
| 插件 helper 没有完整暴露 ProfileLoginState | UI 不方便读写业务登录态 | 新增插件 API 或 IPC facade |
| `helpers.network` 不带浏览器 Cookie | 不能直接调抖店接口 | 新增 `DoudianHttpClient` |
| 没有滑块/验证码状态识别 | 任务失败原因不清晰 | 页面检测 + 人工接管窗口 |
| 没有店铺套餐/授权字段 | 不能复刻小尊宝套餐展示 | 插件建 `doudian_shops` 和授权表 |
| 一个 Profile 只有一个活跃浏览器 | 同店铺登录窗口会阻塞后台任务 | 做任务队列和占用提示，这是合理限制 |

---

## 5. 抖店会话 HTTP SDK

### 5.1 为什么必须新增

小尊宝的功能几乎都依赖平台私有接口，例如：

- 商品：`/product/tproduct/list`、`/product/tproduct/previewDetail`、`/product/tproduct/modifySku`、`/product/tproduct/batchEdit`
- 订单：`/api/order/searchlist`
- 违规：`/governance/shop/penalty/get_penalty_list`
- 营销：限时限量购、优惠券、新人礼金相关接口
- 罗盘：`/compass_api/shop/common/homepage/core_index_v3`
- 商机：`/api/commop/business_chance_center/...`

这些接口需要当前店铺浏览器会话，单纯用 Node HTTP 很容易缺 Cookie、csrf、msToken、referer 或风控上下文。

### 5.2 推荐实现

新增 `DoudianHttpClient`：

```ts
interface DoudianHttpClient {
  get<T>(path: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T>
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  download(path: string, params?: Record<string, unknown>, options?: DownloadOptions): Promise<DownloadResult>
}
```

内部优先使用浏览器页面内 fetch：

```ts
await browser.evaluateWithArgs(async ({ url, method, headers, body }) => {
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include"
  })

  const contentType = response.headers.get("content-type") || ""
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text()

  return {
    ok: response.ok,
    status: response.status,
    data
  }
}, request)
```

必要时提供 Node 请求备用模式：

- 从 `browser.session.getCookies({ url })` 组装 Cookie。
- 设置 User-Agent、Referer、Origin。
- 仅用于下载、无动态签名的接口。

### 5.3 统一响应处理

统一处理：

- 未登录：跳 `expired`。
- 验证码：跳 `captcha`。
- 频繁：指数退避。
- 权限不足：记录 `blocked` 或 `forbidden`。
- 平台错误码：原始返回入库，方便排查。

建议错误类型：

```ts
type DoudianErrorCode =
  | "NOT_LOGGED_IN"
  | "CAPTCHA_REQUIRED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "PLATFORM_BUSY"
  | "VALIDATION_FAILED"
  | "UNKNOWN_PLATFORM_ERROR"
```

---

## 6. 批任务与数据存储设计

### 6.1 批任务引擎

小尊宝的 `exportFailList-Cu2LCUMb.js` 是多个商品批量功能的共用核心。Tianshe 应重写为 `GoodsBatchEngine`。

职责：

1. 读取输入商品 ID。
2. 拉取商品预览详情。
3. 校验状态、SKU、模板、标题、价格。
4. 根据功能生成变更 payload。
5. 分批执行。
6. 记录成功/失败。
7. 导出失败列表。
8. 支持暂停、取消、重试。

Tianshe 可用：

- `helpers.taskQueue`：并发、重试、进度、取消。
- DuckDB 数据集或插件表：任务记录、失败记录、快照。
- `exceljs/xlsx`：导入导出。

建议表：

| 表 | 用途 |
|---|---|
| `doudian_jobs` | 任务主表 |
| `doudian_job_items` | 每个商品/订单/活动的处理状态 |
| `doudian_failures` | 失败列表 |
| `doudian_operation_logs` | 操作日志 |
| `doudian_snapshots` | 商品/资金/经营数据快照 |

### 6.2 并发策略

| 维度 | 建议 |
|---|---|
| 单店铺 | 串行或低并发，避免触发风控 |
| 多店铺 | 可并发，每个 Profile 单独队列 |
| 商品修改 | 每批 5-20 个商品，按接口限制调整 |
| 数据查询 | 可略高并发，但遇到频繁立即退避 |
| 登录窗口打开时 | 暂停该 Profile 后台任务 |

---

## 7. 功能逐项重写方案

### 7.1 店铺管理

小尊宝能力：

- 店铺列表。
- 店铺搜索。
- 登录状态检测。
- 店铺分组。
- 套餐/订购状态。
- 刷新、登录、删除。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 店铺列表 | `helpers.account.list()` + `doudian_shops` 表 |
| 新增店铺 | 创建 Profile + Account |
| 登录 | `helpers.profile.launchPopup(profileId, { url })` |
| 登录检测 | `DoudianLoginVerifier` |
| 店铺名/ID | 登录成功后写回 Account `shopId/shopName` |
| 分组 | 插件表 `groupName`，或 Profile group |
| 删除 | 删除 Account/Profile，同时清理插件表 |
| 套餐状态 | 插件授权服务，不使用 Tianshe 原生 Account |

不能满足/需改造：

- Account 原生没有套餐、授权、订购字段。
- ProfileLoginState 需要更好地暴露给插件 UI。
- 登录状态必须做抖店专用检测。

建议优先级：最高。所有功能都依赖它。

### 7.2 经营数据

小尊宝能力：

- 拉取巨量罗盘和抖店经营指标。
- 商品、订单、物流、服务、违规、营销、口碑等聚合。
- 支持导出。

涉及接口类型：

- `https://compass.jinritemai.com/compass_api/shop/common/homepage/core_index_v3`
- 抖店商品诊断、店铺首页、违规提醒、营销活动、体验分等接口。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 店铺选择 | 读取已登录 Account |
| 罗盘接口 | `DoudianHttpClient` 切到 `compass.jinritemai.com` origin |
| 抖店接口 | `DoudianHttpClient` 切到 `fxg.jinritemai.com` origin |
| 聚合 | `analysis.service` 统一归一化字段 |
| 快照 | 写入 `doudian_snapshots` |
| 导出 | Excel 导出 |

不能满足/需改造：

- 需要处理罗盘域名登录态。
- 罗盘导出/下载如果依赖浏览器下载中心，需要扩展 `download` 能力。
- 指标字段会随平台变动，建议 endpoint 和字段映射做线上配置。

### 7.3 资金数据

小尊宝能力：

- 统计可提现、货款、冻结、待结算、保证金、补贴、赔付、待结算订单。
- 遇到平台繁忙做重试。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 资金接口 | `financial.service` 使用抖店会话请求 |
| 多接口合并 | `financial.normalizer` |
| 重试 | taskQueue retry + 指数退避 |
| 快照 | `doudian_financial_snapshots` |
| 导出 | Excel |

不能满足/需改造：

- 需要确认当前抖店资金接口路径和返回结构。
- 财务数据敏感，建议增加权限控制和操作审计。
- 若平台要求二次验证，必须提示人工进入浏览器完成。

### 7.4 违规管理

小尊宝能力：

- 拉取处罚/违规列表。
- 识别待处理项。
- 结合商品状态做处理、修改、记录失败。

主要接口：

- `/governance/shop/penalty/get_penalty_list`

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 违规列表 | `violation.service.listPenalties` |
| 商品联动 | 调用 `goods.service` 获取商品详情 |
| 批量处理 | `ViolationTaskRunner` |
| 失败记录 | `doudian_failures` |
| UI | 违规列表 + 状态筛选 + 处理按钮 |

不能满足/需改造：

- “违规处理”的具体动作需要按实际业务规则定义，不能只靠框架。
- 自动修改商品有经营风险，建议提供预览和二次确认。
- 处罚状态字段会变，需线上规则配置。

### 7.5 售中管理

小尊宝能力：

- 搜索订单。
- 获取订单收货信息。
- 检测物流、风险、售中状态。
- 处理验证码/频繁限制。

主要接口：

- `/api/order/searchlist`
- `/shopuser/power/getPackageList`
- `/api/order/receiveinfo`

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 订单查询 | `order.service.search` |
| 收货信息 | `order.service.getReceiveInfo` |
| 风险分类 | `onsale.rules` |
| 批量同步 | taskQueue |
| 验证码 | 检测后切换 ProfileLoginState 为 `captcha`，提示人工接管 |

不能满足/需改造：

- 平台订单接口更容易触发风控，必须做低并发和退避。
- 收货信息可能涉及隐私权限，建议加操作审计。
- 验证码无法靠框架自动解决，需要可视化接管。

### 7.6 限时限量购

小尊宝能力：

- 查询限时限量购活动。
- 查询可参与商品。
- 创建/编辑活动。
- 开启/关闭活动。
- 自动续期，接近 8 天时续。

涉及接口：

- 营销中心 limitsales 相关接口。
- `listFlashWithTimeLimit`
- `setFlashStatus`
- detail/edit flash。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 活动列表 | `limitsales.service.list` |
| 商品查询 | `limitsales.service.queryAvailableProducts` |
| 创建/编辑 | `limitsales.service.save` |
| 开关 | `limitsales.service.setStatus` |
| 自动续期 | Tianshe scheduler + taskQueue |
| 续期记录 | `doudian_auto_renew_tasks` |

不能满足/需改造：

- Tianshe 有 scheduler，但需要新增营销活动 payload 校验。
- 自动续期需要守护任务和失败通知。
- 活动规则变化频繁，应把字段映射和默认规则做线上配置。

### 7.7 新人礼金

小尊宝能力：

- 查询新人礼金首页和活动记录。
- 创建新人礼金。
- 禁用活动。
- 大量商品校验。

涉及接口：

- `/ffa/marketing/union/allowance/home`
- `/marketing/union_allowance/v1/create_apply`
- `list_record`
- `disable_apply`

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 活动列表 | `newGift.service.list` |
| 创建活动 | `newGift.service.create` |
| 禁用活动 | `newGift.service.disable` |
| 商品校验 | 复用 `GoodsBatchEngine` 预览/校验 |
| 失败导出 | `doudian_failures` |

不能满足/需改造：

- 大量商品时要分页和断点续跑。
- 创建活动 payload 要实测当前平台字段。
- 平台活动限制和错误文案建议线上配置。

### 7.8 通用优惠券

小尊宝能力：

- 优惠券列表/详情。
- 查询可用商品。
- 创建、检查、启停优惠券。
- 支持不同有效期。

涉及模块：

- `coupons-BgsocAAj.js`
- coupon home/detail/check/list/operate 等接口。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 列表 | `coupon.service.list` |
| 详情 | `coupon.service.detail` |
| 商品检查 | `coupon.service.checkProducts` |
| 创建 | `coupon.service.create` |
| 启停 | `coupon.service.operate` |
| UI | 活动表单 + 商品选择 + 失败列表 |

不能满足/需改造：

- 需要抽象通用营销活动表单。
- 商品适用范围、券类型、有效期规则要动态配置。
- 平台校验错误需要标准化。

### 7.9 商机提报

小尊宝能力：

- 拉取商机列表。
- 批量提报商品。
- 可选择“加商机词改标题”或只校验提报。
- 支持类目、商品筛选。

涉及接口：

- `/api/commop/business_chance_center/clue/common/real_time_list`
- `/multiple_item_submit/submit`
- `/product/batch/edit`
- `/shop_full_category/list`
- `/product/list`

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 商机列表 | `businessChance.service.listClues` |
| 商品筛选 | `goods.service.list` |
| 标题改写 | 复用批量改标题规则引擎 |
| 批量提报 | `businessChance.service.submit` |
| 自动开关 | scheduler 或任务配置 |

不能满足/需改造：

- 标题改写要规避超长、重复词、平台违禁词。
- 类目和商机字段变化频繁，建议线上规则。
- “自动提报”需要授权和操作日志。

### 7.10 清理滞销

小尊宝能力：

- 获取商品列表。
- 从经营版/罗盘导出数据。
- 结合销量、曝光、点击、库存、品质等指标筛选滞销品。
- 批量下架、删除、彻底删除。
- 原实现部分依赖 `https://safe2.zzbtool.com/transV2` 转发/下载。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 商品列表 | `goods.service.list` |
| 罗盘数据 | `analysis.service` 或浏览器下载 |
| 筛选规则 | `staleGoods.rules` |
| 预览 | 商品表格 + 命中原因 |
| 执行 | 复用批量上下架/删除 |
| 导出 | Excel |

不能满足/需改造：

- 这是较大的缺口。小尊宝使用了自己的 `safe2` 中转服务，Tianshe 没有等价能力。
- 如果平台导出需要后端转发、解密、格式转换，就必须自建白牌服务。
- 如果能直接浏览器下载，则可用 Browser download 能力实现。
- 滞销规则必须可配置，否则平台指标变化后容易失效。

### 7.11 批量上下架

小尊宝能力：

- 导入/筛选商品。
- 批量上架或下架。
- 可预览和导出失败。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 商品导入 | Excel/文本导入 |
| 商品预览 | `goods.service.previewDetail` |
| 状态校验 | `GoodsBatchEngine` |
| 执行 | `goods.service.batchEdit` 或下架专用接口 |
| 失败列表 | `doudian_failures` |

不能满足/需改造：

- 需要确认当前上下架接口 payload。
- 上架可能受商品审核/库存/类目限制，需要展示平台错误。

### 7.12 批量删除

小尊宝能力：

- 删除到回收站。
- 彻底删除。
- 避免删除在售商品。

涉及接口：

- `/product/tproduct/batchDelete`
- `/product/tproduct/completeDelete`

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 删除类型 | 回收站/彻底删除 |
| 在售保护 | 执行前读取商品状态 |
| 执行 | `goods.service.batchDelete`、`goods.service.completeDelete` |
| 二次确认 | UI 强提示 |
| 失败导出 | `doudian_failures` |

不能满足/需改造：

- 彻底删除不可逆，应强制二次确认和操作日志。
- 平台接口可能要求商品处于特定状态。

### 7.13 达人秀修改

小尊宝能力：

- 批量开启/关闭达人秀相关状态。
- 基于商品预览详情生成修改 payload。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 商品预览 | `goods.service.previewDetail` |
| 状态计算 | `talentShow.rules` |
| 执行 | 复用 `goods.service.batchEdit` |
| 失败导出 | `doudian_failures` |

不能满足/需改造：

- 当前平台达人秀字段名和 payload 需要用真实账号抓包确认。
- 如果字段隐藏在商品详情深层结构里，必须做 schema 适配。

### 7.14 批量改标题

小尊宝能力：

- 批量删除前缀/后缀。
- 替换词。
- 添加商机词。
- 校验标题长度，最长约 60。
- 预览新旧标题。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 标题规则 | `titleRewrite.engine` |
| 预览 | 新旧标题 diff |
| 长度校验 | 字符数/平台口径配置 |
| 执行 | `goods.service.batchEdit` |
| 失败导出 | `doudian_failures` |

不能满足/需改造：

- 需要维护违禁词/营销词规则。
- 标题长度口径可能不是简单 JS 字符数，应可配置。
- 批量改标题容易触发审核，建议默认低并发。

### 7.15 批量改价

小尊宝能力：

- SKU 级改价。
- 支持按规则计算新价格。
- 处理单买价/拼团价关系。
- 有价格保护，避免异常低价。

主要接口：

- `/product/tproduct/previewDetail`
- `/product/tproduct/modifySku`

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| SKU 预览 | `goods.service.previewDetail` |
| 价格规则 | `priceRule.engine` |
| 单买/团购约束 | `priceRule.validator` |
| 价格保护 | 最低价、最大降幅、确认阈值 |
| 执行 | `goods.service.modifySku` |
| 日志 | 修改前后价格快照 |

不能满足/需改造：

- 价格是高风险操作，应强制预览、确认、日志、可导出。
- SKU 结构变化频繁，需要适配器。
- 小尊宝里“团购价高于单买价时自动调单买价”的逻辑要明确是否保留。

### 7.16 运费模板

小尊宝能力：

- 获取模板列表。
- 复制/新建模板。
- 给商品绑定模板。
- 跨店复制模板，但同店不复制。
- 失败重试。

Tianshe 重写：

| 项 | 实现方式 |
|---|---|
| 模板列表 | `freight.service.listTemplates` |
| 模板详情 | `freight.service.getTemplateDetail` |
| 复制模板 | `freight.service.cloneTemplate` |
| 绑定商品 | `freight.service.bindProducts` |
| 跨店复制 | 源 Account 读模板，目标 Account 创建模板 |
| UI | 源店/目标店/模板/商品选择 |

不能满足/需改造：

- 运费模板 payload 很细，必须真实抓包确认。
- 同店复制、跨店复制、默认模板、偏远地区规则都要做校验。
- 如果页面表单比接口稳定，可由浏览器扩展辅助读取/填写。

---

## 8. 线上 JS 更新设计

用户希望“相关的一部分 JS 代码像小尊宝一样后期可线上更新”。Tianshe 可以实现，但建议不要照搬远程 eval。

### 8.1 可线上更新的三类内容

| 类型 | 推荐更新方式 | 适合内容 |
|---|---|---|
| UI 页面 | `customPage.source.type = "remote"` | 表格、表单、文案、轻交互 |
| 业务插件 | 云插件包更新 + sha256 | SDK、任务逻辑、功能实现 |
| 页面注入 | 云扩展包更新 + sha256 | 抖店页面按钮、页面辅助脚本 |
| 规则配置 | 签名 JSON | endpoint、字段映射、错误码、默认规则 |

### 8.2 不能直接满足点

当前 Tianshe open edition 中：

- `cloudAuth` 被关闭。
- `cloudPlugin` preload API 被删除。
- `cloudBrowserExtension` preload API 被删除。
- 云扩展 catalog 下载入口也被删除。

所以要实现线上更新，必须做一项白牌改造：

1. 新增私有 edition，例如 `edition/white-label`。
2. 实现自己的云插件 provider。
3. 恢复或替换 preload 中的 cloud plugin/extension API。
4. 云端提供插件/扩展 catalog。
5. 客户端校验 sha256 和签名后安装。

### 8.3 推荐更新安全模型

建议要求：

- 只允许官方域名下载。
- 每个包有 `version`、`sha256`、`signature`。
- 支持灰度、回滚、最低客户端版本。
- 插件 manifest `id` 固定，禁止线上包改成任意 ID。
- 远程 UI 只能调用已暴露的插件 API，不能直接获得 Node 能力。
- 业务插件更新后保留旧版本备份，失败自动回滚。

如果确实要实现“小尊宝式远程 JS eval”，也应加限制：

- 远程 JS 必须签名。
- 在隔离上下文执行。
- 禁止 Node/Electron 主进程权限。
- 禁止任意文件读写。
- 记录版本、来源、执行时间。

从长期维护看，更推荐“签名插件包 + 签名规则配置”，而不是 eval。

---

## 9. 建议目录结构

如果以 Tianshe 插件方式落地：

```text
plugins/
  doudian_core/
    manifest.json
    dist/
      index.cjs
    src/
      index.ts
      sdk/
        account.ts
        login-verifier.ts
        doudian-http-client.ts
        origin-session.ts
        retry-policy.ts
      services/
        goods.service.ts
        order.service.ts
        analysis.service.ts
        financial.service.ts
        violation.service.ts
        coupon.service.ts
        limitsales.service.ts
        new-gift.service.ts
        business-chance.service.ts
        freight.service.ts
      engines/
        goods-batch-engine.ts
        title-rewrite-engine.ts
        price-rule-engine.ts
        stale-goods-engine.ts
      tables.ts
      api.ts

  doudian_toolbox/
    manifest.json
    pages/
      toolbox/
        index.html
        assets/
    src/
      App.tsx
      routes/
        ShopList.tsx
        Analysis.tsx
        Financial.tsx
        Violation.tsx
        OnSale.tsx
        TimeLimits.tsx
        NewGiftMoney.tsx
        Coupons.tsx
        BusinessCenterSubmit.tsx
        ClearNoSales.tsx
        BatchListing.tsx
        BatchDelete.tsx
        TalentShowEdit.tsx
        BatchEditTitle.tsx
        BatchEditPrice.tsx
        FreightTemplate.tsx

extension-packages/
  doudian_page_extension/
    manifest.json
    content-scripts/
      fxg.js
      compass.js
```

如果团队希望更深地内置到 Tianshe `src`，也建议仍保持类似边界：

```text
src/
  doudian/
    sdk/
    services/
    engines/
    ui/
```

但从后期线上更新角度看，插件方式更适合。

---

## 10. 插件 manifest 示例

### doudian_core

```json
{
  "id": "doudian_core",
  "name": "抖店核心服务",
  "version": "1.0.0",
  "author": "white-label",
  "main": "dist/index.cjs",
  "category": "business",
  "trustModel": "first_party",
  "permissions": [
    "account",
    "profile",
    "network",
    "database",
    "taskQueue",
    "scheduler",
    "storage"
  ],
  "dataTables": [
    {
      "name": "doudian_shops",
      "description": "抖店店铺扩展信息"
    },
    {
      "name": "doudian_jobs",
      "description": "抖店任务"
    },
    {
      "name": "doudian_job_items",
      "description": "抖店任务明细"
    },
    {
      "name": "doudian_failures",
      "description": "抖店失败列表"
    }
  ]
}
```

### doudian_toolbox

```json
{
  "id": "doudian_toolbox",
  "name": "小尊宝工具箱",
  "version": "1.0.0",
  "author": "white-label",
  "main": "dist/index.cjs",
  "category": "toolbox",
  "trustModel": "first_party",
  "contributes": {
    "activityBarView": {
      "id": "doudian_toolbox_view",
      "title": "工具箱",
      "icon": "Store",
      "enabled": true,
      "order": 1,
      "source": {
        "type": "local",
        "path": "pages/toolbox/index.html"
      },
      "lifecycle": "keep-alive"
    }
  }
}
```

后续线上 UI 更新时可改为：

```json
{
  "source": {
    "type": "remote",
    "url": "https://your-domain.example.com/doudian-toolbox/index.html"
  }
}
```

---

## 11. 关键缺口清单

| 缺口 | 严重程度 | 说明 | 解决方案 |
|---|---:|---|---|
| 抖店登录检测 | 高 | 没有它所有功能都不可靠 | 新增 `DoudianLoginVerifier` |
| 浏览器会话内 HTTP | 高 | 平台接口需要 Cookie/签名/风控上下文 | 新增 `DoudianHttpClient` |
| 云插件更新在 open edition 关闭 | 高 | 不能直接线上更新 JS | 新增白牌 edition/云更新服务 |
| 云扩展更新入口被关闭 | 高 | 不能直接更新页面注入脚本 | 启用 ExtensionPackages 云 catalog |
| 小尊宝 safe2 中转能力缺失 | 中高 | 清理滞销/导出可能依赖 | 自建下载/转换服务或浏览器下载替代 |
| 抖店接口 schema 未固化 | 中高 | 平台字段经常变 | endpoint/字段映射线上配置 |
| 验证码/滑块自动处理 | 中 | 框架不能自动解 | 人工接管 + 状态识别 |
| 店铺套餐/授权模型 | 中 | Tianshe Account 没有 | 插件自建授权表 |
| 批量高风险操作审计 | 中 | 改价/删除/违规处理风险大 | 强制预览、确认、日志 |
| 页面注入安全 | 中 | 远程 JS 权限过大风险 | 签名扩展包，不做任意 eval |

---

## 12. 开发阶段规划

### 阶段 0：白牌壳整理

- 配置 `tianshe-shell.config.json`。
- 设置应用名、图标、默认插件。
- 决定是否保留内置 Account Center。

交付物：

- 可启动的白牌空壳。
- 默认进入工具箱首页。

### 阶段 1：账户与登录

- 初始化抖店/罗盘 SavedSite。
- 实现 Profile + Account 创建。
- 实现登录弹窗。
- 实现登录态检测。
- 同步 `shopId/shopName`。
- 建 `doudian_shops`。

交付物：

- 店铺管理可用。
- 多店铺隔离登录可用。

### 阶段 2：核心 SDK

- `DoudianHttpClient`。
- origin 切换。
- retry/backoff。
- 错误标准化。
- 任务队列封装。
- 失败列表和日志。

交付物：

- 可以稳定调用抖店/罗盘接口。
- 后续功能只写业务 service。

### 阶段 3：商品批量核心

- `GoodsBatchEngine`。
- 商品列表/详情/预览。
- Excel 导入导出。
- 批量上下架。
- 批量删除。
- 批量改标题。
- 批量改价。
- 达人秀修改。
- 运费模板。

交付物：

- 六个商品批量功能可用。

### 阶段 4：数据类功能

- 经营数据。
- 资金数据。
- 售中管理。
- 违规管理。

交付物：

- 数据采集、聚合、导出可用。

### 阶段 5：营销与商机

- 限时限量购。
- 新人礼金。
- 通用优惠券。
- 商机提报。
- 清理滞销。

交付物：

- 营销类和运营类功能可用。

### 阶段 6：线上更新

- 私有 cloud plugin provider。
- 插件包 catalog。
- 扩展包 catalog。
- sha256/signature 校验。
- 灰度和回滚。
- 远程 UI 页面域名白名单。

交付物：

- 核心业务 JS 可线上升级。
- 页面注入脚本可线上升级。
- UI 可线上更新。

### 阶段 7：真实账号回归

- 每个功能至少 2-3 个真实店铺测试。
- 低权限/未订购/验证码/频繁/接口异常测试。
- 批量改价、删除、违规处理做高风险回归。
- 更新失败回滚测试。

---

## 13. 最终建议

Tianshe 适合做小尊宝白牌重写，但重写时不要把它当“远程网页容器”，而要把它当“多店铺浏览器会话 + 插件运行时 + 本地任务引擎”。

优先落地顺序应该是：

1. 账户登录和 Profile 隔离。
2. 抖店会话 HTTP SDK。
3. 商品批量核心引擎。
4. 店铺管理和六个商品批量功能。
5. 数据/营销/商机功能。
6. 云插件与扩展更新。

最需要提前确认的不是 UI，而是：

- 当前抖店接口是否仍能在浏览器上下文稳定调用。
- 罗盘数据是否能同 Profile 登录态访问。
- 清理滞销是否必须依赖类似 `safe2.zzbtool.com/transV2` 的后端中转。
- 白牌版本是否允许启用云插件/云扩展更新入口。

如果这四点确认可行，Tianshe 框架基本可以覆盖小尊宝的主体能力，并且账户隔离、任务队列、插件化更新会比原始小尊宝结构更清晰、更容易维护。
