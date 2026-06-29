# Tianshe 修复进度跟踪

基于 `tianshe-review/verified-repair-plan.md`

---

## P0: 资源安全与可复现运行时缺陷

### 3.1 修正 shutdown 清理顺序 ✅ 完成

- [x] 调整 `cleanupViewManager()` 早于 `stopBrowserPool()`
- [x] 增加阶段隔离（单步骤失败不阻断后续）
- [x] 更新测试断言
- [x] 增加错误传播测试
- [x] 验收通过（5 tests passed, typecheck passed）

**修改文件：**

- `src/main/bootstrap/shutdown-bootstrap.ts`: 引入 `safeStep` 辅助函数，每个清理步骤独立 try/catch；调整顺序使 `cleanupViewManager` 早于 `stopBrowserPool`
- `src/main/bootstrap/shutdown-bootstrap.test.ts`: 更新顺序断言；增加 `continues cleanup when a step throws` 和 `does not duplicate exit when shutdown is called multiple times` 测试

---

### 3.2 修复 DatasetStorage 队列失败传播 ✅ 完成

- [x] 修改队列链为 `.catch(() => undefined).then(...)`
- [x] 保留 `finally` 清理和竞态保护
- [x] 增加失败传播测试
- [x] 增加多 dataset 队列隔离测试
- [x] 验收通过（8 tests passed, dataset-query-service tests still pass）

**修改文件：**

- `src/main/duckdb/dataset-storage-service.ts`: 将 `executeWithQueue` 中 `previousPromise.then(() => operation())` 改为 `previousPromise.catch(() => undefined).then(() => operation())`，确保前序失败不跳过后续任务
- **新增** `src/main/duckdb/dataset-storage-service.test.ts`: 覆盖队列串行执行、失败传播、多 dataset 隔离、队列清理竞态保护

---

### 3.3 引入 DuckDB StatementExecutor ✅ 完成

- [x] 实现 `StatementExecutor` 封装（runPrepared/allPrepared/getPrepared）
- [x] 写单元测试（正常执行、bind 抛错、run/all 抛错）
- [x] 迁移第一批低耦合服务（log-service、task-persistence、automation-persistence）
- [x] 搜索验证：已迁移服务不再直接调用 `destroySync()`
- [x] 验收通过（9 tests passed, typecheck passed）

**新增文件：**

- `src/main/duckdb/statement-executor.ts`: 提供 `runPrepared`、`allPrepared`、`getPrepared`，内部统一 `try/finally { stmt.destroySync(); }`
- `src/main/duckdb/statement-executor.test.ts`: 覆盖正常执行释放、bind 抛错仍释放、run/all 抛错仍释放

**修改文件：**

- `src/main/duckdb/log-service.ts`: 全部 statement 操作迁移到封装函数
- `src/main/duckdb/task-persistence-service.ts`: 全部 statement 操作迁移到封装函数
- `src/main/duckdb/automation-persistence-service.ts`: 全部 statement 操作迁移到封装函数

**补充验收：** 当前 `src/main/duckdb` 非测试代码中，直接 `.destroySync()` 只剩 `src/main/duckdb/statement-executor.ts` 封装层；`src/main/sync` 的旧 statement 仪式已纳入 6.1 架构护栏基线，后续只能减少不能新增。

---

### 3.4 修复 CSV 转码背压 ✅ 完成

- [x] 改为 `for await...of` 模式
- [x] 封装 `writeWithBackpressure`
- [x] 错误路径销毁 stream 并删除临时文件
- [x] 增加背压测试（write true 直接返回、write false 等待 drain、error 传播）
- [x] 验收通过（3 tests passed, typecheck passed）

**修改文件：**

- `src/main/duckdb/import-worker.ts`:
  - 提取 `writeWithBackpressure` 模块级函数
  - `transcodeCsvToUtf8` 改为 `for await...of` + `writeWithBackpressure`
  - 错误路径 `destroy()` 两个 stream 并删除临时文件
  - 用 `if (workerData)` 包装入口调用，避免测试导入时的副作用
- **新增** `src/main/duckdb/import-worker.test.ts`: 覆盖背压三种场景

---

### 3.5 扩展 unknown error 与脱敏辅助函数 ✅ 完成

- [x] 扩展 `handleIPCError`（集成 `redactSensitiveText`）
- [x] 增加 `getUnknownErrorMessage`
- [x] 增加 `createIPCErrorResult`（区分用户可见/内部日志）
- [x] 将 `catch (error: any)` 改为 `catch (error: unknown)`（file-storage 5 处 + log-service 1 处 + import-worker 1 处 + ipc-utils 内部 1 处）
- [x] 写单元测试覆盖所有辅助函数
- [x] 验收通过（11 tests passed, typecheck passed）

**修改文件：**

- `src/main/ipc-utils.ts`: 新增 `getUnknownErrorMessage`、`createIPCErrorResult`；`handleIPCError` 集成脱敏
- `src/main/file-storage.ts`: 5 处 `catch (error: any)` → `catch (error: unknown)`，使用 `getUnknownErrorMessage`
- `src/main/duckdb/log-service.ts`: 1 处迁移到 `unknown` + `getUnknownErrorMessage`
- `src/main/duckdb/import-worker.ts`: 1 处迁移到 `unknown` + `getUnknownErrorMessage`

**新增文件：**

- `src/main/ipc-utils.test.ts`: 覆盖 `getUnknownErrorMessage`（Error/字符串/对象/null/undefined/number）、`handleIPCError`（含脱敏）、`createIPCErrorResult`（用户消息+日志上下文）

**补充验收：** 当前 `src/main` 非测试代码中已无 `catch (error: any)` 命中。

---

## P0 总结

| 任务                    | 状态    | 测试         | 修改文件数 | 新增文件数 |
| ----------------------- | ------- | ------------ | ---------- | ---------- |
| 3.1 shutdown 顺序       | ✅      | 5 passed     | 2          | 0          |
| 3.2 DatasetStorage 队列 | ✅      | 8 passed     | 2          | 1          |
| 3.3 StatementExecutor   | ✅      | 9 passed     | 4          | 2          |
| 3.4 CSV 背压            | ✅      | 3 passed     | 1          | 1          |
| 3.5 unknown error       | ✅      | 11 passed    | 4          | 1          |
| **合计**                | **5/5** | **36 tests** | **13**     | **5**      |

全部 P0 任务已完成，所有变更通过类型检查，无回归测试失败。

---

## P1: 架构边界和扩展点

（进行中）

### 4.1 清理 `core→main` 反向依赖

#### A 类运行时导入 — 已清理 ✅

- [x] `profile.ts`: `generateVariant`/`applyPreset` 下沉到 `constants/fingerprint-defaults.ts`
- [x] `window.ts`: `getDefaultFingerprint` 改为从 `constants/fingerprint-defaults.ts` 导入
- [x] `window.ts`: `maybeOpenInternalBrowserDevTools` 改为 port 模式（通过 `InternalDevToolsOpener` 回调注入）
- [x] `extension-browser.lifecycle.test.ts`: `sendWindowsDialogKeys` 改为从 `utils/platform/windows-dialog` 导入
- [x] 注入链路：`main/index.ts` → `JSPluginManager` → `PluginLifecycleManager` → `PluginHelpers` → `WindowNamespace`

**修改文件：**

- `src/constants/fingerprint-defaults.ts`: 新增 `generateVariant`、`applyPreset`
- `src/main/profile/presets/index.ts`: 改为从 constants re-export
- `src/core/js-plugin/namespaces/profile.ts`: 改为从 `constants/fingerprint-defaults` 导入
- `src/core/js-plugin/namespaces/window.ts`: 新增 `InternalDevToolsOpener` 类型；移除 `maybeOpenInternalBrowserDevTools` 直接导入；改为注入回调
- `src/core/js-plugin/helpers.ts`: 新增 `devToolsOpener` 构造函数参数并透传
- `src/core/js-plugin/plugin-lifecycle.ts`: 新增 `devToolsOpener` 构造函数参数并透传
- `src/core/js-plugin/manager.ts`: 新增 `devToolsOpener` 构造函数参数并透传
- `src/main/index.ts`: 注入 `maybeOpenInternalBrowserDevTools` 回调
- `src/core/browser-extension/extension-browser.lifecycle.test.ts`: 修正 mock 和导入路径

**验收：**

- typecheck passed
- P0 回归测试 36 tests passed
- 受影响测试 204 tests passed (196 js-plugin namespaces + 8 extension-browser lifecycle)
- 剩余 `core→main` 导入全部为 `import type` (C 类)

#### B 类动态导入 — 已清理 ✅

- [x] `src/core/js-plugin/manager.ts` 中的 `import('../../main/duckdb/utils')` → `import('../../utils/data-paths')`

#### C 类类型导入 — 进行中

