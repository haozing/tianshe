# v4 通用框架能力重构整改计划

> 架构依据：`docs/zg.v4.md` 及当前代码、测试、生成快照
> 文档性质：框架实现差距与整改计划
> 业务方案的地位：需求样本和验收消费者，不是框架概念、数据模型或优先级的权威来源

## 1. 目的与结论

本文只回答一个问题：从具体业务暴露的问题中，哪些能力必须由 Tianshe 框架统一拥有。

判断结果不是“业务需要什么，框架就内置什么”，而是：

```text
业务需求
  -> 提取跨站点、跨插件、跨 Runtime 的稳定约束
  -> 判断是否涉及宿主资源、安全或统一执行语义
  -> 复用现有 Capability / Profile / Runtime / Site Adapter / Observation 主干
  -> 形成最小通用接口
```

本轮确认需要推进的核心框架能力共有 7 项：

| 优先级 | 核心能力 | 框架必须拥有的原因 |
| --- | --- | --- |
| P0 | 插件贡献现有 Capability Runtime | Capability 是 v4 唯一业务调用单位；插件不能长期停留在泛化 RPC |
| P0 | Profile 登录健康与人工接管 | 登录仓、控制权和 lease 属于宿主资源，不能由每个插件分别实现 |
| P0 | Runtime-aware Profile Session I/O | Profile 凭据和 Runtime 差异必须留在框架边界内，插件不能搬 Cookie |
| P0 | Capability 确认授权 | destructive/high-risk 调用必须由统一执行层校验，布尔参数不足以授权 |
| P1 | 统一 Artifact 文件后端与 provenance 闭环 | 文件、Trace、Failure Bundle 和数据来源必须能互相追溯 |
| P1 | 插件贡献 Site Adapter Pack | 页面易变层应能随能力提供方加载，同时受 Runner 和 repairScope 约束 |
| P1 | 可选 Durable Capability Run | 长能力需要通用的恢复、取消和 checkpoint，但不能固化某个业务的批处理模型 |

另有 2 项插件平台基础整改：统一 Plugin SDK 合同，以及收紧插件状态存储边界。它们是上述能力的支撑条件，但不应被描述成 v4 Agent-hand 的独立业务能力。

白牌构建、产品标题、appId、安装包更新和主题属于发行平台，不进入本计划的核心能力工作包。

## 2. 通用能力准入规则

### 2.1 准入条件

候选能力只有满足以下至少一个条件，并且合同不包含业务领域概念，才允许进入框架：

| 判断条件 | 典型对象 |
| --- | --- |
| 必须由宿主保护 secrets、文件、浏览器或系统资源 | Profile session、Cookie、artifact file、window lease |
| 必须对 Agent、MCP、Workflow、Plugin UI 统一执行 | Capability schema、scope、confirmation、trace |
| 必须屏蔽多个 Runtime 的实现差异 | session request、download、visibility、handoff |
| 必须跨插件保持同一生命周期和审计语义 | capability provider、adapter registry、artifact、durable run |
| 已由 v4 架构明确指定为框架责任 | Profile login health、Runtime planning、provenance、repairScope |

### 2.2 拒绝上浮的内容

以下内容即使多个业务都可能出现，也默认留在插件：

- 店铺、订单、商品、营销活动等领域实体和状态机。
- 某个平台的 origin 划分、endpoint key、业务错误码和字段规则。
- preview 内容、before/after 业务比较、批量分组和对账算法。
- Job 中的店铺 partition、商品 item、报表指标和业务 attempt 数据。
- 页面布局、产品导航、白牌品牌和业务发布节奏。
- 只有单一业务需要、且插件可在既有安全边界内可靠实现的基础设施。

### 2.3 无兼容负担原则

本轮可以删除错误接口和开发数据，不保留双路径；但“无需兼容”只用于清理实现，不能作为扩大框架职责的理由。

- 不为旧 Plugin SDK、旧表或旧测试保留兼容重载。
- 第一方插件、官方 Site Adapter 和框架可在同一提交内升级。
- 数据库可按新 schema 重建，不编写旧开发数据迁移。
- 不做 shadow write、旧新 registry 并存或按调用方式猜版本。
- 每个新抽象仍必须通过通用能力准入规则。

## 3. v4 边界

### 3.1 唯一业务执行主干

`docs/zg.v4.md` 已确定：Agent、MCP、Workflow 和 Plugin UI 的业务动作都应进入 Capability；Capability 内部编排 Profile、Runtime、Site Adapter、Dataset、Artifact 和 Trace。

```text
Agent / MCP / Workflow / Plugin UI
        |
        v
目标 Orchestration Capability Runtime
        +-- input/output schema metadata + runtime validation
        +-- scopes / retry / idempotency
        +-- confirmation middleware
        +-- trace / failure evidence
        |
        +-- Profile login / Runtime plan / session I/O
        +-- Site Adapter Registry / Runner
        +-- Dataset / Artifact / Provenance
        +-- optional Durable Capability Run
```

