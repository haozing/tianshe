# 天蛇客户端全量审计报告

- 报告日期：2026-06-17
- 对应计划：`docs/full-audit-plan.zh-CN.md`
- 审计基线：源码快照 `main @ af2136d`
- 测试基线：`node scripts/test-inventory.js` 实测 **351 个测试文件**（详见第 2 节）
- 范围声明：本报告覆盖计划第 3 节的八个纵向模块与九个横向主题；纯授权/凭证存储/插件信任模型等独立安全议题按计划第 1 节推迟，但"稳定性即安全"双面守卫（sql-validator、network-target-policy、enableAuth 合约、validateMcpOrigin、senderGuard）在本报告范围内。

> 方法论：本轮采用"先盘点后补缺"。每个模块先列已有测试，再 diff 真空白；所有结论附 `file:line` 证据。问题分级遵循计划第 4 节 P0/P1/P2/P3 定义。

---

## 1. 执行摘要

天蛇客户端整体工程质量高于同类 Electron 自动化项目：错误模型统一（`CoreError` 全链路可序列化）、任务队列与调度器都做过硬取消（hard-settle）改造、浏览器池有 requestId 防 stale handle、导入有 worker 退出与清理路径、能力原语层（ONNX/FFI/模型下载）都有并发闸、超时与校验。测试盘点显示 351 个测试文件、分层清晰，`test:architecture` 与 `test:package-smoke` 已存在（后者证明计划中"打包 smoke 是真缺口"的判断已被部分补上）。

但仍存在若干**会造成数据/状态不一致或不可诊断故障**的真实风险，集中在三类：

1. **跨服务一致性边界**：DB schema 迁移多步执行未包事务（部分失败留半成品 schema）；导入元数据与数据文件写入非原子。
2. **默认免鉴权合约**：`enableAuth: false` 是默认值，HTTP 开启后 orchestration 端点默认无 Bearer 即可驱动 browser/profile/plugin/dataset 网关——这是合约事实，需文档与 UI 双重告知。
3. **原生层资源生命周期**：ONNX `unloadModel` 依赖 GC 无显式释放；FFI `loadedAt` 用 `Date.now()` 占位导致诊断失真；onnx 单例 `models` 无全局内存上限。

另发现一个**工程卫生**问题：3 个源码文件含乱码替换字符（mojibake），其中 `scheduler-service.ts` 的中文注释已损坏。

### 问题分级总览

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 2 | DB 迁移非事务化；导入元数据/数据文件非原子写入 |
| P1 | 7 | 默认免鉴权合约未充分文档化、ONNX 无全局内存上限、FFI 诊断字段失真、senderGuard 依赖、跨库 ATTACH 残留、worker 崩溃 profile 状态、once 任务恢复窗口 |
| P2 | 9 | sql-validator 正则绕过面、临时库命名碰撞、HNSW 版本检测、EP 回退可观测性、日志保留策略、迁移 checksum 漂移等 |
| P3 | 5 | mojibake 注释、`listLibraries` loadedAt 占位、命名一致性、文档缺口 |

---

## 2. 阶段一：审计基线

### 2.1 测试覆盖 baseline（实测）

`scripts/test-inventory.js` 输出（`qa-results/test-inventory.json`）：

- **总计 351 个测试文件**
- 按子系统（byArea）：browser 75、renderer 63、dataset 61、http-mcp 44、plugin 24、shared 18、native 15、bootstrap 14、observability 13、task 7、sync 6、tooling 4、config 3、architecture 3、edition 1
- 按层级（byLayer）：unit 322、contract 9、integration 8、real 4、architecture 3、canary 3、smoke 2
- 按运行时（byRuntime）：node 279、jsdom 63、real-browser 9

### 2.2 测试命令清单（实测 package.json）

完整覆盖计划列出的命令，且**已超出计划**：

- 治理层：`test:architecture`（AST 扫描 + 边界 + runtime-profile 基线）、`test:inventory`
- 启动层：`test:main-bootstrap`（app-runtime + 4 个 bootstrap + browser-pool-readiness）
- 浏览器：`test:browser-pool`、`test:browser-canary`
- 数据：`test:dataset-ipc`
- 打包：`test:package-smoke`（= `package:open:dir` + `scripts/package-smoke.js`）——**计划假设的"真缺口"已部分落地**
- 供应链：`verify:supply-chain`、`verify:open-source-boundary`、`sbom`
- 聚合：`verify:ci` 串联以上全部 + typecheck + lint + test:open:full + build:open

**baseline 结论**：本仓库测试基础设施成熟，本轮所有"必要测试建议"均按计划要求先判定为"评估现有套件充分性"，仅在确认空白处提议新增（见各模块第 X.5 节）。

---

## 3. 模块一：本地数据工作台

### 审计范围
导入/查询/修改/导出/组织数据集链路在大数据量、异常输入、并发与中断恢复下的可靠性。

### 关键代码位置
- 导入：`src/main/duckdb/dataset-import-service.ts`、`import-worker.ts`
- 修改：`src/main/duckdb/dataset-record-mutation-service.ts`
- 并发闸：`src/main/duckdb/dataset-storage-service.ts:193`（`executeInQueue`）、`:202`（`executeInQueues` 稳定排序防死锁）
- 事务封装：`src/main/duckdb/utils.ts:735`（`runInDuckDbTransaction`，自动 BEGIN/COMMIT/ROLLBACK）
- 安全守卫：`src/main/duckdb/sql-validator.ts`
- 迁移：`src/main/duckdb/migration-engine.ts`、`schema-migrations.ts`

### 状态模型与正常路径结论
- 数据集每个 `datasetId` 有独立串行队列（`executeWithQueue`），跨数据集操作用 `executeInQueues` 按 sanitize 后 ID **排序**串行获取，显式规避 A→B/B→A 死锁——这是一个做得好的设计（`dataset-storage-service.ts:202-218`）。
- 批量记录更新**确实包了事务**：`dataset-record-mutation-service.ts:224` 的 `runInDuckDbTransaction` 包住整个 `for` 循环，单条失败回滚全批。计划 5.4 担心的"批量修改无事务"在此模块已解决。

