# Tianshe v4 地基整改复审测试规划

> 目标：用真实、可复跑、可追溯的方式证明 `zg.v4` 地基整改已经闭环，而不是只证明“有文件、有测试、文档写了完成”。

关联文档：

- `docs/zg.v4-foundation-remediation-plan.zh-CN.md`
- `docs/zg.v4-foundation-remediation-review.zh-CN.md`
- `docs/zg.v4-foundation-remediation-progress.zh-CN.md`
- `docs/remote-browser-window-control-design.zh-CN.md`

## 1. 测试原则

1. 不以“测试文件存在”作为完成证据；每个验收项必须有正向、反向或真实运行证据。
2. 不只测 happy path；P0/P1 中的安全、权限、脱敏、lease、事务一致性必须有失败路径和竞态路径。
3. 不只测单元函数；Browser Runtime、MCP/HTTP、Profile、DuckDB、Observability 要有跨模块组合测试。
4. 不依赖外部商业网站稳定性；真实浏览器场景优先使用本地 fixture/test server，外部站点只作为补充烟测。
5. 不把 lint warning 当作本轮阻塞项，但 lint 必须保持 0 error，并记录 warning 数量。
6. 复审结果必须能被第三人复跑：命令、环境、数据、截图、日志、artifact 查询结果都要留痕。

## 2. 测试分层

| 层级 | 目的 | 主要方法 | 阻塞级别 |
| --- | --- | --- | --- |
| L0 静态与契约 | 防止能力描述、schema、surface 撒谎 | typecheck、lint、schema parity、capability contract | 必须通过 |
| L1 单元与反向测试 | 验证每个补强点的局部行为和失败路径 | Vitest targeted suites | 必须通过 |
| L2 跨模块集成 | 验证 MCP、profile、runtime、observability、DuckDB 的组合行为 | P0+P1 专项组合 | 必须通过 |
| L3 真实运行烟测 | 验证实际 Electron/浏览器窗口、profile、manual handoff、artifact 可见 | 本地 dev server + Electron/MCP 操作 | 必须执行，失败需分级 |
| L4 发布前回归 | 验证开源边界、构建、包、供应链 | `verify:ci` 子集或完整 CI | 发布前必须通过 |

## 3. 环境矩阵

| 环境 | 必测内容 | 备注 |
| --- | --- | --- |
| Windows 本机开发环境 | typecheck、lint、open edition、Electron profile、窗口控制 | 当前主要开发环境 |
| 临时 DuckDB 数据目录 | login state、dataset provenance、staged write rollback | 每轮使用新临时目录，避免旧数据污染 |
| Electron runtime | persistent profile、windowControl、manual handoff、screenshot/snapshot | 必测 |
| Cloak runtime descriptor | degraded/unsupported capability notes、contract validation | 必测 descriptor，不要求真实外部浏览 |
| Firefox/Ruyi runtime | dynamic descriptor、防 fallback 漂移 | 若本机 runtime 未安装，可只跑 provider/descriptor 测试并记录原因 |
| MCP HTTP server | auth/scope、runtime availability、session_prepare、runtime_plan | 必测黑盒 API |
| 本地 fixture site | Site Adapter read-only、state machine、repair evidence | 必测，避免依赖外网 |

建议每次复审新建证据目录：

```text
docs/evidence/zg-v4-review/YYYYMMDD-HHMM/
  commands.md
  test-output/
  screenshots/
  mcp-http-samples/
  duckdb-queries/
  manual-checklist.md
```

## 4. 必跑自动化命令

### 4.1 P0+P1 专项组合

