# 天蛇客户端全量审计计划

## 最近一次报告

- 报告文件：`docs/full-audit-report.zh-CN.md`
- 报告日期：2026-06-17
- 最近同步：2026-06-17
- 本轮已完成：八模块纵向审计 + 九主题横向复盘，产出 P0×2 / P1×9 / P2×18 / P3×4 backlog（见报告第 12 节）。测试 baseline 实测 351 文件。
- 待处理：P0（AUD-M1-01/M7-01 迁移事务化、AUD-M1-02 导入孤儿对账）优先；其余按报告第 13 节路线图。

### 差异记录

| 日期 | 来源 | 差异 | 处理 |
| --- | --- | --- | --- |
| 2026-06-15 | `docs/full-audit-report.zh-CN.md` | 报告新增 P1/P2/P3 修复 backlog，并记录本轮已完成的高优先级稳定性修复。 | 计划新增“最近一次报告”和“差异记录”固定锚点；每轮审计结束时同步完成项、待处理项和新增差异。 |
| 2026-06-17 | `docs/full-audit-report.zh-CN.md` | 全量重新生成报告：测试 baseline 实测 351 文件（含 `test:inventory`/`test:package-smoke`，证实计划假设的"打包 smoke 真缺口"已部分落地）；发现跨存储非原子（迁移/导入/卸载同构）为最高优先级主题；确认默认 `enableAuth:false` 合约；新增工程卫生项 AUD-HYG-01（scheduler-service.ts 等 3 文件 mojibake）。 | 同步本轮完成项与待处理 P0；下一轮带复现步骤验证报告中"需确认"的开放项（配置原子写、HNSW 版本头、日志 rotation、health 三态）。 |

## 1. 目标

本计划用于对天蛇客户端进行一次面向稳定性、健壮性和功能完整度的全量代码审计。审计方法采用“按功能模块纵向深挖，再用少量横向主题统一复盘”的方式，避免一次性铺开导致问题只停留在表面。

本计划暂不覆盖“权限与信任边界”这一**独立安全审计主题**。深层授权设计、插件信任模型、凭证处理、威胁建模应作为独立安全审计执行。

但要注意：信任边界代码并不是孤立的几个文件，而是穿插在多个子系统内部的“稳定性即安全”双面控制。以下几类守卫**在本计划范围内**，因为它们同时是数据防腐和合约稳定性的核心，把它们划给推迟的安全审计会导致模块一/四/五在“被告知不许读”的代码上下结论：

- `src/main/duckdb/sql-validator.ts` 的 `checkSecurity` / `sanitizeIdentifier`：拦截 DROP/DELETE/TRUNCATE，是阻止畸形计算列表达式破坏 dataset 表的防线（模块一核心）。
- `src/main/network-target-policy.ts` 的 `assertPublicHttpTarget`：既是 SSRF 防护，又决定 webhook 投递可靠性与错误分类（模块五/六）。
- `src/constants/http-api.ts` 的 `enableAuth` 默认值与 `src/main/http-auth-middleware.ts` 的接线方式：默认是否鉴权是模块四必须给出的合约事实。
- `src/main/mcp-http-route-handlers.ts` 的 `validateMcpOrigin`：401 / invalid-origin 已经是 `http-server-composition.test.ts`、`mcp-server-http-transport.test.ts` 里编码的契约行为。
- 各 handler 里穿插的 `senderGuard`：重点是“漏传即静默放行”这种健壮性 bug，而非授权策略设计本身。

仅 capability scoping 设计、插件信任模型、凭证存储这些纯授权/威胁建模议题留给独立安全审计。

## 2. 审计原则

1. 以真实用户流程为主线，而不是只按目录逐文件阅读。
2. 每个模块都要覆盖正常路径、失败路径、并发路径、升级路径和可观测性。
3. 审计结论必须能落成 issue、测试、重构任务或文档修订。
4. 优先审查会造成数据损坏、任务卡死、状态污染、升级失败、资源泄漏和不可诊断故障的问题。
5. 对高风险流程要求证据：代码位置、复现步骤、现有测试、缺失测试、建议修复方案。
6. **先盘点后补缺**：本仓库已有大量测试文件（数百个 `.test.ts` + 数十个 `.test.tsx`，具体数量由阶段一 baseline 盘点实测填入，不在本计划写死），分层清晰（`.contract.test`、`.integration.test`、`.smoke.test`、`cross-runtime-contract`、`real-contract`、`canary`）。每个模块审计的第一步是列出该子系统现有的 `*.test.ts(x)` 与对应 npm script、标注覆盖层级（unit / contract / integration / smoke），再 diff 出真正的空白。严禁在已有大型测试套件的区域“从零编写测试”——“必要测试建议”一律先判定为“评估现有套件充分性”，确认缺失后才提议新增。严禁在已有大型测试套件的区域“从零编写测试”——“必要测试建议”一律先判定为“评估现有套件充分性”，确认缺失后才提议新增。

## 3. 范围

### 3.1 八个纵向审计对象

1. 本地数据工作台。
2. 浏览器自动化工作流。
3. 插件系统。
4. 本地 HTTP/MCP 自动化端点。
5. 桌面调试与运行健康系统。
6. 任务系统和后台流程。
7. 配置、存储、启动和升级系统。
8. 本地能力原语（AI / CV / 向量检索 / OCR / 原生 FFI）。

