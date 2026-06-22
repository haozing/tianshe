# Tianshe v4 地基整改计划

> 目标：为了真正实现 `docs/zg.v4.md`，先把现有框架里不够硬的基础层补齐，再新增业务 Capability、Site Adapter Lab 或自愈能力。
>
> 本文基于当前代码调研，重点回答三个问题：
>
> 1. 哪些地方已经能复用。
> 2. 哪些地方必须修补、重构、删除。
> 3. 怎样验收，才能证明框架真的更适合大模型当“手”。

---

## 0. 总结结论

`zg.v4.md` 的方案逻辑是对的：Agent 不应该直接面对 Playwright，而应该面对 Capability；Playwright 可以是 Lab 和部分 Runtime 的实现手段；Extractor 调试和生产执行必须分离；登录态、数据、观测、修复都要进入框架闭环。

但当前代码还没有把这些原则完全变成硬约束。现在最大的问题不是“缺一个新功能”，而是几个基础契约还不够统一：

- 浏览器 runtime 能力描述、接口方法、MCP 工具 requirements、实际行为测试还不是一个单一真相源。
- Profile / Session / Runtime 绑定已经有基础，但还没有“登录态健康”这个一等状态，也没有 `profile.ensure_logged_in` 这样的托管能力。
- Site Adapter 目前还只是方案文档和空 PoC 目录，没有一等包、Interactor/Extractor/Verifier、Runner、诊断 schema、fixture gate、repairScope 写闸。
- Failure Bundle 已有浏览器证据基础，但还没有升级成 Site Adapter Repair Bundle。
- Dataset 能写数据，但缺少面向网页抽取的 provenance / run ledger。
- MCP/HTTP 已有鉴权和 scope 框架，但默认兼容口径偏松，不足以作为 agent-hand 的安全默认值。
- 可见窗口、交互健康、远程人工接管还没有进入统一 runtime 能力契约；这会直接影响登录、验证码、扩展弹窗、钱包插件等场景。
- Agent guidance 虽然已经提示优先使用 Airpa MCP，但缺少 golden transcript / regression 来防止模型继续回退到 generic Playwright。

所以 v4 的第一阶段不要继续扩概念，但“最小闭环”必须名实相符。它不只是“模型不再绕回 Playwright、修复不再越权、能力描述不再撒谎”，还包括 v4 的核心价值：**人能像指纹多开一样用 profile、agent 能共用同一份登录**。后者是登录/身份地基，是模型默认路径的前置，不能事后补。所以 P0 包含两条相互咬合的链：

```text
默认路径链：
Agent Surface / Scope Golden
  -> Runtime Descriptor Promotion Gate
  -> Read-only Site Adapter Runtime
  -> Fixture Runner + Browser Canary
  -> repairScope Path Gate
  -> Minimal Repair Evidence

登录/身份链：
Login State 模型
  -> profile.ensure_logged_in（含可见人工登录接管）
  -> electron 持久登录语义纠正
  -> 人/agent 共享同一 profile 的接管策略
```

登录链只做“最小可用”：login state + `ensure_logged_in` + 可见人工登录 + 共享接管策略，运行时选择复用现有 profile→runtime 绑定（不依赖完整 planner）。

状态化写动作（Interactor/Procedure 状态机）、完整 runtime planner、dataset run ledger、完整 window/remote-control contract、schema parity、生命周期治理仍然重要；但它们不再伪装成 P0。除非阻塞上面两条链，否则进入 P1。

### 0.1 原则澄清：不为兼容旧草案和旧数据让路

本计划遵循 `docs/zg.v4.md` 的原则：开发阶段不为了兼容旧草案、旧目录、旧数据形态而迁就架构。

具体含义：

- 可以删除或替换空 PoC、误导性目录和过期文档入口。
- 可以改 capability/tool/runtime 的命名和边界，不为旧名字保留双轨实现。
- 不为旧 dataset/account/profile 形态设计复杂迁移路线，除非它阻塞当前开发验证。
- 不为了兼容历史 plugin/helper 行为，把 v4 的 agent-hand 默认面继续暴露 raw evaluate、cookie value、Playwright 心智。
- runtime alias 可以作为用户输入便利存在，但不能反过来污染真实 runtime id 和能力契约。
- 如果现有代码的抽象不适合“大模型之手”，优先重构，而不是补一层兼容适配。

所以本文里的“保留”“复用”只表示这些模块可以作为实现材料，不表示保留旧行为或旧数据兼容承诺。

### 0.2 二次代码核验：Site Adapter 不是现成能力

针对“Site Adapter 是否真的能承载连续、有状态 DOM 操作”做过二次代码核验，结论如下：

```text
当前不能直接胜任。
但现有浏览器/会话/能力/观测底座足以支撑实现。
```

已经真实存在的底座：

- `src/types/browser-interface.ts`：已有 `goto`、`snapshot`、`search`、`evaluate`、`evaluateWithArgs`、`click`、`type`、`select`、`waitForSelector`，以及 network/intercept/dialog/tab/storage 等可选 capability。
- `src/core/ai-dev/capabilities/browser/handlers/workflow.ts`：`browser_act` 已能做单步 `click` / `type` / `press`，并返回 verification、before/after URL、effect signals、attempts。
- `src/core/ai-dev/capabilities/browser/handlers/action-verification.ts`：已有 `PageFingerprint`、action verification、wait target、DOM changed / URL changed / click event 等验证信号。
- `src/main/mcp-http-session-runtime.ts`：已有 MCP session 的 profile/runtime/visible/scopes 准备、binding lock、browser handle 复用。
- `src/core/browser-pool/runtime-capability-registry.ts`：已有 Electron、Extension、Firefox、Cloak 的 runtime capability 描述，但能力并不完全一致。
- `src/core/observability/browser-failure-bundle.ts`：已有失败时收集 snapshot、console tail、network summary、screenshot、error context 的基础。

仍然不存在的关键件：

- `src/core/site-adapter-runtime/` 一等包不存在。
- `src/core/node-extractor-poc/` 只有空子目录（`extractors/`、`fixtures/`），无实现文件，不能代表 v4 Extractor。
- Site Adapter manifest / registry / runner / fixture runner / browser evaluate runner 不存在。
- `SiteAdapterRunState` / `ProcedureTransition` / `actionTrace` / `stateTransitions` 没有真实实现。
- `browser_act` 目前是 MCP/capability handler 形态，还不是 adapter 内部可复用的 Action Runner contract。
- `RuntimeArtifactType` 还没有 `site_adapter_result`、`site_adapter_failure`、`site_adapter_repair_bundle`、`interactor_action_trace`、`procedure_state_transition`。
- Dataset mutation 已有，但没有网页抽取专用 provenance/run ledger。

可用于复核浏览器底座的定向验证命令示例：

```bash
npx vitest run src/core/browser-automation/browser-runtime.cross-runtime-contract.test.ts src/core/browser-automation/browser-capability-truth.test.ts src/core/ai-dev/capabilities/browser/handlers/browser-handlers.action-verification.test.ts src/core/browser-automation/transport-backed-browser-base.test.ts
```

文档不记录某次运行的通过数量。后续应改为由 CI 或脚本生成 capability matrix / surface manifest 快照，文档引用快照而不是手写状态。

---

## 1. 当前可复用基础

这些代码不是问题，应该作为 v4 的地基继续沿用。

| 领域 | 现有基础 | 评价 |
| --- | --- | --- |
| Capability 编排 | `src/core/ai-dev/orchestration/capability-registry.ts`、`src/core/ai-dev/capabilities/unified-catalog.ts` | 已有定义、handler、中间件、trace、幂等、retry、scope 框架，不应另起一套运行时。 |
| Browser MCP 工具 | `src/core/ai-dev/capabilities/browser/**` | 已有 `browser_observe`、`browser_snapshot`、`browser_search`、`browser_act`、`browser_wait_for`、`browser_debug_state`，工具形态比 raw Playwright 更适合模型。 |
| Runtime 描述 | `src/types/browser-interface.ts`、`src/core/browser-pool/runtime-capability-registry.ts` | 已有 runtime descriptor 和 capability names，是统一能力契约的雏形。 |
| Session 绑定 | `src/main/mcp-http-session-runtime.ts` | `session_prepare`、binding lock、visible、profile/runtime session 状态已经是好的起点。 |
| Browser Pool | `src/core/browser-pool/**`、`src/main/http-browser-pool-adapter.ts` | 已经有 profile -> runtime acquire 流程，能承载登录 profile 与 runtime 的绑定。 |
| Observation | `src/core/observability/**`、`src/main/duckdb/runtime-observation-service.ts` | trace/event/artifact/failure bundle 基础已经存在。 |
| Dataset | `src/core/ai-dev/capabilities/dataset-catalog.ts`、`src/main/duckdb/dataset-*.ts` | 已有 dataset CRUD/query/import/mutation，可作为 Capability 写入目标。 |
| Profile / Account | `src/types/profile.ts`、`src/main/duckdb/profile-service.ts`、`src/main/duckdb/account-service.ts` | 已有 profile、account、runtimeId、partition、loginUrl/lastLoginAt 等字段。 |
| System Bootstrap | `src/core/ai-dev/capabilities/system-catalog.ts` | 已能把 capability/runtime 状态暴露给 agent，是后续 runtime planner 的入口之一。 |
| Assistant Surface / Guidance | `src/core/ai-dev/capabilities/assistant-guidance.ts`、`src/main/mcp-guidance-content.ts` | 已有 canonical/advanced/legacy surface 和“优先 Airpa MCP，不用 generic Playwright”的提示，但还缺少 transcript 级别回归测试。 |
| Interaction Health | `src/core/ai-dev/capabilities/browser/handlers/interaction-health.ts`、`src/main/mcp-http-session-runtime.ts` | 已有 `interactionReady`、`viewportHealth`、`hostWindowId`、`offscreenDetected` 等状态，是统一窗口/接管契约的起点。 |

---

## 2. 地基问题域

本章列出地基问题域，不等于全部都是第一阶段 P0。真正 P0 以第 11 节任务表为准：只保留“大模型默认路径”必须依赖的最小闭环。其余问题进入 P1，避免横向治理吞掉纵向闭环。

### 问题域 01：统一 Browser Runtime 能力契约

#### 代码现状

- `src/types/browser-interface.ts` 定义了 `BROWSER_CAPABILITY_NAMES` 和 `BrowserRuntimeDescriptor`。
- `src/core/browser-runtime/` 已经存在，包含 `runtime-manager.ts`、`provider-registry.ts`、`types.ts`、`index.ts`。后续 `capability-contract.ts`、`runtime-planner.ts` 应优先归入这个已有包，而不是把它当成空白路径重新设计。
- `src/core/browser-pool/runtime-capability-registry.ts` 静态声明了四类 runtime：
  - `electron-webcontents`
  - `chromium-extension-relay`
  - `firefox-bidi`
  - `chromium-cloak-playwright`
