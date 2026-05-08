# Ruyi/Profile/Sync/Logger 后续治理计划

生成日期：2026-05-08

本文档基于当前工作树的真实代码扫描结果，覆盖以下后续治理方向：

- `RuyiFirefoxClient` 深拆
- JS plugin `helpers.profile` namespace 深拆
- `ProfileService` 深拆
- `SyncLocalApplyService` 深拆
- logger baseline 递减
- 共享错误 envelope 与 IPC 稳定错误码统一

本文档定位为后续执行计划，不是 P0/P1 紧急缺陷清单。核心目标是继续降低大文件和横向语义不统一带来的维护成本，同时避免引入过重框架或破坏现有公开 API。

## 1. 当前证据快照

### 1.1 重点文件规模

| 文件 | 当前行数 | 直接 `console.*` | 架构护栏目标组 | 当前判断 |
| --- | ---: | ---: | --- | --- |
| `src/main/profile/ruyi-firefox-client.ts` | 884 | 0 | 已退出 `main-runtime` 大文件目标 | 已拆出 active context tracker、dialog、emulation、window、storage/cookie、capture、input、tab、navigation、network controllers，client 保留 lifecycle、dispatch 和兼容薄入口 |
| `src/core/js-plugin/namespaces/profile.ts` | 737 | 12 raw docs / 0 guard baseline | 已退出 `js-plugin-runtime` 大文件目标 | 已拆出 browser facade、CRUD/stat/group、fingerprint、launch/lease/popup/visibility；namespace 保留公开 helper facade 和 engine 描述 |
| `src/main/duckdb/profile-service.ts` | 869 | 0 | 已退出 `duckdb-core` 大文件目标 | 已拆出 row mapper、fingerprint persistence、schema bootstrap、partition cleanup；service 保留 CRUD/status/observation/cascade transaction facade |
| `src/main/sync/sync-local-apply-service.ts` | 810 | 0 | 已退出 `main-runtime` 大文件目标 | 已拆出 normalizers、metadata mapping resolver、tag/savedSite/profileGroup apply；service 保留 router、account/profile/extension 高风险跨实体逻辑 |
| `src/core/logger.ts` | 327 | 0 | logger 基础设施 | 已有 `createLogger()`、字段清洗和 redaction，可作为迁移目标 |
| `src/main/ipc-utils.ts` | 34 | 0 | IPC 错误工具 | `createIPCErrorResult()` 返回 `userError/logContext`，尚未带稳定 code |
| `src/main/ipc-handlers/errors.ts` | 59 | 0 | IPC 错误工具 | 已有 `IpcErrorCode` 和 `IpcError`，但 code 集合较小，未和共享 `ErrorCode` 打通 |
| `src/main/ipc-handlers/utils.ts` | 137 | 2 | IPC route wrapper | `IPCResponse` 有可选 `code`，但只有 `IpcError` 路径会返回 code，未知错误仍是字符串 |
| `src/types/error-codes.ts` | 391 | 0 | 共享错误码 | 已有 `ErrorCode`、`StructuredError`、`createStructuredError()`，应复用而不是平行造一套 |

### 1.2 logger 热点

当前生产路径粗略扫描，不含测试和 `__tests__`，仍有 178 个文件、1241 处直接 `console.log/warn/error/info/debug` 调用。前 25 个热点如下：

| 文件 | 调用数 |
| --- | ---: |
| `src/main/index.ts` | 51 |
| `src/main/duckdb/dataset-storage-service.ts` | 45 |
| `src/main/ipc-handlers/system-handler.ts` | 43 |
| `src/main/ipc-handlers/profile-ipc-handler.ts` | 36 |
| `src/core/js-plugin/namespaces/profile.ts` | 12 docs only / 0 guard |
| `src/main/webcontentsview-lifecycle-controller.ts` | 33 |
| `src/main/scheduler/scheduler-service.ts` | 29 |
| `src/main/duckdb/query-template-service.ts` | 28 |
| `src/main/webcontentsview-state-controller.ts` | 27 |
| `src/main/duckdb/utils.ts` | 26 |
| `src/main/bootstrap/main-service-composition.ts` | 26 |
| `src/renderer/src/components/DatasetsPage/index.tsx` | 26 |
| `src/main/duckdb/dataset-metadata-service.ts` | 24 |
| `src/main/webcontentsview-layout-controller.ts` | 23 |
| `src/main/duckdb/service.ts` | 23 |
| `src/main/ipc-handlers/query-template-handler.ts` | 22 |
| `src/main/ipc-handlers/js-plugin-handler.ts` | 21 |
| `src/main/window-manager.ts` | 19 |
| `src/main/webcontentsview-stealth-controller.ts` | 19 |
| `src/main/webcontentsview-manager.ts` | 17 |
| `src/main/duckdb/dataset-export-writer.ts` | 17 |
| `src/main/webcontentsview-plugin-page-controller.ts` | 17 |
| `src/main/duckdb/dataset-import-service.ts` | 16 |
| `src/main/duckdb/dataset-schema-service.ts` | 16 |
| `src/core/ffi/ffi-service.ts` | 15 |

结论：logger 治理不能一次性全仓替换，应该按模块递减 baseline。当前 `DIRECT_CONSOLE_CALL_BASELINE` 已经能阻止新增，这是正确方向。

### 1.3 现有测试入口

