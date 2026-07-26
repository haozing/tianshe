# 商机提报吞吐、限频自适应与任务恢复设计

> 状态：已结合当前代码审计修订，尚未实施
>
> 更新日期：2026-07-25
>
> 实施范围：`remote-web/client-shell` 提报流水线、Electron 本地任务数据权限、抖店适配器配置和诊断日志
>
> 相关基线：[商机全量扫描与关联缓存分析](./chihu-opportunity-full-scan-association-cache-analysis.md)

## 一、目标与非目标

### 1.1 目标

1. 在不主动撞击平台限频的前提下，缩短从任务开始到全部可提报候选处理完成的总时间。
2. 将限速控制从固定等待改为按店铺、按响应动态调整。
3. HTTP 429 或业务频控发生后，只暂停当前店铺，不丢弃该店铺剩余候选，也不阻塞其他店铺。
4. 软件重启、worker 崩溃或网络异常后，可以从持久化检查点继续，而不是重复提交或静默跳过。
5. 将冷启动的报名历史同步、商品扫描、商机加载和提交阶段串行空闲时间转化为可控的流水线重叠。
6. 保留现有“报名记录过滤、商品满额索引、提交结果反向更新和幂等恢复”语义。

### 1.2 非目标

- 不绕过抖店平台的频率限制。
- 不把不同 `clue_id` 合并到同一个提交请求；提交接口的请求体只支持一个商机词。
- 不为了共享缓存而把 `tenantId = local-user` 当成真实租户。
- 不使用无限重试掩盖平台长期故障、店铺掉线或接口契约变化。
- 不在本设计中改变商品、报名历史和多类目 5 页覆盖门禁的业务规则。

## 二、当前运行证据

### 2.1 2026-07-25 两店运行

运行 ID：`opportunityPipelineSubmit-1784949154328-12cdb91f2f57`

> 证据边界：本节数值来自已脱敏的运行诊断摘要；原始诊断导出不在仓库中。涉及参数上线或阈值调整时，必须归档对应的脱敏导出及校验摘要，否则仅可作为待验证假设，不能作为阈值依据。

| 指标 | 结果 |
| --- | --- |
| 总耗时 | 18 分 18.971 秒 |
| 准备阶段（启动到提交 worker） | 约 7 分 28 秒 |
| 提交阶段 | 约 10 分 51 秒 |
| 计划候选 | 80 |
| 成功 | 52 |
| 失败 | 1 |
| 远程提交请求 | 58 |
| HTTP 429 响应 | 8 |
| 429 等待总时长（两店相加） | 约 4 分 44 秒，等待时间有重叠 |

店铺 `249967089` 发出 43 次请求，4 次 429，累计等待 156.79 秒，最终成功 41 个商品。店铺 `250546744` 发出 15 次请求，4 次 429，累计等待 126.985 秒，最终只成功 11 个商品，之后因为最终 429 停止本店后续提报。

两店请求的 HTTP 延迟平均约 0.3 秒，正常请求启动间隔约 11-14 秒。因此提交阶段的主要耗时不是网络，而是固定节奏和 429 退避。被限频的店铺等待时，另一家店铺仍在成功提交，说明不能使用全局停机式退避；但目前被限频店铺会一直占用一个 worker 槽位。

### 2.2 准备阶段证据

- 两家店的首次报名历史各约 3 万条，历史窗口完成时间距离任务开始约 6 分 24 秒。
- 历史读取并发为 2 时已经出现多次 HTTP 200 但业务码 500（“系统繁忙，请重试”）。提高历史读取并发不是安全的提速方向。
- 8 个类目商机在两店返回了相同规模的数据，但由于当前缓存作用域是店铺级且租户为 `local-user`，相同类目被分别请求。不能直接改成全局缓存，必须先取得真实租户标识。

### 2.3 当前代码造成的空闲和阻塞

- [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:5900) 的重试等待在店铺任务内部同步执行。
- [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:8058) 最终 429 会设置 `submitThrottleReason`，后续候选直接变为 skipped。
- [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:8152) 每个批次后等待一次，最后一个成功批次也会等待。
- [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:7532) 的 worker 槽以店铺任务为单位；店铺在 30/60 秒退避时仍占据槽位。
- [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:8620) 将商品扫描、报名历史、类目准备作为第一阶段，所有店铺完成后才开始第二阶段的商机加载和匹配。

## 三、总体方案

```text
商品扫描/报名历史准备
          |
          v
类目需求汇总（保持覆盖策略正确）
          |
          v
按店铺加载商机 -> 本地匹配 -> 生成 ready 提报任务
          |                         |
          |                         +--> 后续店铺继续准备
  v
Electron 主进程 SubmitScheduler（持久化 lease / 准入）
  |-- ready：取得店铺和全局 mutation 准入后提交
  |-- cooling_down：释放执行槽，等待 nextEligibleAt
  |-- deferred：超过本次运行预算或等待授权，保留剩余候选
  `-- 每个提交组持久化检查点、结果和恢复契约
