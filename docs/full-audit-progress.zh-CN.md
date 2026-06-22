# 天蛇客户端全量审计进度记录

> 本文件是 `docs/full-audit-plan.zh-CN.md` 的执行记录。审计要求是结合真实代码逐项分析并标记，不用聊天结论替代证据。本文件会持续追加，直到七个纵向模块和九个横向主题全部完成。

## 1. 标记约定

### 1.1 模块状态

- `未开始`：尚未进入代码审计。
- `进行中`：已开始阅读代码并记录证据，但尚未覆盖全部核心流程。
- `待复核`：已完成一轮代码走读，需要测试、复现或二次确认。
- `已完成`：代码证据、测试证据、问题清单和横向复盘均已完成。

### 1.2 发现级别

- `P0`：可能导致数据损坏、主流程不可用、应用无法启动、任务无限卡死、升级不可恢复。
- `P1`：高频用户流程失败、资源泄漏、并发状态污染、错误不可诊断、关键测试缺失。
- `P2`：边缘流程不稳定、日志不足、类型边界不清、局部测试薄弱。
- `P3`：文档缺失、命名不一致、维护性问题、低风险清理项。

### 1.3 证据状态

- `已证实`：代码路径明确，风险或结论可由当前文件内容直接支持。
- `待复现`：代码显示风险，但需要测试或运行场景确认影响。
- `待核查`：已有线索，但尚未完成足够上下文阅读。
- `已排除`：已确认不是问题，并记录排除理由。

## 2. 总览

| 纵向模块 | 状态 | 当前结论 |
| --- | --- | --- |
| 本地数据工作台 | 待复核 | 已完成入口、写入队列、导入、导出、记录变更、schema 变更、插件 database helper 的第一轮代码走读，发现 8 个风险点，后续需要故障注入和 targeted tests 复核。 |
| 浏览器自动化工作流 | 待复核 | 已完成 runtime、browser pool、等待队列、profile integration、Extension/Ruyi/Cloak controller、下载/拦截/弹窗能力的第一轮代码走读，发现 7 个风险点，后续需要入口侧和 targeted tests 复核。 |
| 插件系统 | 待复核 | 已完成 manifest/加载/安装/更新/卸载/生命周期/helper/context/UI 扩展/热重载/执行协调器的第一轮代码走读，发现 9 个风险点，后续需要用 targeted tests 复核命令注册、安装补偿、激活失败清理和插件表一致性。 |
| 本地 HTTP/MCP 自动化端点 | 待复核 | 已完成 HTTP server composition、route registry、MCP transport/session、orchestration REST、browser binding、auth/trace/health、idempotency persistence 的第一轮代码走读，发现 6 个风险点，后续需要 targeted tests 复核超时后台任务、server start 幂等和 cleanup 异常边界。 |
| 桌面调试与运行健康系统 | 待复核 | 已完成 observation trace/failure bundle、DuckDB runtime observation、IPC/HTTP/MCP 观测入口、启动诊断、运行指纹、健康检查、运行时异常和关闭协调的第一轮代码走读，发现 7 个风险点，后续需要 targeted tests 复核超时后台副作用、观测数据损坏容错和保留策略。 |
| 任务系统和后台流程 | 待复核 | 已完成 TaskQueue、Pipeline、SchedulerService、ScheduledTaskService、插件 taskQueue/scheduler namespace、Scheduler IPC/store、resourceCoordinator 和旧 TaskPersistenceService 的第一轮代码走读，发现 7 个风险点，后续需要 targeted tests 复核 pending cancel、timer failure reschedule、取消后互斥保护和执行历史恢复。 |
| 配置、存储、启动和升级系统 | 待复核 | 已完成 runtime config、electron-store/localStorage 配置、DuckDB schema migration/启动恢复、extension package 仓库、updater、build stamp/freshness、启动/关闭接线的第一轮代码走读，发现 7 个风险点，后续需要 targeted tests 复核迁移原子性、扩展包文件/元数据一致性和 updater 生命周期。 |

## 3. 审计准备记录

### 3.1 已确认技术栈

- Electron 主进程、预加载脚本、React/Vite 渲染进程、TypeScript。
- DuckDB 本地数据存储，`@duckdb/node-api`。
- 浏览器自动化涉及 Electron WebContents、extension relay、Ruyi/Firefox、Cloak/Playwright 相关目录。
- 插件 helper 位于 `src/core/js-plugin`。
- MCP/HTTP 端点位于 `src/main/mcp-*`、`src/main/http-*`。
- 观测和失败包位于 `src/core/observability`、`src/main/bootstrap` 等目录。

### 3.2 已确认测试入口

- `npm run test:open`
- `npm run test:open:full`
- `npm run test:architecture`
- `npm run test:browser-pool`
- `npm run test:dataset-ipc`
- `npm run typecheck`
- `npm run lint`
- `npm run verify:ci`

### 3.3 已创建计划文档

- `docs/full-audit-plan.zh-CN.md`

## 4. 模块一：本地数据工作台

状态：`待复核`

### 4.1 审计范围

第一轮已覆盖：

- 主进程 DuckDB 数据服务：`src/main/duckdb`
- 数据集 IPC handler：`src/main/ipc-handlers/dataset-handler.ts`
- 数据集 IPC route 拆分目录：`src/main/ipc-handlers/dataset-routes`
- 插件 database helper：`src/core/js-plugin/namespaces/database.ts`
- 渲染层 dataset store：`src/renderer/src/stores/datasetStore.ts` 和 `src/renderer/src/stores/dataset`
- 数据集 UI 主页面：`src/renderer/src/components/DatasetsPage`
- 查询引擎：`src/core/query-engine`
- 相关测试：`dataset-handler.test.ts`、`datasetStore.test.ts`、`dataset-*` service/integration tests、query-engine tests。

### 4.2 入口和核心流程

已确认的数据工作台入口：

- 导入新数据集：`duckdb:import-dataset-file` -> `DuckDBService.importDatasetFile` -> `DatasetImportService.importDatasetFile`
- 取消导入：`duckdb:cancel-import` -> `DatasetImportService.cancelImport`
- 追加导入记录：`duckdb:import-records-from-file` / `duckdb:import-records-from-base64` -> `DatasetImportService.importRecordsFromFile`
- 查询数据集：`duckdb:query-dataset` -> `DatasetQueryService.queryDataset`
- 查询引擎执行：`duckdb:execute-query` -> `queryWithEngine`
- 创建空数据集：`duckdb:create-empty-dataset` -> `DatasetService.createEmptyDataset`
- 删除数据集：`duckdb:delete-dataset` -> `DatasetStorageService.deleteDataset` + `DatasetMetadataService.deleteMetadata`
- 重命名数据集：`duckdb:rename-dataset` -> `DatasetMetadataService.renameDataset`
- 插入记录：`duckdb:insert-record` -> `DatasetRecordMutationService.insertRecord`
- 批量插入记录：`duckdb:batch-insert-records` -> `DatasetRecordMutationService.batchInsertRecords`
- 更新记录：`duckdb:update-record` -> `DatasetRecordMutationService.updateRecord`
- 批量更新记录：`duckdb:batch-update-records` -> `DatasetRecordMutationService.batchUpdateRecords`
- 硬删除行：schema routes 中 hard delete -> `DatasetRecordMutationService.hardDeleteRows`
- 添加列：`duckdb:add-column` -> `DatasetSchemaService.addColumn`
- 更新列：`duckdb:update-column` -> `DatasetSchemaService.updateColumn`
- 删除列：`duckdb:delete-column` -> `DatasetSchemaService.deleteColumn`
- 导出数据集：`duckdb:export-dataset` -> `DatasetExportService.exportDataset`
- 插件访问：`DatabaseNamespace` 调用 DuckDB service 的 query/insert/update/delete/import/export 能力。

### 4.3 已验证的正向设计

#### DATA-OK-001：同一数据集操作存在串行队列

状态：`已证实`

证据：

- `DatasetStorageService.executeWithQueue` 使用 `queryQueues: Map<string, Promise<any>>` 串联同一数据集操作。
- `executeInQueue` 统一 sanitize dataset id 后入队。
- `executeInQueues` 对多个数据集 id 去重并排序，避免跨数据集 A->B / B->A 死锁。
- 相关测试存在：`dataset-storage-service.test.ts` 覆盖失败后继续队列、不同数据集隔离、队列清理、多队列稳定顺序。

影响：

- 查询、导出、记录写入、schema 修改等大量路径通过队列执行，整体并发基础不是裸奔状态。

#### DATA-OK-002：多条记录更新和批量插入使用 DuckDB transaction

状态：`已证实`

证据：

- `DatasetRecordMutationService.hardDeleteRows` 在 `runInDuckDbTransaction` 中分批 count + delete。
- `DatasetRecordMutationService.updateRecord` 在 transaction 中执行单条 UPDATE。
- `DatasetRecordMutationService.batchUpdateRecords` 在 transaction 中循环 UPDATE。
- `DatasetRecordMutationService.batchInsertRecords` 在 transaction 中按批 INSERT。
- `runInDuckDbTransaction` 在 `src/main/duckdb/utils.ts` 中统一 `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`。

影响：

- 批量写入失败时具备回滚基础，优于逐条裸写。

#### DATA-OK-003：导入新数据集具备 worker 失败清理

状态：`已证实`

证据：

- `DatasetImportService.importDatasetFile` 创建 worker 后监听 `message:error`、`error`、非零 `exit`。
- `rejectWithCleanup` 会发送 failed progress、清除 worker tracking、执行 `cleanupImportArtifacts`。
- `cleanupImportArtifacts` 尝试删除 `.db`、`.wal`、`.tmp`、`-shm`、`-journal`、`.lock`、`-wal` 并删除 metadata。
- `cancelImport` 会 terminate worker 并清理导入产物。

影响：

- 新建导入的失败路径有清理设计，不是只抛错。

#### DATA-OK-004：渲染层 dataset store 对异步竞态有防护

状态：`已证实`

证据：

- `datasetStore.test.ts` 覆盖 stale dataset info response、切换数据集后旧 query result 被忽略、loadMore late page 被忽略。
- `refreshDatasetView` 通过重新加载 dataset info 和 active query template 同步当前视图。
- 乐观更新 slice 有本地事务回滚测试。

影响：

- UI 层已意识到数据集切换和异步请求乱序问题，已有测试覆盖。

#### DATA-OK-005：插件 database helper 的危险 raw where 更新/删除已禁用

状态：`已证实`

证据：

- `DatabaseNamespace.update(datasetId, updates, where)` 在参数校验后直接调用 `rejectRawWhereOperation('update', 'updateById')`。
- `DatabaseNamespace.delete(datasetId, where)` 在参数校验后直接调用 `rejectRawWhereOperation('delete', 'deleteById')`。
- `database.test.ts` 覆盖 update/delete legacy where 接口拒绝，并确认不会调用底层 SQL 执行或批量更新/删除。

影响：

- 插件侧不再允许通过 raw WHERE 字符串直接执行 UPDATE/DELETE，降低注入和误删风险。权限与信任边界不在本轮主题内，但从稳定性角度这是正向收敛。

#### DATA-OK-006：数据查询入口有只读 SQL 约束和测试

状态：`已证实`

证据：

- `src/utils/sql-readonly.ts` 要求 SQL 以 `SELECT|WITH|EXPLAIN|DESCRIBE|SHOW` 开头。
- 同文件拒绝多语句分号和 `ALTER|ATTACH|COPY|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|SET|UPDATE|VACUUM` 等变更关键词。
- `DatasetQueryService.queryDataset` 在自定义 SQL 路径调用 `assertReadOnlySQL(sql)`。
- `DatabaseNamespace.executeSQL` 在提供 `datasetId` 时调用 `assertReadOnlySQL(sql)`，再 attach dataset 后执行。
- `dataset-query-service.test.ts` 覆盖 query endpoint 拒绝 DELETE、多语句，并允许字符串 literal 中出现 update。
- `database.test.ts` 覆盖 `executeSQL(..., { datasetId })` 拒绝 DELETE 和多语句。

影响：

- 常规查询和插件 datasetId 绑定查询不会执行变更 SQL，降低意外写入风险。

### 4.4 已发现问题

#### DATA-001：追加导入记录未纳入数据集队列，可能与查询、导出、schema 修改和记录变更并发冲突

级别：`P1`

证据状态：`已证实代码路径，待复现影响`

代码证据：

- `DatasetService.importRecordsFromFile` 直接代理到 `DatasetImportService.importRecordsFromFile`，没有包裹 `DatasetStorageService.executeInQueue`。
- `DatasetImportService.importRecordsFromFile` 在 worker 完成后调用 `crossDatabaseInsert`。
- `crossDatabaseInsert` 直接 `ATTACH` 临时库和目标库，然后执行 `INSERT INTO target SELECT ... FROM temp`。
- 同模块内查询、导出、记录写入、schema 修改普遍使用 `storageService.executeInQueue`，说明目标库并发访问预期应被串行化。

影响场景：

- 用户在追加导入记录时，同时查询、导出、改 schema、批量编辑或删除同一数据集。
- 插件通过 `helpers.database.importRecordsFromFile` 追加导入，同时 UI 或任务系统操作同一数据集。

风险：

- 可能出现 DuckDB attach/file lock 冲突。
- 可能出现 schema 变化期间追加导入，导致 INSERT 列集合与目标表不匹配。
- 可能出现 row_count 计数与真实行数不同步。
- 可能破坏同一数据集所有操作都经队列串行的架构假设。

建议修复方向：

- 将 `DatasetStorageService` 注入 `DatasetImportService`，或在 `DatasetService.importRecordsFromFile` 处包裹目标 dataset queue。
- `crossDatabaseInsert` 和后续 `incrementRowCount` 应处于同一个队列上下文。
- 增加并发测试：追加导入 vs schema 修改、追加导入 vs 查询、追加导入 vs 导出后删除、追加导入失败后队列继续执行。

需要新增测试：

- `DatasetImportService.importRecordsFromFile` 应证明会获取目标 dataset queue。
- 并发追加导入和 `updateColumn` 的稳定顺序测试。
- 追加导入失败后不影响后续同 dataset 队列任务测试。

#### DATA-002：导出后删除物理行未更新持久化 row_count

级别：`P1`

证据状态：`已证实代码路径，待复现 UI/metadata 影响`

代码证据：

- `DatasetExportService.exportDataset` 在 `postExportAction === 'delete'` 时调用 `handlePostExportAction`。
- `handlePostExportAction` 执行 `DELETE FROM ds_<datasetId>.data WHERE _row_id IN (...)`，返回 `result.rowsChanged`。
- 该服务没有调用 `DatasetMetadataService.incrementRowCount(datasetId, -deletedRows)`。
- 渲染层 `DatasetsPage.index.tsx` 在导出成功后会本地 `applyLocalDatasetCountDelta` 并 `refreshDatasetView`，但如果主进程 metadata 没更新，刷新可能重新读到旧的 row_count。
- 现有 integration test 只验证导出后物理表剩余行数和 `result.deletedRows`，未验证 `datasets.row_count` 是否同步。

影响场景：

- 用户选择“导出后删除”。
- 导出后 UI、侧边栏、分组 tab、插件 helper 或 HTTP/MCP 读取 dataset metadata。

风险：

- 真实数据已删除，但 metadata row_count 仍为旧值。
- 之后基于 row_count 的分页、进度、筛选比例、UI 展示可能不准确。
- 如果后续操作依赖 metadata 计数，会放大为业务一致性问题。

建议修复方向：

- `DatasetExportService` 注入或接收 `DatasetMetadataService`，在 `handlePostExportAction` 成功后持久化扣减 row_count。
- 删除和 row_count 更新最好在同一 dataset queue 内，必要时使用 transaction 或补偿校验。
- 增加 integration test 验证 `datasets.row_count` 与物理表 count 一致。

需要新增测试：

- 导出后删除应同步 `datasets.row_count`。
- 导出后删除失败时不应扣减 row_count。
- 导出后删除部分 batch 时 row_count 应扣减实际 `rowsChanged`。

#### DATA-003：创建空数据集跨文件 DB 和主 metadata 不在同一事务/补偿边界内

级别：`P2`

证据状态：`已证实代码路径，待复现失败残留`

代码证据：

- `DatasetService.createEmptyDataset` 先 `ATTACH` 新 dataset db 文件，再 `CREATE TABLE` 和 row id sequence。
- 随后 `DatasetTabGroupService.createGroupForDataset` 向主库写入 `dataset_tab_groups`。
- 再 `DatasetMetadataService.saveMetadata` 向主库写入 `datasets`。
- 外层只有 dataset queue，没有 `runInDuckDbTransaction` 包裹主库 metadata/group 写入，也没有 catch 中删除已创建的新 dataset 文件或已写入的 tab group。
- `finally` 只负责 `DETACH`。

影响场景：

- 创建空数据集过程中，创建表成功但 tab group 写入失败。
- tab group 写入成功但 metadata 写入失败。
- metadata 写入前后应用崩溃。

风险：

- 可能留下孤儿 dataset db 文件。
- 可能留下 `dataset_tab_groups` 孤儿记录。
- UI 看不到数据集但磁盘或主库 metadata 残留。

建议修复方向：

- 主库 `dataset_tab_groups` 和 `datasets` 写入使用 transaction。
- catch 中补偿删除新建 dataset 文件和已创建的 tab group。
- 增加故障注入测试。

需要新增测试：

- `createEmptyDataset` 在 `saveMetadata` 失败时清理 dataset 文件和 tab group。
- `createEmptyDataset` 在 `createGroupForDataset` 失败时清理 dataset 文件。

#### DATA-004：schema 变更先改物理表后改 metadata，失败时可能导致物理表和 schema metadata 分裂

级别：`P1`

证据状态：`已证实代码路径，待复现失败场景`

代码证据：

- `DatasetSchemaService.addColumn` 先 `createPhysicalColumn`，再 `metadataService.updateDatasetSchema`；默认值填充和 copyDataFrom 在 metadata 更新后执行。
- `DatasetSchemaService.updateColumn` 对物理列先执行 `ALTER TABLE RENAME COLUMN` / `ALTER COLUMN SET DATA TYPE` / `SET/DROP NOT NULL`，然后才 `updateDatasetSchema`。
- `DatasetSchemaService.deleteColumn` 对物理列先 `ALTER TABLE DROP COLUMN`，然后才 `updateDatasetSchema`。
- 上述流程均在 dataset queue 内，但未看到跨物理表和主 metadata 的统一事务或失败补偿。

影响场景：

- 添加列时物理列创建成功，metadata 更新失败。
- 更新列时物理列 rename/type 变更成功，metadata 更新失败。
- 删除列时物理列已删除，metadata 仍保留旧列。

风险：

- UI schema 与真实表结构不一致。
- 查询、导出、插件 helper 依据 metadata 生成 SQL 时失败。
- 计算列依赖关系和物理表实际列不同步。

建议修复方向：

- 对可事务化的 DuckDB ALTER + metadata 更新使用 `runInDuckDbTransaction` 评估可行性。
- 对跨 attach DB 不可统一事务的场景，加入补偿动作或 schema reconcile/health check。
- 增加 schema 变更失败注入测试。

需要新增测试：

- `addColumn` 在 metadata 更新失败时应回滚或补偿删除物理列。
- `updateColumn` 在 metadata 更新失败时应回滚 rename/type 或进入可诊断状态。
- `deleteColumn` 在 metadata 更新失败时应恢复物理列或触发 schema repair。

#### DATA-005：记录插入与 metadata row_count 更新不在同一事务内

级别：`P2`

证据状态：`已证实代码路径，待评估影响`

代码证据：

- `insertRecordInCurrentQueue` 执行 `INSERT INTO data` 后，再调用 `metadataService.incrementRowCount`。
- `metadataService.incrementRowCount` 失败只记录 warn，不回滚插入。
- `batchInsertRecords` 也在批量 INSERT transaction 成功后单独 increment row_count，失败只 warn。
- `importRecordsFromFile` 同样在跨库 INSERT 成功后单独 increment row_count，失败只 warn。
- `hardDeleteRows` 删除物理行成功后单独 decrement row_count，失败只 warn。

影响场景：

- metadata DB 暂时写入失败、锁冲突、进程中断。
- 大量插入/删除后 row_count 累计偏差。

风险：