```powershell
npx vitest run `
  src/core/site-adapter-runtime/read-only-runner.test.ts `
  src/core/site-adapter-runtime/sandbox/import-boundary.test.ts `
  src/core/site-adapter-runtime/repair/repair-scope.test.ts `
  src/core/site-adapter-runtime/repair/repair-evidence.test.ts `
  src/core/site-adapter-runtime/state-machine.test.ts `
  src/core/browser-pool/runtime-capability-registry.promotion-gate.test.ts `
  src/core/browser-runtime/capability-contract.test.ts `
  src/core/browser-runtime/runtime-planner.test.ts `
  src/core/browser-runtime/window-control-contract.test.ts `
  src/main/duckdb/profile-login-state-service.test.ts `
  src/main/duckdb/dataset-provenance-service.test.ts `
  src/main/mcp-guidance-content.golden.test.ts `
  src/main/http-auth-middleware.test.ts `
  src/core/ai-dev/capabilities/browser/handlers/cookies.test.ts `
  src/core/observability/browser-failure-bundle.test.ts `
  src/core/observability/observation-service.test.ts `
  src/main/observation-query-service.test.ts `
  src/constants/http-api.test.ts `
  src/core/ai-dev/capabilities/browser/tool-manifest.test.ts `
  src/core/ai-dev/capabilities/schema-parity.test.ts `
  src/core/ai-dev/orchestration/capability-registry.test.ts `
  src/core/ai-dev/orchestration/lifecycle-contract.test.ts `
  src/main/http-browser-pool-adapter.test.ts `
  src/main/http-server-composition.test.ts `
  src/main/mcp-http-runtime-availability.test.ts `
  src/main/ipc-handlers/profile-ipc-handler.test.ts `
  src/main/ipc-handlers/account-ipc-handler.test.ts `
  src/main/duckdb/profile-service.partition.test.ts `
  src/core/browser-pool/__tests__/pool-manager.test.ts `
  src/core/browser-pool/__tests__/profile-live-session-lease.test.ts `
  src/main/profile/browser-runtime-providers.test.ts `
  src/types/browser-runtime.test.ts
```

通过标准：

- 32 个测试文件全部通过。
- 209 个测试用例全部通过。
- 允许测试内预期的 warning/error log，但必须确认不是未捕获异常。

### 4.2 基础质量门禁

```powershell
npm run typecheck
npm run test:open
npm run lint
```

通过标准：

- `typecheck` 0 error。
- `test:open` 全部通过。
- `lint` 退出码为 0；warning 数量记录到复审报告。

### 4.3 发布前增强门禁

发布前或合入主干前建议追加：

```powershell
npm run test:open:full
npm run test:architecture
npm run test:inventory
npm run verify:open-source-boundary
npm run verify:supply-chain
npm run build:open
```

若时间允许，跑完整：

```powershell
npm run verify:ci
```

## 5. P0/P1 覆盖矩阵

| 范围 | 自动化证据 | 真实复审补充 |
| --- | --- | --- |
| Browser capability contract | `capability-contract.test.ts`、`runtime-capability-registry.promotion-gate.test.ts`、`browser-runtime-providers.test.ts` | 手工检查 runtime matrix 输出与 descriptor 一致 |
| BrowserCore 边界 | `capability-contract.test.ts`、`src/types/browser-interface.ts` typecheck | 抽查新增 browser 方法是否必须进入 capability contract |
| Tool requirements | `tool-manifest.test.ts`、`mcp-http-runtime-availability.test.ts` | 通过 MCP list/invoke 观察 unsupported capability 提示 |
| `browser_observe(url)` side effect | catalog schema、handler tests、cross-runtime contract tests | 黑盒调用一次带 url、一次不带 url，比较 `navigationPerformed`/`sideEffect` |
| Runtime planner/session prepare | `runtime-planner.test.ts`、`session-catalog.ts` 相关测试 | MCP 调 `runtime_plan` 和 `session_prepare(planOnly=true)`，检查 recommended profile/runtime |
| Window/manual handoff | `window-control-contract.test.ts`、interaction health 输出 schema | Electron 可见窗口下截图、聚焦、manual handoff 观察 |
| Site Adapter runtime | `read-only-runner.test.ts`、manifest/sandbox/repair tests | 本地 fixture 跑完整抽取，确认 artifact 可查询 |
| Site Adapter state machine | `state-machine.test.ts` | 抽查 transition replay 和 action trace 无 browser/page/secret 泄露 |
| Observability artifacts | `observation-service.test.ts`、`observation-query-service.test.ts` | 查询 failure bundle，确认 repair bundle/action trace/transition artifacts |
| Dataset provenance | `dataset-provenance-service.test.ts`、dataset capability tests | DuckDB 查询 run ledger、record sidecar；模拟失败回滚 |
| Auth/scope/security | `http-auth-middleware.test.ts`、`http-server-composition.test.ts`、cookies/redaction tests | MCP/REST 黑盒请求：无 token、有 token、缺 scope 三种路径 |
| Human/agent shared profile | `http-browser-pool-adapter.test.ts`、`profile-live-session-lease.test.ts`、`pool-manager.test.ts` | 手工可见 profile + agent acquire，确认不静默抢占 |
| Schema parity | `schema-parity.test.ts` | 抽查 MCP/OpenAPI/assistant manifest 不暴露 private cookie tool |
| Lifecycle | `lifecycle-contract.test.ts`、capability registry abort/rollback tests | 手工中断长操作，确认 lease、artifact、dataset 不留半截状态 |

## 6. 反向与竞态测试重点

### 6.1 安全反向