### 失败路径与数据一致性结论
- 导入 worker 失败/异常退出有 `rejectWithCleanup`，会清理 `.wal/.tmp/-shm/-journal/.lock/-wal` 及 metadata（`dataset-import-service.ts:55-88, 194-208, 279-290`）。worker `exit` 非零码也被处理（`:279`）。
- `importRecordsFromFile` 用临时库 + 跨库 INSERT，`finally` 清理临时文件（`:437-441`），DETACH 在 `finally`（`:653-664`）。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M1-01 | **P0** | DB schema 迁移多步执行未包事务 | `migration-engine.ts:86-105` | 一个 migration 的 `up` 步骤数组逐条执行，若第 N 步失败，前 N-1 步已落库但 `schema_migrations` 未记录 → 重启后重跑整段 → 重复 DDL 报错或半成品 schema，无法恢复 | 将单个 migration 的全部 `up` 步骤 + INSERT 记录用 `runInDuckDbTransaction` 包成原子单元；DuckDB DDL 支持事务 |
| AUD-M1-02 | **P0** | 导入完成时 metadata 与数据文件写入非原子 | `dataset-import-service.ts:242-265` | worker 产出数据文件后，主线程 `saveMetadata` 若失败走 `rejectWithCleanup` 删文件——但若进程在 `saveMetadata` 成功后、`resolve` 前崩溃，会留下"有数据文件无 metadata"或反之的孤儿；无启动期对账 | 启动时做一次"数据文件↔metadata"对账扫描；或先写 metadata 占位 `status=importing` 再转 `ready` |
| AUD-M1-03 | P1 | 跨库 ATTACH 目标库不主动 DETACH | `dataset-import-service.ts:664` 注释"目标库保持 ATTACH" | 长时间运行后 ATTACH 的目标库累积，DuckDB 连接持有大量 attached db 句柄；依赖"智能管理机制"但未见上限 | 确认 attached db 是否有 LRU/上限；补一个 attached 数量上限测试 |
| AUD-M1-04 | P2 | 临时库命名用 `Date.now()` 可能碰撞 | `dataset-import-service.ts:369` `temp_import_${Date.now()}` | 同毫秒并发两次 `importRecordsFromFile` 会生成同名临时库路径，互相覆盖/串数据 | 改用 `generateId('temp_import')`（项目已有 id 生成器，line 27 已 import） |
| AUD-M1-05 | P2 | sql-validator 正则拦截可被构造绕过 | `sql-validator.ts:113-147` | 基于正则黑名单（`\bDROP\b` 等）；DuckDB 函数式破坏（如 `query()`/lambda/`list_transform` 调用副作用）或大小写/Unicode 同形未必命中；这是计算列表达式入口 | 评估改为 DuckDB EXPLAIN AST 白名单校验（已用 EXPLAIN，可解析 logical plan 拒绝非 PROJECTION）；补绕过用例测试 |
| AUD-M1-06 | P2 | `fs.stat` 失败时降级继续导入 | `dataset-import-service.ts:167-177` | 文件大小检查失败仅 warn 并继续，超大文件可能绕过 500MB 闸进 worker | 区分"文件不存在"（应直接失败）与"stat 权限问题"；不存在时 fail-fast |

### 测试覆盖结论
已有：`dataset-import-service.test.ts`、`dataset-query-service.test.ts`、`migration-engine.test.ts`、`dataset-storage-service.test.ts`、`dataset-row-count-reconciliation.test.ts`、`statement-executor.test.ts`、`sql-update-builder.test.ts`、`service.test.ts` + `__tests__/`。dataset area 共 61 个测试文件，覆盖充分。
**确认空白**：迁移多步部分失败的原子性测试（AUD-M1-01）；进程在 saveMetadata 与 resolve 之间崩溃的孤儿对账测试（AUD-M1-02）；并发同毫秒 importRecords 命名碰撞测试（AUD-M1-04）；sql-validator 绕过用例（AUD-M1-05）。

### 必要测试建议（仅确认空白）
- 迁移 `up` 数组中途抛错 → 验证 schema 与 `schema_migrations` 表一致、可重入。
- 模拟 metadata 写入后崩溃 → 启动对账能识别并清理孤儿。
- sql-validator 针对 `query()`、大小写混淆、Unicode 同形的拒绝测试。

---

## 4. 模块二：浏览器自动化工作流

### 审计范围
profile、账号、代理、指纹、浏览器池、自动化控制链路在多 runtime、多 profile、并发与异常退出下的可靠性。

### 关键代码位置
- 池管理：`src/core/browser-pool/pool-manager.ts`
- 获取/等待/转移：`browser-acquire-coordinator.ts`、`wait-queue.ts`、`wait-queue-coordinator.ts`
- 锁与所有权：`pool-manager.ts:444-459`（release requestId 校验）、`:552-572`（renewLock requestId 校验）
- 能力探测：`runtime-capability-registry.ts`、`browser-runtime-create-policy.ts`
- profile 服务：`src/main/duckdb/profile-service.ts`、`profile-partition-cleanup-service.ts`

### 状态模型与正常路径结论
- 架构是 **Profile = Session** 单一模型（`pool-manager.ts:6-25` 注释）。`acquire → 检查 profile → 复用空闲 → 不行则创建单实例 → 否则进等待队列`。
- **防 stale handle 做得扎实**：`release`/`renewLock` 都用 `expectedRequestId` 校验当前锁持有者（`:446-459`、`:559-572`），锁超时被他人重获后旧 handle 再 release 会被忽略并 warn，避免误释放/误交接。这是该模块的亮点。
- 释放时若有等待者**直接转移**浏览器（`:494-497`），不经过 idle，避免竞态——设计正确。
- profile 状态机（active/idle）随浏览器数量同步（`syncProfileIdleIfNoBrowsers:294-308`）。