- 各 runtime 类通过 `describeRuntime()` 返回 descriptor：
  - `src/core/browser-automation/integrated-browser.ts`
  - `src/core/browser-extension/extension-browser.ts`
  - `src/core/browser-ruyi/ruyi-browser.ts`
  - `src/main/profile/browser-pool-integration-cloak.ts`
- `src/types/browser-interface.ts` 同时存在大量 `hasBrowserXCapability()` / `assertBrowserXCapability()` 方法存在性判断。

#### 主要问题

1. Descriptor、接口方法、工具 requirements、实际语义没有统一真相源。

   现在 `BrowserRuntimeDescriptor.capabilities` 说某能力 supported，不等于实际接口语义真的满足。部分测试是手写 truth table，不是从统一 contract 生成或校验。

2. `BrowserCore` 和 optional capability 边界混杂。

   例如 visibility、coordinate、native input、text 等方法在接口上偏 core，但 descriptor 又把它们当 capability flag。这会导致工具层不知道“方法存在”和“能力可用”到底以哪个为准。

3. 一些 runtime 的能力质量存在“实验/降级但标 supported”的风险。

   不在文档里手写某个 runtime 的当前支持矩阵。以代码生成的 capability matrix 为准。任何 runtime 把能力从 `planned/unsupported` 提升到 `experimental/supported`，都必须携带对应 method presence test；关键能力还必须有 semantic smoke / canary 证据，否则模型会误以为各 runtime 等价。

   这是 P0 门禁，不是 P1 愿景。完整 contract 可以在 P1 展开，但最小规则必须先落地：descriptor 只要提升能力等级，同一改动就必须修改对应测试或 smoke 证据；否则 CI 应失败。

4. Profile mode / persistent 语义还需要复核。

   `electron-webcontents` descriptor 标 `ephemeral`，但浏览器池里实际又有 session partition 语义。v4 要以登录态托管为核心，这个语义必须明确。

5. Provider fallback 有漂移风险。

   `browser-runtime-providers.ts` 创建 runtime 时会用 `created.runtimeDescriptor ?? getStaticRuntimeDescriptor(runtimeId)`。如果某个 runtime 需要动态 descriptor 修正，fallback 可能把旧的静态描述带出去。

#### 整改动作

在已有 runtime 包中新增一个一等契约模块，例如：

```text
src/core/browser-runtime/capability-contract.ts
```

定义：

```ts
type BrowserCapabilityContract = {
  name: BrowserCapabilityName;
  requiredMethods: string[];
  semanticChecks: BrowserCapabilitySemanticCheck[];
  degradedModes?: string[];
  toolRequirements?: string[];
};
```

每个 capability 要说明：

- 哪些接口方法必须存在。
- 最小语义是什么。
- 是否允许 degraded。
- 哪些 MCP tool 会依赖它。
- 哪些 runtime 声称支持它。

同时改造测试：

- 从 contract 生成 descriptor completeness test。
- 从 contract 生成 method presence test。
- 给每个 runtime 加 semantic smoke test。
- 明确区分：
  - `unsupported`
  - `supported`
  - `degraded`
  - `experimental`
  - `planned`

建议把 descriptor 从“人工散落声明”收敛为：

```text
contract + runtime implementation notes -> descriptor
```

至少也要做到：

```text
descriptor 必须被 contract 校验
```

#### 验收标准

- 新增/修改任何 `BROWSER_CAPABILITY_NAMES`，测试必须要求补齐 contract、descriptor、tool requirements。
- 每个 runtime 的 `describeRuntime()` 输出都通过统一 contract 校验。
- `browser-capability-truth.test.ts` 不再是孤立手写表，而是 contract 派生或对 contract 做显式覆盖。
- `supported: true` 的能力至少有 method presence test；关键能力有 semantic smoke。
- `degraded` 能力会进入输出 schema 或 runtime status，让模型知道它不是等价能力。

---

### 问题域 02：统一 Browser 工具 requirements 和 Runtime Availability

#### 代码现状

- `src/core/ai-dev/capabilities/browser/tool-manifest.ts` 使用 `createBrowserCapabilityRequires()` 声明工具依赖。
- 多数 public browser 工具只要求基础 `browser/sessionBrowser`，没有细化到具体 capability。
- `browser_network_*`、`browser_console_*` 这类内部工具会额外声明 `network.capture`、`console.capture`。
- `src/main/mcp-http-runtime-availability.ts` 会根据当前 session runtime descriptor 判断 `browserCapability:*` 是否可用。

#### 主要问题

1. 工具到 runtime capability 的依赖不够精确。

   例如 `browser_snapshot` 实际依赖 `snapshot.page`；`browser_act` 的 click/type/press/text-click 对 snapshot、input、text 等能力依赖不同；`browser_debug_state` 会聚合 screenshot、console、network，但现在更像 best-effort，没有把 optional capability 清楚表达给 agent。

2. `browser_observe` 兼具导航和观察。

   它传 `url` 时会导航，有 side effect；不传 `url` 时是观察。当前 manifest 把它标成 write 是正确的，但 agent 看到的语义仍然容易混。

3. Runtime availability 只判断“当前 session 是否满足”，不负责“应该选哪个 runtime/profile”。

   这导致模型要自己猜 runtime，而 v4 希望框架成为模型的手，框架应该给出 plan。

#### 整改动作

为每个 browser tool 定义精确依赖：

```text
browser_snapshot -> snapshot.page
browser_observe(no url) -> snapshot.page
browser_observe(url) -> navigation + snapshot.page
browser_search -> snapshot.page
browser_act.click(elementRef) -> snapshot.page + input/selectors contract
browser_act.click_text -> text.dom 或 text.ocr + input
browser_act.type -> input.native 或 DOM typing fallback contract
browser_debug_state -> snapshot.page + optional screenshot/network/console
browser_screenshot -> screenshot.detailed
browser_network_entries -> network.capture
browser_network_response_body -> network.responseBody
```

把 requirements 放进统一 contract，而不是每个 tool 自己猜。

对 `browser_observe` 做二选一整改：

- 方案 A：拆成 `browser_navigate_observe` 和纯 `browser_observe`。
- 方案 B：保留一个工具，但 output 和 guidance 明确标出 `navigationPerformed`、`sideEffectLevel`、`afterUrl`，并让 availability 对 url 模式单独判断。

新增 runtime planning 能力或增强 `session_prepare`：

```text
browser_runtime_plan / session_prepare(planOnly=true)
```

返回：

```text
requiredCapabilities
candidateRuntimes
compatibleProfiles
blockedReason
recommendedAction
```

#### 验收标准

- public MCP 工具的 capability requirements 与 contract 一致。
- 当当前 runtime 不满足工具能力时，MCP 返回“缺哪个能力、哪些 runtime/profile 可满足”，而不是只说 unavailable。
- `browser_observe(url)` 的写副作用在 schema/guidance/trace 中可见。
- 模型不需要自己知道 Playwright、BiDi、extension 细节，也能得到可执行 runtime/profile 建议。

---

### 问题域 03：Runtime Planner 与 Profile 兼容性

#### 代码现状

- `src/core/browser-pool/acquire-session-resolver.ts` 会把 profile 解析为 session config，并校验 requested runtime 与 profile runtime 是否一致。
- `src/core/browser-pool/acquire-request-factory.ts` 会把 acquire runtime 强制改成 profile runtime。
- `src/main/mcp-http-session-runtime.ts` 的 `session_prepare` 在 binding locked 后不允许随意改 profile/runtime/visible/scopes。

#### 主要问题

这其实是正确的安全基础：已登录 profile 不能被模型随便切 runtime。问题是缺少一个框架拥有的 planner，导致模型只能在工具调用失败后反复试。

v4 需要的是：

```text
任务需要什么能力
  -> 哪些 runtime 能做
  -> 哪些 profile 绑定了这些 runtime
  -> 哪些 profile 登录态健康
  -> 是否需要用户新建/切换 profile
```

当前代码没有把这个决策变成能力。

#### 整改动作

新增规划器，例如：

```text
src/core/browser-runtime/runtime-planner.ts
```

输入：

```ts
{
  requiredCapabilities: BrowserCapabilityName[];
  preferredProfileId?: string;
  site?: string;
  needsVisible?: boolean;
  allowNewProfile?: boolean;
}
```

输出：

```ts
{
  decision: 'ready' | 'needs_profile_switch' | 'needs_runtime_install' | 'needs_manual_login' | 'blocked';
  recommendedRuntimeId?: BrowserRuntimeId;
  recommendedProfileId?: string;
  candidateRuntimes: RuntimeCandidate[];
  candidateProfiles: ProfileCandidate[];
  reasons: string[];
}
```

原则：

- 不自动把已有登录 profile 切到另一个 runtime。
- 不自动创建带登录语义的 profile。
- 当任务需要 response body / intercept / persistent login 等能力时，由 planner 显示推荐合适 runtime。
- planner 作为 `system_bootstrap` / `session_prepare` / capability handler 的共同依赖，不让每个 handler 自己写判断。

#### 验收标准

- 任何网页型 Capability 执行前都能拿到 runtime plan。
- 当前 profile/runtime 不匹配时，错误返回中包含可执行下一步。
- 测试覆盖：
  - profile runtime 与 requested runtime mismatch。
  - required capability 当前 runtime 不支持。
  - 可见登录需要 external/direct window。
  - 已绑定 session 不能静默切 runtime。

---

### 问题域 04：登录态托管：新增 Login State 模型和 `profile.ensure_logged_in`

#### 代码现状

- `src/types/profile.ts` 有 profile runtime/partition/fingerprint/proxy/status 等字段。
- `src/main/duckdb/account-service.ts` 有 account、platform、loginUrl、password、lastLoginAt 等字段。
- `src/main/duckdb/account-service.password.test.ts` 已覆盖 safeStorage 不可用时拒绝非空密码、共享账号 secret 不可随意 reveal 等行为。
- `src/main/mcp-http-session-runtime.ts` 能准备可见浏览器 session。
- `src/core/ai-dev/capabilities/profile-catalog.ts` 有 profile list/get/create/update/delete/start_session 等能力。

#### 主要问题

账号资料不等于登录态健康。

当前只能知道某个 account 可能有 `lastLoginAt`，但不知道：

- 当前 profile 对某 site 是否仍 logged in。
- 是否过期。
- 是否需要 2FA / captcha / manual login。
- 最近一次验证证据在哪里。
- 哪个 Capability 可以验证登录状态。