必须覆盖：

- `agentHandMode=true` 且 `enableAuth=false` 时，底层 server/composition 仍强制 auth。
- 未授权请求不能调用 MCP/REST sensitive tool。
- `browser_cookies_get` 不出现在 public MCP surface。
- Cookie、Authorization、Set-Cookie、URL query、console、error message、stack、普通字符串都必须脱敏。
- Site Adapter import boundary 必须拦截 ESM import、dynamic import、CommonJS `require()`。
- repairScope 必须拒绝 path traversal、`src/main/**`、framework core。

### 6.2 Lease 和 handoff 竞态

必须覆盖：

- Human IPC 已持有 visible locked browser，MCP acquire 不能静默抢占。
- Human IPC 已持有 profile lease，但 browser 尚未进入 pool，MCP acquire 不能静默抢占。
- MCP/HTTP agent 持锁时，human IPC 可以 human-priority takeover，并产生 handoff/pause 事件。
- stale requestId release 不能释放新 holder 的 browser/lease。
- timeout、abort、browser closed 后 lease 必须释放或转移到明确状态。

### 6.3 数据一致性反向

必须覆盖：

- staged write 未 confirmRisk 不能 commit。
- staged write rows 成功但 provenance 写入失败时必须整体 rollback。
- provenance 写入成功但 rows 失败时必须整体 rollback。
- run ledger 与 record provenance sidecar 的 `runId`、`traceId`、`operation` 一致。

### 6.4 Descriptor 漂移反向

必须覆盖：

- runtime descriptor 声明 supported capability 但没有 method evidence，要失败。
- static descriptor unsupported capability 缺少 notes，要失败。
- provider factory 返回 fallback static descriptor，要失败。
- browser tool requirement 未声明精确 `browserCapability:*`，要失败。

## 7. 真实运行烟测

真实烟测不替代自动化测试，但能证明框架在用户路径里可用。

### 7.1 Electron profile 持久登录语义

步骤：

1. 使用临时 profile 创建 Electron runtime。
2. 打开本地 auth fixture page，写入 cookie/localStorage/sessionStorage。
3. release browser，不清理 `persist:profile-*` partition。
4. 再次 acquire 同一 profile。
5. 读取 cookie/localStorage，确认仍存在。
6. 记录 profileId、runtimeId、partition、截图或日志。

通过标准：

- 同一 profile 的登录态跨 acquire 保留。
- release 默认不清 persistent profile storage。
- 证据不包含真实凭据、cookie 原文或 token。

### 7.2 Human 与 agent 共享 profile 接管

步骤：

1. 由 UI/IPC 启动一个 visible profile。
2. 保持 human 持有窗口或 profile lease。
3. MCP 侧发起需要同 profile 的 browser acquire。
4. 观察 MCP 返回 manual handoff required，而不是静默抢占。
5. 反向测试：agent 持有 browser 时，由 human 侧发起接管，确认产生 handoff/pause 事件。

通过标准：

- human 持有时 agent 不静默抢占。
- agent 持有时 human 可以优先接管。
- 事件中包含 holder/source 信息，敏感字段已脱敏。

### 7.3 `runtime_plan` 与 `session_prepare(planOnly=true)`

步骤：

1. 启动 MCP HTTP server。
2. 使用 public MCP list 确认存在 `runtime_plan`。
3. 调用 `runtime_plan`，传入 `requiredCapabilities`、`profileId/site`、`visible`。
4. 调用 `session_prepare`，设置 `planOnly=true`。
5. 对比两个输出中的 recommended runtime/profile、blocked reason、unsupported requirement。

通过标准：

- planOnly 不创建或抢占真实 browser。
- 缺 capability 时返回可理解的 blocked/unsupported reason。
- 建议包含下一步工具或 action。

### 7.4 Site Adapter 本地 fixture 抽取

步骤：

1. 使用 `examples/web-site-adapter-static-product/` fixture。
2. 跑 read-only runner。
3. 查询 result/failure/repair evidence artifacts。
4. 故意改坏 selector，确认 failure bundle 带 selector diagnostics、fixture、expected、before/after。

通过标准：

- 正常 fixture 抽取结果稳定。
- 失败路径可查询 repair bundle。
- `changedFiles` 只允许 adapter scope。

### 7.5 Window/interaction health

步骤：

1. 使用 Electron runtime acquire visible browser。
2. 调用 observe/snapshot/screenshot/debug_state。
3. 检查输出中 `windowControl` descriptor、interaction health、capture availability。
4. 最小人工操作：聚焦窗口、切换可见性、截图。

通过标准：

