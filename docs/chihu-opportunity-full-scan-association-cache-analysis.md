# 商机提报全量扫描、报名记录缓存与跨店缓存设计

> 更新日期：2026-07-24
>
> 实施范围：`remote-web/client-shell`、两份抖店适配器配置、Electron 任务权限与本地数据库
>
> 本文是当前实现基线。旧的权益商品接口方案已经废弃，不再作为提报门禁或统计数据源。

## 一、结论

商机提报使用三份相互独立的数据：

1. 商品列表：提供可提报商品、标题和末级类目；
2. 商机列表：按店铺有效类目加载候选商机；
3. 商机报名记录：判断商品是否达到 50 个商机，以及“商品 + 商机”是否提交过。

报名记录使用以下稳定 endpoint，通过现有动态签名链路请求，不保存浏览器 URL 中的临时签名参数：

```text
POST /api/commop/business_chance_center/item_submit/common/list
```

请求体：

```json
{
  "condition": {
    "clue_channel": "",
    "item_info": "",
    "gmt_start_time": 1782230400,
    "gmt_end_time": 1784908799,
    "status_list": [0, 1, 2, 3, 4, 5, 6]
  },
  "page": {
    "current": 1,
    "page_size": 100
  }
}
```

已确认的响应契约：

| 字段 | 用途 |
| --- | --- |
| `base_resp.status_code` | 业务成功码，成功值为 `200` |
| 根部 `data[]` | 报名记录数组 |
| 根部 `total` | 当前时间范围内的远端总记录数 |
| `data[].id` | 报名记录唯一 ID，分页与幂等写入依据 |
| `data[].product_info.product_id` | 商品 ID |
| `data[].clue_id` | 商机 ID |
| `data[].submit_time` | 提交时间，兼容毫秒/秒时间戳 |
| `data[].audit_time` | 审核时间，用于记录更新时间 |
| `data[].audit_status` | 审核状态，原样保留 |
| `data[].appeal_status` | 申诉状态，原样保留 |

## 二、主流程

```text
选择店铺
  |
  | 最多 2 家并发准备
  v
完整扫描商品（按唯一 productId 达到 remoteTotal）
  |
  v
同步报名记录
  |-- 首次：从配置起始时间按 31 天窗口全量扫描，可断点续跑
  `-- 后续：从上次成功水位向前重叠 1 天增量扫描
  |
  v
构建/更新店铺级商品报名索引
  |
  v
全局类目选择 ∩ 当前店铺商品类目
  |
  v
单类目全量商机；多类目每类至少 5 页
  |
  v
报名记录过滤 + 本地历史过滤
  |
  v
过滤后重新计算 Top-K 和 rankForProduct
  |
  v