如果没有这个状态，网页型 Capability 只能自己打开页面试，失败后再猜原因。这不符合“框架作为大模型的手”的目标。

#### 整改动作

新增 login state 数据模型。可以新表，也可以先扩 account/profile 旁路表：

```text
profile_login_states
```

字段建议：

```text
id
profileId
accountId
site
runtimeId
status: unknown | logged_in | expired | needs_manual_login | captcha | two_factor | blocked
verifiedAt
expiresAt
loginUrl
verifierCapability
evidenceArtifactRefs
lastFailureReason
createdAt
updatedAt
```

新增 public capability：

```text
profile.ensure_logged_in
```

输入：

```ts
{
  site: string;
  profileId?: string;
  accountId?: string;
  loginUrl?: string;
  visible?: boolean;
  verifier?: string;
}
```

输出：

```ts
{
  status: 'logged_in' | 'needs_manual_login' | 'captcha' | 'two_factor' | 'blocked' | 'unknown';
  profileId: string;
  runtimeId: BrowserRuntimeId;
  verifiedAt?: string;
  evidenceArtifactRefs: string[];
  nextActionHints: string[];
}
```

原则：

- 默认不让模型输入或使用密码。
- 若必须使用已保存凭据，只允许通过本地 safeStorage / secretRef / 用户授权注入，模型、MCP 输出、trace、broker 都不能接触明文。
- 验证码、短信、2FA、风控登录必须人在环。
- Capability 可以请求打开 visible browser，让用户接管。
- 登录成功后框架记录 verifiedAt 和 evidence，不把敏感 token/cookie 暴露给模型。
- 现有 login guidance 要从“让模型输入凭据”改成“ensure/login handoff”。

#### 验收标准

- `profile.ensure_logged_in` 能返回稳定结构化状态。
- 至少有一个站点 verifier 的测试 fixture。
- 人在环登录流程不把密码、cookie、token 写进 trace/failure bundle。
- secret reveal 能力不进入默认 public MCP；需要显式 scope、用户授权和审计。
- 网页型 Capability 必须先依赖 login state，而不是每个业务 handler 自己判断。

---

### 问题域 05：Site Adapter / Extractor 从 PoC 变成一等包

#### 代码现状

- `src/core/node-extractor-poc/` 当前只有空的 `extractors/` 和 `fixtures/` 目录。
- 代码搜索中没有真正的网页 Site Adapter runner、Interactor/Extractor/Verifier、diagnostics schema、selectorHits、actionTrace、pageFingerprint、repairScope enforcement。
- `src/core/image-search/mobilenet-extractor.ts` 是图像特征抽取，不是 v4 文档里的网页 DOM Extractor。

#### 主要问题

v4 的核心闭环依赖 Site Adapter。只做 Extractor 不够，因为站点变化也会影响写动作：按钮、输入框、提交、等待条件、验证点都会变。

```text
Site Adapter = Interactor / Procedure + Extractor + Verifier
```

其中：

```text
Extractor = readonly evidence -> fields + diagnostics
Interactor / Procedure = intent + browser state -> constrained actions + action diagnostics
Verifier = readonly evidence -> state / pass / fail + diagnostics
```

当前还没有真实可运行的 Site Adapter 基础设施。没有这个，就谈不上写动作自愈、读字段自愈、repair bundle、fixture gate、生产 runner 验收。

#### 写动作自愈的风险边界

v4 把可修范围从只读 Extractor 扩到 Interactor / Procedure，这是实质性扩权。必须承认两类修复的验证强度不同：

| 修复类型 | 验证强度 | 必要门禁 |
| --- | --- | --- |
| Extractor repair | 较强 | 静态 HTML fixture、expected output、schema validate。 |
| Verifier repair | 中等 | fixture + browser evaluate runner，确保状态判断不写页面。 |
| Interactor / Procedure repair | 较弱且风险更高 | mock action log、state transition replay、目标生产 runner / canary、人工审核。 |

因此，写动作自愈不能只靠 fixture。任何修改 Interactor / Procedure 的 repair 都必须：

- 明确 sideEffectLevel。
- 输出 `actionTrace` 和 `ProcedureTransition`。
- 通过 mock action runner 回放。
- 通过目标生产 runner / canary。
- 默认进入 human review，不自动发布。

#### 整改动作

删除或替换空 PoC 目录，建立“一等包”。这里的一等包不是插件，也不是示例站点代码，而是框架级 Site Adapter 基础设施包：类型、Runner、diagnostics、repair bundle、repairScope gate。

建议路径：

```text
src/core/site-adapter-runtime/
```

或：

```text
src/core/site-adapters/
```

放进 `core` 的只能是通用基础设施：

- Site Adapter / Extractor / Interactor / Verifier 类型和 manifest 规范。
- fixture/browser/lab runner 的抽象和通用实现。
- diagnostics、selectorHits、actionTrace、pageFingerprint 的统一 schema。
- repair bundle 生成器。
- repairScope 路径闸门。
- sandbox/import boundary 测试。

不应该放进 `core` 的内容：

- `1688-product.extractor.ts`、`1688-product.interactor.ts` 这类站点业务 adapter 代码。
- 面向某站点的 Capability handler。
- 某插件专属 schema、字段映射、业务 normalize。
- 仅用于演示的 fixture 和 expected output。

当前仓库已有 `examples/minimal-plugin/`，所以示例站点 adapter 应放到 `examples/` 下，例如：

```text
examples/web-site-adapter-1688-product/
  README.md
  manifest.json
  interactors/
    open-product.ts
  extractors/
    product.ts
  verifiers/
    product-page.ts
  fixtures/
    product.html
    product.expected.json
```

如果未来把某站点能力产品化，有两种更清晰的归属：

| 类型 | 放置建议 | 原因 |
| --- | --- | --- |
| 通用 Site Adapter 框架 | `src/core/site-adapter-runtime/` | 被 Capability、插件、Lab、repairScope 共同复用。 |
| 示例站点 Adapter | `examples/web-site-adapter-*/` | 只证明框架用法，不进入核心。 |
| 内置官方站点能力 | `src/core/web-capabilities/<site>/` 或专门 domain package | 如果产品要内置此站点能力，可作为官方 capability，但仍不要污染 extractor core。 |
| 第三方/用户站点能力 | 插件体系 | 用户或生态提供，受插件权限和 scope 约束。 |

最小结构：

```text
src/core/site-adapter-runtime/
  types.ts
  manifest.ts
  runner/
    fixture-runner.ts
    browser-evaluate-runner.ts
    diagnostics.ts
  repair/
    repair-scope.ts
    repair-bundle.ts
  sandbox/
    import-boundary.ts
```

核心类型：

```ts
type ExtractorManifest = {
  name: string;
  version: string;
  site: string;
  inputSchema: unknown;
  outputSchema: unknown;
  requiredPageSignals: string[];
};

type ExtractorResult<TFields> = {
  fields: TFields;
  missingFields: string[];
  selectorHits: SelectorHit[];
  confidence: number;
  extractorName: string;
  extractorVersion: string;
  runner: 'fixture' | 'browser-evaluate' | 'playwright-lab';
  pageFingerprint: PageFingerprint;
  warnings: string[];
};

type InteractorStepResult = {
  stepId: string;
  action: 'click' | 'type' | 'select' | 'scroll' | 'press' | 'wait';
  selectorHits: SelectorHit[];
  beforeUrl?: string;
  afterUrl?: string;
  verified: boolean;
  diagnostics: string[];
};

type SiteAdapterRunState<TData = unknown> = {
  runId: string;
  currentStep: string;
  pageState: string;
  cursor?: unknown;
  seenKeys: string[];
  retryCount: number;
  lastAction?: InteractorStepResult;
  evidenceRefs: string[];
  actionTrace: InteractorStepResult[];
  data: TData;
};

type ProcedureTransition = {
  fromStep: string;
  toStep: string;
  reason: string;
  stepResult?: InteractorStepResult;
  verifierState?: 'pass' | 'fail' | 'unknown';
  diagnostics: string[];
};
```

Runner 分三类：

| Runner | 用途 | 要求 |
| --- | --- | --- |
| fixture runner | 本地 regression | 主要验证 Extractor/Verifier；Interactor 用 mock browser/action log/state transition 验证。 |
| browser evaluate runner | 生产执行 | 只依赖 `BrowserInterface` 的标准 DOM/evaluate/action 能力。 |
| Playwright lab runner | 调试和 fixture capture | 可用 Playwright，但产物必须是 Adapter/fixture/diagnostics。 |

同时必须建立 Site Adapter sandbox 边界：

```text
Site Adapter source
  -> static boundary check
  -> bundled pure DOM function
  -> constrained browser action function
  -> fixture runner
  -> browser evaluate runner
```

Extractor 禁止：

- import Node/Electron/main-process 模块。
- import Playwright page/context。
- 访问文件系统、网络、secrets、profile、dataset、ctx。
- 修改 DOM 状态作为抽取前提。
- 直接写 observation artifact 或 dataset。

需要补测试：

- Extractor 目录禁止出现 `playwright`、`fs`、`child_process`、`electron`、`duckdb` 等依赖。
- Interactor 目录禁止出现 `playwright`、`fs`、`child_process`、`electron`、`duckdb` 等依赖。
- production runner 禁止 import Playwright。
- Lab runner 可以 import Playwright，但必须隔离在 lab/dev 目录或 scope 下。
- fixture runner 和 browser evaluate runner 对同一 fixture 输出一致。
- Interactor 必须通过统一 BrowserInterface action primitives，不能直接拿 browser handle 或 page/context。
- Procedure / Interactor 的连续流程必须使用可序列化的 `SiteAdapterRunState`，不能把状态藏在 page/context handle 或全局变量里。
- 多步骤 Interactor 必须能输出 `actionTrace`、`ProcedureTransition`、before/after evidence，用于失败诊断和自愈。

#### 验收标准

- `src/core/site-adapter-runtime/` 只包含通用框架能力，不包含站点业务 adapter。
- 至少有一个真实 Site Adapter 示例，放在 `examples/web-site-adapter-*/`。
- fixture runner 能在 CI 跑通。
- browser evaluate runner 能通过 `BrowserInterface` 执行，不直接依赖 Playwright page API。
- Extractor 返回 `selectorHits`、`missingFields`、`confidence`、`pageFingerprint`。
- Interactor 返回 `actionTrace`、`step diagnostics`、`verification result`。
- 连续 DOM 流程可以通过 `SiteAdapterRunState` + `ProcedureTransition` 回放，失败时能定位到具体步骤和验证点。
- adapter state 不包含 browser/page/context handle、secrets、cookie value 或不可序列化对象。
- 空的 `node-extractor-poc` 目录被删除或明确迁移，避免继续误导。
- Site Adapter sandbox boundary test 通过，证明生产 adapter 不能越权访问 Node、Playwright、secrets、dataset。