### 并发与资源管理结论
- `destroyProfileBrowsers`、`releaseByPlugin` 都先取消等待请求再销毁浏览器，并 `processWaitQueue`，链路完整（`:317-337`、`:612-655`）。
- 业务层通过 `runtime-capability-registry` + `parseRequestedRuntimeId` 解析 runtime，**未硬编码具体 runtime 名称**做分支（`http-server-composition.ts:145` 经 capability 解析），符合计划 6.4 的"依赖 capability 而非名称"要求。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M2-01 | P1 | 浏览器崩溃后 profile 状态依赖健康检查，非即时 | `pool-manager.ts:198` `startHealthCheck()` + `:294` 仅在 browser 数归零时置 idle | 浏览器进程外部崩溃（非经 release）时，profile 仍可能停留 active 直到 health check 周期感知；窗口期内 acquire 可能误判可复用 | 在 browser 进程 `exit`/`disconnect` 事件上即时触发 `destroyBrowser` + 状态同步，不等健康检查 |
| AUD-M2-02 | P1 | 任务取消是否真正停止浏览器侧操作未在本层保证 | `pool-manager.ts` 无 cancel 传导到 page/CDP | pool 层只管租约，automation 任务取消能否中断正在执行的 CDP 操作取决于上层；计划 6.4 明确要求"取消能真正停止浏览器侧操作" | 核对 `browser-automation` 是否把 AbortSignal 传到 CDP 调用；补一个"取消正在执行的任务"集成测试 |
| AUD-M2-03 | P2 | profile user data dir 并发写入防护未在本层显式可见 | profile-service / partition 目录 | 单实例模型下同 profile 理论上只一个浏览器，但 `takeoverLockedBrowser`/`adoptSamePluginLockedBrowser` 存在多入口；user data dir 锁依赖 Chromium 自身 SingletonLock | 确认 takeover 路径不会在旧实例未完全退出时启动新实例写同一 partition；补并发 takeover 测试 |
| AUD-M2-04 | P2 | `forceRelease` 不校验 requestId | `pool-manager.ts:592-605` | 与 `release` 不同，`forceRelease` 无 requestId 校验（设计用于超时/异常），但若被误调用会绕过所有权保护 | 文档明确 forceRelease 仅限内部超时回收路径调用；或加调用源标记 |

### 测试覆盖结论
browser area **75 个测试文件**（全仓最多）。已有 `test:browser-pool` 覆盖 pool-manager、wait-queue、closed-persistent、global-pool、profile-live-session-lease；`test:browser-canary` + 9 个 real-browser 测试。覆盖是全项目最强的区域之一。
**确认空白**：浏览器进程崩溃 → profile 状态即时同步测试（AUD-M2-01）；取消传导到 CDP 的集成测试（AUD-M2-02）；并发 takeover 写同 partition 测试（AUD-M2-03）。

### 必要测试建议（仅确认空白）
- 模拟浏览器进程意外 exit，断言 pool 即时清理且 profile 转 idle、等待队列被重新驱动。
- 自动化任务在 `page.goto` 进行中取消，断言 CDP 操作被中断而非等待完成。

---

## 5. 模块六：任务系统和后台流程

### 审计范围
定时任务、长任务、后台/插件任务的状态机、取消、重试、恢复、可追踪性。

### 关键代码位置
- 通用队列：`src/core/task-manager/queue.ts`
- 调度器：`src/main/scheduler/scheduler-service.ts`
- 持久化：`src/main/duckdb/scheduled-task-service.ts`、`task-persistence-service.ts`
- 资源协调：`src/core/resource-coordinator.ts`

### 状态模型与正常路径结论
- **TaskQueue 做了硬取消（hard-settle）**：超时/取消通过 `settleCancelled` 强制结算队列记录，即使任务本体不响应 AbortSignal 也不会永久占用状态（`queue.ts:382-587`，注释明确这是修复项）。`stop()` 先处理 pending 再 abort running 再等 `allSettled`，避免 pause 死锁（`:314-369`）。
- **调度器恢复路径完整**：`init()` 启动时 `markStaleExecutionsCancelled()` 把上次未结束的执行标记为 cancelled（`scheduler-service.ts:94-99`）；`restoreActiveTasks()` 从 DB 恢复 active 任务（`:108-129`）。
- **错过执行有策略**：`missedPolicy: 'skip' | 'run_once'`（`:539-542`）；超长 delay 用 24h 分段定时器避免 setTimeout 溢出（`:563-574`）。
- **取消/暂停/删除都等运行中任务结束**：`tasksPendingDelete`/`tasksSuppressSchedule` 两个 Set 防止取消期间被重新调度（`:282-357`、`:619`）。
- **任务字段齐全**：execution 有 id/taskId/triggerType/status/startedAt/finishedAt/durationMs/error/result（`:702-708, 813-819`）；区分 cancelled 与 failed（cancelled 不计入 failCount，`:904-911`）。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M6-01 | P1 | `once` 任务在恢复窗口可能重复执行 | `scheduler-service.ts:532-549` + `:633-636` | 错过的 once 任务在 `scheduleTask` 里 `run_once` 执行后，仅在 `onTimerFired` 后置 `disabled`；若执行后、置 disabled 前进程崩溃，重启 `restoreActiveTasks` 会再次把它当 active 调度并可能重跑 | once 任务执行前先在 DB 置一个"已触发"标记，恢复时据此跳过 |
| AUD-M6-02 | P1 | 重试不区分幂等性，可能重复副作用 | `queue.ts:530-552`、`scheduler-service.ts:779-877` | 通用队列与调度器都按 `retry` 次数无条件重试 handler；若 handler 做了导入/外部 POST，重试会重复副作用。计划 10.4 明确点名此风险 | 在 TaskOptions/ScheduledTask 增加 `idempotencyKey` 或 `retryable` 标志；对非幂等任务默认 retry=0，并在文档约定 |
| AUD-M6-03 | P2 | 任务记录无 traceId 字段贯穿 | `queue.ts:133-140` TaskInfo 无 traceId | 计划 10.4 要求每任务有 trace id 串联日志；当前仅 taskId/executionId，跨 IPC/浏览器/数据层日志无法用统一 trace 关联 | 在 TaskContext 注入 traceId（复用 observability 的 trace 约定，见模块五），写入 execution 记录 |
| AUD-M6-04 | P2 | 通用队列任务历史仅内存，进程重启丢失 | `queue.ts:18` `MAX_COMPLETED_TASKS=100` 内存 Map | TaskQueue（区别于 scheduler 的 DB 持久化）完成历史只在内存，重启全失；诊断"上次那批任务为何失败"时无据可查 | 明确 TaskQueue 定位为瞬态；需审计的长任务走 scheduler 持久化路径，文档区分二者 |