| 方向 | 现有测试 |
| --- | --- |
| Ruyi client | `src/main/profile/ruyi-firefox-client.test.ts`、`ruyi-firefox-client-utils.test.ts`、`ruyi-firefox-downloads.test.ts`、`browser-pool-integration-ruyi.*.test.ts`、`chrome-ruyi-shared.test.ts`、`ruyi-runtime-shared.test.ts` |
| JS plugin profile namespace | `src/core/js-plugin/namespaces/profile.test.ts`、`profile.with-lease.test.ts` |
| ProfileService | `profile-service.delete-with-cascade.test.ts`、`profile-service.fingerprint-normalization.test.ts`、`profile-service.observation.test.ts`、`dev-schema-bootstrap.test.ts`、部分 account service 自动 profile 测试 |
| Sync apply | `src/main/sync/sync-local-apply-service.test.ts`、`sync-metadata-service.scope.test.ts`、`sync-contract-validator.boundary.test.ts`、`sync-outbox-service.test.ts` |
| IPC 错误 | `src/main/ipc-utils.test.ts`、IPC handler route tests、dataset route error helper tests |
| 架构护栏 | `npm run test:architecture` |

## 2. 总体治理原则

1. 保持公开入口稳定。`RuyiFirefoxClient`、`helpers.profile`、`ProfileService`、`SyncLocalApplyService.applyChange()`、IPC channel、renderer response shape 先保持兼容。
2. 先拆“能力边界”，再考虑“依赖注入形态”。本轮不需要重做框架，只需要把当前大类变成更薄的 facade。
3. 拆分时优先迁移纯函数、状态少的 helper 和独立控制器，最后迁移持有复杂生命周期的部分。
4. 每个阶段都要同步更新架构护栏登记：行数下降则调整或移除登记，logger 迁移则只下调 baseline。
5. error envelope 复用 `src/types/error-codes.ts` 里的 `ErrorCode` / `StructuredError`，不要新增平行错误码体系。
6. 每次只在一个高风险域内做行为变更。文件移动、logger 迁移、错误码语义变更尽量拆批执行，便于回归定位。

## 3. 阶段 0：契约冻结与测试基线

### 目标

在拆代码前先明确公共契约，防止“拆完文件但行为变了”。这一阶段只补测试和文档，不主动重构业务。

### 执行项

- 为 `RuyiFirefoxClient` 列出当前 public 方法清单，至少覆盖 launch/start/stop、context、tab、navigation、emulation、network、storage/cookie、capture、dialog、input、window policy。
- 为 `helpers.profile` 列出公开 helper surface，和 `docs/plugin-helpers-reference.md` 对齐。
- 为 `ProfileService` 列出被外部服务调用的 public 方法，确认哪些可以迁入子服务但继续由 facade 暴露。
- 为 `SyncLocalApplyService` 固定 `applyChange(domain, change, options)` 的输入输出契约。
- 为 IPC 错误结果确认兼容策略：新增 `code` 和 `errorEnvelope` 可以是 additive change，不能移除现有 `error/userError` 字段。

### 验收

```powershell
npm run typecheck
npm run test:architecture
npx vitest run src/main/profile/ruyi-firefox-client.test.ts src/core/js-plugin/namespaces/profile.test.ts src/core/js-plugin/namespaces/profile.with-lease.test.ts
npx vitest run src/main/duckdb/profile-service.delete-with-cascade.test.ts src/main/duckdb/profile-service.fingerprint-normalization.test.ts src/main/duckdb/profile-service.observation.test.ts
npx vitest run src/main/sync/sync-local-apply-service.test.ts
npx vitest run src/main/ipc-utils.test.ts
```

完成情况：2026-05-08

- 已新增 `tianshe-review/runtime-profile-contract-baseline.md`，记录 Ruyi client、helpers.profile、ProfileService、SyncLocalApplyService 的稳定入口。
- 已新增 `src/core/ai-dev/runtime-profile-contract-baseline.test.ts`，静态锁定关键公开方法和 Ruyi remote command dispatch 覆盖。
- 已将契约基线测试接入 `npm run test:architecture`。

## 4. 阶段 1：Ruyi client 深拆

### 当前问题

`RuyiFirefoxClient` 仍是 2127 行。最大风险不是行数本身，而是同一个类同时管理：

- BiDi 连接、session 和事件路由
- active context tracking 与恢复
- tab 创建、激活、关闭、枚举
- navigation 和 reload
- viewport/emulation/fallback resize
- network intercept 生命周期
- storage/cookie 操作
- screenshot/PDF capture
- dialog wait/handle
- input actions
- window open policy 和 page scripts
- downloads 与 native prompt 相关桥接

这导致构造函数过大，状态依赖难以隔离，后续修 bug 容易牵动全类。

### 建议拆分模块

| 新模块 | 迁移内容 | 风险 |
| --- | --- | --- |
| `ruyi-firefox-client-runtime.ts` | client 共享依赖和内部上下文类型，例如 connection、eventRouter、downloads、prepared launch、event emit port | 低 |
| `ruyi-firefox-context-controller.ts` | active context tracker、`ensureActiveContextId()`、context recovery、active context event script 绑定 | 中 |
| `ruyi-firefox-tab-controller.ts` | list/create/activate/close tab、tab info 映射、popup/new context 处理 | 中 |
| `ruyi-firefox-navigation-controller.ts` | goto、reload、history、current URL/title 读取 | 中 |
| `ruyi-firefox-emulation-controller.ts` | `setEmulationIdentity()`、viewport emulation、resize fallback、clear emulation | 高 |
| `ruyi-firefox-network-controller.ts` | enable/disable intercept、request continue/fulfill/fail、pattern 和 event routing | 高 |
| `ruyi-firefox-storage-cookie-controller.ts` | localStorage/sessionStorage/cookie get/set/clear | 中 |
| `ruyi-firefox-capture-controller.ts` | screenshot、PDF、capture option normalization | 中 |
| `ruyi-firefox-dialog-controller.ts` | wait/handle dialog、native prompt bridge | 中 |
| `ruyi-firefox-window-policy-controller.ts` | window open policy、clear policy、与 page scripts 的协作 | 中 |
| `ruyi-firefox-input-controller.ts` | 已有 `ruyi-firefox-input-actions.ts` 的 thin wrapper 和 perform action orchestration | 低 |

