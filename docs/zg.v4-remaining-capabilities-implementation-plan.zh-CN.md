# Tianshe v4 剩余新增能力实施计划

> 前提：`docs/zg.v4.md` 的地基整改已经完成，`docs/zg.v4-foundation-remediation-progress.zh-CN.md` 中 P0/P1 地基任务已关闭。
>
> 本文只规划地基之后的新增产品能力。底层 runtime capability matrix、MCP public surface、repairScope allow/deny、schema 字段和测试状态仍以代码、测试、生成快照和 evidence 为准，不在本文手抄第二套真相源。

---

## 0. 总结

下一阶段不要继续横向铺地基，也不要一上来做很多站点脚本。目标应该是把已经完成的地基串成可交付的上层能力：

```text
站点适配
  -> 业务 Capability
  -> 登录态 / runtime plan / Site Adapter Runner
  -> dataset 写入与 provenance
  -> trace / failure bundle
  -> Lab 调试
  -> scoped repair
  -> 回归和发布
```

也就是说，后续新增能力的主线不是“给模型更多浏览器工具”，而是：

```text
让模型默认调用稳定业务能力；
让人和开发者能快速制造、调试、修复这些能力；
让每次运行和每次修复都有证据。
```

推荐采用 4 条并行但有先后依赖的产品线：

| 产品线                 | 目标                                                   | 第一阶段产物                  |
| ---------------------- | ------------------------------------------------------ | ----------------------------- |
| 业务 Capability        | 让 agent 调 `<site>.<action>`，不是写浏览器脚本        | 第一个真实只读站点能力        |
| Site Adapter Lab       | 让开发者/模型调试 adapter、生成 fixture、定位 selector | Lab MVP                       |
| Repair Studio          | 把 failure bundle 变成可审核、可回归的 scoped repair   | 只读 repair 闭环              |
| Dataset / Trace 产品化 | 让抽取结果可追溯、可复查、可回放                       | provenance 查看与 run history |

### 0.1 代码复审结论（2026-06-22）

本计划按当前代码复审后，需要带着以下真实约束执行：

- MCP public surface 已经有 `profile_ensure_logged_in`、`runtime_plan`、`session_prepare`、`dataset_get_record_provenance`、`observation_get_failure_bundle` 等地基能力，但还没有任何 `<site>.<action>` 业务站点能力。
- `createUnifiedCapabilityCatalog()` 当前通过固定 factory 合并 browser/dataset/plugin/profile/observation/system/session catalog。阶段 A 必须补一个站点能力注册机制，否则第一个真实站点能力仍会落成 core catalog 改动。
- Site Adapter runtime 当前是 P0 只读接口：`SiteAdapterSideEffectLevel = 'read-only'`，`SiteAdapterManifest` 只包含 `id/name/version/site/sideEffectLevel/extractors/verifiers` 等最小字段。
- 官方示例当前在 `examples/web-site-adapter-static-product/adapter.ts`，不是 `site-adapters/<site-id>/manifest.ts`。`site-adapters/` 是目标形态，不是现有装载路径。
- 现有 runner 是 `runReadOnlySiteAdapterFixture()` 和基于 `BrowserInterface.snapshot()` 的 `runReadOnlySiteAdapterRuntimeCanary()`；还没有 browser evaluate runner、Playwright lab runner、Lab UI 或 Repair Studio UI。
- repairScope 默认只允许 `examples/web-site-adapter-*` 下的 `extractors/verifiers/fixtures/expected`，迁移到 `site-adapters/` 前必须同步改 repairScope contract 和 forbidden path 测试。
- Dataset provenance、trace/failure bundle、site adapter repair evidence 已有服务和 artifact 类型；下一步主要是业务闭环和 UI 查询入口，不应重造 schema。
- `browser_validate_selector` 已经存在，但它是浏览器工具能力，不等于 Site Adapter Lab。Lab 仍需新增 fixture capture、expected editor、runner diff 和 artifact viewer。

---

## 1. 范围

### 1.1 本计划要做的