---

### 问题域 06：repairScope 必须变成真实写闸

#### 代码现状

- `docs/zg.v4.md` 已定义 repairScope 概念。
- 当前代码里没有真实 enforcement。

#### 主要问题

如果没有强制写闸，就不能说“大模型只能修站点适配层”。模型修复失败时可能修改 Capability core、schema、profile、安全配置、dataset 写入逻辑，最终把系统越修越不可控。

#### 整改动作

新增 repair scope 模块：

```text
src/core/site-adapter-runtime/repair/repair-scope.ts
```

支持：

```ts
type RepairScope = {
  allowedFiles: string[];
  forbiddenFiles: string[];
  requiredChecks: string[];
};
```

默认允许应指向“站点 Adapter 产物”，不是通用框架本身。下面是命名约定示例，不是权威 allow/deny。权威 repairScope 必须由 adapter manifest + repair-scope tests 生成：

```text
examples/web-site-adapter-*/manifest.json
examples/web-site-adapter-*/interactors/**/*
examples/web-site-adapter-*/extractors/**/*
examples/web-site-adapter-*/verifiers/**/*
examples/web-site-adapter-*/fixtures/**/*
```

如果未来有内置官方站点能力，可为该站点单独开 scope。注意业务能力目录叫 `web-capabilities`，框架运行时目录叫 `site-adapter-runtime`，两者不能混用：

```text
src/core/web-capabilities/<site>/extractors/**/*
src/core/web-capabilities/<site>/interactors/**/*
src/core/web-capabilities/<site>/verifiers/**/*
src/core/web-capabilities/<site>/fixtures/**/*
```

如果是插件提供的站点能力，allowedFiles 应由插件 manifest 声明到插件自己的 adapter 子目录，而不是开放整个插件目录。

通用框架目录默认禁止由自愈 repair 修改：

```text
src/core/site-adapter-runtime/**/*
```

默认禁止：

```text
src/core/site-adapter-runtime/**/*
src/core/ai-dev/capabilities/**/*
src/main/**/*
src/types/**/*
src/core/browser-*/**/*
src/core/browser-pool/**/*
src/constants/**/*
**/*.capability.ts
```

所有模型 repair 写盘必须走：

```text
diff -> path normalize -> allowed check -> forbidden check -> fixture runner -> schema validate -> production runner / canary when action flow changes -> regression -> human review
```

#### 验收标准

- repair 尝试修改 forbidden path 时直接失败。
- repair 修改 allowed path 但 fixture 不过时失败。
- repair 修改 Interactor / Procedure 时，目标生产 runner / canary 不过则失败。
- repairScope 自身有路径穿越测试，例如 `../src/main/foo.ts`。
- repair bundle 中只包含修站点 adapter 所需的最小证据，不包含 secret/cookie/token。

---

### 问题域 07：Agent-hand 安全默认值

#### 代码现状

- `src/constants/http-api.ts` 默认 `enableAuth: false`、`enableMcp: false`、`enforceOrchestrationScopes: false`。
- `src/main/http-auth-middleware.ts` 在开启 token 时能保护 HTTP/MCP。
- `src/core/ai-dev/orchestration/capability-registry.ts` 已有 scope middleware，但是否强制由配置决定。
- `src/main/mcp-http-adapter.ts` 默认从 config 读取 `enforceOrchestrationScopes ?? false`。
- `src/core/ai-dev/capabilities/browser/tool-manifest.ts` 中 `browser_cookies_get` 已不是 public MCP。后续重点不是“再降级 public surface”，而是防止 cookie value、Authorization header、Set-Cookie 等敏感值通过内部工具、trace、failure bundle、repair bundle 泄漏。
- dataset/profile/delete 等 destructive 能力仍要依赖确认或 scope 策略，agent-hand 模式下默认不应裸露给模型。

#### 主要问题

这些默认值适合本地开发兼容，但不适合作为“大模型拥有本地手”的安全默认口径。只要 MCP/HTTP 面向 agent，就应该默认要求 token 和 scope，而不是事后提醒。

更具体地说，v4 不应该让默认 agent surface 直接读取 cookie、response body、raw evaluate 或深层调试信息。登录态托管的目标是“框架知道 profile 已登录”，不是“模型拿到登录凭据和 cookie”。

#### 整改动作

新增一个显式模式：

```text
agentHandMode: true
```

当该模式开启：

- HTTP/MCP 必须 token auth。
- orchestration scopes 默认强制。
- destructive capability 必须确认。
- public MCP surface 只暴露 canonical tools。
- raw evaluate、selector validation、network body、cookie read/write、repair apply 等工具必须在 dev/lab/secret scope 下。
- `browser_cookies_get` 必须保持 advanced/internal；默认 agent surface 不返回 cookie value，只允许必要的脱敏 metadata。
- destructive dataset/profile/plugin/browser 操作必须同时满足 scope + confirmRisk / confirmation token。
- trace/failure bundle 做 secret redaction。

#### 验收标准

- agent-hand 模式下无 token 不能调用 `/mcp`。
- 缺 scope 不能调用 dataset/profile/browser destructive capability。
- raw evaluate 不进入 public MCP manifest。
- cookie value、Authorization header、Set-Cookie、password、token 不进入默认 MCP 输出。
- failure bundle 不包含 cookie/password/token 明文。

---

### 问题域 08：窗口 / 可见性 / 人工接管能力统一

#### 代码现状

- `src/main/mcp-http-session-runtime.ts` 已维护 `visible`、`hostWindowId`、`viewportHealth`、`interactionReady`、`offscreenDetected`。
- `src/core/ai-dev/capabilities/browser/handlers/interaction-health.ts` 已把这些状态放进 `browser_observe`、`browser_snapshot`、`browser_debug_state` 的输出。
- 不同 runtime 的 show/hide/window 行为差异很大：
  - Electron 是 BrowserView / host window 语义。
  - Extension/Cloak/Firefox 是外部窗口语义。
  - Cloak 当前 `show()` 更接近 `bringToFront()`，`hide()` 近似 no-op。
- `docs/remote-browser-window-control-design.zh-CN.md` 已经提出 window capture + WebRTC + OS input 的远程接管方向，但还没有和 v4 runtime descriptor / profile login state 统一。

#### 主要问题

登录态托管不只是“打开页面看 DOM”。验证码、2FA、浏览器扩展弹窗、钱包插件、地址栏、文件选择框都可能发生在 tab DOM 之外。如果框架没有统一的窗口/接管契约，模型会再次倾向于绕过框架，直接找 Playwright 或系统级远控方案。

当前已有 interaction health，但它更偏“当前 BrowserView 是否能交互”。v4 需要更高一层的能力描述：

```text
这个 runtime 能不能被看见
能不能前置
能不能恢复窗口
能不能捕获窗口画面
能不能注入 OS 输入
能不能被远程人工接管
接管时如何暂停自动化 lease
```

#### 整改动作

扩展 runtime/window capability contract，新增或细化能力：

```text
window.showHide
window.restore
window.focus
window.bounds
window.capture
input.os
remoteControl.window
manualHandoff.login
```

在 runtime descriptor 或相邻 descriptor 中表达：

```ts
type BrowserWindowControlDescriptor = {
  showHide: 'supported' | 'degraded' | 'unsupported';
  restore: 'supported' | 'degraded' | 'unsupported';
  focus: 'supported' | 'degraded' | 'unsupported';
  capture: 'window' | 'tab' | 'unsupported';
  input: 'browser-api' | 'os-input' | 'unsupported';
  remoteControl: 'supported' | 'planned' | 'unsupported';
};
```

将人工接管并入 login state 流程：

```text
profile.ensure_logged_in
  -> needs_manual_login / captcha / two_factor
  -> open visible runtime
  -> create manual handoff session
  -> user/local operator/remote operator completes login
  -> verifier updates login state
  -> resume capability
```

同时补 lease 语义：

- 接管期间自动化任务暂停或等待。
- 同一 profile/browser/window 只能有一个 active controller。
- 接管超时必须释放 lease。
- 接管会话只记录审计和质量指标，不记录视频帧和敏感输入。

#### 验收标准

- runtime planner 能判断某任务是否需要 visible/manual handoff/remote control。
- `profile.ensure_logged_in` 遇到验证码/2FA 时返回 handoff plan，而不是让模型尝试绕过。
- `session_prepare(visible=true)` 后 `interactionReady`、`viewportHealth`、`hostWindowId` 的语义在 Electron/Extension/Firefox/Cloak 中一致可解释。
- 外部窗口 runtime 的 `show/hide/focus/restore` 如果是 degraded，必须在 descriptor 和 MCP 输出中可见。
- 远程接管设计文档中的 window capture 能力，不作为默认 agent browser 协议暴露，只作为 manual handoff 后端能力。

---

### 问题域 09：Agent Surface Guidance 和 Golden Transcript 防退化

#### 代码现状

- `src/main/mcp-guidance-content.ts` 已提示模型优先使用 Airpa MCP，而不是 generic Playwright/browser MCP。
- `src/core/ai-dev/capabilities/assistant-guidance.ts` 和 `assistant-surface-manifest.ts` 已有 canonical/advanced/legacy surface。
- `docs/zg.v4.md` 明确列出当前未完成项包含 `agent transcript / golden tests`。

#### 主要问题

用户已经观察到：即使框架提供了 MCP 浏览器工具，大模型仍然会“不自觉”地使用 Playwright。这不是单靠文档句子能解决的，需要把 agent surface 变成可回归测试的契约。

如果没有 transcript 级别的测试，后续任何一次 guidance、tool manifest、capability catalog 改动，都可能重新把模型引向：

```text
page.goto / locator / evaluate / Playwright MCP
```

而不是：

```text
system_bootstrap -> session_prepare -> browser_observe -> capability
```

#### 整改动作

新增 agent transcript / guidance regression：

```text
src/core/ai-dev/capabilities/agent-surface-golden.test.ts
src/main/mcp-guidance-content.golden.test.ts
```

覆盖典型任务：

- “使用已登录 profile 打开页面并观察。”
- “抽取商品信息。”
- “遇到登录/验证码。”
- “浏览器工具失败后诊断。”
- “需要调试 Extractor。”

每个 golden case 断言：

- 推荐起手是 `system_bootstrap` / `session_prepare` / `profile.ensure_logged_in` / 业务 Capability。
- 默认路径不出现 Playwright page API、generic browser MCP、raw evaluate。
- debug/lab 场景才出现 advanced/internal tools。
- 登录场景返回 manual handoff，不鼓励模型输入密码。
- repair 场景只暴露 extractor/fixture/schema/failure evidence。