> 注：第 8 项是对原始七模块切分的修正。`ai-service`、`onnx-runtime`、`image-search`、`image-similarity`、`system-automation`、`ffi` 六个子系统是真实运行、高风险的本地计算层，原计划只把它们当作插件 namespace 的薄 facade 而漏在范围之外。它们的实现本体（ONNX 推理、HNSW 向量索引、模型下载、OCR/CV worker pool、koffi 调原生 DLL）必须独立审计。

### 3.2 九个横向审计主题

1. 架构边界。
2. 数据安全与一致性。
3. 插件系统稳定性。
4. 浏览器自动化可靠性。
5. API/MCP 合约质量。
6. 错误处理与可观测性。
7. 测试覆盖。
8. 依赖与供应链。
9. 发布与升级。

## 4. 总体执行顺序

### 阶段一：审计准备

目标是得到项目的真实结构图和审计切入点。

检查内容：

- 阅读 `README.md`、`README.zh-CN.md`、`ROADMAP.md`、`SECURITY.md`、`docs/` 下现有设计文档。
- 梳理 `src/core`、`src/main`、`src/renderer`、`src/preload`、`src/shared` 的职责边界。
- 梳理 Electron 主进程、预加载脚本、渲染进程、本地服务、插件 helper、浏览器运行时之间的调用关系。
- 梳理现有测试命令，**完整清单**包括 `test:open`、`test:open:full`、`test:architecture`、`test:main-bootstrap`、`test:browser-pool`、`test:dataset-ipc`、`typecheck`、`lint`、`verify:supply-chain`、`verify:open-source-boundary`、`sbom`、`verify:ci`。注意原计划遗漏的两项：
  - `test:main-bootstrap` 覆盖 `app-runtime` + `bootstrap/{app-ready,runtime-error,shutdown,stdio}` + `browser-pool-readiness`，直接回答模块七（配置、存储、启动和升级系统）关于启动阶段测试的开放问题。
  - `test:architecture` 是一整层结构性治理测试（`architecture-maintenance-guard.test.ts` 做 AST 扫描、`HARD_SIZE_LIMIT=900` 文件大小基线、`architecture-boundary` 与 edition 边界），应登记为现有覆盖强项，而非缺口。
- 跑一遍 `vitest --coverage` 或至少枚举全部 `*.test.ts(x)`，按子系统建立**覆盖 baseline**，作为后续每个模块“先盘点后补缺”的依据。

产出：

- 一张模块依赖图。
- 一张核心数据流图。
- 一张启动流程图。
- 一张**现有测试覆盖 baseline 表**（按子系统列出 test 文件 + 覆盖层级 + 对应 npm script）。
- 审计 issue 模板和严重级别定义。

### 阶段二：八个模块纵向深挖

每次只审一个模块。每个模块都按“入口、核心流程、状态模型、失败路径、并发行为、测试、日志、升级影响”八个维度展开。每个模块的第一步统一是“盘点现有测试覆盖，diff 出真空白”（见审计原则 6）。

建议顺序：

1. 本地数据工作台。
2. 浏览器自动化工作流。
3. 任务系统和后台流程。
4. 本地能力原语（AI / CV / ONNX / 向量检索 / OCR / FFI）。
5. 插件系统。
6. 本地 HTTP/MCP 自动化端点。
7. 桌面调试与运行健康系统。
8. 配置、存储、启动和升级系统。

### 阶段三：九个横向主题复盘

纵向模块审完后，用九个横向主题统一校准。重点检查不同模块之间是否有不一致的错误模型、状态模型、日志字段、测试策略、迁移策略和发布策略。

### 阶段四：修复计划和回归验证

将发现的问题按风险分层：

- P0：可能导致数据损坏、主流程不可用、应用无法启动、任务无限卡死、升级不可恢复。
- P1：高频用户流程失败、资源泄漏、并发状态污染、错误不可诊断、关键测试缺失。
- P2：边缘流程不稳定、日志不足、类型边界不清、局部测试薄弱。
- P3：文档缺失、命名不一致、维护性问题、低风险清理项。

每个问题都应包含：

- 标题。
- 严重级别。
- 影响模块。
- 影响场景。
- 代码位置。
- 复现方式。
- 当前行为。
- 期望行为。
- 修复建议。
- 需要新增或修改的测试。

## 5. 模块一：本地数据工作台

### 5.1 审计目标

确认导入、查询、修改、导出和组织数据集的链路在大数据量、异常输入、并发操作和中断恢复场景下仍然可靠。

### 5.2 重点代码区域

- `src/main/duckdb`
- `src/main/ipc-handlers`
- `src/core/query-engine`
- `src/core/js-plugin/helpers.ts` 中 `helpers.database`
- `src/renderer/src/stores` 中数据集相关 store
- `src/renderer` 中数据集页面、表格、导入导出 UI
- `src/types`、`src/shared` 中数据集 schema 和 IPC 类型

### 5.3 核心流程

需要逐条走读：

- 创建数据集。
- 导入 CSV、Excel、JSON 或其他支持格式。
- 字段类型推断、schema 更新、列名冲突处理。
- 查询、筛选、排序、分页、虚拟滚动。
- 单条和批量记录修改。
- 数据集组织、重命名、删除。
- 导出数据。
- 插件通过 helper 访问数据集。
- 渲染进程通过 IPC 调用主进程数据能力。