```

核心原则是：

1. **店铺限速独立**：一个店铺 429 不暂停其他店铺。
2. **任务不丢失**：429 只把未完成候选放回该店铺的持久化队列。
3. **状态先持久化、结果后推进**：远程请求前在一个本地事务中记录 `sending`、提交组和检查点；响应后在一个本地事务中写结果、速率状态和游标。
4. **总时间优先**：让已准备好的店铺先提交，同时其他店铺继续本地匹配和必要读取。
5. **平台信号优先**：任何 429、`Retry-After` 或明确业务频控都必须提高该店铺的后续间隔；不为了追求单次运行时间而连续撞击平台。
6. **主进程拥有调度权**：渲染进程只执行被授予的一个请求；它们的模块级队列不能承担跨 `BrowserWindow`、重启或后台恢复的全局互斥职责。

当前 Electron 任务管理器会为任务创建独立的隐藏 `BrowserWindow`，并可同时运行多个 runner。因此 [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:8351) 的 `pipelineSubmitWorkerTail` 只能防止同一渲染进程内重入，不能保证整个应用只有一个 scheduler。全局调度、同店互斥、恢复唤醒和 mutation 准入必须位于 Electron 主进程，并以数据库 lease/事务为最终裁决。

## 四、自适应提交限速器

### 4.1 持久化状态

新增店铺级逻辑 store：`opportunity_submit_rate_state_v1`。记录键包含 `tenantId + shopId + storeGeneration`，删除店铺时级联删除。

```ts
type SubmitRateState = {
  id: string;
  tenantId: string;
  shopId: string;
  storeGeneration: number;
  mode: "normal" | "cooling_down" | "deferred";
  policyVersion: string;
  intervalMs: number;
  lastAdmittedAt?: string;
  nextEligibleAt?: string;
  consecutiveSuccesses: number;
  consecutive429: number;
  cooldownCount: number;
  cooldownStartedAt?: string;
  cooldownUntil?: string;
  last429At?: string;
  lastHttpStatus?: number;
  lastMessage?: string;
  updatedAt: string;
};
```

该状态不是提交事实源。它只控制调度节奏，提交事实仍由提报尝试记录、候选状态和报名历史索引共同决定。

同时新增全局逻辑 store：`opportunity_submit_global_rate_state_v1`，键为 `tenantId + endpointContract`，至少保存：

```ts
type SubmitGlobalRateState = {
  id: string;
  tenantId: string;
  endpointContract: string;
  mode: "inactive" | "protective";
  policyVersion: string;
  intervalMs: number;
  burstSpacingMs: number;
  lastAdmittedAt?: string;
  nextEligibleAt?: string;
  rolling429Buckets: Array<{ windowStartedAt: string; shopIds: string[] }>;
  consecutiveAffectedWindows: number;
  consecutiveStableWindows: number;
  updatedAt: string;
};
```

全局状态在正常情况下保持 `inactive`，只使用很短的 `burstSpacingMs` 防止多个店铺在同一时刻突发；它不能把店铺级 15 秒节奏串行化。只有同一统计窗口内达到“不同店铺数”阈值时才进入 `protective` 并使用 `intervalMs`；同一店铺重复 429 不得单独触发全局降速。该状态、店铺状态和 mutation 准入必须由 Electron 数据库事务更新，不能用渲染进程内存令牌替代。

### 4.2 初始参数和调节策略

建议先以配置值落地，运行中通过诊断数据校准：

```text
submitPacingMode                 = adaptive
submitPacingInitialIntervalMs    = 15000
submitPacingMinIntervalMs        = 10000
submitPacingMaxIntervalMs        = 60000
submitPacingJitterMs             = 1500
submitPacingSuccessesToDecrease  = 8
submitPacingDecreaseMs           = 1000
submitPacing429Multiplier        = 1.5
submitPacingMaxCooldownMs        = 120000
submitStoreThrottleBudgetMs      = 1800000   # 单店本次运行最多暂停 30 分钟
submitGlobalBurstSpacingMs       = 500
submitGlobalPacingInitialMs      = 15000
submitGlobalPacingMaxMs          = 60000
submitGlobalPacing429Multiplier  = 1.5
submitGlobalPacingDecreaseMs     = 5000
submitGlobal429WindowMs          = 120000
submitGlobal429DistinctStores    = 2
submitGlobalStableWindowsToExit  = 2
submitDailyHttpRequestLimit      = 1000
```

调节规则：

1. 首次提交使用 `initialIntervalMs`，店铺之间增加确定性错峰和小随机抖动。
2. 每个成功的远程请求组只增加一次 `consecutiveSuccesses`，不能按组内商品数累加；连续达到 8 次时只减少 1 秒，不能一次恢复到 10 秒。
3. HTTP 429、响应头 `Retry-After`、或明确的业务频控错误都进入限速处理：
   - 下一次尝试时间至少遵守 `Retry-After`；没有该响应头时使用 30 秒、60 秒的指数退避并加小抖动；
   - `submitPacingMaxCooldownMs` 只封顶本地生成的退避，不得截短平台给出的更长 `Retry-After`；
   - 下一次普通提交间隔至少乘以 1.5，且不低于 15 秒；
   - 连续 429 时继续提高间隔，封顶 60 秒；
   - 成功后不立即恢复高速，必须经过连续成功窗口才缓慢下降。
4. “明确业务频控”必须由经过契约测试的业务码/消息白名单识别。“环境存在风险”、验证码/身份校验、登录失效、权限不足和契约不匹配不属于短期限频，禁止直接进入自动 cooling 重试。
5. 非频控的业务失败不改变店铺节奏，但仍按原有可重试/不可重试分类处理。
6. 429 统计按店铺和全局分别维护。统计窗口按 UTC epoch 固定分桶，默认只有最近 2 分钟窗口内至少 2 家不同店铺出现 429 才把全局状态切换为 `protective`；单店 429 不得让其他店铺全局停顿。protective 下每个受影响窗口把全局间隔乘以 1.5 并封顶 60 秒；每个完整无 429 窗口下降 5 秒。间隔回到初始值且至少连续 2 个完整窗口无 429 后切回 `inactive`，并清除过期桶。
7. 抖动和店铺错峰值由 `tenantId + shopId + storeGeneration + taskId + logicalGroupId + attemptOrdinal` 确定性生成或直接持久化，重启后不得重新抽样而提前请求。
8. `policyVersion` 变化时只允许显式迁移并把已有 `nextEligibleAt` 向更保守值钳制；不能因升级直接清空冷却。

### 4.3 请求准入

每一个远程提交尝试，包括 429、超时或网络错误后的再次尝试，都必须重新通过以下准入顺序：

```text
店铺 nextEligibleAt
  -> 全局 rate state / mutation token（正常态只防瞬时突发）
  -> 候选 mutation 额度和 HTTP 请求熔断额度预留
  -> 当前候选幂等检查
  -> 原子写入 logical group、request attempt、候选 sending、任务检查点和 rate state
  -> 主进程消费一次性 HTTP 授权并把额度预留转为 dispatched 事实
  -> 发起请求
```

等待放在下一次请求之前，不放在上一次请求之后。这样最后一个批次不再产生无意义的尾部等待，本地结果落库也不会被重复延迟。

店铺最早准入时间为：

```text
max(store.cooldownUntil,
    store.lastAdmittedAt + store.intervalMs + persistedJitter,
    global.mode == protective
      ? global.nextEligibleAt
      : global.lastAdmittedAt + global.burstSpacingMs)
```

准入、额度预留和 `lastAdmittedAt` 更新在同一个 `BEGIN IMMEDIATE` 数据库事务中完成。事务还必须检查同一 `tenantId + shopId + storeGeneration` 是否已有非终态任务；已有 deferred/cooling 任务时优先恢复或合并，禁止为新 run 创建并行任务。现有任务 claim 对 `concurrencyKey` 的约束可以复用，但仅检查 running 任务不足以保护 deferred/cooling 状态。

每日限制拆成两个不能混用的维度：

1. **候选 mutation 额度**：保留当前 `dailyAttemptLimit` 语义。组内每个候选在每次已经派发的远程尝试中各计 1 次；包含 10 个商品的请求计 10 次，429、超时和未知响应也计入。重试前必须再次检查该组全部候选所需额度，不足时不得部分发出同一请求。
2. **HTTP 请求熔断额度**：`submitDailyHttpRequestLimit` 按实际派发的请求计数，一个批次请求只计 1 次，用于限制异常循环和网络请求总量，不能替代候选 mutation 额度。

两个额度都必须在每次 claim/恢复时按当前业务日重新读取。事务 A 只创建带 `quotaReservationId` 的预留，不把尚未交给 native transport 的请求记为已派发；主进程消费一次性 HTTP grant 时，在数据库命令中原子地把预留转换为 `dispatched` 并增加两个计数，然后才调用网络传输。如果崩溃后无法证明 grant 未消费，则按已派发保守计数并进入 unknown/reconcile。跨业务日时，仍处于 cooling/deferred 且可恢复的原任务沿用原 run，并使用新业务日额度；已经收敛为 `quota_exhausted` 的候选不自动重新打开。

## 五、429 后的任务恢复

### 5.1 任务状态扩展

`PipelineSubmitTaskRecord` 增加以下状态和字段：

```ts
status: "preparing" | "ready" | "queued" | "running" | "cancelling" |
        "cooling_down" | "ok" | "partial" | "deferred" |
        "deferred_contract_mismatch" | "manual_reconcile" |
        "failed" | "cancelled" | "expired";