### 推荐顺序

1. 先抽 `client-runtime` 和共享内部类型，减少后续 controller 构造参数的混乱。
2. 抽 input/capture/storage 这类状态少的能力，验证 facade 转发方式。
3. 抽 tab/navigation/context，建立 controller 之间共享 active context 的模式。
4. 抽 emulation/window policy，它们和 viewport、page scripts、fallback 关系更密，放在中后段。
5. 最后抽 network intercept，因为它涉及事件路由、request 生命周期和失败恢复。
6. 收缩 `RuyiFirefoxClient` 构造函数，只保留 lifecycle、controller wiring 和 public facade。

### 验收标准

- `src/main/profile/ruyi-firefox-client.ts` 降到 900 行以下。
- controller 文件原则上低于 600 行，极少数过渡文件不得超过 900 行。
- `RuyiFirefoxClient` 仍是外部唯一稳定入口，现有 import 方不需要大面积修改。
- `ruyi-firefox-client.test.ts` 不应只测 facade forwarding，至少保留关键行为测试。
- 需要补充 controller 级单测，尤其是 emulation、network、context recovery。

### 验收命令

```powershell
npx vitest run src/main/profile/ruyi-firefox-client.test.ts src/main/profile/ruyi-firefox-client-utils.test.ts src/main/profile/ruyi-firefox-downloads.test.ts
npx vitest run src/main/profile/browser-pool-integration-ruyi.smoke.test.ts src/main/profile/browser-pool-integration-ruyi.real-contract.test.ts
npm run typecheck
npm run test:architecture
```

完成情况：2026-05-08

- 已新增 `ruyi-firefox-active-context-tracker.ts`、`ruyi-firefox-dialog-controller.ts`、`ruyi-firefox-emulation-controller.ts`、`ruyi-firefox-window-controller.ts`、`ruyi-firefox-storage-cookie-controller.ts`、`ruyi-firefox-capture-controller.ts`、`ruyi-firefox-input-controller.ts`、`ruyi-firefox-tab-controller.ts`、`ruyi-firefox-navigation-controller.ts`、`ruyi-firefox-network-controller.ts`。
- `src/main/profile/ruyi-firefox-client.ts` 已从 2127 行降到 884 行，低于 900 行护栏。
- 已保持 `RuyiFirefoxClient` facade、`dispatch()` remote command surface、dialog/native/evaluate/network 等现有测试可替换入口。
- 已从 `src/core/ai-dev/architecture-baselines.ts` 的 `main-runtime` size repair target 中移除 `ruyi-firefox-client.ts`。

## 5. 阶段 2：JS plugin ProfileNamespace 深拆

### 当前问题

`src/core/js-plugin/namespaces/profile.ts` 当前 1831 行。它不仅是 namespace，还承担很多 runtime 适配：

- profile CRUD 与 group list
- profile launch、popup launch、dock/visibility 控制
- plugin resource coordinator 和 live session lease
- `BrowserHandle` 包装和私有 API 屏蔽
- `createPluginBrowserFacade()` proxy 逻辑
- fingerprint preset/generate/validate/randomize/regenerate
- profile engine/capability 描述
- 直接 `console.*` 调试和错误输出

其中 `createPluginBrowserFacade()` 的 proxy descriptor 逻辑和 launch/lease 流程最容易继续膨胀。

### 建议拆分模块

| 新模块 | 迁移内容 | 说明 |
| --- | --- | --- |
| `profile-browser-facade.ts` | `createPluginBrowserFacade()`、private API migration 提示、blocked property error | 已完成 |
| `profile-launch-namespace.ts` | `withLease()`、`launch()`、`launchPopup()`、usage、visibility、popup handle wrap、resource wait | 已完成，保持 namespace facade 调用 |
| `profile-crud-namespace.ts` | list/get/create/update/delete、group list、stat 方法、runtime cache 清理 | 已完成，只调用 `ProfileService` / `ProfileGroupService` |
| `profile-fingerprint-namespace.ts` | preset、default config、generate、validate、randomize、regenerate | 已完成，复用 stealth/fingerprint 现有 helper |
| `profile-namespace-engine.ts` | engine support、capability registry、engine descriptors | 暂不单拆，当前只剩 2 个薄 facade 方法，继续留在 `profile.ts` 更轻 |
| `profile-namespace-engine.ts` | engine support、capability registry、engine descriptors | 防止 namespace 继续吸收 runtime capability |
| `profile-namespace-logger.ts` 或局部 `createLogger('JSPluginProfileNamespace')` | 替换直接 `console.*` | 不需要单独服务，可只是模块级 logger |

### docs 同步

因为用户当前打开的是 `docs/plugin-helpers-reference.md`，拆 `helpers.profile` 时必须同步确认文档：