- 输出 schema 与实际 runtime descriptor 一致。
- unsupported/degraded capability 有明确原因。
- 截图非空，窗口状态不与 descriptor 矛盾。

## 8. 黑盒 MCP/HTTP 检查

每轮复审至少保存以下样例请求与响应：

| 场景 | 请求 | 期望 |
| --- | --- | --- |
| 未授权 MCP invoke | 无 token 调 sensitive tool | 401/unauthorized |
| 缺 scope invoke | 有 token 缺 browser/profile scope | scope error |
| public list | list MCP tools | private cookie tool 不出现 |
| runtime availability | runtime 缺 capability | 返回 unsupportedRequirements 和 `runtime_plan` 建议 |
| observe no-url | `browser_observe` 不带 url | `navigationPerformed=false`、`sideEffect=none` |
| observe with url | `browser_observe(url)` | `navigationPerformed=true`、`sideEffect=navigation` |
| plan only | `session_prepare(planOnly=true)` | 不创建 browser，只返回 plan |
| dataset staged write | stage -> inspect -> commit | confirmRisk 前不写入；commit 后 provenance 可查 |

## 9. 证据留存格式

每次复审产出一份 `commands.md`：

```markdown
# ZG v4 review evidence

- Date:
- Commit/worktree:
- OS:
- Node:
- npm:
- Commands:
  - ...
- Results:
  - P0+P1 vitest: pass/fail, test count
  - typecheck: pass/fail
  - test:open: pass/fail
  - lint: 0 errors, N warnings
- Manual checks:
  - ...
- Known gaps:
  - ...
```

每条人工复审记录包含：

- 操作步骤。
- 预期结果。
- 实际结果。
- 截图/日志/artifact 查询路径。
- 是否含敏感数据；若有，必须先脱敏再入库。

## 10. 退出标准

可以判定“真实全面复审通过”的最低标准：

1. `docs/zg.v4-foundation-remediation-progress.zh-CN.md` 中所有 P0/P1 项为已完成，未完成事项为 `-` 或明确非阻塞扩展点。
2. P0+P1 专项组合全部通过。
3. `npm run typecheck`、`npm run test:open`、`npm run lint` 通过，lint 为 0 error。
4. 安全反向、lease 竞态、dataset rollback、descriptor drift 至少各有一个失败路径测试。
5. 至少完成 Electron profile、MCP runtime plan、Site Adapter fixture、window/interaction health 四个真实烟测。
6. 所有复审证据可在本地重新打开和复核。
7. 若有无法执行的环境项，必须记录原因、风险等级、替代证据和后续补测 owner。

## 11. 建议补充的自动化

为降低后续复审成本，建议新增一个聚合脚本：

```json
{
  "scripts": {
    "test:zg-v4-remediation": "vitest run <P0+P1专项组合>",
    "verify:zg-v4-remediation": "npm run test:zg-v4-remediation && npm run typecheck && npm run test:open && npm run lint"
  }
}
```

建议新增或增强的测试：

| 建议 | 目的 |
| --- | --- |
| Electron cookie/localStorage 跨 acquire canary | 把 persistent login 证据从 partition 推导升级为真实存储证据 |
| MCP 黑盒 snapshot tests | 防止 public/private surface 漂移 |
| Descriptor matrix snapshot | 防止 runtime capability matrix 非预期变化 |
| Repair bundle fixture regression | 防止 Site Adapter 失败证据缺字段 |
| Dataset staged write fault injection | 更强地证明 rows/provenance transaction 一致 |
| Window screenshot pixel smoke | 防止 screenshot/capture 输出空图 |

## 12. 复审节奏

| 时机 | 必跑 |
| --- | --- |
| 每次修改 P0/P1 涉及文件 | 相关 targeted tests + typecheck |
| 每次更新 progress/review 状态 | P0+P1 专项组合 |
| 合入前 | `verify:zg-v4-remediation` + `test:open:full` |
| 发布前 | `verify:ci` 或等价完整 CI |
| 发现安全/数据/lease 回归 | 增加反向测试，再恢复完成状态 |

## 13. 复审结论模板

```markdown
## 复审结论

结论：通过 / 有条件通过 / 不通过

自动化：

- P0+P1 专项组合：
- typecheck：
- test:open：
- lint：

真实烟测：

- Electron profile 持久登录：
- Human/agent handoff：
- runtime_plan/session_prepare planOnly：
- Site Adapter fixture：
- Window/interaction health：

阻塞问题：

- 无 / 列表

非阻塞风险：

- 无 / 列表

证据目录：

- `docs/evidence/zg-v4-review/...`
```