- metadata row_count 与真实行数不一致。
- 当前策略可能是性能换一致性，需要明确是否接受“最终可修复”。

建议修复方向：

- 明确 row_count 是否是缓存字段。如果是缓存，应提供 reconcile/repair 入口和健康检查。
- 对高价值写入路径尝试将物理写入与 row_count 更新放入同一事务或同一补偿策略。
- 至少增加定期或启动时 row_count 校准能力。

需要新增测试：

- 插入成功但 row_count 更新失败时是否有可诊断日志和修复路径。
- row_count reconcile 工具或健康检查测试。

#### DATA-006：删除数据集对附件删除失败选择继续，可能留下孤儿附件文件

级别：`P2`

证据状态：`已证实代码路径，待评估产品取舍`

代码证据：

- `DatasetStorageService.deleteDataset` 普通数据集删除主 `.db` 文件失败时会抛错并阻止 metadata 删除，这是正确的强一致性选择。
- 但步骤 7 `fileStorage.deleteDatasetFiles(safeDatasetId)` 失败只记录 warn，然后继续执行 `deleteMetadata`。
- 插件表删除文件失败时 catch 中记录 error，并注释“不中断流程，继续删除元数据”。

影响场景：

- 附件目录被占用、权限不足、文件系统异常。
- 插件表 `.db` 文件删除失败但 metadata 已删除。

风险：

- metadata 已消失，后续 UI 无法从数据集入口发现这些残留文件。
- 长期使用后磁盘积累孤儿附件或插件表文件。
- 用户看到“删除成功”，但实际磁盘空间没有释放。

建议修复方向：

- 附件删除失败至少写入可恢复的 cleanup backlog 或健康检查项。
- 插件表主文件删除失败是否应与普通数据集一致，阻止 metadata 删除，需要产品层明确。
- 提供“清理孤儿数据文件/附件”的诊断工具。

需要新增测试：

- 附件删除失败时应记录可恢复状态。
- 插件表文件删除失败时 metadata 是否保留或 cleanup backlog 是否生成。

#### DATA-007：导出 writer 缺少临时文件 + 原子 rename，失败时可能留下半成品导出文件

级别：`P2`

证据状态：`已证实代码路径，待复现具体格式影响`

代码证据：

- `DatasetExportWriter.exportToCSV` 直接 `COPY (...) TO outputPath`，随后可能再 `rewriteTextFileEncoding` 覆盖写同一路径。
- `exportToJSON`、`exportToTXT`、`exportToParquet` 同样直接写目标路径。
- `exportSingleExcel` 用 `ExcelJS.stream.xlsx.WorkbookWriter({ filename: outputPath })` 直接写目标路径。
- Excel 多文件拆分在循环中逐个 `exportSingleExcel`，中途失败时已完成的 part 文件不会被 `DatasetExportWriter` 清理。
- 插件 helper 的 `exportDataset(outputType !== 'file')` 有 temp cleanup，但普通 UI 导出和 outputType=file 路径没有失败清理。

影响场景：

- 目标磁盘空间不足。
- 用户导出到已存在文件或同步盘。
- Excel 多文件拆分导出到第 N 个 part 失败。
- 非 UTF-8 encoding 重写失败。

风险：

- 用户目标目录留下半成品文件。
- 自动化端点误认为目标文件可用，或者下游消费到不完整文件。
- 重试导出时覆盖行为不清晰。

建议修复方向：

- 导出到 `${outputPath}.tmp-<id>`，成功后 rename 到目标路径。
- Excel 多文件拆分记录 createdFiles，失败时按策略清理，或返回 partial files 明确状态。
- 非 UTF-8 重写先写临时文件，再替换目标文件。

需要新增测试：

- CSV/JSON/Parquet 写入失败时不留下目标文件或返回 partial 状态。
- Excel 多 part 第 N 个失败时清理前序 part，或明确返回 partial files。
- encoding rewrite 失败时目标文件状态可控。

#### DATA-008：插件 database helper 文档注释与实际行为不一致

级别：`P3`

证据状态：`已证实`

代码证据：

- `DatabaseNamespace.update` 和 `delete` 已禁用 raw where，但注释仍展示 `helpers.database.update('dataset_123', ..., "产品名称 = '测试产品'")` 和 `helpers.database.delete('dataset_123', "状态 = '已删除'")` 示例。
- `DatabaseNamespace.executeSQL` 注释展示“插入数据（使用 datasetId）”的 `INSERT INTO data ...` 示例，但实际 `datasetId` 模式会调用 `assertReadOnlySQL(sql)` 并拒绝 INSERT。

影响场景：

- 插件作者照注释写代码，运行时失败。
- Agent 读取 helper 文档后生成不可执行示例。

风险：

- 不影响数据安全，但影响功能可用性和开发体验。

建议修复方向：

- 删除或改写 raw where update/delete 示例，只保留 `updateById` / `deleteById`。
- `executeSQL(..., { datasetId })` 注释明确只读；写入请使用 `insert`、`batchInsert`、`updateById`、`deleteById`。

需要新增测试：

- 无需新增运行测试，可用文档 lint 或 snapshot 检查 public helper 注释中的禁用示例。

### 4.5 待继续核查点

- `DatasetStorageService.deleteDataset` 普通 dataset 文件删除成功但 metadata 删除失败时，是否会导致 metadata 仍存在但文件已丢失；当前代码会在文件删除后再执行 metadata 删除，需故障注入确认。
- `DatasetImportService.importDatasetFile` 新建导入成功后 metadata 写入失败的 cleanup 是否覆盖所有已创建文件和主库记录。第一轮看到 `rejectWithCleanup`，但需跑故障注入测试。
- `DatasetExportPlanBuilder` 对自定义 SQL、隐藏列、选中行、query template 的 SQL 构造是否足够安全和稳定。
- 插件 `DatabaseNamespace.executeSQL` 的 `replaceTableName` 是否能正确处理复杂 SQL 中的 `data` 表名替换。当前仅替换 `FROM|INTO|UPDATE|JOIN data`，datasetId 模式又只允许只读 SQL，因此重点是 `FROM data`、`JOIN data`、CTE、带引号 `"data"`、schema-qualified 写法。
- 查询服务 `queryDataset` 使用 `querySql.replace(/FROM\s+data/gi, ...)` 是否遗漏 JOIN、CTE、带引号表名场景。JOIN 场景需重点复核。
- 数据集导入的 500MB 限制是否有配置化、用户提示和测试覆盖。
- 临时文件命名 `temp_import_${Date.now()}` 在并发追加导入中是否可能冲突。
- query/update/export 日志中的 SQL preview 是否可能泄露用户数据，需要在横向可观测性复盘中检查。

### 4.6 当前测试覆盖观察

已看到的覆盖：

- `dataset-handler.test.ts` 覆盖 IPC route 注册、成功/失败返回、base64 import payload 校验、导出返回结构。
- `datasetStore.test.ts` 覆盖 UI store 的 query/template、stale response、乐观更新和删除当前数据集状态清理。
- `dataset-storage-service.test.ts` 覆盖队列失败继续、跨 dataset 隔离、清理、多队列排序。
- `dataset-query-service.test.ts` 覆盖只读 SQL 防护、多语句拒绝、lookup 多队列。
- `dataset-export-service.test.ts` 和 `dataset-operations.integration.test.ts` 覆盖多个导出场景，包括导出后删除物理行。
- `dataset-import-service.test.ts` 覆盖部分导入服务行为。

初步缺口：

- 追加导入现有数据集的并发队列测试不足。
- schema 物理变更成功但 metadata 失败的故障注入测试不足。
- 创建空数据集失败补偿测试不足。
- 导出后删除同步持久化 row_count 的测试不足。
- row_count 与物理表 count 的 reconcile/健康检查测试暂未看到。

## 5. 模块二：浏览器自动化工作流

状态：`待复核`

### 5.1 审计范围

第一轮已覆盖：

- 浏览器运行时抽象：`src/core/browser-runtime`
- 浏览器池核心：`src/core/browser-pool`
- 主进程运行时 provider 和 profile 集成：`src/main/profile/browser-runtime-providers.ts`、`browser-pool-integration*.ts`
- Extension relay 运行时：`src/main/profile/browser-pool-integration-extension.ts`、`src/core/browser-extension`
- Ruyi/Firefox BiDi 运行时：`src/main/profile/browser-pool-integration-ruyi.ts`、`ruyi-firefox-*`、`src/core/browser-ruyi`
- Cloak/Playwright 运行时：`src/main/profile/browser-pool-integration-cloak.ts`
- 自动化共享 facade：`src/core/browser-automation`
- 浏览器池入口：插件 profile namespace、profile IPC、HTTP/MCP browser pool adapter 的第一轮入口检索。

### 5.2 入口和核心流程

已确认的浏览器自动化入口：

- 运行时状态：`browser-runtime-ipc-handler` -> `BrowserRuntimeManager.getRuntimeStatus/listRuntimeStatuses/installRuntime`
- 池初始化：`main-service-composition.ts` -> `initBrowserPoolManager` -> `BrowserPoolManager.initialize`
- 获取浏览器：`BrowserPoolManager.acquire` -> `AcquireSessionResolver` -> `AcquireRequestFactory` -> `BrowserAcquireCoordinator`
- 复用浏览器：`PoolReuseStrategy.acquire` -> `GlobalPool.acquireIdle/acquireSpecific` -> `GlobalPool.lockBrowser`
- 创建浏览器：`BrowserCreationStrategy.create` -> `GlobalPool.createBrowser` -> runtime-specific factory
- 等待队列：`WaitQueueCoordinator.waitForBrowser` -> `WaitQueue.enqueue/dequeue/cancel`
- 释放浏览器：`BrowserHandle.release` -> `BrowserPoolManager.release` -> `transferBrowserToWaiter` 或 `GlobalPool.releaseBrowser`
- 锁续期：`BrowserHandle.renew` -> `BrowserPoolManager.renewLock` -> `GlobalPool.renewLock`
- 强制/批量清理：`forceRelease`、`releaseByPlugin`、`destroyProfileBrowsers`、`GlobalPool.runHealthCheck`
- 插件调用：`ProfileNamespace.launch/withLease/reuseActive/releaseByPlugin` -> `getBrowserPoolManager`
- HTTP/MCP 调用：`http-browser-pool-adapter` -> profile resource lease -> `poolManager.acquire/takeoverLockedBrowser`
- UI/IPC 调用：`profile:pool-launch/release/show-browser/stats/destroy-profile-browsers/renew-lock`

### 5.3 已验证的正向设计

#### BROWSER-OK-001：运行时抽象已经从 engine 字符串收敛为 provider/descriptor/source 模型

状态：`已证实`

证据：

- `BrowserRuntimeRegistry` 拒绝重复 provider，并在未知 runtime id 时抛明确错误。
- `BrowserRuntimeManager` 统一处理 source override、resolve、probe、install status 和 store snapshot。
- `resolveAndProbe` 对 provider 抛错、显式路径缺失和探测失败返回 unhealthy status，而不是直接让 UI/调用方崩溃。
- `browser-runtime-providers.ts` 将 `electron-webcontents`、`chromium-extension-relay`、`firefox-bidi`、`chromium-cloak-playwright` 统一包装为 `BrowserRuntimeProvider`。

影响：

- 运行时可用性、安装状态和能力描述有统一出口，后续新增 runtime 不需要绕开池化架构。

#### BROWSER-OK-002：GlobalPool 对创建中、创建超时和销毁中资源有明确状态机

状态：`已证实`

证据：

- `GlobalPool.createBrowser` 先创建 `creating` 占位，再执行 factory，避免并发创建同 profile 多实例。
- 创建过程使用 `creationSemaphore` 限流，并用 `BROWSER_FACTORY_TIMEOUT_MS` 防止 factory 永久挂起。
- factory 超时后，如果后台 promise 后续成功，会调用 `destroyCreatedBrowser(..., 'factory-timeout')` 回收资源。
- `destroyBrowser` 对 creating 占位保存 `pendingFactoryPromise`，等创建完成后再回收，避免孤儿进程或 view。
- `sessionDestroying` 防止同 profile 销毁未完成时被并发重建。

影响：

- 浏览器进程、WebContentsView、临时 controller 在创建失败/停止/销毁竞态下有基础保护。

#### BROWSER-OK-003：等待队列支持超时、优先级、防饥饿和 AbortSignal

状态：`已证实`

证据：

- `WaitQueue.enqueue` 为每个请求设置超时，避免 Promise 永久悬挂。
- 队列按 session + runtime 分组，优先级排序，并通过 `applyAntiStarvation` 提升长时间等待请求。
- `WaitQueueCoordinator.waitForBrowser` 在入队前检查 `signal.aborted`，入队后注册 abort listener 并调用 `cancelRequest`。
- `wait-queue.test.ts` 覆盖优先级、防饥饿、超时、取消、按 session/plugin 清理和统计。

影响：

- 常规资源不足场景不会无限卡住，调用方可以主动取消等待。

#### BROWSER-OK-004：BrowserHandle 绑定 requestId，能防 stale handle 误释放/误续期

状态：`已证实`

证据：

- `buildBrowserHandle` 生成的 `release` 和 `renew` 都把当前 `request.requestId` 作为 `expectedRequestId` 传入。
- `BrowserPoolManager.release` 在 `expectedRequestId` 不匹配时直接忽略，并返回当前统计。
- `BrowserPoolManager.renewLock` 同样检查当前锁持有者。
- `pool-manager.test.ts` 覆盖 stale handle release 不应释放他人锁。

影响：

- 锁超时、交接或复用后，旧 handle 再执行 release/renew 不会破坏新持有者。

#### BROWSER-OK-005：插件/Profile live session lease 和 HTTP adapter 已有资源协调层

状态：`已证实`

证据：

- `profile-live-session-lease.ts` 为 profile live browser session 提供 lease 包装。
- `ProfileNamespace.withLease` 测试覆盖 callback 结束释放、callback 抛错释放、abort signal 透传。
- `http-browser-pool-adapter.ts` 通过 `resourceCoordinator` 串行同 profile acquire，并在 MCP takeover 场景尝试 `takeoverLockedBrowser`。
- `http-browser-pool-adapter.test.ts` 覆盖同 profile acquire 串行、不同 profile 并行、lease contention diagnostics、MCP takeover plugin-held browser。

影响：

- 上层自动化入口不是直接裸用池，而是有一层 profile 资源协调，降低多入口抢同一 profile 的概率。

#### BROWSER-OK-006：Extension relay 启动失败有较好的诊断和清理

状态：`已证实`

证据：

- `createExtensionBrowserFactory` 启动前校验 Chrome runtime 和 fingerprint preflight。
- 启动失败会构造包含 session、退出码、ruyi source/file 和 stderr preview 的错误信息。
- 创建过程中失败会执行 `cleanup`，杀 Chrome 进程、停止 relay、删除 control extension runtimeDir。
- Chrome 进程退出时也会停止 relay 并删除 runtimeDir。

影响：

- Extension runtime 的启动失败可诊断性较好，且不易留下 control extension 临时目录。

#### BROWSER-OK-007：Ruyi/Firefox 关闭序列和下载 tracker 设计较完整

状态：`已证实`

证据：

- `RuyiFirefoxClient.launch` 在 start 失败时调用 `client.close()`。
- `close` 会拒绝 dialog waiters、清 window open policy、清 active context tracker、禁用 request interception、结束 BiDi session、关闭 browser，并等待进程退出，必要时 kill。
- `RuyiBiDiConnection` 在 disconnect 时清空 pending command 并 reject。
- `BrowserDownloadTracker` 结合文件系统扫描和生命周期事件，处理 `.part`、文件大小稳定、deny policy、cancel、目标路径迁移和唯一目标名。

影响：

- Firefox runtime 对长期自动化任务中的关闭、下载和连接断开有较明确的恢复/失败语义。

#### BROWSER-OK-008：跨 runtime 基础契约已有测试

状态：`已证实`

证据：

- `browser-runtime.cross-runtime-contract.test.ts` 对 `BrowserSnapshotService`、`ExtensionBrowser`、`RuyiBrowser` 的 snapshot/search 契约做对齐测试。
- `browser-capability-truth.test.ts` 覆盖 runtime capability truth。
- `transport-backed-browser-base.test.ts` 覆盖 intercepted request wait 的游标、并发等待和已 abort signal。

影响：

- 基础观察能力不是每个 runtime 完全各写各的，已有共享契约约束。

### 5.4 已发现问题

#### BROWSER-001：BrowserPoolManager.acquire 未检查 initialized，未初始化调用会伪装成 acquire timeout

级别：`P1`

证据状态：`已证实代码路径，待补测试复现`

代码证据：

- `BrowserPoolManager` 有 `initialized` 字段，`initialize` 成功后才设置为 `true`，但 `acquire()` 只检查 `stopped`，没有检查 `initialized`。
- `PoolNotInitializedError` 已定义且被导入，但在 `BrowserPoolManager.acquire` 中未使用。
- 未初始化时 `GlobalPool.browserFactory` 未设置，`GlobalPool.createBrowser` 会抛 `FactoryNotSetError`。
- `BrowserCreationStrategy.create` 会捕获非 non-retryable create error 并返回 `undefined`，随后 `BrowserAcquireCoordinator.acquire` 进入等待队列，最终表现为 `Acquire timeout`。
- `pool-manager.test.ts` 未看到“未 initialize 直接 acquire 应快速失败”的测试。

影响场景：

- 启动顺序异常时，MCP/HTTP、插件或 IPC 入口提前调用浏览器池。
- 测试或未来模块直接 `new BrowserPoolManager()` 后忘记 `initialize`。

风险：

- 配置/启动错误被误报为资源忙或等待超时。
- Agent/MCP 自动化调用方会重试错误方向，诊断成本高。
- 等待队列可能短时间积累无意义请求。

建议修复方向：

- `BrowserPoolManager.acquire/adoptSamePluginLockedBrowser/takeoverLockedBrowser/forceRelease/releaseByPlugin` 等需要 runtime 的入口统一检查 initialized。
- 未初始化时抛 `PoolNotInitializedError`，不要进入等待队列。
- 增加测试：未 initialize 的 manager 调用 acquire 应立即拒绝，waitQueue 保持 0。

#### BROWSER-002：GlobalPool lock timeout 自动释放不会驱动 BrowserPoolManager 等待队列，等待者可能继续卡到超时

级别：`P1`

证据状态：`已证实代码路径，待复现场景`

代码证据：

- `GlobalPool.runHealthCheck` 调用 `checkLockTimeout`。
- `checkLockTimeout` 找到超时锁后直接调用 `this.releaseBrowser(browserId, { navigateTo: 'about:blank' })`。
- 该路径只把底层 browser 从 locked 释放成 idle，没有经过 `BrowserPoolManager.release`。
- 因此不会调用 `BrowserAcquireCoordinator.processWaitQueue(sessionId)`，也不会发射 `browser:released` 事件。
- `global-pool.test.ts` 只验证 `checkLockTimeout` 后 browser 状态变为 idle；未验证 BrowserPoolManager 场景下等待队列是否被唤醒。

影响场景：

- profile 已被长任务锁住，另一个请求进入等待队列。
- 长任务没有续期，GlobalPool 健康检查释放锁。
- 底层 browser 已 idle，但等待队列没有被 process。

风险：

- 等待中的 acquire 可能继续等待直到自身 timeout。
- 池统计显示有 idle browser，但调用方仍收到 acquire timeout，表现为间歇性资源调度失败。
- 事件订阅者和 profile 状态也拿不到一次“因 lock timeout 被释放”的生命周期信号。

建议修复方向：

- 将 lock timeout 释放上移到 BrowserPoolManager，或让 GlobalPool 暴露回调通知 released session/browser。
- lock timeout 释放后按 session 调用 `processWaitQueue`。
- 增加集成测试：一个 handle 锁超时、第二个 acquire 正在等待，健康检查后第二个 acquire 应获得同一 browser。

#### BROWSER-003：releaseByPlugin 释放插件持有锁后不处理其他等待者

级别：`P1`

证据状态：`已证实代码路径，待复现场景`

代码证据：