### 测试覆盖结论
task area 仅 7 个测试文件，但关键的 `queue.test.ts`、`scheduler.test.ts`、`errors.test.ts`、`scheduler-service.test.ts`、`scheduler-resource.test.ts`、`scheduled-task-service.bigint.integration.test.ts` 都在。硬取消与资源协调已被测试。
**确认空白**：once 任务执行后崩溃重启的重复执行测试（AUD-M6-01）；重试副作用幂等测试（AUD-M6-02）。

### 必要测试建议（仅确认空白）
- once 任务 `run_once` 恢复后，注入"执行完成但未置 disabled 即崩溃"，断言重启不重跑。
- 非幂等 handler 在 retry>0 时被调用次数断言（驱动 AUD-M6-02 的 API 设计）。

---

## 6. 模块三：插件系统

### 审计范围
一方可信插件的加载、启停、升级、helper 调用、自有数据、页面、命令、定时任务不破坏主应用稳定性。

### 关键代码位置
- 管理器：`src/core/js-plugin/manager.ts`
- 生命周期：`plugin-lifecycle.ts`、加载器 `loader.ts`/`plugin-loader.ts`
- 注册表/运行时状态：`registry.ts`、`runtime-registry.ts`、`runtime-budget.ts`
- 数据表：`data-table-manager.ts`、安装器 `plugin-installer.ts`
- 信任策略：`trust-policy.ts`、`permissions.ts`

### 状态模型与正常路径结论
- **卸载链路完整且有序**：`uninstall` 走 deactivate(force) → unloadModule → deletePlugin → 处理数据表（delete 或 orphan）→ 删插件目录 → 删 DB 记录（custom_pages、js_plugins）→ removePlugin（`manager.ts:301-375`）。每步都在一个 observation span 内，失败记 `recordError` + 附 error context artifact。
- **错误带可观测上下文**：插件错误经 `runtimeRegistry.recordError(pluginId, error, level, name)`（`:349`）+ span 携带 pluginId / lifecyclePhase / runtimeStatus，满足计划 7.4 的"含 plugin id、hook、namespace"要求。
- **lifecycle phase 显式机**：`setLifecyclePhase(pluginId, 'stopping'|...)`（`:308`），runtime-registry 统一记录 workState/runningTasks/failedTasks（见 `http-server-composition.ts:292-345` 的 status 映射）。
- 运行时预算 `runtime-budget.ts` 有独立测试，约束插件资源占用。

### 失败隔离与升级结论
- 单插件操作失败被 `try/catch` 包裹并 `recordError`，不向上冒泡阻断其他插件（`manager.ts:347-374`、`:514-527`）。
- 数据表卸载区分 `deleteTables`（删）与 `orphanPluginTables`（保留为孤儿）（`:321-325`），升级保数据有路径。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M3-01 | P1 | 卸载多步骤跨存储非原子 | `manager.ts:312-338` | deactivate→删目录→删 DB 记录是多个 await，任一步后崩溃会留下不一致：目录已删但 DB 仍有 js_plugins 记录，或反之；重启后该插件"存在但加载不了" | 卸载前先在 DB 标 `state=uninstalling`，启动时扫描该状态做补偿清理（与 AUD-M1-02 同源问题） |
| AUD-M3-02 | P2 | 数据表迁移策略未见独立版本化 | `data-table-manager.ts` / `plugin-table-bootstrap.ts` | 计划 7.4 要求插件自有数据表升级有迁移策略；主应用有 `migration-engine`，但插件表是否复用同一带 checksum 的迁移引擎未确认 | 确认插件表走 `SchemaMigrationEngine`；若是各插件自管，补迁移失败回滚测试 |
| AUD-M3-03 | P2 | 重复加载去重依赖 registry，hot-reload 路径需核对 | `manager.ts` reload/import 路径 | 计划 7.4 关注重复加载是否重复注册命令/页面/定时器；卸载链路已删 custom_pages，但 hot-reload（`hotReloadEnabled`）下事件监听/scheduler handler 是否每次都先 unregister 需确认（scheduler 有 `unregisterPluginHandlers`，见 `scheduler-service.ts:157`） | 补 hot-reload 连续触发 N 次后断言 handler/page 数不累积的测试 |

### 测试覆盖结论
plugin area 24 个测试文件：`manager.test.ts`、`loader.test.ts`、`plugin-lifecycle.test.ts`、`plugin-installer.test.ts`、`plugin-loader.test.ts`、`registry.test.ts`、`runtime-registry.test.ts`、`runtime-budget.test.ts`、`trust-policy.test.ts`、`ui-extension-manager.test.ts`、`helpers.*.contract.test.ts`（4 个 helper 合约测试）。生命周期与 helper 合约覆盖良好。
**确认空白**：卸载多步崩溃的补偿测试（AUD-M3-01）；hot-reload 重复注册累积测试（AUD-M3-03）；插件表迁移失败回滚（AUD-M3-02）。

### 必要测试建议（仅确认空白）
- 注入卸载在"删目录后、删 DB 前"崩溃，断言重启补偿清理。
- hot-reload 连续 5 次，断言 scheduler handler 与 custom page 记录数不增长。

---

## 7. 模块四：本地 HTTP/MCP 自动化端点

### 审计范围
单一 MCP-over-HTTP 统一服务器作为 Agent/CLI/编排客户端入口的合约清晰度、稳定性、可测试性、可诊断性。

### 关键代码位置
- 组装：`src/main/http-server-composition.ts`
- 鉴权：`http-auth-middleware.ts`、`http-api-config-guard.ts`、合约常量 `src/constants/http-api.ts`
- MCP 路由/origin：`mcp-http-route-handlers.ts`、`mcp-http-transport-utils.ts`（`validateMcpOrigin`）
- 幂等：`orchestration-idempotency-duckdb-store.ts`
- 会话：`http-session-manager.ts`、`http-session-bridge.ts`