- [x] 提取 `types/service-interfaces.ts`：定义 `IAccountService`、`ISavedSiteService`、`IProfileService`、`IProfileGroupService`、`IWebhookSender`
- [x] 迁移 js-plugin namespaces：account、saved-site、profile、webhook → 使用新接口
- [x] 迁移 browser-pool：index.ts、pool-manager.ts → 使用 `IProfileService`
- [x] 迁移 js-plugin 核心：helpers.ts、manager.ts、plugin-lifecycle.ts → 使用 `IWebhookSender`
- [x] 更新 browser-pool 测试工具：`__tests__/test-utils.ts` mock 改用 `IProfileService`
- [x] 清理 architecture-boundary whitelist：移除 8 条已消除的 C 类导入
- [x] 迁移 `window.ts`：`ProfileService` → `IProfileService`（whitelist 移除 1 条）
- [x] 提取 `ISchedulerService` 到 `types/scheduler.ts`：覆盖 registerHandler/createTask/pauseTask/resumeTask/cancelTask/triggerTask/getTasksByPlugin/getTask/getTaskHistory/deleteTasksByPlugin
- [x] 迁移 `scheduler.ts` namespace 和 `task-manager/scheduler.ts`：`SchedulerService` → `ISchedulerService`（whitelist 移除 1 条）
- [x] 提取 `IWebContentsViewManager` / `IWindowManager` 到 `core/browser-pool/ports.ts`：含 `PopupWindowConfig`、`ViewDisplayMode`、`ViewSource`
- [x] 迁移 browser-pool utils：`showBrowserView`/`hideBrowserView`/`showBrowserViewInPopup`/`closeBrowserPopup`/`attachBrowserView` → 使用接口
- [x] 迁移 js-plugin 核心：helpers.ts、manager.ts、plugin-lifecycle.ts、ui-extension-manager.ts → 使用 `IWebContentsViewManager`/`IWindowManager`
- [x] 迁移 js-plugin namespaces：profile.ts、window.ts → 使用 `IWebContentsViewManager`/`IWindowManager`
- [x] 修复 `js-plugin-handler.ts`：`windowManager` 从直接 import 改为构造函数注入
- [x] 修复 `manager.test.ts` mock 类型
- [x] 修复 `utils-popup.test.ts` 移除无效断言
- [x] 清理 architecture-boundary whitelist：移除 13 条 WebContentsViewManager/WindowManager C 类导入
- [x] 提取 `IExtensionControlRelay` / `IRuyiFirefoxClient` 到 `core/browser-automation/transport-types.ts`
- [x] 迁移 browser-automation：`browser-command-transport.ts` → 使用 `IExtensionControlRelay` / `IRuyiFirefoxClient`
- [x] 迁移 browser-extension：`extension-browser.ts` → 使用 `IExtensionControlRelay`
- [x] 迁移 browser-ruyi：`ruyi-browser.ts` → 使用 `IRuyiFirefoxClient`
- [x] 迁移 main 类型：`ruyi-firefox-client.types.ts` 从 `core/browser-automation/transport-types.ts` 导入 `RuyiFirefoxEvent`
- [x] 清理 architecture-boundary whitelist：移除 4 条 ExtensionControlRelay/RuyiFirefoxClient C 类导入 + 1 条 stale SchedulerService 条目
- [x] 提取 `IDuckDBService` / 共享 schema 类型到 `types/duckdb.ts`：`FieldType`、`StorageMode`、`ColumnMetadata`、`EnhancedColumnSchema`、`QueryResult`、`ButtonExecuteResult` 等
- [x] 迁移 17 个 core 文件：`DuckDBService` → `IDuckDBService`，`main/duckdb/{service,types}` → `types/duckdb`
- [x] 修复类型不匹配：`queryDataset` 返回类型、`addColumn` 参数、`importRecordsFromFile` 返回类型、`ButtonExecuteResult` 导出
- [x] 清理 architecture-boundary whitelist：全部 17 条 DuckDBService/EnhancedColumnSchema C 类导入移除，whitelist 归零
- [x] 类型检查通过，3643 tests passed

### 4.2 引入 QueryEngine Builder 管道

- [x] 定义 `QueryPipelineStep` 接口：`key`/`phase`/`applies`/`apply`/`validate`
- [x] 建立 `QueryPipeline` 注册表：支持按 phase 分组执行、跳过不适用的步骤
- [x] 建立 `createBuilderStep` 适配器工厂：将标准 Builder（build + 可选 getResultColumns）包装为 pipeline step
- [x] 新增 `src/core/query-engine/pipeline/` 模块：
  - `QueryPipelineStep.ts`：步骤接口定义
  - `QueryPipeline.ts`：有序管道注册表与执行器
  - `createBuilderStep.ts`：Builder → Step 适配器工厂
  - `index.ts`：模块导出
  - `QueryPipeline.test.ts`：5 tests passed（注册顺序、phase 过滤、条件跳过、validate 前置、key 列表）
- [x] 扩展 `createBuilderStep`：新增 `preApply`（运行时前置条件检查）和 `postApply`（更新运行时状态如 `isAggregated`）
- [x] 扩展 `QueryPipeline`：新增 `getStep(key)` 方法（供 PreviewService 获取单个 step）
- [x] 将 10 个 Builder 注册为 pipeline step（filter/clean/explode/validation/lookup/compute/group/aggregate/dedupe/sample）
- [x] `QueryEngine` 主流程改用 `pipeline.executePhase()` 执行三阶段（pre-dedupe → dedupe → post-dedupe）
- [x] 删除 `applyPreDedupeOperations` 方法（~120 行硬编码调用链），保留 softDelete/选列/排序/分页等最终组装逻辑
- [x] `PreviewService` 接收 `QueryPipeline` + `LookupBuilder`（保留 `buildJoinSelectItems` 直接引用），通过 `buildStepSQL` 辅助方法生成预览 SQL
- [x] 迁移 `createDedupePreviewContext` 使用 pipeline 的 pre-dedupe phase

**验收：**

- query-engine 全部 453 tests passed（含新增 pipeline 测试），无回归
- 类型检查通过

### 4.3 建立 IPC 注册中心 ✅ 完成

- [x] 创建 `IpcRouteRegistry` 单例（`src/main/ipc-route-registry.ts`）：支持 `register`/`registerAll`/`unregister`/`unregisterAll`/`getChannels`，内置重复 channel 检测
- [x] 迁移 `http-api-handler.ts`：4 个 `ipcMain.handle` → `ipcRouteRegistry.register`
- [x] 迁移 `system-handler.ts`：16 个 `ipcMain.handle` → `ipcRouteRegistry.register`
- [x] 迁移 `account-ipc-handler.ts`：2 个直接 `ipcMain.handle` → `ipcRouteRegistry.register`（其余已通过 `createIpcHandler` 工厂间接使用 registry）
- [x] 迁移 `profile-ipc-handler.ts`：18 个 `ipcMain.handle` → `ipcRouteRegistry.register`
- [x] 迁移 `js-plugin-handler.ts`：31 个 `ipcMain.handle` → `ipcRouteRegistry.register`
- [x] 迁移 `dataset-handler.ts`：43 个 `ipcMain.handle` → `ipcRouteRegistry.register`
- [x] 更新所有相关测试文件：`removeHandler`/`removeListener` mock + `ipcRouteRegistry.unregisterAll()` 于 `beforeEach`
- [x] 全局验证：`src/main` 下仅剩 `ipc-route-registry.ts` 自身和 JSDoc 注释引用 `ipcMain.handle`
- [x] 补齐 IPC route 权限清单元数据
  - `IpcRouteDefinition` 新增必填 `permission` 与可选 `schema`
  - registry 在注册时拒绝缺失或非法 `permission` 的 route
  - 新增 `getManifest()`，导出 `channel` / `kind` / `permission` / `schema`，不暴露 handler 函数
  - 所有 IPC handler route literal 统一补充 `permission: 'trusted-renderer'` 作为当前基线
  - `createIpcHandler` / `createIpcVoidHandler` 工厂默认补充 `trusted-renderer` 权限

**验收：**

- 15 个 IPC handler 测试文件全部通过（373 tests passed）
- IPC 权限清单补充验收：`ipc-route-registry` + 代表性 handler 回归 146 tests passed
- 类型检查通过

**修改文件：**

- `src/main/ipc-route-registry.ts`：IPC 注册中心（已有）
- `src/main/ipc-handlers/http-api-handler.ts`：迁移 4 个 handler
- `src/main/ipc-handlers/system-handler.ts`：迁移 16 个 handler
- `src/main/ipc-handlers/account-ipc-handler.ts`：迁移 2 个 handler
- `src/main/ipc-handlers/profile-ipc-handler.ts`：迁移 18 个 handler
- `src/main/ipc-handlers/js-plugin-handler.ts`：迁移 31 个 handler，移除 `ipcMain` 导入
- `src/main/ipc-handlers/dataset-handler.ts`：迁移 43 个 handler，移除 `ipcMain` 导入
- `src/main/ipc-handlers/http-api-handler.test.ts`：补充 mock 和 `unregisterAll()`
- `src/main/ipc-handlers/system-handler.test.ts`：补充 mock 和 `unregisterAll()`
- `src/main/ipc-handlers/dataset-handler.test.ts`：补充 mock 和 `unregisterAll()`
- `src/main/ipc-handlers/utils.ts`：route 工厂默认补充权限声明
- `src/core/ai-dev/architecture-maintenance-guard.test.ts`：新增 IPC route literal 权限护栏

### 4.4 拆分主进程启动与 HTTP gateway

- [x] 消除 `js-plugin-handler.ts` 对 `windowManager` 的直接 import，改为构造函数注入
  - `src/main/ipc-handlers/js-plugin-handler.ts`: 移除 `import { windowManager } from '../index'`，改为构造函数参数
  - `src/main/index.ts`: `new JSPluginIPCHandler(...)` 调用点增加 `windowManager` 参数
- [x] HTTP dependency/gateway 构造提取为 `buildRestApiDependencies(runtime)`
  - 新增 `src/main/http-server-composition.ts`: `buildRestApiDependencies()` 函数，包含所有 `toOrchestration*` 转换和 gateway 组装
  - `src/main/index.ts`: `startHttpServer()` 从 ~500 行降至 ~140 行，仅保留生命周期逻辑