插件业务 API 可以保留给纯 UI 状态和插件自省，但不能成为绕过 Capability policy 的第二条业务写路径。

### 3.2 框架与插件的责任

| 层 | 框架负责 | 插件负责 |
| --- | --- | --- |
| Capability | 定义、注册、schema、scope、调用来源、重试、幂等、确认、trace | 业务输入输出和 handler |
| Profile | 凭据仓、site 登录健康、Runtime 绑定、控制权和人工接管 | 提供站点登录 Verifier 和业务账号解释 |
| Runtime | descriptor、capability probe、规划、acquire、统一 session I/O | 声明所需 browser capabilities |
| Site Adapter | manifest、registry、Runner、Lab、repair evidence、repairScope | Extractor、Interactor/Procedure、Verifier、fixture |
| Dataset | 数据写入、provenance 和 schema 边界 | 业务数据结构和 normalize |
| Artifact | 元数据、文件后端、保留策略、Trace/Failure Bundle 关联 | 业务文件内容和脱敏规则 |
| Durable Run | run、checkpoint、取消、恢复、资源键 | 业务分片、业务 item、对账和领域状态 |

## 4. 真实代码审计

### 4.1 可直接复用的底座

| 方向 | 代码事实 | 整改含义 |
| --- | --- | --- |
| Capability Runtime | `src/core/ai-dev/orchestration/types.ts`、`capability-registry.ts` 和 `src/core/ai-dev/capabilities/unified-catalog.ts` 已有 definition、handler、catalog、executor | 只增加动态 provider、运行时校验和 policy middleware，不新建第二套执行器 |
| Capability policy | `capability-registry.ts` 已有 scope、idempotency、retry middleware；observation 目前是 executor 外层 span/failure evidence，不是 middleware；schema 目前主要是 metadata/parity 校验，未统一拦截 invocation args/result | 新增 schema validation 与 confirmation middleware；observation 是否 middleware 化需单独写入执行合同 |
| Runtime planning | `src/core/browser-runtime/runtime-planner.ts` 已按 required capabilities、Profile 和登录态产出决策 | 补 probe/descriptor 真实性和 session I/O requirement，不做业务 Runtime Gate |
| 登录状态 | `src/main/duckdb/profile-login-state-service.ts` 和 Profile capability gateway 已存在 | 收口逻辑键、失效规则和插件/adapter 写入入口 |
| 控制权 | `src/core/resource-coordinator.ts`、`browser-pool/profile-live-session-lease.ts` 已有 lease、handoff/takeover | 补 owner 语义、人工优先级、通知和恢复，不重做锁系统 |
| Browser capabilities | `src/types/browser-interface.ts` 和 `src/core/browser-pool/runtime-capability-registry.ts` 已覆盖 network capture、response body、download | session request 应成为新 capability requirement，而不是插件复制 Cookie |
| Site Adapter | `src/core/site-adapter-runtime/runner.ts`、`procedure.ts`、`repair/*` 已有 Runner、Procedure、repair bundle 和 repairScope | 缺动态 registry 及 plugin source 生命周期接入 |
| Observation | `src/core/observability/types.ts`、`browser-failure-bundle.ts` 已有 Runtime Artifact、Trace 和 FailureBundle | 文件 artifact 应扩展现有模型，不另立平行 Store |
| Provenance | `src/main/duckdb/dataset-provenance-service.ts` 已有 Dataset run ledger 和 record provenance | 插件 Capability 写入必须携带同一 trace/capability/profile 语境 |

### 4.2 当前真实缺口

