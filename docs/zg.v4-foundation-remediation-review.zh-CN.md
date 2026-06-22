# Tianshe v4 地基整改复审报告

复审日期：2026-06-22  
复审对象：

- `docs/zg.v4-foundation-remediation-plan.zh-CN.md` 第 11 节任务表。
- `docs/zg.v4-foundation-remediation-progress.zh-CN.md` 当前进度账本。
- `docs/zg.v4-foundation-remediation-review-test-plan.zh-CN.md` 复审测试规划。
- 当前工作树中的 tracked diff、untracked 新增文件、关键测试与实现代码。

## 1. 总结

当前复核结论：本报告最初指出的 5 个 P0 复审缺口，以及 P1 清单中标为“部分完成/未开始”的项目，均已补齐并通过专项验证。当前进度账本状态为：

| 状态 | 当前数量 |
| --- | ---: |
| 已完成 | 33 |
| 部分完成 | 0 |
| 未开始 | 0 |

本报告第 2-8 节保留的是补强前的原始复审发现；第 9-11 节记录了后续补强与当前关闭结论。

补强前复审基线如下：

| 类别 | 补强前进度文档 | 当时复审建议 |
| --- | ---: | ---: |
| P0 已完成 | 16 | 11 |
| P0 部分完成/需补 | 0 | 5 |
| P1 部分完成 | 1 | 1 |
| P1 未开始 | 16 | 16 |

已关闭的原 P0 缺口：

- `P0-BR-01`：promotion gate 只检查 evidence 文件存在，不能阻止只改 descriptor 不补测试。
- `P0-EXT-04`：sandbox import boundary 未覆盖 CommonJS `require()`。
- `P0-SEC-01`：`agentHandMode` 强制 auth 依赖上层先 normalize，底层 server/composition 直接调用时可绕过。
- `P0-SEC-02`：Observation/error/failure bundle 对普通字符串、error message、stack、console/currentUrl 的敏感文本脱敏不足。
- `P0-SHARE-01`：human-priority 只覆盖“可见 ipc locked browser”，未覆盖“human 已持有 profile lease 但 browser 尚未进入 pool”的竞态窗口。

已作为非阻塞扩展点或补强证据关闭的项：

- `P0-REPAIR-02`：repair scope/evidence、changedFiles 校验和失败 evidence 写入已落地；官方站点路径策略作为后续业务 adapter policy 扩展点处理。
- `P0-LOGIN-04`：Electron persistent descriptor、`persist:profile-*` partition、release 不清持久存储和 login state 承载 runtime 均已有测试或账本证据。

## 2. 高优先级发现（补强前，已关闭）

### R-01：`P0-SHARE-01` 仍有静默抢占窗口（补强前发现，已关闭）

严重级别：高  
涉及文件：

- `src/main/http-browser-pool-adapter.ts:222-339`
- `src/core/browser-pool/profile-live-session-lease.ts:42-58`
- `src/core/resource-coordinator.ts:305-314`
- `src/main/http-browser-pool-adapter.test.ts:405-445`

计划验收要求：

> human(ipc) 持有时 agent 不静默抢占；接管发通知并暂停；ipc<->mcp 双向交接回归覆盖。

当前实现已经做到：

- 当池里能看到 `lockedBy.source === 'ipc'` 的 browser 时，`tryTakeoverLockedBrowser()` 会抛 `BrowserManualHandoffRequiredError`，并发出 `browser:handoff-requested`。
- `plugin-lease-strategy.ts` 在接管 locked browser 时发出 `browser:lock-handoff`，携带 `pausePreviousHolder: true`。
- IPC 发起 `profile:pool-launch` 时能从 `mcp/http` 持锁 browser 接回。

缺口：

- `tryTakeoverProfileLeaseAndAcquire()` 在 `source === 'mcp'` 且 profile lease 已被占用、但 pool 暂时没有 locked browser 时，会直接调用 `takeoverProfileLiveSessionLease(profileId)`。
- `profile-live-session-lease.ts` 和 `resource-coordinator.ts` 只保存 `ownerToken`，没有保存 `source/controllerType`，因此这条路径无法知道当前 lease 持有者是不是 human IPC。
- 测试 `allows mcp to take over a held profile lease even when no pooled browser is visible yet` 把这种行为固定成允许行为。

