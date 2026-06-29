# Tianshe 大模型手架构 v4（唯一真实版）

> 本文替代 `zg.md`、`zg.v2.md`、`zg.v3.md`、`zg-runtime-choice.md`。
>
> 本版不再为了兼容旧草案和旧数据迁就概念，唯一目标是：从“最适合大模型当手”的角度，定义 Tianshe 的真实架构边界。
>
> 本文只保留架构原则、边界和判断标准。代码现状、任务优先级、runtime capability matrix、MCP public surface、repairScope allow/deny 等容易漂移的事实，应以代码、测试或生成快照为准，不在本文手抄成第二套真相源。

---

## 一、核心结论

Tianshe 不应该把 Playwright 直接暴露成 agent 默认手。

正确定位是：

```text
Playwright 是 Lab 和部分 Runtime 的实现手段，
不是 agent-facing 自动化协议本身。
```

大模型真正应该面对的是：

```text
Capability
  -> 登录态 / Profile / Runtime / Site Adapter / Dataset / Trace / Failure Bundle
```

而不是：

```text
page.goto / page.locator / page.evaluate / page.click
```

原因很简单：直接让大模型用 Playwright，会绕过框架最有价值的资产：

- profile 托管
- 登录态健康
- runtime 能力判断
- 本地数据
- trace / artifacts
- failure bundle
- repairScope
- Extractor diagnostics
- capability schema
- scope / auth / destructive confirmation

所以 v4 的主线是：

```text
Agent 调用 Capability。
Capability 拥有业务闭环。
Site Adapter 是固定站点代码。
Extractor 只负责读。
Interactor / Procedure 负责写动作。
Playwright 主要用于调试台和可选 runtime 后端。
```

---

## 二、三种“模型用浏览器”的场景必须分开

### 2.1 Agent 执行业务能力

这是产品主路径。

Agent 应该调用：

```text
1688.extract_product        # 业务站点能力：<site>.<action> 命名空间
profile_ensure_logged_in    # 框架自带能力/工具：下划线
dataset_query
system_bootstrap
observation_get_failure_bundle
```

> 命名约定：业务/站点能力用 `<site>.<action>` 命名空间（如 `1688.extract_product`）；框架自带的能力与 MCP 工具用下划线（如 `system_bootstrap`）。真实名以代码/工具清单为准，本文不另立一套。

Agent 不应该自己写：

```text
page.locator(...)
page.evaluate(...)
page.waitForSelector(...)
```

在这一层，模型关注的是某个能力接口，而不是浏览器技术细节。

### 2.2 Browser hand 作为 fallback

当还没有对应 Capability，或者需要人工探索时，agent 可以使用受限浏览器工具：

```text
session_prepare
browser_observe
browser_search
browser_act
browser_wait_for
browser_debug_state
observation_get_failure_bundle
```

这些工具的目标不是复刻 Playwright，而是提供模型友好的闭环：

```text
观察 -> 选择 ref -> 动作 -> 验证 -> 失败证据
```

默认仍不应该给模型 raw Playwright。

### 2.3 Extractor 调试 / 修复

这是 Lab 场景。

Lab 可以用 Playwright，而且非常适合用 Playwright。因为调试需要：

- 打开目标页面
- 快速试 selector
- 查看 DOM
- 查看 network
- 截图
- 验证字段命中
- 生成 fixture
- 跑 extractor
- 对比 expected

但 Lab 产物不能是 Playwright 脚本。

Lab 产物应该是：

```text
Extractor 代码或声明
fixture HTML
expected output
selectorHits
pageFingerprint
repair diff
```

---

## 三、最终分层

```text
Agent / MCP / Workflow / Plugin UI
        |
        v
Capability（唯一业务调用单位）
        |
        +-- profile.ensure_logged_in(site)
        +-- runtime plan / acquire
        +-- browser observe / navigate / wait
        +-- site_adapter_run
        +-- interactor_run（如需要）
        +-- extractor_run
        +-- schema validate
        +-- dataset write / artifact write
        +-- trace / failure bundle
        |
        v
Site Adapter（固定站点代码，页面易变层）
        +-- Interactor / Procedure（受限动作 -> action diagnostics）
        +-- Extractor（只读证据 -> fields + diagnostics）
        +-- Verifier（只读证据 -> state / pass / fail）
        |
        v
Site Adapter Runner
        +-- fixture runner（jsdom / happy-dom）
        +-- browser evaluate runner（任意 BrowserInterface）
        +-- Playwright lab runner（调试 / 修复）
        |
        v
Browser Runtime
        +-- chromium-extension-relay
        +-- chromium-cloak-playwright
        +-- electron-webcontents
        +-- firefox-bidi
```

