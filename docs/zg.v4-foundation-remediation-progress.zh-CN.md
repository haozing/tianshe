# Tianshe v4 地基整改实施进度

> 来源：`docs/zg.v4-foundation-remediation-plan.zh-CN.md` 第 11 节。  
> 规则：不漏项；未完全满足验收的任务只标“部分完成”或“未开始”。

## 状态汇总

| 状态 | 数量 |
| --- | ---: |
| 已完成 | 33 |
| 部分完成 | 0 |
| 未开始 | 0 |

## 最近验证

2026-06-22 当前复核，结果：

- P0+P1 专项组合（同下方 P1 未完成项补齐后验证命令）：通过，209 tests。
- `npm run typecheck`：通过。
- `npm run test:open`：通过，26 tests。
- `npm run lint`：0 errors；226 warnings（既有 warning，未作为本轮阻塞项处理）。

2026-06-22 P1 未完成项补齐后验证，结果：

- `npx vitest run src/core/site-adapter-runtime/read-only-runner.test.ts src/core/site-adapter-runtime/sandbox/import-boundary.test.ts src/core/site-adapter-runtime/repair/repair-scope.test.ts src/core/site-adapter-runtime/repair/repair-evidence.test.ts src/core/site-adapter-runtime/state-machine.test.ts src/core/browser-pool/runtime-capability-registry.promotion-gate.test.ts src/core/browser-runtime/capability-contract.test.ts src/core/browser-runtime/runtime-planner.test.ts src/core/browser-runtime/window-control-contract.test.ts src/main/duckdb/profile-login-state-service.test.ts src/main/duckdb/dataset-provenance-service.test.ts src/main/mcp-guidance-content.golden.test.ts src/main/http-auth-middleware.test.ts src/core/ai-dev/capabilities/browser/handlers/cookies.test.ts src/core/observability/browser-failure-bundle.test.ts src/core/observability/observation-service.test.ts src/main/observation-query-service.test.ts src/constants/http-api.test.ts src/core/ai-dev/capabilities/browser/tool-manifest.test.ts src/core/ai-dev/capabilities/schema-parity.test.ts src/core/ai-dev/orchestration/capability-registry.test.ts src/core/ai-dev/orchestration/lifecycle-contract.test.ts src/main/http-browser-pool-adapter.test.ts src/main/http-server-composition.test.ts src/main/mcp-http-runtime-availability.test.ts src/main/ipc-handlers/profile-ipc-handler.test.ts src/main/ipc-handlers/account-ipc-handler.test.ts src/main/duckdb/profile-service.partition.test.ts src/core/browser-pool/__tests__/pool-manager.test.ts src/core/browser-pool/__tests__/profile-live-session-lease.test.ts src/main/profile/browser-runtime-providers.test.ts src/types/browser-runtime.test.ts`：通过，209 tests。
- `npm run typecheck`：通过。
- `npm run test:open`：通过，26 tests。
- `npm run lint`：0 errors；仍有仓库既有 warnings（本次为 226 warnings），未作为本轮阻塞项处理。

2026-06-22 复审缺口补强后验证，结果：

- `npx vitest run src/main/http-browser-pool-adapter.test.ts src/core/observability/observation-service.test.ts src/core/observability/browser-failure-bundle.test.ts src/core/site-adapter-runtime/sandbox/import-boundary.test.ts src/main/http-server-composition.test.ts src/core/browser-pool/runtime-capability-registry.promotion-gate.test.ts src/main/ipc-handlers/profile-ipc-handler.test.ts src/main/ipc-handlers/account-ipc-handler.test.ts src/core/resource-coordinator.test.ts src/core/browser-pool/__tests__/profile-live-session-lease.test.ts`：通过，61 tests。
- `npx vitest run src/core/site-adapter-runtime/read-only-runner.test.ts src/core/site-adapter-runtime/sandbox/import-boundary.test.ts src/core/site-adapter-runtime/repair/repair-scope.test.ts src/core/site-adapter-runtime/repair/repair-evidence.test.ts src/core/browser-pool/runtime-capability-registry.promotion-gate.test.ts src/main/duckdb/profile-login-state-service.test.ts src/main/mcp-guidance-content.golden.test.ts src/main/http-auth-middleware.test.ts src/core/ai-dev/capabilities/browser/handlers/cookies.test.ts src/core/observability/browser-failure-bundle.test.ts src/core/observability/observation-service.test.ts src/main/observation-query-service.test.ts src/constants/http-api.test.ts src/core/ai-dev/capabilities/browser/tool-manifest.test.ts src/core/ai-dev/orchestration/capability-registry.test.ts src/main/http-browser-pool-adapter.test.ts src/main/http-server-composition.test.ts src/main/ipc-handlers/profile-ipc-handler.test.ts src/main/duckdb/profile-service.partition.test.ts src/core/browser-pool/__tests__/pool-manager.test.ts src/types/browser-runtime.test.ts`：通过，156 tests。
- `npm run typecheck`：通过。
- `npm run test:open`：通过，26 tests。
- `npm run lint`：0 errors；仍有仓库既有 warnings（本次为 226 warnings），未作为本轮 P0 阻塞项处理。