### 合约事实结论（计划重点）
- **默认免鉴权确认**：`DEFAULT_HTTP_API_CONFIG`（`http-api.ts:52-64`）`enabled: false`、`enableAuth: false`、`mcpRequireAuth: true`。
- **鉴权中间件只在有 token 时挂载**：`http-server-composition.ts:108-116`，`if (authToken) registerTokenAuthMiddleware(...)`。因此当用户开启 HTTP 但未设 token 时，`/api/v1/orchestration/*` 与 `/mcp` **默认无 Bearer 即可驱动 browser + profile + plugin + dataset 网关**。
- **该合约已被代码显式建模**：`describeHttpApiAuthContract`（`http-api.ts:136-176`）返回 `mode: 'no-auth'` 并附 detail 文案，是可被 UI/文档消费的事实。
- **DNS-rebinding 防护到位**：`validateMcpOrigin`（`mcp-http-transport-utils.ts:259-300`）默认只允许 loopback origin（`localhost/127.0.0.1/[::1]`），非 loopback 且未在 `mcpAllowedOrigins` 中则返回 **403** invalid-origin——这是稳定且可被客户端处理的合约行为。
- **传输输入收敛**：transport 层拒绝 `x-airpa-tool-profile`/`mcp-runtime-id` 等 header/query，强制走 `session_prepare`（`mcp-http-route-handlers.ts:27-80`），返回稳定的 `-32600 unsupported_transport_input`。

### 幂等结论
- `orchestration-idempotency-duckdb-store.ts` 是**活的**持久化实现：表 `orchestration_idempotency_entries`，主键 `(namespace, idempotency_key)`，记录 `request_hash`/`state`/`result_json`/`error_json`，按 `created_at` 建索引（`:10-33`）。仅在 `orchestrationIdempotencyStore === 'duckdb'` 时挂载（`http-server-composition.ts:572-576`），默认是 memory。TTL 由 `ORCHESTRATION_IDEMPOTENCY_TTL_MS` 控制（`http-api.ts:201`）。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M4-01 | P1 | 默认免鉴权合约文档/UI 告知不足 | `http-api.ts:52-64`、`http-server-composition.ts:108` | 默认 `enableAuth:false`，开启 HTTP 即暴露全网关；虽限 `127.0.0.1` 绑定（`HTTP_SERVER_DEFAULTS.BIND_ADDRESS`）+ origin 403，但本机其他进程/容器可直接调用编排 | 在开启 HTTP 的 UI 上对 no-auth 模式做显著警告（已有 `describeHttpApiAuthContract` 文案可复用）；README/runbook 明确"默认本机可信"前提 |
| AUD-M4-02 | P2 | duckdb 幂等条目无主动过期清理可见 | `orchestration-idempotency-duckdb-store.ts` | 表按 created_at 建索引、TTL 常量存在，但未见周期性 DELETE 过期行的清理任务；长期运行表会膨胀 | 确认是否有 TTL 清理；若无，加一个低频清理（复用 scheduler 的 cleanup 模式） |
| AUD-M4-03 | P2 | 幂等 request_hash 冲突语义需明确 | 同上 `request_hash` 列 | 相同 idempotency_key 但不同 request_hash（参数变了）应报冲突而非返回旧结果；需确认 store.get 是否比对 hash | 补"同 key 不同 hash"返回冲突错误的合约测试 |
| AUD-M4-04 | P3 | senderGuard 漏传即放行风险（横向） | 各 IPC handler | 计划 1 节点名："漏传 senderGuard 即静默放行"是健壮性 bug 而非授权设计 | 用 `test:architecture` 的 AST 扫描追加规则：断言所有 ipc handler 注册点都经过 senderGuard 包装 |

### 测试覆盖结论
http-mcp area **44 个测试文件**，含计划点名的大文件：`mcp-server-http.*.test.ts`（auth-invoke / browser-binding / mcp-surface / orchestration-routes / split-contract / start-stop / transport-session）、`mcp-server-http-transport.test.ts`、`orchestration-openapi-contract.test.ts`、`http-server-composition.test.ts`、`http-session-manager.test.ts`、`mcp-http-runtime-availability.test.ts` 等。**本模块测试已非常充分**，401/invalid-origin 已编码为契约。
**确认空白**：默认 no-auth 放行路径 vs token 模式对比（若 auth-invoke 未覆盖默认放行）；幂等同 key 不同 hash 冲突（AUD-M4-03）；幂等条目 TTL 清理（AUD-M4-02）。

### 必要测试建议（仅确认空白）
- `enableAuth:false` 下 orchestration 端点免 Bearer 成功调用 + `enableAuth:true` 下 401 的对比测试。
- 幂等存储 TTL 过期后同 key 重新执行的行为测试。

---

## 8. 模块五：桌面调试与运行健康系统

### 审计范围
启动失败、运行异常、浏览器崩溃、任务失败、数据异常、插件异常下，是否能提供足够定位/恢复/反馈信息。

### 关键代码位置
- 统一错误基类：`src/core/errors/BaseError.ts`（`CoreError`）
- 错误码：`src/types/error-codes.ts`（`ErrorCode`、`createStructuredError`、`StructuredError`）
- 观测：`src/core/observability/observation-service.ts`、`observation-context.ts`、`error-context-artifact.ts`
- 失败包：`src/core/observability/browser-failure-bundle.ts`
- HTTP trace：`src/main/http-trace-middleware.ts`