仅三个覆盖门禁都满足时创建提报任务
```

## 三、本地数据模型

数据存入 Electron SQLite 的 `native_records`，由逻辑 storeName 隔离。

### 3.1 报名明细

storeName：`opportunity_submit_history_records_v1`

```ts
type SubmitHistoryRecord = {
  id: string;                 // tenant + shop + generation + encoded(remoteRecordId)
  tenantId: string;
  shopId: string;
  storeGeneration: number;
  remoteRecordId: string;
  productId: string;
  productTitle: string;
  clueId: string;
  clueName: string;
  clueChannel: string;
  submitTimeMs: number;
  auditTimeMs: number | null;
  remoteUpdatedAtMs: number;
  auditStatus: string;
  appealStatus: string;
  isAutoSubmitted: boolean;
  raw: Record<string, unknown>;
  fetchedAt: string;
  updatedAt: string;
};
```

明细按远端记录 ID 幂等覆盖。`raw` 用于后续契约审计，不参与提报决策。

### 3.2 同步状态

storeName：`opportunity_submit_history_sync_v1`

```ts
type SubmitHistorySync = {
  initialized: boolean;
  status: "complete" | "truncated" | "failed";
  initialStartEpochSeconds: number;
  initialCursorStartEpochSeconds: number;
  watermarkMs: number;                 // 上次成功查询的 gmt_end_time，不是记录更新时间
  remoteUpdatedAtWatermarkMs?: number; // 已见记录的最大远端更新时间，仅用于观测
  recordCount: number;
  lastMode: "initial" | "incremental";
  lastSuccessfulSyncAt?: string;
  lastError?: string;
};
```

每个完整时间窗口写入明细和商品索引后，才推进 `initialCursorStartEpochSeconds`。进程中断后从未完成窗口继续，不从头重复全量扫描。

### 3.3 商品聚合索引

storeName：`opportunity_submit_history_product_indexes_v1`

```ts
type SubmitHistoryProductIndex = {
  productId: string;
  associatedClueIds: string[];
  associatedClueCount: number;
  remainingClueCapacity: number;
  submissionRecordIds: string[];
  sourceRecordCount: number;
  saturatedByRemoteError?: boolean;
};
```

计算规则：

```text
associatedClueIds      = unique(all history rows for productId -> clueId)
associatedClueCount    = associatedClueIds.length
sourceRecordCount      = unique(remoteRecordId).length
remainingClueCapacity  = max(0, 50 - max(associatedClueCount, sourceRecordCount))
```

报名历史初始化已经完整时，商品没有索引代表 0 条报名记录，不代表未知。初始化或本次增量同步失败时，完整性门禁会阻止提报。

## 四、近 30 天初始化与增量同步

### 4.1 首次初始化

默认参数：

```text
submitHistoryInitialLookbackDays = 30
submitHistoryWindowDays = 31
submitHistoryPageSize = 100
maxSubmitHistoryPagesPerWindow = 1000
submitHistoryPageDelayMs = 150
```

首次运行在任务开始时按 `now - submitHistoryInitialLookbackDays` 动态计算起点，到当前时间生成不重叠窗口。默认回溯 30 天，因此通常只产生一个 31 天以内的窗口。每个窗口从第 1 页开始，维护 `Map<remoteRecordId, row>`。

该 30 天仅定义首次平台历史的覆盖范围，不代表平台全生命周期历史完整。初始化成功后记录会随增量同步持续累积，不做滚动删除；30 天以前且未进入本地成功提报记录的数据无法用于首次精确判断商品累计次数或历史关联，后续遇到平台返回“已报名”或“满额”时再反向更新本地索引。

该参数只限制首次回溯范围。初始化完成后，本地缓存会继续接收后续增量记录，不执行滚动 30 天删除。

窗口只有满足以下条件才算完整：

- HTTP 和业务响应成功；
- 每条记录都能解析出 `id + productId + clueId + submitTime`；
- `total = 0` 时列表必须为空；
- 没有整页重复或无新增页；
- 唯一记录数达到远端 `total`，或在远端没有 `total` 时明确遇到短页/空页；
- 没有达到 `maxSubmitHistoryPagesPerWindow` 的保护上限。

窗口不完整时不推进游标，整个店铺的报名历史门禁保持关闭。

### 4.2 后续增量

初始化完成后，`watermarkMs` 记录上次成功同步的查询上界。下一次从以下时间开始：

```text
max(now - submitHistoryInitialLookbackDays, watermark - submitHistoryIncrementalOverlapSeconds)
```

默认重叠 86400 秒，用于覆盖临界时间、延迟写入和审核状态更新。由于 endpoint 的时间条件是 `gmt_start_time/gmt_end_time`，查询水位必须保持为上次成功查询上界，不能直接替换成 `remoteUpdatedAtMs`，否则会漏掉旧提交的后续审核变化。远端记录 ID 保证重叠范围可以幂等覆盖，不会重复计数；最大 `remoteUpdatedAtMs` 单独记录用于审计和延迟观测。

增量失败时保留此前已完成初始化的事实和数据，但当前运行的报名历史门禁关闭；下次仍从原成功水位重试。

## 五、提交前过滤

### 5.1 商品达到 50 个商机

```ts
max(associatedClueCount, sourceRecordCount) >= 50
```

命中后排除该商品全部候选。平台提交返回满额时，立即把本地索引标记为 saturated，避免同次任务继续尝试该商品。

### 5.2 商品已经提交过同一商机

```ts
associatedClueIds.includes(candidate.clueId)
```

只过滤这一个“商品 + 商机”组合，不过滤商品的其他商机。平台返回“已经报名”时，立即把对应 clueId 补入商品索引。

### 5.3 过滤顺序

报名索引过滤和本地提交历史过滤必须发生在最终排名之前：

```text
匹配通过候选
  -> 报名历史过滤
  -> 本地提报历史过滤
  -> 排序
  -> Top-K
  -> rankForProduct
  -> 主候选/备选