| 缺口 | 代码证据 | 判断 |
| --- | --- | --- |
| 插件 SDK 类型分裂 | `src/core/js-plugin/context.ts` 是 `exposeAPI(map)`；`types/index.ts` 声明为 `exposeAPI(name, handler)`；`src/types/js-plugin.d.ts` 又缺少 `helpers/exposeAPI` | 插件平台基础缺口 |
| 插件页面共享 partition 与调用身份未绑定 | `src/main/webcontentsview-plugin-page-controller.ts` 使用 `persist:plugin-page-shared`；preload 的 `callPluginAPI(pluginId, ...)` 允许 renderer 传入任意 pluginId，主进程只校验 trusted renderer | UI 存储隔离和 RPC caller identity 缺口，不是 Capability 新模型 |
| Catalog 静态快照 | `unified-catalog.ts` 由静态 factories 组成；`orchestration/capability-registry.ts` 在模块加载时生成 map | 插件 capability 无法动态注册/注销 |
| 登录健康入口存在但可信写入和失效语义不足 | `profile_ensure_logged_in` 与 `profileLoginStateGateway` 已存在；`IDuckDBService` 未暴露 login-state service；表内 runtime 只是记录字段，planner 主要看 status/verified | 应提供受控 gateway、writer role、revision/runtime snapshot 失效，不鼓励插件自建框架登录态 |
| 登录态唯一性不足 | `profile-login-state-service.ts` 的 `profile_id + site` 只有普通索引，runtime 只是记录字段 | 需要明确逻辑键和 Runtime 变化后的失效语义 |
| 人工与 Agent 接管语义不完整 | `ResourceOwnerSnapshot` 主要只有 source/token/refCount；pool 已支持 takeover | 需要产品化 owner、请求接管、暂停和恢复协议 |
| Profile session request 缺失且 raw browser surface 过宽 | `profile-browser-facade.ts` 暴露 Cookie、evaluate、network capture/interception 和底层下载控制，但没有统一 authenticated request | 应下沉到 BrowserRuntime/Profile session gateway，并收紧插件默认 browser façade |
| 高风险确认是布尔值 | `site-adapter-runtime/procedure.ts` 及多个 catalog 使用 `confirmRisk === true` | 需要不可伪造、可审计的 invocation grant |
| 文件 artifact 未统一 | `runtime-observation-service.ts` 主要保存 JSON evidence；`src/main/download.ts` 主要在内存跟踪 | 需要 file-backed payload 和生命周期服务 |
| Site Adapter 消费方静态依赖 | `site-capability-catalog.ts`、Lab、Repair Studio、governance snapshot、release gate/canary 直接或间接读取 `officialSiteAdapters` | 需要统一动态 registry，并同步生成快照和门禁 |
| 长能力没有通用恢复合同 | `helpers.taskQueue` 是进程内队列；`TaskPersistenceService` 明确是 legacy facade；Scheduler 面向定时触发 | 需要可选 Capability Run，而不是全局业务 Job 表 |
| 插件可写主库裸 SQL | `namespaces/database.ts` 的 `executeSQL()` 无 datasetId 时直达主库；`DatabaseError` 可携带 SQL/params/record/updates 等业务值 | 必须收紧状态存储和错误边界 |

## 5. 本次架构校准决策

| 旧方向 | 本次决策 |
| --- | --- |
| Profile 身份全局永久不可变 | 改为 Runtime 严格校验和显式 transition policy；有登录数据时优先新建 Profile，但不把产品策略写死在类型中 |
| 框架统一管理每个业务 origin 状态 | 框架只管理 `profile + site` 登录健康及 runtime snapshot；业务可维护更细的 origin/权限投影 |
| 强制每插件独立 DuckDB 文件 | 只规定 namespace、事务、migration、不可越权；物理隔离方案由实现 spike 决定 |
| 新建 Plugin Capability Runtime | 复用现有 Orchestration Capability Runtime，插件只是新的 provider 来源 |
| 新建独立 File Artifact Store | 扩展现有 Runtime Artifact/FailureBundle，增加 file-backed payload |
| 框架统一 Operation Plan/Plan Item | 移除；框架只提供 confirmation grant，业务 preview/plan 留在插件 |
| 框架统一 Job/Partition/Item/Attempt | 移除；只提供可选 Durable Capability Run 和 checkpoint/attempt 基元 |
| 删除插件所有细分登录状态表 | 移除；只禁止把插件投影冒充框架登录健康 |
| 白牌构建进入 v4 核心路线 | 移到独立发行平台计划 |

## 6. 整改工作包

### F-01：统一 Plugin SDK 合同与页面隔离

性质：插件平台基础；优先级 P0，因为 C-01/C-06 依赖它。

#### 目标

- 只有一个版本化的 Plugin SDK 类型出口。
- `activate(context)`、`context.helpers`、API 注册和 dispose 在类型与运行时完全一致。
- 插件页面使用独立 session partition。
- 页面 RPC 保留结构化错误、调用来源和不可伪造的 caller identity。
- 业务写动作通过 Capability Runtime，不通过任意插件 API 逃逸。

#### 整改

1. 合并 `context.ts`、`types/index.ts`、`js-plugin.d.ts` 的重复公开类型。
2. manifest 强制 `pluginApiVersion`；不支持的版本直接拒绝加载。
3. 统一 `context.helpers` 是否公开、`exposeAPI` 注册签名、晚注册策略和 dispose 顺序；类型、示例和运行时必须同源生成或同测。
4. API 参数和结果执行 schema/serializable 校验，重复注册、activate 后异步注册和 registry 同步必须有明确语义。
5. preload 绑定 pluginId 和 caller source，页面不能指定其他插件身份；主进程必须校验调用来自该插件页面/会话。
6. 注入脚本使用 JSON 编码 pluginId/apiList，不把 pluginId 直接拼进 JS 字符串。
7. 将 `persist:plugin-page-shared` 改为每插件独立 partition；共享 view 如需复用，切换插件时必须重建 session 边界。
8. API 错误统一转换为安全 DTO，不把 SQL、params、record、updates、Cookie、token、raw header 或 stack 传给页面。

#### 验收