- 文档里的 helper 名称、参数、返回结构不应因内部拆分变化。
- 如果新增稳定错误码，文档应说明 `helpers.profile.*` 失败时的 `code` 语义。
- 不要把内部 migration warning 暴露成新 helper surface。

### 推荐顺序

1. 抽 `profile-namespace-browser-facade.ts`，先移走 proxy 私有 API 屏蔽逻辑。
2. 抽 fingerprint helper。它行为相对纯，测试可独立。
3. 抽 CRUD helper，保持 namespace public methods 不变。
4. 抽 launch/lease/popup。这个阶段风险最高，应单独提交和验证。
5. 迁移 `console.*` 到 logger，并下调 `DIRECT_CONSOLE_CALL_BASELINE` 中该文件的值。

### 验收标准

- `profile.ts` 降到 900 行以下。
- browser facade、fingerprint、launch lease 至少有各自 focused tests。
- `docs/plugin-helpers-reference.md` 与实际 helper surface 一致。
- raw `console.*` 调用显著下降，架构 baseline 只降低不升高。

### 验收命令

```powershell
npx vitest run src/core/js-plugin/namespaces/profile.test.ts src/core/js-plugin/namespaces/profile.with-lease.test.ts
npx eslint src/core/js-plugin/namespaces/profile.ts src/core/js-plugin/namespaces/profile-browser-facade.ts src/core/js-plugin/namespaces/profile-crud-namespace.ts src/core/js-plugin/namespaces/profile-fingerprint-namespace.ts src/core/js-plugin/namespaces/profile-launch-namespace.ts
npm run typecheck
npm run test:architecture
```

完成情况：2026-05-08

- 已新增 `profile-browser-facade.ts`，将插件侧 browser facade / 私有 API 屏蔽逻辑从 `profile.ts` 移出。
- 已新增 `profile-fingerprint-namespace.ts`，承接 generate/preset/apply/randomize/regenerate/validate/default fingerprint 行为；内部日志改为 `createLogger()`。
- 已新增 `profile-crud-namespace.ts`，承接 list/get/create/update/delete/isAvailable/getStats/listGroups，并保留 fingerprint cache 清理与 profile browser 销毁语义。
- 已新增 `profile-launch-namespace.ts`，承接 `withLease()`、`launch()`、`getUsage()`、`launchPopup()`、可见性控制、popup handle 包装和 resource wait 逻辑；直接 `console.*` 迁移为 logger。
- `src/core/js-plugin/namespaces/profile.ts` 已从 1831 行降到 737 行，低于 900 行护栏；`src/core/ai-dev/architecture-baselines.ts` 已移除该文件的大文件目标和 direct console baseline。
- `docs/plugin-helpers-reference.md` 的公开 helper surface 未变化，本阶段没有新增/删除 `helpers.profile.*` API，也没有新增稳定错误码文档项。
- 已验证：`npm run typecheck`、`npm run test:architecture`、`npx vitest run src/core/js-plugin/namespaces/profile.test.ts src/core/js-plugin/namespaces/profile.with-lease.test.ts src/core/ai-dev/runtime-profile-contract-baseline.test.ts`、相关 eslint 均通过。

## 6. 阶段 3：ProfileService 深拆

### 当前问题

`src/main/duckdb/profile-service.ts` 当前 1509 行。它的问题是“数据库 facade + 领域规则 + 文件系统清理 + fingerprint normalization + observation”全部集中：

- schema bootstrap 和 migration 前置逻辑
- profile create/list/update/delete
- fingerprint core config 提取和持久化
- proxy config normalization
- extension package association
- partition cleanup retry 和 deferred cleanup 文件
- cascade delete
- observation service 事件记录
- 直接 `console.*` 15 处

### 建议拆分模块

| 新模块 | 迁移内容 | 说明 |
| --- | --- | --- |
| `profile-schema-bootstrap.ts` | `initTable()`、schema/migration/table bootstrap | 让 `ProfileService` 不再持有表初始化细节 |
| `profile-row-mapper.ts` | DB row 到 `BrowserProfile` 映射、JSON parse、fingerprint parse | 低风险，先拆 |
| `profile-fingerprint-persistence.ts` | fingerprint normalize、extract core config、default/validation bridge | 可直接承接当前最大 helper |
| `profile-partition-cleanup-service.ts` | partition path cleanup、retry、deferred cleanup file | 文件系统副作用独立出去 |
| `profile-cascade-delete-service.ts` | `deleteWithCascade()` 相关依赖删除和事务边界 | 风险较高，单独做 |
| `profile-command-service.ts` | create/update/delete 参数 normalization 和 SQL command | 可在 mapper/fingerprint 拆完后做 |
| `profile-query-service.ts` | list/get/getByName/getDefault 之类读取逻辑 | 视剩余行数决定 |

### 推荐顺序

1. 抽 `profile-row-mapper.ts`，先把无副作用转换逻辑拿走。
2. 抽 `profile-fingerprint-persistence.ts`，降低 `create/update` 的复杂度。
3. 抽 `profile-schema-bootstrap.ts`，把初始化逻辑从主服务移出。
4. 抽 `profile-partition-cleanup-service.ts`，隔离文件系统副作用和 retry。
5. 抽 `profile-cascade-delete-service.ts`，这个阶段必须重点跑 cascade delete tests。
6. 迁移 15 处直接 `console.*` 到 logger，并下调 baseline。