2026-06-22 复核 P0 闭环，结果：

- `npx vitest run src/core/site-adapter-runtime/read-only-runner.test.ts src/core/site-adapter-runtime/sandbox/import-boundary.test.ts src/core/site-adapter-runtime/repair/repair-scope.test.ts src/core/site-adapter-runtime/repair/repair-evidence.test.ts src/core/browser-pool/runtime-capability-registry.promotion-gate.test.ts`：通过，16 tests。
- `npx vitest run src/main/duckdb/profile-login-state-service.test.ts src/main/mcp-guidance-content.golden.test.ts src/main/http-auth-middleware.test.ts src/core/ai-dev/capabilities/browser/handlers/cookies.test.ts src/core/observability/browser-failure-bundle.test.ts src/core/observability/observation-service.test.ts src/main/observation-query-service.test.ts`：通过，18 tests。
- `npx vitest run src/constants/http-api.test.ts src/core/ai-dev/capabilities/browser/tool-manifest.test.ts src/core/ai-dev/orchestration/capability-registry.test.ts src/main/http-browser-pool-adapter.test.ts src/main/ipc-handlers/profile-ipc-handler.test.ts src/main/duckdb/profile-service.partition.test.ts src/core/browser-pool/__tests__/pool-manager.test.ts src/types/browser-runtime.test.ts`：通过，110 tests。
- `npm run typecheck`：通过。
- `npm run test:open`：通过，26 tests。
- `npm run lint`：0 errors；仍有仓库既有 warnings，未作为本轮 P0 阻塞项处理。

## 任务账本