### 5.4 深挖问题清单

架构边界：

- 查询引擎、DuckDB 存储、IPC handler、渲染层 store 是否职责清晰。
- SQL 构造、字段映射和 UI 状态是否混杂。
- 插件 helper 是否绕过主数据层直接读写底层存储。

数据安全与一致性：

- 导入失败是否会留下半成品表或不一致 metadata。
- 批量修改是否具备事务或等价的回滚机制。
- 并发导入、并发修改、导入同时查询是否有锁或队列约束。
- 字段类型变化是否影响旧记录、查询条件和导出结果。
- 删除数据集时相关索引、缓存、附件或派生文件是否同步清理。

错误处理与可观测性：

- 导入失败是否能定位到文件、行号、字段和原始错误。
- 查询失败是否区分 SQL 错误、schema 错误、数据文件损坏和资源不足。
- 大文件导入是否有进度、取消和失败包。

测试覆盖：

- 是否已有导入、查询、修改、导出测试。
- 是否覆盖空文件、非法编码、超大文件、重复列名、特殊字符列名、类型不一致。
- 是否覆盖并发写入和异常中断。

发布与升级：

- 数据库 schema、metadata schema、导入历史和导出格式是否有版本化策略。
- 旧版本数据集在新版本中是否可读。

### 5.5 必要测试建议

- 数据集 IPC 合约测试。
- DuckDB 事务和异常回滚测试。
- 大文件导入压力测试。
- 导入中断恢复测试。
- 插件 helper 数据库访问测试。
- 导出结果快照测试。

### 5.6 产出

- 数据工作台流程图。
- 数据状态机和事务边界说明。
- 数据一致性风险列表。
- 缺失测试列表。
- 高风险修复任务。

## 6. 模块二：浏览器自动化工作流

### 6.1 审计目标

确认浏览器配置、账号绑定、代理、指纹、浏览器池和自动化控制链路在多 runtime、多 profile、并发任务和异常退出场景下可靠运行。

### 6.2 重点代码区域

- `src/core/browser-runtime`
- `src/core/browser-pool`
- `src/core/browser-core`
- `src/core/browser-automation`
- `src/core/browser-extension`
- `src/core/browser-ruyi`
- `src/core/fingerprint`
- `src/core/stealth`
- `src/main/profile`
- `docs/browser-runtime-refactor-plan.md`
- `docs/browser-runtime-git-change-review.md`

### 6.3 核心流程

需要逐条走读：

- 创建和编辑 profile。
- 绑定账号和平台。
- 配置代理。
- 生成和应用指纹。
- 选择 runtime 并启动浏览器。
- 从浏览器池获取、续租和释放 session。
- 自动化任务打开页面、执行操作、采集结果。
- 浏览器崩溃、关闭、超时、任务取消。
- 运行时健康检查和降级提示。

### 6.4 深挖问题清单

架构边界：

- runtime、profile、pool、automation controller、extension relay 是否职责分离。
- 业务层是否直接依赖具体 runtime 名称，而不是 capability。
- Electron 内嵌、extension relay、Firefox/Ruyi、Cloak/Playwright 等路径是否存在重复条件分支。

浏览器自动化可靠性：

- 浏览器实例是否可能泄漏。
- profile user data dir 是否可能被多个任务同时写入。
- 账号和 profile 状态是否可能串号。
- 代理失败、指纹失败、extension relay 失败时是否有明确失败状态。
- wait queue、lease、release、forced close 是否有一致状态机。
- 任务取消是否能真正停止浏览器侧操作。
- 崩溃后 pool 是否能感知并清理。

错误处理与可观测性：

- 启动失败是否区分 binary 缺失、profile 锁定、代理失败、extension 未加载、协议连接失败。
- 每次 lease 是否有 trace id。
- 浏览器运行日志、控制协议日志和任务日志是否能串起来。

测试覆盖：

- 是否覆盖 pool manager、wait queue、closed persistent session、live lease。
- 是否有真实浏览器或 Playwright 层面的集成测试。
- 是否覆盖并发 profile 租用和异常释放。

发布与升级：

- runtime 配置变更是否兼容旧 profile。
- 浏览器 binary、extension 包、fingerprint schema 的版本变化是否可诊断。

### 6.5 必要测试建议

- 浏览器池 lease 状态机测试。
- profile 并发启动冲突测试。
- 代理失败模拟测试。
- runtime capability probe 测试。
- 浏览器崩溃清理测试。
- 自动化任务取消测试。

### 6.6 产出

- 浏览器 runtime 能力矩阵。
- profile/session 状态机。
- 浏览器池资源泄漏风险报告。
- 启动失败分类表。
- 集成测试补强计划。

## 7. 模块三：插件系统

### 7.1 审计目标

确认一方可信插件的加载、启停、升级、helper 调用、插件自有数据、页面、命令和定时任务不会破坏主应用稳定性。

### 7.2 重点代码区域

- `src/core/js-plugin`
- `docs/plugin-helpers-reference.md`
- `examples/minimal-plugin`
- 插件相关 renderer 页面和 store
- 插件相关 IPC handler
- `src/main/scheduler`
- `src/core/task-manager`

### 7.3 核心流程

需要逐条走读：