关键点：

- Capability 是业务入口。
- Site Adapter 是页面易变层。
- Extractor 是 Site Adapter 里负责读的部分。
- Interactor / Procedure 是 Site Adapter 里负责写动作的部分。
- Runner 是执行 Site Adapter 的方式。
- Runtime 是浏览器实现。
- Playwright 只是某些 Runner/Runtime 的实现，不是顶层协议。

---

## 四、Capability 的边界

Capability 是 agent 默认应该调用的东西。

一个网页型 Capability 的目标骨架：

```text
输入参数校验
  -> 解析 profile / site / account
  -> ensure_logged_in
  -> 选择 runtime
  -> 打开页面 / 等待页面稳定
  -> 运行 Interactor / Procedure（如需要写动作）
  -> 运行 Extractor / Verifier
  -> 校验 output schema
  -> normalize
  -> 写 dataset / artifact
  -> 记录 trace / provenance
  -> 返回结构化结果
```

Capability 可以内部用 Playwright runtime，也可以不用。

Capability 不应该：

- 暴露 browser handle 给模型
- 让模型写 Playwright 代码
- 把 selector / action flow 修复逻辑混进业务 Core
- 让 Site Adapter 选择 profile/runtime
- 让 Site Adapter 处理登录凭据、验证码、2FA
- 让 Extractor 写 dataset
- 让 Site Adapter 读本地文件、secrets、Node API

Capability 必须拥有：

```text
name
version
inputSchema
outputSchema
requiredScopes
requires
idempotent
retryPolicy
sideEffectLevel
assistantGuidance
assistantSurface
```

现有代码已有 `OrchestrationCapabilityDefinition`、`CapabilityHandler`、`createUnifiedCapabilityCatalog()`、`createOrchestrationExecutor()`，不要再新增一套 Node Runtime。

---

## 五、Site Adapter 的边界

前面只说 Extractor 不够准确。页面变化不只影响“读字段”，也会影响“写动作”：按钮选择器、输入框、提交步骤、等待条件、验证点都会变。

所以 v4 的页面易变层应该叫：

```text
Site Adapter = Extractor + Interactor / Procedure + Verifier
```

Site Adapter 是固定站点代码，不是 agent 临场脚本。

### 5.1 Extractor：读证据

Extractor 定义：

```text
Extractor = readonly evidence -> fields + diagnostics
```

Extractor 允许读取：

- 读 DOM
- 读 location
- 读 meta/script/img 属性
- 读 runner 提供的 readonly network artifacts
- 读 runner 提供的 readonly OCR / visual text artifacts
- 做 selector fallback
- 做字段清洗
- 产出 diagnostics

Extractor 禁止：

- 访问 ctx
- 访问 Node API
- 访问本地文件
- 访问 secrets
- 发网络请求
- 写 dataset
- 写 artifact
- 修改 profile
- 依赖 Playwright page/context API

Extractor 必须返回：

```text
fields
missingFields
selectorHits
confidence
extractorVersion
runner
pageFingerprint
warnings
```

`selectorHits` 是自愈闭环的关键字段。它告诉模型：

```text
哪个业务字段失败
哪个 selector 没命中
哪个 fallback 命中了
哪个字段置信度不足
```

### 5.2 Interactor / Procedure：写动作

Interactor / Procedure 定义：

```text
Interactor = intent + browser state -> constrained browser actions + action diagnostics
```

它解决的问题是：页面写动作也会随站点变化。

允许：

- click / type / select / scroll / press 等受限动作
- 等待明确的页面状态
- 使用 `BrowserInterface` 的统一动作能力
- 记录 action steps、selectorHits、before/after URL、verification result
- 返回 `needs_manual_handoff`、`blocked`、`captcha_detected` 等状态