- [x] `startHttpServer()` 添加启动超时保护（30 秒），失败后清理锁
- [x] `startResourceMonitoring()` 返回 `dispose()` 函数，接入 shutdown bootstrap
  - `src/main/bootstrap/shutdown-bootstrap.ts`: 新增 `disposeResourceMonitoring` 清理步骤
  - `src/main/bootstrap/shutdown-bootstrap.test.ts`: 更新顺序断言（5 tests passed）

### 4.5 提取服务层小抽象

- [x] 提取 `runInDuckDbTransaction(conn, work)` 统一事务封装
  - `src/main/duckdb/utils.ts`: 新增 `runInDuckDbTransaction`，ROLLBACK 失败时优先抛出原始错误并记录 rollback 失败
  - `src/main/duckdb/account-service.ts`: 迁移到通用函数
  - `src/main/duckdb/extension-packages-service.ts`: 迁移到通用函数（保留 `ensureSchemaReady` 前置调用）
  - 验收：`rg -n "runInDuckDbTransaction" src/main/duckdb` 命中 2+ 服务，相关测试全部通过
- [x] 提取 `SyncFieldNormalizer`
  - 新增 `src/main/duckdb/sync-field-normalizer.ts`: `normalizeSyncString`、`normalizeSyncInteger`（支持 `min` 约束）、`normalizeSyncBoolean`、`normalizeSyncTimestamp`、`normalizeSyncScope`、`normalizeSyncOwnership`
  - `src/main/duckdb/tag-service.ts`: 完全迁移，消除 6 个私有 normalize 方法
  - `src/main/duckdb/account-service.ts`: 完全迁移，消除 6 个私有 normalize 方法 + `toTimestampValue`
  - `src/main/duckdb/saved-site-service.ts`: 完全迁移，消除 7 个私有 normalize 方法 + `toTimestampValue`
  - **新增** `src/main/duckdb/sync-field-normalizer.test.ts`: 16 tests passed
- [x] 提取 `SqlUpdateBuilder`（tag-service/account-service/saved-site-service 已推广）
  - 新增 `src/main/duckdb/sql-update-builder.ts`: `set`/`setRaw`/`build`/`isEmpty`/`changeCount`
  - 新增 `src/main/duckdb/sql-update-builder.test.ts`: 14 tests passed
  - `tag-service.ts`: update() 方法完全迁移到 SqlUpdateBuilder
  - `saved-site-service.ts`: update() 方法完全迁移到 SqlUpdateBuilder
  - `account-service.ts`: update() 方法完全迁移到 SqlUpdateBuilder（含 setRaw('updated_at', 'CURRENT_TIMESTAMP')）
- [x] dataset 表名长度限制（128 字符）和白名单测试
  - `src/main/duckdb/dataset-storage-service.ts`: `sanitizeDatasetId` 增加长度上限
  - `src/main/duckdb/dataset-storage-service.test.ts`: 增加超长拒绝/边界接受测试（10 tests passed）

---

## P1 总结

| 任务                    | 状态 | 关键产出                                                                                    |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 4.1 A/B 类依赖清理      | ✅   | core→main 运行时/动态导入归零                                                               |
| 4.1 C 类类型导入        | ✅   | 已提取 10 个服务/传输/数据库接口，消除 28 条 whitelist 项，whitelist 归零                   |
| 4.2 QueryEngine Builder | ✅   | 10 个 Builder 已适配为 pipeline step，QueryEngine/PreviewService 已迁移                     |
| 4.3 IPC 注册中心        | ✅   | 全部 ~114 个 handler 迁移完成；补齐 permission/schema 清单与缺失权限防回归护栏              |
| 4.4 HTTP gateway 拆分   | ✅   | `startHttpServer()` 从 ~500 行降至 ~140 行                                                  |
| 4.5 服务层小抽象        | ✅   | `runInDuckDbTransaction` + `SyncFieldNormalizer` + `SqlUpdateBuilder` + dataset ID 长度限制 |

---

## P2: 大对象拆分和维护性

（P1 完成后开始）

### 5.1 拆分 `datasetStore` ✅ 完成

- [x] 第一刀：抽出 `datasetImportStore` slice，保持 `useDatasetStore` 对外入口不变
  - 新增 `src/renderer/src/stores/dataset/importSlice.ts`
  - `src/renderer/src/stores/datasetStore.ts` 改为通过 `createDatasetImportSlice(set, get)` 组合导入相关 action
  - 覆盖导入启动、失败、取消导入、进度更新、processed 标记
  - 验收：`src/renderer/src/stores/dataset/importSlice.test.ts` 4 tests passed，`datasetStore.test.ts` 28 tests passed，typecheck passed
- [x] 第二刀：抽出 `datasetWorkspaceStore` slice，继续保持 `useDatasetStore` 对外入口不变
  - 新增 `src/renderer/src/stores/dataset/workspaceSlice.ts`
  - `src/renderer/src/stores/datasetStore.ts` 改为通过 `createDatasetWorkspaceSlice(set, get)` 组合 group tabs / workspace selection / reconcile action
  - 覆盖 group tab 排序与默认选择、API hydrate、snapshot selection、stale selection reconcile
  - 验收：`src/renderer/src/stores/dataset/workspaceSlice.test.ts` 4 tests passed，`datasetStore.test.ts` 28 tests passed，workspace/tab 页面回归 20 tests passed，typecheck passed
- [x] 第三刀：抽出 `datasetQueryRuntimeStore` slice，继续保持 `useDatasetStore` 对外入口不变
  - 新增 `src/renderer/src/stores/dataset/queryRuntimeSlice.ts`
  - `src/renderer/src/stores/datasetStore.ts` 改为通过 `createDatasetQueryRuntimeSlice(set, get)` 组合 `queryDataset` / `loadMoreData` / `cancelQuery` / `clearQueryResult`
  - 同步迁出 query session、active query template snapshot、分页 hasMore 推导等运行时 helper
  - 新增 `src/renderer/src/stores/dataset/queryRuntimeSlice.test.ts`，覆盖直接查询、模板查询、stale template 清理、加载更多、取消后忽略过期结果
  - 验收：query/import/workspace slice + `datasetStore.test.ts` 共 41 tests passed，workspace/tab 页面回归 20 tests passed，typecheck passed；`datasetStore.ts` 降至 1009 行
- [x] 第四刀：抽出 `datasetQueryTemplateStore` slice，继续保持 `useDatasetStore` 对外入口不变
  - 新增 `src/renderer/src/stores/dataset/queryTemplateSlice.ts`
  - `src/renderer/src/stores/datasetStore.ts` 改为通过 `createDatasetQueryTemplateSlice(set, get, queryRuntime.helpers)` 组合模板创建、应用、刷新、默认模板加载、模板更新和清空处理
  - 模板 slice 复用 query runtime helpers，避免复制 session 竞态保护、模板快照查询和分页 `hasMore` 推导
  - 新增 `src/renderer/src/stores/dataset/queryTemplateSlice.test.ts`，覆盖从 preview SQL 创建模板、应用模板、刷新非默认模板、fallback 到直接查询、无 active template 时加载默认模板再更新、reset 视图状态
  - 验收：query-template/query-runtime/import/workspace slice + `datasetStore.test.ts` 共 47 tests passed，workspace/tab 页面回归 20 tests passed，typecheck passed；`datasetStore.ts` 降至 691 行
- [x] 第五刀：抽出 `datasetCoreStore` slice，完成数据集列表、详情、刷新、删除、重命名和 UI 基础状态迁移
  - 新增 `src/renderer/src/stores/dataset/coreSlice.ts`
  - 新增 `src/renderer/src/stores/dataset/types.ts`，统一导出 `DatasetInfo` / `DatasetSchemaColumn`
  - `src/renderer/src/stores/datasetStore.ts` 改为通过 `createDatasetCoreSlice(set, get, queryRuntime.helpers)` 组合 core CRUD action
  - 删除数据集时继续复用 query runtime 的 `clearDatasetViewState()`，并保持 group tabs / active template / current dataset 的级联清理行为
  - 新增 `src/renderer/src/stores/dataset/coreSlice.test.ts`，覆盖列表加载、详情请求竞态、重命名、删除当前数据集并清理关联视图状态
- [x] 第六刀：抽出 `datasetOptimisticStore` slice，完成本地 optimistic patch 迁移
  - 新增 `src/renderer/src/stores/dataset/optimisticSlice.ts`
  - `src/renderer/src/stores/datasetStore.ts` 改为通过 `createDatasetOptimisticSlice(set, get)` 组合 schema/count/record optimistic patch action
  - 同步迁出本地 schema refresh 标记、临时 `_row_id` 序列、复杂 queryConfig 下拒绝本地行 patch 的保护
  - 新增 `src/renderer/src/stores/dataset/optimisticSlice.test.ts`，覆盖插入追加、复杂查询拒绝本地更新、schema refresh 标记、删除行并同步计数
  - 验收：core/optimistic/query-template/query-runtime/import/workspace slice + `datasetStore.test.ts` 共 55 tests passed，workspace/tab 页面回归 20 tests passed，typecheck passed；`datasetStore.ts` 降至 211 行

**5.1 总结：**

- `datasetStore.ts` 保留为兼容入口，组件 import 路径不变
- 子模块已拆为 core / optimistic / import / queryRuntime / queryTemplate / workspace / shared types
- 每个子 store 均有职责边界测试
- 后续如需继续压小文件，可把 query template API adapter 从 `queryRuntimeSlice.ts` 独立为共享小模块；这不再阻塞 5.1 验收