- 新增真实站点业务 Capability。
- 新增 Site Adapter Pack 规范和官方示例升级路径。
- 新增 Site Adapter Lab，用于 fixture capture、selector 调试、runner 对比和 repair bundle 查看。
- 新增只读抽取能力闭环：profile/login、runtime plan、adapter runner、schema validate、dataset write、provenance、trace。
- 新增状态化写动作 Procedure 的产品能力，但必须晚于只读闭环。
- 新增 Repair Studio，把模型修复限制在 adapter scope 内，并要求 fixture / smoke /人工审核。
- 新增 Dataset provenance / trace 的可视化查询入口。
- 新增面向 agent 的业务流程 playbook 和 golden transcript 回归。
- 新增真实 runtime canary / release gate，把 Lab 与生产 runner 漂移纳入验收。

### 1.2 本计划不做的

- 不把 raw Playwright 暴露给默认 agent surface。
- 不让模型输入密码、验证码、2FA 或绕过风控。
- 不允许 Site Adapter 访问 Node/Electron/Playwright/DuckDB/secrets。
- 不在业务站点 adapter 里选择 profile/runtime。
- 不把修复权限扩展到 framework core、main process、schema 权威源。
- 不为了旧草案、旧 PoC、旧概念保留双轨架构。

---

## 2. 目标闭环

地基完成后的第一个真实产品闭环应长这样：

```text
用户选择一个站点能力
  -> agent 调用 <site>.<action>
  -> capability 检查输入、scope、确认策略
  -> profile_ensure_logged_in / runtime_plan / session_prepare
  -> Site Adapter Runner 执行 Extractor / Verifier
  -> output schema validate
  -> dataset staged write + provenance
  -> observation artifact / trace summary
  -> 返回结构化结果
```

失败时：

```text
Capability 失败
  -> failure bundle
  -> site_adapter_repair_bundle
  -> Repair Studio 展示字段缺失、selector hits、page fingerprint、action trace
  -> 模型只修改 adapter scope
  -> fixture runner
  -> target runtime smoke / canary
  -> 人工审核
  -> 发布 adapter 新版本
```

Lab 调试时：

```text
打开页面
  -> capture DOM/screenshot/network summary
  -> 试 selector
  -> 生成 fixture + expected
  -> 运行 extractor / verifier / procedure
  -> 对比生产 runner
  -> 生成可提交 adapter diff
```

---

## 3. 能力分层

### 3.1 Site Adapter Pack

Site Adapter Pack 是站点易变层的交付单位。它不直接面向 agent，agent 面对的是 Capability。

建议结构：

```text
site-adapters/<site-id>/
  adapter.ts
  extractors/
  verifiers/
  procedures/
  fixtures/
  expected/
  repair-scope.ts
  README.md
```

当前 P0 runtime 兼容字段：

- `id`
- `name`
- `version`
- `site`
- `sideEffectLevel: 'read-only'`
- `extractors[].id`
- `extractors[].outputFields`
- `verifiers[].id`
- `verifiers[].description`

目标补充字段：

- `siteId`
- `capabilities`
- `inputSchema`
- `outputSchema`
- `requiredScopes`
- `supportedRunners`
- `repairScope`
- `fixtures`
- `expected`
- `riskLevel`

验收：

- manifest schema test 通过。
- import boundary test 通过。
- fixture runner 通过。
- target runtime smoke 通过。
- output schema 与 capability schema 对齐。
- 若从 `examples/web-site-adapter-*` 迁移到 `site-adapters/`，repairScope allow/deny 测试必须同步更新。

### 3.2 Business Capability

Business Capability 是 agent 默认调用单位，命名使用 `<site>.<action>`。

第一批只做只读能力，例如：

```text
<site>.extract_product
<site>.extract_search_results
<site>.extract_order_list
```

第二批再做低风险写动作，例如：

```text
<site>.add_product_to_dataset
<site>.save_item_to_collection
<site>.submit_draft_form
```

验收：

- 具备 `OrchestrationCapabilityDefinition` 所需元数据。
- 使用 `profile_ensure_logged_in` 和 `runtime_plan`，不自己散落 runtime/profile 判断。
- 不暴露 selector、page handle、Playwright API 给 agent。
- 成功结果写 dataset 时必须带 provenance。
- 失败结果必须能查到 failure bundle / repair bundle。

### 3.3 Site Adapter Lab

Lab 是人和模型协作制造 adapter 的工作台，不是默认 agent 工具。

MVP 功能：