- 示例插件只依赖一个 SDK 类型即可 typecheck、激活、注册和 dispose。
- 两个插件页面的 localStorage、IndexedDB、CacheStorage 互不可见。
- 插件 A 页面无法通过 preload 或 `window.pluginAPI` 调用插件 B 的 API。
- UI 不能通过通用插件 API 调用未授权 high-risk handler。

### F-02：收紧插件状态存储边界

性质：插件平台基础；P0 先封住主库越权，P1 再补关系状态能力。

#### 目标合同

```ts
interface PluginStateStore {
  migrate(migrations: PluginMigration[]): Promise<void>;
  query<T>(statement: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(run: (tx: PluginStateTransaction) => Promise<T>): Promise<T>;
}
```

合同只规定：

- pluginId namespace 隔离。
- migration id/checksum 和原子执行。
- 参数化查询和显式事务。
- 安全错误 DTO。
- 插件不能 attach、查询或删除其他插件/框架表。

不在本计划中预先决定使用“独立数据库文件”还是“主库隔离 schema”。实现前以并发、备份、卸载、DuckDB attach 安全和故障恢复做 spike，再选择物理方案。

#### 整改

1. 删除插件侧无 dataset scope 的主库裸 `executeSQL()`。
2. `helpers.database` 只保留 Dataset 语义；插件状态进入独立 `state` namespace。
3. DatabaseError 公共序列化不得包含 SQL、params、value、record、updates 或其他业务明文。
4. 简单插件仍可使用 KV storage；只有声明 relational state 的插件才启用 migration/transaction。

#### 验收

- 插件无法访问框架表或另一插件状态。
- migration 中断完整 rollback，checksum 冲突阻止插件进入可写状态。
- 敏感 SQL/params/value/record/updates fixture 不进入 API、Trace、Failure Bundle 或日志。

### C-01：插件贡献现有 Capability Runtime

性质：v4 核心；优先级 P0。

#### 原则

不新增 `PluginCapabilityDefinition` 或第二个执行器。插件贡献必须直接生成现有：

```ts
interface RegisteredCapability {
  definition: OrchestrationCapabilityDefinition;
  handler: CapabilityHandler<OrchestrationDependencies>;
}
```

definition 继续使用现有字段：name、version、input/output schema、requires、requiredScopes、idempotent、retryPolicy、sideEffectLevel、assistantGuidance、assistantSurface。

#### 目标设计

```text
BuiltInCapabilityProvider ─┐
PluginCapabilityProvider  ─┴─> CapabilityRegistry instance
                                  -> OrchestrationExecutor
```

本轮只实现 built-in 与本地 first-party plugin provider，不实现远程 provider。

#### 整改

1. 将模块加载时静态 map 改为可注入 provider 的 registry instance。
2. 现有 catalog factories 作为 built-in provider 保留。
3. manifest 只声明 capability 元数据；activate 时绑定 handler，二者不一致则激活失败。
4. 插件 disable/reload/uninstall 时原子注销其 capability，并更新 registry version。
5. 所有来源进入同一个 executor pipeline：scope、schema validation、confirmation、idempotency、retry；observation 由统一 span/event/failure evidence 包裹，若改成 middleware 必须保持 trace 语义不变。
6. provider 注册必须复用现有 metadata validation、duplicate detection、assistant guidance/surface 默认值和 public capability schema parity。
7. assistantSurface 决定 Agent/MCP/Plugin UI/Workflow 可见性；插件 capability 默认只对本地 Plugin UI/Workflow 可见，不默认 `publicMcp`。
8. MCP HTTP adapter、OpenAPI/assistant manifest、generated snapshot 和 release gate 必须从同一个 registry view 读取 surface。
9. `cross_plugin_call_api` 保留为受控兼容/诊断面，不作为默认 Agent 业务工具，也不能绕过 capability policy。

#### 验收

- 同一 executor 可调用 built-in 和 plugin capability，返回结构完全一致。
- 插件能力禁用后立即从对应 surface 消失且不可新调用。
- 重名、版本非法、schema 缺失、schema 非法、scope 缺失和 surface 越权在注册期失败。
- invocation args/result 未通过 schema validation 时 handler 不执行或结果被安全失败包装。
- registry 更新不会产生“catalog 已更新但 handler 仍旧”的中间态。

### C-02：Profile 登录健康与人工接管

性质：v4 核心；优先级 P0。

#### 通用状态

框架登录健康以 `profileId + site (+ accountId)` 为逻辑键，并保存 `runtimeIdSnapshot` 和 `revision`。如果 Profile 当前 Runtime 与 snapshot 不一致，或 revision 被 Profile/Runtime 生命周期推进，该状态自动视为失效，不能继续作为 logged_in 证据。