### 5.2 重构 `McpSessionInfo` ✅ 完成

- [x] 将 `McpSessionInfo` 从 24 个顶层字段改为分组结构：
  - `transport`：`sessionId` / MCP `server` / Streamable HTTP transport
  - `queue`：`invokeQueue` / pending / active / max queue size / active invocation controller
  - `browser`：browser handle / acquire promise / partition / engine / visible / host window
  - `auth`：effective MCP scopes
  - `lifecycle`：last activity / closing / close controller / close reason / terminate-after-response
  - `viewport`：health / interaction readiness / offscreen state
- [x] 新增 `createMcpSessionInfo()` factory，兼容 flat 初始化参数并支持按子对象覆盖 mock state
- [x] 新增 `getMcpInvokeQueueState()` queue adapter，使现有 invoke queue/cleanup 逻辑可操作分组后的 `queue` 与 `lifecycle`
- [x] 更新 MCP runtime、route handler、session lifecycle、session snapshot、HTTP session bridge/manager 的全部字段访问
- [x] 更新相关测试 helper，统一通过 `createMcpSessionInfo()` 构造 MCP session mock
- [x] 新增 `src/main/mcp-http-types.test.ts`，覆盖子对象 mock 构造与 queue adapter 双向映射
- [x] 拆出 `src/main/mcp-server-http-transport.test.ts`，把 `mcp-server-http.test.ts` 中的 MCP transport guardrail（Origin / protocol version）用例迁移为聚焦测试文件
- [x] 验收通过：
  - `npm run typecheck`
  - `npx vitest run src/main/mcp-http-types.test.ts src/main/mcp-server-http-transport.test.ts src/main/mcp-server-http.test.ts src/main/mcp-http-session-runtime.test.ts src/main/mcp-http-runtime-availability.test.ts src/main/mcp-http-adapter.test.ts src/main/http-session-manager.test.ts src/main/http-session-bridge.test.ts`：118 tests passed

### 5.3 拆分 BrowserInterface ✅ 完成

- [x] 保持 `BrowserInterface = BrowserCore & BrowserOptionalCapabilitySet` 兼容入口不变，新增更小的 role interface：
  - `BrowserNavigationCapability`
  - `BrowserPageContentCapability`
  - `BrowserElementInteractionCapability`
  - `BrowserCookieCapability`
  - `BrowserVisibilityCapability`
  - `BrowserAbortSignalCapability`
- [x] 新增 capability guard/assert helper：
  - 通用 `hasBrowserCapabilityMethods()` / `assertBrowserCapabilityMethods()`
  - network / console / windowOpenPolicy / text OCR / download / PDF / dialog / tabs / emulation / storage / intercept 的具名 helper
- [x] 为 OCR 引入显式 `OCRProviderFactory` 注入：
  - `IntegratedBrowser` 不再直接 import `getOcrPool()`；未注入 factory 时访问 OCR 会抛出清晰错误
  - `ExtensionBrowser` / `RuyiBrowser` 构造参数新增 `ocrProviderFactory`
  - main 层 browser factory 负责把 `getOcrPool()` 包装为 provider factory 注入
  - `createViewportOCRService()` 改为懒加载注入 provider，并支持 terminate 已创建 provider
- [x] 清理 `viewport-ocr.ts` 热路径输出：确认已使用 logger，`rg -n "console\\." src/core/browser-automation/viewport-ocr.ts` 无结果
- [x] 抽出三种浏览器重复的 `observeBrowserOperation`：
  - 新增 `createBrowserObservationContext()` / `observeBrowserOperation()` 到 `browser-facade-shared.ts`
  - `IntegratedBrowser` / `ExtensionBrowser` / `RuyiBrowser` 仅保留各自 engine/browserId 包装
- [x] 补充测试：
  - `browser-facade-shared.test.ts` 覆盖注入 OCR factory 与缺失 factory 的清晰失败
  - `integrated-browser.text-strategy.test.ts` 覆盖 Integrated OCR 必须通过注入 factory，不依赖全局 pool
  - `browser-capability-truth.test.ts` 覆盖 capability helper 与三种实现的能力方法组
- [x] 验收通过：
  - `npm run typecheck`
  - `npx vitest run src/core/browser-automation/browser-facade-shared.test.ts src/core/browser-automation/integrated-browser.text-strategy.test.ts src/core/browser-automation/browser-capability-truth.test.ts src/core/browser-extension/extension-browser.text-strategy.test.ts src/core/browser-automation/browser-runtime.cross-engine-contract.test.ts`：32 tests passed
  - `npx vitest run src/core/browser-extension/extension-browser.lifecycle.test.ts src/core/browser-ruyi/ruyi-browser.lifecycle.test.ts src/core/browser-ruyi/ruyi-browser.observation.test.ts src/core/browser-ruyi/ruyi-browser.prompt-click.test.ts`：16 tests passed

### 5.4 引入 SchemaMigrationEngine ✅ 完成

- [x] 新增 `src/main/duckdb/migration-engine.ts`
  - `SchemaMigrationEngine` 负责创建/读取 `schema_migrations`
  - 每条迁移记录 `id` / `description` / `checksum` / `applied_at` / `rollback_sql`
  - 支持重复执行时跳过已应用迁移，checksum 不一致时报错
  - 支持 `addColumnIfMissingStep()`，通过 `PRAGMA table_info` 判断列是否存在，不再依赖散落的 `ALTER TABLE ADD COLUMN IF NOT EXISTS`
  - 迁移 step 可携带 rollback SQL，为后续回滚实现保留设计入口
- [x] 新增 `src/main/duckdb/schema-migrations.ts`
  - 集中定义静态应用表迁移与 backfill
  - 覆盖 accounts / saved_sites / tags / browser_profiles / scheduled_tasks / datasets 元数据 / extension_packages / profile_extensions / plugin bootstrap tables
- [x] 迁移静态表补列逻辑：
  - `account-service.ts`
  - `saved-site-service.ts`
  - `tag-service.ts`
  - `profile-service.ts`
  - `scheduled-task-service.ts`
  - `dataset-metadata-service.ts`
  - `extension-packages-service.ts`
  - `service.ts` 中 plugin 表 bootstrap 补列
- [x] 保留数据修复 UPDATE 为可重复 backfill：例如 account 默认 profile/tags/sync、profile pool 默认值、extension package 默认 source/enabled/timestamps
- [x] 补充/更新测试：
  - 新增 `src/main/duckdb/migration-engine.test.ts`，覆盖新表迁移、旧表升级、重复执行幂等、重复 migration id 防护
  - 更新 `dev-schema-bootstrap.test.ts`，验证旧 profile/account/site/tag 表升级后写入 `schema_migrations`，重复 init 不增加迁移记录
  - 更新 `extension-packages-service.test.ts`，验证 legacy extension package 表通过迁移修复并记录 migration id
- [x] 验收通过：
  - `npm run typecheck`
  - `npx vitest run src/main/duckdb/migration-engine.test.ts src/main/duckdb/dev-schema-bootstrap.test.ts src/main/duckdb/extension-packages-service.test.ts`：12 tests passed
  - `npx vitest run src/main/duckdb/account-service.normalization.test.ts src/main/duckdb/account-service.password.test.ts src/main/duckdb/account-service.references.test.ts src/main/duckdb/account-service.tag-mutation.test.ts src/main/duckdb/saved-site-service.test.ts src/main/duckdb/scheduled-task-service.bigint.integration.test.ts src/main/duckdb/service.test.ts`：相关服务回归通过
  - `rg -n "ADD COLUMN IF NOT EXISTS|ALTER TABLE .*ADD COLUMN" src/main/duckdb`：仅剩数据集动态表加列和迁移引擎自身

### 5.5 收缩 DuckDBService facade 与巨型测试文件

- [x] 拆分 `src/main/mcp-server-http.test.ts`
  - 删除原 4864 行巨型测试文件，按职责拆成 5 个聚焦文件：
    - `src/main/mcp-server-http.orchestration-routes.test.ts`：orchestration REST/capabilities/health/OpenAPI
    - `src/main/mcp-server-http.mcp-surface.test.ts`：MCP tools/resources/prompts/public surface/protocol error
    - `src/main/mcp-server-http.transport-session.test.ts`：MCP transport session lifecycle、DELETE/timeout、profile takeover
    - `src/main/mcp-server-http.browser-binding.test.ts`：session_prepare、browser observe、session self-inspection
    - `src/main/mcp-server-http.auth-invoke.test.ts`：auth、REST session lifecycle、invoke queue/timeout/idempotency
  - 拆分后单文件行数：1199 / 1419 / 1143 / 1066 / 1410，均低于 1500 行
- [x] 新增测试规模防回归护栏
  - 新增 `src/main/mcp-server-http.split-contract.test.ts`
  - 自动扫描 `mcp-server-http*.test.ts` 与 `datasetStore.test.ts`，超过 1500 行即失败
  - 当前 `datasetStore.test.ts` 为 1146 行，store slice 测试继续保持独立
- [x] 新增 DuckDBService facade 防回归护栏
  - 新增 `src/main/duckdb/service-facade-contract.test.ts`
  - 使用 TypeScript AST 识别 `DuckDBService` 中“同名方法直接转发给子服务”的纯 facade proxy
  - 现存 legacy proxy 统一登记迁移说明；新增纯代理如未补充迁移说明会失败
  - 同时校验 `getDatasetService()` / `getProfileService()` / `getAccountService()` 等显式子服务 accessor 仍作为迁移路径存在