- 打开目标 URL 或导入本地 HTML。
- 生成 fixture。
- 试 selector 并展示 selector hits。
- 跑 Extractor / Verifier。
- 展示 expected diff。
- 展示 runner 差异：fixture runner vs browser runner vs Playwright lab runner。
- 生成 repair bundle。

后续功能：

- Procedure step recorder。
- action trace replay。
- page fingerprint diff。
- network/console 脱敏摘要。
- adapter diff preview。
- 一键跑 fixture + target runtime smoke。

验收：

- Lab 可以用 Playwright，但产物不能是 Playwright 脚本。
- Lab 产物必须能被 fixture runner 和生产 runner 消费。
- Lab 不能把 secrets/cookie value/token 写入 fixture 或 artifact。

### 3.4 Repair Studio

Repair Studio 负责把失败证据变成可审核修复。

MVP 只做只读 Extractor repair：

- 选择 failure bundle。
- 查看 missing fields、selector diagnostics、before/after expected。
- 生成模型修复任务。
- repairScope 写闸。
- diff review。
- fixture runner 回归。
- target runtime smoke。
- 人工 approve。

Procedure repair 后置，原因是写动作风险更高。它必须增加：

- sideEffectLevel 展示。
- mock action log。
- state transition replay。
- destructive confirmation。
- target runtime canary。
- 人工审核强制。

### 3.5 Dataset / Trace 产品化

地基已有 provenance 能力，下一步要做可用入口。

目标页面：

- Dataset row provenance panel。
- Capability run history。
- Trace summary viewer。
- Failure bundle viewer。
- Site Adapter artifact viewer。
- Repair history。

关键体验：

- 一行数据能看到来自哪个 capability、哪个 adapter 版本、哪个 URL、哪个 trace。
- 一个失败能看到它是否可 repair、repair 改了哪些 adapter 文件、哪些回归通过。
- 用户能按 site/profile/runtime/adapterVersion 过滤结果。

---

## 4. 阶段路线

### 阶段 A：能力地图和模板

目标：让后续新增能力有统一入口和模板，避免每个站点各写一套。

任务：

| ID     | 任务                                                   | 输出                                                                 | 验收                                        |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------- |
| V4-A01 | 生成当前 capability / MCP / runtime / repairScope 快照 | generated snapshot 或 JSON                                           | CI 可复跑，文档只引用                       |
| V4-A02 | Site Adapter Pack 模板                                 | 兼容 `SiteAdapterModule` 的 `adapter.ts` 示例模板                    | 新站点可复制模板起步                        |
| V4-A03 | Business Capability 模板                               | handler + schema + guidance 模板                                     | 新能力必须有 schema/guidance/tests          |
| V4-A04 | 站点能力注册机制                                       | `site-capability-catalog` 或等价 loader                              | 新站点能力不必长期手改 unified core catalog |
| V4-A05 | repairScope 迁移策略                                   | `examples/web-site-adapter-*` 与 `site-adapters/` 的 allow/deny 测试 | 迁移目录前不会放宽 core 写权限              |
| V4-A06 | 新增能力 DoD 检查清单                                  | `docs` 或脚本输出                                                    | PR 可按清单验收                             |

出站条件：

- 新增站点能力不需要改 core 才能注册。
- 新能力必须自动进入 inventory / schema parity / assistant surface 检查。
- 如果 V4-A04 暂缓，阶段 B 的第一个真实站点可以先显式接入 catalog，但必须记录为迁移债务。

### 阶段 B：第一个真实只读站点能力

目标：做一个真实站点的端到端只读能力，证明地基能产出业务价值。

建议选择标准：

- 页面结构稳定。
- 不需要绕登录或强风控。
- 输出字段明确。
- 能用本地 fixture 回归。
- 能写入 dataset 并检查 provenance。

任务：

| ID     | 任务                                              | 输出                      | 验收                                                                          |
| ------ | ------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| V4-B01 | 选择第一个真实站点和一个只读 action               | capability spec           | 输入/输出/risk 明确                                                           |
| V4-B02 | 编写 adapter extractor/verifier/fixtures/expected | Site Adapter Pack         | fixture runner 通过                                                           |
| V4-B03 | 注册 `<site>.extract_*` capability                | public/agent capability   | MCP list/resource 可见；若仍改 core catalog，要标记为临时接入                 |
| V4-B04 | 接入 runtime_plan/session_prepare                 | runtime/profile plan      | 当前 runtime 不满足时有 next action                                           |
| V4-B05 | 写 dataset + provenance                           | dataset rows + run ledger | row 可查 traceId/adapterVersion/sourceUrl                                     |
| V4-B06 | 加入 failure bundle / repair evidence             | artifacts                 | 失败时可通过 observation 工具查到 repair artifacts；Repair Studio UI 后续承接 |