nextCandidateIndex?: number;
inFlightAttemptId?: string;
inFlightLogicalGroupId?: string;
inFlightCandidateIds?: string[];
inFlightAttemptOrdinal?: number;
quotaReservationId?: string;
resumeAt?: string;
throttleCount?: number;
throttlePauseMs?: number;
lastThrottleAt?: string;
retryableRemainingCount?: number;
checkpointVersion?: string;
deferredReason?: "throttle_budget" | "authorization_wait" |
                 "login_wait" | "contract_mismatch" |
                 "retry_exhausted";
requiresExplicitResume?: boolean;
releaseId: string;
releaseManifestHash: string;
runnerArtifactHash: string;
adapterVersion: string;
scriptsVersion: string;
requestPlanHash: string;
submitContractVersion: string;
pacingPolicyHash: string;
adapterSnapshotHash: string;
```

现有候选状态仍是最终事实。`nextCandidateIndex` 只是优化恢复速度，定义为“最小的、候选尚未终态的索引”，不能直接设置为批次中的最大索引。任务恢复时必须重新从候选记录、提交组和报名历史索引确认状态，不能只相信游标。

增加提交组记录 `opportunity_submit_attempt_groups_v1`。一个 group 表示跨 claim 保持稳定的**逻辑批次**，而不是一次 HTTP 请求，至少包含：

```ts
type SubmitAttemptGroup = {
  id: string;                 // logicalGroupId
  taskId: string;
  clueId: string;
  orderedCandidateIds: string[];
  requestPlanHash: string;
  requestBodyCanonicalJson: string;
  requestBodyHash: string;
  retryCycle: number;
  nextAttemptOrdinal: number;
  status: "ready" | "sending" | "retry_waiting" |
          "accepted" | "partial" | "failed" |
          "retry_exhausted" | "unknown";
  attempts: Array<{
    attemptId: string;
    attemptOrdinal: number;
    quotaReservationId: string;
    quotaBusinessDate: string;
    reservedCandidateMutationUnits: number;
    reservedHttpRequestUnits: 1;
    httpGrantId?: string;
    status: "reserved" | "dispatched" | "accepted" |
            "partial" | "throttled" | "failed" |
            "unknown" | "released";
    admittedAt: string;
    grantConsumedAt?: string;
    dispatchedAt?: string;
    resolvedAt?: string;
    responseClass?: string;
  }>;
};
```

`logicalGroupId` 由带版本的规范编码 `H("submit-group:v1", taskId, clueId, 有序 candidateIds, requestBodyHash)` 确定性生成，同一逻辑批次恢复时不得改变。每次真实请求使用 `attemptId = H("submit-attempt:v1", logicalGroupId, retryCycle, attemptOrdinal)`，不能直接拼接可变长字符串；数据库必须对 `(logicalGroupId, retryCycle, attemptOrdinal)` 建唯一约束。

当前 `submitBody` 会把商品标题、图片、类目、库存、销量、价格、店铺和品牌等字段写入请求体。逻辑组创建时必须把不含 Cookie、签名、时间戳等传输期字段的规范化请求体持久化为 `requestBodyCanonicalJson`，并从该字符串计算 `requestBodyHash`。恢复和同组重试必须复用这份快照，由 transport 在派发时补充实时鉴权/签名；禁止只凭候选 ID 从可能已变化的商品记录重新构造请求体。重新去重或授权校验可以阻止派发，但不能静默改写原组快照；确需修改时必须终结旧组并以可审计的新组处理。

`quotaReservationId` 和 `httpGrantId` 均必须唯一。预留记录必须固定业务日和两个额度单位；可证明 grant 未消费时把 attempt 原子改为 `released` 并释放原预留，grant 已消费或无法证明未消费时不得回退计数。一个请求的结果必须应用到该组全部候选；批次 429 时全部候选回到 `retry_waiting`，不能只处理当前游标候选。现有 `opportunity_submit_attempts_v2` 继续保存候选级 mutation 尝试事实，并增加 `throttled` 分类；逻辑组记录负责请求级次数和批次恢复，二者不能互相替代。

### 5.2 单批次状态机

```text
ready/retry_waiting
    |
    v
reserve/admit -> sending（事务 A）
    |
    +--> grant consumed -> dispatched（事务 A2）
    |
    +--> accepted/already_submitted/failed（落库终态）
    |
    +--> unknown -> reconcile -> accepted / retry_waiting / manual_reconcile
    |
    `--> 429 -> retry_waiting + cooling_down
                         |
                         +--> resume -> retry_waiting 再次准入
                         `--> retry limit -> retry_exhausted