- [x] 验收通过：
  - `npx vitest run src/main/duckdb/service-facade-contract.test.ts src/main/mcp-server-http.split-contract.test.ts`：3 tests passed
  - `npx vitest run src/main/mcp-server-http.orchestration-routes.test.ts src/main/mcp-server-http.mcp-surface.test.ts src/main/mcp-server-http.transport-session.test.ts src/main/mcp-server-http.browser-binding.test.ts src/main/mcp-server-http.auth-invoke.test.ts`：80 tests passed
  - `npx vitest run src/main/mcp-server-http-transport.test.ts`：4 tests passed
  - `npx vitest run src/renderer/src/stores/__tests__/datasetStore.test.ts` + `src/renderer/src/stores/dataset/*.test.ts`：55 tests passed
  - `npm run typecheck`

## 6. 持续守护

### 6.1 自动化架构护栏第一批 ✅ 完成

- [x] 复用并验证已有边界守护
  - `src/core/ai-dev/architecture-boundary.test.ts` 已覆盖 AI-Dev 分层、HTTP/MCP 边界、`src/core` 禁止新增 `src/main` 运行时/未登记类型导入
  - `src/main/ipc-route-registry.test.ts` 已覆盖 IPC 注册中心重复 channel 检测与注销行为
- [x] 新增 `src/core/ai-dev/architecture-maintenance-guard.test.ts`
  - 文件规模护栏：扫描 `src/**/*.ts(x)`，超过 900 行必须在 `ARCHITECTURE_SIZE_NOTES` 中登记架构说明
  - DuckDB statement 仪式护栏：禁止在新文件中重新出现 `prepare()` + `destroySync()` 成对仪式；现存 sync 服务作为迁移基线，只允许减少不允许增加
  - `normalizeSync*` 护栏：禁止新建 service-local normalizeSync 家族，集中到 `sync-field-normalizer.ts` 或显式登记 account 特例
  - 浏览器 observe 护栏：只允许 shared helper 与三种浏览器 facade 的薄 adapter，防止重新复制 observe 包装逻辑
  - IPC 权限清单护栏：扫描 `src/main/ipc-handlers` route literal，缺少 `permission` 声明即失败
- [x] 验收通过：
  - `npx vitest run src/core/ai-dev/architecture-boundary.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts src/main/ipc-route-registry.test.ts`：24 tests passed
  - `npx eslint src/core/ai-dev/architecture-maintenance-guard.test.ts`
  - `npm run typecheck`

### 6.2 关键命令总验收 ✅ 完成

- [x] `npm run typecheck`：通过
- [x] `npm run lint`：通过，0 errors；仍有 168 个既有 warning，主要来自历史测试 harness 与 legacy any/unused/shadow/react-hooks 警告
- [x] `npm run test:open`：通过，7 个测试文件、25 tests passed
- [x] `npm run test:open:full`：通过（exit 0）
- [x] `npm run verify:open-source-boundary`：通过，verified 1029 open-source file(s)
- [x] `git diff --check`：通过（仅 Git line-ending 提示，无 whitespace error）
- [x] 重点扫描：
  - `src/main` 非测试代码无 `catch (error: any)`
  - `src/main/duckdb` 非测试代码直接 `.destroySync()` 只剩 `statement-executor.ts`
  - `src/main` 非测试代码无新的直接 `ipcMain.handle/on` 注册点（仅 registry 自身和注释命中）

## 7. 剩余审查项第一批

基于 `tianshe-review/remaining-repair-summary.md` 的建议落地顺序，先处理两个低风险、可独立验收的修复点。

### 7.1 Dataset 删除列契约与 Base64 导入边界 ✅ 完成

- [x] 修复 `deleteDatasetColumn()` 契约不一致：
  - `deleteDatasetColumn()` 现在与其他 dataset mutation 一样，对 `success: false` 调用 `unwrapResult()` 并抛错
  - 新增 `deleteDatasetColumnRaw()`，专门供需要读取失败结果的强制删除二次确认流程使用
  - `DatasetTable` 删除列流程改为使用 raw 入口，保留“先失败提示依赖，再确认 force 删除”的交互
- [x] 为 `duckdb:import-records-from-base64` 增加输入边界：
  - 支持普通 Base64 与 `data:*;base64,` 前缀
  - 校验 Base64 字符集、padding 与解码后字节数
  - 解码前限制最大导入大小为 500MB
  - 增加导入扩展名白名单：`.csv` / `.tsv` / `.txt` / `.json` / `.xlsx` / `.xls`
  - 对 data URL MIME 增加白名单，非法 MIME 在写临时文件前失败
  - 写入临时文件后校验实际 buffer 大小，失败路径仍清理临时文件
- [x] 补充测试：
  - `datasetMutationService.test.ts` 覆盖默认删除列失败抛错与 raw 入口保留失败结果
  - `dataset-handler.test.ts` 覆盖 Base64 规范化、非法内容、超限、扩展名、MIME 与 IPC 成功/失败路径
- [x] 验收通过：
  - `npx vitest run src/renderer/src/services/datasets/datasetMutationService.test.ts src/main/ipc-handlers/dataset-handler.test.ts`：63 tests passed
  - `npm run typecheck`：通过

  - `npx prettier --check src/main/ipc-handlers/dataset-handler.ts src/main/ipc-handlers/dataset-handler.test.ts src/renderer/src/components/DatasetsPage/DatasetTable.tsx src/renderer/src/services/datasets/datasetMutationService.ts src/renderer/src/services/datasets/datasetMutationService.test.ts repair-progress.md`：通过
  - `git diff --check -- src/main/ipc-handlers/dataset-handler.ts src/main/ipc-handlers/dataset-handler.test.ts src/renderer/src/components/DatasetsPage/DatasetTable.tsx src/renderer/src/services/datasets/datasetMutationService.ts src/renderer/src/services/datasets/datasetMutationService.test.ts repair-progress.md`：通过（仅 Git line-ending 提示）

### 7.2 全局 catch(any) 防回归与第一批迁移 ✅ 完成

- [x] 新增共享错误消息工具：
  - `src/utils/error-message.ts`
  - 提供 `getUnknownErrorMessage()` / `getUnknownErrorStack()` / `toError()`
  - `src/main/ipc-utils.ts` 改为复用并 re-export 共享函数，避免 main/core/renderer 各自散落实现
- [x] 第一批 `catch(error:any)` 迁移到 `unknown`：
  - renderer store：`pluginStore` / `pluginRuntimeStore` / `executionStore`
  - renderer 设置面板：HTTP API / OCR pool / internal browser
  - dataset UI：附件字段、Compute/Lookup/Sample 面板、custom pages、toolbar buttons、data parser
  - core/browser：browser-core CDP、SimpleBrowser network idle、browser-pool 创建失败路径
  - core/query：`FilterBuilder`、`PreviewService`
  - core/ffi/http：FFI library/service、HTTP client
- [x] 新增架构护栏：
  - `architecture-maintenance-guard.test.ts` 增加生产代码 `catch(error:any)` 基线测试
  - 当前生产 `catch(error:any)` 从 138 处降到 87 处
  - 剩余基线集中在 `src/core/ai-service/openai.ts` 与 `src/core/js-plugin/**`
  - 后续只能减少，新增或反弹会失败

### 7.3 大输入边界、IPC schema 与导入 worker 诊断 ✅ 完成

- [x] 前端导入文件预检查：
  - 新增 `src/renderer/src/components/DatasetsPage/importFilePolicy.ts`
  - 在 `AddRecordDrawer` 调用 `File.arrayBuffer()` 前校验扩展名与 500MB 大小上限
  - 防止无本地 path 时先把超大文件整包读入 renderer 再转 Base64
- [x] 高风险 IPC schema 第一批：
  - `duckdb:import-records-from-base64` 增加 schema manifest
  - `duckdb:import-records-from-file` 增加 schema manifest
  - 架构护栏新增高风险 route schema 检查，当前覆盖上述两条导入 route
- [x] import worker 入口诊断：
  - `DatasetImportService.resolveImportWorkerPath()` 改为候选路径列表
  - 若 app.asar.unpacked、app.asar、dev path 均不存在，会记录已检查路径并明确 fallback
  - 增加缺失 worker 路径诊断测试
- [x] 验收通过：
  - `npx vitest run src/core/ai-dev/architecture-maintenance-guard.test.ts src/main/ipc-utils.test.ts src/main/ipc-handlers/dataset-handler.test.ts src/main/duckdb/dataset-import-service.test.ts src/renderer/src/components/DatasetsPage/__tests__/AddRecordDrawer.test.tsx`：106 tests passed
  - `npx vitest run src/core/query-engine/QueryEngine.test.ts src/core/query-engine/builders/FilterBuilder.test.ts`：63 tests passed
  - `npm run typecheck`：通过
  - 合并复跑上述 7 个测试文件：169 tests passed
  - `npx prettier --check`（本批涉及文件）：通过
  - `git diff --check`（本批涉及文件）：通过（仅 Git line-ending 提示）

## 8. 剩余审查项第二批

继续基于 `tianshe-review/remaining-repair-summary.md`，先处理 P1-1 中可独立落地、风险较低的生命周期启动治理项。

### 8.1 App ready bootstrap 阶段超时与浏览器池 readiness ✅ 完成

- [x] 为 `runAppReadyBootstrap()` 增加阶段包装：
  - 每个启动阶段都有稳定阶段名
  - 阶段抛错会被包装为 `AppReadyBootstrapStageError`
  - 阶段卡住会被包装为 `AppReadyBootstrapStageTimeoutError`
  - 支持全局默认超时与单阶段覆盖超时
  - 失败仍走现有 `handleInitializationFailure()`，不改变主进程失败处理入口
