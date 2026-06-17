# 天蛇客户端运行手册

本文档记录本地运行、发布验证和常见故障恢复步骤。默认先保护用户数据，再恢复服务。

## 通用处置

1. 记录现象、时间、用户操作和可见错误码。
2. 保留 `x-airpa-trace-id` 或响应 `_meta.traceId`。后续可用观察链路查询同一 trace 的事件、失败 bundle 和 artifact。
3. 先停止重复提交或自动重试，再做恢复操作。
4. 对数据目录、插件目录、索引目录做备份。不要直接删除未知目录。
5. 运行快速验证：

```powershell
npm run typecheck
node scripts/open-source-boundary.js
```

## HNSW 索引损坏

症状：
- 图像搜索或模板匹配启动失败。
- 日志中出现 checksum mismatch、metadata invalid、`.corrupt-*` quarantine。

处置：
1. 记录被隔离的 `.corrupt-*` 文件路径。
2. 确认业务数据仍在原始模板或数据表中。
3. 重启应用，让索引按当前数据重新加载或重建。
4. 若重启后仍失败，备份后移走同目录下成对的 index/meta 文件，再重启触发空索引重建。
5. 验证：

```powershell
npx vitest run src/core/image-search/hnsw-index.test.ts
```

## 数据集 row_count 不一致

症状：
- 数据表实际可查询行数与 UI/metadata 展示行数不一致。
- 导入或追加过程中发生崩溃。

处置：
1. 停止继续导入同一数据集。
2. 重启应用。启动初始化会执行 best-effort row_count reconcile。
3. 对关键数据集执行一次列表/查询，确认展示行数与真实记录一致。
4. 验证：

```powershell
npx vitest run src/main/duckdb/dataset-row-count-reconciliation.test.ts
```

## 插件卡住或停用失败

症状：
- 插件 runtime status 长时间停留在 `starting`、`stopping` 或 `busy`。
- 停用提示仍有命令运行中。
- 日志出现 lifecycle hook timeout、command timeout 或 runtime error。

处置：
1. 记录插件 id、当前 operation、traceId 和最近错误。
2. 优先使用普通停用，避免在命令运行中释放 context/helper。
3. 若普通停用被运行中命令阻止，等待命令预算超时；必要时使用强制停用路径。
4. 对异常插件执行 reload 或 repair。
5. 插件作者应在 `manifest.runtime` 中显式声明预算：

```json
{
  "runtime": {
    "lifecycleHookTimeoutMs": 30000,
    "commandTimeoutMs": 120000,
    "apiTimeoutMs": 120000,
    "isolation": "main-process",
    "highRiskScopes": ["browser", "ffi"]
  }
}
```

6. 验证：

```powershell
npx vitest run src/core/js-plugin/runtime-budget.test.ts src/core/js-plugin/plugin-lifecycle.test.ts src/core/js-plugin/manager.test.ts
```

## HTTP Token 轮换

症状：
- `/api/v1/orchestration/*` 或 `/mcp` 返回 401 / `PERMISSION_DENIED`。
- 客户端或自动化工具使用旧 Bearer Token。

处置：
1. 确认当前 HTTP 合约：
   - `enabled=false`：HTTP/MCP 不开放。
   - `enabled=true` 且 `enableAuth=false`：HTTP 与 MCP 均不要求 Bearer，仅限本机可信环境。
   - `enableAuth=true`：`/api/v1/orchestration/*` 要求 Bearer；`/mcp` 是否要求 Bearer 由 `mcpRequireAuth` 决定。
2. 写入新 token 后重启 HTTP 服务或应用。
3. 更新所有调用方的 `Authorization: Bearer <token>`。
4. 用健康检查、capabilities 和一次最小 invoke 验证。
5. 验证：

```powershell
npx vitest run src/constants/http-api.test.ts src/main/http-server-composition.test.ts src/main/mcp-server-http.auth-invoke.test.ts
```

## 编排幂等冲突

症状：
- 同一 `Idempotency-Key` 返回 running/conflict。
- 客户端重试未完成请求时看到 409。

处置：
1. 使用响应 `_meta.traceId` 和 idempotency key 定位原请求。
2. 若原请求仍 running，等待完成或按业务取消会话。
3. 若请求参数已变更，生成新的 idempotency key。
4. DuckDB 持久化幂等模式下，确认 running reservation 不会重复进入能力执行。