实际风险：

1. Human IPC 启动 profile 时，先 acquire profile lease，再 acquire browser。
2. 在“lease 已持有、browser 尚未进入 pool/尚未 locked”的短窗口里，MCP agent 发起 acquire。
3. MCP 看不到 ipc locked browser，于是 handoff profile lease 并 acquire。
4. 旧 human lease release 时因 ownerToken 已变更而不会释放新 owner；human 和 agent 的接管语义被打散。

建议：

- 给 profile live-session lease 增加 `source/controllerType` 元数据，至少能区分 `ipc`、`mcp/http`、`plugin/internal`。
- MCP 只允许接管 agent/plugin 持有的 lease；如果 lease holder 是 `ipc/human`，返回 handoff-required，并发 `browser:handoff-requested`。
- 修改或拆分当前“无可见 browser 时允许 MCP 接管 held lease”的测试，明确仅允许 plugin/agent lease，不允许 human lease。

### R-02：`P0-SEC-02` 对 error message/stack/普通字符串脱敏不足（补强前发现，已关闭）

严重级别：高  
涉及文件：

- `src/core/observability/observation-service.ts:92-128`
- `src/core/observability/observation-service.ts:130-141`
- `src/core/observability/browser-failure-bundle.ts:79-113`
- `src/main/observation-query-service.ts:142-177`
- `src/utils/redaction.ts`

计划验收要求：

> 默认 MCP 输出、trace、failure bundle、repair bundle 不含 cookie value / Authorization / Set-Cookie。

当前实现已经做到：

- `browser_cookies_get` 从输出中移除 cookie `value`。
- `ObservationService` 对对象 key 为 `authorization`、`cookie`、`set-cookie`、`token` 等字段做 `[redacted]`。
- cookie-like object 的 `value` 会被 redacted。
- 测试覆盖了 artifact data 中的 request/response headers 和 cookie object。

缺口：

- `normalizeObservationError()` 直接写入 `error.message` 和 `error.stack`，没有调用 `redactSensitiveText()`。
- `summarizeForObservation()` 对普通字符串只截断，不做敏感文本替换。
- `browser-failure-bundle.ts` 会把 console messages、network summary、currentUrl 等作为 artifact data；其中普通字符串如果包含 `Authorization: Bearer ...`、`Set-Cookie: ...`、`token=...`，不会被脱敏。
- `observation-query-service.ts` 会把 failed event 的 `error` 和 `failedEvent` 原样放入 failure bundle。

现有测试盲区：

- `observation-service.test.ts` 只测了 sensitive key 下的值，不测普通字符串。
- 没有覆盖 `new Error('Authorization: Bearer secret')`、`stack`、console message、currentUrl query token。

建议：

- 在 `ObservationService` 中对所有字符串调用 `redactSensitiveText()` 后再截断。
- `normalizeObservationError()` 对 message/stack 使用 `redactSensitiveText()`。
- 增加回归测试：
  - error message 中包含 `Authorization: Bearer secret`。
  - stack 中包含 `Set-Cookie: sid=secret`。
  - console tail 中包含 token。
  - currentUrl 中包含 `?token=secret`。
  - site adapter repair evidence 中的 fixture/snapshot 字符串包含敏感文本。

### R-03：`P0-EXT-04` import boundary 可被 `require()` 绕过（补强前发现，已关闭）

严重级别：中  
涉及文件：

- `src/core/site-adapter-runtime/sandbox/import-boundary.ts:13-17`
- `src/core/site-adapter-runtime/sandbox/import-boundary.ts:40-54`
- `src/core/site-adapter-runtime/sandbox/import-boundary.test.ts`

计划验收要求：

> 禁止生产 adapter import Node/Electron/Playwright/DuckDB。

当前实现已经做到：

- 扫描 `.ts/.tsx/.js/.mjs/.cjs` 文件。
- 能识别 ESM `import ... from`、`export ... from`、`import('...')`。
- 能分类 `node:*`、`fs/path/os/child_process/crypto`、`electron`、`playwright(-core)`、`@duckdb/node-api/duckdb`。