### 错误模型与可观测性结论（强项）
- **错误对象字段齐全**：`CoreError` 有 `code`/`message`/`details`/`context`/`timestamp`/`cause`（`BaseError.ts:63-116`）；`isUserError()`、`isRetryable()` 提供 recoverable/retryable 判定（`:169-187`）。
- **跨 IPC 序列化无损**：`toJSON()` 递归序列化 cause 链（`:121-155`），非 CoreError 的 cause 也降级为带 code 的结构（`:142-151`）。`isCoreError` 支持 duck-typing 跨进程识别（`:216-225`）。
- **trace 贯穿**：plugin manager 用 `observationService.startSpan({ context: traceContext, component, event, attrs })`（`manager.ts:290-299`），失败 `span.fail(error, { artifactRefs })` 附 error-context artifact；HTTP 层有 `registerTraceContextMiddleware`（`http-server-composition.ts:106`）。observationGateway 暴露 `getTraceSummary`/`getFailureBundle`/`getTraceTimeline`/`searchRecentFailures`（`:565-571`），trace 可从 HTTP 端查询——满足计划 9.4 的"一次操作串起多层日志"。
- **失败包存在**：`browser-failure-bundle.ts` + `getFailureBundle(traceId)` 链路。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M5-01 | P1 | `cause` 类型限定为 `Error`，丢失非 Error 抛出物上下文 | `BaseError.ts:87` `cause?: Error` | 当底层 `throw '字符串'` 或抛对象时，`fromError`/构造无法保留为结构化 cause，诊断链断裂 | `cause` 放宽为 `unknown` 并在 toJSON 里规范化；或在边界统一 `toError()` 包装（项目已有 `utils/error-message.toError`） |
| AUD-M5-02 | P2 | 日志保留/大小策略未在错误模型层体现 | logger/pino 配置 | 计划 9.4 要求日志有大小限制与保留策略；需确认 pino 是否配置 rotation（observation 写 DuckDB 有 cleanup，但文件日志未确认） | 核对 pino 文件 transport 是否有 rotation/maxSize；无则补 |
| AUD-M5-03 | P2 | health 三态（available/degraded/unavailable）需核对 | `http-system-routes.ts buildHealthPayload` | 计划 9.4 要求 health 区分三态；当前 health payload 聚合 session/runtime metrics，是否显式产出 degraded 态未确认 | 确认 buildHealthPayload 是否输出 degraded；补健康聚合三态测试 |

### 测试覆盖结论
observability area 13 个测试文件 + errors 的 `BaseError.test.ts`/`BrowserPoolError.test.ts`/`StealthError.test.ts`：`observation-service.test.ts`、`browser-failure-bundle.test.ts` 在列。错误序列化与失败包已被测试。
**确认空白**：非 Error 抛出物的 cause 保真测试（AUD-M5-01）；health 三态聚合测试（AUD-M5-03）；日志 rotation 测试（AUD-M5-02）。

---

## 9. 模块七：配置、存储、启动和升级系统

### 审计范围
首次/正常/异常退出后启动、配置损坏、数据迁移、插件/runtime/桌面应用升级的可控性。

### 关键代码位置
- 启动：`src/main/bootstrap/{app-ready,runtime-error,shutdown,stdio}-bootstrap.ts`、`app-runtime.ts`
- 配置归一化：`src/constants/http-api.ts`（`normalizeHttpApiConfig`，为历史配置补字段）
- 迁移：`src/main/duckdb/migration-engine.ts`、`schema-migrations.ts`
- edition：`src/edition`、`scripts/build-edition.js`
- 打包/供应链：`electron-builder.yml`、`scripts/{package-electron,verify-supply-chain,open-source-boundary,generate-sbom}.js`、`scripts/package-smoke.js`

### 启动与配置结论
- **启动分阶段且有专测**：`test:main-bootstrap` 覆盖 app-ready / runtime-error / shutdown / stdio 四个 bootstrap 阶段 + browser-pool-readiness（package.json）。失败阶段可定位。
- **配置归一化健壮**：`normalizeHttpApiConfig`（`http-api.ts:95-120`）为历史配置补齐新字段、屏蔽无效类型、port 强制取 runtime 值忽略持久化旧值（`:101`），对配置漂移有韧性。
- **迁移有 checksum 防漂移**：`migration-engine.ts:74-82` 已应用迁移的 checksum 不匹配会抛错，防止迁移定义被偷偷改动。
- **打包白名单显式**：`electron-builder.yml` 有 `asar: true`、`asarUnpack`、`extraResources`、`files` 白名单；`test:package-smoke` 已存在（这是计划假设的"真缺口"，实际已部分落地）。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M7-01 | **P0**（同 M1-01） | 迁移多步非事务化 | `migration-engine.ts:85-105` | 见 AUD-M1-01：单 migration 的 up 步骤逐条执行 + 末尾单独 INSERT 记录，中途失败留半成品 schema 且无记录，升级不可恢复 | 整个 migration（up 全部步骤 + 记录 INSERT）包进一个事务 |
| AUD-M7-02 | P2 | 配置写入原子性/备份恢复未确认 | 配置持久化（electron-store） | 计划 11.4 要求配置写原子化、损坏有备份恢复；electron-store 写入是否原子、损坏 JSON 是否有 fallback 未在本轮确认 | 核对配置写是否 temp+rename 原子；损坏时是否回落默认值而非崩溃 |
| AUD-M7-03 | P2 | 迁移无 down/回滚执行路径 | `migration-engine.ts:17` `down?` 字段存在但 migrate 不调用 | 有 `rollbackSql` 记录但无自动回滚执行；升级失败后只能靠重装或手工 | 文档明确"前滚不回滚"策略；或实现基于 rollback_sql 的回退命令 |
| AUD-M7-04 | P3 | 版本协调（app/config/db/plugin/runtime）无统一清单 | 多处分散 | 计划 11.4/13.9 要求版本协调；当前各子系统各自版本，无单一 manifest 汇总 | 增加一个启动时打印的版本矩阵（app version + schema migration head + plugin api version + runtime version） |

### 测试覆盖结论
bootstrap area 14 个 + config 3 个测试文件。`test:main-bootstrap`、`migration-engine.test.ts`、`dev-schema-bootstrap.test.ts`、`test:package-smoke`、`verify:supply-chain`、`sbom`、`verify:open-source-boundary` 齐备。供应链与启动覆盖良好。
**确认空白**：迁移多步部分失败原子性（AUD-M7-01，P0）；配置损坏恢复（AUD-M7-02）；目录无权限启动降级。

---

## 10. 模块八：本地能力原语

### 审计范围
本地 AI 推理、CV、向量检索、OCR、原生 FFI 在模型加载、推理失败、worker 崩溃、原生内存边界、并发背压下不拖垮主应用。**风险等级最高**（原生内存安全 + 模型下载 + worker 崩溃）。

### 关键代码位置
- ONNX：`src/core/onnx-runtime/onnx-service.ts`、`tensor-utils.ts`
- 向量/特征：`src/core/image-search/{hnsw-index,mobilenet-extractor,model-download-safety}.ts`
- 相似度：`src/core/image-similarity`
- worker pool：`src/core/system-automation/{ocr,cv}`
- FFI：`src/core/ffi/{ffi-service,library,callback,isolated-runner}.ts`