## 打包冒烟失败

症状：
- 发布前打包产物缺少 `app.asar`、native 模块、worker 或 FFI isolated worker。
- 源码测试通过但安装包/目录产物启动失败。

处置：
1. 先跑轻量脚本测试：

```powershell
npx vitest run scripts/package-smoke.test.js
```

2. 再跑真实打包冒烟：

```powershell
npm run test:package-smoke
```

3. 若只需检查已存在产物：

```powershell
node scripts/package-smoke.js
```

4. 失败时优先检查 `electron-builder.yml` 的 `asarUnpack` 和 `scripts/package-smoke.js` 的资源断言。

## 原生能力故障

FFI：
1. 默认使用异步 `call()`，可序列化参数走隔离子进程。
2. 指针、回调等信任路径必须显式使用 `callUnsafeInProcess()`。
3. 崩溃或超时后确认主进程仍存活。

OCR：
1. 默认 wait 模式受 `maxQueue` 约束。
2. 队列满时应拒绝或等待，不应无界增长。

ONNX：
1. 关注模型级并发、推理超时和输入元素上限。
2. 大输入或超时先调低并发，再检查模型配置。

验证：

```powershell
npx vitest run src/core/ffi/library.test.ts src/core/ffi/isolated-runner.test.ts src/core/system-automation/ocr/pool.test.ts src/core/onnx-runtime/onnx-service.test.ts
```

## 日志保留和清理

1. 结构化运行日志由 `@core/logger` 输出；任务日志持久化在 DuckDB `logs` 表中，用于 UI 查询和故障排查。
2. 任务日志保留策略是按时间清理，不是无限增长。默认入口保留最近 7 天，可通过 `cleanup-logs` IPC 调整 `daysToKeep`。
3. 清理操作必须等待 DuckDB 删除完成后再向 UI 返回 deleted 计数；失败时返回 IPC 错误，不应把 Promise 当作成功结果。
4. 验证：
```powershell
npx vitest run src/main/duckdb/log-service.test.ts src/main/ipc-handlers/system-handler.test.ts
```

## 数据库迁移和回滚策略

1. 主数据库迁移采用前滚策略：每个 migration 的全部 `up` 步骤和 `schema_migrations` 记录写入必须在同一个 DuckDB 事务内完成。
2. 已应用迁移用 checksum 防漂移；修改已经发布的 migration 会在启动迁移时失败，而不是静默套用新定义。
3. 当前不自动执行 `down`。失败恢复优先使用升级前数据目录备份；确需手工回退时，先备份用户数据，再按 `schema_migrations.rollback_sql` 和实际 schema 状态人工处理。
4. 新增 migration 应保持幂等前置检查、清晰错误信息和失败可重入；涉及跨文件或跨目录的步骤必须配套启动期补偿扫描。
5. 验证：
```powershell
npx vitest run src/main/duckdb/migration-engine.test.ts
```

## 版本协调矩阵

排查升级问题时先记录以下版本，避免只看 app version：

| 项 | 来源 | 用途 |
| --- | --- | --- |
| App version | `package.json` / Electron app metadata | 判断发布包 |
| DB schema head | `schema_migrations` 最新记录 | 判断数据库迁移进度 |
| MCP protocol | `/health` 的 `mcpProtocolVersion` | 判断 HTTP/MCP 客户端兼容 |
| Runtime fingerprint | `/health` 的 runtime fingerprint | 判断 build、SDK shim 和 runtime 状态 |
| Browser runtime | 设置页 runtime status / `/health` | 判断 Electron/extension/Firefox/Cloak 能力 |
| Plugin version | 插件 manifest | 判断插件升级与卸载恢复 |

## TaskQueue 与 Scheduler 历史边界

1. `TaskQueue` 是进程内瞬态队列，只保留最近完成任务的内存历史；进程重启后不承诺保留。
2. 需要审计、恢复或长期排障的任务应走 scheduler 持久化路径，或把结果写入业务表、runtime observation、failure bundle。
3. 非幂等副作用任务必须显式设置 `retryable: false`，或提供稳定的 `idempotencyKey`。
4. 所有新任务应保留 `traceId`，用同一 trace 串联日志、浏览器、数据层和 observation 查询。