```ts
interface ProfileLoginHealth {
  profileId: string;
  site: string;
  accountId?: string;
  runtimeIdSnapshot: BrowserRuntimeId;
  revision: number;
  status:
    | 'logged_in'
    | 'needs_manual_login'
    | 'captcha'
    | 'two_factor'
    | 'blocked'
    | 'expired'
    | 'unknown';
  verified: boolean;
  checkedAt: string;
  verifiedAt?: string;
  verifiedBy?: 'profile_service' | 'capability' | 'trusted_site_adapter_verifier';
  loginUrl?: string;
  reasonCode?: string;
  evidenceArtifactId?: string;
}
```

具体平台的多 origin 激活、业务权限和账号字段解释不进入该模型；如需区分账号，只保存宿主 accountId 引用。

#### 接管语义

```text
自动控制者持有 Profile
  -> 人请求接管
  -> 框架展示 owner/trace/capability 摘要
  -> 原控制者进入可暂停点
  -> 保活式 handoff，不销毁浏览器
  -> 人完成登录或取消
  -> Verifier 更新登录健康
  -> 原 Capability 决定继续、等待或失败
```

#### 整改

1. 复用 `ProfileLoginStateService`，补唯一约束、revision 和 runtime snapshot 失效规则。
2. 提供正式 login-health gateway；只有 Capability/Profile service/受信 Site Adapter Verifier 能记录验证结果，普通插件只能读取或请求验证。
3. 统一 interactive session 生命周期，UI 只获取 sessionId，不获取 browser handle。
4. 登录验证复用当前 interactive browser，不再次获取同 Profile lease。
5. owner snapshot 增加 controller kind、pluginId、capability、traceId、acquiredAt、interruptibility。
6. 明确 `show`、`requestHandoff`、`completeHandoff`、`cancelHandoff`，禁止静默抢占人在使用的 Profile。
7. 插件停用、窗口关闭、超时和应用退出统一释放 session/lease。

#### 验收

- `profile_ensure_logged_in`、Runtime Planner、Plugin Capability 和 UI 读取同一份框架登录健康。
- 人与自动化不会同时写同一 Profile。
- Runtime 变化后旧 logged_in 记录不能通过健康检查。
- 验证码、2FA 和风控只能进入人在环流程，不能被自动绕过。

### C-03：Runtime-aware Profile Session I/O

性质：v4 核心；P0 完成 authenticated request，P1 完成统一 download。

#### 定位

这是 BrowserRuntime/Profile session 能力，不是业务 endpoint service。框架负责在 Profile 会话内执行受控请求和下载；插件 Capability 负责 URL/endpoint 选择、平台业务码分类和领域重试策略。

#### 目标接口

```ts
await profileSessionGateway.withSession(
  {
    profileId,
    site,
    requiredCapabilities: ['network.sessionRequest'],
    intent: 'read',
  },
  async (session) => {
    const response = await session.request({
      url,
      method: 'GET',
      timeoutMs: 30_000,
      maxResponseBytes: 2_000_000,
    });
  }
);
```

`network.sessionRequest` 应成为 Browser capability matrix 的正式 requirement，由每个 Runtime provider 明确 supported/stability/notes；不得通过 Runtime 名称猜测。

#### 通用安全边界

- Cookie、Authorization、Set-Cookie 和浏览器 storage 不返回插件。
- 默认插件 Browser façade 删除 `getCookies/setCookie/clearCookies` 等原始凭据方法；宿主内部如需 Cookie 能力，只能走不对插件公开的受控 gateway。
- 默认插件 Browser façade 不暴露 raw `evaluate/evaluateWithArgs`、request interception control 和可改写网络请求的底层接口；需要页面语义动作时通过 Capability 或受控 Site Adapter Procedure。
- URL 必须命中 capability/plugin 声明的 network scope；同源约束默认开启。
- request header 使用 allowlist；插件页面不能直接传入 raw Cookie/header。
- response body 有大小和类型限制；默认不返回敏感响应头。
- write intent 必须处在 Capability execution context，并经过 scope 和 confirmation middleware。
- transport 只分类 timeout、network、redirect、response-too-large 等通用错误；平台业务错误留给插件。
- session 生命周期、origin 切换和并发由 ResourceCoordinator/Runtime provider 管理。

#### Download

下载复用 runtime `download.manage` 能力，并将完成结果写为 C-04 的 file-backed artifact；不向插件暴露任意保存路径或底层 DownloadItem。

#### 验收

- 至少两个 Runtime provider 通过同一 request contract；不支持者由 descriptor 明确拒绝。
- 插件代码无法取得 raw Cookie 后转交普通 HTTP client。
- URL scope、跨 origin、危险 header、正文超限、取消和 lease 释放均有 contract test。
- 下载返回统一 artifact reference，可进入 Trace/Failure Bundle。

### C-04：统一 Artifact 文件后端与 Provenance

性质：v4 核心闭环；优先级 P1，C-03 download 前需完成最小版本。

#### 原则

不新增与 Runtime Artifact 平行的业务文件系统。现有 Artifact 增加 payload 形态：