缺口：

- 没有识别 CommonJS `require('fs')`、`require('electron')`、`require('playwright-core')`。
- 因为扫描扩展包含 `.js/.cjs`，这不是理论问题；实际 adapter 可以用 CommonJS 写法绕过。
- 也没有覆盖 `module.createRequire()`、`eval("require('fs')")` 等更隐蔽写法；P0 至少应覆盖直接 `require()`。

建议：

- 增加 `\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)` 模式。
- 测试中加入 `.js/.cjs` adapter 文件，分别验证 `require('fs')`、`require('electron')`、`require('playwright-core')`、`require('@duckdb/node-api')`。
- 若要更稳，改用 TypeScript/ESTree parser 做 import/require AST 检查，避免 regex 漏报和误报。

### R-04：`P0-BR-01` promotion gate 不是“promotion” gate（补强前发现，已关闭）

严重级别：中  
涉及文件：

- `src/core/browser-pool/runtime-capability-registry.promotion-gate.test.ts:42-77`
- `src/core/browser-pool/runtime-capability-registry.ts`

计划验收要求：

> 能力从 `planned/unsupported` 提升到 `experimental/supported` 时，必须同改动提交 method presence test；关键能力必须提交 semantic smoke/canary 证据。没有测试证据时 descriptor 提升失败；Cloak 等 runtime 也被覆盖。

当前实现已经做到：

- 检查每个 static descriptor 覆盖全部 `BROWSER_CAPABILITY_NAMES`。
- 禁止 `supported === true && stability === 'planned'`。
- unsupported 且非 planned 时要求 notes。
- 每个 runtime 有一个 hard-coded evidence 文件路径，并检查文件存在。
- critical capability supported 时要求 semanticSmokeTest 路径存在。

缺口：

- 没有检测“本次改动是否把某个 capability 提升为 supported/experimental”。
- 没有 per-capability evidence；一个 runtime 只要已有 evidence 文件，后续任意 capability 提升都能复用旧文件通过。
- 没有验证 evidence 文件确实覆盖被提升的 capability。
- 没有和 git baseline、snapshot、contract map、或 generated support matrix 建立关系。

建议：

- 引入 `capability-contract` 或至少一份 `runtimeCapabilityEvidence` map，粒度到 `runtimeId + capabilityName`。
- promotion gate 对 descriptor 做 snapshot/baseline diff；新增 supported/experimental 时必须找到对应 evidence。
- evidence 不只检查文件存在，还要检查测试名/metadata/contract 覆盖 capability。
- 后续 P1-BR-01/P1-BR-02 可以承接完整 contract，但 P0 gate 需要先把“只改 descriptor 不补测试”拦住。

### R-05：`P0-SEC-01` 的 `agentHandMode` 强制 auth 依赖上层 normalize（补强前发现，已关闭）

严重级别：中  
涉及文件：

- `src/constants/http-api.ts:98-123`
- `src/main/http-auth-middleware.ts:32-40`
- `src/main/http-server-composition.ts:108-116`
- `src/main/mcp-server-http.ts:82-103`
- `src/main/index.ts:326-379`

计划验收要求：

> `agentHandMode` 开启后强制 auth/scope；无 token/scope 不能调 MCP 敏感能力。

当前实现已经做到：

- `normalizeHttpApiConfig()` 中，`agentHandMode: true` 会强制：
  - `enableAuth: true`
  - `mcpRequireAuth: true`
  - `enforceOrchestrationScopes: true`
- `mcp-http-adapter.ts` 和 `orchestration-http-routes.ts` 在 `agentHandMode` 时强制 `enforceScopes: true`。
- `http-auth-middleware.ts` 在 `agentHandMode` 时强制 `/mcp` 需要 token。
- 主启动路径 `index.ts` 会 normalize store config，再传给 server。

缺口：