同时为 public MCP manifest 加守护测试：

```text
canonical surface 不包含 raw evaluate
canonical surface 不包含 cookie value read
canonical surface 不包含 network response body
canonical surface 不包含 repair apply
destructive advanced tools 必须有 confirm/scope
```

#### 验收标准

- 修改 guidance、tool manifest、assistant surface 时必须更新 golden tests。
- 新增网页 Capability 时必须有一条推荐调用路径示例。
- 对“为什么不用 Playwright”的提示不是散文，而是进入 `system_bootstrap`、MCP guidance、assistant manifest 和测试。
- 模型默认工具列表里，Capability 和 Airpa browser hand 的顺序高于任何 lab/debug/raw 工具。

---

### P0 方向：electron-webcontents 升级为持久登录隐藏 runtime

#### 代码现状（核验结论：存储已持久，标注错误）

- `src/core/browser-pool/runtime-capability-registry.ts:71` electron descriptor 标 `profileMode: 'ephemeral'`。
- 但 `profileMode` 在池/profile 业务代码里**没有任何消费点**（全仓只在 registry 内被赋值/读出 descriptor），所以它当前只是元数据标签，不真正驱动 ephemeral 行为。
- 实际存储是持久的：profile partition 是 `persist:profile-${id}`（`src/main/duckdb/profile-service.ts:184`），Electron 磁盘持久 partition，cookie/localStorage 落盘并按 profileId 隔离。
- partition 仅在删除 profile 时清除（`profile-service.ts:677`、`:751` 的 `purgePartitionData`），session release 不清。
- electron 已按 profile 应用代理（`src/main/profile/browser-pool-integration.ts:39-54` 的 `applyProxyToSession` / `ses.setProxy`）和 stealth 指纹（`buildStealthConfigFromFingerprint`）。
- 但池里 electron view 是 `temporary: true` + `displayMode: 'offscreen'`（`browser-pool-integration.ts:84-88`），是一次性离屏视图心智。

#### 主要问题

electron 已经具备"指纹 + 代理 + 持久存储 + profile 隔离"，但 descriptor 把它标成 ephemeral，会让 runtime planner / login state 误判它不承载登录；离屏 temporary view 的生命周期心智也会让人以为 release 即丢登录态。这阻碍把 electron 当"持久登录的隐藏模式浏览器"使用。

#### 整改动作

1. `registry.ts:71` 把 electron `profileMode` 改为 `persistent`，并纳入 P0-BR-01 的 descriptor promotion gate；同时让 login state 真正读取 `profileMode`（否则改了标签也没人用）。
2. 审计 release / view 销毁路径，确认没有任何地方在 session release 时清 `persist:profile-*`（只允许删除 profile 时清）。为 login-bearing electron profile 区分"持久登录视图"与"一次性离屏视图"两种 view 生命周期，或显式声明持久 partition 跨 view 存活的契约。
3. 把 electron 接入 P0-LOGIN-01 login state 与 P0-LOGIN-02 `profile.ensure_logged_in`：人工登录接管 = 显示这个 embedded BrowserView（descriptor `window.showHide: true`、`visibilityMode: 'embedded-view'`），框架记录 verifiedAt/evidence、runtimeId=electron。
4. 为 `input.native: false` 的 DOM-only 输入补登录场景的 DOM 兜底或显式降级提示。

#### 验收标准

- electron profile 登录后，重新 acquire 仍保持登录态（持久 partition 验证）。
- `profile.ensure_logged_in` 对 electron 返回与 extension-relay 一致的结构化状态。
- descriptor / contract 不再把 electron 标成 ephemeral；planner 能把 electron 当登录承载 runtime。
- session release / 离屏 view 销毁不清 `persist:profile-*`。

---

### P0 方向：人/agent 共享同一 profile 的接管策略（机制已存在，缺协作/优先级）

> 更正说明：本节早期版本断言"没有 lease / 没有协作接管 / 没有保活交接 / release 只能销毁"。逐行核验后该结论**错误**——lease、强制 handoff、保活式接管都已存在并接进 MCP。真正缺的是接管**策略**（同意、优先级、暂停、UX）。下文为更正后的事实。

#### 代码现状（逐行核验）

底层机制**已存在且已接进 MCP**：

- 同一 pool 单例：`getBrowserPoolManager()`（`src/core/browser-pool/pool-manager.ts:902`）被 renderer IPC（`profile-ipc-handler.ts`、`account-ipc-handler.ts`）和 HTTP/MCP（`http-browser-pool-adapter.ts`）共用。
- 登录仓按 profileId 共享：`getExtensionUserDataDir(session.id)`（`src/main/profile/chrome-runtime-shared.ts:42`）、electron `persist:profile-${id}`；release/视图销毁不清持久存储（见 P0-LOGIN-04 核验）。
- lease：`src/core/resource-coordinator.ts` 的 `acquire` + 强制 `handoff`（`handoffOne` 直接改 `state.ownerToken`）；`src/core/browser-pool/profile-live-session-lease.ts:42` 的 `takeoverProfileLiveSessionLease`。
- 保活式接管：`src/core/browser-pool/plugin-lease-strategy.ts:93` 的 `takeoverLockedBrowser` 走 `globalPool.handoffLock(candidate.id, ...)`，把同一活浏览器的锁转交新持有者，不销毁。
- 控制者类型信号：`AcquireSource = 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin'`（`src/core/browser-pool/types.ts:179`），人/UI=`ipc`、agent=`mcp`，接管记录 `previousSource`。
- 现状策略：MCP acquire 第一步无条件接管 `tryTakeoverLockedBrowser`（`src/main/http-browser-pool-adapter.ts:316`）；UI/ipc 只 `acquire`+lease、不接管（`src/main/ipc-handlers/profile-ipc-handler.ts:362-371`）。

#### 主要问题

机制齐全，但**策略是单向、无条件、agent 优先**：

- agent 永远从人手里强制抢占（MCP 一进来就 takeover），人却抢不回（ipc 路径不 takeover）。
- 接管只有 `logger.warn`：不询问、不通知被抢方、不暂停被抢方的自动化或人工交互。
- `source` 能区分 `ipc`(人)/`mcp`(agent)，但接管逻辑不据此区别对待，没有 human 优先。
- 没有 `profile.ensure_logged_in` / login state（P0-LOGIN-01/02），agent 无法预知"人已登录此 profile"。
- 没有 renderer 指纹多开 UI 与 MCP session 间的接管 UX（请求/授予/通知）。

所以这不是"在独占锁上新建 lease/接管"，而是**改造已有的强制接管策略**。

#### 整改动作

1. 给已有 lease / `takeoverLockedBrowser` 增加 **controllerType（human/agent）优先级策略**：human 持有时，agent 默认不无条件抢占，改为 `request_handoff`。
2. 在 `tryTakeoverLockedBrowser`（`http-browser-pool-adapter.ts:316`）前加策略闸：根据 `previousSource` 决定"直接接管 / 请求同意 / 等待 / 拒绝"。
3. 接管语义补"通知 + 暂停"：被抢方收到事件、暂停其自动化或人工 lease，而不是静默失去锁。
4. busy / acquireReadiness 输出占用者 `source`，并给出"请求接管"下一步。
5. 打通 renderer 指纹多开 UI 与 MCP session 的接管事件（agent 请求控制 → 人授予/拒绝；人接管 → agent 暂停）。

#### 验收标准

- human(ipc) 持有某 profile 时，agent(mcp) 默认走"请求接管"，而非无条件 `tryTakeoverLockedBrowser`。
- 接管发生时被抢方收到通知并暂停，不再只有 `logger.warn`。
- 接管后浏览器与登录态保活（已由 `handoffLock` 保证），回归测试覆盖 ipc↔mcp 双向交接。
- 同一 profile 任意时刻只有一个 active controller，且 human 优先策略可配置。

---

## 3. P1：地基稳定后重构完善

P1 不一定阻塞第一条最小闭环，但应该紧跟 P0 做，否则 v4 会缺“可追溯、可修复、可运营”的能力。

### P1 方向：Failure Bundle 升级为 Site Adapter Repair Bundle

#### 代码现状

- `src/core/observability/browser-failure-bundle.ts` 能采集 snapshot、screenshot、console tail、network summary。
- `src/core/ai-dev/capabilities/observation-catalog.ts` 能查询 trace summary、failure bundle、timeline、recent failures。
- artifact 类型主要是 `snapshot`、`screenshot`、`console_tail`、`network_summary`、`error_context`。

#### 整改动作

新增或扩展 artifact 类型，最终名称以 `site-adapter-runtime` schema 为准：

```text
extractor_result
extractor_failure
site_adapter_result
site_adapter_failure
site_adapter_repair_bundle
interactor_action_trace
extractor_fixture
extractor_expected
```

Repair Bundle 不在 Markdown 里维护字段真相源。整改任务是建立 schema 和生成快照，并覆盖这些证据类别：

- capability / site / adapter / step 定位。
- runtime / profile / URL / trace 语境。
- 只读抽取证据：failed fields、missing fields、selector diagnostics、fixture、expected。
- 页面证据：snapshot、screenshot、脱敏 network / console 摘要。
- 写动作证据：action trace、state transition、verification result、side effect level。
- 修复边界：output schema、allowed files、forbidden files。

#### 验收标准

- Site Adapter 失败时能通过 observation capability 拿到 repair bundle。
- Repair bundle 不需要模型重新浏览页面，也能修 action flow、selector、field mapping、verifier。
- bundle 有大小限制和敏感信息 redaction。

---

### P1 方向：Dataset Provenance / Run Ledger

#### 代码现状

- Dataset service 有系统字段 `_row_id`、`created_at`、`updated_at`、`deleted_at`。
- Record mutation service 能 insert/update/batch write。
- 但网页抽取写入没有统一 provenance。

#### 主要问题

数据错了之后无法判断原因：

- 页面变了。
- 账号状态变了。
- runtime 变了。
- extractor 坏了。
- capability normalize 错了。
- 模型误操作。

#### 整改动作

新增 sidecar ledger，而不是强迫所有 dataset schema 加字段：

```text
dataset_write_runs
dataset_record_provenance
```

字段建议：

```text
runId
traceId
capabilityName
capabilityVersion
adapterName
adapterVersion
extractorName
extractorVersion
interactorName
interactorVersion
runtimeId
profileId
accountId
sourceUrl
pageFingerprint
artifactRefs
confidence
schemaVersion
capturedAt
recordRowIds
```

Capability 写 dataset 时必须记录 run ledger。

对模型驱动写入增加 staging / review 口径：

```text
extractor result
  -> schema validate
  -> normalize
  -> staged write plan
  -> optional human/confirmRisk gate
  -> transaction write rows + provenance
```