### 验收标准

- `ProfileService` 降到 900 行以下，最好只保留 public facade 和依赖组合。
- 文件系统 cleanup、cascade delete、fingerprint normalization 各自有单独测试。
- `ProfileService` public 方法签名保持兼容。
- DuckDB transaction/statement executor 使用方式不变或有明确测试覆盖。

### 验收命令

```powershell
npx vitest run src/main/duckdb/profile-service.delete-with-cascade.test.ts src/main/duckdb/profile-service.fingerprint-normalization.test.ts src/main/duckdb/profile-service.observation.test.ts
npx vitest run src/main/duckdb/account-service.create-with-auto-profile.test.ts src/main/duckdb/dev-schema-bootstrap.test.ts
npm run typecheck
npm run test:architecture
```

完成情况：2026-05-08

- 已新增 `profile-row-mapper.ts`，承接 DB row -> `BrowserProfile` 映射和 JSON 解析。
- 已新增 `profile-fingerprint-persistence.ts`，承接 system default fingerprint、engine 切换时的 fingerprint materialize、fingerprint validation。
- 已新增 `profile-partition-cleanup-service.ts`，承接 Electron partition 清理、延期清理队列、extension profile 文件清理；日志改为 `createLogger()`。
- 已新增 `profile-schema-bootstrap.ts`，承接 profile/profile_groups 建表、schema migration/backfill、非法 profile 清理、默认 profile 修复。
- `ProfileService` 保留 public CRUD/status/stats、observation span、cascade delete transaction 这类领域 facade；为兼容现有测试和内部替换点，保留了少量 private thin delegates。
- `src/main/duckdb/profile-service.ts` 已从 1509 行降到 869 行，低于 900 行护栏；直接 `console.*` 从 15 降到 0，`src/core/ai-dev/architecture-baselines.ts` 已移除该文件的大文件目标和 direct console baseline。
- 暂不单拆 `profile-cascade-delete-service.ts`：当前 cascade delete 与 observation span、事务回滚测试、partition cleanup 委托耦合较强，且行数目标已经达成；后续如果继续收缩，可单独拆这一块。
- 已验证：`npm run typecheck`、`npm run test:architecture`、`npx vitest run src/main/duckdb/profile-service.delete-with-cascade.test.ts src/main/duckdb/profile-service.fingerprint-normalization.test.ts src/main/duckdb/profile-service.observation.test.ts src/main/duckdb/dev-schema-bootstrap.test.ts src/main/duckdb/account-service.create-with-auto-profile.test.ts`、相关 eslint 均通过。

## 7. 阶段 4：SyncLocalApplyService 深拆

### 当前问题

`src/main/sync/sync-local-apply-service.ts` 当前 1201 行。它没有直接 console，但职责过宽：

- `applyChange()` domain/entity dispatch
- tag、saved site、account、profile、profile group、extension package、profile-extension binding apply
- metadata mapping CRUD wrapper
- any-scope/globalUid/remoteUid local id resolution
- payload normalization
- tombstone/delete 行为
- extension binding 的跨实体依赖解析

这里最容易出问题的是跨 scope mapping 和 profile-extension binding，本轮拆分要尤其保护这些语义。

### 建议拆分模块

| 新模块 | 迁移内容 | 说明 |
| --- | --- | --- |
| `sync-apply-normalizers.ts` | `normalizeScopeKey()`、payload object、optional string/number/boolean、fallback name、profile engine normalize | 纯函数先拆 |
| `sync-apply-mapping-resolver.ts` | metadata get/upsert/delete/list、any scope/global/remote resolution | 统一 mapping 语义 |
| `sync-common-entity-apply-service.ts` | tag、saved site 这种简单实体 apply 模板 | 可减少重复 |
| `sync-account-apply-service.ts` | account apply、profile local id resolution | 依赖 account/profile |
| `sync-profile-apply-service.ts` | profile/profile group apply、cascade delete | 高价值 |
| `sync-extension-apply-service.ts` | extension package、profile extension binding apply | 风险最高，最后拆 |
| `sync-local-apply-router.ts` | 保留 domain/entity dispatch，主类只委托 | 可作为最后收口 |

### 推荐顺序

1. 抽 pure normalizers，并保持测试覆盖全部边界值。
2. 抽 metadata mapping resolver。先只移动 wrapper，不改变行为。
3. 抽 tag/saved site 简单实体 apply，验证子服务依赖注入方式。
4. 抽 account/profile/profile group。
5. 最后抽 extension package 和 profile extension binding。
6. 收缩 `SyncLocalApplyService` 为 router/facade。

### 验收标准

- `sync-local-apply-service.ts` 降到 900 行以下，最终目标低于 600 行。
- mapping resolver 有单独测试，覆盖 same scope、any scope、remote uid fallback。
- profile-extension binding 的 delete/upsert/local id resolution 行为不变。
- `applyChange()` 的返回结构保持兼容。

### 验收命令

```powershell
npx vitest run src/main/sync/sync-local-apply-service.test.ts src/main/sync/sync-metadata-service.scope.test.ts
npx vitest run src/main/sync/sync-contract-validator.boundary.test.ts src/main/sync/sync-outbox-service.test.ts
npm run typecheck
npm run test:architecture
```

完成情况：2026-05-08