```ts
type ArtifactPayload =
  | { kind: 'inline'; data: unknown }
  | {
      kind: 'file';
      storageKey: string;
      contentAddress?: string;
      filename: string;
      mimeType?: string;
      sizeBytes: number;
      sha256: string;
      retentionPolicy?: string;
    };
```

公开 DTO 不暴露实际 storage path。Artifact 继续携带 traceId、capability、pluginId、profileId、datasetId、runtime、source 和 sensitivity/retention metadata。

#### 整改

1. 扩展 observation artifact schema/service，支持 file-backed payload 和 artifact refs。
2. 建立框架托管目录、stream 写入、临时文件原子提交、hash 和磁盘空间检查。
3. 提供受控 open/reveal/saveAs/delete；调用方只能提交 artifactId。
4. FailureBundle 能包含 file artifact ref，而不是把大文件塞入 JSON data。
5. Capability 写 Dataset 或 Artifact 时继承同一 TraceContext，并写入现有 dataset provenance/run ledger；dataset provenance 可保存 artifactRefs，但不保存真实文件路径。
6. retention 和清理以 artifact type/source/createdAt 为依据，只删除托管目录内文件。
7. repair bundle、下载、截图、失败导出使用同一个 artifact service。

#### 验收

- 下载、截图、失败证据和 repair bundle 都能通过统一 artifact API 查询。
- 文件在重启后仍可定位，路径穿越和符号链接逃逸被拒绝。
- 从 Dataset 记录可以追溯 capability、adapter、runtime/profile、trace 和 artifact。
- Failure Bundle 与 file artifact 互相引用，不出现第二套孤立文件表。

### C-05：Capability 确认授权

性质：v4 安全边界；任何 built-in 或 plugin high-risk/destructive Capability 上线前必须完成，优先级 P0。

#### 目标

将 `confirmRisk: true` 替换为 executor middleware 校验的 confirmation grant：

```ts
interface CapabilityConfirmationGrant {
  grantId: string;
  invocationId: string;
  capability: string;
  capabilityVersion: string;
  argumentsHash: string;
  policyHash: string;
  principal: string;
  source: 'plugin-ui' | 'workflow-ui' | 'agent-ui';
  sessionId: string;
  scopes: string[];
  idempotencyKey?: string;
  previewRef?: string;
  expiresAt: string;
}
```

业务 preview、plan、target item 和规则 hash 由插件生成；框架只验证 grant 与最终 Capability invocation 是否一致。

#### 整改

1. 在现有 orchestration middleware chain 增加 confirmation middleware。
2. 根据 sideEffectLevel、destructiveHint、requiredScopes 和 capability policy 判断是否需要 grant。
3. grant 只能由受信本地交互面签发，绑定 capability/version/arguments hash/principal/session/scopes。
4. grant 短时有效、不可跨 session 使用；同一 invocationId 幂等关联，不能被另一调用消费。
5. 可选 previewRef 指向 Artifact 或插件 plan，但框架不解析业务 preview。
6. Dataset/Profile/Plugin/Site Adapter 等所有现有 high-risk catalog 移除公开裸 `confirmRisk`，改读 executor 注入的授权结果。
7. Site Adapter Procedure 不再自行接受裸 `confirmRisk`；它继承 Capability execution context 的授权结果。
8. confirmation grant 与 idempotency/retry 的顺序写入合同：重试不重复消费 grant，参数变化必须重新确认。

#### 验收

- 伪造布尔参数、跨 Capability、改参数、过期、跨 session 和重复抢占 grant 全部失败。
- built-in 与 plugin Capability 使用同一确认 middleware。
- 确认记录可从 Trace 审计，但不保存敏感明文。
- MCP/HTTP/Plugin UI/Workflow 调用同一 high-risk 能力时得到一致的授权失败形态。

### C-06：插件贡献 Site Adapter Pack

性质：v4 扩展能力；优先级 P1。

#### 目标

新增统一 `SiteAdapterRegistry`，所有 adapter 消费方依赖 registry，而不是直接读取 `officialSiteAdapters`。

```ts
interface RegisteredSiteAdapter {
  module: SiteAdapterModule;
  source: 'built-in' | 'plugin';
  pluginId?: string;
  packageRoot: string;
  trusted: boolean;
}
```

#### 整改

1. built-in adapters 作为 registry provider 注册，保留现有模块格式。
2. 插件 manifest 声明 adapter entry，加载时校验路径、manifest、capability 引用和 repairScope。
3. Site Capability catalog、Runner、Lab、Repair Studio、governance snapshot、release gate、canary suite selection 和 repair-scope matrix 全部通过 registry 查询。
4. 插件 disable/reload/uninstall 时注销 adapter 和派生 capability。
5. adapter id 全局唯一；本轮不允许静默 override 或按 latest 猜版本。
6. 插件 adapter 加载必须经过 packageRoot/path 约束、import boundary 和 sandbox policy；不能通过相对路径逃逸到 framework core。
7. 插件 adapter 仍只能使用 Site Adapter Runtime 受控接口，不能访问 secrets、Node API、Dataset 或 Artifact 写入口。