出站条件：

- agent 能只用业务 Capability 完成一次抽取。
- 没有 raw Playwright、selector 或 page handle 泄漏到 agent 默认路径。
- 同一 fixture 修改字段后能稳定失败并生成 repair evidence。

### 阶段 C：Site Adapter Lab MVP

目标：让人能制造和调试 adapter，不再靠手写猜 selector。

任务：

| ID     | 任务                   | 输出                              | 验收                             |
| ------ | ---------------------- | --------------------------------- | -------------------------------- |
| V4-C01 | Lab 页面入口           | renderer 页面                     | 能选择站点/fixture/URL           |
| V4-C02 | Fixture capture        | HTML/snapshot/screenshot artifact | 默认脱敏                         |
| V4-C03 | Selector workbench     | selector hits panel               | 展示命中数量、文本预览、fallback |
| V4-C04 | Extractor runner panel | result/diff/diagnostics           | fixture 和 browser runner 都能跑 |
| V4-C05 | Expected editor        | expected JSON                     | 保存后触发 fixture test          |
| V4-C06 | Repair bundle viewer   | failure/repair evidence UI        | 能从 observation artifact 打开   |

出站条件：

- 开发者可以从真实页面生成 fixture，跑出 expected，并提交一个 adapter。
- Lab 生成的产物不包含 cookie/password/token。
- Lab 输出能被 CLI/CI 复跑。

### 阶段 D：登录态站点只读能力

目标：证明 profile、人机接管、登录态健康能支撑真实登录站点。

任务：

| ID     | 任务                             | 输出            | 验收                                |
| ------ | -------------------------------- | --------------- | ----------------------------------- |
| V4-D01 | 选择一个需要登录但只读的站点能力 | capability spec | 不涉及敏感写动作                    |
| V4-D02 | 接入 `profile_ensure_logged_in`  | login flow      | captcha/2FA 返回人工接管            |
| V4-D03 | 人工接管 UI 打通                 | handoff flow    | 人登录后 agent 继续                 |
| V4-D04 | login verifier                   | verifier        | 登录状态可更新 login state          |
| V4-D05 | profile 持久性烟测               | smoke evidence  | cookie/localStorage 跨 acquire 存在 |

出站条件：

- agent 不会提示用户把密码告诉模型。
- 人能接管可见 profile 登录，agent 使用同一 profile 继续只读能力。
- 登录态过期时返回结构化状态和 next action。

### 阶段 E：Repair Studio 只读闭环

目标：让 selector 失效时，可以从失败证据到修复发布形成闭环。

任务：

| ID     | 任务                 | 输出                                | 验收                    |
| ------ | -------------------- | ----------------------------------- | ----------------------- |
| V4-E01 | 失败定位             | failed field / selector diagnostics | 能指出哪个字段失败      |
| V4-E02 | 模型修复任务生成     | scoped prompt payload               | 只包含 adapter scope    |
| V4-E03 | repair apply service | dev/lab only apply                  | repairScope 拒绝 core   |
| V4-E04 | 回归执行             | fixture + target smoke              | 失败不能 approve        |
| V4-E05 | repair review record | repair history                      | 记录 diff、测试、审核人 |

出站条件：

- 故意改坏 selector 后，Repair Studio 能生成修复、跑回归、展示 diff。
- 没有人工 approve 不发布 adapter 新版本。
- 修复不能改 framework core。

### 阶段 F：状态化写动作 Procedure

目标：让 Site Adapter 支撑可约束、可验证、可回放的写流程。

先做低风险动作，不做支付、下单、删除、不可逆提交。

任务：