### 模型下载安全结论（强项）
- **强制 SHA256**：`assertModelInfoHasSha256` 要求 64 位 hex（`model-download-safety.ts:29-37`）；`verifyFileSha256` 流式校验，不匹配抛错（`:39-52`）。
- **zip 解压防护**：`safeExtractModelZip` 用 `assertSafeZipMetadata`（限 128 entries、单文件/总量上限、压缩比 100 防 zip bomb）+ `assertSafeZipEntryPath` 防 path traversal（`:54-68`、`:12-19`）。计划 12.4 担心的"加载被篡改/不完整模型"已被覆盖。

### ONNX/并发结论
- **推理有并发闸 + 超时 + 输入预算**：`acquireModelSlot` 按 `maxConcurrency`（默认 1，上限 8）排队（`onnx-service.ts:222-252`）；`withTimeout` 默认 30s（`:202-220`）；`assertInputBudget` 默认上限 1000 万元素防 OOM（`:185-200`）。背压做得好。
- **EP 回退有兜底**：`getExecutionProviders` 对 cuda/directml/coreml 都附加 `'cpu'` 兜底（`:131-142`）；初始化失败给 Windows VC++ Redist 安装提示（`:96-104`）。

### FFI 结论
- **路径白名单 + realpath**：`validateLibraryPath` 限插件目录 / userData/lib / 系统目录，用 `realpathSync` 防符号链接逃逸（`ffi-service.ts:353-406`）。系统库走 allowlist（`SYSTEM_LIBS_WHITELIST`）。
- **资源上限 + dispose**：maxLibraries(10)/maxCallbacks(50)（`:79-80`）；`dispose()` 释放所有 callback 与 library（`:307-338`）；默认 `isolateCalls: true` 走隔离 runner（`:82`）。

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| AUD-M8-01 | P1 | ONNX `unloadModel` 无显式 session 释放，依赖 GC | `onnx-service.ts:338-352` 注释"InferenceSession 没有 dispose，依赖 GC" | 大模型卸载后原生内存不立即释放，反复加载/卸载不同模型会推高常驻内存直至 GC；`models` Map 无全局内存/数量上限 | 加全局已加载模型数上限 + LRU 驱逐；调研 onnxruntime-node 的 `session.release()`（新版本有）显式释放 |
| AUD-M8-02 | P1 | `unloadModel` 不等待 activeRuns 归零 | `onnx-service.ts:338-347` | 卸载时若有 in-flight 推理（activeRuns>0 或 waiters 非空），直接 `models.delete` 会让等待者永久挂起、运行中推理结果无主 | 卸载前检查 activeRuns/waiters，拒绝或等待 drain；唤醒所有 waiters 并抛 ModelNotFound |
| AUD-M8-02b | P2 | EP 回退发生时无可观测信号 | `onnx-service.ts:131-142, 300-310` | cuda→cpu 静默回退，用户不知推理跑在 CPU（慢 10x）；计划 12.4 要求"优雅降级"但也需可诊断 | session 创建后记录实际 EP，log + 暴露到 getModelInfo |
| AUD-M8-03 | P2 | HNSW 索引版本/损坏检测需核对 | `image-search/hnsw-index.ts` | 计划 12.4 要求索引损坏/版本不匹配可检测恢复；需确认 hnsw-index 加载时是否校验维度/版本头 | 核对 `hnsw-index.test.ts` 是否覆盖损坏文件加载；补版本头校验 |
| AUD-M8-04 | P3 | FFI `listLibraries` 的 loadedAt 是占位值 | `ffi-service.ts:275` 注释"简化：实际应记录真实时间" | 诊断 FFI 库加载时间时永远是当前时刻，失真 | Library 实例记录真实 loadedAt，listLibraries 返回真值 |

### 测试覆盖结论
native area 15 个测试文件：`hnsw-index.test.ts`、`mobilenet-extractor.test.ts`、`model-download-safety.test.ts`、`image-similarity-service.test.ts`、`onnx-service.test.ts`、`ffi/{library,isolated-runner}.test.ts`、`system-automation/types.test.ts`。模型下载安全与基础推理已测。
**确认空白**：ONNX 卸载时 in-flight 推理处理（AUD-M8-02）；EP 实际回退路径断言（AUD-M8-02b）；HNSW 损坏文件恢复（AUD-M8-03）；FFI double-free/句柄泄漏边界（计划 12.5）；worker pool 崩溃重启与背压（system-automation）。

### 必要测试建议（仅确认空白）
- 卸载正在推理的模型，断言 waiters 被唤醒且不挂起。
- 强制 cuda 不可用，断言回退 cpu 且记录可观测信号。
- 加载截断/损坏的 HNSW 索引文件，断言检测并优雅失败。
- OCR/CV worker 崩溃后断言池重启、崩溃任务标记失败而非永久挂起。

---

## 11. 横向主题复盘

### 11.1 架构边界
八个模块 owner 清晰，IPC/HTTP-MCP/插件 helper 多为适配层。亮点：HTTP 层经 capability 解析 runtime 而非硬编码名称；dataset 跨数据集操作排序串行防死锁。**待收敛**：多个模块（M1 导入、M3 卸载、M7 迁移）共享"多步跨存储非原子"的同构问题，建议统一一个"操作前置 pending 状态 + 启动期补偿扫描"模式。

### 11.2 数据安全与一致性
- 写操作有串行队列（dataset per-id queue）+ 事务封装（`runInDuckDbTransaction`），批量更新已包事务。
- **共性缺口**：跨存储边界（DB 文件 + metadata + 插件目录 + schema_migrations 表）的写入非原子，崩溃留孤儿。**这是本轮最高优先级主题**，对应 AUD-M1-01/02、M3-01、M7-01。

### 11.3 插件系统稳定性
lifecycle/helper/scheduler/data-table 都有失败隔离与可观测 span；卸载链路有序。缺口在卸载原子性与 hot-reload 去重的回归测试。

### 11.4 浏览器自动化可靠性
状态模型一致（Profile=Session），requestId 防 stale handle 是亮点。缺口：崩溃即时感知（依赖 health check 周期）、取消到 CDP 的传导验证。

### 11.5 API/MCP 合约质量
端点有 structured error、稳定错误码、origin 403、transport 输入收敛、duckdb 幂等。44 个测试文件覆盖充分。缺口：默认 no-auth 合约的文档/UI 告知（AUD-M4-01）。