#### 验收

- built-in 与 plugin adapter 通过同一 Runner、fixture、browser canary 和 repairScope gate。
- 插件禁用后 adapter、派生 capability、Lab 和 Repair 入口同步消失。
- governance snapshot、release gate 和 status summary 不再依赖静态 `officialSiteAdapters` 真相源。
- 路径逃逸、重复 id、越权 repair path 和 capability/adapter 版本不匹配均在注册期失败。

### C-07：可选 Durable Capability Run

性质：通用长能力执行基元；优先级 P1。短能力继续直接使用现有 executor。

#### 边界

框架只提供：

```text
CapabilityRun
  -> provider/capability/version/inputHash
  -> status
  -> checkpoint
  -> attempt timeline
  -> resource keys
  -> cancellation signal
  -> trace/artifact refs
```

框架不提供通用 shop partition、order item、product attempt 或营销对账表。插件需要批量明细时，使用 F-02 状态存储维护领域数据，并把 runId/traceId 作为关联键。

#### 目标接口

```ts
interface DurableCapabilityHandler {
  start(context: CapabilityRunContext): Promise<CapabilityRunResult>;
  resume?(checkpoint: unknown, context: CapabilityRunContext): Promise<CapabilityRunResult>;
  reconcile?(checkpoint: unknown, context: CapabilityRunContext): Promise<CapabilityRunResult>;
  cancel?(checkpoint: unknown, context: CapabilityRunContext): Promise<void>;
}
```

#### 整改

1. 新增 capability run 与 attempt/checkpoint store，不复用 legacy `tasks` 表；可复用 SchedulerService/ScheduledTaskService 的执行、恢复和资源序列化基元，但 CapabilityRun 拥有独立合同。
2. run 固定 providerId、pluginVersion、capabilityVersion、inputHash、confirmation grant、idempotencyKey 和 traceId。
3. resourceKeys 接入 ResourceCoordinator；框架不理解 key 的业务含义。
4. handler 显式声明 resume/reconcile 能力；没有恢复合同的副作用 run 在重启后进入 manual review。
5. 取消是协作式 AbortSignal；框架不把已发出的副作用伪装成 cancelled-before-effect。
6. provider/version 不匹配时暂停，不调用新 handler 猜测恢复。
7. 原有 taskQueue 明确定位为 ephemeral concurrency helper；`TaskPersistenceService` 保持 legacy-persistence-only 或删除需单独审计，不作为本工作包的前置动作。

#### 验收

- 同一个 long-running Capability 可在进程退出后按自身合同 resume 或进入 reconciliation。
- 短 Capability 不承担 durable run 的额外复杂度。
- 重启恢复、正在运行 execution 取消标记、资源键重入和 handler 缺失都有确定状态。
- 不同行业插件可复用 run/checkpoint/resource/cancel，而无需采用同一种 item/partition schema。

## 7. 不进入核心计划的配套方向

### 7.1 白牌与发行平台

构建身份参数化是合理需求，但应独立成发行平台计划，内容包括 brand overlay、appId、productName、userDataKey、图标、update channel 和 Shell theme。它不参与 Capability、Profile 或 Site Adapter 的运行时语义。

### 7.2 插件包与扩展包在线更新

现有安装器、扩展包 manager、hash 和回滚能力继续单独演进。本计划不新增远程 JS、规则热更新、插件 update manifest 或命令式扩展安装 API。

### 7.3 业务 Job/Plan

插件可以基于 F-02 和 C-07 实现领域 Plan、批次、item、对账和失败导出。只有当至少两个不相关领域证明某一状态或转换完全相同时，才重新评估是否上浮。

## 8. 实施阶段

### Phase 0：收拢现有主干

1. F-01 统一 Plugin SDK、页面隔离和页面 caller identity。
2. 在现有 executor 中补 schema validation 和 C-05 confirmation middleware。
3. F-02 先关闭插件主库裸 SQL 越权入口，并统一敏感错误 DTO。
4. C-02 打通 Profile login health gateway、runtime snapshot/revision 和人工 handoff。
5. C-01 将 Capability catalog 改为 provider/registry instance，先接 built-in provider，再开放 first-party plugin provider。

退出条件：插件提供的业务动作只能通过现有 Capability Runtime 执行；Profile 登录、schema validation、high-risk 确认、插件页面 identity 和插件状态存储不存在旁路。

### Phase 1：Runtime I/O 与证据闭环

1. C-03 增加 `network.sessionRequest` runtime capability 和 Profile-bound gateway。
2. C-04 增加 file-backed artifact，并贯通 Trace、Failure Bundle、Dataset provenance。
3. C-03 完成 download → artifact。
4. C-06 建立 SiteAdapterRegistry，并迁移 catalog/Lab/Repair/snapshot/release gate/canary consumers。