| ID     | 任务                   | 输出                       | 验收                            |
| ------ | ---------------------- | -------------------------- | ------------------------------- |
| V4-F01 | Procedure DSL/contract | procedure schema           | 无 browser/page/context handle  |
| V4-F02 | Action Runner          | BrowserInterface wrapper   | click/type/wait/verify 有 trace |
| V4-F03 | Verification policy    | verifier + effect signals  | 不能只靠动作成功                |
| V4-F04 | Confirmation policy    | destructive/low-risk gates | 高风险需要显式确认              |
| V4-F05 | Procedure replay       | state transition replay    | mock action log 可复跑          |
| V4-F06 | Write repair gate      | stricter repair workflow   | 必须 target canary + 人审       |

出站条件：

- Procedure 每一步都有 action trace、before/after、verification。
- abort 不留下悬挂 lease 或半截 dataset/provenance。
- 写动作 repair 不和只读 repair 混用同一低门槛。

### 阶段 G：Agent 工作流产品化

目标：让默认 agent 使用业务能力，而不是回退通用浏览器。

任务：

| ID     | 任务                          | 输出                        | 验收                                    |
| ------ | ----------------------------- | --------------------------- | --------------------------------------- |
| V4-G01 | getting started playbook 升级 | MCP guide                   | 优先 `<site>.<action>`                  |
| V4-G02 | site capability discovery     | resource/tool catalog       | 能按 site/action 查工具                 |
| V4-G03 | golden transcript             | regression tests            | 不出现 raw Playwright 默认路径          |
| V4-G04 | fallback policy               | browser hand fallback guide | 何时用 browser_observe/browser_act 明确 |
| V4-G05 | result-to-dataset workflow    | agent recipe                | 抽取后查 provenance                     |

出站条件：

- 模型能在不知道 Playwright 的情况下完成站点抽取。
- 没有成熟业务 capability 时，模型才走 browser hand fallback。
- 所有 fallback 都保留 trace/failure evidence。

### 阶段 H：发布门禁和运行时运维

目标：把真实 runtime 漂移、打包缺资源、浏览器 canary 纳入发布前必检。

任务：

| ID     | 任务                          | 输出            | 验收                                          |
| ------ | ----------------------------- | --------------- | --------------------------------------------- |
| V4-H01 | Browser runtime install check | diagnostics     | 缺 chrome/firefox 给明确 remediation          |
| V4-H02 | Real canary suite             | canary evidence | Extension/Cloak/Electron 至少覆盖核心路径     |
| V4-H03 | Package resource gate         | package smoke   | 缺 runtime extraResources 时分级处理          |
| V4-H04 | Release dashboard             | QA summary      | CI/手工/环境缺口一屏可见                      |
| V4-H05 | Adapter release gate          | adapter CI      | fixture + target smoke + schema + repairScope |

出站条件：

- 本机缺 `chrome/` 或 `firefox/` 时，不再变成模糊失败。
- package smoke 和 real canary 结果都进入 evidence。
- 每个 official adapter 发布前都有明确 runner 覆盖。

---

## 5. 首批垂直切片建议

### Slice 1：公开页面只读抽取到 Dataset

目的：最小业务价值。

路径：

```text
<site>.extract_product
  -> runtime_plan
  -> browser_observe
  -> read-only runner
  -> dataset write + provenance
```

验收：

- 一个真实 URL 输入，返回结构化字段。
- 写入 dataset。
- row provenance 可查。
- selector 改坏后生成 repair evidence。

### Slice 2：登录页面只读抽取

目的：验证人机共用 profile。

路径：

```text
profile_ensure_logged_in
  -> visible human handoff
  -> session_prepare
  -> <site>.extract_account_data
```

验收：

- 未登录时返回 `needs_manual_login`。
- 人登录后同一 profile 继续执行。
- 不泄露 password/cookie/token。

### Slice 3：Lab 生成 fixture 并修复 selector

目的：验证开发体验和修复闭环。

路径：

```text
Lab capture
  -> fixture + expected
  -> runner
  -> failure
  -> repair
  -> regression
```

验收：

- 10 分钟内从页面生成可提交 fixture。
- 故意失效 selector 可被 Repair Studio 修复。
- repairScope 拒绝 core 修改。

### Slice 4：低风险状态化 Procedure

目的：验证写动作模型。

候选动作：

- 保存搜索条件。
- 添加商品到本地清单。
- 填写草稿但不提交。

验收：

- 每步可回放。
- verification 不依赖模型猜测。
- 中途 abort 清理 lease。

---