- `BrowserPoolManager.releaseByPlugin(pluginId)` 调用 `globalPool.releaseByPlugin(pluginId)`，再 `waitQueue.cancelByPlugin(pluginId, 'Plugin stopped')`。
- `GlobalPool.releaseByPlugin` 直接对插件持有的 locked browser 调用 `releaseBrowser`，释放为 idle。
- `BrowserPoolManager.releaseByPlugin` 没有收集被释放 browser 的 session，也没有对这些 session 调用 `processWaitQueue`。
- `pool-manager.test.ts` 只验证插件持有的 browser 变 idle、同插件等待请求被取消，未覆盖“其他插件/入口正在等待同一 profile”的场景。

影响场景：

- 插件 A 持有 profile 浏览器。
- 插件 B、MCP 或 UI 正在等待同一 profile。
- 插件 A 停止触发 releaseByPlugin。

风险：

- 浏览器已经 idle，但等待者仍卡在 waitQueue。
- 插件停止后的资源释放无法及时唤醒其他自动化任务。

建议修复方向：

- `GlobalPool.releaseByPlugin` 返回 released browser 的 sessionIds，或在 manager 层先枚举将要释放的 browser。
- 释放后对每个受影响 session 调用 `processWaitQueue`。
- 增加测试：插件 A releaseByPlugin 后，插件 B 的 pending acquire 应成功接管。

#### BROWSER-004：resetBrowserState 失败被忽略，可能把未清理状态的浏览器交给下一个等待者

级别：`P2`

证据状态：`已证实代码路径，待评估产品取舍`

代码证据：

- `resetBrowserState` 捕获 reset/goto 失败后只记录 warn 并返回 `false`。
- `GlobalPool.releaseBrowser` 调用 `await resetBrowserState(...)`，但不读取返回值，随后仍把 browser 标记为 idle。
- `WaitQueueCoordinator.transferBrowserToWaiter` 释放交接前调用 `resetBrowserState(...)`，同样不读取返回值，然后继续 `handoffLock`。
- `pool-manager.test.ts` 覆盖“reset 未完成前不交接”，但未覆盖 reset 抛错时是否应 destroy、重试或拒绝等待者。

影响场景：

- `release({ clearStorage: true, navigateTo: 'about:blank' })` 期间浏览器无响应。
- 跨插件、MCP、UI 复用同 profile browser 时，上一轮页面状态/下载/拦截/存储清理失败。

风险：

- 下一个任务拿到未清理的页面状态，出现偶发操作失败。
- 如果调用方以为 clearStorage 已成功，后续行为会和预期不一致。

建议修复方向：

- 明确 reset 失败策略：保守做法是 destroy browser 并为等待者创建新实例；宽松做法是返回 resetFailed 状态给调用方。
- 对 `clearStorage: true` 的失败应比普通 navigate failure 更严格。
- 增加测试：reset 抛错时不应静默交接给等待者，或至少返回可诊断状态。

#### BROWSER-005：Cloak waitForInterceptedRequest 的 AbortSignal 处理不完整

级别：`P2`

证据状态：`已证实代码路径，待补测试`

代码证据：

- `CloakPlaywrightBrowser.waitForInterceptedRequest` 对 `options.signal` 只添加 abort listener，没有先检查 `signal.aborted`。
- 如果传入已 abort 的 signal，listener 不会自动触发，请求会等到 timeout。
- 正常 resolve 或 timeout 时没有 `removeEventListener('abort', onAbort)`，长期多次等待可能残留 listener。
- 共享的 `TransportBackedBrowserBase.waitForInterceptedRequestEntry` 已有已 abort signal 测试，但 Cloak 使用自有实现，未复用这条测试。

影响场景：

- Agent/MCP 取消一次等待中的拦截请求。
- 插件或自动化任务大量 waitForInterceptedRequest。

风险：

- 已取消任务仍等待到 timeout。
- 重复等待积累 abort listener，增加长期任务内存和状态噪声。

建议修复方向：

- 入参开始处检查 `options?.signal?.aborted`。
- waiter cleanup 中统一 clear timer、删除 waiter、remove abort listener。
- 为 Cloak 单独增加 pre-aborted、abort during wait、resolve 后 listener cleanup 测试。

#### BROWSER-006：Cloak 下载 finalize 失败时可能让下载长期停留在 in_progress

级别：`P2`

证据状态：`已证实代码路径，待复现具体错误`

代码证据：

- `attachPageListeners` 中 `page.on('download')` 后执行 `void this.finalizeDownload(id, download)`，没有 catch。
- `finalizeDownload` 在 `download.saveAs(targetPath)`、`download.path()`、`download.failure()` 之间没有总 catch。
- 如果 `saveAs` 或 mkdir 失败，entry 保持 `in_progress`，`waitForDownload` 只能等到 timeout，而不是返回 interrupted/error 状态。
- `browser-pool-integration-cloak.test.ts` 覆盖 saveAs 成功保存，但未覆盖 saveAs 失败或路径不可写。

影响场景：

- 下载目标目录不可写、磁盘不足、文件名冲突、Playwright download.saveAs 抛错。

风险：

- 调用方收到等待超时而不是下载失败原因。
- `listDownloads` 中残留 in_progress 项，后续诊断困难。

建议修复方向：

- `finalizeDownload` 外层捕获错误，将 entry 标记为 `interrupted`，记录 error message，并发出 runtime event。
- `page.on('download')` 的 `void` promise 至少 `.catch(logger.warn)`。
- 增加下载保存失败测试。

#### BROWSER-007：跨 runtime 测试尚未覆盖状态型能力契约

级别：`P2`

证据状态：`已证实测试缺口`

代码证据：

- 现有 `browser-runtime.cross-runtime-contract.test.ts` 主要覆盖 snapshot/search。
- `browser-capability-truth.test.ts` 覆盖 capability truth，但不是完整行为契约。
- download、dialog、request interception、tabs、window open policy、emulation、runtime events 在 Extension/Ruyi/Cloak 中实现差异较大。
- Cloak 下载和拦截已经出现与共享 base/Ruyi tracker 不同的行为边界。

影响场景：

- 同一插件或 MCP workflow 切换 runtime 后行为不一致。
- 能力声明为 supported，但边缘取消、失败、关闭时的语义不同。

风险：

- 稳定性问题只在特定 runtime 中出现，常规测试难发现。

建议修复方向：

- 建立跨 runtime contract test matrix：download wait/cancel/failure、dialog wait abort/handle、intercept wait/continue/fulfill/fail/disable cleanup、tabs create/activate/close、window policy set/clear。
- 对不支持能力的 runtime 明确断言 capability false 和错误信息。

### 5.5 待继续核查点

- `profile-ipc-handler.ts` 的 `profile:pool-launch/release/show-browser/renew-lock` 是否全部绑定 requestId 或 lease，避免 renderer 侧用 browserId 释放他人锁。
- `http-browser-pool-adapter.ts` 的 profile resource lease 与 pool lock 的释放顺序，在 acquire 成功但后续 handler 抛错时是否必定释放。
- `ProfileNamespace.launch/reuseActive/withLease` 在 `goto`、`show`、callback 抛错、abort signal、插件卸载时是否都释放 handle 和 profile lease。
- `forceRelease` 没有发射 `browser:released` 事件，也不更新 profile idle；需要确认它是否只用于内部异常恢复，还是暴露给 UI/外部入口。
- profile status 当前语义是“有 live browser instance 即 active”，release 到 idle 池后仍 active；需要确认 UI 是否把 active 理解为“正在被锁定使用”。
- `CloakPlaywrightBrowser.waitForResponse` 和 network capture 会读取 response body；大响应体、二进制响应和敏感内容记录策略需要在横向可观测性主题复盘。
- Extension/Ruyi/Cloak 的 `show/hide`、popup、window policy 和 view manager 状态需要在桌面调试/运行健康模块中继续联查。

### 5.6 当前测试覆盖观察

已看到的覆盖：

- `pool-manager.test.ts` 覆盖 acquire/release、等待队列交接、destroy release、新建 browser、stale handle release、stop 清等待队列、forceRelease、releaseByPlugin、统计和部分 profile 状态同步。
- `global-pool.test.ts` 覆盖创建/销毁、idle eviction、lock timeout、releaseByPlugin、health check。
- `wait-queue.test.ts` 覆盖队列排序、优先级、防饥饿、超时、取消和统计。
- `profile-live-session-lease.test.ts` 覆盖 lease 包装释放和 takeover。
- `http-browser-pool-adapter.test.ts` 覆盖同 profile 串行、不同 profile 并行、失败计数、lease contention、MCP takeover。
- `browser-pool-integration-extension/ruyi/cloak` 系列测试覆盖 runtime smoke、real contract、fingerprint、dialog、download、interception 的部分场景。
- `browser-download-tracker.test.ts` 覆盖 Ruyi/shared tracker 的文件系统下载状态。

初步缺口：

- 未初始化 manager 直接 acquire 的快速失败测试不足。
- BrowserPoolManager 层面的 lock timeout 唤醒等待者测试不足。
- releaseByPlugin 释放后唤醒其他等待者测试不足。
- resetBrowserState 失败后的销毁/交接策略测试不足。
- Cloak abort/failure 边界测试不足。
- 跨 runtime 状态型能力契约测试不足。

## 6. 模块三：插件系统

状态：`待复核`

### 6.1 审计范围

第一轮已覆盖：

- 插件类型和 manifest 合约：`src/types/js-plugin.d.ts`
- 插件入口管理器：`src/core/js-plugin/manager.ts`
- 插件加载和 manifest/zip 校验：`src/core/js-plugin/loader.ts`
- 插件导入器：`src/core/js-plugin/plugin-loader.ts`
- 安装/更新协调器：`src/core/js-plugin/plugin-installation-coordinator.ts`
- 插件数据表安装器：`src/core/js-plugin/plugin-installer.ts`
- 生命周期管理器：`src/core/js-plugin/plugin-lifecycle.ts`
- 插件 context/helper：`src/core/js-plugin/context.ts`、`src/core/js-plugin/helpers.ts`
- 执行协调器：`src/core/js-plugin/plugin-execution-coordinator.ts`
- UI 扩展管理器：`src/core/js-plugin/ui-extension-manager.ts`
- 热重载文件监听：`src/core/js-plugin/file-watcher.ts`
- 字节码运行器：`src/core/js-plugin/bytecode-runner.ts`
- 插件 IPC routes：`src/main/ipc-handlers/js-plugin-routes`
- 相关测试：`manager.test.ts`、`plugin-loader.test.ts`、`plugin-installer.test.ts`、`plugin-lifecycle.test.ts`、`registry.test.ts`、`runtime-registry.test.ts`、helper/namespace contract tests。

本轮暂不评价插件权限和信任边界；只看稳定性、完整性、一致性、失败路径和可观测性。

### 6.2 入口和核心流程

已确认的插件系统入口：

- 导入本地插件：`JSPluginManager.import` -> `PluginInstallationCoordinator.importPlugin` -> `PluginLoader.import`
- 安装/更新云插件：`installOrUpdateCloudPlugin` -> `replaceInstalledCloudPlugin` 或首次安装流程
- 开发模式本地插件：`installLocalPluginAtPath`，可 symlink/junction 或 staged copy
- 加载插件：`JSPluginManager.loadWithDependencies` -> `readManifest` -> `loadPluginModule` -> `PluginLifecycleManager.activate`
- 激活插件：创建 logger/helpers/context，注册到 `PluginRegistry`，执行 `commands`/`activate`，注册 UI，启动热重载
- 执行命令：IPC/UI/custom page -> `PluginExecutionCoordinator.executeCommand` -> context command handler
- 自定义页面：`renderCustomPage` 注入通信脚本，`handlePageMessage` 通过 pageId/pluginId 路由回插件 context/helpers
- 插件数据表：manifest `dataTables` -> `PluginInstaller.createTables/createSingleTable`
- 停用/卸载：`deactivate` -> context/helpers/UI/view/watch cleanup；`uninstall` -> delete/orphan tables -> remove plugin files/metadata/runtime registry
- 热重载：`enableHotReload`/`setupHotReloadIfEnabled` -> `PluginFileWatcherManager.startWatching` -> `reload`

### 6.3 已验证的正向设计

#### PLUGIN-OK-001：manifest、main 入口和 zip 解包有基本完整性校验

状态：`已证实`

证据：

- `validateManifest` 要求 `id/name/version/author/main`，校验 id 和 semver，并对浏览器扩展 manifest 给出友好错误。
- `loadPluginModule` 拒绝绝对 `main` 路径和包含 `..` 的入口，解析后再次确认仍在插件目录内。
- `unpackPlugin` 使用 `assertSafeZipMetadata`、`assertSafeZipEntryPath`、临时目录和 nested root 识别，避免解包路径污染安装目录。
- `unloadModule` 会按 realpath 清理插件目录下的 require cache。

影响：

- 插件加载入口不是裸 `require`，基本路径安全和包完整性有基础。

#### PLUGIN-OK-002：已安装插件的替换更新具备备份和恢复路径

状态：`已证实`

证据：

- `replaceInstalledCloudPlugin` 和 `replaceInstalledLocalPlugin` 都使用 `installPath.__backup__.<Date.now()>` 备份旧插件目录。
- 替换流程会停用旧插件、卸载 module cache、移动新目录、更新 metadata、重建 folder/tables/UI、重新加载。
- catch 中会删除新 installPath、恢复 backupPath、尽量恢复 metadata，并尝试 reload 恢复旧插件。

影响：

- 相比首次安装，更新路径对失败恢复考虑更完整。

#### PLUGIN-OK-003：停用清理链路覆盖面较广，且多数清理失败不阻断后续清理

状态：`已证实`

证据：

- `PluginLifecycleManager.deactivate` 会注销全局 registry、调用 `onStop` 和 `deactivate`、dispose context、dispose helpers、停止 file watcher、清理 plugin views、注销 UI contributions。
- `PluginHelpers.dispose` 会清理 disposers、taskQueue、scheduler、webhook、browser pool、ffi、onnx、imageSearch、ocr、cv、vectorIndex 等资源。
- 多数 cleanup 块独立 try/catch，避免一个清理失败导致后续资源全部跳过。

影响：

- 正常停用和卸载路径的资源释放意识比较强。

#### PLUGIN-OK-004：helper surface 有 contract/docs/lazy/behavior 测试

状态：`已证实`

证据：

- 已存在 `helpers.contract.test.ts`、`helpers.docs.contract.test.ts`、`helpers.lazy.test.ts`、`helpers.behavior.contract.test.ts`。
- namespace 层也有 `database`、`storage`、`scheduler`、`task-queue`、`profile.with-lease`、`network`、`ui` 等测试。

影响：

- 插件 helper 作为对外稳定 API，有一批合约测试，不是完全依赖人工约定。

#### PLUGIN-OK-005：运行态 registry 能记录生命周期和 task queue 状态

状态：`已证实`

证据：

- `PluginRuntimeRegistry` 支持 lifecycle phase、error、queue listener、work state 派生。
- `TaskQueueNamespace` 创建 queue 时注册 runtime queue，`release/stopAll` 会 stop 并 unregister。
- `runtime-registry.test.ts` 覆盖状态派生和 listener 清理。

影响：

- 插件运行态具备基础可观测状态，便于后续健康检查和诊断扩展。

#### PLUGIN-OK-006：插件数据表存在孤儿表识别和 schema compatibility 检查

状态：`已证实`

证据：

- `PluginInstaller.createSingleTable` 使用固定 datasetId `plugin__${pluginId}__${code}`。
- 遇到已有记录时会区分同插件已有表、其他数据集冲突、孤儿表恢复。
- 恢复孤儿表前会读取实际 schema 并和 manifest table schema 做 compatibility 检查。

影响：

- 插件表重复安装和部分孤儿恢复不是简单覆盖，已经有一定保护。

### 6.4 已发现问题

#### PLUGIN-001：仅导出 commands 对象的插件会被标记 active 但不注册命令

级别：`P1`

证据状态：`已证实代码路径，待补回归测试`

代码证据：

- `src/types/js-plugin.d.ts` 明确说明插件可以提供 `activate()`、`commands` 对象，或两者都提供。
- `src/core/js-plugin/loader.ts` 的 `loadPluginModule` 允许 `activate` 或 `commands` 任一存在。
- `PluginLifecycleManager.invokePluginActivateHook` 本身也会先注册 `plugin.module.commands`，再调用 `activate`。
- 但 `PluginLifecycleManager.activate` 的早退条件是 `!plugin.module.activate && !plugin.manifest.contributes`，没有检查 `plugin.module.commands`。
- 因此一个只有 `commands` 且没有 `contributes` 的插件会直接进入早退分支，只设置 runtime active，不创建 context/helpers，也不注册命令。

影响场景：

- 插件作者按类型定义导出 command-only 插件，用于被其他插件、CLI、HTTP/MCP 或内部编排调用。
- 插件没有 toolbar/custom page/activity bar contributions，只提供纯命令能力。

风险：

- 插件显示为 active，但 `executeCommand` 报 `Plugin is not activated` 或 `Command not found`。
- 插件状态与实际可调用能力不一致，排查时容易误判为调用方问题。

建议修复方向：

- 早退条件改为同时没有 `activate`、没有 `commands`、没有 `contributes` 时才跳过。
- 增加 lifecycle/manager 测试：command-only 插件激活后 context 存在，命令可执行，runtime active。
- 补一个负向测试：真正空插件可 active/inactive 的期望语义需要明确。

#### PLUGIN-002：首次安装失败缺少跨文件、metadata、folder、table、UI 的补偿

级别：`P1`

证据状态：`已证实代码路径，待故障注入复现残留`

代码证据：

- 首次安装走 `PluginInstallationCoordinator.importPlugin` -> `PluginLoader.import`。
- `PluginLoader.import` 会按顺序复制/解包到安装目录、`savePluginMetadata`、`callbacks.createFolderAndTables`、`callbacks.unregisterUIContributions`、`callbacks.saveUIContributions`、`callbacks.loadPlugin`。
- catch 只返回 `{ success: false, error }`，未看到对已复制插件目录、`js_plugins` metadata、已创建 folder/table、已保存 UI contribution 的统一回滚。
- `plugin-loader.test.ts` 覆盖数据库保存失败、创建文件夹失败、加载失败会返回失败，但没有断言残留被清理。
- 对比 `replaceInstalledCloudPlugin`/`replaceInstalledLocalPlugin`，更新路径有 backup/restore，首次安装路径没有等价补偿。

影响场景：

- 首次导入插件时，metadata 保存成功后 folder/table 创建失败。
- table 或 UI contribution 创建成功后 module load/activate 失败。
- 插件文件复制成功但数据库写入失败。

风险：

- 插件安装失败但磁盘目录、`js_plugins`、folder、dataset、UI contribution 部分残留。
- 下一次安装同 id 插件可能被误判已存在，或出现重复/孤儿数据。

建议修复方向：

- 为首次安装引入 install transaction/compensation plan：每一步登记 undo action，失败时逆序执行。
- 至少清理 installPath、`js_plugins`、`js_plugin_*` UI records、插件 folder、插件 dataTables。
- 增加 failure injection tests，分别在 metadata、folder/table、UI、loadPlugin 阶段抛错并断言无残留。

#### PLUGIN-003：激活失败时 context/helpers 被直接从 Map 删除，未执行 dispose

级别：`P1`

证据状态：`已证实代码路径，待故障注入复现资源泄漏`

代码证据：

- `PluginLifecycleManager.activate` 在 try 中先 `setupPluginHelpers`、`loadPluginDataTables`、`createPluginContext`、`registry.registerPlugin`，再调用 `invokePluginActivateHook`。
- catch 中只 `registry.unregisterPlugin`，然后 `contexts.delete`、`helpers.delete`、`loggers.delete`、`plugins.delete`。
- catch 中没有调用 `context.dispose()` 或 `helpers.dispose()`。
- 如果 `activate(context)` 内创建 scheduler、task queue、webhook、browser handle、storage listener、bytecode temp file 等资源后再抛错，正常 `deactivate` 的清理链路不会被触发。

影响场景：

- 插件激活过程执行了一部分 helper 调用后抛错。
- 热重载时新代码 activate 部分成功后失败。

风险：

- 定时任务、队列、浏览器锁、webhook、文件/字节码临时资源可能泄漏。
- lifecycle 删除插件实例后，运行态资源缺少 owner，可观测状态也可能断链。

建议修复方向：