禁止：

- 直接使用 Playwright page/context API
- 自己选择 profile/runtime
- 读取或 reveal secrets/password/cookie value
- 绕过验证码、2FA、风控
- 发起任意网络请求或控制 network intercept
- 写 dataset / artifact / profile
- 调用 Node/Electron/main-process API
- 做无限循环式探索

Interactor 的动作必须是 Capability 授权下的动作。Capability 决定任务意图、sideEffectLevel、确认策略、登录态、runtime plan；Interactor 只负责站点页面内的受限动作细节。

### 5.3 Verifier：验证状态

Verifier 定义：

```text
Verifier = readonly evidence -> state / pass / fail + diagnostics
```

它用于确认：

- 表单是否提交成功
- 商品是否已加入列表
- 登录是否已完成
- 页面是否进入预期状态
- 写动作是否产生了预期效果

Verifier 只读，不写。

### 5.4 Extractor 同时用于功能运行和自愈

Extractor 不应只存在于自愈阶段。它在两个阶段都要用，但职责不同。

功能运行阶段：

- Capability 调用 Site Adapter Runner。
- Runner 使用 Extractor 读取页面事实，产出 `fields`、`missingFields`、`confidence`、`selectorHits`、`pageFingerprint`。
- Capability 根据这些结构化结果决定是否写 dataset、生成 artifact、继续下一步或进入人工接管。
- Extractor 的输出同时成为 provenance，说明数据来自哪个页面、哪个 adapter 版本、哪些 selector 命中。

自愈阶段：

- 当功能运行失败或置信度不足时，Runner 把 Extractor / Interactor / Verifier 的 diagnostics 打成 repair bundle。
- repair bundle 给模型看的不是“请随便操作浏览器”，而是字段缺失、selector 命中、页面指纹、action trace、验证失败点。
- 模型修的是站点 adapter、fixture、expected output；不是临场绕过 Capability，也不是改框架 core。

所以 Extractor 是运行路径里的读证据组件，也是自愈路径里的证据来源。它不是一次性的调试脚本。

### 5.5 连续 DOM 操作和状态

有连续性的 DOM 操作不应该交给 Extractor。Extractor 保持只读；连续写流程交给 Interactor / Procedure。

严格说，当前代码还没有一个可直接使用的 Site Adapter Runner，所以不能说“现在已经能胜任”。更准确的结论是：现有 BrowserInterface、browser_act、session binding、observation 基础足以承载这类实现，但必须新增状态化 Site Adapter Runner 后才算真的能胜任。

Site Adapter 要胜任这类流程，前提是它按“受限状态机”设计，而不是按自由脚本设计：

```text
Capability Run
  -> Site Adapter Runner
    -> Procedure State
    -> Interactor Step
    -> Extractor / Verifier Evidence
    -> Next Procedure State
```

Procedure State 是本次运行的状态，必须可序列化、可回放、可诊断。它可以包含：

- `currentStep`
- `pageState`
- `cursor` / `pagination`
- `seenKeys`
- `retryCount`
- `lastAction`
- `evidenceRefs`
- `actionTrace`
- `collectedFields`

它不能包含：

- Playwright `page` / `context` / `browser` handle
- Electron / Node 对象
- cookie value、password、token
- 不受限制的 DOM 快照缓存
- 隐藏全局变量里的流程状态

连续流程的标准循环应该是：

```text
observe / extract
  -> decide next step
  -> act through BrowserInterface
  -> verify
  -> record transition
  -> continue / finish / handoff
```

适合放进 Procedure 的例子：

- 分页 / 无限滚动采集
- 多步骤表单填写
- 搜索条件组合和结果验证
- 加入清单、加入购物车、提交前确认
- 登录状态检测后的人工接管入口

不适合放进 Procedure 的例子：

- 绕过验证码、2FA、风控
- 在 adapter 内直接决定 profile/runtime
- 用 Playwright API 做站点专属捷径
- 长时间无边界探索页面

因此，Site Adapter 不是只有读字段能力。它应该覆盖站点页面内“可约束、可验证、可回放”的读写流程；Extractor 负责读，Interactor / Procedure 负责写，Verifier 负责确认结果。

### 5.6 现状判断的文档边界