## 6. 新增能力 Definition of Done

任何新增业务 Capability 必须满足：

- 有 input/output schema。
- 有 assistant guidance 和 surface 定义。
- 有 scopes、sideEffectLevel、retryPolicy、idempotency 说明。
- 需要浏览器时使用 `runtime_plan` / `session_prepare`。
- 需要登录时使用 `profile_ensure_logged_in`。
- 使用 Site Adapter Runner，不暴露 Playwright page。
- 成功写 dataset 时记录 provenance。
- 失败时记录 trace / failure bundle / site adapter evidence。
- 有 fixture runner 测试。
- 有目标 runtime smoke 或明确环境缺口。
- 有 schema parity / inventory 覆盖。
- 不泄露 cookie/password/token/Authorization/Set-Cookie。

任何新增 Site Adapter Pack 必须满足：

- manifest schema 通过。
- import boundary 通过。
- repairScope 明确。
- fixture/expected 可复跑。
- output confidence/selectorHits/missingFields 可诊断。
- 站点业务代码不进入 framework core。
- 不决定 profile/runtime。
- 不写 dataset/artifact/profile。

任何新增 Procedure 必须额外满足：

- 状态可序列化。
- action trace 可查询。
- state transition 可回放。
- sideEffectLevel 明确。
- 高风险动作有显式确认。
- write repair 需要 target canary 和人工审核。

---

## 7. 关键风险和对策

| 风险                   | 表现                              | 对策                                                   |
| ---------------------- | --------------------------------- | ------------------------------------------------------ |
| 模型回退 Playwright    | 让 agent 写 page/locator/evaluate | golden transcript + default surface 限制 + playbook    |
| Lab 与生产 runner 漂移 | Lab 能跑，生产失败                | fixture runner 只作静态回归，target runtime smoke 必过 |
| 站点修复越权           | 模型改 core 或 schema             | repairScope 写闸 + diff review + forbidden path tests  |
| 登录态泄漏             | fixture/trace 中出现 cookie/token | 字符串级 redaction + artifact audit                    |
| 写动作不可回放         | 失败后不知道做了什么              | Procedure state/action trace/verification              |
| provenance 断链        | dataset 行不知道来源              | staged write + run ledger + UI 查询                    |
| runtime 缺资源         | canary/打包失败难诊断             | runtime install check + release evidence               |
| 站点能力碎片化         | 每个站点各写一套                  | Site Adapter Pack 模板 + capability template           |

---

## 8. 推荐文件和模块落点

已有地基优先复用：

- `src/core/site-adapter-runtime/`
- `src/core/browser-runtime/`
- `src/core/ai-dev/orchestration/`
- `src/core/ai-dev/capabilities/`
- `src/core/observability/`
- `src/main/duckdb/dataset-provenance-service.ts`
- `src/main/mcp-guidance-content.ts`
- `examples/web-site-adapter-static-product/`

建议新增：

```text
site-adapters/
  <site-id>/

src/core/site-adapter-lab/
  fixture-capture.ts
  selector-workbench.ts
  runner-diff.ts

src/main/site-adapter-lab/
  routes-or-ipc.ts
  artifact-service.ts

src/renderer/src/components/SiteAdapterLab/

src/core/ai-dev/capabilities/site-capability-catalog.ts

docs/site-adapter-pack-template.zh-CN.md
docs/site-adapter-lab-user-guide.zh-CN.md
```

是否新建 `site-adapters/` 目录可以在第一站点落地前最终决定。原则是：framework core 只放通用 runtime，站点业务代码不要混进 `src/core/site-adapter-runtime/`。

如果从当前 `examples/web-site-adapter-*` 迁移到 `site-adapters/`，必须同时完成：

- 更新 `DEFAULT_SITE_ADAPTER_REPAIR_ROOT_PATTERN` 或 manifest 级 repairScope。
- 补 forbidden path / path traversal / allowed subpath 测试。
- 保持 `extractors/verifiers/fixtures/expected` 以外的默认路径不可写。
- 保持 adapter 不能 import Node/Electron/Playwright/DuckDB 的边界测试。

---

## 9. 里程碑

### M1：只读业务能力 MVP

完成标准：

- 第一个真实站点只读 capability 可被 MCP 调用。
- 成功写 dataset + provenance。
- 失败能生成 repair evidence。
- fixture runner 和 target runtime smoke 有证据。