- activate catch 中按 deactivate 的资源清理顺序执行最小 cleanup：registry unregister -> context.dispose -> helpers.dispose -> watcher/view/UI cleanup。
- 即使 cleanup 失败也继续清理 Map，并记录 error artifact。
- 增加测试：activate 创建 scheduler/taskQueue/browser mock 后抛错，断言对应 dispose/release 被调用。

#### PLUGIN-004：插件数据表创建跨物理文件和主库 metadata 缺少事务/补偿

级别：`P1`

证据状态：`已证实代码路径，待故障注入复现残留`

代码证据：

- `PluginInstaller.createTables` 逐个调用 `createSingleTable`，最后执行 `CHECKPOINT`。
- `createSingleTable` 会创建/attach 插件 dataset 物理 DB、建表/sequence/default rows，再保存 `datasets` metadata。
- 如果某个 table 已创建成功，后续 table 创建失败，`createTables` 没有回滚之前已创建的插件表。
- 如果物理 DB 建表成功但 metadata 保存失败，当前代码未看到删除物理 DB 文件的补偿。

影响场景：

- 插件声明多个 dataTables，其中第 N 个表创建失败。
- 主库 metadata 写入失败、磁盘写入失败、schema 解析失败或应用崩溃。

风险：

- 插件安装失败后留下部分可见/不可见插件表。
- 物理 DB 文件与 `datasets` metadata 分裂，后续删除、恢复、孤儿检测需要额外处理。

建议修复方向：

- `createTables` 应维护已创建 datasetId 列表，失败时逆序删除。
- `createSingleTable` 在 metadata 保存失败时清理刚创建的物理 DB。
- 增加多表创建中途失败、metadata 保存失败、cleanup 失败的测试。

#### PLUGIN-005：卸载时 delete/orphan 插件表失败会被吞掉，卸载仍可能继续删除插件本体

级别：`P2`

证据状态：`已证实代码路径，待复现最终状态`

代码证据：

- `PluginInstaller.deletePluginTables` 对每个插件表调用 `duckdb.deleteDataset(table.id)`，单表失败只记录 error 并继续。
- 之后删除插件 folder 失败也只记录 error。
- `PluginInstaller.orphanPluginTables` 更新 metadata 失败同样 catch 后只记录 error。
- `JSPluginManager.uninstall` 调用 `deletePluginTables` 或 `orphanPluginTables` 后继续删除 plugin path、custom pages 和 `js_plugins` metadata。

影响场景：

- 卸载插件时某个插件表文件被锁定、损坏或删除失败。
- 用户选择保留数据表，但 `created_by_plugin` 解绑失败。

风险：

- 插件 metadata 已删除，但表仍指向不存在的 `created_by_plugin`。
- 用户以为卸载并删除数据完成，实际磁盘或 metadata 仍有残留。
- 之后重装同 id 插件可能触发冲突或错误恢复路径。

建议修复方向：

- `deletePluginTables/orphanPluginTables` 返回结构化结果：成功、失败表列表、folder cleanup 状态。
- `uninstall` 根据失败结果决定是否中止、提示“部分卸载”、或进入可修复状态。
- 增加卸载故障注入测试：单表删除失败、orphan update 失败、folder 删除失败。

#### PLUGIN-006：热重载 watcher 状态和数据库 hot_reload_enabled 更新不是原子操作

级别：`P2`

证据状态：`已证实代码路径，待补测试`

代码证据：

- `enableHotReload` 先 `fileWatcherManager.startWatching`，再更新 `js_plugins.hot_reload_enabled = true`。
- 如果 watcher 已启动但数据库更新失败，方法返回失败，但 watcher 仍在运行。
- `disableHotReload` 先 `stopWatching`，再更新 `hot_reload_enabled = false`。
- 如果 stop 成功但数据库更新失败，方法返回失败，但数据库仍表示热重载开启，实际 watcher 已停止。
- `plugin-lifecycle.test.ts` 只覆盖成功/基本失败分支，没有覆盖 DB 更新失败后的 watcher/DB 状态偏差。

影响场景：

- 开发模式插件启用/禁用热重载时主库写入失败。
- 应用重启后根据 DB 状态恢复 watcher。

风险：

- UI 和实际 watcher 状态不一致。
- 用户以为没有启用热重载，但文件变化仍触发 reload。
- 用户以为热重载启用，但 watcher 实际已停止。

建议修复方向：

- enable 失败时如果 DB 更新失败，应 stop watcher 补偿。
- disable 失败时如果 DB 更新失败，应恢复 watcher 或返回明确的部分失败状态。
- 增加 DB update failure 测试，断言 watcher 状态被补偿或状态报告准确。

#### PLUGIN-007：插件页面注入脚本使用未定义的 logger，可能导致自定义页面 API 初始化失败

级别：`P2`

证据状态：`已证实代码路径，待浏览器复现`

代码证据：

- `UIExtensionManager.injectCommunicationScript` 注入到 HTML 的浏览器脚本中多处调用 `logger.info(...)`。
- 该 `logger` 是主进程 TypeScript 模块内变量，不会自动存在于自定义页面的 `window` 作用域。
- `DOMContentLoaded` 回调中第一句就是 `logger.info('🚀 [Plugin Page] Initializing plugin API...')`，如果页面没有定义 `logger`，会抛 `ReferenceError` 并进入 catch。
- catch 又会插入“插件 API 初始化失败”提示，页面 API wrapper 不会完成。

影响场景：

- 本地 custom page 通过 `renderCustomPage` 注入通信脚本后打开。
- 页面本身没有全局 `logger`。

风险：

- 插件自定义页面无法初始化 `window.pluginAPI`。
- 用户看到 API 初始化失败，但插件本体和通信链路其实可能正常。

建议修复方向：

- 注入脚本中改用 `console.info` 或定义局部 logger shim。
- 增加 custom page render/browser test，验证注入脚本在空 HTML 中不抛 ReferenceError，并能发送 ready message。

#### PLUGIN-008：PluginContext.dispose 的字节码临时文件清理是 fire-and-forget

级别：`P3`

证据状态：`已证实代码路径，待评估实际影响`

代码证据：

- `PluginContext.dispose` 清理 commands、APIs、loader 后调用 `this.bytecodeRunner.cleanupAll().catch(...)`，但没有 await。
- `BytecodeRunner.cleanupAll` 会 `emptyDir(os.tmpdir()/airpa-bytecode)`。
- `PluginLifecycleManager.deactivate` 调用 `context.dispose()` 是同步调用，无法等待 bytecode cleanup 完成。

影响场景：

- 插件运行临时字节码后立即停用、卸载或应用退出。

风险：

- 临时文件清理失败或尚未完成时，卸载流程已经报告完成。
- 如果后续流程依赖 temp dir 已清空，会出现偶发残留。

建议修复方向：

- 将 `PluginContext.dispose` 改为 async，生命周期中 await。
- 或将 bytecode cleanup 纳入 helpers/context 的异步 disposer 模型。
- 增加 dispose 等待 cleanup 的测试。

#### PLUGIN-009：直接命令执行和停用/重载之间缺少运行中命令协调

级别：`P2`

证据状态：`已证实缺少显式协调，待构造并发测试`

代码证据：

- `PluginExecutionCoordinator.executeCommand` 获取 context/helper 后直接 `await handler(params, helpers)`。
- `PluginLifecycleManager.deactivate` 没有读取 execution coordinator 的运行中命令计数，也没有等待/取消正在执行的 command。
- `canDeactivate` 是插件自定义 hook，默认情况下不能自动感知 direct command 正在执行。
- `registerCommandExecutionGuard` 可添加前置 guard，但当前未看到内置的 running-command lock。

影响场景：

- 用户或热重载在插件命令执行期间停用/重载插件。
- 命令 handler 正在使用 helper 数据库、browser、task queue、storage 或 UI API。

风险：

- 停用流程 dispose helpers/context 后，运行中的 command 继续执行并访问已释放资源。
- 热重载可能让旧命令和新插件实例并行，状态污染或错误不可诊断。

建议修复方向：

- execution coordinator 维护 per-plugin in-flight command 计数和 AbortSignal。
- deactivate 默认等待短时间或拒绝停用；force 停用时显式 cancel 并等待 cleanup。
- runtime registry 暴露 runningCommands 状态。
- 增加测试：长命令执行期间 deactivate/reload 的行为应稳定且可诊断。

### 6.5 待继续核查点

- `loadWithDependencies` 对缺失依赖、循环依赖和依赖加载失败的最终语义：当前看起来会尽量继续加载主插件，需要确认是否符合产品预期。
- `reload` 调用 `callbacks.load` 失败时，旧插件实例是否已经被卸载且无法恢复；开发热重载是否需要恢复上一个可用版本。
- `UIExtensionManager.saveUIContributions` 多条 command/button/page 保存中途失败时，旧 UI contribution 是否会与新 manifest 混合。
- `PluginFileWatcherManager.stopAll` 使用 `Promise.all`，单个 watcher 停止失败是否影响其他 watcher 完整清理。
- 插件页面 postMessage 的 origin/source 校验属于权限与信任边界，暂不在本轮结论中展开，但后续独立安全审计必须覆盖。
- helper 中 scheduler/webhook/taskQueue/profile/browser 的跨模块资源释放，还需要在任务系统和浏览器模块二次联查。

### 6.6 当前测试覆盖观察

已看到的覆盖：

- `plugin-loader.test.ts` 覆盖 manifest 校验、导入、UI contribution 保存、错误返回、module load。
- `plugin-installer.test.ts` 覆盖 createTables、createSingleTable、deletePluginTables、orphanPluginTables、孤儿表恢复和 schema compatibility。
- `plugin-lifecycle.test.ts` 覆盖 deactivate、onStop、canDeactivate、热重载基础分支、reload 事件。
- `manager.test.ts` 覆盖 loadWithDependencies、enable/disable、uninstall、executeCommand、hot reload、reload 等管理器行为。
- `registry.test.ts` 和 `runtime-registry.test.ts` 覆盖跨插件 registry 和运行态状态。
- helper contract/namespace tests 覆盖 helper 公开面和若干具体 namespace。

初步缺口：

- command-only 插件激活和命令执行测试不足。
- 首次安装部分失败后的文件/metadata/folder/table/UI 清理测试不足。
- activate 中途失败后的 context/helpers dispose 测试不足。
- 插件表多表创建中途失败和 metadata 保存失败的补偿测试不足。
- 卸载 delete/orphan 失败后的用户可见状态和残留测试不足。
- 热重载 DB 更新失败后的 watcher 补偿测试不足。
- 自定义页面注入脚本真实浏览器运行测试不足。
- 命令执行中停用/重载的并发测试不足。

## 7. 模块四：本地 HTTP/MCP 自动化端点

状态：`待复核`

### 7.1 审计范围

第一轮已覆盖：

- HTTP/MCP server 总入口：`src/main/mcp-server-http.ts`
- Express 组装和路由注册：`src/main/http-server-composition.ts`、`src/main/http-route-registry.ts`
- HTTP server 生命周期：`src/main/http-server-lifecycle.ts`
- MCP route handlers：`src/main/mcp-http-adapter.ts`、`src/main/mcp-http-route-handlers.ts`
- MCP session runtime：`src/main/mcp-http-session-runtime.ts`、`src/main/mcp-http-session-lifecycle.ts`
- HTTP/MCP session queue 和清理：`src/main/http-session-manager.ts`、`src/main/http-session-bridge.ts`
- Browser pool HTTP adapter：`src/main/http-browser-pool-adapter.ts`
- Orchestration REST routes：`src/main/orchestration-http-routes.ts`
- 响应和错误映射：`src/main/http-response-mapper.ts`、`src/main/http-error-utils.ts`
- health/trace/auth/config：`src/main/http-system-routes.ts`、`src/main/http-trace-middleware.ts`、`src/main/http-auth-middleware.ts`、`src/main/http-api-config-guard.ts`
- 幂等持久化：`src/main/orchestration-idempotency-duckdb-store.ts`
- OpenAPI contract：`src/main/schemas/orchestration-openapi-v1.json`、`orchestration-openapi-contract.test.ts`
- 相关测试：`mcp-server-http*.test.ts`、`http-session-manager.test.ts`、`http-session-bridge.test.ts`、`http-browser-pool-adapter.test.ts`、`http-server-*test.ts`、`mcp-http-session-runtime.test.ts`。

本轮暂不评价“是否允许谁调用”的权限与信任边界；只看端点合约、session 生命周期、队列、超时、资源释放、一致性和可诊断性。

### 7.2 入口和核心流程

已确认的端点和调用主线：

- 健康检查：`GET /health` -> `buildHealthPayload`
- MCP transport：`GET/POST/DELETE /mcp` -> `StreamableHTTPServerTransport`
- MCP initialize：创建 `McpSessionInfo`，`onsessioninitialized` 后放入 `runtimeState.transports`
- MCP tool call：`CallToolRequestSchema` -> `enqueueInvokeTask` -> `OrchestrationExecutor.invoke`
- MCP session_prepare/session_get_current/session_end_current：通过 `createMcpSessionGateway`
- REST orchestration：`/api/v1/orchestration/capabilities|metrics|sessions|invoke`
- REST session create：`POST /sessions` -> browser pool acquire -> create executor -> store `OrchestrationSessionInfo`
- REST invoke：`POST /invoke` -> per-session queue -> `executor.invokeApi`
- Session cleanup：定时 `cleanupInactiveSessions`、DELETE session、MCP terminate、server stop
- Browser binding：profile/runtime/visible 在 acquisition 前准备，acquire 后 binding locked

### 7.3 已验证的正向设计

#### HTTP-OK-001：HTTP/MCP 入口边界集中，系统路由、MCP 路由和 REST orchestration 分层注册

状态：`已证实`

证据：

- `createHttpServerComposition` 统一注册 trace、auth、health、MCP、orchestration routes。
- `registerHttpRoutes` 根据 `enableMcp` 控制 `/mcp` 是否注册，并始终注册 orchestration REST。
- `buildRestApiDependencies` 把 DuckDB、插件、profile、observation、browser runtime 等依赖收敛成网关。

影响：

- HTTP 入口没有散落在多个主进程文件里，审计和回归测试切入点清楚。

#### HTTP-OK-002：MCP transport 对协议版本、Origin、canonical transport input 有保护和测试

状态：`已证实`

证据：

- `validateMcpProtocolVersion` 校验 header 和 initialize protocol version，并拒绝不匹配。
- `validateMcpOrigin` 默认允许无 Origin/loopback Origin，可配置外部 allowed origins。
- `validateCanonicalTransportInputs` 拒绝 transport-level profile/runtime/scopes/toolProfile 输入，要求使用 `session_prepare`。
- `mcp-server-http.transport-session.test.ts` 覆盖 session 复用时拒绝 `mcp-partition`、`mcp-runtime-id` 等输入。

影响：

- MCP transport 和 tool/session 语义分层比较明确，避免同一个 session 被请求级 header 悄悄改 profile/runtime。

#### HTTP-OK-003：每个 MCP/REST session 都有串行 invokeQueue、队列上限、timeout 和 AbortSignal

状态：`已证实`

证据：

- `enqueueInvokeTask` 使用 per-session `invokeQueue` 串联调用。
- 队列超过 `maxQueueSize` 会抛 `Queue overflow` 并增加 `queueOverflowCount`。
- 每次 active invocation 创建 `AbortController`，timeout 会 abort signal，并增加 `invokeTimeoutCount`。
- session cleanup 会 abort close controller 和 active invocation controller。
- `http-session-manager.test.ts` 覆盖 timeout 会 abort signal，cleanup 会 abort in-flight invoke 并释放 browser。

影响：

- 同一个 session 的调用不是无序并发，已有基础背压和超时机制。

#### HTTP-OK-004：MCP session browser binding 有 stale handle 回收、hidden host、viewport health 和 acquire diagnostics

状态：`已证实`

证据：

- `ensureSessionBrowserHandle` 在复用 handle 前检查 `isMcpBrowserHandleUsable`，stale handle 会 `release({ destroy: true })` 后重新获取。
- hidden MCP session 会创建 hidden automation host 并通过 `showBrowserView` 附着 view。
- `collectSessionViewportState` 记录 hostWindowId、viewportHealth、interactionReady、offscreenDetected。
- acquire timeout 会包装成带 `acquireReadiness` 的结构化错误。
- `mcp-http-session-runtime.test.ts` 覆盖 stale handle、hidden host、无 managed view、acquire contention diagnostics。

影响：

- MCP browser session 不只是保存一个 handle，还具备 host/viewport 可诊断状态。

#### HTTP-OK-005：MCP current session 关闭采用 after-response-flush，避免自杀式工具调用中断响应

状态：`已证实`

证据：

- `closeSession(... allowCurrent: true)` 会 `markSessionClosingAfterResponse`，设置 `terminateAfterResponse`。
- `armPendingMcpSessionTerminationOnResponse` 在 response `finish/close/error` 后触发 cleanup，并做 once/finalized 防重入。
- `mcp-http-session-lifecycle.ts` 清理前会确认 transports 中 active session 仍是同一对象。
- 测试覆盖 `closeSession marks the current session as closing before response-flush cleanup`。

影响：

- `session_end_current` 这类当前 session 自关闭工具可以先返回结果，再清理 transport/browser。

#### HTTP-OK-006：REST orchestration 有统一响应 `_meta`、OpenAPI drift contract 和幂等基础

状态：`已证实`

证据：

- `sendSuccess/sendStructuredError` 统一输出 `_meta.traceId/durationMs/sessionId/capability`。
- `orchestration-openapi-contract.test.ts` 校验 v1 路径、统一响应头、Bearer 安全声明、幂等和 scopes header。
- `orchestration-http-routes.ts` 支持 `Idempotency-Key` 和可选 `x-airpa-idempotency-namespace`。
- `mcp-server-http.auth-invoke.test.ts` 覆盖幂等 replay、DuckDB persistence get/set namespace。

影响：

- REST API 合约不是纯文档，已有 drift test 和运行时响应元数据。

### 7.4 已发现问题

#### HTTP-001：invoke timeout/abort 使用 Promise.race，底层不响应 AbortSignal 时旧任务会在后台继续执行

级别：`P1`

证据状态：`已证实代码路径，待构造后台继续执行测试`

代码证据：

- `http-session-manager.ts` 的 `waitForAbortableTask` 在 timeout/abort 时 reject，但无法取消传入的 `task` Promise 本身。
- `enqueueInvokeTask` 的 finally 会在 race reject 后立即减少 `activeInvocations/pendingInvocations`，并让 `session.invokeQueue` 继续后续任务。
- `capability-registry.ts` 也用 `awaitAbortableInvocation(Promise.race)` 包装能力调用和 browserFactory。
- `bindAbortSignalToFacade` 能让被包装的 browser 方法返回 abort reject，但如果底层方法忽略取消并继续执行副作用，外层无法等待其真正停止。
- `http-session-manager.test.ts` 只覆盖 task 主动监听 signal 后 reject；`mcp-server-http.auth-invoke.test.ts` 的 timeout 用永不 resolve snapshot，只验证返回 408，没有验证旧任务是否仍在后台运行或后续任务是否与旧任务重叠。

影响场景：

- MCP/REST 调用超时后，底层能力仍在浏览器、插件、数据集或 profile 上继续操作。
- 同一 session 后续 invoke 已开始，但旧 invoke 的底层副作用还没结束。

风险：

- 破坏“同一 session 串行执行”的语义，出现后台旧任务和新任务并发。
- 可能导致浏览器操作交错、数据写入交错、插件命令交错。
- metrics 显示 active=0，但实际还有未停止的底层工作。

建议修复方向：

- 明确能力 handler 必须响应 AbortSignal，并建立 contract tests。
- 对无法取消的底层 Promise，timeout 后不要立刻释放串行队列；至少要进入 `aborting` 状态并等待一个 cleanup budget。
- 区分 `response timeout` 和 `task cancellation complete` 两个状态，runtime metrics 增加 abandoned/background task counter。
- 对 browser facade 的 abort 可增加 best-effort cleanup，例如导航 stop、release/destroy 或 runtime-specific cancel。

需要新增测试：

- 一个不监听 signal 但延迟产生副作用的 mock capability：第一次 invoke timeout 后，第二次 invoke 不应与第一次后台副作用交错，或应报告 session contaminated/abandoned。
- cleanup/DELETE session 时，底层 task 未结束时 metrics 和状态应可诊断。