- 已新增 `sync-apply-normalizers.ts`，承接 scope normalization、payload/object/string/number/boolean/array 规整、fallback name、profile engine normalization。
- 已新增 `sync-apply-mapping-resolver.ts`，统一 metadata mapping 的 scoped/any-scope/globalUid/remoteUid/listAll/upsert/delete 包装。
- 已新增 `sync-common-entity-apply-service.ts`，承接 tag、savedSite、profileGroup 三类相对简单实体的 create/update/delete apply。
- `SyncLocalApplyService` 保留 `applyChange()` router，以及 account/profile/extensionPackage/profileExtensionBinding 这些跨实体、高风险逻辑；本轮没有改变 `applyChange(domain, change, options)` 的公开契约。
- `src/main/sync/sync-local-apply-service.ts` 已从 1201 行降到 810 行，低于 900 行护栏；`src/core/ai-dev/architecture-baselines.ts` 已移除该文件的大文件目标。
- 暂不继续拆 account/profile/extension binding：这些路径依赖跨 scope mapping、profile/savedSite local id resolution、extension package/binding 联动，适合作为后续高风险小批次。
- 已验证：`npm run typecheck`、`npx vitest run src/main/sync/sync-local-apply-service.test.ts src/main/sync/sync-metadata-service.scope.test.ts src/main/sync/sync-contract-validator.boundary.test.ts src/main/sync/sync-outbox-service.test.ts`、相关 eslint 均通过。

## 8. 阶段 5：logger baseline 递减

### 当前判断

仓内已经有 `src/core/logger.ts` 和 `DIRECT_CONSOLE_CALL_BASELINE`。下一步不是“全仓一键替换”，而是把每次模块拆分顺手变成 logger 迁移机会。

### 迁移策略

1. main/core 生产路径优先，renderer UI 调试输出后置。
2. 每个被治理模块引入局部 logger，例如：

```ts
const logger = createLogger('ProfileService');
```

3. 日志字段统一使用结构化对象，至少包含：

| 字段 | 用途 |
| --- | --- |
| `component` | 组件名，通常由 logger context 表达 |
| `operation` | 当前操作，例如 `profile.update`、`ruyi.network.intercept.enable` |
| `profileId` / `pluginId` / `browserId` | 关键实体 |
| `requestId` / `channel` | IPC 或 runtime 请求追踪 |
| `durationMs` | 长操作耗时 |
| `outcome` | `success` / `failed` / `skipped` |
| `error` | 脱敏后的错误对象或 message |

4. 对启动早期必须写入诊断文件的逻辑，可以保留 file writer，但控制台输出要走 logger。
5. 每完成一个模块迁移，只下调对应文件在 `DIRECT_CONSOLE_CALL_BASELINE` 中的值。
6. 不把 test、docs 示例、开发脚本里的 console 纳入同一批治理。

### 优先批次

| 批次 | 文件 |
| --- | --- |
| Logger A | `src/core/js-plugin/namespaces/profile.ts`、拆出的 `profile-namespace-*` |
| Logger B | `src/main/duckdb/profile-service.ts`、拆出的 `profile-*` service |
| Logger C | `src/main/ipc-handlers/utils.ts`、`src/main/ipc-utils.ts`、高频 IPC handlers |
| Logger D | `src/main/index.ts`、`src/main/bootstrap/main-service-composition.ts` |
| Logger E | dataset storage/schema/import/export service |
| Logger F | webcontentsview controllers、scheduler、window-manager |

### 验收标准

- 架构护栏继续阻止新增直接 console。
- 每批迁移后 baseline 下降，不能通过增加新文件 baseline 来绕过。
- logger 输出不包含未脱敏 token、cookie、password、authorization header、profile secret。

### 验收命令

```powershell
npm run test:architecture
rg -n "\bconsole\.(log|warn|error|info|debug)\s*\(" src/main src/core src/renderer -g "*.ts" -g "*.tsx" -g "!**/*.test.ts" -g "!**/*.test.tsx" -g "!**/__tests__/**"
```

### 完成情况（2026-05-08）

- 已完成 Logger A/B 的延伸小批次：`src/core/js-plugin/namespaces/account.ts`、`src/core/js-plugin/namespaces/saved-site.ts`、`src/main/duckdb/account-service.ts`、`src/main/duckdb/profile-group-service.ts`、`src/main/duckdb/saved-site-service.ts`、`src/main/duckdb/tag-service.ts` 已迁移到 `createLogger()`。
- 已从 `DIRECT_CONSOLE_CALL_BASELINE` 移除上述 6 个文件，baseline 减少 23 处直接 `console.*` 预算；JS account namespace 剩余的 `console.log` 仅存在于 JSDoc 示例，不计入架构护栏。
- 已完成 IPC wrapper 小批次：`src/main/ipc-handlers/utils.ts` 的 2 处 `console.error` 已迁移到 `createLogger('IPCHandler')`，并从 baseline 移除。
- 已完成 profile/browser IPC 小批次：`src/main/ipc-handlers/profile-ipc-handler.ts` 的 36 处直接 `console.*` 已迁移到 `createLogger('ProfileIPCHandler')`，并从 baseline 移除；同时清理了该文件的 shadow lint warning。
- 已完成 dataset route 小批次：`src/main/ipc-handlers/dataset-routes/{route-utils,import-export-routes,metadata-routes,query-preview-routes,record-routes}.ts` 的 13 处直接 `console.*` 已迁移到 `createLogger('DatasetIPCRoutes')`，并从 baseline 移除。
- 已完成 JS plugin route 小批次：`src/main/ipc-handlers/js-plugin-routes/{config-routes,lifecycle-routes,ui-extension-routes,view-routes}.ts` 的 14 处直接 `console.*` 已迁移到 `createLogger('JSPluginIPCRoutes')`，并从 baseline 移除。
- 本批只做日志出口替换和结构化字段补齐，不改变 CRUD、密码加解密、profile/group/tag/saved site 业务错误语义。
- 阶段 5 仍保留为未完成：仓内还有 main bootstrap、dataset、file/system handler 等高频热点，后续继续按模块递减，不做全仓一键替换。