本文只定义 Site Adapter 应该承担什么边界，不手抄当前代码里哪些文件已经存在、哪些能力已经完成。

当前实现状态、证据、整改任务和验收标准，以 `docs/zg.v4-implementation-gap-analysis.zh-CN.md`、代码、测试、生成快照和 release gate 证据为准。这里保留一条架构判断：

```text
Site Adapter 是正确方向，但不能被描述成已经完成的能力。
```

任何文档、guidance 或任务描述都不能让模型误以为：

- Site Adapter Runner 已经是可用产品能力。
- repairScope 已经真实 enforce。
- Runtime descriptor 已经是完整单一真相源。
- 写动作自愈与只读 Extractor 自愈拥有相同验证强度。

这些状态一律由当前 gap analysis、测试、生成快照和 release gate 证据证明。

---

## 六、调试和执行必须分离

### 6.1 调试 Site Adapter

调试可以用 Playwright。

推荐形态：

```text
Site Adapter Lab = 用 Playwright 驱动的站点适配调试台
```

它负责：

- 打开真实页面
- 抓 DOM / screenshot / network
- 试 selector
- 生成 fixture
- 跑 interactor / extractor / verifier
- 展示 selectorHits
- 展示 actionTrace / step diagnostics
- 生成 repair bundle
- 接收模型修复 diff

### 6.2 执行 Site Adapter

执行不等于 Playwright。

执行应该走统一 Runner 接口：

```text
SiteAdapterRunner.run(adapter, evidenceOrBrowserHandle, options)
```

至少需要三类 Runner：

| Runner | 用途 | 是否面向 agent |
| --- | --- | --- |
| fixture runner | 本地 fixture / regression | 否 |
| browser evaluate runner | 生产执行，基于当前 BrowserInterface | 否 |
| Playwright lab runner | 调试 / repair / fixture capture | 否 |

Agent 不直接调用这些 Runner。Agent 调用 Capability。

### 6.3 调试和执行不一致的风险

如果 Lab 用 Playwright，而生产执行用 extension/electron/cloak，需要防止环境漂移：

- selector 在 Playwright 下命中，electron 下不命中
- action flow 在 Playwright 下能点，生产 runtime 下坐标/焦点/输入行为不同
- iframe / shadow DOM 行为不同
- 页面因 runtime 指纹差异返回不同 DOM
- network 时序不同
- 风控页和正常页不一致

解决方式：

- Extractor 只依赖标准 DOM
- Interactor 只依赖统一 BrowserInterface 动作能力
- fixture runner 只负责静态回归，不能证明 runtime 漂移已被消除
- 目标生产 runner / canary 必过，才能证明生产 runtime 下的真实语义成立
- Playwright Lab 只能帮助修复，不能作为唯一验收

---

## 七、Runtime 的 v4 定位

v4 不再争论“哪个 runtime 是唯一标准”。

按模型手的目标重新定位：

| Runtime | v4 定位 |
| --- | --- |
| chromium-extension-relay | 真实 Chrome 会话、当前页、登录接管、接口 JSON、responseBody |
| chromium-cloak-playwright | 强风控、Playwright 调试心智、cloak 指纹、Lab 主要后端之一 |
| electron-webcontents | 应用内界面 + 离屏渲染/OCR/PDF + **持久登录的隐藏模式浏览器**（见 §8.1） |
| firefox-bidi | niche / 验证 / 特定站点兼容 |

如果完全不考虑旧兼容，agent-hand 的主力 runtime 可以更偏向 Playwright/Cloak。但这不代表直接暴露 Playwright 给 agent。

正确表达：

```text
Playwright-powered, framework-owned, MCP-constrained browser hand.
```

中文：

```text
由 Playwright 能力加持，但由 Tianshe 框架拥有，并通过 MCP 受限协议暴露的大模型浏览器手。
```

---

## 八、登录态托管

Profile 是账号、指纹、代理、runtime 绑定的承载物。

但账号资料不等于登录态健康。

必须新增目标能力：