#### HTTP-002：`AirpaHttpMcpServer.start()` 缺少幂等保护，重复 start 可能泄漏 HTTP server 和 cleanup timer

级别：`P2`

证据状态：`已证实代码路径，待最小复现`

代码证据：

- `AirpaHttpMcpServer.start` 每次都会调用 `startHttpServer`，并把返回的 `httpServer/cleanupTimer` 覆盖到实例字段。
- 方法开始处没有检查 `this.httpServer` 是否已存在或正在 listening。
- 如果同一实例重复 `start()` 且端口为 `0`，可能启动多个 server；实例只保留最后一个 server 引用。
- `stop()` 只停止当前字段里的 server/timer，之前启动的 server/timer 可能残留。
- `http-server-lifecycle.test.ts` 覆盖 stop 幂等，但未覆盖 `AirpaHttpMcpServer.start()` 幂等。

影响场景：

- 主进程启动流程重复调用 HTTP server start。
- 配置变更/重启 HTTP API 时 start/stop 顺序异常。
- 测试或开发工具误调用 start 两次。

风险：

- 端口和 cleanup timer 泄漏。
- 健康检查显示一个 server，实际另一个旧 server 仍在响应。

建议修复方向：

- `start()` 若已 running，直接返回或抛出明确错误。
- 对 start-in-progress 增加 promise guard。
- 增加同实例 double start 测试，断言不会创建第二个 listener/timer。

#### HTTP-003：`stopHttpServer` 对 session cleanup 使用 `Promise.all`，单个 cleanup 失败会中断 server close

级别：`P2`

证据状态：`已证实代码路径，待故障注入测试`

代码证据：

- `stopHttpServer` 收集所有 `cleanupMcpSession/cleanupOrchestrationSession` 到 `cleanupTasks`。
- 随后 `await Promise.all(cleanupTasks)`，没有对单个 cleanup 失败做 allSettled 或 catch。
- 如果任意 session cleanup reject，函数会直接抛出，后面的 `httpServer.close` 不执行。
- `cleanupMcpSession` 和 `cleanupOrchestrationSession` 内部捕获了不少错误，但并不保证所有路径都不会 reject，例如调用方传入的 cleanup 实现或未来新增 cleanup 可能抛出。
- `http-server-lifecycle.test.ts` 覆盖等待 cleanup 完成，没有覆盖 cleanup reject 后仍关闭 server。

影响场景：

- 应用退出时某个 session 清理失败。
- 插件/浏览器释放路径抛出未捕获异常。

风险：

- HTTP server 可能没有关闭，进程退出/重启卡住或端口占用。
- 后续 session cleanup 也可能因为 Promise.all reject 提前无法被完整观察。

建议修复方向：

- server stop 应优先保证关闭监听 socket；session cleanup 使用 `Promise.allSettled`，汇总失败日志。
- 必要时先 `httpServer.close` 拒绝新请求，再并发清理 session。
- 增加 cleanup reject 测试：仍应关闭 server、清空 maps，并记录失败。

#### HTTP-004：MCP 初始化请求中如果包含 initialize batch，session 创建和请求处理语义需要复核

级别：`P2`

证据状态：`待核查`

代码证据：

- `findInitializeRequest` 支持在 JSON-RPC batch 数组中查找 initialize。
- `handleInitializeRequest` 只要没有 `mcp-session-id` 且存在 initialize，就创建新 transport/server，并把原始 `requestBody` 交给 `transport.handleRequest`。
- 如果 batch 同时包含 initialize 和 tools/call，具体执行顺序和 sessionId 返回语义依赖 MCP SDK。
- 当前测试重点覆盖单条 initialize、坏协议、session reuse，尚未看到 batch initialize+tool call 的行为测试。

影响场景：

- 客户端发送 JSON-RPC batch，把 initialize 和后续请求合并。

风险：

- 同一 HTTP 请求里创建 session 后又执行需要 session 状态的 tool call，可能产生不一致或错误不可诊断。
- 如果 SDK 允许 batch 后续 tool call，可能绕过客户端读取 `mcp-session-id` 后再调用的预期流程。

建议修复方向：

- 明确是否支持 initialize batch。保守做法：initialize 请求必须单独发送，batch initialize 返回 400。
- 如果支持，增加 contract test 固化 SDK 行为和 sessionId/header 语义。

#### HTTP-005：REST orchestration session create 在 visibility/show/hide 成功后、session 注册前失败，只释放 browser 但不强制 destroy

级别：`P2`

证据状态：`已证实代码路径，待评估期望语义`

代码证据：

- `POST /sessions` 先 `acquireBrowserFromPool` 得到 handle。
- try 中会执行 show/hide、创建 executor、写入 `orchestrationSessions`。
- catch 中如果 `!sessionRegistered`，调用 `browserHandle.release()`，没有传 `{ destroy: true }`。
- MCP cleanup 和 recycle 失败路径多处使用 `release({ destroy: true })`，说明异常路径是否应销毁需要统一语义。

影响场景：

- REST session 创建时 show/hide 抛错、executor 创建抛错、写入 session 前异常。

风险：

- 可能把 show/hide 失败或半初始化状态的 browser 放回 idle 池。
- 后续 session 复用到 viewport/visibility 状态异常的 browser。

建议修复方向：

- 如果失败发生在 visibility 应用或 executor 创建后，考虑 `release({ destroy: true })`。
- 至少区分失败阶段：acquire 后未 touched 可普通 release；已 touched 或 show/hide failure 应 destroy。
- 增加 show/hide 抛错的 session create 测试，断言释放策略。

#### HTTP-006：自定义 idempotency namespace 的生命周期语义未在文档/测试中完全固化

级别：`P3`

证据状态：`待确认产品语义`

代码证据：

- `resolveIdempotencyNamespace` 支持 `x-airpa-idempotency-namespace`，默认 namespace 为 sessionId。
- `DELETE /sessions/:sessionId` 只调用 `idempotencyPersistence.deleteNamespace(sessionId)`。
- 如果调用方使用自定义 namespace，例如 `order-1001`，删除 session 不会删除该 namespace 的持久化幂等记录。
- 测试覆盖自定义 namespace 的 get/set，并断言 delete session 时删除默认 sessionId namespace；没有说明自定义 namespace 是否故意跨 session 保留。

影响场景：

- 客户端用业务订单号/任务号作为幂等 namespace。
- session 删除后，新 session 复用同 namespace/key。

风险：

- 如果预期“session 删除清理所有本 session 产生的幂等记录”，当前行为会保留自定义 namespace。
- 如果预期“自定义 namespace 用于跨 session 幂等”，则当前行为正确，但需要文档和 OpenAPI 更明确。

建议修复方向：

- 在 OpenAPI 和用户文档中明确自定义 namespace 生命周期。
- 如果要随 session 清理，需要记录 session -> custom namespace 映射并 delete。
- 增加测试覆盖跨 session replay 或 session delete 后保留/删除自定义 namespace 的明确语义。

### 7.5 待继续核查点

- MCP SDK `StreamableHTTPServerTransport` 在 batch initialize、GET SSE close、DELETE terminate 失败时的具体行为。
- HTTP auth/security 已有基础测试，但独立权限与信任边界审计需要覆盖 token 存储、mcpRequireAuth=false、allowedOrigins 和本地网络暴露。
- MCP session hidden automation host 和 WebContentsViewManager 的 attach/detach 需要在桌面调试/运行健康模块继续联查。
- REST orchestration 的 profile/plugin/dataset 写能力与插件/数据模块的一致性风险需要回到对应模块二次复核。
- `createAsyncHandler` 在 `res.headersSent` 后只返回，streaming/SSE 异常的日志和客户端可见性需要结合 MCP SDK 复核。

### 7.6 当前测试覆盖观察

已看到的覆盖：

- `mcp-server-http-transport.test.ts`、`transport-session.test.ts` 覆盖 MCP 协议、transport guardrails、session lifecycle。
- `mcp-server-http.mcp-surface.test.ts` 覆盖 MCP public tool surface。
- `mcp-server-http.browser-binding.test.ts` 覆盖 session_prepare、profile/runtime/visible binding。
- `mcp-server-http.auth-invoke.test.ts` 覆盖 auth、REST invoke、timeout、idempotency、scope metadata。
- `mcp-server-http.orchestration-routes.test.ts` 覆盖 REST orchestration routes 和 plugin/dataset/profile/observation 能力入口。
- `http-session-manager.test.ts` 和 `http-session-bridge.test.ts` 覆盖 timeout abort、cleanup abort、inactive cleanup 和 metrics。
- `http-server-lifecycle.test.ts` 覆盖 cleanup timer、stop 等待 cleanup、stop 幂等。
- `orchestration-openapi-contract.test.ts` 覆盖 OpenAPI v1 drift。

初步缺口：

- timeout 后底层不响应 AbortSignal 的后台任务/队列串行破坏测试不足。
- `AirpaHttpMcpServer.start()` double-start 测试不足。
- server stop 中单个 session cleanup reject 仍关闭 server 的测试不足。
- MCP initialize batch 语义测试不足。
- REST session create show/hide/executor 失败后的释放策略测试不足。
- 自定义 idempotency namespace 生命周期语义测试/文档不足。

## 8. 模块五：桌面调试与运行健康系统

状态：`待复核`

### 8.1 审计范围

第一轮已覆盖：

- 运行时观测核心：`src/core/observability`
- DuckDB 观测落盘与查询：`src/main/duckdb/runtime-observation-service.ts`、`src/main/observation-query-service.ts`
- 观测 IPC/HTTP/MCP 暴露：`src/main/ipc-handlers/observation-handler.ts`、`src/core/ai-dev/capabilities/observation-catalog.ts`、`src/main/http-server-composition.ts`
- 启动诊断和运行时错误：`src/main/bootstrap/startup-diagnostic-log.ts`、`src/main/bootstrap/runtime-error-bootstrap.ts`、`src/main/bootstrap/app-ready-bootstrap.ts`
- 健康检查和运行指纹：`src/main/runtime-fingerprint.ts`、`src/main/main-build-freshness.ts`、`src/main/renderer-build-freshness.ts`、`src/main/http-runtime-diagnostics.ts`
- 关闭协调：`src/main/runtime/shutdown-coordinator.ts`、`src/main/bootstrap/shutdown-bootstrap.ts`
- WebContentsView 诊断：`src/main/window-manager-diagnostics.ts`、`src/main/webcontentsview-viewport-debugger.ts`、`src/main/webcontentsview-manager.ts`、`src/main/webcontentsview-state-controller.ts`
- 相关测试：`observation-service.test.ts`、`runtime-observation-service.test.ts`、`observation-query-service.test.ts`、`app-ready-bootstrap.test.ts`、`runtime-error-bootstrap.test.ts`、`shutdown-coordinator.test.ts`、`http-runtime-diagnostics.test.ts`。

### 8.2 入口和核心流程

已确认的调试与健康入口：

- 业务 trace：`withTraceContext` / `observationService.startSpan` / `observationService.event`
- 失败证据：`attachErrorContextArtifact`、`attachBrowserFailureBundle`
- 观测落盘：`setObservationSink` -> `RuntimeObservationService.recordEvent/recordArtifact`
- trace 查询：`ObservationQueryService.getTraceSummary/getFailureBundle/getTraceTimeline/searchRecentFailures`
- IPC 查询：`observation:get-trace-summary`、`observation:get-failure-bundle`、`observation:get-trace-timeline`、`observation:search-recent-failures`
- MCP 查询：`observation_get_trace_summary`、`observation_get_failure_bundle`、`observation_get_trace_timeline`、`observation_search_recent_failures`
- 启动诊断：`runAppReadyBootstrap` 分阶段执行并写入 startup diagnostic log。
- 运行健康：HTTP health 组合 runtime fingerprint、build freshness、MCP SDK shim、session leak risk、协议版本和 runtime alerts。
- 关闭协调：`ShutdownCoordinator` 串行执行清理步骤，记录 completed/failed/timed-out。

### 8.3 已验证的正向设计

#### DEBUG-OK-001：运行时观测采用 trace/span/artifact 模型，业务侧接入面较广

状态：`已证实`

证据：

- `ObservationService` 基于 `AsyncLocalStorage` 的 trace context 创建 span、event 和 artifact。
- dataset、profile、plugin、browser facade、orchestration/system capability 等关键入口均可创建 span 或记录 error context。
- observation sink 写失败会被捕获并记录 warn，不会直接把业务请求变成失败。

影响：

- 出现跨模块失败时，可以用 trace id 串联业务入口、组件、实体 id 和失败证据。

#### DEBUG-OK-002：runtime observation 已落盘到 DuckDB，并有 trace 顺序索引

状态：`已证实`

证据：

- `RuntimeObservationService.initTable` 创建 `runtime_events` 和 `runtime_artifacts`。
- 表中包含 trace/span、component、capability、pluginId、browserRuntimeId、sessionId、profileId、datasetId、browserId、attrs、error、artifactRefs。
- 建立 `idx_runtime_events_trace_seq`、`idx_runtime_artifacts_trace_seq` 等索引。
- `DuckDBService.initSystemTables` 初始化 runtime observation service。

影响：

- 重启后仍能查询历史 trace，且失败证据不只停留在内存里。

#### DEBUG-OK-003：观测查询已同时暴露给 IPC、HTTP/MCP 和编排能力

状态：`已证实`

证据：

- `ObservationQueryService` 提供 trace summary、failure bundle、timeline、recent failures。
- `registerObservationHandlers` 将查询挂到主进程 IPC。
- `http-server-composition` 注入 `observationGateway`。
- `observation-catalog.ts` 定义四个 read-only MCP/编排工具，并声明 output schema、assistant guidance 和 recommended next tools。

影响：

- Agent、CLI、渲染进程和本地 HTTP/MCP 客户端都能以结构化方式读取失败证据。

#### DEBUG-OK-004：启动、运行时错误和关闭路径已有分层诊断

状态：`已证实`

证据：

- `startup-diagnostic-log.ts` 记录 package、app、platform、node/chrome/electron、路径和启动阶段。
- `runtime-error-bootstrap.ts` 区分 critical/non-critical runtime error，忽略 EPIPE/stream destroyed 等运行时 IO 噪声。
- critical error 会尝试关闭 DuckDB、弹出错误框并退出。
- `ShutdownCoordinator` 对每个 shutdown step 单独记录状态、耗时和错误，并在失败后继续执行后续步骤。

影响：

- 应用启动失败、运行时崩溃和退出卡顿都有基础诊断面。

#### DEBUG-OK-005：运行健康检查包含 build freshness 和本地 HTTP runtime 诊断

状态：`已证实`

证据：

- `runtime-fingerprint.ts` 汇总 main/renderer build freshness、main build stamp、git commit、MCP SDK initialize shim 状态。
- `http-runtime-diagnostics.ts` 可探测端口响应、当前进程、自身 Airpa server、其他 Airpa server 和异常响应。
- HTTP/MCP health payload 会携带 runtime alerts、session metrics、capability provider status 和协议版本。

影响：

- 常见的“启动了旧 dist”“端口被其他进程占用”“MCP SDK shim 降级”等问题可以从健康接口直接定位。

#### DEBUG-OK-006：浏览器自动化失败会收集快照、console、network 和 error context

状态：`已证实`

证据：

- `attachBrowserFailureBundle` 会 best-effort 采集当前 URL、标题、snapshot、console tail、network summary。
- browser facade 的失败路径会附加 failure bundle。
- MCP browser observation/action 路径会把 viewport health、interactionReady、offscreenDetected 等状态放入提示。

影响：

- 页面自动化失败时，不需要只依赖纯文本错误，能拿到页面和网络上下文。

### 8.4 已发现问题

#### DEBUG-001：启动阶段 timeout 只中断等待，不会取消已超时的初始化动作

级别：`P1`

证据状态：`已证实代码路径，待最小复现`

代码证据：

- `runBootstrapStage` 创建 `actionPromise` 后用 `Promise.race([actionPromise, timeoutPromise])` 等待。
- timeout 后会进入 `handleInitializationFailure`，但 `actionPromise` 本身没有 AbortSignal 或取消机制。
- 如果 `initializeServices`、`initializePlugins`、`createWindow`、`initializeIPC` 或 `initializeBrowserControlApi` 在超时后继续完成，仍可能注册 IPC、启动服务或创建窗口。
- `app-ready-bootstrap.test.ts` 覆盖“超时后不继续下一阶段”，但未覆盖“超时动作后来 resolve/reject 是否产生副作用”。

影响场景：

- DuckDB 初始化、插件加载、窗口创建、HTTP/MCP 初始化或浏览器控制 API 启动卡住后又迟到完成。

风险：

- 失败处理或退出流程已经开始时，后台初始化继续改变全局状态。
- 可能出现重复 IPC handler、半启动 HTTP server、半初始化插件 runtime 或窗口状态污染。

建议修复方向：

- 对支持取消的阶段传入 AbortSignal。
- 对不可取消阶段增加 generation token/startup state guard，超时后禁止迟到结果注册全局资源。
- targeted test：让初始化阶段 timeout 后再 resolve，断言不会注册后续资源或写入 ready 状态。

#### DEBUG-002：关闭步骤 timeout 后，已超时 cleanup 仍可能在后台继续运行并与后续步骤交错

级别：`P2`

证据状态：`已证实代码路径，待故障注入测试`

代码证据：

- `ShutdownCoordinator.runWithTimeout` 同样使用 `Promise.race`。
- 某个 step timed-out 后，coordinator 会继续执行后续 shutdown steps。
- timed-out step 的 Promise 没有被取消，后续仍可能继续释放浏览器、关闭窗口、关闭 DuckDB 或写日志。
- `shutdown-coordinator.test.ts` 覆盖 stuck step 标记为 timed-out，但未覆盖 timed-out step 后来完成并与后续步骤交错。

影响场景：

- 浏览器池停止、窗口销毁、插件 unload、DuckDB close 或 HTTP server stop 卡住。

风险：

- 后续步骤已经关闭共享资源后，迟到 cleanup 再访问这些资源，引发二次异常或资源状态不一致。
- 退出诊断只显示 timed-out，无法反映迟到 cleanup 的最终副作用。

建议修复方向：

- 对 shutdown step 传入 AbortSignal 或 shutdown context。
- 对关键资源 cleanup 增加幂等和 state guard。
- 记录 timed-out step 的 late completion/late failure。

#### DEBUG-003：runtime observation 查询对 JSON 字段损坏不容错，诊断入口可能被单条坏数据拖垮

级别：`P2`

证据状态：`已证实代码路径，待故障注入测试`

代码证据：

- `RuntimeObservationService.parseJson` 直接 `JSON.parse(value)`，没有 try/catch。
- `toRuntimeEvent` 会解析 `attrs`、`error`、`artifact_refs`。
- `toRuntimeArtifact` 会解析 `attrs`、`data`。
- 如果 DuckDB 中存在损坏 JSON，`listEventsByTrace`、`listArtifactsByTrace`、`getTraceSummary`、`getFailureBundle` 等诊断查询会直接抛错。
- 当前 observation service 测试主要覆盖正常 JSON 写入/读取，未看到损坏 JSON 容错测试。

影响场景：

- 旧版本写入格式变化、手工修复数据库、DuckDB JSON 类型兼容问题、异常中断导致字段异常。

风险：

- 用户最需要诊断失败时，观测查询本身失败。
- `observation_get_failure_bundle`、IPC 观测页面或 HTTP health debug 工具无法返回部分可用证据。

建议修复方向：

- `parseJson` 返回 `{ parseError, raw }` 或在字段级降级为 undefined，并记录 warning artifact。
- failure bundle/summary 查询应尽量返回剩余可解析事件。
- 增加 corrupt JSON fixture 测试。

#### DEBUG-004：runtime observation 没有自动保留/清理策略，长期运行可能造成本地库膨胀

级别：`P2`

证据状态：`已证实代码路径`

代码证据：

- 普通日志链路存在 `LogStorageService.cleanup(daysToKeep = 7)` 和 `LogService.cleanupLogs`。
- `RuntimeObservationService` 只看到 `clearAll()`，未看到按天数、数量或 trace 状态的 prune/retention 入口。
- `runtime_events` 和 `runtime_artifacts` 可能保存 snapshot、console tail、network summary、screenshot base64、error context 等较大 JSON。

影响场景：

- 长时间运行自动化任务、频繁浏览器失败、Agent 大量调用 observation/failure bundle。