退出条件：同一 Capability 可跨 Runtime 复用登录会话、adapter 和文件证据，失败能进入统一 Failure/Repair 闭环。

### Phase 2：长能力与关系状态

1. C-07 实现可选 Durable Capability Run。
2. F-02 完成 namespaced relational state、migration 和 transaction。
3. 用至少两个无关插件验证 run/store 合同没有领域耦合。

退出条件：长能力可恢复，但框架 schema 中不存在店铺、商品、订单等业务概念。

## 9. Release Gate

### 9.1 架构门禁

- 任何新业务入口都能映射到一个 `OrchestrationCapabilityDefinition`。
- 不存在第二套 Capability executor、第二套 artifact taxonomy 或第二套 Profile login truth。
- Capability invocation args/result 必须经过同一运行时 schema validation；只有 schema metadata/parity 测试不算完成。
- Site Adapter 不选择 Profile/Runtime，不直接写 Dataset/Artifact，不访问 secrets/Node API。
- Runtime 选择只依赖 descriptor、probe、required capabilities 和 Profile 状态，不依赖 runtime 名称猜测。
- Plugin UI 的业务写动作不能绕过 capability schema、scope、confirmation 和 observation。

### 9.2 通用性门禁

- 工作包接口中不得出现特定站点、店铺、商品、订单、营销、报表平台等领域词。
- 至少使用两个 Runtime 验证 C-03。
- 至少使用 built-in adapter 与 plugin adapter 验证 C-06。
- governance snapshot、assistant/MCP surface、runtime capability matrix、repairScope matrix 和 release gate 均从同一 registry/source 生成。
- C-07 必须用两个结构不同的长能力验证，框架表中不得出现业务 partition/item schema。
- 业务样本只出现在 fixture/consumer test，不出现在框架类型和表名。

### 9.3 安全与故障门禁

- Cookie、Authorization、token、raw header、SQL/params/value/record/updates 不进入 API、Trace、Artifact metadata 或 Failure Bundle。
- 插件页面 caller identity 覆盖跨插件 API 调用、共享 view 切换、刷新、reload 和恶意 renderer 传参。
- Profile handoff 覆盖人工优先、拒绝、超时、暂停、恢复和应用退出。
- confirmation 覆盖参数篡改、过期、跨 session 和并发消费。
- file artifact 覆盖磁盘满、路径穿越、符号链接和孤儿临时文件。
- durable run 覆盖 checkpoint 前后强杀、版本不匹配、取消和 reconcile。

### 9.4 权威证据

实现状态不在本文手工打勾。完成情况以以下证据为准：

- 代码和测试。
- 生成的 capability matrix、assistant/MCP surface、runtime capability matrix、repairScope matrix。
- release gate 和 browser canary artifacts。
- 文档只记录架构决策、缺口和验收条件，不复制容易漂移的运行时事实。

## 10. 明确非目标

- 不把任一业务插件的完整稳定闭环搬进框架。
- 不为业务 preview、plan、partition、item 或 reconcile 建统一领域模型。
- 不自动绕过验证码、短信、2FA 或风控。
- 不跨 Profile/Runtime 复制 Cookie 或浏览器 storage。
- 不向 Agent 暴露 raw Playwright、raw evaluate、raw Cookie 或任意文件写。
- 不让插件 Site Adapter 修改 framework core、Capability core 或 schema 权威源。
- 不实现远程未签名 JS/CSS/HTML、规则包热更新或完整插件市场。
- 不把白牌品牌和安装包身份混入 v4 运行时能力。

## 11. 第一批任务

1. 修正 Plugin SDK 的 `PluginContext/helpers/API` 类型分裂，隔离插件页面 partition，并给 preload/API 调用绑定不可伪造的 plugin caller identity。
2. 在现有 orchestration executor 中补 schema validation middleware 和 confirmation grant middleware，替换内置高风险路径的裸 `confirmRisk`。
3. 关闭插件主库裸 `executeSQL()` 越权入口，定义 `state` namespace 和安全错误 DTO。
4. 将 unified catalog 和 orchestration registry 从模块静态快照改为 provider 驱动的实例，保持单 executor，并让 MCP/OpenAPI/snapshot/release gate 从 registry view 生成。
5. 为 `ProfileLoginStateService` 定义 `profileId + site (+ accountId) + runtime snapshot + revision` 合同，接入插件 Capability 和受信 Site Adapter Verifier。
6. 在 ResourceCoordinator/Profile lease 上补完整 owner 与 request-handoff 协议。
7. 设计 `network.sessionRequest` Browser capability contract，并对 Electron/Extension 做 semantic spike。
8. 为现有 Runtime Artifact 设计 file-backed payload，不新建第二套 artifact service。

完成这批任务后，再分别推进动态 Site Adapter Pack 和 Durable Capability Run。整个过程中，业务需求只负责证明框架合同是否足够，不负责定义框架合同本身。