对于覆盖、删除、批量 upsert 等高风险操作，不能只依赖 handler 自觉；必须有 capability metadata 的 destructive/confirm/scope 约束。

#### 验收标准

- 任意一行由网页 Capability 写入的数据，都能追溯到 trace、runtime、profile、extractor version、source URL。
- 支持按 traceId 查询写入了哪些 rows。
- 支持按 extractorVersion 查询受影响数据。
- 高风险写入有 staged plan 和 confirm/scope 证据。
- rows 与 provenance 的写入要么一起成功，要么一起失败。

---

### P1 方向：Capability Web 骨架

#### 整改动作

建立网页型 Capability 的标准骨架，避免每个业务能力重复造轮子：

```text
resolve input
  -> runtime plan
  -> resolve profile/account
  -> ensure logged in
  -> session prepare
  -> navigate/wait stable
  -> run interactor/procedure when needed
  -> run extractor/verifier
  -> validate output
  -> write artifacts
  -> write dataset with provenance
  -> return structured result
```

建议路径：

```text
src/core/ai-dev/capabilities/web-capability-runner.ts
```

或放在新的 domain package：

```text
src/core/web-capabilities/
```

#### 验收标准

- 第一个网页业务能力不直接操作 Playwright page。
- capability handler 内部没有散落登录判断、runtime 判断、provenance 写入。
- 失败会自动挂 observation artifact。

---

### P1 方向：System Bootstrap 输出 runtime plan 信息

#### 代码现状

`system_bootstrap` 已能输出 browser runtime descriptors/statuses。

#### 整改动作

增强输出：

```text
agentHandMode
defaultProfile
currentSessionBinding
recommendedBrowserTools
runtimePlanHints
knownLoginStates
labToolsAvailable
repairToolsAvailable
```

目的不是让模型自己规划所有细节，而是让模型知道“下一步应该调用哪个能力”。

#### 验收标准

- 新会话第一步 `system_bootstrap` 能告诉模型是否需要 `session_prepare`、`profile.ensure_logged_in`、或某业务 Capability。
- 不鼓励 raw Playwright 或 raw evaluate。

---

### P1 方向：Cross-runtime Contract CI

#### 代码现状

- 已有 `browser-runtime.cross-runtime-contract.test.ts`、`browser-capability-truth.test.ts`、各 runtime real-contract/canary 测试。
- 但覆盖面和 contract 统一度不够。

#### 整改动作

建立分层测试：

| 层级 | 目的 |
| --- | --- |
| unit/fake | contract 完整性、descriptor 完整性、tool requirements。 |
| integration | 每个 runtime 的 method presence 与核心语义。 |
| real/canary | extension/firefox/cloak 的真实浏览器行为，允许本地可选。 |

#### 验收标准

- 新增 runtime 或 capability 时必须补齐 contract 测试。
- Cloak、Extension、Firefox、Electron 的差异是显式矩阵，不靠人脑记忆。

---

### P1 方向：Abort / Timeout / Lease 生命周期契约

#### 代码现状

- `src/core/ai-dev/orchestration/capability-registry.ts` 已有 invocation abort、`AbortSignal` 绑定和“abort 后不重试 canonical browser work”的测试。
- `src/main/mcp-http-session-runtime.ts` 已在 browser acquire 和 session close 中接入 abort。
- `src/types/browser-interface.ts` 中部分 browser capability 已接受 `signal` / `timeoutMs`，例如 screenshot、download、dialog、intercept 等。

#### 主要问题

v4 增加 Extractor runner、remote/manual handoff、repair gate、dataset write、Lab 后，长任务会明显增多。如果 abort/timeout/lease 不是统一契约，容易出现：

- capability 已取消，但浏览器仍在运行。
- manual handoff lease 没释放，profile 被锁死。
- repair runner 卡住，阻塞后续任务。
- dataset 写入部分完成，provenance 不完整。
- browser handle 被 abort 后继续复用，状态不可信。

#### 整改动作

建立统一生命周期约定：

```text
Capability invocation
  -> AbortSignal
  -> Runtime operation
  -> Extractor runner
  -> Dataset write transaction
  -> Observation artifact write
  -> Lease release
```

要求：

- 所有网页型 Capability 必须接受并传递 `AbortSignal`。
- Extractor runner 必须支持 timeout 和 abort。
- manual/remote handoff session 必须有 lease timeout 和 release hook。
- dataset write + provenance 应尽量事务化，失败时写 failure artifact。
- abort 后的 browser/session 是否可复用必须由 health check 决定。

#### 验收标准

- abort 任意网页型 Capability，不留下 active lease。
- abort Extractor runner，不写半截 dataset。
- abort 后再次 `session_prepare` 能得到明确的 session phase / health。
- 长任务超时会生成可查询 observation event，而不是静默挂起。

---

### P1 方向：Schema / OpenAPI / MCP Surface 同步

#### 代码现状

- `src/core/ai-dev/capabilities/browser/output-schema-contract.test.ts` 已校验部分 browser tool structured output。
- `src/main/schemas/orchestration-openapi-v1.json` 存在 orchestration OpenAPI schema。
- Capability catalog、MCP tool manifest、OpenAPI、assistant guidance 当前是多处维护。

#### 主要问题

v4 会新增 login state、runtime planner、extractor result、repair bundle、dataset provenance 等结构化输出。如果 schema 多处漂移，模型拿到的工具说明、MCP 输出、OpenAPI 文档、测试夹具会不一致。

#### 整改动作

建立 schema 同步规则：

- Capability definition 是 input/output schema 的主入口。
- MCP tool manifest 从 capability definition 派生或被 parity test 校验。
- OpenAPI schema 必须与 capability catalog 同步。
- golden transcript 使用真实 manifest，不手写假工具列表。
- Extractor output schema 和 dataset schema 要显式版本化。

#### 验收标准

- 新增/修改 Capability 时，schema parity test 会覆盖 MCP + OpenAPI + assistant manifest。
- `profile.ensure_logged_in`、`runtime_plan`、`extractor_run`、`repair_bundle` 都有 output schema contract test。
- 文档示例中的字段能被测试中的 schema 接受。

---

## 4. P2：清理与降噪

### 清理项：删除或迁移空 PoC 目录

`src/core/node-extractor-poc/` 目前只有空目录。它的执行任务 ID 以第 11 节的 `P0-EXT-01` 为准；这里不再维护第二个优先级编号，避免 P0/P2 漂移。

### P2-02 历史 runtime 文档归档

`docs/browser-runtime-refactor-plan.md`、`docs/browser-runtime-git-change-review.md` 可以保留为历史资料，但不应再作为 v4 当前架构依据。建议后续加“历史文档”标记或移动到 archive。

### P2-03 命名收敛

当前代码里同时有 Ruyi、Firefox BiDi、extension relay、cloak 等多套名字。建议建立公开名称和内部名称映射：

```text
firefox-bidi -> Firefox BiDi Runtime
chromium-extension-relay -> Chromium Extension Relay Runtime
chromium-cloak-playwright -> Cloak Playwright Runtime
electron-webcontents -> Electron WebContents Runtime
```

并补充用户输入 alias，例如 `cloak` -> `chromium-cloak-playwright`。

### P2-04 注释编码与维护性清理

部分 orchestration/types 相关文件里有注释编码异常现象。功能不阻塞，但会降低维护质量。建议在 P0/P1 后统一清理，避免混在功能改动里。

---

## 5. 删除 / 停用清单

这些不是立即无脑删除，而是进入 v4 后不应继续作为真实入口。

| 对象 | 动作 | 原因 |
| --- | --- | --- |
| `src/core/node-extractor-poc/` | `P0-EXT-*` 完成后删除或迁移 | 现在是空 PoC，不能代表 v4 Extractor。 |
| 直接面向 agent 的 raw Playwright 心智 | 停用 | 会绕过 profile、trace、dataset、repairScope。 |
| 默认 public MCP 中的 raw evaluate / deep debug 工具 | 只保留 dev/lab scope | agent 默认面不应退回脚本模式。 |
| 文档里的“repairScope 已强制”说法 | 禁止 | 代码没 enforce 前只能说 planned。 |
| 文档里的“Extractor 已端到端验证”说法 | 禁止 | 当前没有一等 Extractor runner。 |

---

## 6. 推荐实施阶段

### 阶段 1：真正最小 agent-hand 闭环

目标：让大模型先通过框架完成一条“只读、可修、可验收”的网页能力路径，而不是继续直接拿 Playwright 当手。

任务：

- 增加 agent-hand surface golden，确保默认路径不出现 Playwright page API、raw evaluate、cookie value、network body、repair apply。
- 增加 `agentHandMode` 的最小安全闸：auth/scope/redaction 必须在 agent-hand 模式下默认开启。
- 增加 runtime descriptor promotion gate：能力从 `planned/unsupported` 提升到 `experimental/supported` 时，必须同改动提交 method presence test；关键能力必须提交 semantic smoke / canary 证据。
- 删除或迁移 `src/core/node-extractor-poc/` 空 PoC，避免它继续伪装成 Extractor 正式入口。
- 建 `src/core/site-adapter-runtime/` 的最小只读骨架：types、manifest、Extractor、Verifier、fixture runner、diagnostics、schema validation。
- 在 `examples/web-site-adapter-*/` 加第一个真实只读示例 adapter；示例不依赖登录，不包含写动作。
- 增加目标 runtime 的 browser canary，只证明当前生产 runner 能执行这条只读路径；fixture 只证明静态回归，不再被当作 runtime 漂移证据。
- 实现 repairScope path gate，先只做 path normalize、allow/deny、path traversal、forbidden path 测试。
- 增加最小 Site Adapter repair evidence，至少能定位 failed extractor/verifier、selector diagnostics、fixture、expected、before/after evidence。

验收：

- 模型默认看到 Capability / Site Adapter 能力，不看到 raw Playwright。
- agent-hand 模式下无 token/scope 不能调敏感 MCP 能力，trace/failure/repair 默认脱敏。
- descriptor 提升能力等级但没有测试证据时，CI 失败。
- 空 PoC 不再作为 Extractor 入口出现。
- fixture runner 通过，证明只读抽取回归成立。
- 目标生产 runner / canary 通过，证明当前 runtime 真实语义成立。
- repairScope 拒绝 core/framework 路径。
- 默认 agent surface 不暴露 cookie value、raw evaluate、network body、repair apply。

### 阶段 2：登录/身份链（P0，与阶段 1 并列）

目标：让人能像指纹多开一样用 profile，agent 能共用同一份登录——这是 v4 核心价值，与阶段 1 的只读闭环并列为 P0，不是阶段 1 跑通后才补。