- 插件发现和加载。
- 插件 manifest 解析。
- 插件初始化和销毁。
- 插件命令注册。
- 插件页面注册和渲染。
- 插件自有数据表创建和迁移。
- 插件存储读写。
- 插件 helper 调用。
- 插件定时任务创建、暂停、恢复、触发和历史记录。
- 插件升级和卸载。

### 7.4 深挖问题清单

架构边界：

- 插件 runtime、helper 注册、插件页面、插件数据是否边界清楚。
- 插件是否能稳定复用主应用能力，而不是复制业务逻辑。
- helper namespace 是否有清晰归属和错误模型。

插件系统稳定性：

- 单个插件初始化失败是否影响其他插件或主应用启动。
- 插件重复加载是否会重复注册命令、页面、事件或定时任务。
- 插件卸载是否清理事件监听、定时器、缓存和数据连接。
- helper 调用是否有超时、取消和资源清理。
- 插件升级时自有数据表是否有迁移策略。
- 插件异常是否能被隔离并记录到插件级日志。

数据安全与一致性：

- 插件自有数据表创建、修改、删除是否有事务。
- 插件操作数据集时是否复用数据工作台的一致性机制。

错误处理与可观测性：

- 插件错误是否包含 plugin id、version、hook、helper namespace、trace id。
- 插件启动失败是否能在 UI 和日志中定位。
- 插件定时任务失败是否记录历史和下一次计划。

测试覆盖：

- 是否有最小插件加载测试。
- 是否覆盖 helper 参数校验、失败路径和资源清理。
- 是否覆盖插件升级、重复加载和卸载。

### 7.5 必要测试建议

- 插件 manifest schema 测试。
- 插件生命周期测试。
- helper namespace 合约测试。
- 插件定时任务恢复测试。
- 插件数据表迁移测试。
- 插件失败隔离测试。

### 7.6 产出

- 插件生命周期状态机。
- helper 能力矩阵。
- 插件异常隔离报告。
- 插件测试缺口列表。

## 8. 模块四：本地 HTTP/MCP 自动化端点

### 8.1 审计目标

确认本地端点作为 Agent、CLI 工具和编排客户端的入口时，具备清晰、稳定、可测试、可诊断的调用合约。

注意：这里**不是**“HTTP 或 MCP 二选一”的两套服务，而是**单一的 MCP-over-HTTP 统一服务器**——MCP 协议跑在 HTTP 传输之上。审计时按这一事实组织，不要去找两个独立 server。同时必须把“默认是否鉴权”作为合约事实给出结论：`src/constants/http-api.ts` 的 `DEFAULT_HTTP_API_CONFIG` 默认 `enableAuth: false`，`src/main/http-server-composition.ts` 只有在拿到 token 时才挂 auth 中间件（`if (authToken) { registerTokenAuthMiddleware(...) }`），因此默认状态下 `/api/v1/orchestration/*` 无需 Bearer 即可驱动 browser + profile + plugin + dataset 网关。合约审计不能跳过这一点（参见 section 1 的双面守卫说明）。

### 8.2 重点代码区域

不要再用一行概括或指向 `bootstrap`/`runtime`/`ipc-handlers` 等边缘目录；实现本体集中在 `src/main` 下约 30 个 `http-*.ts` / `mcp-*.ts` 文件，按九个子域点名走读：

- **会话生命周期**：`mcp-http-session-runtime.ts`、`mcp-http-session-lifecycle.ts`、`mcp-http-session-snapshot.ts`、`http-session-manager.ts`、`http-session-bridge.ts`。
- **传输**：`mcp-http-transport-utils.ts`、`mcp-server-http-transport`（见 `mcp-server-http-transport.test.ts`）。
- **catalog**：`mcp-http-catalog.ts`、`mcp-catalog-metadata.ts`、`mcp-guidance-content.ts`、`mcp-initialize-instructions.ts`。
- **orchestration**：`orchestration-http-routes.ts`。
- **幂等**：`orchestration-idempotency-duckdb-store.ts`（活的 orchestration 幂等存储，不要当成 cloud-sync 跳过）。
- **auth**：`http-auth-middleware.ts`、`http-api-config-guard.ts`、`src/constants/http-api.ts` 的 `enableAuth` 默认值。
- **运行时可用性与诊断**：`mcp-http-runtime-availability.ts`、`http-runtime-diagnostics.ts`、`http-runtime-state.ts`。
- **路由注册与 composition**：`http-server-composition.ts`、`http-server-lifecycle.ts`、`http-route-registry.ts`、`http-system-routes.ts`、`mcp-http-route-handlers.ts`、`http-response-mapper.ts`、`http-error-utils.ts`、`http-request-utils.ts`、`http-trace-middleware.ts`。
- **SDK init shim**：`mcp-sdk-initialize-shim.ts`、`mcp-server-http.ts`。
- 端点入参/出参 schema（`src/shared`、`src/types`）与 Agent / CLI / 插件 helper 桥接代码。
- 注意 `src/core/http-client` 是**出站** HTTP 客户端（get/post/put/delete），不注册路由、不管会话，**不属于本模块**；它应在调用方（数据/浏览器/webhook）上下文里审，别列进入站端点合约。

### 8.3 核心流程

需要逐条走读：

- 服务启动和关闭。
- 端点注册。
- 请求 schema 校验。
- 调用数据工作台能力。
- 调用浏览器自动化能力。
- 调用插件能力。
- 长任务创建和结果返回。
- 超时、取消、重试。
- 错误响应。