| ID | 优先级 | 状态 | 当前证据 | 未完成事项 |
| --- | --- | --- | --- | --- |
| P0-BR-01 | P0 | 已完成 | `src/core/browser-pool/runtime-capability-registry.promotion-gate.test.ts` 覆盖 descriptor completeness、supported/planned 不一致、Cloak 等 runtime evidence；复审后已补 capability-level evidence baseline，descriptor 多声明一个 supported capability 但未补 evidence map 会失败；P1 已补完整 capability contract。 | - |
| P1-BR-01 | P1 | 已完成 | `src/core/browser-runtime/capability-contract.ts` 定义 `BrowserCapabilityContract`、requiredMethods、semanticChecks、degradedModes、toolRequirements；`capability-contract.test.ts` 覆盖所有 `BROWSER_CAPABILITY_NAMES`。 | - |
| P1-BR-02 | P1 | 已完成 | `runtime-capability-registry.ts` 在加载 static descriptor 时调用 contract assertion；`capability-contract.test.ts`/`runtime-capability-registry.promotion-gate.test.ts` 覆盖 descriptor 完整性、错字段、supported/planned 冲突和所有 unsupported notes。 | - |
| P1-BR-03 | P1 | 已完成 | `src/types/browser-interface.ts` 将 `BrowserCore` 收敛为 runtime introspection、abort facade、navigation core，并新增 `BrowserCapabilitySurface`；`capability-contract.test.ts` 固定最小 core 与 capability method 边界。 | - |
| P1-BR-04 | P1 | 已完成 | `createBrowserRuntimeCapabilityMatrix()` 从 descriptor + contract 生成支持矩阵；promotion gate 对每个 runtime supported capability 要求 method presence evidence，关键能力要求 semantic smoke/canary evidence。 | - |
| P1-BR-05 | P1 | 已完成 | `src/main/profile/browser-runtime-providers.ts` 要求 factory 返回 `runtimeDescriptor` 并执行 contract assertion；`browser-runtime-providers.test.ts` 覆盖禁止静态 fallback 和保留动态 descriptor。 | - |
| P1-TOOL-01 | P1 | 已完成 | `src/core/ai-dev/capabilities/browser/tool-manifest.ts` 为每个 browser tool 声明精确 `browserCapability:*`；`tool-manifest.test.ts` 与 `mcp-http-runtime-availability.test.ts` 覆盖 requirement 与缺失能力提示。 | - |
| P1-TOOL-02 | P1 | 已完成 | `browser_observe` 输出 schema/handler 返回 `navigationPerformed`、`afterUrl`、`sideEffect`；guidance 保留导航+观察语义，并由 browser catalog schema 固定。 | - |
| P1-PLAN-01 | P1 | 已完成 | `src/core/browser-runtime/runtime-planner.ts` 根据 requiredCapabilities、profile runtime、login state、visibility、binding lock 生成 runtime/profile plan；`runtime-planner.test.ts` 覆盖 ready、切 profile/runtime、locked blocked。 | - |
| P1-SESSION-01 | P1 | 已完成 | `session_prepare` 支持 `planOnly=true`/`requiredCapabilities`/`site`，并新增 public `runtime_plan` capability；`session-catalog.ts`、`mcp-http-runtime-availability.ts` 将 plan 接入工具可用性提示。 | - |
| P0-LOGIN-01 | P0 | 已完成 | `src/main/duckdb/profile-login-state-service.ts` 新增 `profile_login_states` 表、查询/upsert/delete；`src/main/duckdb/service.ts` 初始化并暴露服务；`src/main/duckdb/profile-login-state-service.test.ts` 覆盖 upsert/latest/evidence 脱敏。 | - |
| P0-LOGIN-02 | P0 | 已完成 | `profile_ensure_logged_in` 已加入 `src/core/ai-dev/capabilities/profile-catalog.ts`，接入 `profileLoginStateGateway` 与 `mcpSessionGateway.prepareCurrentSession`，复用 profile→runtime 绑定，返回 `logged_in/needs_manual_login/captcha/two_factor/blocked/unknown` 状态并不返回凭据/cookie/token；站点级 verifier 作为业务 adapter 扩展点保留。 | - |
| P0-LOGIN-03 | P0 | 已完成 | `src/main/mcp-guidance-content.ts` 和 `src/main/mcp-guidance-content.golden.test.ts` 禁止默认建议模型输入凭据。 | - |
| P1-WIN-01 | P1 | 已完成 | `src/core/browser-runtime/window-control-contract.ts` 定义 window/focus/restore/capture/osInput/manualHandoff contract；`window-control-contract.test.ts` 覆盖 Electron supported 与 Cloak degraded。 | - |
| P1-WIN-02 | P1 | 已完成 | `interaction-health.ts` 合并 `windowControl` descriptor；`browser-catalog.ts` 将 `windowControl` 纳入 observe/snapshot/screenshot/debug_state 输出 schema。 | - |
| P0-EXT-01 | P0 | 已完成 | `src/core/node-extractor-poc/README.md` 明确迁移到 `src/core/site-adapter-runtime`。 | - |
| P0-EXT-02 | P0 | 已完成 | `src/core/site-adapter-runtime/` 已包含通用 types、manifest validation、read-only runner、Extractor/Verifier contract、diagnostics、repairScope、sandbox import boundary。 | - |
| P0-EXT-03 | P0 | 已完成 | 已新增 `examples/web-site-adapter-static-product/`，含 adapter、extractors、verifiers、fixtures、expected、README；`read-only-runner.test.ts` 覆盖 fixture runner 与 `BrowserInterface.snapshot()` target runtime canary。 | - |
| P0-EXT-04 | P0 | 已完成 | `src/core/site-adapter-runtime/sandbox/import-boundary.ts` 和测试禁止生产 adapter import Node/Electron/Playwright/DuckDB；复审后已补 CommonJS `require()` 检测，覆盖 `.js/.cjs`。 | - |
| P1-EXT-05 | P1 | 已完成 | `src/core/site-adapter-runtime/state-machine.ts` 定义 `SiteAdapterRunState`、`ProcedureTransition`、`InteractorActionTraceEntry`、replay 与敏感字段清理；`state-machine.test.ts` 覆盖多步骤 replay 和 secret/browser/page 剔除。 | - |
| P0-REPAIR-01 | P0 | 已完成 | `src/core/site-adapter-runtime/repair/repair-scope.ts` 和测试覆盖 path normalize、workspace traversal、framework core deny、example allow。 | - |
| P0-REPAIR-02 | P0 | 已完成 | `src/core/site-adapter-runtime/repair/repair-evidence.ts` 要求 selector diagnostics、fixture、expected、before/after evidence，并复用 repairScope 校验 changedFiles；`read-only-runner` 失败时写入 `site_adapter_repair_evidence`；测试覆盖 framework core 禁止与字段定位；自动 apply/发布链路不在 P0 范围内。 | - |
| P0-SEC-01 | P0 | 已完成 | `agentHandMode` 已加入 HTTP 配置归一化、REST/MCP route config、auth middleware 与 scope enforcement；复审后 `getHttpApiAuthToken()` 在底层 server/composition 直接调用时也把 `agentHandMode` 视同 auth enabled，并新增 composition 集成测试覆盖 `enableAuth=false + agentHandMode=true`。 | - |
| P0-SEC-02 | P0 | 已完成 | `browser_cookies_get` 非 public 且输出 redacted；ObservationService/failure bundle 脱敏 Authorization/Set-Cookie/cookie value/token；复审后已补普通字符串、error message/stack、currentUrl query、console message 的字符串级脱敏回归。 | - |
| P0-GOLD-01 | P0 | 已完成 | `src/main/mcp-guidance-content.golden.test.ts` 覆盖默认 guidance、登录异常、只读 Site Adapter 抽取/修复 evidence 路径，禁止默认退回 Playwright page API/generic MCP/模型输入凭据。 | - |
| P0-OBS-01 | P0 | 已完成 | 新增 `site_adapter_result/site_adapter_failure/site_adapter_repair_evidence` artifact 类型；failure bundle 可查询 repair evidence；read-only runner 在失败时实际写入 result/failure/repair evidence artifacts。 | - |
| P1-OBS-02 | P1 | 已完成 | `RuntimeArtifactType` 增加 `site_adapter_repair_bundle`、`interactor_action_trace`、`procedure_state_transition`；`read-only-runner.test.ts` 和 `observation-query-service.test.ts` 覆盖失败 bundle 查询。 | - |
| P1-DATA-01 | P1 | 已完成 | `src/main/duckdb/dataset-provenance-service.ts` 新增 run ledger 与 record provenance sidecar；`dataset-service.ts`/facade 暴露 provenance 查询。 | - |
| P1-DATA-02 | P1 | 已完成 | `DatasetRecordMutationService` 新增 staged write plan/commit，rows 与 provenance 在同一 DuckDB transaction；`dataset-provenance-service.test.ts` 覆盖失败回滚不留下半截 provenance。 | - |
| P1-SCHEMA-01 | P1 | 已完成 | `src/core/ai-dev/capabilities/schema-parity.test.ts` 覆盖 public MCP、assistant surface manifest、OpenAPI invoke/list envelope 与 capability schema 基本一致性。 | - |
| P1-LIFE-01 | P1 | 已完成 | `src/core/ai-dev/orchestration/lifecycle-contract.ts` 定义 capability invocation、MCP session、browser lease、Site Adapter run、dataset write 生命周期规则；abort/retry/withAbortSignal、Site Adapter abort、staged dataset write 回滚均有测试覆盖。 | - |
| P0-LOGIN-04 | P0 | 已完成 | `electron-webcontents` descriptor/profile helper 标为 persistent；`src/main/duckdb/profile-service.partition.test.ts` 固定 `persist:profile-*` partition；`pool-manager.test.ts` 覆盖默认 release 不清持久 profile 存储；login state/ensure_logged_in 已把 electron 当登录承载 runtime。 | - |
| P0-SHARE-01 | P0 | 已完成 | `src/main/http-browser-pool-adapter.ts` 阻止 MCP 静默抢占 human(`ipc`) 持有的 profile，并发出 `browser:handoff-requested`；`src/core/browser-pool/events.ts`/`plugin-lease-strategy.ts` 新增 `browser:lock-handoff`，带 `pausePreviousHolder=true`；`profile:pool-launch` 在发现 MCP/HTTP agent 持锁时走 human-priority takeover；复审后 `ResourceCoordinator`/profile live-session lease 已记录 owner source，覆盖 human 已持 profile lease 但 browser 尚未进入 pool 的竞态窗口；UI 呈现由已完成的 P1 window/manual-handoff contract 承接。 | - |