### 11.6 错误处理与可观测性
`CoreError` 统一、可序列化、cause 链、trace 贯穿、failure bundle、observationGateway 查询——**全项目最成熟的横向能力之一**。缺口：cause 限定 Error 类型、文件日志 rotation。

### 11.7 测试覆盖
351 文件分层清晰（unit 322 / contract 9 / integration 8 / real 4 / smoke 2 / canary 3 / architecture 3）。`test:architecture` AST 治理 + `test:package-smoke` 已存在。**本轮所有新增测试建议均为"确认空白后补缺"，无"从零重写"。** 主要空白集中在"崩溃恢复/原子性/原生层边界"这类失败路径。

### 11.8 依赖与供应链
`verify:supply-chain`、`verify:open-source-boundary`、`sbom`、`electron-builder` files 白名单、asarUnpack 齐备，`verify:ci` 串联全链。原生依赖（duckdb-node、koffi、onnxruntime-node）走 asarUnpack。未见明显缺口；建议确认外部 tarball 依赖（若有）的来源校验。

### 11.9 发布与升级
启动分阶段有专测，迁移有 checksum 防漂移，打包有 smoke。缺口：迁移无自动回滚（前滚策略需文档化，AUD-M7-03）、版本协调无统一清单（AUD-M7-04）。

---

## 12. 问题汇总 backlog（按级别）

### P0（数据损坏 / 升级不可恢复）
| ID | 模块 | 标题 |
| --- | --- | --- |
| AUD-M1-01 / M7-01 | 数据/升级 | DB schema 迁移多步执行未包事务，部分失败留半成品 schema |
| AUD-M1-02 | 数据 | 导入完成时 metadata 与数据文件写入非原子，崩溃留孤儿 |

### P1（高频流程失败 / 资源泄漏 / 不可诊断 / 关键测试缺失）
| ID | 模块 | 标题 |
| --- | --- | --- |
| AUD-M4-01 | HTTP/MCP | 默认免鉴权合约文档/UI 告知不足 |
| AUD-M8-01 | 能力原语 | ONNX unloadModel 无显式释放 + 无全局内存上限 |
| AUD-M8-02 | 能力原语 | unloadModel 不等待 in-flight 推理，waiters 永久挂起 |
| AUD-M5-01 | 观测 | CoreError cause 限定 Error，丢失非 Error 抛出物上下文 |
| AUD-M2-01 | 浏览器 | 崩溃后 profile 状态依赖健康检查非即时 |
| AUD-M2-02 | 浏览器 | 任务取消到 CDP 的传导未在本层保证 |
| AUD-M3-01 | 插件 | 卸载多步骤跨存储非原子 |
| AUD-M6-01 | 任务 | once 任务在恢复窗口可能重复执行 |
| AUD-M6-02 | 任务 | 重试不区分幂等性，可能重复副作用 |

### P2（边缘流程 / 日志不足 / 类型边界 / 局部测试薄弱）
AUD-M1-03（ATTACH 残留）、M1-04（临时库命名碰撞）、M1-05（sql-validator 正则绕过面）、M1-06（stat 失败降级）、M2-03（partition 并发写）、M2-04（forceRelease 无 requestId）、M3-02（插件表迁移版本化）、M3-03（hot-reload 去重）、M4-02（幂等条目无过期清理）、M4-03（幂等 hash 冲突语义）、M5-02（日志 rotation）、M5-03（health 三态）、M6-03（任务无 traceId）、M6-04（队列历史仅内存）、M7-02（配置原子写/恢复）、M7-03（迁移无回滚）、M8-02b（EP 回退无信号）、M8-03（HNSW 版本检测）。

### P3（文档 / 命名 / 维护性 / 低风险清理）
AUD-M4-04（senderGuard AST 断言）、M7-04（版本协调清单）、M8-04（FFI loadedAt 占位）、以及工程卫生项 **AUD-HYG-01：3 个源码文件含 mojibake 替换字符，其中 `src/main/scheduler/scheduler-service.ts` 多处中文注释损坏**（建议用 `git log` 找到引入 commit 并以 UTF-8 重新保存）。

---

## 13. 修复优先级路线图

1. **第一波（P0，数据/升级安全）**：AUD-M1-01/M7-01 迁移事务化、AUD-M1-02 导入孤儿对账。这两项是"操作前置 pending 状态 + 启动补偿扫描"统一模式的首批应用，建议一并设计，顺带覆盖 AUD-M3-01。
2. **第二波（P1，可诊断与资源）**：ONNX 卸载安全（M8-01/02）、默认鉴权告知（M4-01）、cause 类型放宽（M5-01）、浏览器崩溃即时感知（M2-01）、任务幂等与 once 恢复（M6-01/02）。
3. **第三波（P2/P3，加固与卫生）**：sql-validator 白名单化、幂等清理、日志 rotation、health 三态、mojibake 修复、版本清单。

每项落地都应附"确认空白后新增"的测试（见各模块第 X 节），并入 `verify:ci`。

---

## 14. 交付物对照（计划第 16 节）

| 交付物 | 状态 |
| --- | --- |
| 全量审计报告 | ✅ 本文件 |
| 八个模块独立审计记录 | ✅ 第 3–10 节，按计划第 14 节模板 |
| 九个横向主题复盘 | ✅ 第 11 节 |
| 测试 baseline 与缺口 diff | ✅ 第 2 节（baseline）+ 各模块"测试覆盖结论/确认空白" |
| P0/P1/P2/P3 问题列表 | ✅ 第 12 节 |
| 修复优先级路线图 | ✅ 第 13 节 |
| 回归测试矩阵 | ◐ 各模块"必要测试建议"已列；建议落成独立测试矩阵表 |
| 发布前检查清单 | ◐ `verify:ci` 已是事实清单；建议补人工项 |
| 架构图/数据流图/状态机图 | ☐ 文字描述已具备，图形化待补 |

> 说明：本报告基于源码静态走读 + 测试盘点，未实际运行全部测试套件验证每条结论的可复现性。标注"需确认/需核对"的条目（如配置原子写、HNSW 版本头、日志 rotation、health 三态）是本轮未深挖到底、留给下一轮带复现步骤验证的开放项。