```

每个批次的顺序必须是：

1. 新逻辑批次从 `ready` 候选创建；恢复已有逻辑批次时只允许选择该 group 中的 `retry_waiting` 候选。两种情况都要重新执行本地报名索引和本地历史去重，禁止把 `retry_waiting` 与新的 `ready` 候选重新拼成不同请求。
2. 在事务 A 中创建或读取稳定的 `logicalGroupId` 和规范化请求体快照，创建本次 `attemptId` 和额度预留，把组内所有候选写为 `sending`，并更新任务 `inFlightLogicalGroupId`、`inFlightAttemptId`、`inFlightCandidateIds`、`inFlightAttemptOrdinal`、准入时间、速率状态和检查点。
3. 主进程消费一次性 HTTP grant 时执行事务 A2：核对当前 in-flight/group/attempt/lease，原子写入 `dispatchedAt`、候选 mutation 尝试计数、HTTP 请求计数和请求授权使用证据，然后发起远程提交。无法证明 grant 未消费的崩溃窗口按 unknown 处理。
4. 在事务 B 中根据响应写入组内全部候选的终态或 `retry_waiting`、候选级提报尝试结果、group/request attempt、任务进度和速率状态；同库的报名索引反向更新也应包含在事务 B 中。
5. 事务 B 必须以 `taskId + inFlightLogicalGroupId + attemptId + lease/fencingToken` 做条件更新，拒绝旧 lease 的迟到结果覆盖新状态。只有事务 B 提交后才清空 in-flight 和额度预留字段，并将 `nextCandidateIndex` 重算为最小未终态索引。

现有 `onRemoteSubmitStart`、`submitRecovery.ts`、`submitRetryPolicy.ts` 和 `submitWorkerState.ts` 作为重构基础复用；当前“尝试记录一次写、候选再单独写”的窗口必须收敛到上述数据库命令。当前 `logicalSubmitAttemptId` 和 `recordSubmitAttempts` 的候选级 ID 不能直接承担跨 claim 的逻辑组重试计数。事务不能解决“平台已接受但客户端在响应落库前崩溃”，因此远程调用语义仍是 at-least-once，不能宣称 exactly-once。

### 5.3 未知结果的收敛边界

提交接口当前没有平台幂等键。`sending` 在崩溃恢复后不得仅因本地历史暂未出现记录就自动重发：

1. 先按发送时间覆盖范围执行多轮报名历史增量同步，等待可配置的历史可见性宽限窗口。
2. 报名历史命中或平台返回“已经报名”等正向证据时，收敛为 `accepted/already_submitted`。
3. 只有平台提供明确、可审计的“未受理”证据时，才把可重试分类持久化为 group/candidate 的 `retry_waiting` 并重新准入；`retryable` 只作为诊断分类名，不新增一个游离于状态机之外的持久化状态。
4. 宽限期结束仍无正反证据时保持 `unknown`，任务进入 `manual_reconcile` 或可见的 deferred 状态，不盲目重发。

设计目标是避免可预防的重复影响并让不确定状态可见；在平台没有幂等键或权威查询前，不能承诺崩溃场景零重复。

### 5.4 任意一次 429 都释放执行槽

当前 [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:5923) 的 `submitWithRetry` 会在店铺 worker 内等待 30/60 秒。实施时必须改为单次远程尝试，或在第一次频控信号后立即把控制权交回主进程 scheduler；不能在 renderer 的调用栈内睡眠后重试。

任意一次 HTTP 429 或明确业务频控发生时，而不是“内部重试全部耗尽”后：

1. 当前提交组的所有候选变为 `retry_waiting`，不能标记为 `skipped`。
2. 当前店铺的任务写成 `cooling_down`，记录 `resumeAt`、累计暂停时长和剩余候选数。
3. 当前 renderer 结束本次请求执行并释放 mutation/执行槽，让其他 ready 店铺继续。
4. 调度器在 `resumeAt` 到达后重新 claim 该任务，从未完成候选继续。
5. 再次尝试保持原 `logicalGroupId` 和 `retryCycle`，只增加该 group 的 `attemptOrdinal`，重新经过全部准入、额度检查和原子检查点步骤。
6. `submitRetryLimit = 3` 定义为同一提交组跨 claim 的总尝试次数，不再表示一次 renderer 调用中的同步循环次数。
7. 恢复成功后店铺退出 cooling 状态，但不立即清除限频记忆；间隔只按连续成功窗口缓慢下降。

达到 `submitRetryLimit` 后，group 进入 `retry_exhausted`，任务进入 `deferred`，`deferredReason = retry_exhausted`、`requiresExplicitResume = true` 且不设置自动 `resumeAt`。应用启动、普通定时器、店铺重新登录和新运行前检查只能暴露该任务，不能自动发出第 4 次请求。只有用户显式确认继续，或后续策略明确提供经过审计的重置条件时，才能增加 `retryCycle`、重新校验实时授权并再次准入；该动作必须产生事件。这样才能保证“跨 claim 最多 3 次”不会退化为“每次唤醒再试 3 次”。

本次运行达到 `submitStoreThrottleBudgetMs` 仍无法恢复时，任务进入 `deferred`，而不是把剩余候选标为 skipped：

- pipeline 总状态为 `partial`；
- `retryableRemainingCount` 大于 0；
- 原任务和剩余候选快照保持持久化，不迁移到新的 runId；
- 持久化恢复 scheduler 在 `resumeAt`、软件启动、店铺重新登录或同店新提报操作开始时被唤醒；满足授权和契约条件后继续原任务，但 `retry_exhausted` 只展示和阻止新任务，不自动 mutation；
- 新提报操作必须先唤醒同一 `tenantId + shopId + storeGeneration` 的 deferred 任务，不能为相同商品和商机再创建一份并行任务；
- UI 和日志明确显示“待恢复”，不能显示为已处理或主动跳过。

这样避免无限死循环，并使平台短时限频后的剩余候选保持可恢复；未知结果仍受 5.3 的保守边界约束。

原 Electron operation 在达到本次运行预算后可以保持 `partial` 历史状态；恢复 scheduler 通过独立恢复事件更新原 pipeline run、候选和店铺汇总。恢复全部完成后，pipeline run 可以从 `partial` 收敛为 `ok`，但不能篡改已经归档的 Electron operation 历史结果。UI 读取最新 pipeline run 时应显示恢复后的事实，并保留“本次由后台恢复完成”的来源标记。

### 5.5 主进程多店调度器

当前 renderer 内的 `Promise.all` 店铺槽位改为 Electron 主进程拥有的单一逻辑调度器。单一是数据库 lease 和事务准入语义，不要求永远只有一个进程循环存在；即使两个隐藏窗口或两个唤醒源同时竞争，也只能有一个获得同店执行权。

```text
readyQueue：按 nextEligibleAt、创建时间排序
cooldownQueue：按 resumeAt 排序
activeStores：每个 tenantId + shopId + storeGeneration 最多一个活动任务
```

调度循环：

1. 在事务中 claim 到期任务，并检查 scheduler lease、同店非终态唯一性和全局 mutation 准入。
2. 从 readyQueue 取最多 `submitTaskConcurrency` 个不同店铺，将单次已授权请求交给 renderer 执行。
3. 如果某店返回任意频控信号，立即保存 checkpoint，移入 cooldownQueue，释放槽位。
4. 从 readyQueue 补入其他店铺，不等待冷却结束。
5. 到达 `resumeAt` 后把店铺放回 readyQueue，再次执行授权、版本和幂等检查。
6. scheduler lease 超时后可被其他主进程循环回收；每次 claim 都生成单调递增的 fencing token，所有事务 B/取消/过期写入都必须校验 token。请求级 lease 在结果未知时只能进入 reconcile，不能直接重发。

初始仍保持 `submitTaskConcurrency = 2`。只有在连续两轮运行的 429 比例、平均间隔和有效吞吐达到验收标准后，才评估提高到 3；不能把增加并发作为第一步。

### 5.6 后台恢复的授权与版本契约

现有持久化 recovery 仅覆盖受限的 `marketingTask`，不能直接把提报 deferred 任务接入后台。新增 `opportunitySubmitContinuation` Electron 任务类型及专用执行器，并明确：

1. 任务定义声明所需 data store、partition、只读/写入请求计划范围、适配器快照和操作证据；renderer 只能执行主进程签发的单次计划。
2. deferred 后再次远程提交属于新的 mutation。每次恢复时必须重新校验实时付费权益、店铺登录态、storeGeneration 和计划授权；原 operation 曾获授权不能永久授权后续 mutation。
3. 权益缺失时不发请求，任务保持 `deferred`，记录 `authorization_wait` 并在 UI 暴露；权益恢复后重新 claim。
4. 任务必须保存 `releaseId`、`releaseManifestHash`、`runnerArtifactHash` 和 `adapterSnapshotHash`。仅保存 adapter hash 不足以定位或验证执行该任务的 renderer 代码。
5. Electron 增加主进程拥有的 `opportunity_submit_contract_snapshots_v1` 元数据和 verified-release 引用计数。任务创建时把已验证 release 的 manifest、adapter、window commands 和实际 runner artifact 绑定为不可变快照；签名工件继续存放在主进程 verified-release cache，renderer 不能提供或覆盖快照内容。
6. 应用启动时必须从磁盘重新验证并装载仍被非终态任务引用的 release 快照，不能只依赖进程内 `verifiedReleases` map。被任务引用的快照不得被普通更新清理，至少保留到任务终态及审计保留期结束。
7. 恢复必须使用任务创建时已签名且哈希匹配的适配器/脚本/请求计划/runner 快照。快照不存在、签名或 hash 不一致、mutation 契约不兼容时 fail closed，进入 `deferred_contract_mismatch` 或 `manual_reconcile`。
8. 版本升级不得用当前触发运行的 payload 静默替换旧任务契约；只允许有审计记录的显式迁移。迁移记录必须包含源/目标 release、字段变换、风险说明和用户授权要求。

当前 `requestPlanHash` 不覆盖 pacing 参数，所以 `pacingPolicyHash` 必须独立保存并参与恢复校验。`authorization_wait`、`login_wait` 和 `retry_exhausted` 是 `deferredReason`，不是可绕过终态/授权校验的新任务状态。

### 5.7 看门狗、收尾与清理兼容改造

当前 worker 返回后会将仍处于活动状态的任务交给 `failUnconsumedSubmitTasks`，并统一标记为 failed。实施本设计时必须同步调整：

1. `activeSubmitTasksForRun`、`refreshPipelineRunSummary`、`pipelineSubmitResultMessage`、`fetchPipelineSubmit` 和 operation task-result 映射都要认识新状态。`cooling_down` 和 `cancelling` 是非终态活动状态；`deferred`、`manual_reconcile` 和 `deferred_contract_mismatch` 使本次 operation 收敛为 `partial`，不能误报 `ok` 或 `failed`。
2. 当前 5 分钟无进度看门狗不能把最长 30 分钟的合法冷却当作 stalled。主进程 scheduler 应独立等待；原 renderer 没有 ready 工作时尽快返回 partial/deferred。若短冷却仍留在原 operation 中，必须持久化合法 `resumeAt` 并周期发出 `cooldown_wait` 进度证据，且看门狗只接受与数据库状态一致的未来时间。
3. 达到运行预算后，worker 可以返回 deferred，但 pipeline 收尾不能调用 `failUnconsumedSubmitTasks`。只有无合法 `resumeAt`、lease 无法回收、候选快照缺失等真实故障才标记 failed。
4. 用户取消必须覆盖 ready/running/cooling/deferred（包括 `authorization_wait`/`login_wait` 原因）和 manual_reconcile，并将未发送候选原子改为 `cancelled`。存在 `sending/unknown` 时任务先进入非终态 `cancelling`：禁止签发新 mutation、保留同店唯一性并继续 reconcile；所有已派发尝试收敛后，任务才能变为 `cancelled`，不能把未决请求伪装成未发生。
5. 店铺删除或 tombstone 必须停止同店所有非终态任务并删除店铺 rate state；全局 rate state 仅删除该店统计，不影响其他店铺。未派发候选可直接取消，存在 `sending/unknown` 的任务仍按 `cancelling` 保留提交组、契约快照和审计记录，无法自动核对时进入 `manual_reconcile`。删除操作要产生诊断事件。
6. `cleanupOpportunityData`、`expiredHistoryRecords`、workspace 清理、verified-release cache 清理和父 run 清理必须保护 cooling/deferred/unknown 及关联提交组、事件和契约快照。
7. deferred 默认保留 30 天。到期前持续在 UI 暴露；到期后原子写入 `expired`、终结未发送候选并产生事件，不能依赖“非活动即终态”的旧判断静默清理。
8. UI 的最新汇总读取 pipeline run 事实，可显示后台恢复后的 `ok` 和 `recoverySource`；已归档 Electron operation 仍保持当时的 `partial` 结果，不回写篡改历史。

恢复 scheduler 的唤醒点包括任务入队、`resumeAt` 定时器、应用启动、店铺登录恢复和新运行前检查。它扫描所有授权作用域内的到期任务，不只扫描当前 run；`retry_exhausted` 只参与冲突检测和 UI 暴露，不进入自动 readyQueue。最终互斥依赖主进程数据库 lease 和 fencing token，而不是 `pipelineSubmitWorkerTail`。

## 六、准备阶段与提交阶段重叠

### 6.1 保留必要的覆盖屏障

类目需求仍需先按所有已发现店铺的 `(tenantId, categoryKey)` 汇总，才能决定多类目 5 页和单类目全量覆盖，不直接删除这个业务屏障。

### 6.2 删除不必要的提交屏障

完成类目需求汇总后，改为按店铺流式处理：

1. 店铺完成商品扫描、报名历史和类目快照后进入类目需求汇总。
2. 汇总完成后，各店铺独立执行商机加载、分词和本地匹配。
3. 某店铺完成匹配并成功写入 `ready` 提报任务后，立即通知 SubmitScheduler。
4. SubmitScheduler 开始该店提交时，其他店铺仍可继续商机加载和本地匹配。

报名历史读取和提交写入使用不同的资源预算：

- 历史首次全量同步并发维持 1-2；
- 提交开始后，不再增加新的历史全量读取；已有店铺可继续低优先级增量读取；
- 商品扫描和本地匹配不占用历史读取 semaphore；
- 若连续出现历史业务 500，降低历史读取并发，但不暂停已经准备好的提交任务。

### 6.3 后台预热

后台预热是独立的只读 Electron 维护任务 `opportunityHistoryPrewarm`，不能借用提报 continuation 的 mutation 权限。执行前必须重新校验实时付费权益、店铺登录态、storeGeneration、只读请求计划和 partition/data store 权限；未授权时保持待执行，不启动隐藏 runner。

任务开始前的闲时维护任务按店铺低优先级同步：

- 首次报名历史：在店铺登录且软件空闲时完成 30 天窗口初始化；
- 后续运行：按成功水位做重叠 1 天的增量同步；
- 预热并发默认 1，出现业务 500 时退避；
- 只允许历史读取和本地索引写入，禁止触发任何提报 mutation；
- 与前台操作竞争资源时主动让出，并记录可审计的任务进度与诊断事件；
- 提报任务只等待目标店铺的最新增量同步，不重复全量扫描。

今天的运行中，首次历史同步约占准备阶段 6 分半。预热命中后，准备阶段应主要剩余商品变化扫描、增量同步、商机加载和本地匹配。

## 七、配置建议

以下是建议新增的配置，不在本设计文档提交时直接改生产值：

```json
{
  "opportunityReport": {
    "submitPacingMode": "adaptive",
    "submitPacingInitialIntervalMs": 15000,
    "submitPacingMinIntervalMs": 10000,
    "submitPacingMaxIntervalMs": 60000,
    "submitPacingJitterMs": 1500,
    "submitPacingSuccessesToDecrease": 8,
    "submitPacingDecreaseMs": 1000,
    "submitPacing429Multiplier": 1.5,
    "submitPacingMaxCooldownMs": 120000,
    "submitStoreThrottleBudgetMs": 1800000,
    "submitGlobalBurstSpacingMs": 500,
    "submitGlobalPacingInitialMs": 15000,
    "submitGlobalPacingMaxMs": 60000,
    "submitGlobalPacing429Multiplier": 1.5,
    "submitGlobalPacingDecreaseMs": 5000,
    "submitGlobal429WindowMs": 120000,
    "submitGlobal429DistinctStores": 2,
    "submitGlobalStableWindowsToExit": 2,
    "submitDailyHttpRequestLimit": 1000,
    "submitRetryExhaustedAutoResume": false,
    "submitThrottleRecoveryEnabled": true,
    "submitTaskConcurrency": 2
  }
}
```

`submitCandidateDelayMs` 在自适应模式下只作为兼容 fallback；正常状态的实际请求间隔由店铺 rate state 决定，全局状态只施加 `submitGlobalBurstSpacingMs`。达到跨店阈值后，全局状态进入 protective，才使用 `submitGlobalPacingInitialMs` 到 `submitGlobalPacingMaxMs` 的全局间隔。

现有 `dailyAttemptLimit` 继续表示候选 mutation 尝试额度，不能改成 HTTP 请求数。`submitDailyHttpRequestLimit` 是独立的请求熔断上限。`submitRetryLimit = 3` 可先保持数值不变，但语义改为同一 `logicalGroupId + retryCycle` 跨 claim 的总远程尝试次数；达到上限后必须显式恢复并增加 retryCycle，renderer 内部不得等待后继续下一次尝试。

当前两套适配器配置的基线为 `submitBatchSize = 10`、`submitCandidateDelayMs = 10000`、`submitBatchDelayMs = 10000`、抖动 2500、`submitRetryLimit = 3`、`submitRetryDelayMs = 10000`、并发 2。灰度配置必须记录 release 和 policy hash，不能只记录最终数值。

## 八、数据、权限与日志契约

### 8.1 Electron 数据权限

新增 `opportunity_submit_rate_state_v1`、`opportunity_submit_global_rate_state_v1`、`opportunity_submit_attempt_groups_v1` 和 `opportunity_submit_contract_snapshots_v1`，以及两个后台任务类型后，必须同步：

- `OPPORTUNITY_DATA_STORES`；
- 数据库声明和 store 自检；
- 店铺删除级联；
- 任务定义的 dataScopes、planScopes、partition/store 引用和操作证据；
- paid entitlement、登录态和 storeGeneration 的 claim 时校验；
- 版本化 `releaseManifestHash`、`runnerArtifactHash`、`requestPlanHash`、`pacingPolicyHash`、适配器快照和 mutation 契约测试；
- verified-release cache 的启动重载、任务引用计数和保留策略；
- 主进程原子准入、额度预留、HTTP grant 消费/派发、提交前 checkpoint、结果落库、取消和过期数据库命令；
- `opportunity_submit_attempts_v2` 的候选级 `throttled` 状态、候选额度计数，以及逻辑组 `(logicalGroupId, retryCycle, attemptOrdinal)`、`quotaReservationId` 和 `httpGrantId` 唯一约束。

现有任务恢复注册表只允许已声明的任务类型和请求计划。不能仅增加 store 白名单后让任意 renderer 扫描 deferred 记录；所有后台 mutation 都必须由主进程签发一次性执行授权并记录授权证据。

### 8.2 运行汇总

Pipeline summary 增加：

```text
throttleCount
throttlePauseMs
recoveredAfterThrottleCount
deferredCount
retryableRemainingCount
retryExhaustedCount
maxStoreIntervalMs
averageStoreIntervalMs
globalRateMode
candidateMutationAttemptCount
httpRequestAttemptCount
dailyCandidateMutationRemaining
dailyHttpRequestRemaining
unknownCount
manualReconcileCount
authorizationWaitingCount
contractMismatchCount
```

`skippedCount` 不包含因 429 暂停而未处理的候选。未完成候选必须通过 `retryableRemainingCount`、`retryExhaustedCount` 或 `deferredCount` 暴露。候选 mutation 额度和 HTTP 请求熔断必须分别汇总，禁止复用同一个 `dailyAttemptUsed` 字段造成单位混淆。

### 8.3 诊断事件

增加或统一以下事件：

- `submit-rate-admitted`
- `submit-rate-delayed`
- `submit-rate-adjusted`
- `submit-throttle-detected`
- `submit-task-cooling-down`
- `submit-task-resumed`
- `submit-task-deferred`
- `submit-retry-exhausted`
- `submit-retry-cycle-reset`
- `submit-checkpoint-persisted`
- `submit-http-grant-dispatched`
- `submit-result-reconciled`
- `submit-authorization-waiting`
- `submit-contract-mismatch`
- `submit-task-expired`
- `submit-task-cancelled`
- `submit-scheduler-lease-claimed`

每条事件至少包含：`runId`、`storeRunId`、`shopId`、`taskId`、`logicalGroupId`、`attemptId`、`candidateId`（如适用）、兼容期旧 `batchId`（如仍产生）、`retryCycle`、`attemptOrdinal`、`quotaReservationId`、`nextEligibleAt`、当前店铺/全局间隔、全局模式、累计 429、候选 mutation 尝试数、HTTP 请求尝试数、剩余候选数、worker 槽位、release/契约/策略版本和调度原因。

日志禁止写入 `verifyFp`、`fp`、`msToken`、`a_bogus` 和完整 Cookie。

### 8.4 当前代码实施触点

| 代码位置 | 已确认现状 | 本设计要求 |
| --- | --- | --- |
| [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:5923) | `submitWithRetry` 在店铺 worker 内等待并重试 | 拆为单次尝试，429/频控立即交还 scheduler |
| [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:8351) | `pipelineSubmitWorkerTail` 是 renderer 模块变量 | 只保留进程内防重入；全局互斥迁到主进程数据库 lease |
| [task-manager.js](../electron-client/src/main/tasks/task-manager.js:31) | 可运行 8 个 runner、单 owner 4 个，并为任务创建独立窗口 | 不能假设 renderer 单例；一次只下发已准入的请求 |
| [task-manager.js](../electron-client/src/main/tasks/task-manager.js:470) | operation 恢复只接受 `marketingTask`，恢复计划过滤 mutation | 新增受审计的 continuation/prewarm 任务定义和实时授权 |
| [task-result-policy.js](../electron-client/src/main/tasks/task-result-policy.js:3) | 提报 5 分钟无进度即 stalled | 按 5.7 调整 scheduler/operation 边界和合法冷却证据 |
| [worker.js](../electron-client/src/main/database/worker.js:816) | task claim 已在事务内检查 running `concurrencyKey` | 扩展为同店所有非终态唯一、原子准入和 checkpoint 命令 |
| [worker.js](../electron-client/src/main/database/worker.js:895) | 候选级 attempt 状态不包含 `throttled`，额度按 attempt 行计数 | 保留候选级额度语义，增加 throttled 分类；请求级次数写入 logical group/独立计数 |
| [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:3727) | 规划容量和 `dailyAttemptLimit` 按候选数计算 | 继续按候选 mutation 额度规划，另加 HTTP 请求熔断，禁止把批次请求只算 1 个候选额度 |
| [submitRecovery.ts](../remote-web/client-shell/src/domain/doudian/opportunity/submitRecovery.ts:1) | 只把 `sending/submitting` 视为未决 | 将 `retry_waiting` 纳入可恢复未终态，但仍把 `unknown` 交给 reconcile 而不是自动重发 |
| [submitWorkerState.ts](../remote-web/client-shell/src/domain/doudian/opportunity/submitWorkerState.ts:1) | 活动任务只包含 preparing/ready/queued/running | 识别 cooling_down/cancelling；deferred/manual_reconcile/contract mismatch 按本次 operation 的 partial 语义汇总 |
| [worker.js](../electron-client/src/main/database/worker.js:1391) | tombstone 只取消旧活动状态集合 | 覆盖 cooling/deferred/unknown；未派发项取消，已派发未决项进入 cancelling/reconcile，并保护提交组与契约快照 |
| [opportunityReport.ts](../remote-web/client-shell/src/domain/doudian/opportunityReport.ts:2569) | 过期逻辑把未识别状态视为终态 | 显式保护并最终写入 `expired`，禁止静默清理 |
| [remote-web-integrity.js](../electron-client/src/main/security/remote-web-integrity.js:274) | verified snapshot 只从进程内 map 获取 | 启动时重载并验证被任务引用的 release；按引用保留 runner/adapter/manifest 快照 |

上述改造必须一起发布。只修改 `opportunityReport.ts` 的队列或配置不能满足跨窗口互斥、后台授权和崩溃恢复要求。

## 九、异常分类

| 类型 | 当前店铺 | 其他店铺 | 处理 |
| --- | --- | --- | --- |
| HTTP 429 / 明确频控 | cooling_down | 继续 | 提高店铺间隔，按 `resumeAt` 恢复 |
| HTTP 200 业务频控白名单命中 | cooling_down | 继续 | 与 429 相同；必须有稳定业务码或经过测试的精确消息规则 |
| 环境风险/验证码/身份校验/账号风控 | manual/deferred | 继续 | 禁止按短期频控自动重试；要求重新登录、人工确认或风控专用恢复证据 |
| HTTP 200 业务繁忙（历史读取） | 读取退避 | 提交继续 | 只降低读取资源池并发 |
| 请求超时/网络错误 | retryable | 继续 | 按请求计划重试，超限后 deferred |
| 响应未知 | reconcile | 继续 | 多轮同步并等待可见性窗口；无明确反证则 manual_reconcile，不盲重试 |
| 每日额度耗尽 | exhausted | 继续 | 当前店铺剩余候选标记 quota_exhausted，当日及后续自动唤醒均不重新打开 |
| 付费权益暂不可用 | deferred | 继续 | 标记 authorization_wait，不发 mutation，权益恢复后重验 |
| 店铺掉线 | deferred | 继续 | 保留原代次任务，重新登录且代次匹配后恢复 |
| 店铺代次变化 | contract mismatch | 继续 | fail closed，禁止把旧任务静默迁移到新代次 |
| 恢复快照/契约不匹配 | contract mismatch | 继续 | deferred_contract_mismatch 或 manual_reconcile |
| 同一 logical group 重试耗尽 | retry_exhausted | 继续 | 不设自动 resumeAt；显式确认后增加 retryCycle 并重新授权 |

只有每日额度耗尽、用户取消、店铺已删除或显式过期等不可恢复原因，才允许把未发送候选变成对应终态。`sending/unknown` 候选即使取消也必须先保留并核对远程事实。

## 十、验收测试

### 10.1 429 恢复

1. 第 3 个提交组第一次尝试返回 429：该组全部候选进入 `retry_waiting`，renderer 立即释放槽位，第三家 ready 店铺可在冷却期内执行。
2. 同一 logical group 连续 3 次 429：3 次使用相同 `logicalGroupId/retryCycle` 和递增 ordinal，均分别经过准入与 checkpoint；达到总尝试上限后任务以 `retry_exhausted` deferred，不出现 renderer 内 30/60 秒睡眠。
3. `retry_exhausted` 在应用启动、普通定时器、重新登录或新运行前检查时不会发出第 4 次请求；显式确认后才增加 retryCycle 并重新授权。
4. cooling 恢复时，原 group 的 `retry_waiting` 候选可再次准入，但不得与新 `ready` 候选重组；批次候选顺序和 requestBodyHash 保持不变。
5. 批次包含非连续候选索引时，成功、429 和部分业务失败后 `nextCandidateIndex` 始终等于最小未终态索引。
6. 重启发生在 cooling_down：恢复任务读取持久化 `resumeAt` 和确定性抖动，不提前请求，不重提 accepted 候选。
7. 重复 429 超过单店运行预算：原 operation 为 partial，任务为 deferred；下一次运行优先恢复普通 `throttle_budget` 任务，UI 显示剩余数量和恢复来源。
8. 单店重复 429 不改变全局速率；同一窗口内两家不同店铺 429 才把全局模式切换为 protective，连续稳定窗口后缓慢下降并回到 inactive。
9. `retry_waiting` 在恢复扫描中属于可恢复未终态，在新批次选择器中不属于普通 `ready`；`unknown` 始终进入 reconcile，三者不会互相混用。

### 10.2 原子性与未知结果

1. 事务 A 前崩溃：没有 `sending` 事实，可以重新准入。
2. 事务 A 后、请求调用前崩溃：只有主进程存在可审计的“请求授权尚未交付/使用”证据时才能恢复为 ready；否则按 unknown 处理，不能产生两个活动提交组或盲目重发。
3. 请求发出后、事务 B 前崩溃：恢复为 unknown/reconcile，不直接重发。
4. 报名历史存在可见性延迟：宽限窗口内多轮未命中仍保持 unknown；正向历史出现后收敛为 accepted。
5. 只有模拟平台明确返回未受理证据时 unknown 才按 retryable 分类并持久化为 `retry_waiting`；无证据超时进入 manual_reconcile。
6. 两个隐藏 `BrowserWindow` 同时请求同店准入，或应用重启期间两个唤醒源竞争时，数据库只允许一个非终态任务/一个有效请求 lease；旧 fencing token 的迟到结果不能覆盖新状态。
7. 事务 A 后、HTTP grant 消费前崩溃且可证明 grant 未使用：释放额度预留并恢复为 ready/retry_waiting，不增加任何已派发计数。
8. HTTP grant 已消费后崩溃：候选 mutation 和 HTTP 请求计数均已增加，恢复为 unknown，不得因未收到响应而回退计数。
9. 取消发生在请求已派发但结果未落库时：任务进入 `cancelling`，不再签发请求且不释放同店唯一性；reconcile 收敛后才变为 cancelled，迟到结果仍受 fencing token 约束。

### 10.3 节奏、配额与吞吐

1. 正常成功时请求间隔不会低于店铺当前 `intervalMs`。
2. 429 后下一次普通间隔增加，不会立刻恢复为 10-12.5 秒。
3. 一个包含 10 个商品的成功请求只增加一次速率状态的连续成功数，但候选 mutation 额度增加 10。
4. 正常态全局 gate 只施加 `submitGlobalBurstSpacingMs`，不会把两店各自的 15 秒节奏串行成全局每 15 秒一次。
5. 两店运行时单店 429 不会增加另一店的等待。
6. 最后一个成功批次不再额外等待一个完整提交间隔。
7. 在不增加 429 比例的情况下，有效完成数/分钟高于当前基线。
8. 每个已派发 HTTP 尝试（含 429）使 HTTP 请求计数增加 1；组内每个候选使候选 mutation 额度各增加 1。批次大小变化不能放大候选额度。
9. 跨业务日恢复仍可恢复的 cooling/deferred 任务时重新读取当天两类额度；原业务日的已派发事实保持不变，`quota_exhausted` 候选不自动重新打开。

### 10.4 生命周期、授权与版本

1. 合法 cooling 超过 5 分钟时不会被无进度看门狗误杀；没有 ready 工作的原 renderer 会安全返回 partial/deferred，由主进程后续唤醒。
2. 付费权益过期时 deferred 任务进入 `authorization_wait`，不执行 mutation；权益恢复后重新校验并继续。
3. 原 release/runner/adapter 快照缺失、签名或 hash 不一致、storeGeneration 变化时不发送请求，状态为 `deferred_contract_mismatch` 或 `manual_reconcile`。
4. 同店已有旧 run 的 deferred 任务时，新 run 原子地优先恢复/合并旧任务，不创建第二个非终态任务。
5. 用户取消和店铺删除覆盖 cooling/deferred/unknown；存在已派发未决请求时任务保持 `cancelling` 和同店唯一性，收敛后才 cancelled。店铺 rate state 被清除，其他店铺的全局状态不被误删。
6. 普通清理不删除可恢复任务；30 天到期时任务和未发送候选显式变为 expired，并有诊断事件。
7. pipeline 最新汇总可由 partial 收敛为后台恢复后的 ok；已归档 Electron operation 保持原 partial 事实。
8. 应用重启后可以从磁盘重新装载仍被任务引用的签名 release；普通版本更新不会删除活动/deferred 任务所需工件。
9. 创建逻辑组后修改本地商品标题、价格、库存或类目记录，再恢复同组重试时，请求仍使用原 `requestBodyCanonicalJson`；如快照缺失或 hash 不一致则 fail closed，不从当前商品记录静默重建。

### 10.5 流水线和预热

1. 历史缓存命中时不再执行 30 天全量扫描。
2. 第一个店铺完成匹配后即可开始提交，后续店铺仍可继续匹配。
3. 历史接口业务 500 不会阻塞已 ready 店铺的提交。
4. 商品、报名历史和商机覆盖门禁仍然 fail closed。
5. 预热 runner 只有只读远程计划和索引写入权限；付费权益、登录态或计划授权缺失时不启动请求。
6. 预热连续收到业务 500 时降并发/退避，前台已 ready 的提交不被暂停。

## 十一、灰度发布顺序

### 阶段 0：只观测

记录每店/全局请求间隔、429、冷却时间、剩余候选、未知结果和尾部等待，不改变现有节奏。归档脱敏诊断导出及校验摘要，校准建议阈值。

### 阶段 0.5：主进程基础设施

先交付 Electron 任务定义与实时授权、scheduler lease/fencing token、同店非终态唯一约束、四类 rate/attempt group/contract snapshot store、额度预留与 grant 消费、事务 A/A2/B、verified-release 重载、看门狗兼容和生命周期清理。通过双 `BrowserWindow` 竞争、崩溃窗口、取消/删除、额度单位和契约不匹配测试后，才允许开启后台 mutation 恢复。

### 阶段 1：恢复优先

启用单次尝试、自适应间隔、cooling_down、checkpoint、unknown reconcile 和 deferred，保持两店并发为 2。验收重点是“任意 429 立即释放槽位”“retry_exhausted 不自动形成无限循环”和“有明确证据时安全恢复，未知时不盲重发”。

### 阶段 2：缩短冷启动

在只读任务授权完成后启用报名历史后台预热、阶段流式入队和最后批次无尾部等待。比较冷启动与缓存命中的总耗时。

### 阶段 3：评估并发

只有阶段 1、2 连续两轮稳定后，才在多店环境评估 `submitTaskConcurrency = 3`。若全局 429 增加，立即退回 2，并提高全局 token 间隔。

## 十二、预期结果与边界

基于当前两店约 76 个提交组的运行数据，采用每店约 15 秒的自适应起始节奏、并发 2、全局状态保持 inactive 且仅施加约 500ms 突发间隔时，提交阶段理论下界约为 `76 / 2 * 15s = 9.5 分钟`，因此预计约 9-10 分钟；若跨店 429 触发全局 protective，耗时会高于该区间。这是推算，不是平台保证。相比当前 18 分钟只完成 52 个候选，优先目标是完成接近全部可提报候选，而不是单纯缩短到达第一个成功请求的时间。

历史缓存预热预计能减少约 6 分钟冷启动等待；流式入队可以进一步重叠后续店铺的商机加载与前序店铺提交。最终收益需要用两店、三店和多店连续运行数据校准。

平台限频规则是外部不透明状态，设计不能承诺永远零 429。可接受目标是：429 出现后自动降低该店频率、释放并发资源、可靠恢复剩余任务，并让有效完成数和整体完成时间持续优于当前“遇到最终 429 就停止本店”的行为。