### 8.4 深挖问题清单

架构边界：

- HTTP/MCP 层是否只做协议适配，不直接承担业务逻辑。
- 端点 schema 是否和内部类型解耦或明确绑定。
- 长任务是否通过统一 task manager，而不是每个端点自建状态。

API/MCP 合约质量：

- 每个端点是否有明确输入、输出、错误结构。
- 参数校验是否集中、可复用、可测试。
- 错误码是否稳定，是否可被 Agent/CLI 自动处理。
- 长任务是否返回 task id、进度、最终结果和失败原因。
- 操作是否具备幂等性，或者明确标注不可幂等（对照 `orchestration-idempotency-duckdb-store.ts` 的实际行为）。
- 是否区分同步请求、异步任务、流式输出和事件通知。
- **默认鉴权状态**：`enableAuth: false` 下端点的默认合约是否被文档明确说明？401 / invalid-origin（已在 `http-server-composition.test.ts`、`mcp-server-http-transport.test.ts` 中编码）是否是稳定且可被客户端处理的合约行为？

错误处理与可观测性：

- 每个请求是否有 request id 或 trace id。
- 是否记录调用端、端点名、耗时、状态码、错误类别。
- 是否避免把大 payload、密钥、账号状态和敏感文件路径直接写入日志。

测试覆盖：

- 是否有端点合约测试。
- 是否有 schema 快照或类型一致性测试。
- 是否覆盖超时、取消、并发请求、下游模块失败。

### 8.5 必要测试建议

先盘点：`mcp-server-http.*.test.ts`（auth-invoke、browser-binding、mcp-surface、orchestration-routes、split-contract、start-stop、transport-session 等多个 30–55KB 大文件）、`mcp-server-http-transport.test.ts`、`orchestration-openapi-contract.test.ts`、`http-server-composition.test.ts`、`http-session-manager.test.ts`、`http-session-bridge.test.ts`、`mcp-http-session-runtime.test.ts`、`mcp-http-runtime-availability.test.ts`、`mcp-http-types.test.ts`、`http-api-handler.test.ts` 已经存在。本模块的测试任务**主要是评估上述套件的充分性**，而非从零编写。

确认缺失后才提议新增，候选缺口：

- 默认 `enableAuth: false` 与显式开启 token 两种模式下的端点行为对比测试（若现有 auth-invoke 测试未覆盖默认放行路径）。
- schema 快照或类型一致性测试（若 openapi-contract 未覆盖全部端点）。
- 下游模块失败（dataset / browser / plugin 网关报错）向上映射为稳定错误码的测试。
- 并发请求与长任务取消测试（若 transport-session 测试未覆盖）。

### 8.6 产出

- 端点清单。
- API/MCP 合约表。
- 错误码矩阵。
- 长任务调用规范。
- Agent/CLI 兼容性风险列表。

## 9. 模块五：桌面调试与运行健康系统

### 9.1 审计目标

确认应用在启动失败、运行异常、浏览器崩溃、任务失败、数据异常和插件异常时，能够提供足够信息用于定位、恢复和用户反馈。

### 9.2 重点代码区域

- `src/core/observability`
- `src/main/bootstrap`
- `src/main/runtime`
- `src/core/errors`
- 日志初始化和 pino 配置。
- trace、失败包、健康检查相关代码。
- 渲染进程错误边界和通知组件。

### 9.3 核心流程

需要逐条走读：

- 应用启动诊断。
- 主进程未捕获异常处理。
- 渲染进程错误处理。
- 任务 trace 创建和传递。
- 浏览器启动失败诊断。
- 插件失败记录。
- 数据导入失败包生成。
- 健康检查展示。
- 日志文件轮转和清理。

### 9.4 深挖问题清单

架构边界：

- 错误分类、日志、trace、用户提示是否分层。
- 业务模块是否直接拼接错误文本，还是使用统一错误类型。
- 主进程、渲染进程、插件和浏览器运行时是否共享 trace 约定。

错误处理与可观测性：

- 错误是否有 code、message、cause、context、recoverable、retryable 等字段。
- 是否能从一次用户操作串起 UI、IPC、主进程、任务、浏览器或数据层日志。
- 失败包是否包含版本、平台、配置摘要、关键日志、trace id 和复现线索。
- 健康检查是否能区分可用、降级、不可用。
- 日志是否有大小限制和保留策略。

测试覆盖：

- 是否测试未捕获异常、启动失败、健康检查失败、失败包生成。
- 是否测试错误序列化跨 IPC 后不会丢失关键信息。

### 9.5 必要测试建议

- 错误类型序列化测试。
- trace 贯穿 IPC 的测试。
- 健康检查状态聚合测试。
- 失败包内容快照测试。
- 启动诊断失败路径测试。

### 9.6 产出

- 错误分类规范。
- trace 字段规范。
- 失败包字段清单。
- 健康检查矩阵。
- 不可诊断故障列表。

## 10. 模块六：任务系统和后台流程

### 10.1 审计目标

确认定时任务、长任务、后台自动化任务和插件任务具备完整状态机、可取消、可重试、可恢复、可追踪，不会重复执行危险操作或永久卡住。

### 10.2 重点代码区域