- `createHttpServerComposition()` 只调用 `getHttpApiAuthToken(options.restApiConfig)`，而这个 guard 只看 `enableAuth`，不看 `agentHandMode`。
- `AirpaHttpMcpServer` 构造函数直接接收 `RestApiConfig` 并传给 composition，没有在该层 normalize。
- 因此直接使用导出的 `createHttpMcpServer()`/`AirpaHttpMcpServer`/`createHttpServerComposition()` 时，如果传入 `{ agentHandMode: true, enableAuth: false }`，auth middleware 不会注册。

建议：

- 在 server/composition 边界再次 normalize，或让 `getHttpApiAuthToken()` 把 `agentHandMode` 当作 auth enabled。
- 增加集成测试：直接调用 `createHttpServerComposition({ restApiConfig: { agentHandMode: true, enableAuth: false, token: 'secret' } })`，断言 `/mcp` 和 orchestration route 无 token 返回 401。
- 如果设计要求所有调用方必须传 normalized config，需要在类型或函数名上明确，并加 assertion，避免安全语义靠约定。

## 3. P0 逐项复审账本（补强前快照）

| ID | 计划验收核心 | 当前证据 | 复审判定 | 细节/风险 |
| --- | --- | --- | --- | --- |
| P0-BR-01 | descriptor promotion 必须绑定测试证据；Cloak 覆盖 | `runtime-capability-registry.promotion-gate.test.ts` | 部分完成 | 只检查 evidence 文件存在，不检查 capability-level promotion。见 R-04。 |
| P0-LOGIN-01 | 新增 login state 表，记录 site/profile/account/runtime/status/evidence，可查询 | `profile-login-state-service.ts`、`service.ts`、测试 | 通过 | 表、index、upsert/get/delete、evidence redaction 均有实现。 |
| P0-LOGIN-02 | 新增 `profile.ensure_logged_in`，复用 profile->runtime 绑定，返回 6 类状态 | `profile-catalog.ts`、capability registry test | 基本通过 | 实际工具名为 `profile_ensure_logged_in`。能返回 required statuses，接入 `profileLoginStateGateway` 和 `prepareCurrentSession`。站点级 verifier 仍后置。 |
| P0-LOGIN-03 | guidance 禁止模型输入密码，改走 ensure/login handoff | `mcp-guidance-content.ts`、golden test | 通过 | 默认 guidance/login guide 都包含 human handoff，不再建议模型输入凭据。 |
| P0-LOGIN-04 | Electron profileMode persistent；release 不清 `persist:profile-*`；login state 把 electron 当承载 runtime | `runtime-capability-registry.ts`、`browser-runtime.ts`、`profile-service.partition.test.ts`、`pool-manager.test.ts` | 基本通过 | descriptor/partition/release 有证据；真实登录态跨 acquire 的证据仍偏间接。建议补 cookie/localStorage 级 canary。 |
| P0-SHARE-01 | human(ipc) 持有时 agent 不静默抢占；通知+暂停；双向交接测试 | `http-browser-pool-adapter.ts`、`plugin-lease-strategy.ts`、IPC tests | 部分完成 | 覆盖可见 ipc locked browser；未覆盖 human 持 profile lease 但无 visible browser 的竞态。见 R-01。 |
| P0-EXT-01 | 删除空 PoC 或 README 明确迁移 | `src/core/node-extractor-poc/README.md` | 通过 | README 明确 PoC 不再是 runtime entrypoint，指向 `src/core/site-adapter-runtime`。 |
| P0-EXT-02 | core 只放通用 Site Adapter runtime，不放站点业务代码；fixture runner 通过 | `src/core/site-adapter-runtime/**` | 通过 | types/manifest/read-only runner/diagnostics/repair/sandbox 均存在。未发现 1688 等站点 adapter 混入 core。 |
| P0-EXT-03 | 第一个真实只读示例 adapter，含 extractor/verifier/fixture/expected/README；fixture runner 和 runtime canary | `examples/web-site-adapter-static-product/**`、`read-only-runner.test.ts` | 通过 | 示例完整，测试覆盖 fixture 与 `BrowserInterface.snapshot()` canary。 |
| P0-EXT-04 | import boundary 禁止生产 adapter import Node/Electron/Playwright/DuckDB | `sandbox/import-boundary.ts`、测试 | 部分完成 | ESM import/dynamic import 有覆盖；CommonJS `require()` 可绕过。见 R-03。 |
| P0-REPAIR-01 | repairScope path normalize、allow/deny、path traversal；拒绝 `src/main/**` 和 framework core | `repair-scope.ts`、测试 | 通过 | 默认 deny roots 包含 `src/main`、`src/core/site-adapter-runtime`；测试覆盖 traversal/core deny/example allow。 |
| P0-REPAIR-02 | repair 只能改站点 extractors/verifiers/fixtures/expected；evidence 带 selector diagnostics、fixture、expected、before/after | `repair-evidence.ts`、`read-only-runner.ts`、测试 | 基本通过/需补证据 | evidence 结构完整，failure 会写 `site_adapter_repair_evidence`。但 official site adapter 路径未明确，自动 failure evidence 的 `changedFiles` 为空属于合理 pre-repair 状态。 |
| P0-SEC-01 | agentHandMode 开启后强制 auth/scope | `http-api.ts`、`http-auth-middleware.ts`、MCP/REST executor | 部分完成 | 主启动路径安全；导出的底层 server/composition 直接传未 normalized config 时可绕过。见 R-05。 |
| P0-SEC-02 | cookie tool 非 public；默认 MCP/trace/failure/repair bundle 脱敏 cookie/Auth/Set-Cookie | `tool-manifest.test.ts`、cookies handler、Observation tests | 部分完成 | cookie API 输出和 sensitive-key artifacts 有覆盖；error message/stack/普通字符串未脱敏。见 R-02。 |
| P0-GOLD-01 | golden 覆盖只读抽取/修复/登录异常路径；默认不出现 Playwright page API/generic MCP | `mcp-guidance-content.golden.test.ts` | 通过 | golden test 覆盖 framework guidance、login handoff、Site Adapter evidence。 |
| P0-OBS-01 | 增加最小 site_adapter_* artifact；失败可查询 repair evidence | `observability/types.ts`、`read-only-runner.ts`、`observation-query-service.ts` | 通过 | artifact types、failure bundle selector、runner attach artifacts 均落地。 |