任务：

- 新增 login state 存储和 `profile.ensure_logged_in` capability；运行时选择复用现有 profile→runtime 绑定，不依赖完整 planner。
- 登录异常返回可见人工登录接管，不鼓励模型输入密码、绕验证码、绕 2FA。
- electron 持久登录语义纠正：`profileMode` 改 persistent、确认 release 不清 `persist:profile-*`、接入 login state。
- 人/agent 共享同一 profile 的接管策略：human 持有时 agent 请求接管而非无条件抢占；接管可通知、可暂停被接管方、可超时回收。

验收：

- login state 可查询、可验证、可追溯；密码/token/cookie 不入 trace/failure bundle。
- 登录异常走人工接管而非模型绕过。
- electron 登录态跨 acquire 持久。
- human(ipc) 持有 profile 时 agent 不静默抢占。

### 阶段 3：Browser Capability Contract、完整 Planner 与窗口能力（P1）

目标：把 runtime descriptor、方法存在性、tool requirements、语义烟测收敛成完整单一契约，并在其上建完整 planner。

任务：

- 在已有 `src/core/browser-runtime/` 中建 `capability-contract.ts`。
- 将 runtime descriptor、method checks、tool requirements 接入 contract。
- 修正 `BrowserCore` 与 optional capability 边界。
- 由脚本输出 runtime capability matrix，不在文档手写矩阵。
- 新增完整 runtime planner（按 requiredCapabilities/profile/login state/visibility 给 plan）与 `runtime_plan`，替换阶段 2 的最小运行时选择。
- 补 window/interaction/manual handoff capability contract。

### 阶段 4：写动作 Procedure 与自愈收紧

目标：承认写动作自愈比只读 Extractor 风险更高，并提高门禁。

任务：

- 区分 read-only Extractor repair 与 write Interactor/Procedure repair。
- Extractor repair 可由 fixture gate 强约束。
- Interactor/Procedure repair 必须额外通过 mock action log、state transition replay、目标生产 runner / canary、人工审核。
- repair bundle 明确标注 sideEffectLevel、failedStep、state transition、verification strength。

### 阶段 5：数据追溯、Schema / 生命周期治理（P1）

目标：让数据写入、schema surface、长任务生命周期都可追溯、可取消、可验证。

任务：

- 最小 dataset provenance / run ledger：把 traceId、adapterVersion、runtimeId、sourceUrl 关联到写入结果；Site Adapter 结果写入 observation artifact 与 dataset provenance。
- schema / MCP / OpenAPI parity gate。
- abort / timeout / lease 生命周期测试。
- artifact redaction。

---

## 7. 最小闭环目标

不要一上来做完整 Lab，也不要一上来把写动作自愈、完整 planner 和完整数据账本都塞进 P0。P0 是两条并列的最小但真实的链：

```text
默认路径链（只读）：
system_bootstrap
  -> agent-hand surface guidance
  -> read-only site adapter capability
  -> extractor fixture runner
  -> target runtime canary
  -> observation trace
  -> repair evidence
  -> repairScope gate

登录/身份链：
login state
  -> profile.ensure_logged_in（可见人工登录接管）
  -> electron 持久登录语义纠正
  -> 人/agent 共享同一 profile 的接管策略
```

这两条链跑通后，再把完整 runtime planner、dataset provenance、状态化 Interactor/Procedure 接进来。把登录/身份链留到这之后，就违背了 v4“人指纹多开 + agent 共用登录”的核心价值；把写动作和完整数据账本塞进 P0，则会让第一阶段变成横向重构合集。

---

## 8. 暂缓新增的内容

在 P0 完成前，建议暂缓：

- 大量新增站点业务 Capability。
- 做完整可视化 Site Adapter Lab。
- 做自动修复发布链路。
- 把 Playwright 工具直接暴露给 public MCP。
- 给 dataset 写复杂自动合并策略。
- 做多 agent 自治修复。
- 做完整远程桌面产品。
- 做绕过验证码/2FA/风控的自动化。

原因：这些都依赖地基。第一刀没有完成前，如果 agent surface 仍会引导模型回到 Playwright、runtime descriptor 可以无测试升级、repairScope 不能 enforce，越往上做，系统越容易被模型绕开。

---

## 9. 最终验收清单

v4 地基完成的标志不是文档写完，而是以下事实成立：

- Agent 默认看到的是 Capability，不是 Playwright page。
- Browser runtime 能力矩阵由 contract 约束，不靠手写散表。
- 当前 runtime 不满足任务时，框架能给出 runtime/profile plan。
- 登录态是被框架验证和记录的状态，不是 `lastLoginAt` 字段猜测。
- 验证码/2FA/扩展弹窗等非 DOM 场景有 manual handoff/window control plan。
- Site Adapter 是固定站点代码，有 Interactor/Extractor/Verifier、fixture、diagnostics、runner。
- 调试 Site Adapter 可以用 Playwright，但生产执行不依赖 Playwright page API。
- Site Adapter 有 sandbox boundary test，不能访问 Node、Playwright、secrets、dataset。
- Failure Bundle 能升级成 Repair Bundle。
- repairScope 是真实写闸，不是文档约定。
- Dataset 写入带 provenance。
- agent-hand 模式默认 auth/scope/redaction。
- Cookie value、network body、raw evaluate、repair apply 不在默认 canonical agent surface。
- Agent surface/guidance 有 golden transcript 测试，防止默认路径退回 Playwright。
- abort/timeout/lease 生命周期可验证，不残留悬挂浏览器或半截写入。

一句话：

```text
先把“浏览器能力、登录态、Site Adapter、修复边界、数据追溯”做成代码契约，
再让大模型在这些契约上调用能力。
这才是 Tianshe v4 作为大模型之手的地基。
```

---

## 10. 代码证据映射

本计划不是只按 v4 文档推演，下面这些结论来自当前代码。

| 结论 | 代码证据 | 说明 |
| --- | --- | --- |
| Runtime 能力还没有形成单一契约 | `src/types/browser-interface.ts`、`src/core/browser-runtime/**`、`src/core/browser-pool/runtime-capability-registry.ts`、各 runtime 的 `describeRuntime()` | 已有 browser-runtime 包、capability names 和 descriptor，但 descriptor、接口方法、工具 requirements、语义测试仍是分散的。 |
| Browser tool requirements 不够精确 | `src/core/ai-dev/capabilities/browser/tool-manifest.ts`、`src/core/ai-dev/capabilities/catalog-utils.ts` | 多数 public browser tools 只要求基础 browser/sessionBrowser，没有细化到 `snapshot.page`、`input.native`、`text.dom` 等。 |
| Runtime availability 只判断当前 session，不负责规划 | `src/main/mcp-http-runtime-availability.ts` | 能发现 unsupported browser requirements，但不会给出完整 profile/runtime/login plan。 |
| Profile/runtime 绑定已经存在，不能静默切换 | `src/core/browser-pool/acquire-session-resolver.ts`、`src/core/browser-pool/acquire-request-factory.ts`、`src/main/mcp-http-session-runtime.ts` | profile runtime mismatch 会被拒绝，`session_prepare` binding locked 后也不能随便换。这个是好基础。 |
| 交互健康已有雏形，但窗口/远程接管未统一 | `src/main/mcp-http-session-runtime.ts`、`src/core/ai-dev/capabilities/browser/handlers/interaction-health.ts`、`docs/remote-browser-window-control-design.zh-CN.md` | 已有 `interactionReady`、`viewportHealth`，但 window capture、OS input、manual handoff 尚未进入 runtime contract。 |
| 登录态健康不是一等模型 | `src/types/profile.ts`、`src/main/duckdb/account-service.ts`、`src/core/ai-dev/capabilities/profile-catalog.ts` | 有 profile/account/password/loginUrl/lastLoginAt，但没有 `profile.ensure_logged_in`、site login state、verifier/evidence。 |
| 网页 Site Adapter 基础设施不存在 | `src/core/node-extractor-poc/`、`src/core/image-search/mobilenet-extractor.ts` | PoC 目录为空；现有 `mobilenet-extractor` 是图像特征抽取，不是 Interactor/Extractor/Verifier 站点适配层。 |
| Failure Bundle 有基础，但不是 Repair Bundle | `src/core/observability/browser-failure-bundle.ts`、`src/core/ai-dev/capabilities/observation-catalog.ts` | 能收 snapshot/screenshot/console/network/error_context，但没有 site_adapter_result、actionTrace、selectorHits、fixture/expected。 |
| Dataset 能写入，但缺网页能力 provenance | `src/main/duckdb/dataset-service.ts`、`src/main/duckdb/dataset-record-mutation-service.ts`、`src/core/ai-dev/capabilities/dataset-catalog.ts` | 有行数据 CRUD/mutation，但没有 run ledger、adapterVersion、extractorVersion、interactorVersion、pageFingerprint、traceId 到 row 的关联。 |
| agent-hand 安全默认值偏开发兼容 | `src/constants/http-api.ts`、`src/main/http-auth-middleware.ts`、`src/main/mcp-http-adapter.ts` | 默认 auth/scope enforcement 偏宽松；agent-hand 模式需要显式更严格。 |
| Cookie/raw debug 默认面需要继续防泄漏 | `src/core/ai-dev/capabilities/browser/tool-manifest.ts`、`src/core/ai-dev/capabilities/browser/handlers/cookies.ts` | `browser_cookies_get` 已不是 public MCP；剩余风险是内部工具、trace、failure bundle、repair bundle 泄漏 cookie value / token / Authorization header。 |
| Guidance 已有，但缺 transcript 防退化 | `src/main/mcp-guidance-content.ts`、`src/core/ai-dev/capabilities/assistant-guidance.ts`、`src/core/ai-dev/capabilities/assistant-surface-manifest.ts` | 已提示优先 Airpa MCP，但还没有 golden transcript 测试来防止模型退回 Playwright。 |
| Schema 多处维护，需要 parity | `src/core/ai-dev/capabilities/*-catalog.ts`、`src/main/schemas/orchestration-openapi-v1.json`、`src/core/ai-dev/capabilities/browser/output-schema-contract.test.ts` | v4 新增 login/runtime/site adapter/repair/provenance 后，必须防 schema 漂移。 |
| electron 标 ephemeral，但存储其实持久 | `src/core/browser-pool/runtime-capability-registry.ts:71`、`src/main/duckdb/profile-service.ts:184,677`、`src/main/profile/browser-pool-integration.ts:39-54,84-88` | partition 是 `persist:profile-${id}`、只在删 profile 时清、已应用代理/指纹；`profileMode` 标 ephemeral 且无代码消费。是标注/生命周期问题，不是存储问题。见 P0-LOGIN-04。 |
| 人/agent 登录已共享，接管机制已存在，缺策略 | `src/main/profile/chrome-runtime-shared.ts:42`、`src/core/resource-coordinator.ts`、`src/core/browser-pool/profile-live-session-lease.ts:42`、`src/core/browser-pool/plugin-lease-strategy.ts:93`、`src/core/browser-pool/types.ts:179`、`src/main/http-browser-pool-adapter.ts:316` | 同一 pool 单例 + 登录仓按 profileId 共享；lease、强制 handoff、保活式 `takeoverLockedBrowser`(handoffLock)、source(ipc/mcp) 均已存在并接进 MCP。缺的是策略：MCP 无条件抢占、人抢不回、无同意/通知/暂停/优先级。见 P0-SHARE-01。 |