```text
profile.ensure_logged_in(site, profileId?)
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

原则：

- 交互式登录、验证码、短信、2FA 必须人在环。
- 不做全自动凭据登录。
- 不绕验证码。
- 不绕风控。
- 模型可以请求打开可见浏览器，但人负责敏感登录步骤。

目标流程：

```text
Capability 请求登录态
  -> 检查 site/profile 最近登录健康
  -> 已登录：继续
  -> 未登录/过期：打开可见 runtime
  -> 用户接管登录
  -> 框架记录 verifiedAt / status / evidence
  -> Capability 继续执行
```

### 8.1 electron-webcontents 也必须能承载持久登录

electron 不只是"界面 + 离屏渲染"，它也应当是一个**带持久登录的隐藏模式浏览器**。原则：

- 登录承载 runtime 由框架按客观条件判定——存储是否持久、能否隔离指纹/代理、能否被人工接管登录——而不是按 runtime 名字预设。electron 满足这些条件就应被当作登录承载 runtime。
- runtime descriptor 的标注（持久/临时等）必须与它真实的存储和生命周期语义一致。标注与实现不符时，优先纠正标注与生命周期口径，而不是改存储或绕过。
- 人工登录接管在 embedded-view 形态下通过显示视图完成；登录态健康由 §8 的 login state 托管，与 runtime 名字无关。
- 输入能力较弱的 runtime（如只支持 DOM 级输入）在登录场景要有兜底或显式降级提示。

（electron 当前的持久/临时语义偏差、以及具体纠正项属于代码现状，见当前 gap analysis，不在此手抄。）

### 8.2 人与 agent 共用同一 profile

目标：人能像指纹多开浏览器一样用 profile，agent 又能在同一个已登录 profile 上调用 Capability，**登录只有一份**。原则：

- 共享的是同一个 profile 的同一份登录仓，不是把登录在 runtime 间搬家（登录态按 profile + runtime 隔离，见 §7、§8）。
- 同一 profile 任意时刻只有一个 active controller；人和 agent 通过**接管**轮流，而不是并发写同一浏览器。
- 接管必须区分控制者类型并带优先级：人在用时 agent 不应无条件抢占，而应请求接管；接管要可通知、可暂停被接管方、可超时回收。
- 目标语义是**保活式接管**——交出控制权但不销毁浏览器、不丢登录。

（共享登录仓、租约与接管的底层机制现状，以及"当前是 agent 无条件抢占人"这一缺口，属于代码现状，见当前 gap analysis，不在此手抄。）

---

## 九、Agent 工具面

默认 agent-facing MCP 应该小而强。

### 9.1 默认工具

```text
system_bootstrap
profile_list
profile_resolve
profile_ensure_logged_in
session_prepare
browser_observe
browser_search
browser_act
browser_wait_for
browser_debug_state
observation_get_trace_summary
observation_get_failure_bundle
dataset_query
```

业务成熟后，agent 更应该调用：

```text
1688.extract_product
douyin.extract_order
shop.export_products
```

而不是通用 browser 工具。

### 9.2 Lab / Repair 工具

这些工具只在 dev / repair / lab 模式开放：

```text
browser_evaluate
browser_network_entries
browser_validate_selector
browser_screenshot
site_adapter_debug
interactor_debug
extractor_debug
extractor_fixture_capture
extractor_fixture_run
repair_apply_patch
```

不要把 Lab 工具混进默认 agent surface。

否则模型会退回写脚本模式。

---

## 十、自愈闭环

目标闭环：

```text
Capability 执行失败
  -> 生成 Failure Bundle
  -> 判断是否为 Site Adapter 失败
  -> 生成 Site Adapter Repair Bundle
  -> 模型只看到 adapter 子目录 + fixture + schema + failure evidence
  -> 模型修改 extractor / interactor / verifier / fixture
  -> repairScope 校验写盘
  -> fixture runner
  -> production runner smoke
  -> schema validate
  -> regression
  -> 人工审核
  -> 发布 site adapter 新版本