- [x] 补充启动链路测试：
  - 验证启动顺序不变
  - 验证初始化失败携带阶段名
  - 验证卡住阶段按配置超时并停止后续阶段
  - 验证未单独配置的阶段使用默认超时
- [x] 新增浏览器池 readiness 状态：
  - 新增 `BrowserPoolReadiness`
  - 显式记录 `not-started` / `initializing` / `ready` / `failed`
  - 记录 startedAt / readyAt / failedAt / error
  - `initializeServices()` 后台初始化浏览器池时同步更新 readiness
  - 导出 `getBrowserPoolReadiness()` 作为后续 HTTP/MCP 降级错误的明确状态来源
- [x] 验收通过：
  - `npx vitest run src/main/bootstrap/app-ready-bootstrap.test.ts src/main/browser-pool-readiness.test.ts`：6 tests passed
  - `npm run typecheck`：通过
  - `npx prettier --check src/main/bootstrap/app-ready-bootstrap.ts src/main/bootstrap/app-ready-bootstrap.test.ts src/main/browser-pool-readiness.ts src/main/browser-pool-readiness.test.ts src/main/index.ts repair-progress.md`：通过
  - `git diff --check -- src/main/bootstrap/app-ready-bootstrap.ts src/main/bootstrap/app-ready-bootstrap.test.ts src/main/browser-pool-readiness.ts src/main/browser-pool-readiness.test.ts src/main/index.ts repair-progress.md`：通过（仅 Git line-ending 提示）

### 8.2 主窗口 runtime provider 与可变导出收缩 ✅ 完成

- [x] 新增 `AppRuntime` 主进程 runtime 容器：
  - 先承载 `mainWindow` 与 `browserPoolReadiness`
  - 预留 store、DuckDB、窗口/视图、插件、调度器、HTTP server 等后续迁移字段
  - `require*()` 访问器在半初始化状态下给出明确错误，避免后续继续新增隐式全局读取
- [x] 将主窗口 sender guard 改为显式 provider：
  - 新增 `createMainWindowIpcSenderGuard(getMainWindow)`
  - `index.ts` 通过 `() => appRuntime.mainWindow` 注入窗口来源
  - 未创建主窗口时抛出稳定错误，非主窗口 sender 仍走 `UnauthorizedIpcSenderError`
- [x] 移除 `index.ts` 的 `export let windowManager`：
  - `windowManager` 不再作为 mutable runtime 状态从组合根暴露
  - 架构护栏新增 `export let` 禁止项，防止后续把主进程 runtime 状态重新导出
- [x] 验收通过：
  - `npx vitest run src/main/ipc-authorization.test.ts src/main/app-runtime.test.ts src/main/browser-pool-readiness.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：17 tests passed
  - `npm run typecheck`：通过
  - 合并复跑 8.1/8.2 相关测试：`src/main/bootstrap/app-ready-bootstrap.test.ts` + `src/main/ipc-authorization.test.ts` + `src/main/app-runtime.test.ts` + `src/main/browser-pool-readiness.test.ts` + `src/core/ai-dev/architecture-maintenance-guard.test.ts`，21 tests passed
  - `npx prettier --check`（本批涉及文件）：通过
  - `git diff --check`（本批涉及文件）：通过（仅 Git line-ending 提示）

### 8.3 核心服务状态迁入 AppRuntime ✅ 完成

- [x] 将 `index.ts` 的核心服务实例从模块级 `let` 迁入 `AppRuntime`：
  - store / DuckDB / logger / download manager
  - window manager / view manager / JS plugin manager / updater
  - scheduler / extension packages / hook bus / webhook sender
  - HTTP server 实例、启动锁和 resource monitoring disposer
- [x] 更新启动、IPC、HTTP、shutdown 调用点：
  - app ready 阶段通过 `appRuntime.require*()` 获取已初始化依赖
  - HTTP server 启动锁和当前 server 统一挂在 runtime 上
  - shutdown bootstrap 读取 runtime 的半初始化状态，仍保持“存在才清理”的容错行为
  - `getLogger()` / `getDuckDBService()` 改为 runtime 访问器
- [x] 架构护栏继续收紧：
  - 禁止 `src/main/index.ts` 重新出现核心 runtime 服务 `let`
  - 继续禁止 `export let` 暴露 mutable runtime 状态
- [x] 验收通过：
  - `npx vitest run src/main/app-runtime.test.ts src/main/ipc-authorization.test.ts src/main/bootstrap/app-ready-bootstrap.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：19 tests passed
  - `npm run typecheck`：通过
  - 合并复跑 8.1-8.3 相关测试：`src/main/bootstrap/app-ready-bootstrap.test.ts` + `src/main/ipc-authorization.test.ts` + `src/main/app-runtime.test.ts` + `src/main/browser-pool-readiness.test.ts` + `src/core/ai-dev/architecture-maintenance-guard.test.ts`，21 tests passed
  - `npx prettier --check`（本批涉及文件）：通过
  - `git diff --check`（本批涉及文件）：通过（仅 Git line-ending 提示）

## 9. 剩余审查项第三批

继续基于 `tianshe-review/remaining-repair-summary.md`，处理 P1-4：DuckDB 全局事务/执行模型和 sync statement 仪式收敛。

### 9.1 DuckDB statement 与手写事务收敛 ✅ 完成

- [x] 迁移 sync metadata/outbox 的 statement 生命周期：
  - `SyncMetadataService` 改为通过 `allPrepared()` / `runPrepared()` 执行带参数 SQL
  - `SyncOutboxService` 改为通过 `allPrepared()` / `runPrepared()` 执行带参数 SQL
  - `architecture-maintenance-guard.test.ts` 中的 `STATEMENT_RITUAL_BASELINE` 已清空，后续不允许 sync 服务重新出现 `prepare()` + `destroySync()` 成对仪式
- [x] 迁移 DuckDB 业务服务中的手写事务到 `runInDuckDbTransaction()`：
  - `DatasetTabGroupService.reorderTabs()`
  - `DatasetFolderService.deleteFolder()` / `deleteFolderWithContents()`
  - `DatasetQueryService.createTempRowIdTable()`
  - `DatasetMetadataService.deleteMetadata()`
  - `ProfileService` 无效 profile 清理与 `deleteWithCascade()`
  - `DatasetService.hardDeleteRows()` / `updateRecord()` / `batchUpdateRecords()` / `batchInsertRecords()`
  - `DuckDBService.initPluginTables()` 表初始化与索引初始化事务
- [x] 收紧架构护栏：
  - 新增“DuckDB transaction SQL 只能留在共享事务 helper”守卫
  - 当前扫描 `src/main/duckdb` / `src/main/sync` 非测试代码，`BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` 只剩 `src/main/duckdb/utils.ts`
  - 当前扫描 `.destroySync()` / `prepare()`，只剩 `src/main/duckdb/statement-executor.ts`
- [x] 验收通过：
  - `npx vitest run src/main/duckdb/service.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：通过
  - `npx vitest run src/main/duckdb/service.test.ts src/main/duckdb/__tests__/dataset-service.integration.test.ts src/main/duckdb/dataset-query-service.test.ts src/main/duckdb/__tests__/dataset-folder-service.integration.test.ts src/main/duckdb/profile-service.delete-with-cascade.test.ts src/main/sync/sync-metadata-service.scope.test.ts src/main/sync/sync-outbox-service.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：通过
  - `npm run typecheck`：通过
  - `npx prettier --check`（本批涉及文件）：通过
  - `git diff --check`（本批涉及文件）：通过（仅 Git line-ending 提示）

### 9.2 Dataset 延迟依赖 guard 与 schema 通知入口收敛 ✅ 完成

- [x] 收敛 QueryEngine 延迟注入风险：
  - `DatasetQueryService` 不再使用 `private queryEngine!`
  - 新增 `requireQueryEngine()`，preview / compute expression 路径会在触碰 storage 队列前给出明确初始化错误
  - `DatasetService.validateComputeExpression()` 不再通过 `queryService['queryEngine']` 访问私有字段，改为委托 `DatasetQueryService.validateComputeExpression()`
- [x] 收敛导出 SQL builder 延迟注入风险：
  - `DatasetExportService` 将 `exportQuerySQLBuilder` 改为 `null` 状态 + `requireExportQuerySQLBuilder()`
  - query-backed export 未注入 builder 时返回稳定错误，不再依赖可选字段散落判断
- [x] 收敛 dataset schema 更新通知入口：
  - `dataset-handler.ts` 新增 `notifyDatasetSchemaUpdated()`
  - `dataset:schema-updated` channel 字符串只保留一处
  - schema mutation route 统一通过 helper 通知前端刷新
- [x] 收紧架构护栏：
  - 防止 `dataset-handler.ts` 重新散落 `dataset:schema-updated` 直接发送
  - 防止 `DatasetQueryService` 重新引入 `queryEngine!`
  - 防止 `DatasetService` 重新通过索引访问 `queryService['queryEngine']`