- `src/core/task-manager`
- `src/main/scheduler`
- `src/core/js-plugin/helpers.ts` 中 `helpers.scheduler`
- 浏览器自动化任务相关代码。
- 数据导入导出任务相关代码。
- HTTP/MCP 端点触发任务相关代码。

### 10.3 核心流程

需要逐条走读：

- 创建任务。
- 排队和调度。
- 执行和进度更新。
- 暂停、恢复、取消。
- 超时和重试。
- 失败记录。
- 定时任务触发。
- 应用重启后的任务恢复。
- 插件任务卸载后的清理。

### 10.4 深挖问题清单

架构边界：

- 长任务是否都复用统一 task manager。
- 定时任务和即时任务是否有统一状态模型。
- 插件 scheduler 是否复用主调度器能力。

数据安全与一致性：

- 重试是否会重复导入、重复修改、重复提交外部请求。
- 任务失败后是否能标记部分成功、部分失败和可恢复状态。
- 取消任务是否会留下半写入数据。

错误处理与可观测性：

- 每个任务是否有 task id、trace id、owner、type、status、progress、startedAt、finishedAt。
- 任务失败是否有分类、cause、上下文和可重试标记。
- 定时任务历史是否足够定位问题。

测试覆盖：

- 是否覆盖任务状态转换合法性。
- 是否覆盖取消、超时、重试、并发执行、应用重启。
- 是否覆盖定时任务重复触发和错过触发。

### 10.5 必要测试建议

- 任务状态机单元测试。
- 重试幂等测试。
- 取消清理测试。
- 调度器时钟测试。
- 应用重启恢复测试。
- 插件任务隔离测试。

### 10.6 产出

- 任务状态机图。
- 重试和幂等策略表。
- 后台任务恢复策略。
- 卡死任务检测清单。
- 定时任务可靠性报告。

## 11. 模块七：配置、存储、启动和升级系统

### 11.1 审计目标

确认应用首次启动、正常启动、异常退出后启动、配置损坏、数据迁移、插件升级、浏览器 runtime 升级和桌面应用发布升级都可控。

### 11.2 重点代码区域

- `src/main/bootstrap`
- `src/main/runtime`
- `src/main/system`
- `src/main/schemas`
- `src/constants`
- `src/edition`
- `electron-builder.yml`
- `scripts/build-edition.js`
- `scripts/package-electron.js`
- `scripts/verify-supply-chain.js`
- `scripts/open-source-boundary.js`
- `scripts/generate-sbom.js`

### 11.3 核心流程

需要逐条走读：

- 首次启动。
- 加载配置。
- 初始化本地数据库和目录。
- 初始化日志。
- 初始化插件。
- 初始化浏览器 runtime。
- 启动本地服务。
- 异常退出后的再次启动。
- 应用版本升级。
- 打包和发布。
- 供应链验证。

### 11.4 深挖问题清单

架构边界：

- 启动流程是否分阶段，是否能清楚知道失败发生在哪一阶段。
- 配置读取、schema 校验、默认值补全、迁移是否分层。
- open edition 与其他 edition 的边界是否清晰。

数据安全与一致性：

- 配置写入是否原子化。
- 配置损坏是否有备份和恢复。
- 数据库迁移失败是否会破坏旧数据。
- 插件升级或卸载是否影响主数据。

错误处理与可观测性：

- 启动失败是否能输出结构化诊断。
- 迁移失败是否能定位版本、步骤和目标文件。
- 打包产物运行失败是否有最小日志。

测试覆盖：

- 是否有 app ready、runtime error、shutdown、stdio bootstrap 测试。
- 是否覆盖配置缺失、配置损坏、迁移失败、目录无权限。
- 是否覆盖打包产物 smoke test。

依赖与供应链：

- `package-lock.json` 是否稳定。
- 原生依赖是否可构建、可验证、可打包。
- 外部 tarball 依赖是否有来源和校验策略。
- SBOM 是否覆盖发布产物。

发布与升级：

- 版本号、迁移号、插件版本、runtime 版本是否有统一策略。
- 发布包是否包含必要资源，是否排除不该发布的临时文件。
- 回滚和重装是否不会破坏用户数据。

### 11.5 必要测试建议

- 启动阶段失败注入测试。
- 配置迁移测试。
- 配置损坏恢复测试。
- 应用升级模拟测试。
- 打包产物 smoke test。
- 供应链验证测试。

### 11.6 产出

- 启动阶段图。
- 配置 schema 和迁移表。
- 发布包资源清单。
- 升级和回滚风险列表。
- 供应链风险报告。

## 12. 模块八：本地能力原语

### 12.1 审计目标

确认本地 AI 推理、计算机视觉、向量检索、OCR 和原生 FFI 这一层在模型加载、推理失败、worker 崩溃、原生内存边界和并发背压场景下不会拖垮主应用。这一层是被插件 namespace 当作薄 facade 暴露的，但实现本体真实运行、且风险等级最高（原生内存安全、模型下载、worker 崩溃恢复）。

### 12.2 重点代码区域

- `src/core/ai-service`（OpenAI 兼容客户端、错误模型）。
- `src/core/onnx-runtime`（`onnx-service.ts`、`tensor-utils.ts`，CPU/CUDA/DirectML execution provider 回退）。
- `src/core/image-search`（`hnsw-index.ts` 向量索引、`mobilenet-extractor.ts` 特征提取、`model-download-safety.ts` 模型下载校验）。
- `src/core/image-similarity`（感知哈希、SSIM 比对）。
- `src/core/system-automation`（`ocr/` 与 `cv/` worker pool）。
- `src/core/ffi`（`ffi-service.ts`、`library.ts`、`callback.ts`，koffi 调原生 DLL）。
- `src/main/ipc-handlers/ocr-pool-handler.ts` 等把这些能力桥接到主进程/插件的入口。