```

Repair Bundle 的权威字段不写在本文。它必须由 `src/core/site-adapter-runtime` 的 schema / tests / generated snapshot 生成和校验。

本文只规定模型修复时必须看到的证据类别：

- 哪个 capability / site / adapter / step 失败。
- 页面输入证据：URL、runtime/profile 语境、snapshot、screenshot、必要的脱敏 network/console 摘要。
- 只读抽取证据：字段命中、缺失字段、selector diagnostics、fixture、expected output。
- 写动作证据：action trace、state transition、verification result、side effect level。
- 修复边界：允许修改的 adapter 文件、禁止修改的 framework/core 文件、输出 schema。

如果某个字段是否存在会影响执行，答案不在本文找，而在 schema、测试和生成快照里找。

---

## 十一、repairScope

repairScope 是强制写闸，不是文档声明，也不是提示词约定。

本文不维护 allow/deny 路径清单。权威定义必须在代码中的 repair-scope contract 和测试里，文档只声明原则：

- 允许模型修站点 adapter 产物。
- 禁止模型修框架 core。
- 禁止模型修 capability core、main process、types、secrets、schema 权威源。
- 任何 allow/deny 改动必须经过路径穿越测试和 forbidden path 测试。
- 示例站点、官方站点、插件站点必须由各自 manifest 明确声明 repairScope，不能靠全局通配猜测。

强制要求：

- 写盘前路径校验
- forbiddenFiles 拒绝
- diff 审核
- fixture 必过，作为静态回归门禁
- 目标生产 runner / canary 必过，作为 runtime 语义门禁
- regression 必过
- Capability Core 不可被模型修改
- schema 不可被模型随意修改

没有 repairScope，就不能说“大模型只能修站点适配层”。

---

## 十二、本地数据和 provenance

让框架成为大模型的手，数据必须能追溯。

每次 Capability 写入 dataset，都应该能追溯到几类证据：

- 来源能力与版本（哪个 capability / extractor、什么版本）
- 运行环境（runtime、profile、account）
- 来源页面（source URL、page fingerprint）
- 追溯锚点（traceId、artifact 引用、capturedAt）
- 数据质量（confidence）
- schema 版本

具体字段以 dataset provenance 的 schema / 生成快照为准，本文不手抄字段列表（避免变成第二套真相源）。

否则数据错了之后无法判断：

- 是页面变了
- 是账号状态变了
- 是 runtime 变了
- 是 Extractor 坏了
- 是模型误操作
- 是写入逻辑错了

---

## 十三、HTTP/MCP 安全口径

如果让模型拥有“手”，本地端点的授权边界就不是附属问题。

目标要求：

- AI-hand 模式必须启用 token auth 或等价本地信任机制。
- destructive capability 必须有显式确认。
- dataset/profile/plugin/browser scopes 必须可审计。
- 默认 agent surface 不暴露 raw evaluate / raw file write / raw Playwright。
- failure bundle 和 trace 不应泄露 secrets、cookies、密码、token。

这不是传统安全审计的后置项，而是模型手架构的一部分。

---

## 十四、实施状态与路线的权威来源

本文不维护实现状态、任务优先级、任务 ID 或能力矩阵。

这些内容的权威来源是：

- 当前代码和测试。
- 由代码生成的 capability matrix / MCP surface / repairScope 快照（本地/CI artifact）。
- `docs/zg.v4-implementation-gap-analysis.zh-CN.md` 中的缺口优先级、完成标记和验收清单。
- `docs/evidence/README.md` 固定的 release gate / browser canary artifact 入口。

因此，本文不再列“当前已有 / 当前未完成 / 阶段路线明细”。只保留架构原则，防止同一事实在两份 Markdown 里重复维护。

---

## 十五、v4 最终原则

1. Agent 调 Capability，不写 Playwright。
2. Playwright 是 Lab/Runtime 实现，不是 agent-facing contract。
3. 调试 Site Adapter 和执行 Site Adapter 分离。
4. Site Adapter 是固定站点代码，不是临场脚本。
5. Extractor 只读，Interactor/Procedure 才负责受限写动作。
6. Capability Core 不给模型改。
7. 登录态人在环，框架托管状态。
8. Runtime 是实现细节，按任务选择。
9. Failure Bundle 必须能转成 Repair Bundle。
10. repairScope 必须真执行。
11. 本地数据必须带 provenance。

一句话：

```text
Tianshe 的价值不是替代 Playwright，
而是把 Playwright 等浏览器能力收进 profile、capability、site adapter、dataset、trace 和 repairScope 的框架闭环里，
让大模型调用稳定能力，而不是临场写浏览器脚本。
```