## 4. P1/P2 标记复审（补强前快照）

以下是本轮 P1 补强前的抽查快照；最新完成状态见第 10 节“P1 补强回执”。当时 P1/P2 大体未开始的标记是合理的。抽查结果：

| ID | 当前状态 | 复审判定 | 证据 |
| --- | --- | --- | --- |
| P1-BR-01 | 未开始 | 正确 | `src/core/browser-runtime/capability-contract.ts` 不存在。 |
| P1-BR-02 | 部分完成 | 正确 | P0 gate 有 descriptor completeness，但没有完整 contract 校验，也没有 unsupported notes 全策略。 |
| P1-BR-03 | 未开始 | 正确 | 未见 BrowserCore/optional capability 边界重构。 |
| P1-BR-04 | 未开始 | 正确 | 未见跨 runtime semantic smoke suite/生成支持矩阵的新增完整实现。 |
| P1-BR-05 | 未开始 | 正确 | 未见 provider fallback descriptor 漂移修正。 |
| P1-TOOL-01 | 未开始 | 正确 | 仍未要求每个 browser tool 精确声明 `browserCapability:*`。 |
| P1-TOOL-02 | 未开始 | 基本正确 | 代码中已有 `navigationPerformed`，但不是本轮 P1 完整副作用 schema/guidance/trace 拆分。 |
| P1-PLAN-01 | 未开始 | 正确 | `src/core/browser-runtime/runtime-planner.ts` 不存在。 |
| P1-SESSION-01 | 未开始 | 正确 | 未见 `session_prepare(planOnly=true)` 或 `runtime_plan`。 |
| P1-WIN-01 | 未开始 | 正确 | 未见 window/focus/restore/capture/osInput/manualHandoff contract。 |
| P1-WIN-02 | 未开始 | 正确 | 未见 window descriptor 与 interaction health 合并输出。 |
| P1-EXT-05 | 未开始 | 正确 | `src/core/site-adapter-runtime/state-machine.ts` 不存在。 |
| P1-OBS-02 | 未开始 | 正确 | 未见 `site_adapter_repair_bundle`、`interactor_action_trace`、`procedure_state_transition` artifacts。 |
| P1-DATA-01 | 未开始 | 正确 | 未见 dataset run ledger / record provenance sidecar。 |
| P1-DATA-02 | 未开始 | 正确 | 未见 staged write plan + provenance transaction 一致性改造。 |
| P1-SCHEMA-01 | 未开始 | 正确 | 未见 MCP/OpenAPI/assistant manifest schema parity gate。 |
| P1-LIFE-01 | 未开始 | 正确 | 虽有局部 AbortSignal/timeout/lease 逻辑，但未见统一 lifecycle contract。 |