### 12.3 核心流程

需要逐条走读：

- ONNX 模型加载、execution provider 选择与回退、推理调用、张量编解码。
- 模型下载、来源校验、完整性校验、缓存目录管理。
- HNSW 向量索引的构建、持久化、增量更新、并发查询。
- 特征提取与相似度比对管线。
- OCR / CV worker pool 的创建、任务分发、背压、超时、崩溃重启。
- FFI 库加载、原生函数调用、回调生命周期、句柄/内存释放。
- 上述能力通过插件 helper namespace 暴露时的参数校验与错误传递。

### 12.4 深挖问题清单

架构边界：

- AI/CV/向量/OCR/FFI 这五类原语是否各自边界清楚，还是互相直接调用底层实现。
- 插件 namespace 是否只是薄 facade，业务逻辑是否漏进了 facade 层。

数据安全与一致性：

- 模型下载是否校验来源与完整性，是否可能加载被篡改或不完整的模型。
- HNSW 索引文件损坏或版本不匹配时是否能检测并恢复。
- FFI 调用是否存在内存泄漏、double free、句柄泄漏、缓冲区越界。

稳定性与资源管理：

- worker pool 崩溃后能否感知并重启，崩溃任务是否标记失败而非永久挂起。
- 并发推理/OCR 任务是否有背压和队列上限，避免内存爆掉。
- execution provider 回退（CUDA→DirectML→CPU）是否在缺驱动/缺硬件时优雅降级而不是直接崩进程。
- 原生 DLL 缺失或版本不符时是否有清晰失败状态。

错误处理与可观测性：

- 推理失败、模型加载失败、FFI 调用失败、worker 崩溃是否各有可区分的错误类型与上下文。
- 原生层崩溃是否能在不丢失诊断信息的前提下被主进程捕获。

测试覆盖：

- `hnsw-index.test.ts`、`mobilenet-extractor.test.ts`、`model-download-safety.test.ts`、`image-similarity-service.test.ts`、`system-automation/types.test.ts` 已覆盖哪些路径，缺口在哪。
- 是否覆盖 worker 崩溃恢复、execution provider 回退、FFI 内存/崩溃边界、模型下载被篡改场景。

### 12.5 必要测试建议

先评估上述现有测试的充分性，再针对以下确认缺失的高风险路径补测：

- worker pool 崩溃重启与背压测试。
- execution provider 回退路径测试。
- FFI 原生内存/崩溃边界测试（含 double free、句柄泄漏）。
- 模型下载完整性/来源校验失败路径测试。
- HNSW 索引损坏检测与恢复测试。

### 12.6 产出

- 本地能力原语能力矩阵。
- 原生/ML 资源生命周期与崩溃恢复说明。
- 原生内存安全与模型下载安全风险列表。
- 缺失测试列表。

## 13. 九个横向主题复盘

### 13.1 架构边界

复盘问题：

- 八个模块是否都有清楚的 owner、入口、出口和依赖。
- 主进程、渲染进程、预加载脚本、core、shared、types 的边界是否稳定。
- IPC、HTTP/MCP、插件 helper 是否各自只是适配层，还是混入了核心业务逻辑。
- 是否存在跨模块直接访问内部状态、重复实现状态机、重复实现错误处理。

统一产出：

- 架构边界问题清单。
- 推荐依赖方向图。
- 需要拆分或收敛的模块列表。

### 13.2 数据安全与一致性

复盘问题：

- 所有写操作是否有事务、锁、队列或补偿策略。
- 是否存在半写入、重复写入、删除不彻底、缓存与存储不一致。
- 数据集、插件数据、任务状态、配置文件、浏览器 profile 的一致性规则是否明确。
- 是否有中断恢复和损坏检测。

统一产出：

- 数据状态资产表。
- 写入路径清单。
- 事务和锁策略表。
- 数据恢复策略。

### 13.3 插件系统稳定性

复盘问题：

- 插件 lifecycle、helper、scheduler、data table、page、command 是否都有失败隔离。
- 插件升级、重复加载、卸载、异常退出是否可控。
- 插件错误是否可诊断。

统一产出：

- 插件能力矩阵。
- 插件故障隔离策略。
- 插件升级测试清单。

### 13.4 浏览器自动化可靠性

复盘问题：

- runtime、profile、pool、account、proxy、fingerprint、automation task 是否有一致状态模型。
- 浏览器崩溃、协议断开、代理不可用、profile 锁定是否可恢复。
- 是否存在资源泄漏和状态污染。

统一产出：

- 浏览器状态机。
- runtime 健康矩阵。
- 资源泄漏排查表。

### 13.5 API/MCP 合约质量

复盘问题：

- 所有端点是否有 schema、错误结构、超时策略和测试。
- 长任务端点是否统一返回 task id 和可查询状态。
- Agent/CLI 是否能稳定处理失败和重试。

统一产出：

- API/MCP 端点目录。
- 合约测试覆盖表。
- 错误码和响应格式规范。