- [x] 验收通过：
  - `npx vitest run src/main/duckdb/dataset-query-service.test.ts src/main/duckdb/dataset-export-service.test.ts src/main/ipc-handlers/dataset-handler.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：88 tests passed
  - `npx vitest run src/main/duckdb/__tests__/dataset-operations.integration.test.ts src/main/duckdb/__tests__/lookup-preview-attachment.integration.test.ts`：29 tests passed
  - `npm run typecheck`：通过
  - `npx prettier --check`（本批涉及文件）：通过

### 9.3 Dataset 单条插入路径复用 ✅ 完成

- [x] 抽出 `DatasetService.insertRecordInCurrentQueue()`：
  - 只在外层已持有 dataset queue 的上下文内调用
  - 统一处理 writable 字段过滤、空记录校验、安全列名引用、`runPrepared()` 插入、`row_count` 自增与 `webhook:record.created`
  - `insertRecord()` 和 `batchInsertRecords(records.length === 1)` 复用同一实现，避免复制单条 INSERT 逻辑
- [x] 修复历史跳过测试：
  - 恢复单条 batch 插入测试，验证不会再因嵌套队列死锁而跳过
  - 增加单条 batch 空记录错误契约测试
  - 多条 batch 路径增加空列保护，避免生成非法 `INSERT INTO (...) VALUES` SQL
- [x] 收紧架构护栏：
  - 防止单条 INSERT SQL 在 `DatasetService` 中再次复制
  - 防止旧的 “use insertRecord for single record” skip 用例回归
- [x] 验收通过：
  - `npx vitest run src/main/duckdb/__tests__/dataset-service.integration.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：53 tests passed
  - `npm run typecheck`：通过

### 9.4 Dataset 本地 schema refresh pending 状态收敛 ✅ 完成

- [x] 将 `pendingLocalSchemaRefreshDatasets` 从模块级 `Set` 迁入 Zustand store state：
  - `DatasetOptimisticState` 与 `DatasetStore` 显式持有 `pendingLocalSchemaRefreshDatasets`
  - `applyLocalDatasetSchema()` 通过复制 `Set` 的方式标记 pending，避免原地修改状态对象
  - `consumePendingLocalSchemaRefresh()` 从当前 store state 读取并消费标记，避免多 store / 测试实例共享模块级 pending 状态
- [x] 补齐测试隔离：
  - `optimisticSlice.test.ts` 新增双 harness 用例，验证不同 store 实例不会共享 schema refresh marker
  - `datasetStore.test.ts` 验证本地 schema patch 会写入 store state，并且 marker 仍只消费一次
  - 页面级 DatasetsPage 测试 reset 统一清理 `pendingLocalSchemaRefreshDatasets`，避免跨用例污染
- [x] 收紧架构护栏：
  - 防止 `optimisticSlice.ts` 重新出现模块级 `const pendingLocalSchemaRefreshDatasets = new Set`
  - 要求 pending marker 留在 store state，并保留实例隔离测试
- [x] 验收通过：
  - `npx vitest run src/renderer/src/stores/dataset/optimisticSlice.test.ts src/renderer/src/stores/__tests__/datasetStore.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：46 tests passed
  - `npx vitest run` DatasetsPage 相关 10 个页面测试文件：44 tests passed
  - `npm run typecheck`：通过

### 9.5 Dataset 列名策略与 SQL identifier 引用收敛 ✅ 完成

- [x] 新增共享列名策略：
  - `src/utils/dataset-column-name-policy.ts` 集中定义用户新增/重命名列的白名单、50 字符长度限制、系统字段禁用和统一错误消息
  - `AddColumnDialog` 的前端 Zod 校验改为复用同一套常量，避免前后端规则漂移
  - `duckdb:validate-column-name` IPC 在查重前复用后端 policy，并对输入列名做 trim 规范化
- [x] 后端 schema mutation 接入 policy：
  - `DatasetSchemaService.addColumn()` 对新增列名调用 `assertDatasetColumnNamePolicy()`
  - `DatasetSchemaService.updateColumn()` 对重命名目标调用同一 policy
  - 仍保留已有 schema 列名的兼容性：导入/历史列名不被新增列名白名单 retroactively 拦截
- [x] 拆开列名验证与 SQL 引用：
  - `DatasetService` 删除局部 `validateColumnName()` 黑名单
  - 记录插入/更新路径对已通过 schema 过滤的列名只使用 `quoteIdentifier()`
  - 新增集成测试覆盖已有 schema 列名为 SQL 关键字 `DROP` 时仍可安全写入
- [x] 收紧架构护栏：
  - 防止 `DatasetService` 重新引入局部列名黑名单
  - 要求 schema service、validate IPC 和 AddColumnDialog 继续依赖共享 policy
- [x] 验收通过：
  - `npx vitest run src/utils/dataset-column-name-policy.test.ts src/main/ipc-handlers/dataset-handler.test.ts src/main/duckdb/__tests__/dataset-service.integration.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：120 tests passed
  - `npm run typecheck`：通过

### 9.6 Dataset 本地 patch 事务边界 ✅ 完成

- [x] 为 `optimisticSlice` 增加显式本地 patch 事务 API：
  - `beginLocalPatch()` 捕获 datasets/currentDataset/groupTabs/queryResult/currentOffset/hasMore/pending schema refresh 的快照
  - `commitLocalPatch(patchId)` 清理事务快照并保留当前 state
  - `rollbackLocalPatch(patchId)` 恢复快照并清理事务状态
  - 同一 store 实例只允许一个活动事务，避免嵌套 rollback 顺序不明导致状态回退错位
- [x] 将事务状态纳入 store state：
  - `DatasetOptimisticState` / `DatasetStore` 增加 `localPatchTransaction`
  - 页面级 DatasetsPage 测试 reset 同步清理 `localPatchTransaction`
- [x] 补齐回归测试：
  - `optimisticSlice.test.ts` 覆盖 rollback 恢复、commit 保留、嵌套事务拒绝
  - `datasetStore.test.ts` 覆盖真实 store 组合后的 rollback 行为
  - 架构护栏要求保留 begin/rollback API 与 store 初始事务状态