## 5. 验证记录解释（补强前）

进度文档记录的验证包括：

- Site Adapter/repair/descriptor gate 相关 vitest：通过。
- login/guidance/auth/cookies/observability 相关 vitest：通过。
- Electron persistent/profile sharing/HTTP config/capability registry 相关 vitest：通过。
- `npm run typecheck`：通过。
- `npm run test:open`：通过。
- `npm run lint`：0 errors，仍有既有 warnings。

复审认为这些测试是有价值的，但不能直接证明 P0 全完成，原因是：

- `P0-BR-01` 测试没有检测 capability-level promotion。
- `P0-SHARE-01` 测试覆盖了可见 `ipc` locked browser，却把 bare profile lease takeover 设为允许。
- `P0-SEC-02` 测试覆盖了 sensitive key，不覆盖 error message/stack/普通字符串。
- `P0-EXT-04` 测试覆盖 ESM import，不覆盖 CommonJS require。
- `P0-SEC-01` 测试覆盖 normalize/middleware，但缺直接 server/composition 的 agentHandMode 集成路径。

## 6. 建议修复顺序（已执行）

1. 先修 `P0-SHARE-01`：补 lease owner metadata 和 human-priority policy，这是最贴近登录共享核心价值的缺口。
2. 修 `P0-SEC-02`：统一字符串级脱敏，补 error/failure bundle regression tests。
3. 修 `P0-EXT-04`：补 `require()` boundary 和测试。
4. 修 `P0-BR-01`：把 promotion gate 从 runtime-level path existence 提升到 capability-level evidence gate。
5. 修 `P0-SEC-01`：在 server/composition 边界 normalize 或 assert `agentHandMode`。
6. 补证据类测试：
   - Electron persistent profile 的 cookie/localStorage 跨 acquire canary。
   - repair scope 的官方站点路径 allow/deny 策略。

## 7. 建议更新进度文档（修复前，已关闭）

本节保留原始复审建议；当前关闭状态见第 11 节。

在修复前，建议把 `docs/zg.v4-foundation-remediation-progress.zh-CN.md` 中以下项从“已完成”调为“部分完成”：

- `P0-BR-01`
- `P0-EXT-04`
- `P0-SEC-01`
- `P0-SEC-02`
- `P0-SHARE-01`

可选调整：

- `P0-REPAIR-02`：若计划坚持“官方站点路径测试”作为 P0 验收，应调为“部分完成”；否则保留“已完成”，并在未完成事项中写明官方站点 path policy 后续补。
- `P0-LOGIN-04`：可保留“已完成”，但建议在未完成事项中加“补真实登录存储跨 acquire canary”。

## 8. 复审结论（补强前）

这轮实现已经把 v4 地基从文档推进到了真实代码：Site Adapter runtime、login state、guidance、observability、repair evidence、HTTP auth/scope、人机接管策略都有落点。但按计划第 11 节的验收文字逐项复审后，当前还不能把 P0 认定为全量完成。

最核心的问题不是“没有代码”，而是几处门禁仍偏软：

- gate 只检查存在，不检查变化。
- 策略只覆盖稳定状态，不覆盖竞态窗口。
- 脱敏只看 key，不看字符串内容。
- sandbox 只看 ESM import，不看 CommonJS require。
- 安全模式依赖调用方先 normalize。

建议先按第 6 节顺序补齐，再重新运行 P0 专项测试、typecheck、`test:open` 和 lint，然后再把 P0 状态恢复为“已完成”。