```

第一名被过滤后，下一候选自动晋升，不能留下只有 alternative 的商品。

过滤发生在候选进入 Top-K 之前。每个商品只保留 `min(topKPerProduct, candidateLimitPerProduct)` 个候选，默认最多 5 个；店铺每天最多提交 1000 次只约束店铺任务总量，不能作为单商品候选池大小。

## 六、三个独立完整性门禁

自动提报必须同时满足：

| 门禁 | 完整条件 |
| --- | --- |
| `productComplete` | 商品按唯一 ID 达到远端总数并完成分页 |
| `benefitComplete`（兼容字段名） | 报名历史首次初始化完成且本次增量同步成功 |
| `clueCoverageSatisfied` | 单类目全量，或多类目按策略完成至少 5 页，且无硬失败 |

`benefitComplete` 是现有任务快照的兼容字段，当前语义已经改为“报名历史同步完整”，不再表示权益商品接口。

任一门禁失败时：

- 不持久化可执行候选；
- 不创建可运行提报任务；
- 店铺运行记录为 skipped/failed；
- 记录具体同步窗口、页数、唯一计数、远端总数和错误原因。

## 七、商机跨店缓存

商机缓存与报名历史缓存相互独立。

- 类目需求按 `(tenantId, categoryKey)` 汇总；
- 同租户同类目取所有消费店铺的最大覆盖需求；
- global 实际作用域必须是 `tenant:${tenantId}`，禁止固定字符串 `global`；
- `tenantId = local-user` 时禁止共享缓存；
- 5 页缓存升级为全量时从第 6 页继续；
- 缓存 generation 先写 shards，校验后最后切 manifest；
- token key 绑定商机集合 generation/ID 指纹，集合升级后必须重建 token。

## 八、并发、原子性与保留策略

- 店铺准备并发上限为 2；
- 每个报名历史时间窗口串行翻页，避免店铺级签名和限频竞争；
- 提交遇到 HTTP 429 时，单店按 `Retry-After` 或 30 秒、60 秒递增退避；不改变其他店铺 worker 的并发策略；
- 明细与聚合索引写成功后才推进同步游标；
- 报名历史是长期事实源，不受 14/30 天运行日志清理策略影响；
- 删除店铺时级联删除报名明细、同步状态和商品索引；
- 所有键包含 `tenantId + shopId + storeGeneration`，禁止跨店、跨租户、跨店铺代次复用。

## 九、适配器与 Electron 契约

适配器必须同时声明：

- endpoint `opportunitySubmitHistoryList`；
- POST request plan，动态本地签名，body 为 `{bodyJson}`；
- `submitHistoryListPaths` 包含根部 `data`；
- `submitHistoryTotalPaths` 包含根部 `total`；
- operation plan `executeOpportunitySubmit` 包含该 plan；
- `requestPlanHash` 包含 plan、映射和同步参数。

Electron 必须同时声明：

- `OPPORTUNITY_SUBMIT_PLANS` 包含 `opportunitySubmitHistoryList`；
- `opportunityReportScan` 允许该 plan；
- 三个新 store 在 native record store 白名单和任务数据权限中；
- 店铺删除级联覆盖三个 store；
- 任务权限测试验证旧权益 plan 不再出现。

## 十、日志与诊断

每个时间窗口记录：

- 模式：initial/incremental；
- 查询起止时间；
- 已拉页数、原始行数、唯一记录数；
- 远端 `total` 及是否存在；
- schema mismatch、重复页、`total=0` 但列表非空；
- complete/truncated/failed；
- 店铺 ID 和运行 ID。

日志不得记录 URL 中的 `verifyFp`、`fp`、`msToken`、`a_bogus` 等临时凭证。

## 十一、契约测试样本

必须覆盖：

1. 根部 `data[]` + 根部 `total` 的成功响应；
2. `total = 0` 且空列表；
3. `base_resp.status_code != 200`；
4. 第二页重复远端记录 ID；
5. 缺少记录 ID、商品 ID、商机 ID 或提交时间；
6. 秒和毫秒时间戳；
7. 时间窗口不重叠；
8. 页数达到保护上限但未达到 total；
9. 提交返回“已经报名”后的索引反向更新；
10. 满额返回后的 saturated 反向更新；
11. 店铺删除级联；
12. Electron 任务 request plan 白名单。

## 十二、验收标准

1. 发布配置和构建产物中不再出现旧权益 endpoint/request plan。
2. 首次运行只回溯任务开始时间之前 30 天的报名记录，进程中断后按窗口断点继续。
3. 初始化完成后的运行只扫描成功水位附近的增量范围。
4. 重叠增量不会重复增加报名数。
5. 商品的唯一商机数达到 50 后不会进入候选队列。
6. 已存在的“商品 + 商机”组合会在最终 Top-K 前被过滤，下一候选正确晋升。
7. 每个商品默认最多保留 5 个候选，不会因店铺 1000 次额度扩张到 1000 个。
8. 报名历史同步不完整、契约异常或业务失败时自动提报 fail closed。
9. 提报成功、满额和已经报名响应会即时修正本地商品索引。
10. 报名历史不会被普通运行历史清理删除。
11. 删除店铺不会残留该店或旧 generation 的报名记录。
12. 两份适配器、Electron 权限、TypeScript 类型检查、客户端测试、Electron 测试和发布构建全部通过。