- [x] 验收通过：
  - `npx vitest run src/renderer/src/stores/dataset/optimisticSlice.test.ts src/renderer/src/stores/__tests__/datasetStore.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：51 tests passed
  - `npx vitest run` DatasetsPage 相关 10 个页面测试文件：44 tests passed
  - `npm run typecheck`：通过

### 9.7 Dataset handler schema mutation route 模板收敛 ✅ 完成

- [x] 新增 `DatasetIPCHandler.registerDatasetRoute()`：
  - 统一 route 注册的 `permission: 'trusted-renderer'`
  - 统一 `try/catch`、可选错误日志和 `handleIPCError()` 返回
- [x] 新增 `DatasetIPCHandler.registerSchemaMutationRoute()`：
  - schema mutation 成功后统一调用 `notifyDatasetSchemaUpdated()`
  - `dataset:schema-updated` channel 仍只保留一处
  - route 本体只描述参数解包和 DuckDB service 调用
- [x] 迁移第一批 schema mutation route：
  - `duckdb:materialize-clean-to-new-columns`
  - `duckdb:update-column-display-config`
  - `duckdb:add-column`
  - `duckdb:update-column`
  - `duckdb:apply-schema`
  - `duckdb:delete-column`
  - `duckdb:reorder-columns`
- [x] 收紧架构护栏：
  - 要求 dataset handler 保留 `registerSchemaMutationRoute`
  - 继续防止 schema update IPC channel 直接散落发送
- [x] 验收通过：
  - `npx vitest run src/main/ipc-handlers/dataset-handler.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`：74 tests passed
  - `npm run typecheck`：通过

### 9.8 P1 final sweep: error model, dependency injection, and large-input boundaries - Done

- [x] P1-2 catch-any cleanup:
  - Production `catch (<name>: any)` is now zero across `src`.
  - Shared unknown-error helpers are used by AI service and JS plugin paths.
  - `CATCH_ANY_BASELINE` is zero and the architecture guard blocks new catch-any usage.
- [x] P1-5 DuckDB delayed dependency cleanup:
  - `DatasetQueryService`, `DatasetExportService`, and `QueryTemplateService` receive delayed dependencies through constructors.
  - Removed production `setQueryEngine()` / `setExportQuerySQLBuilder()` compatibility setters.
  - `DatasetService` and `DuckDBService` now wire QueryEngine/export SQL builder at construction time.
- [x] P1-3 large-input boundary cleanup:
  - `FileStorage.getFileAsBase64()` checks file type and size before reading; default preview limit is 10MB.
  - Attachment upload now supports `file:upload-from-path`, copies in the main process, and keeps a 500MB upload limit.
  - Renderer dataset import no longer uses `File.arrayBuffer() -> base64 -> Buffer.from(base64)` fallback.
  - Plugin `database.importRecordsFromBase64()` validates Base64 format, padding, decoded byte length, and max size before writing temp files.
- [x] P1-1 main entry accessors:
  - Removed exported `getLogger()` / `getDuckDBService()` from `src/main/index.ts`.
  - Guard now requires service access to stay inside `AppRuntime` composition instead of exported globals.
- [x] Verification passed:
  - `npm run typecheck`
  - `npx vitest run src/main/file-storage.test.ts src/core/js-plugin/namespaces/database.test.ts src/main/ipc-handlers/file-handler.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts src/renderer/src/components/DatasetsPage/__tests__/AddRecordDrawer.test.tsx src/renderer/src/services/datasets/datasetMutationService.test.ts`
  - `rg -n "catch\s*\(\s*\w+\s*:\s*any\s*\)" src -g "*.ts" -g "*.tsx" -g "!*.test.ts" -g "!**/__tests__/**"` has no production hits.
  - `rg -n "queryEngine!|setQueryEngine|setExportQuerySQLBuilder|export\s+function\s+get(Logger|DuckDBService)|export\s+let" src/main -g "*.ts" -g "!*.test.ts" -g "!**/__tests__/**"` has no production hits.
  - `rg -n "importDatasetRecordsFromBase64|arrayBufferToBase64|\.arrayBuffer\s*\(|fileFacade\.upload\(" src/renderer/src/components/DatasetsPage src/renderer/src/services/datasets -g "*.ts" -g "*.tsx" -g "!*.test.ts" -g "!**/__tests__/**"` has no production hits.

## 10. P2 follow-up

### 10.1 Browser pool lifecycle, screenshot utilities, and snapshot lazy binding - Done

- [x] Browser pool singleton reset is now awaitable:
  - Added `createBrowserPoolManager()` so tests and future composition can instantiate managers without global singleton state.
  - Changed `resetBrowserPoolManager()` to `async` and await `manager.stop()` instead of fire-and-forget cleanup.
  - Added singleton helper tests for factory independence and awaited reset.
- [x] Browser pool health/reset type cleanup:
  - Replaced health-check `browser.browser as any` probes with `hasBrowserClosedStateProbe()`.
  - Replaced release reset `(browser as any).reset` checks with `hasBrowserResetCapability()`.
  - Architecture guard blocks the old fire-and-forget reset and raw health/reset casts from returning.
- [x] Screenshot/snapshot cleanup:
  - Extracted shared `screenshot-utils.ts` for format, capture mode, and MIME normalization.
  - IntegratedBrowser and RuyiBrowser now use the shared screenshot helpers.
  - `BrowserSnapshotService` supports lazy `getNetworkManager()` / `getConsoleManager()` providers, so snapshots can see capture managers created after browser construction.
  - Added focused tests for screenshot utilities and lazy snapshot capture-manager binding.
- [x] Verification passed:
  - `npm run typecheck`
  - `npx vitest run src/core/browser-automation/screenshot-utils.test.ts src/core/browser-automation/snapshot.test.ts src/core/browser-automation/integrated-browser.screenshot.test.ts src/core/browser-ruyi/ruyi-browser.observation.test.ts src/core/browser-automation/browser-runtime.cross-engine-contract.test.ts src/core/browser-pool/__tests__/pool-manager.test.ts src/core/browser-pool/__tests__/global-pool.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`
  - `rg -n "resetBrowserPoolManager\(\): void|instance\.stop\(\)\.catch|\(browser\.browser as any\)|\(browser as any\)\.reset|networkManager: undefined|consoleManager: undefined" src/core/browser-pool src/core/browser-automation src/core/browser-ruyi -g "*.ts" -g "!*.test.ts" -g "!**/__tests__/**"` has no production hits.
  - `rg -n "function normalizeScreenshotFormat|function normalizeScreenshotCaptureMode|function getMimeTypeForScreenshotFormat" src/core/browser-automation/integrated-browser.ts src/core/browser-ruyi/ruyi-browser.ts` has no hits.

### 10.2 Query pipeline nextContext transition - Done

- [x] Added `QueryPipelineStepResult` with explicit `nextContext`.
- [x] `QueryPipeline.executePhase()` now accepts both legacy mutating steps and new next-context steps, then copies the final context back for existing callers.
- [x] `createBuilderStep()` no longer mutates `context.ctes`, `context.currentTable`, or `context.availableColumns` directly; it builds and returns a new `nextContext`.
- [x] Added pipeline tests for next-context steps and architecture guard coverage for the adapter.
- [x] Removed the dead `executeWithAhoCorasick()` QueryEngine branch; current behavior was already an immediate unsupported-operation error, while the commented legacy body kept obsolete builder-chain mutations in the main file.
- [x] Moved view-level `softDelete` handling into `createSoftDeleteStep()` and registered it before normal filters.
- [x] `PreviewService.buildStepSQL()` now consumes returned `nextContext`, so preview paths stay consistent with pipeline steps.
- [x] Verification passed:
  - `npm run typecheck`
  - `npx vitest run src/core/query-engine/pipeline/QueryPipeline.test.ts src/core/query-engine/QueryEngine.test.ts src/core/query-engine/__tests__/QueryEngine.test.ts src/core/query-engine/builders/FilterBuilder.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`
  - `rg -n "context\.ctes\.push|context\.currentTable\s*=|context\.availableColumns\s*=" src/core/query-engine/pipeline/createBuilderStep.ts` has no hits.
  - `rg -n "applySoftDelete|executeWithAhoCorasick" src/core/query-engine/QueryEngine.ts` has no hits.

### 10.3 Query field-reference validation extraction - Done

- [x] Extracted `FieldReferenceValidator` from `QueryEngine.validateConfig()`:
  - QueryEngine now orchestrates schema validation, dataset column loading, and result merging only.
  - Field existence checks for filter, columns, sort, clean, dedupe, compute, validation, explode, lookup, sample, group, aggregate, and softDelete live in the validator.
  - Aggregate validation now also catches missing `params.orderBy` fields before SQL execution.
- [x] Added focused validator tests and an architecture guard requiring field-reference validation to stay outside QueryEngine orchestration.
- [x] Verification passed:
  - `npm run typecheck`
  - `npx vitest run src/core/query-engine/validators/FieldReferenceValidator.test.ts src/core/query-engine/pipeline/QueryPipeline.test.ts src/core/query-engine/QueryEngine.test.ts src/core/query-engine/__tests__/QueryEngine.test.ts src/core/query-engine/builders/FilterBuilder.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`
  - `npx prettier --check src/core/query-engine/QueryEngine.ts src/core/query-engine/QueryEngine.test.ts src/core/query-engine/pipeline/QueryPipeline.test.ts src/core/query-engine/pipeline/createSoftDeleteStep.ts src/core/query-engine/pipeline/index.ts src/core/query-engine/services/PreviewService.ts src/core/query-engine/validators/FieldReferenceValidator.ts src/core/query-engine/validators/FieldReferenceValidator.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`
  - `git diff --check -- src/core/query-engine/QueryEngine.ts src/core/query-engine/QueryEngine.test.ts src/core/query-engine/pipeline/QueryPipeline.test.ts src/core/query-engine/pipeline/createSoftDeleteStep.ts src/core/query-engine/pipeline/index.ts src/core/query-engine/services/PreviewService.ts src/core/query-engine/validators/FieldReferenceValidator.ts src/core/query-engine/validators/FieldReferenceValidator.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts`

### 10.4 P2-2 QueryEngine contract/test cleanup - Done

- [x] Query builder contracts now support sync and async builders explicitly:
  - Added `MaybePromise<T>` to `IQueryBuilder`.
  - `IQueryBuilder.build()` and `getResultColumns()` now return `MaybePromise`.
  - `SyncQueryBuilder` no longer wraps synchronous implementations in `async` methods.
- [x] QueryEngine test mock no longer uses regex SQL extraction:
  - Replaced `sql.match(...)` parsing in `MockDuckDBService` with a tiny token fixture evaluator.
  - Architecture guard blocks reintroducing the regex mock pattern.

### 10.5 P2-3 MCP/HTTP parameter bag cleanup - Done

- [x] Split MCP route registration options into focused ports:
  - `McpHttpRouteContext`
  - `McpAuthContext`
  - `McpBrowserBindingPort`
  - `McpInvokeQueuePort`
  - `McpSessionLifecyclePort`
- [x] Split HTTP route registration options into focused route contexts:
  - server, sessions, auth, browser, invoke, and errors.
- [x] Updated MCP adapter/route handlers and HTTP composition to pass grouped dependencies only.
- [x] Added architecture guard coverage so `RegisterMcpRoutesOptions` and `RegisterHttpRoutesOptions` stay grouped.

### 10.6 P2-4 IPC manifest schema/auth matrix - Done

- [x] Extended IPC handler helpers so helper-created routes can carry `permission` and `schema` metadata.
- [x] Promoted high-risk IPC route metadata from broad `trusted-renderer` to explicit tiers:
  - file upload/delete/open/image/dataset-file cleanup routes are `privileged`.
  - dataset record import routes are `privileged`.
  - internal browser DevTools config routes are `internal`.
  - download-image and shell open-path routes are `privileged`.
  - plugin import/cloud install/uninstall routes are `privileged`.
  - profile delete, browser pool launch/show/destroy, and browser pool config mutation routes are `privileged`.
- [x] Added schema metadata for the high-risk route set above.
- [x] Added sender-guard wiring for profile browser-pool privileged routes through `registerProfileHandlers(..., { senderGuard })`.
- [x] Added architecture guard coverage for high-risk IPC schema presence and expected permission tiers.

### 10.7 P2 sweep verification - Done

- [x] `npm run typecheck` passed.
- [x] `npx vitest run src/core/query-engine/__tests__/QueryEngine.test.ts src/core/query-engine/QueryEngine.test.ts src/core/query-engine/pipeline/QueryPipeline.test.ts src/main/mcp-http-types.test.ts src/main/mcp-http-session-runtime.test.ts src/main/mcp-server-http.split-contract.test.ts src/main/mcp-server-http.transport-session.test.ts src/main/mcp-server-http.mcp-surface.test.ts src/main/ipc-route-registry.test.ts src/main/ipc-authorization.test.ts src/main/ipc-handlers/utils.test.ts src/main/ipc-handlers/file-handler.test.ts src/main/ipc-handlers/system-handler.test.ts src/main/ipc-handlers/profile-ipc-handler.test.ts src/core/ai-dev/architecture-maintenance-guard.test.ts` passed: 252 tests.
- [x] `npx prettier --check` passed for the P2 touched files.