## 9. 阶段 6：共享错误 envelope 与 IPC 稳定错误码

### 当前问题

现在错误语义有三套局部形态：

- `src/types/error-codes.ts`：已有跨 HTTP/MCP/AI-dev 使用的 `ErrorCode`、`StructuredError`。
- `src/main/ipc-handlers/errors.ts`：IPC 局部 `IpcErrorCode` 和 `IpcError`。
- `src/main/ipc-utils.ts` / route wrapper：多数 IPC 返回字符串错误，只有部分路径带 `code`。

这会导致 renderer、plugin runtime、HTTP/MCP 对同一类错误看到不同 code 或根本没有 code。

### 目标模型

不要新造一套和 `StructuredError` 平行的错误模型。建议新增一个轻量 envelope 类型，作为 IPC/renderer 传输层格式，并能从 `StructuredError` 转换：

```ts
export interface AppErrorEnvelope {
  code: string;
  message: string;
  details?: string;
  context?: Record<string, unknown>;
  reasonCode?: string;
  retryable?: boolean;
  traceId?: string;
}
```

建议落点：

- 类型与转换函数优先放在 `src/types/error-codes.ts` 或相邻 `src/types/app-error-envelope.ts`。
- `StructuredError` 是语义源，`AppErrorEnvelope` 是传输裁剪。
- `IpcError` 保留，但其 code 映射到共享 `ErrorCode` 或至少有确定转换表。

### 建议新增工具

| 工具 | 作用 |
| --- | --- |
| `toAppErrorEnvelope(error, fallback)` | unknown error 到 envelope |
| `structuredErrorToEnvelope(error)` | `StructuredError` 到 envelope |
| `ipcErrorToEnvelope(error)` | `IpcError` 到 envelope |
| `inferErrorCodeFromMessage(message)` | 兜底兼容旧错误，复用 HTTP 侧思路 |
| `createIPCErrorResult(error)` 增强 | 返回 `code`、`message`、`userError`、`errorEnvelope`、`logContext` |
| `createErrorResponse(error)` 增强 | `IPCResponse` 必定包含稳定 `code`，并可选包含 `errorEnvelope` |

### 兼容策略

短期内 `IPCResponse` 可以扩展为：

```ts
export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  errorEnvelope?: AppErrorEnvelope;
}
```

同时保留旧字段：

- `error` 继续给 renderer 老代码显示。
- `userError` 继续给使用 `createIPCErrorResult()` 的调用方。
- `code` 变成稳定必选目标，但第一阶段可保持可选，逐步收敛。
- 新 renderer/store 逻辑优先消费 `errorEnvelope.code` 或 `code`。

### 错误码统一优先级

| 优先级 | 范围 | 目标 |
| --- | --- | --- |
| P1 | dataset mutation/import/export/schema route | renderer 需要稳定区分 validation、not found、conflict、operation failed |
| P1 | profile/browser control IPC | 区分 profile not found、browser busy、timeout、permission denied |
| P1 | plugin install/cloud install/helpers.profile launch | 区分 plugin not found、invalid manifest、resource busy、timeout、permission |
| P2 | file/base64/folder/system logs | 区分 invalid input、permission denied、file not found、operation failed |
| P2 | query template/scheduler | 区分 validation、not found、already exists |
| P3 | renderer-only UI errors | 统一显示模型，后置 |

### 验收标准

- `createIPCErrorResult()` 测试覆盖 unknown error、Error、IpcError、StructuredError。
- `createIpcHandler()` 和 `createIpcVoidHandler()` 对未知错误也返回稳定 code。
- HTTP 和 IPC 对 not found、permission denied、timeout、validation、operation failed 的 code 语义一致。
- 高风险 IPC route 的测试不再只断言字符串 error，还断言 code。

### 验收命令

```powershell
npx vitest run src/main/ipc-utils.test.ts src/main/ipc-handlers/errors.test.ts
npx vitest run src/main/ipc-handlers/dataset-handler.test.ts src/main/ipc-handlers/profile-ipc-handler.test.ts
npm run typecheck
npm run test:architecture
```

如果当前没有 `src/main/ipc-handlers/errors.test.ts`，应在阶段 6 新增。

### 完成情况（2026-05-08）