---

## 11. 具体整改任务清单

这里按“修补 / 重构 / 删除 / 新增”列出下一步可执行任务。P0 做完前，不建议新增大批站点能力。

| ID | 类型 | 要改的位置 | 具体动作 | 验收 |
| --- | --- | --- | --- | --- |
| P0-BR-01 | 修补 | runtime descriptor / tests | 增加 descriptor promotion gate：能力从 `planned/unsupported` 提升到 `experimental/supported` 时，必须同改动提交 method presence test；关键能力必须提交 semantic smoke / canary 证据。 | 没有测试证据时 descriptor 提升失败；Cloak 等 runtime 也被覆盖。 |
| P1-BR-01 | 新增 | `src/core/browser-runtime/capability-contract.ts` | 定义 `BrowserCapabilityContract`，列出每个 capability 的 requiredMethods、semanticChecks、degradedModes、toolRequirements。 | 新增 capability 时必须补 contract，否则测试失败。 |
| P1-BR-02 | 重构 | `src/core/browser-pool/runtime-capability-registry.ts` | 让 static descriptor 接受 contract 校验，至少禁止 descriptor 漏字段、错字段、unsupported 但无 notes。 | descriptor completeness test 通过。 |
| P1-BR-03 | 修补 | `src/types/browser-interface.ts` | 清理 `BrowserCore` 与 optional capability 的边界，明确哪些是最小 core，哪些必须走 capability flag。 | method-presence helper 与 capability contract 对齐。 |
| P1-BR-04 | 修补 | runtime descriptor / smoke tests | 在 P0 promotion gate 基础上补齐跨 runtime semantic smoke suite，覆盖核心观察、动作、网络、下载、弹窗、窗口能力的真实语义。 | 支持矩阵由测试和生成快照证明，而不是文档手写。 |
| P1-BR-05 | 修补 | `src/main/profile/browser-runtime-providers.ts` | 取消会导致 descriptor 漂移的 fallback，或强制 factory 返回动态 descriptor。 | Cloak 动态 descriptor 不会退回旧 static 描述。 |
| P1-TOOL-01 | 重构 | `src/core/ai-dev/capabilities/browser/tool-manifest.ts` | 每个 browser tool 声明精确 `browserCapability:*`，不要只依赖基础 browser/sessionBrowser。 | `mcp-http-runtime-availability.test.ts` 覆盖缺失能力提示。 |
| P1-TOOL-02 | 修补 | `src/core/ai-dev/capabilities/browser/handlers/observation.ts` | 明确 `browser_observe(url)` 的导航副作用；必要时拆出 `browser_navigate_observe`。 | 输出包含 `navigationPerformed` / `afterUrl` / sideEffect。 |
| P1-PLAN-01 | 新增 | `src/core/browser-runtime/runtime-planner.ts` | 根据 requiredCapabilities、profile runtime、login state、visibility 生成 runtime/profile plan。 | 当前 runtime 不满足时返回候选 runtime/profile。 |
| P1-SESSION-01 | 修补 | `src/main/mcp-http-session-runtime.ts` | 把 planner 接进 `session_prepare(planOnly=true)` 或新增 `runtime_plan` capability。 | binding locked 时不静默切换，只返回 plan。 |
| P0-LOGIN-01 | 新增 | DuckDB schema / profile/account service | 新增 `profile_login_states` 或等价表，记录 site/profile/account/runtime/status/evidence。 | 可查询最近登录健康和 evidence artifact。 |
| P0-LOGIN-02 | 新增 | `src/core/ai-dev/capabilities/profile-catalog.ts` 或新 login catalog | 新增 `profile.ensure_logged_in` capability，运行时选择复用现有 profile→runtime 绑定，不依赖完整 planner。 | 返回 `logged_in / needs_manual_login / captcha / two_factor / blocked / unknown`。 |
| P0-LOGIN-03 | 修补 | `src/main/mcp-guidance-content.ts` | 登录 guidance 从“模型输入凭据”改成 ensure/login handoff。 | golden test 不允许默认建议模型输入密码。 |
| P1-WIN-01 | 新增 | runtime descriptor / window control contract | 增加 window/focus/restore/capture/osInput/manualHandoff 能力描述。 | Electron/Extension/Firefox/Cloak 都有明确 supported/degraded/unsupported。 |
| P1-WIN-02 | 修补 | `src/core/ai-dev/capabilities/browser/handlers/interaction-health.ts` | 将 window descriptor 与 `interactionReady`、`viewportHealth` 合并输出。 | 外部窗口 degraded 时模型能看到原因。 |
| P0-EXT-01 | 删除/替换 | `src/core/node-extractor-poc/` | 删除空 PoC 或迁移为真实实现入口；不能继续作为伪入口。 | 目录不存在，或 README 明确迁移到新包。 |
| P0-EXT-02 | 新增 | `src/core/site-adapter-runtime/` | 只放通用 Site Adapter types/manifest/read-only runner/Extractor/Verifier/diagnostics/repair/sandbox，不放站点业务代码。 | core 包内无 `1688` 等站点 adapter；fixture runner 通过。 |
| P0-EXT-03 | 新增 | `examples/web-site-adapter-*/` | 放第一个真实只读示例 adapter，包含 extractors/verifiers/fixtures/expected/README。 | 示例 fixture runner 和目标 runtime canary 通过。 |
| P0-EXT-04 | 新增 | `src/core/site-adapter-runtime/sandbox/` | 做 import boundary 检查，禁止生产 adapter import Node/Electron/Playwright/DuckDB。 | sandbox boundary test 通过。 |
| P1-EXT-05 | 新增 | `src/core/site-adapter-runtime/state-machine.ts` | 定义 `SiteAdapterRunState`、`ProcedureTransition`、`actionTrace` schema，支撑连续 DOM 操作的序列化、诊断和回放。 | 多步骤 mock flow 可从 fixture/action log 回放；state 不包含 browser/page/context/secrets。 |
| P0-REPAIR-01 | 新增 | `src/core/site-adapter-runtime/repair/repair-scope.ts` | 实现 repairScope path normalize、allow/deny、path traversal 防护。 | 修改 `src/main/**`、`src/core/site-adapter-runtime/**` 被拒绝。 |
| P0-REPAIR-02 | 修补 | repair flow / tests | P0 repair 只能改站点 extractors/verifiers/fixtures/expected，不能改 framework core；repair evidence 必须带 selector diagnostics、fixture、expected、before/after evidence。 | allowed/forbidden 测试覆盖 examples 和官方站点路径；只读抽取失败能定位具体字段。 |
| P0-SEC-01 | 新增/修补 | `src/constants/http-api.ts`、`src/main/mcp-http-adapter.ts` | 增加 `agentHandMode`，开启后强制 auth/scope。 | 无 token/scope 不能调 MCP 敏感能力。 |
| P0-SEC-02 | 修补 | `src/core/ai-dev/capabilities/browser/tool-manifest.ts`、cookies/trace/failure bundle | 保持 `browser_cookies_get` 非 public；增加回归测试确保默认 MCP 输出、trace、failure bundle、repair bundle 不含 cookie value / Authorization / Set-Cookie。 | 默认 agent surface 没有 cookie value，内部诊断也默认脱敏。 |
| P0-GOLD-01 | 新增 | `src/main/mcp-guidance-content.golden.test.ts` | golden 测试“网页只读抽取/修复/登录异常占位”路径。 | 默认路径不出现 Playwright page API / generic MCP。 |
| P0-OBS-01 | 新增 | `src/core/observability/**`、`src/core/ai-dev/capabilities/observation-catalog.ts` | 增加最小 site_adapter_result、site_adapter_failure、site_adapter_repair_evidence artifact 类型，不包含写动作 state machine。 | Site Adapter 失败能查询只读 repair evidence。 |
| P1-OBS-02 | 新增 | `src/core/observability/**`、`src/core/ai-dev/capabilities/observation-catalog.ts` | 在 P0 evidence 基础上扩展 site_adapter_repair_bundle、interactor_action_trace、procedure_state_transition artifact 类型。 | 连续流程失败能查询 repair bundle 和状态转移。 |
| P1-DATA-01 | 新增 | `src/main/duckdb/**dataset**` | 新增最小 run ledger / record provenance sidecar 表。 | row 能追溯 traceId、adapterVersion、runtimeId、sourceUrl。 |
| P1-DATA-02 | 修补 | dataset mutation capability | 高风险写入走 staged plan + confirm/scope，rows/provenance 事务一致。 | 写入失败不留下半截 provenance。 |
| P1-SCHEMA-01 | 修补 | `src/main/schemas/orchestration-openapi-v1.json`、capability catalogs | 增加 schema parity，覆盖 MCP/OpenAPI/assistant manifest。 | 新 capability schema 不同步时测试失败。 |
| P1-LIFE-01 | 修补 | capability registry / session runtime / site adapter runner | 统一 AbortSignal、timeout、lease release。 | abort 不残留 active lease，不写半截 dataset。 |
| P0-LOGIN-04 | 修补 | `src/core/browser-pool/runtime-capability-registry.ts:71`、electron release/view 生命周期、login state | electron `profileMode` 改 persistent 并纳入 contract；确认 release 不清 `persist:profile-*`；接入 P0-LOGIN-01/02 login state 与 `ensure_logged_in`（embedded-view 显示登录）。 | electron 登录态跨 acquire 持久；login state 把 electron 当登录承载 runtime（不依赖完整 planner）。 |
| P0-SHARE-01 | 修补 | `src/main/http-browser-pool-adapter.ts:316`、`src/core/browser-pool/plugin-lease-strategy.ts:93`、renderer↔MCP 接管信号 | 在已有 `takeoverLockedBrowser`/lease 之上加 controllerType(human/agent) 优先级策略：human 持有时 agent 改"请求接管"而非无条件抢占；接管补通知+暂停被抢方。 | human(ipc) 持有时 agent 不静默抢占；接管发通知并暂停；ipc↔mcp 双向交接回归覆盖。 |