## 9. 补强回执（2026-06-22）

已按第 6 节顺序补齐复审指出的 5 个 P0 软门禁：

- `R-01 / P0-SHARE-01`：`ResourceCoordinator` 和 profile live-session lease 增加 owner source 元数据；MCP 在 human(`ipc`) 已持 profile lease、但 browser 尚未进入 pool 时返回 manual handoff 并发 `browser:handoff-requested`，不再静默 handoff lease。
- `R-02 / P0-SEC-02`：Observation 字符串级脱敏覆盖普通字符串、error message、stack、currentUrl query、console message、Authorization、Cookie、Set-Cookie。
- `R-03 / P0-EXT-04`：Site Adapter import boundary 增加 CommonJS `require()` 检测，覆盖 `.js/.cjs`。
- `R-04 / P0-BR-01`：descriptor promotion gate 升级为 capability-level evidence baseline；新增 supported capability 必须同步补 evidence map。
- `R-05 / P0-SEC-01`：`getHttpApiAuthToken()` 在底层 server/composition 直接调用时把 `agentHandMode` 视同 auth enabled，新增 composition 集成测试覆盖 `enableAuth=false + agentHandMode=true`。

补强后验证：

- P0 受影响专项：61 tests，通过。
- P0 闭环专项组合：156 tests，通过。
- `npm run typecheck`：通过。
- `npm run test:open`：通过，26 tests。
- `npm run lint`：0 errors，226 warnings（既有 warning，未作为本轮 P0 阻塞项处理）。

## 10. P1 补强回执（2026-06-22）

在 P0 软门禁补齐后，已继续把第 4 节复审表中标为“未开始/部分完成”的 P1 项补齐。进度文档已同步更新为：已完成 33、部分完成 0、未开始 0。

已补齐的 P1 范围：

- `P1-BR-01` 至 `P1-BR-05`：新增 Browser Capability Contract，接入 static descriptor 校验、unsupported notes 完整策略、最小 `BrowserCore` 边界、runtime capability matrix 生成、provider dynamic descriptor 防漂移门禁。
- `P1-TOOL-01`、`P1-TOOL-02`：browser tool requirements 精确到 `browserCapability:*`；`browser_observe(url)` 输出 `navigationPerformed`、`afterUrl`、`sideEffect`。
- `P1-PLAN-01`、`P1-SESSION-01`：新增 runtime/profile/login/visibility planner；`session_prepare(planOnly=true)` 与 public `runtime_plan` 接入当前 session guidance 和 runtime availability。
- `P1-WIN-01`、`P1-WIN-02`：新增 window/focus/restore/capture/osInput/manualHandoff contract，并合并到 interaction health 输出。
- `P1-EXT-05`、`P1-OBS-02`：新增 Site Adapter state machine、actionTrace、transition replay，并扩展 `site_adapter_repair_bundle`、`interactor_action_trace`、`procedure_state_transition` artifacts。
- `P1-DATA-01`、`P1-DATA-02`：新增 dataset run ledger / record provenance sidecar，以及 staged write plan + rows/provenance 事务一致性测试。
- `P1-SCHEMA-01`、`P1-LIFE-01`：新增 MCP/OpenAPI/assistant schema parity gate 与 orchestration lifecycle contract。

P1 补强后验证：

- P0+P1 专项组合：209 tests，通过。
- `npm run typecheck`：通过。
- `npm run test:open`：通过，26 tests。
- `npm run lint`：0 errors，226 warnings（既有 warning，未作为本轮阻塞项处理）。

## 11. 当前复核结论（2026-06-22）

当前复核结论：本 review 中提出的 5 个 P0 复审缺口，以及第 4 节历史快照里标为“未开始/部分完成”的 P1 项，均已补齐。当前进度文档状态为：已完成 33、部分完成 0、未开始 0。

本次复核验证：

- P0+P1 专项组合：209 tests，通过。
- `npm run typecheck`：通过。
- `npm run test:open`：通过，26 tests。
- `npm run lint`：0 errors，226 warnings（既有 warning，未作为本轮阻塞项处理）。