- 已把 IPC 局部 `IpcErrorCode` 对齐为共享 `ErrorCode` 类型，并向 `src/types/error-codes.ts` 补齐 IPC 已公开使用的稳定 code：`INVALID_INPUT`、`ALREADY_EXISTS`、`RESOURCE_BUSY`、`UNKNOWN`。
- 已为 `IpcError` 增加 `toStructuredError()`，并新增 `isStructuredError()` 类型守卫；没有引入新的平行错误模型。
- 已增强 `createIPCErrorResult()`：返回 `code`、`errorDetails: StructuredError`、`userError`、`logContext`；普通 Error、字符串错误、unknown/null 都会稳定落到 `OPERATION_FAILED`。
- 已增强 `createIpcHandler()` / `createIpcVoidHandler()` / `handleIPCError()`：保留旧 `error` 字符串字段，同时附加 `code` 和 `errorDetails`，renderer 旧调用方可继续显示 `error`。
- 已新增 `inferErrorCodeFromMessage()` 兼容层：旧 route 抛出的普通 Error 会按 timeout、permission denied、not found、already exists/conflict、resource busy、invalid input 等常见语义推断稳定 code；无法识别时仍落到 `OPERATION_FAILED`。
- 已增强 dataset route error result：dataset mutation/import/export/schema 路径返回 `code` 的同时附加 `errorDetails: StructuredError`；`get-dataset-info` 和 `validate-column-name` 的 dataset-not-found 手写返回已补稳定 `NOT_FOUND`。
- 已增强 JS plugin route 的手写 not-found 返回：`js-plugin:get`、`js-plugin:get-runtime-status` 现在返回稳定 `PLUGIN_NOT_FOUND` code。
- 已补充 `src/main/ipc-utils.test.ts`、`src/main/ipc-handlers/utils.test.ts` 对普通 Error、IpcError、未知错误、脱敏和稳定 code 的断言。
- 阶段 6 仍保留为未完成：还需要继续把 dataset/profile/plugin/file/system 等高风险 route 的业务错误显式改为稳定 code，而不是仅依赖兜底 `OPERATION_FAILED`。

## 10. 推荐总执行顺序

### 第一批：低风险拆分和契约补强

- Ruyi：抽 runtime shared type、input/capture/storage controller。
- ProfileNamespace：抽 browser facade 和 fingerprint helper。
- ProfileService：抽 row mapper 和 fingerprint persistence。
- Sync apply：抽 normalizers。
- 错误：新增 envelope 类型和转换工具，但暂不批量改 route。
- logger：只迁移被拆出的新模块，不碰全仓热点。

### 第二批：中风险 facade 收缩

- Ruyi：抽 tab/navigation/context controller。
- ProfileNamespace：抽 CRUD 和 popup/visibility。
- ProfileService：抽 schema bootstrap 和 partition cleanup。
- Sync apply：抽 mapping resolver 和简单实体 apply。
- 错误：增强 `createIPCErrorResult()` 和 `createIpcHandler()`。
- logger：下调 profile namespace 与 profile service baseline。

### 第三批：高风险生命周期和跨实体逻辑

- Ruyi：抽 emulation/window policy/network intercept。
- ProfileNamespace：抽 launch/lease/resource wait。
- ProfileService：抽 cascade delete。
- Sync apply：抽 account/profile/extension binding apply。
- 错误：高风险 IPC route 稳定错误码。
- logger：处理 IPC handler、main bootstrap、dataset service 热点。

## 11. 不建议现在做的事

- 不建议一次性把所有大文件全部拆完。Ruyi、ProfileNamespace、ProfileService、Sync apply 任意一个都足够形成独立回归面。
- 不建议引入全新的大型 DI/错误框架。已有 `ServiceContainer`、`StructuredError`、`createLogger()` 可以继续演进。
- 不建议为每个小函数都创建类。优先使用纯函数模块和窄 controller，只有持有状态或依赖的能力才需要 class。
- 不建议在 logger 迁移时改变错误处理行为。日志结构化和错误 envelope 应分批做。
- 不建议移除旧 IPC `error` 字段。稳定 code 应以 additive 方式加入，等 renderer 全部消费新字段后再考虑清理。

## 12. 后续任务列表

- [x] 阶段 0：补契约清单和测试基线。
- [x] 阶段 1：Ruyi client 深拆到 900 行以下。
- [x] 阶段 2：JS plugin ProfileNamespace 深拆到 900 行以下，并同步确认 `docs/plugin-helpers-reference.md`。
- [x] 阶段 3：ProfileService 深拆到 900 行以下。
- [x] 阶段 4：SyncLocalApplyService 深拆到 900 行以下。
- [ ] 阶段 5：按模块递减 logger baseline。（已完成 account/saved-site namespace、DuckDB account/profile-group/saved-site/tag、IPC wrapper、profile/browser IPC、dataset route、JS plugin route 小批次）
- [ ] 阶段 6：建立共享 error envelope，统一 IPC 稳定错误码。（已完成 IPC 工具层基础设施、旧错误消息兼容推断、dataset route 基础 errorDetails、JS plugin route not-found code，route 业务 code 待继续收敛）

## 13. 每轮完成后必须更新

- `src/core/ai-dev/architecture-baselines.ts`
- `tianshe-review/runtime-profile-error-governance-plan.md`
- 涉及 plugin helper surface 时同步 `docs/plugin-helpers-reference.md`
- 涉及 README 命令或开发流程时同步 `README.md` / `README.zh-CN.md`

## 14. 最小回归命令集合

```powershell
npm run typecheck
npm run test:architecture
npx vitest run src/main/profile/ruyi-firefox-client.test.ts
npx vitest run src/core/js-plugin/namespaces/profile.test.ts src/core/js-plugin/namespaces/profile.with-lease.test.ts
npx vitest run src/main/duckdb/profile-service.delete-with-cascade.test.ts src/main/duckdb/profile-service.fingerprint-normalization.test.ts src/main/duckdb/profile-service.observation.test.ts
npx vitest run src/main/sync/sync-local-apply-service.test.ts
npx vitest run src/main/ipc-utils.test.ts
```

阶段性修改完成后再补跑对应 `eslint` 和相关集成测试。