风险：

- 主 DuckDB 文件持续增长。
- trace 查询变慢，备份/同步/升级成本升高。
- 大量 screenshot 或 snapshot artifact 可能放大磁盘占用。

建议修复方向：

- 增加 runtime observation retention 配置，例如保留最近 N 天、最多 N 条事件、最多 N MB artifact。
- 对大 artifact 单独限制大小或落文件并维护索引。
- 增加 cleanup metrics 和 health alert。

#### DEBUG-005：浏览器 failure bundle 在 snapshot 成功时跳过 screenshot，视觉类故障证据不足

级别：`P2`

证据状态：`已证实代码路径，待评估产品期望`

代码证据：

- `attachBrowserFailureBundle` 只有在 `!artifacts.some((artifact) => artifact.type === 'snapshot')` 时才调用 `screenshotDetailed`。
- snapshot 成功并不等价于页面视觉正常，例如空白页面、遮挡、裁剪、缩放、透明覆盖层和 WebContentsView 坐标问题。
- 失败包最多默认 4 个 artifact，snapshot、console tail、network summary 占满后也不会再采集 screenshot。

影响场景：

- 页面 DOM 可解析但实际不可见。
- WebContentsView bounds、缩放、离屏、遮罩或截图回退问题。

风险：

- failure bundle 看起来有 snapshot，但无法判断用户实际看到的画面。
- 视觉/布局/视口类故障需要重新复现，降低诊断效率。

建议修复方向：

- 对浏览器自动化失败默认保留一张低质量 viewport screenshot，或在 snapshot 成功但 viewport health 异常时强制截图。
- 将 screenshot 与 snapshot 区分为不同诊断维度，不互相替代。
- 增加 failure bundle 测试覆盖 snapshot+screenshot 共存策略。

#### DEBUG-006：WebContentsView viewport 诊断只在开发模式写 debug 日志，生产故障不可结构化追踪

级别：`P2`

证据状态：`已证实代码路径`

代码证据：

- `WebContentsViewViewportDebugger.schedule` 开头 `if (!isDevelopmentMode()) return`。
- 诊断内容只通过 `logger.debug('Viewport diagnostics', ...)` 输出，未写入 runtime observation artifact 或 health payload。
- 诊断包含 desiredBounds、actualBounds、DOM viewport、window content bounds、fullscreen/maximized、activityBarWidth 等关键字段。

影响场景：

- 用户生产环境遇到页面空白、视图错位、hidden host、窗口尺寸和 WebContentsView bounds 不一致。

风险：

- 本该最有价值的 viewport 诊断在生产环境不可用。
- HTTP/MCP failure bundle 和 health alerts 很难解释桌面窗口/视图层问题。

建议修复方向：

- 将异常 viewport 状态写入 observation artifact 或 health diagnostics，正常重复状态可继续只在 dev debug。
- 在 browser failure bundle 中附带最近一次 WebContentsView/window diagnostics。
- 增加生产模式下的 offscreen/zero-size/mismatch 结构化诊断测试。

#### DEBUG-007：observation sink 写入被业务路径同步等待，缺少超时或后台队列隔离

级别：`P2`

证据状态：`已证实代码路径，待压测/故障注入`

代码证据：

- `ObservationService.event` 会 `await observationSink?.recordEvent(runtimeEvent)`。
- `ObservationService.attachArtifact` 会 `await observationSink?.recordArtifact(artifact)`。
- sink 写失败会被 catch 并降级为 warn，但如果 DuckDB 写入变慢或卡住，没有写入超时、缓冲队列或熔断。

影响场景：

- 高频 browser snapshot、插件命令、dataset 操作、HTTP/MCP invoke 同时记录大量 observation。
- DuckDB 繁忙、锁等待、磁盘慢或 artifact 过大。

风险：

- 原本只是调试观测的写入，会增加业务请求尾延迟。
- 极端情况下，观测系统卡住会拖慢或卡住关键流程。

建议修复方向：

- 将 observation sink 改为有界异步队列，业务路径只等待 enqueue。
- 对 recordEvent/recordArtifact 设置短超时和 drop/backpressure 统计。
- health payload 暴露 observation queue depth、drop count、last sink error。

### 8.5 待继续核查点

- `startup-diagnostic.log` 是否有外部轮转；当前启动诊断文件只看到 append 入口，未看到截断或保留策略。
- IPC handler 通用 wrapper 当前未自动建立 trace context；需要结合渲染层请求链路确认是否需要 IPC trace id。
- HTTP/MCP health 中的 runtime alerts 与 observation failure bundle 是否应共享同一组诊断字段。
- WebContentsView hidden automation host、page/temp/pool view 的 attach/detach 诊断还需要和浏览器模块二次联查。

### 8.6 当前测试覆盖观察

已看到的覆盖：

- `observation-service.test.ts` 覆盖 trace context、span、event、artifact、sink failure 降级。
- `runtime-observation-service.test.ts` 覆盖表/索引初始化、event/artifact 写入、按 trace 查询、recent failure 查询。
- `observation-query-service.test.ts` 覆盖 trace summary、failure bundle、timeline、recent failures。
- `app-ready-bootstrap.test.ts` 覆盖启动顺序、stage failure、stage timeout、默认 timeout。
- `runtime-error-bootstrap.test.ts` 覆盖 critical error、non-critical rejection、EPIPE 忽略和 handler 幂等。
- `shutdown-coordinator.test.ts` 覆盖顺序执行、失败继续、timeout 标记。

初步缺口：

- 启动/关闭 timeout 后底层 Promise 迟到完成的副作用测试不足。
- runtime observation JSON 损坏容错测试不足。
- observation retention/prune 测试缺失。
- sink 慢写/卡住/队列背压测试缺失。
- failure bundle 同时保留 snapshot 和 screenshot 的策略测试不足。
- WebContentsView 生产诊断和 observation artifact 联动测试不足。
- `observation-query-service.test.ts` 仍有 `browserEngine` mock 字段，而当前类型和 schema 使用 `browserRuntimeId`，需要清理以避免测试与真实模型漂移。

## 9. 模块六：任务系统和后台流程

状态：`待复核`

### 9.1 审计范围

第一轮已覆盖：

- 通用内存任务队列：`src/core/task-manager/queue.ts`
- 数据库驱动流水线：`src/core/task-manager/pipeline/pipeline.ts`
- core 层 scheduler facade：`src/core/task-manager/scheduler.ts`
- 主进程持久化 scheduler：`src/main/scheduler/scheduler-service.ts`
- scheduler 持久化服务：`src/main/duckdb/scheduled-task-service.ts`
- 旧任务持久化服务：`src/main/duckdb/task-persistence-service.ts`
- scheduler IPC 和 renderer store：`src/main/ipc-handlers/scheduler-handler.ts`、`src/renderer/src/stores/schedulerStore.ts`
- 插件 namespace：`src/core/js-plugin/namespaces/task-queue.ts`、`src/core/js-plugin/namespaces/scheduler.ts`
- 共享资源协调：`src/core/resource-coordinator.ts`
- 相关测试：`queue.test.ts`、`pipeline.test.ts`、`scheduler.test.ts`、`scheduler-service.test.ts`、`scheduler-resource.test.ts`、`scheduler-handler.test.ts`、`scheduled-task-service.bigint.integration.test.ts`。

### 9.2 入口和核心流程

已确认的任务/后台入口：

- 插件临时任务队列：`helpers.taskQueue.create` -> `TaskQueue.add/addAll/cancel/stop`
- 插件持久化定时任务：`helpers.scheduler.create` -> `SchedulerService.createTask` -> `ScheduledTaskService.createTask`
- 手动触发：IPC `scheduler:trigger-task` / plugin helper `scheduler.trigger` -> `SchedulerService.triggerTask`
- 定时触发：`SchedulerService.setTimer` -> `onTimerFired` -> `executeTask`
- 启动恢复：`SchedulerService.init` -> `ScheduledTaskService.getActiveTasks` -> `scheduleTask`
- 资源互斥：`SchedulerService.executeTask` -> `resourceCoordinator.acquire/runWithContext`
- 插件卸载清理：`PluginHelpers.dispose` -> `taskQueue.stopAll` + `scheduler.dispose`
- 后台执行历史：`task_executions` 表记录 pending/running/completed/failed/cancelled。

### 9.3 已验证的正向设计

#### TASK-OK-001：TaskQueue 超时只触发 abort，不用 Promise.race 释放并发槽

状态：`已证实`

证据：

- `TaskQueue.executeTask` 通过 `setTimeout(() => controller.abort(...))` 触发取消。
- 任务函数仍被 `await task(ctx)` 等待到真正结束后才释放 p-queue 并发槽位。
- 注释明确写明“超时不破坏并发上限”。
- `queue.test.ts` 覆盖超时取消、重试前检查取消状态、暂停/恢复、clear、stop。

影响：

- 相比前面 HTTP/启动/关闭的 `Promise.race` 模式，这里不会因为超时把仍在运行的任务当作已结束，从而破坏队列并发上限。

#### TASK-OK-002：TaskQueue 对 pending clear/stop 有显式 settle 和 listener cleanup

状态：`已证实`

证据：

- `clear()` 会 `queue.clear()`，并把 pending task 标记为 `cancelled`、reject deferred、清理 external signal listener、删除 task record。
- `stop()` 会先 `queue.start()`，再清 pending，取消 running，等待 running promise settled，最后 `queue.onIdle()`。
- `queue.test.ts` 覆盖暂停状态下清空待执行任务、stop 后拒绝新任务和 stop 幂等。

影响：

- 队列停止不会因为暂停状态或 pending promise 未 settle 而明显卡死。

#### TASK-OK-003：插件 taskQueue namespace 有队列数量限制、运行态注册和 stopAll

状态：`已证实`

证据：

- `TaskQueueNamespace` 限制每个插件最多 10 个 active queues。
- 创建队列时向 `PluginRuntimeRegistry.registerQueue` 注册，stop/release 时 unregister。
- idle 后不自动移除队列，避免长期 dispatcher 脱离 stopAll 管控。
- `task-queue.test.ts` 覆盖最大队列数量、idle 保留、stopAll 清空运行态计数。

影响：

- 插件临时队列资源有基本上限和运行态可见性。

#### TASK-OK-004：SchedulerService 有持久化执行历史、重试、超时和资源 key 串行化

状态：`已证实`

证据：

- `ScheduledTaskService` 创建 `scheduled_tasks` 和 `task_executions`，并建立 task/status/next_run/execution started 索引。
- `SchedulerService.executeTask` 创建 execution，更新 running/completed/failed/cancelled，更新 task run/fail count。
- `scheduler-service.test.ts` 覆盖同任务互斥、不同任务并行、重试、超时取消、handler missing。
- `scheduler-resource.test.ts` 覆盖相同 resource key 串行、不同 resource key 并行、resource wait timeout。

影响：

- 持久化定时任务具备基础的可恢复、可查询、可诊断和共享资源互斥能力。

#### TASK-OK-005：插件 scheduler facade 在创建失败和卸载时有补偿/清理设计

状态：`已证实`

证据：

- `Scheduler.create` 先注册 handler，再调用 `schedulerService.createTask`；createTask 失败时删除 handler 并 unregister。
- `Scheduler.dispose` 调用 `deleteTasksByPlugin` 删除该插件全部定时任务，再 unregister plugin handlers。
- `scheduler.test.ts` 覆盖 createTask 失败回滚 handler、dispose 调用 deleteTasksByPlugin、deleteTasksByPlugin 失败时仍 unregister handlers。

影响：

- 插件安装/卸载和持久化定时任务之间不是完全裸奔，能减少僵尸 handler 或僵尸任务。

#### TASK-OK-006：Scheduler execution retention 已有定期清理

状态：`已证实`

证据：

- `SchedulerService.startCleanupTimer` 初始化时立即 `performCleanup`，随后每 24 小时清理。
- `ScheduledTaskService.cleanupOldExecutions(daysToKeep = 30)` 删除 30 天前 execution。
- `scheduler-service.test.ts` 覆盖 init 执行清理、24 小时重复清理、dispose 后清理定时器停止。

影响：

- 定时任务执行历史不会无限增长，优于 runtime observation 当前无保留策略的状态。

### 9.4 已发现问题

#### TASK-001：`TaskQueue.cancelTask` 取消 pending 任务时不移出 p-queue，任务未来仍会启动

级别：`P1`

证据状态：`已证实代码路径，待最小复现`

代码证据：

- `TaskQueue.cancelTask(taskId)` 只调用 `record.controller.abort(...)`，不判断 `record.info.status`，也不从 p-queue 删除对应 pending task。
- pending task 的 `wrappedTask` 仍在 p-queue 中；当队列恢复或并发槽空出后，会进入 `executeTask` 并调用 `task(ctx)`。
- `executeTask` 在调用任务函数前没有检查 `controller.signal.aborted`。
- `clear()` 和 `stop()` 对 pending 任务有专门 settle/delete 逻辑，但单个 `cancelTask` 没有。
- 当前 `queue.test.ts` 覆盖 running cancel、clear pending、stop pending，未看到“单个 pending task cancel 后不应执行 task function”的测试。

影响场景：

- 队列 concurrency=1 时，用户取消排队中的某个插件任务。
- 插件批量任务中取消尚未开始的账号/profile 操作。

风险：

- 用户以为任务已取消，但任务随后仍启动，可能访问浏览器、profile、数据集或外部网络。
- 已 abort 的 signal 只有在插件任务主动检查时才会阻止副作用；如果任务开头先做了外部操作，再检查 signal，就已经造成影响。

建议修复方向：

- `cancelTask` 对 pending task 应复用 clear 的 pending settle 逻辑：标记 cancelled、emit、reject、cleanup listener、删除 record，并确保 queued wrapper 不会执行业务函数。
- 由于 p-queue 不支持按 id 删除时，可在 `wrappedTask/executeTask` 开头检查 signal.aborted，若已取消则直接 throw `TaskCancelledError`，不调用用户 task。
- 增加测试：pause queue -> add task -> cancelTask -> resume -> 断言 task function 未被调用且 promise rejected 为 TaskCancelledError。

#### TASK-002：Scheduler timer fire 中 `executeTask` 抛错会中断后续 reschedule/disable

级别：`P1`

证据状态：`已证实代码路径，待 timer 级测试`

代码证据：

- `onTimerFired` 中 `await this.executeTask(task, 'scheduled')` 没有 try/finally。
- `executeTask` 开头如果 `this.runningTasks.has(task.id)` 会 `throw new Error("Task ... is already running")`。
- `createExecution`、`updateExecution`、`updateTask`、resource acquire 等持久化/资源路径抛出的异常也可能从 `executeTask` 向外冒泡。
- 一旦 `executeTask` 抛出，`onTimerFired` 后续对 interval/cron 的 `nextRunAt` 更新和 `setTimer` 不会执行；once 任务的 `status: disabled` 也不会执行。
- 现有测试覆盖 `triggerTask` 的 already-running reject，但未看到 timer fired 后 executeTask 抛错仍 reschedule/disable 的测试。

影响场景：

- 定时器触发时同一任务仍在手动执行或上一次 scheduled 执行未完成。
- DuckDB createExecution/updateExecution 短暂失败。
- resource acquire 以外的异常在执行前抛出。

风险：

- 周期任务可能漏掉下一次调度，表现为“失败一次后不再跑”。
- 一次性任务执行路径异常时可能一直保持 active + 旧 nextRunAt，重启后反复恢复/尝试。

建议修复方向：

- `onTimerFired` 使用 try/finally 包裹 executeTask；无论执行成功、失败还是 already running，都按策略计算下一次时间或禁用 once。
- 区分 already-running 的 missed policy：可 skip 当前 tick 并安排下一次，而不是让 timer 链断掉。
- 增加 timer 级测试：already running 时 interval task 仍更新 nextRunAt 并设置新 timer；once task 执行异常后状态语义明确。

#### TASK-003：Scheduler pause/cancel/delete/dispose 会立即从 runningTasks 删除 controller，正在运行的 handler 仍可迟到完成并写库

级别：`P1`

证据状态：`已证实代码路径，待故障注入测试`

代码证据：

- `pauseTask` 发现 running controller 后 `controller.abort(); this.runningTasks.delete(taskId);`，随后更新 task status 为 paused。
- `cancelTask` 同样 abort 后立即 delete runningTasks，再删除 task 和 execution 历史。
- `deleteTasksByPlugin` 对每个 running task abort 后立即 delete runningTasks，再删除数据库任务。
- `dispose()` abort 所有 running controllers 后直接 `runningTasks.clear()`，不等待 handler settle。
- `executeTask` 的 finally 会在 handler 最终返回/抛错后继续 updateExecution/updateTask；如果任务记录已删除或 DuckDB 已关闭，可能产生迟到写入/异常。

影响场景：

- 用户暂停/取消正在运行的定时任务。
- 插件卸载时定时任务 handler 正在使用 profile/browser/database。
- 应用退出时 dispose scheduler 后很快 close DuckDB。

风险：

- 互斥保护提前消失，同一 task 可能被重新触发，同时旧 handler 尚未真正停止。
- cancel/delete 后旧 handler 迟到完成，可能写入已删除 execution/task 或访问已释放资源。
- shutdown 中 scheduler dispose 返回后，closeDuckDB 可能和迟到 handler 写库交错。

建议修复方向：

- runningTasks 不应在 abort 请求时删除，应保留到 `executeTask.finally`。
- pause/cancel/delete/dispose 可选择等待执行 settle，或显式记录 cancelling 状态并阻止重新触发。
- 对删除任务可先标记 cancelled/deleting，等待 running settle 后再删除历史，或让迟到 update 变成受控 no-op。
- 增加测试：cancel running task 后立即 trigger 同 task，应拒绝直到旧 handler settle；deleteTasksByPlugin 后迟到 handler 不应写坏 DB。

#### TASK-004：Scheduler 启动恢复没有修复上次进程遗留的 running/pending executions

级别：`P2`

证据状态：`已证实代码路径`

代码证据：

- `SchedulerService.init` 只读取 `getActiveTasks()` 并 schedule。
- `ScheduledTaskService` 没有看到类似 `markStaleExecutionsCancelled` 的启动修复入口。
- `task_executions` 中如果进程崩溃前留下 `pending` 或 `running`，重启后会继续作为未完成记录存在。
- `getRecentExecutions/getTaskHistory/getStats` 会直接读取这些历史。

影响场景：

- 应用崩溃、强杀、电源中断、升级重启时 scheduler execution 处于 pending/running。

风险：

- UI 和插件历史显示长期 running/pending 的僵尸执行。
- 统计中的今日执行数包含永不结束的记录，诊断时难以判断是否仍在运行。

建议修复方向：

- SchedulerService.init 时将本进程启动前遗留的 pending/running execution 标记为 cancelled/failed，error 写入 `Process restarted before execution completed`。
- 可以按 task status 和 last heartbeat 区分 cancelled vs failed。
- 增加集成测试：预置 running execution，init 后应被终结并可查询到明确错误。

#### TASK-005：Pipeline 查询到 item 后没有先声明/抢占状态，多 worker/多实例可能重复处理同一行

级别：`P2`

证据状态：`已证实代码路径，待并发复现`

代码证据：

- `StageWorker.queryItems` 只执行 `SELECT * FROM data WHERE status IN (...) ORDER BY ... LIMIT ...`。
- `processBatch` 直接对查询结果并发执行 handler。
- 在 handler 完成后才调用 `applyResult` 更新 status 到 `toStatus` 或 `errorStatus`。
- 多个 Pipeline 实例、同一 stage 的并发 poll、或应用重启后并行 worker 都可能在状态更新前读到同一批 pending 行。
- Pipeline 文档称“数据库状态持久化、自动轮询和并发控制、重启可恢复”，但当前控制是“完成后更新状态”，不是“开始前抢占状态”。

影响场景：

- 插件或内部模块启动多个 pipeline 实例处理同一个 dataset/table。
- handler 较慢，poll interval 短，或多个阶段/进程同时读取同一 fromStatus。

风险：

- 同一行重复调用外部 API、重复写数据、重复消耗浏览器/profile 资源。
- 失败/成功状态互相覆盖，导致数据行结果不确定。

建议修复方向：