### M2：Lab MVP

完成标准：

- 能从真实页面生成 fixture/expected。
- 能跑 extractor/verifier。
- 能展示 selector diagnostics 和 expected diff。
- 能打开 failure bundle。

### M3：登录只读能力

完成标准：

- 需要登录的只读 capability 跑通。
- 人工登录接管跑通。
- profile 登录态跨 acquire 保持。
- 不泄露敏感信息。

### M4：Repair Studio MVP

完成标准：

- 故意破坏 selector 后，能从 failure bundle 修复到通过 fixture。
- repairScope 拒绝越权。
- 修复有 diff、测试、审核记录。

### M5：状态化 Procedure MVP

完成标准：

- 一个低风险写动作 procedure 跑通。
- 每步 action trace 和 verification 可查。
- abort/retry/lease/provenance 不残留坏状态。

### M6：发布门禁

完成标准：

- package smoke、runtime install check、real canary、adapter CI 汇总到 evidence。
- 缺 chrome/firefox 等环境问题可被明确标记，而不是误判代码失败。

---

## 10. 建议优先级

立即做：

1. 阶段 A：能力模板和生成快照。
2. 阶段 B：第一个真实只读站点能力。
3. 阶段 C：Lab MVP 的 fixture capture + runner panel。

随后做：

4. 阶段 D：登录只读能力。
5. 阶段 E：只读 Repair Studio。
6. Dataset / Trace 产品化视图。

再之后做：

7. 状态化 Procedure。
8. 写动作 repair。
9. 多站点 adapter pack 和生态分发。

不要提前做：

- 大批站点能力。
- 高风险写动作。
- 自动发布 repair。
- 默认暴露 Lab/Repair 工具给 agent。
- 复杂多 agent 自治修复。

---

## 11. 最终验收口径

这一阶段完成的标志不是“又多了一批工具”，而是以下事实成立：

- 至少一个真实站点可以从页面抽取到 dataset，并能追溯来源。
- 至少一个需要登录的只读能力能通过人工接管复用同一 profile。
- 开发者可以用 Lab 生成 fixture、调试 selector、复跑 runner。
- 站点 selector 失效时，Repair Studio 能在 adapter scope 内修复并回归。
- agent 默认路径调用业务 Capability，不需要知道 Playwright。
- 任何失败都能落到 trace / failure bundle / repair bundle。
- 发布前能区分代码失败、站点变化、登录态问题、runtime 缺资源和环境缺口。

### 11.1 v4 完成关闭门禁

完成 M1-M6 之后，不能只按任务表勾选完成。必须补一轮总验收，作为宣布 `docs/zg.v4.md` 产品闭环完成的关闭门禁：

- 生成并归档 capability / MCP public surface / runtime descriptor / repairScope 快照。
- 默认 MCP surface 不暴露 raw Playwright、Lab、Repair 或任意文件写工具。
- 至少一个公开页面只读站点能力可以从真实 URL 抽取到 dataset，并能查到 row provenance。
- 至少一个需要登录的只读站点能力可以通过人工接管复用同一 profile 继续执行。
- Site Adapter Lab 可以从真实页面生成 fixture / expected，并能复跑 extractor / verifier。
- Repair Studio 可以从 failure bundle 生成 scoped repair，repairScope 拒绝 core/schema/main process 越权修改。
- 一个低风险 Procedure 可以完成 action trace、verification、replay、abort 清理。
- Dataset row provenance、trace summary、failure bundle、site adapter repair bundle 可以从 UI 或 MCP 入口串起来查询。
- golden transcript 证明 agent 默认调用业务 Capability，只有缺少成熟能力时才使用 browser hand fallback。
- package smoke、runtime install diagnostics、real runtime canary、adapter CI 都进入 evidence。
- `verify:ci` 或等价增强门禁通过；若真实浏览器 runtime 缺失，必须以明确环境缺口记录，不能当作已覆盖。

只有这些关闭门禁都有证据，才可以把 v4 状态从“架构已定义、地基已完成、剩余能力实施中”更新为“产品闭环完成”。

一句话：

```text
地基完成后，下一步不是给模型更多手指，
而是让这些手指握成稳定的业务能力、调试工具、修复流程和可追溯数据。
```