### 13.6 错误处理与可观测性

复盘问题：

- 错误对象是否统一。
- trace 是否贯穿 UI、IPC、主进程、插件、任务、浏览器和数据层。
- 失败包是否覆盖高风险流程。
- 日志是否可搜索、可关联、可控制大小。

统一产出：

- 错误分类规范。
- trace 字段规范。
- 日志字段规范。
- 失败包规范。

### 13.7 测试覆盖

复盘问题：

- 单元测试、合约测试、集成测试、浏览器测试、打包 smoke test 是否分层清楚。
- 高风险路径是否有失败测试，而不只是 happy path。
- CI 是否能稳定执行关键测试。

统一产出：

- 测试矩阵。
- 高风险缺失测试清单。
- CI 分层建议。

### 13.8 依赖与供应链

复盘问题：

- 依赖版本是否锁定。
- 原生依赖和外部二进制是否可验证。
- 打包资源是否受控。
- SBOM、开源边界和供应链脚本是否覆盖实际发布内容。

统一产出：

- 依赖风险清单。
- 原生依赖构建和打包验证表。
- SBOM 和发布产物一致性报告。

### 13.9 发布与升级

复盘问题：

- 应用版本、配置版本、数据库版本、插件版本、runtime 版本是否协调。
- 升级失败是否可恢复。
- 用户数据是否与应用安装目录清晰分离。
- 发布包是否能在干净机器上启动并完成核心流程。

统一产出：

- 升级路径矩阵。
- 回滚策略。
- 发布前检查清单。

## 14. 审计执行模板

每个模块建议使用同一份模板记录结果。

```md
## 模块名称

### 审计范围

### 入口和核心流程

### 关键代码位置

### 状态模型

### 正常路径结论

### 失败路径结论

### 并发和资源管理结论

### 数据一致性结论

### 错误处理和可观测性结论

### 测试覆盖结论

### 发布和升级影响

### 发现的问题

| ID | 级别 | 标题 | 代码位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |

### 需要新增的测试

### 后续任务
```

## 15. 建议排期

**关于工期的现实判断**：原 4 周估算建立在"7 个模块、从零写测试"的假设上，不成立。修正范围后有两点必须考虑：

- 模块四真实面约 30 个 `http-*` / `mcp-*` / `orchestration-*` 实现文件，外加约 20 个测试文件（多个 30–55KB），单这一块的"评估现有套件 + 补缺"就不止一周。
- 模块八（本地能力原语）含原生 FFI 与 ML 推理，需要单独排期，不能挤进既有模块的边角。

因此 4 周更接近"只够模块二 + 模块四两块深挖"。建议按以下分配，由一名审计者执行约需 6 周；若按 4 周硬约束，则需多人并行或缩小本轮范围（见下）。

单人 6 周参考排期：

| 周期 | 内容 | 主要产出 |
| --- | --- | --- |
| 第 1 周 | 审计准备（含测试 baseline 盘点）、本地数据工作台 | 模块图、测试覆盖现状表、数据风险 |
| 第 2 周 | 浏览器自动化工作流 | 浏览器状态机、资源泄漏报告、集成测试 CI 编排缺口 |
| 第 3 周 | 任务系统、插件系统 | 任务状态机、插件生命周期、现有套件充分性评估 |
| 第 4 周 | 本地 HTTP/MCP 端点（含默认鉴权合约事实）、桌面调试与健康系统 | 端点合约表、错误码矩阵、错误/trace 规范 |
| 第 5 周 | 模块八本地能力原语、配置存储启动升级、供应链 | 原生/ML 风险列表、启动阶段图、供应链报告、打包 smoke 缺口 |
| 第 6 周 | 横向复盘、问题分级、修复路线、回归测试计划 | 全量审计报告、修复 backlog、测试矩阵 |

如果由多人并行执行，建议每个纵向模块指定 owner，同时保留一名横向 owner 负责错误模型、测试策略和发布升级一致性。模块四与模块八体量最大，建议各自单独 owner。

## 16. 最终交付物

审计完成后应交付：

- 全量审计报告。
- 八个模块的独立审计记录。
- 九个横向主题复盘记录。
- 测试覆盖 baseline 与缺口 diff（区分"已有套件"与"确认缺失"）。
- P0/P1/P2/P3 问题列表。
- 修复优先级路线图。
- 回归测试矩阵。
- 发布前检查清单。
- 架构图、数据流图、任务状态机、浏览器状态机、插件生命周期图。

## 17. 推荐优先级

第一优先级：

- 本地数据工作台。
- 浏览器自动化工作流。
- 任务系统和后台流程。
- 本地能力原语（ffi / onnx / system-automation 原生与 ML 层风险最高，须尽早纳入）。

第二优先级：

- 插件系统。
- 本地 HTTP/MCP 自动化端点。

第三优先级：

- 桌面调试与运行健康系统。
- 配置、存储、启动和升级系统。

独立的快赢项（可随时插入）：

- 打包产物 smoke test（electron-builder 产物 + asar 内容 + `package.json` 的 `files` 白名单断言）。这是已确认的真缺口，不要把精力花在已有大型测试套件的子系统上。

最后用九个横向主题统一复盘。这样可以先覆盖最容易造成数据损坏、状态污染、任务卡死和原生层崩溃的核心风险，再处理长期维护和发布升级稳定性。