- 增加 claiming 状态，例如 pending -> processing 原子更新后再执行 handler。
- 使用条件更新 `WHERE _row_id=? AND status=?` 并检查 rowsChanged，抢占失败则跳过。
- 增加并发测试：两个 Pipeline 实例同时读取同一 pending 行，断言只处理一次。

#### TASK-006：Pipeline `applyResult` 失败会被吞掉，handler 成功但状态未推进时仍记为成功

级别：`P2`

证据状态：`已证实代码路径`

代码证据：

- `processBatch` 中先 `const result = await handler(...)`，随后 `await this.applyResult(...)`。
- `applyResult` 内部 catch 所有 DB update 错误，只记录 logger.error，不向上抛。
- `processBatch` 后续仍会 `stats.succeeded++` 或 `stats.failed++`，并调用 `onItemComplete`。
- 如果成功结果的 updateById 失败，行状态仍停留在 fromStatus，下轮 poll 会再次处理；但外部回调和 stats 已认为完成。

影响场景：

- DuckDB 短暂失败、dataset 队列冲突、行被删除、字段不存在、schema 被修改。

风险：

- 重复处理同一行，造成外部副作用重复。
- pipeline 统计和真实 DB 状态不一致。
- 失败难以从回调层发现。

建议修复方向：

- `applyResult` 应返回 boolean 或抛出；状态回写失败应进入 error path 或至少不计为成功。
- 对成功 handler 但状态回写失败的行，写入单独的 error artifact 或 status。
- 增加测试：updateById reject 时不调用 onItemComplete，stats 不记成功，错误可被 onItemError 捕获。

#### TASK-007：旧 `TaskPersistenceService` 仅有持久化 facade，未看到恢复执行器接线，容易形成误用

级别：`P3`

证据状态：`待确认产品语义`

代码证据：

- `TaskPersistenceService` 提供 `saveTask/updateTaskStatus/loadUnfinishedTasks/cleanupOldTasks`。
- `DuckDBService` 继续暴露这些代理方法。
- 全局搜索未看到生产代码调用 `loadUnfinishedTasks` 恢复任务执行，主要是集成测试和 service facade contract 使用。
- 该 service 与 `ScheduledTaskService` 并存，名称都带 task，职责容易混淆。

影响场景：

- 新功能误以为 `TaskPersistenceService.loadUnfinishedTasks` 会被系统自动恢复。
- 后续维护者在两个任务持久层之间选错入口。

风险：

- 写入 `tasks` 表的后台任务可能永远不会被执行或恢复。
- 任务系统审计和测试范围被误导。

建议修复方向：

- 明确标注 legacy/unused/internal，或接入真正 runner。
- 如果保留，应在 docs 和类型名中区分 `WorkflowTaskPersistenceService` 与 `ScheduledTaskService`。
- 增加架构守护测试或注释，说明哪些 task 表参与运行时恢复。

### 9.5 待继续核查点

- `SchedulerService.onTimerFired` 对 `executeTask` 返回 failed/cancelled 但不 throw 的常规路径会继续 reschedule；需要 targeted test 钉住异常路径。
- `SchedulerService.pauseTask/cancelTask/deleteTasksByPlugin/dispose` 是否应等待 handler settle，涉及用户体验和退出速度，需要产品语义确认。
- `resourceCoordinator` 本身具备 sorted key 和 waiter timeout/cancel；还需要联查 profile helper 是否正确使用 current context/handoff。
- Pipeline 目前没有被生产代码明显引用，可能是 SDK/插件能力预留；如果要正式暴露，需要先补 claiming 和 update failure 语义。

### 9.6 当前测试覆盖观察

已看到的覆盖：

- `queue.test.ts` 覆盖基础执行、取消、统计、进度、事件、重试、超时、并发、暂停/恢复、clear、stop、边界输入。
- `task-queue.test.ts` 覆盖插件 namespace 创建、数量限制、stopAll、runtime registry active queue/running task 计数。
- `pipeline.test.ts` 覆盖 start/pause/resume/stop、状态更新、handler/query 错误、安全字段/orderBy、multiple fromStatus、多阶段并行。
- `scheduler.test.ts` 覆盖 core Scheduler facade 创建、所有权检查、pause/resume/cancel/trigger/list/history、dispose。
- `scheduler-service.test.ts` 覆盖 cleanup timer、同任务互斥、不同任务并行、重试、超时取消、handler 注册/注销、统计更新、事件。
- `scheduler-resource.test.ts` 覆盖 resource key 串行、不同 key 并行和 resource wait timeout。
- `scheduler-handler.test.ts` 覆盖 IPC routes 的成功/失败返回。

初步缺口：

- 单个 pending task cancel 后不执行用户 task 的测试缺失。
- timer fired 中 `executeTask` 抛出后仍 reschedule/disable 的测试缺失。
- pause/cancel/delete/dispose running task 后迟到 handler 与 DB/资源交错测试缺失。
- 启动恢复 stale `task_executions.running/pending` 的测试缺失。
- Pipeline 并发实例 claiming 测试缺失。
- Pipeline result 回写失败的可观测错误/状态语义测试缺失。

## 10. 模块七：配置、存储、启动和升级系统

状态：`待复核`

### 10.1 审计范围

第一轮已覆盖：

- DuckDB 初始化、WAL 恢复和 system tables：`src/main/duckdb/service.ts`
- schema migration 框架和迁移清单：`src/main/duckdb/migration-engine.ts`、`src/main/duckdb/schema-migrations.ts`
- profile/account/saved site/tag/dataset/extension packages/scheduled task 等表初始化入口。
- 插件表 bootstrap：`src/main/duckdb/plugin-table-bootstrap.ts`
- profile schema bootstrap：`src/main/duckdb/profile-schema-bootstrap.ts`
- electron-store/localStorage 配置：`src/renderer/src/stores/uiStore.ts`、`src/core/cloud-auth-store.ts`、`src/main/profile/browser-runtime-store.ts`
- runtime 配置 SSOT：`src/constants/runtime-config.ts`
- App shell config：`src/shared/app-shell-config.ts`、`src/main/app-shell-config.ts`
- HTTP API config guard：`src/main/http-api-config-guard.ts`
- 扩展包仓库和绑定：`src/main/profile/extension-packages-manager.ts`、`src/main/duckdb/extension-packages-service.ts`、`src/main/profile/extension-package-file-utils.ts`
- updater：`src/main/updater.ts`、`src/main/ipc-handlers/updater-handler.ts`、`src/main/index.ts`
- build stamp/freshness/package scripts：`src/main/main-build-stamp.ts`、`src/main/main-build-freshness.ts`、`src/main/renderer-build-freshness.ts`、`scripts/build-main-with-stamp.js`、`scripts/package-electron.js`
- 相关测试：`migration-engine.test.ts`、`dev-schema-bootstrap.test.ts`、`extension-packages-service.test.ts`、`extension-packages-ipc-handler.test.ts`、`updater.test.ts`、`updater-handler.test.ts`、启动/关闭 bootstrap tests。

### 10.2 入口和核心流程

已确认的配置、存储、启动和升级入口：

- 应用启动：`app.whenReady()` -> `runAppReadyBootstrap` -> services/plugins/window/ipc/updater/http/browser control/resource monitoring。
- DuckDB 打开：`DuckDBService.initialize` -> `DuckDBInstance.create` -> service construction -> `initializeSystemTables`。
- WAL 恢复：DuckDB open 失败且命中 WAL replay/internal error -> 关闭 partial handles -> 移动 `.wal` 备份 -> reopen。
- schema 迁移：各 service `initTable` 创建基础表 -> `SchemaMigrationEngine.migrate` -> `runSchemaBackfills`。
- 插件表 bootstrap：`ensurePluginTables` 在 transaction 中建表、迁移和补字段。
- profile schema bootstrap：browser profile/account relation/account extension relation/group/extensions 等表初始化和修复。
- runtime 配置：`AIRPA_RUNTIME_CONFIG` 从 argv 和运行环境推导，不让 runtime code 散读 `process.env`。
- UI/local 配置：Zustand persist migration、electron-store normalization、app shell config 文件候选路径读取。
- 扩展包安装：本地目录/zip/cloud archive -> safe extract/copy -> extension_packages metadata upsert -> profile_extensions binding。
- 扩展包云同步：build cloud meta、download/inline restore、set profile bindings。
- 自动更新：`initializeUpdater` 生产环境构造 `UpdateManager` -> 注册 IPC -> 延迟首次 check -> 启动定时 check。
- 关闭：`createShutdownBootstrap` 依次 stop HTTP、dispose resource monitoring/scheduler、cleanup updater、stop browser pool、cleanup views/window、close DuckDB。

### 10.3 已验证的正向设计

#### CONFIG-OK-001：schema migration 有迁移表、checksum、防重复 ID 和幂等加列步骤

状态：`已证实`

证据：

- `SchemaMigrationEngine.ensureMigrationTable` 创建 `schema_migrations`，记录 `id/description/checksum/applied_at/rollback_sql`。
- `ensureUniqueIds` 在执行前拒绝重复 migration id。
- 已应用 migration 会校验 checksum，发现同 id 内容变化会抛错。
- `addColumnIfMissingStep` 先 `PRAGMA table_info` 检查列是否存在，再执行 `ALTER TABLE ... ADD COLUMN`。
- `migration-engine.test.ts` 覆盖新迁移、旧表补列、重复运行跳过和重复 ID 拒绝。

影响：

- 普通新增列迁移具备可重复启动能力，能避免大部分“升级后再次启动重复 ALTER”问题。

#### CONFIG-OK-002：DuckDB 打开失败时有 WAL replay 恢复路径

状态：`已证实`

证据：

- `DuckDBService.openDatabaseWithWalRecovery` 捕获 open 失败。
- `isWalReplayFailure` 命中 WAL replay/internal error 后，会关闭 partial connection/db。
- `backupCorruptWalFile` 将 `.wal` 移动到 `.corrupted.<timestamp>`，然后重新打开主数据库。
- 恢复成功后记录 `Database recovered after WAL replay failure; recent uncheckpointed changes may be lost`。
- `initializeSystemTables` 完成后执行 `checkpointDatabase`。

影响：

- 进程崩溃或 WAL 损坏时，应用有机会启动并给出诊断，而不是永久卡死在数据库 open 阶段。

#### CONFIG-OK-003：插件表 bootstrap 把建表、迁移和补字段包在 transaction 中

状态：`已证实`

证据：

- `ensurePluginTables` 通过 `runInDuckDbTransaction(conn, async () => { ... })` 包裹核心创建和迁移。
- 内部调用 `createPluginTables`、`SchemaMigrationEngine.migrate(PLUGIN_TABLE_SCHEMA_MIGRATIONS)`、`ensurePluginTableColumns`。
- index 创建被放在事务外并 warn-only，核心表结构失败会回滚。

影响：

- 插件系统的共享表升级比普通裸 migration 更稳，失败时不容易留下半建核心表。

#### CONFIG-OK-004：profile schema bootstrap 包含旧数据修复和默认 profile 保障

状态：`已证实`

证据：

- `ProfileSchemaBootstrap.initTable` 创建 browser profiles、accounts、relations、profile groups、profile extensions/global config 等表。
- `ensureBrowserProfilesLatestSchema` 执行 runtime/quota/timeout/is_system/fingerprint split 等迁移和 backfill。
- `removeInvalidStoredProfiles` 会识别不合法 profile，解绑账号、删除 profile extensions、删除 profile 记录，并尝试清理 partitions。
- `ensureSystemDefaultProfile` 保证系统默认 profile 存在。
- `dev-schema-bootstrap.test.ts` 覆盖旧 profile、saved sites、tag、account 等 schema 修复。

影响：

- 浏览器 profile 这类长期本地状态有启动修复意识，不是只依赖新表 schema。

#### CONFIG-OK-005：扩展包仓库 DB 层有 schema 初始化串行化和绑定前校验

状态：`已证实`

证据：

- `ExtensionPackagesService.ensureSchemaReady` 使用 `schemaInitPromise` 合并并发 initTable。
- `bindPackagesToProfiles` 在写绑定前调用 `ensureBindingsResolvable`，版本绑定必须存在且 enabled；latest 绑定必须能解析到 enabled package。
- `setProfileBindings`、`bindPackagesToProfiles`、`unbindExtensionsFromProfiles` 通过 `runInTransaction` 包裹批量写。
- `extension-packages-service.test.ts` 覆盖缺失版本拒绝写 dangling binding、批量绑定失败 rollback、replace binding rollback、legacy table migration。

影响：

- profile extension binding 不会轻易写入完全不存在的扩展包引用。

#### CONFIG-OK-006：扩展包文件导入包含 ZIP 安全检查、hash 校验和 base64 校验

状态：`已证实`

证据：

- `safeExtractZip` 调用 `assertSafeZipMetadata` 和 `assertSafeZipEntryPath`，逐 entry 写入目标目录。
- cloud download/inline/archive path 均计算 sha256；传入 `archiveSha256` 时必须匹配。
- `decodeBase64Archive` 去空白后校验 base64 字符集和解码长度。
- `resolveExtensionId` 会标准化 extension id；manifest key 可派生 Chrome extension id，缺 key 时用 manifest 内容 hash fallback。

影响：

- 扩展包安装不是裸解压，对 zip-slip、空包、hash 错误和 id 格式有基础防护。

#### CONFIG-OK-007：updater 对配置缺失、网络/鉴权错误和敏感信息有用户态处理

状态：`已证实`

证据：

- `UpdateManager` 通过 `resolveUpdateConfigPath` 和 `fs.existsSync` 判断 `app-update.yml` 是否存在。
- `checkForUpdates/downloadUpdate` 在配置缺失时抛出中文用户提示。
- `getUserFacingUpdateErrorMessage` 对 404、401/403、network、download 等错误做归类。
- `sanitizeUpdaterDiagnosticText`/`buildUpdateErrorLogContext` 避免把 headers、token、cookie、release feed URL 等敏感内容送到 renderer。
- `updater.test.ts` 覆盖缺失 config、已有 config、GitHub feed 错误脱敏。
- `updater-handler.test.ts` 覆盖 IPC 成功和失败结构化返回。

影响：

- 自动更新失败时能给用户明确提示，并避免泄露更新源细节。

#### CONFIG-OK-008：构建新鲜度和打包脚本已有防陈旧产物机制

状态：`已证实`

证据：

- `main-build-stamp.ts` 定义 main build stamp schema，记录 builtAt、gitCommit、entryPointUpdatedAt。
- `isMainBuildStampAligned` 用 entry point mtime 和 stamp 对齐校验。
- `main-build-freshness.ts`、`renderer-build-freshness.ts` 已纳入启动诊断和健康链路。
- `scripts/package-electron.js` 在 electron-builder 后比较并恢复 `package.json`，避免打包工具修改工作树残留。

影响：

- 开发/打包时能识别 dist/main 或 renderer 产物陈旧，降低“以旧代码运行”的诊断成本。

### 10.4 已发现问题

#### CONFIG-001：通用 SchemaMigrationEngine 不包事务，迁移和 backfill 可能部分成功后未被记录

级别：`P2`

证据状态：`已证实代码路径，待故障注入测试`

代码证据：

- `SchemaMigrationEngine.migrate` 对每个 migration 逐 step 执行，最后再插入 `schema_migrations` 记录。
- `migrate` 自身没有 `BEGIN/COMMIT/ROLLBACK`。
- `runSchemaBackfills` 在 migration 之后逐条 `conn.run(statement)`，也没有统一 transaction。
- `account-service`、`saved-site-service`、`tag-service`、`dataset-metadata-service`、`scheduled-task-service`、`extension-packages-service`、`profile-schema-bootstrap` 等多处直接调用 `new SchemaMigrationEngine(this.conn).migrate(...)` + `runSchemaBackfills(...)`。
- 插件表 bootstrap 是例外，它把 migration 放进 `runInDuckDbTransaction`。

影响场景：

- 启动升级时某个 migration 的前几个 add column 成功，但后续 step、backfill 或 `schema_migrations` 插入失败。
- 下一次启动重复执行同一个未记录 migration。
- 当前迁移多为 `addColumnIfMissingStep`，重复加列风险被降低，但 raw SQL step 或 backfill 仍可能出现半升级状态。

风险：

- 部分表结构或数据修复已经生效，但迁移记录缺失，后续恢复语义依赖每个 step/backfill 都天然幂等。
- 未来新增复杂 migration 时容易踩到“开发时测试通过，用户旧库升级中断后无法恢复”的问题。

建议修复方向：

- 为 `SchemaMigrationEngine.migrate` 增加可选 transaction 模式，或者默认每个 migration 包事务。
- migration + 对应 backfill 应作为同一升级单元记录，至少高风险 service 要包 `runInDuckDbTransaction`。
- 增加故障注入测试：第二个 step 或 migration record insert 抛错后，重启再次 migrate 的行为必须明确且可恢复。

#### CONFIG-002：扩展包安装先删除/覆盖目标目录，再更新 DB metadata，跨文件系统和数据库不具备原子性

级别：`P1`

证据状态：`已证实代码路径，待故障注入测试`

代码证据：

- `ExtensionPackagesManager.importFromArchivePath` 解包到 temp 后，计算 `targetDir`，执行 `fs.remove(targetDir)`、`fs.ensureDir(dirname)`、`fs.copy(payload.manifestRootDir, targetDir)`，随后返回待 upsert 参数。
- `importFromDirectory` 同样先 `fs.remove(targetDir)` 再 `fs.copy(...)`。
- 调用方 `importFromLocalPath/importCloudArchiveFromPath/installCloudArchiveBuffer` 在文件复制完成后才调用 `extensionService.upsertPackage(...)`。
- 如果复制成功但 DB upsert 失败，文件系统已替换；如果删除旧目录后复制失败，旧版本文件已丢。
- `extension-packages-service.test.ts` 主要覆盖 DB transaction 和 legacy migration，未看到文件替换失败/DB upsert 失败补偿测试。

影响场景：

- 用户更新同一 extensionId/version 的本地扩展或云扩展。
- 磁盘不足、权限错误、杀进程、DuckDB upsert 失败、manifest 读取后 copy 失败。

风险：

- DB 仍指向旧 package metadata，但文件目录已经被新版本或半拷贝内容替换。
- 运行中的 profile 解析扩展目录时发现 manifest/资源缺失。
- 同步或导出扩展包时打包的是和 metadata 不一致的目录。

建议修复方向：

- 采用 staging dir + atomic rename：先复制到 `targetDir.__staging__`，校验 manifest/hash 后再 rename。
- 替换已有目录时先 move 到 backup，DB upsert 成功后删除 backup；失败时恢复 backup。
- 把文件安装和 DB upsert 组合成 coordinator，返回明确的 compensation 结果。
- 增加测试：copy 失败保留旧目录；upsert 失败恢复旧目录；进程中断后启动 repair 能识别 staging/backup。

#### CONFIG-003：扩展包删除/清理先删 DB metadata 再删目录，失败会留下不可追踪文件或半清理状态

级别：`P2`

证据状态：`已证实代码路径，待故障注入测试`

代码证据：

- `unbindExtensionsFromProfiles(... removePackageWhenUnused)` 中，refCount 为 0 后先 `extensionService.removePackagesByExtensionIds([extensionId])`，再 `fs.remove(path.join(this.getPackagesDir(), extensionId))`。
- `pruneUnusedPackagesByExtensionIds` 同样先删除 DB package 记录，再删除扩展目录。
- `removePackagesByExtensionIds` 本身会先查询 removedPackages，再 `DELETE FROM extension_packages`，但没有和文件删除形成补偿。
- 如果 `fs.remove` 失败，DB 已不知道这些 package；如果进程在 DB delete 后退出，目录会长期残留。

影响场景：

- 用户解绑并选择“未使用时删除扩展包”。
- 清理云端/本地扩展包时目录被占用、权限不足或磁盘异常。

风险：

- userData 下 extension package 目录残留，后续 listPackages 不可见，用户无法通过 UI 清理。
- 重新安装同 extensionId/version 时可能遇到旧目录残留或被覆盖风险。

建议修复方向：

- 删除操作改为 two-phase：先标记 package deleting 或 move 到 trash/staging，再 DB 删除，最后后台清理。
- `fs.remove` 失败时保留 DB metadata 并标记 cleanupFailed，或至少写 runtime observation/health issue。
- 启动时扫描 packages dir 与 DB metadata，识别 orphan dir 并提供 repair/prune。

#### CONFIG-004：无版本绑定的扩展包 “latest” 按 updated_at 选择，不按语义版本选择

级别：`P2`

证据状态：`已证实代码路径，待产品语义确认`

代码证据：

- `ExtensionPackagesService.getLatestEnabledPackageByExtensionId` 查询 `WHERE extension_id=? AND enabled=TRUE ORDER BY updated_at DESC, created_at DESC LIMIT 1`。
- `ensureBindingsResolvable`、`resolveLaunchExtensions`、`buildCloudMetaForProfile`、`applyCloudMetaToProfile` 在 binding.version 为空时都会调用该方法。
- `ExtensionPackagesManager.bindPackagesToProfiles` 允许 `version` 为空，表示 latest。
- 当前未看到 semver 排序或“latest=最近导入版本”的文档化说明。

影响场景：

- 用户先导入 `2.0.0`，后又导入/修复 `1.5.0`。
- cloud restore 未指定 version，或 profile binding 使用 latest。

风险：

- profile 实际加载“最近更新时间”的包，而不是用户通常理解的最高版本。
- 回滚旧版本、重装旧版本、修复旧版本文件时可能意外改变 latest binding 的运行结果。

建议修复方向：

- 明确 latest 语义：如果是“最高 semver”，查询时按 semver 排序或维护 resolved version；如果是“最近导入”，UI/metadata 应显示为 current/recent 而不是 latest。
- 对 profile binding 建议写入明确 version，减少运行时漂移。
- 增加测试：同 extensionId 多版本导入顺序和 latest 解析符合产品语义。

#### CONFIG-005：updater 定时检查 fire-and-forget，失败 promise 未 catch

级别：`P2`

证据状态：`已证实代码路径，待测试复现`

代码证据：

- `UpdateManager.startPeriodicCheck` 中 `setInterval(() => { this.logger.info(...); this.checkForUpdates(); }, intervalMs)`。
- `checkForUpdates` 会在配置缺失、网络失败、autoUpdater 抛错时 reject。
- `initializeUpdater` 的首次延迟 check 使用 `.catch(...)` 记录错误，但后续 periodic check 没有 catch。
- `updater.test.ts` 覆盖手动 check 的 reject 和事件脱敏，未看到 periodic reject 不产生 unhandled rejection 的测试。

影响场景：

- 生产环境网络断开、更新源 404、GitHub 限流、临时 DNS/TLS 失败。

风险：

- Node/Electron 进程可能产生 unhandled rejection，取决于运行时策略可能导致控制台噪声、诊断误报，甚至未来 Node 策略变化下影响进程稳定性。
- 定时检查失败没有一条明确的 periodic context 日志。

建议修复方向：

- 在 interval callback 内 `void this.checkForUpdates().catch(...)`。
- 错误日志加 `source: 'periodic'`，并避免重复刷屏，可加节流。
- 增加 fake timer 测试：mock check reject 后不触发 unhandledRejection，logger.error 被调用。

#### CONFIG-006：UpdateManager cleanup 只停止定时器，不解绑 autoUpdater 事件

级别：`P2`

证据状态：`已证实代码路径，待 lifecycle 测试`

代码证据：

- `UpdateManager.setupAutoUpdater` 每次构造都会调用 `registerEvents`，向全局 `autoUpdater` 注册 checking/update/error/download 等 listener。
- `cleanup()` 只调用 `stopPeriodicCheck()` 并记录日志。
- 未看到保存 listener 引用并 `off/removeListener` 的逻辑。
- `updater.test.ts` 在 `beforeEach` 用 mock `removeAllListeners` 清理测试环境，但这不是生产 cleanup 行为。

影响场景：

- 未来支持窗口重建、热重载、测试重复初始化、生产异常后重新创建 UpdateManager。
- shutdown cleanup 后某些 autoUpdater 事件迟到触发。

风险：

- renderer 收到重复 `updater:*` 消息，日志重复写入。
- 旧 mainWindow 引用被 listener 捕获，窗口销毁后仍参与事件判断，增加生命周期噪声。

建议修复方向：

- `registerEvents` 保存 listener 函数，`cleanup` 中逐一 `autoUpdater.off/removeListener`。
- cleanup 后将 `mainWindow` 引用释放或加 disposed guard。
- 增加测试：构造两个 manager 并 cleanup 第一个，emit error 时只通知当前 manager/window。

#### CONFIG-007：runtime argv 配置在模块加载时固化，运行中修改 argv 或测试切换不会刷新全局配置

级别：`P3`

证据状态：`已证实代码路径，待确认是否符合设计`

代码证据：

- `runtime-config.ts` 在模块顶层计算 `const runtimeMode = detectRuntimeMode()`，并导出常量 `AIRPA_RUNTIME_CONFIG`。
- `AIRPA_RUNTIME_CONFIG.http.port`、`enableHttpOverride`、`paths.*`、`extension.allowNoSandbox` 等也在模块加载时读取 argv 固化。
- 文件底部的 `resolveUserDataDir/resolveAsarExtractBaseDir/resolveFirefoxExecutablePathOverride` 会重新读取 argv，但很多调用方直接使用 `AIRPA_RUNTIME_CONFIG`。

影响场景：

- 测试进程内多次修改 `process.argv` 后复用模块。
- 未来如果支持运行中修改 HTTP port 或 runtime 开关，旧常量不会刷新。

风险：

- 配置行为在测试/开发环境中容易受模块缓存影响，出现“为什么参数改了没生效”的问题。
- 生产影响较低，因为 argv 正常只在启动前确定。

建议修复方向：

- 保持启动时固化也可以，但需要文档化 “runtime config is startup-only”。
- 测试中提供 `createRuntimeConfig(argv/env)` 纯函数，减少对模块缓存的依赖。
- 对确实需要动态读取的路径统一走 resolver，不混用顶层常量和实时函数。

### 10.5 待继续核查点

- `SchemaMigrationEngine` 是否应默认事务化，需要结合 DuckDB DDL transaction 行为做 targeted integration test。
- `profile-schema-bootstrap.removeInvalidStoredProfiles` 删除 profile 后清理 partition 目录/表失败时的 orphan repair 策略还需补测。
- `electron-store` 文件损坏时 electron-store 本身如何恢复；当前代码多是读取后 normalize，但不是所有 store 都有损坏 JSON 的应用级兜底。
- `AppShellConfig` 候选文件读取失败只 warn 并继续，这是合理容错；仍需确认多候选路径优先级是否符合发布包和用户配置预期。
- build freshness 目前主要诊断陈旧产物，是否在生产启动时阻断陈旧/错配产物需要结合发布策略确认。

### 10.6 当前测试覆盖观察

已看到的覆盖：

- `migration-engine.test.ts` 覆盖基础 migration、重复运行、rollback metadata、重复 ID。
- `dev-schema-bootstrap.test.ts` 覆盖旧 schema 修复和数据迁移。
- `extension-packages-service.test.ts` 覆盖 extension package DB schema、binding transaction、legacy migration。
- `extension-packages-ipc-handler.test.ts` 覆盖 profile runtime gate、restart failure 返回、partial import result。
- `updater.test.ts` 覆盖 update config 缺失、配置存在、更新错误脱敏。
- `updater-handler.test.ts` 覆盖 updater IPC 成功/失败返回。
- 启动/关闭 bootstrap tests 覆盖阶段执行、失败处理和 shutdown timeout 的部分行为。

初步缺口：

- migration/backfill 中途失败后的重启恢复测试不足。
- extension package 文件替换与 DB upsert 跨介质失败补偿测试不足。
- extension package 删除 DB 成功但 fs remove 失败后的 orphan repair 测试不足。
- latest 扩展版本解析语义缺少测试。
- updater periodic check reject 不产生 unhandled rejection 的测试不足。
- UpdateManager cleanup 解绑 autoUpdater listener 的测试不足。
- runtime config startup-only 语义缺少纯函数单测或架构说明。

## 11. 九个横向主题复盘

状态：`已完成第一轮统一复盘`

### 11.1 架构边界

横向结论：

- 数据工作台、浏览器池、插件系统、HTTP/MCP、观测健康、Scheduler、配置升级都已经拆出较清楚的 service/coordinator/handler 层，整体不是无边界堆叠。
- 当前最大问题不是“没有分层”，而是少数关键能力绕过了所属边界：`importRecordsFromFile` 绕过 dataset queue，GlobalPool lock timeout 绕过 BrowserPoolManager wait queue，HTTP/MCP timeout 绕过真实取消边界，Scheduler cancel/delete 绕过 running handler settle 边界。
- 跨介质逻辑单元还缺少统一 owner：插件安装涉及文件、metadata、folder、dataTables、UI；扩展包安装涉及文件目录和 DuckDB metadata；数据集涉及物理表和主 metadata。
- 任务模块需要进一步命名和文档化三套模型：内存 `TaskQueue`、数据行驱动 `Pipeline`、持久化 `SchedulerService`，避免未来误把旧 `TaskPersistenceService` 当作生产 runner。

优先关联问题：

- DATA-001、BROWSER-002、BROWSER-003、PLUGIN-002、PLUGIN-004、HTTP-001、TASK-003、CONFIG-001、CONFIG-002。

### 11.2 数据安全与一致性

横向结论：

- 正向基础：同 dataset queue、多处 DuckDB transaction、插件表 bootstrap transaction、扩展包 binding transaction、Scheduler execution history、requestId owner guard 都是有效一致性设计。
- 高风险裂缝集中在跨数据库/文件系统/进程资源边界：dataset 物理表和 metadata、插件目录和 `js_plugins`、扩展包目录和 `extension_packages`、浏览器锁和 wait queue、Scheduler running handler 和 DB 状态。
- 多个模块都有“失败后继续、只 warn、不补偿”的局部容错，这对用户体验友好，但在删除、升级、导出、schema 变更、扩展包替换这类不可逆流程中会放大一致性风险。
- Pipeline 没有 claiming、Scheduler 启动不修复 stale execution、runtime observation 无 retention，这些会让持久状态在长时间运行后漂移。

优先修复方向：

- 为跨介质写入建立 staging/backup/repair 机制。
- 对状态驱动后台任务增加 claiming 和 stale recovery。
- 对删除/导出/schema 变更增加故障注入测试，而不是只测 happy path。

### 11.3 插件系统稳定性

横向结论：

- 插件系统的 manifest 校验、路径校验、helper contract、lifecycle dispose、runtime registry、数据表兼容检查都较完整。
- 稳定性短板集中在生命周期边缘：command-only 插件早退、首次安装补偿不足、激活失败时 context/helpers map 删除前未 dispose、插件表创建非事务、热重载 watcher/DB 状态非原子、命令执行和 deactivate/reload 缺少 in-flight 协调。
- 插件 helper 触达 data/browser/task/scheduler/profile/storage 等多个模块，任何一个 helper 的取消和释放语义不严，都会通过插件放大成跨模块稳定性问题。

优先关联问题：

- PLUGIN-001 至 PLUGIN-009，尤其 PLUGIN-001、PLUGIN-002、PLUGIN-003、PLUGIN-004、PLUGIN-009。

### 11.4 浏览器自动化可靠性

横向结论：

- 浏览器自动化的运行时抽象、等待队列、优先级、防饥饿、requestId owner guard、factory timeout cleanup、Extension/Ruyi/Cloak 多 runtime 接入都已经有较好的骨架。
- 可靠性短板集中在非正常释放和 runtime 差异：未初始化 acquire 被误报 timeout、lock timeout/releaseByPlugin 不唤醒等待者、reset 失败仍交接、Cloak abort/download 失败语义不完整。
- 浏览器池是 HTTP/MCP、插件、Scheduler、profile UI 的共同底层资源，因此释放、续租、销毁、等待队列唤醒必须有单一状态机，不能由底层 pool 私自改变锁状态。

优先关联问题：

- BROWSER-001 至 BROWSER-007，尤其 BROWSER-001、BROWSER-002、BROWSER-003、BROWSER-004。

### 11.5 API/MCP 合约质量

横向结论：

- HTTP/MCP 模块具备 route registry、session manager、MCP transport、trace meta、health endpoint、auth config guard、idempotency store 等基础，合约意识较强。
- 主要风险是合约里的 timeout/cancel 与真实底层任务生命周期不一致：`Promise.race` 对外返回 timeout 后，原任务可能继续持有 browser/session/plugin 资源。
- MCP batch initialize、server start idempotency、stop cleanup 异常、自定义 idempotency namespace 生命周期都需要协议级测试固化。
- 对 Agent/CLI/编排客户端来说，最重要的不是“返回了错误”，而是错误之后 session 是否仍干净、资源是否释放、下一次调用是否可信。

优先关联问题：

- HTTP-001 至 HTTP-006，尤其 HTTP-001、HTTP-002、HTTP-003。

### 11.6 错误处理与可观测性

横向结论：

- 项目已有结构化 logger、runtime observation、trace summary、failure bundle、startup log、shutdown result、updater 脱敏错误、browser acquire diagnostics，这些是很好的可诊断基础。
- 当前不足集中在“错误表达不等于真实根因”：未初始化 pool 表现为 acquire timeout，Cloak saveAs 失败表现为 download wait timeout，HTTP/MCP timeout 掩盖后台任务仍运行，Scheduler timer 链断裂缺少恢复提示。
- observation 写入目前偏同步和无限增长；runtime JSON 损坏、sink 慢写、保留策略、生产 WebContentsView artifact 都需要补齐。
- 失败包和健康检查应覆盖跨介质一致性问题，例如 dataset metadata/table 分裂、extension package DB/file 分裂、plugin install 残留。

优先关联问题：

- DEBUG-001 至 DEBUG-007、HTTP-001、BROWSER-001、BROWSER-006、TASK-002、TASK-004、CONFIG-005。

### 11.7 测试覆盖

横向结论：

- 当前测试数量不少，且不是只测 UI：dataset service/integration、browser pool/wait queue/runtime、plugin helper contracts、HTTP/MCP transport、startup/shutdown bootstrap、Scheduler/resource、extension packages/updater 都已有测试。
- 缺口有共同模式：失败注入不足、跨 service 组合不足、跨介质补偿不足、取消/超时后的迟到副作用不足、真实 runtime 差异不足。
- 后续测试应围绕已记录问题做 targeted tests，不建议先追求大而全的端到端测试；关键是把最容易破坏状态机的边缘条件钉住。

第一批 targeted tests：

- DATA-001、DATA-002、DATA-004。
- BROWSER-001、BROWSER-002、BROWSER-003、BROWSER-004。
- PLUGIN-001、PLUGIN-002、PLUGIN-003、PLUGIN-004、PLUGIN-009。
- HTTP-001、HTTP-002、HTTP-003。
- DEBUG-001、DEBUG-002、DEBUG-003、DEBUG-007。
- TASK-001、TASK-002、TASK-003、TASK-004、TASK-005、TASK-006。
- CONFIG-001、CONFIG-002、CONFIG-003、CONFIG-005、CONFIG-006。

### 11.8 依赖与供应链

横向结论：

- `package.json` 已把 `verify:supply-chain`、`sbom`、`verify:open-source-boundary` 纳入 `verify:ci`，说明供应链和开源边界不是事后手工步骤。
- `scripts/verify-supply-chain.js` 校验 package-lock 中 resolved source、integrity metadata、allowed host、allowed git source、copyleft review list。
- `scripts/supply-chain-policy.json` 限定 registry host，固定 `xlsx` 的 CDN tarball URL，并记录已审 copyleft 包。
- `scripts/generate-sbom.js` 生成 CycloneDX 1.5 SBOM。
- `scripts/open-source-boundary.js` 和 `open-source-manifest.json` 会检查开源包 include/exclude、required scripts、forbidden path/marker、npm pack 是否包含 build output。

剩余风险：

- 供应链脚本没有替代漏洞扫描、签名验证、native binary 运行时验证；`@duckdb/node-api`、`sharp`、`onnxruntime-node`、`hnswlib-node`、`koffi`、Electron、Playwright/Cloak 等 native/浏览器相关依赖仍需要平台级验证。
- `xlsx` 来自允许的外部 tarball URL，策略已固定来源，但仍应在发布前确认可用性、license 和 hash/integrity。
- 本轮未运行 `npm audit` 或第三方 CVE 扫描，不能据此声明依赖无已知漏洞。

建议发布门禁：

- `npm ci` 后运行 `npm run verify:supply-chain`、`npm run sbom`、`npm run verify:open-source-boundary`。
- 对 native/browser 依赖补平台 smoke test：Windows x64 至少覆盖 DuckDB open、sharp load、OCR/ONNX 可加载、browser runtime probe。

### 11.9 发布与升级

横向结论：

- 发布链路已有 `build:open`、`package:open:*`、build stamp、main/renderer freshness、updater config missing guard、package-electron 恢复 `package.json`、open-source boundary。
- updater 的用户提示和脱敏处理较好；缺口是 periodic check 未 catch、cleanup 不解绑 listener。
- schema migration 已有 checksum 和 migration table；缺口是事务化和 migration/backfill 组合恢复。
- 扩展包和插件安装都有升级/替换逻辑；缺口是首次安装和扩展包文件/metadata 的跨介质补偿。
- runtime config 以启动参数为准，适合发布启动期配置，但需要文档化 startup-only，避免测试和未来动态配置误用。

建议发布前硬门禁：

- `npm run verify:ci`。
- 旧库升级 smoke：至少覆盖 profile/account/tag/saved site/dataset metadata/extension packages/schema_migrations。
- 扩展包升级 smoke：同 extensionId/version 替换、失败回滚、orphan scan。
- updater smoke：缺失 `app-update.yml`、更新源不可达、periodic check failure、cleanup 后事件不重复。
- 打包产物 smoke：`main-build-freshness`、`renderer-build-freshness`、启动诊断无 stale dist 警告。

## 12. 最终审计状态和修复路线

### 12.1 当前状态

- 七个纵向模块均已完成第一轮深入代码审计和文档标记。
- 九个横向主题均已完成统一复盘。
- 当前模块状态保持 `待复核`，原因是本轮主要完成代码证据审计；风险点仍需要 targeted tests、故障注入和修复验证后才能标记为 `已完成`。
- 本轮未发现明确 P0；P1/P2 风险集中在一致性、取消/超时、资源释放、跨介质补偿和启动/升级恢复。

### 12.2 第一批 P1 修复路线

建议先处理会导致用户主流程失败、资源泄漏或状态污染的问题：

1. 数据一致性：DATA-001、DATA-002、DATA-004。
2. 浏览器池资源调度：BROWSER-001、BROWSER-002、BROWSER-003。
3. 插件生命周期和安装补偿：PLUGIN-001、PLUGIN-002、PLUGIN-003、PLUGIN-004、PLUGIN-009。
4. HTTP/MCP 真实取消语义：HTTP-001。
5. 启动超时后台副作用：DEBUG-001。
6. Scheduler/TaskQueue 取消和调度：TASK-001、TASK-002、TASK-003。
7. 扩展包安装跨介质一致性：CONFIG-002。

### 12.3 第二批 P2 加固路线

完成第一批后，继续补齐边缘稳定性：

1. 导出临时文件、dataset 删除清理、row_count warn-only：DATA-003、DATA-005、DATA-006、DATA-007。
2. reset 失败、Cloak abort/download、跨 runtime contract：BROWSER-004、BROWSER-005、BROWSER-006、BROWSER-007。
3. HTTP server lifecycle、MCP batch、REST session/idempotency：HTTP-002 至 HTTP-006。
4. observation retention、JSON 容错、sink backpressure、failure bundle：DEBUG-002 至 DEBUG-007。
5. stale execution、Pipeline claiming/result write failure：TASK-004、TASK-005、TASK-006。
6. migration transaction、extension package prune/latest/updater cleanup/runtime config：CONFIG-001、CONFIG-003、CONFIG-004、CONFIG-005、CONFIG-006、CONFIG-007。

### 12.4 回归验证建议

- 每个风险先补一个最小失败测试，再修复，再保留回归测试。
- 跨介质一致性问题需要故障注入：DB write fail、fs copy/remove fail、进程中断、旧库升级。
- 取消/超时问题需要证明底层任务真的停止或被标记为 contaminated，不能只证明调用方拿到了 timeout。
- 浏览器和 native 依赖需要平台 smoke test，不要只依赖纯单元测试。
