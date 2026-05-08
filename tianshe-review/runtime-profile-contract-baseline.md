# Runtime/Profile Contract Baseline

生成日期：2026-05-08

本文档是 `runtime-profile-error-governance-plan.md` 阶段 0 的契约清单。后续拆分 Ruyi client、JS plugin profile namespace、ProfileService、SyncLocalApplyService 时，以下入口先保持稳定，内部可以迁移到 controller/helper/service，但外部调用面不应被改名或删除。

配套护栏：`src/core/ai-dev/runtime-profile-contract-baseline.test.ts`

## 1. RuyiFirefoxClient

源码：`src/main/profile/ruyi-firefox-client.ts`

稳定 class 方法：

| 方法 | 契约 |
| --- | --- |
| `static launch(prepared)` | 创建 client、启动 Firefox runtime，失败时负责 close cleanup |
| `isClosed()` | 返回 runtime 是否关闭 |
| `getObservationBrowserId()` | 返回 observation 使用的 browser id |
| `onEvent(listener)` | 注册 runtime event listener，并返回 unsubscribe |
| `dispatch(method, params, timeoutMs)` | 远程浏览器命令统一入口 |
| `close()` | 关闭 runtime、session、BiDi、child process，并清理 waiters/intercepts |

`dispatch()` 当前必须继续覆盖 `RUYI_REMOTE_BROWSER_COMMANDS` 中的命令：

| 能力 | 命令 |
| --- | --- |
| navigation | `goto`、`back`、`forward`、`reload`、`stop`、`getCurrentUrl`、`title` |
| script/capture | `evaluate`、`evaluateWithArgs`、`screenshot`、`pdf.save` |
| cookies/storage | `cookies.getAll`、`cookies.set`、`cookies.clear`、`storage.getItem`、`storage.setItem`、`storage.removeItem`、`storage.clearArea` |
| visibility/window | `show`、`hide`、`windowOpen.setPolicy`、`windowOpen.clearPolicy` |
| dialog | `dialog.wait`、`dialog.handle` |
| tabs | `tabs.list`、`tabs.create`、`tabs.activate`、`tabs.close` |
| emulation | `emulation.identity.set`、`emulation.viewport.set`、`emulation.clear` |
| native input | `native.click`、`native.move`、`native.drag`、`native.type`、`native.keyPress`、`native.scroll` |
| touch input | `touch.tap`、`touch.longPress`、`touch.drag` |
| download | `download.setBehavior`、`download.list`、`download.wait`、`download.cancel` |
| network intercept | `network.intercept.enable`、`network.intercept.disable`、`network.intercept.continue`、`network.intercept.fulfill`、`network.intercept.fail` |

后续拆分要求：

- `RuyiFirefoxClient` 保留 facade，不要求外部调用方切到 controller。
- 新 controller 只能承接内部实现，不能绕过 `dispatch()` 契约。
- 命令新增时要同步 `remote-browser-command-protocol.ts`、contract baseline test 和本文件。

## 2. JS Plugin helpers.profile

源码：`src/core/js-plugin/namespaces/profile.ts`

稳定 helper 方法：

| 方法 | 契约 |
| --- | --- |
| `describeEngineRuntime(engine)` | 返回指定 engine runtime 描述 |
| `listEngineRuntimes()` | 返回所有 engine runtime 描述 |
| `withLease(profileId, options, runner)` | profile live session lease 包装入口 |
| `list(params)` | 查询 profile 列表 |
| `get(id)` | 查询单个 profile |
| `create(params)` | 创建 profile |
| `update(id, params)` | 更新 profile |
| `delete(id)` | 删除 profile，当前走 cascade delete |
| `isAvailable(id)` | 查询 profile 可用状态 |
| `getStats()` | 查询 profile 统计 |
| `listGroups()` | 查询 profile group |
| `launch(profileId, options)` | 启动 profile browser handle |
| `getUsage(profileId)` | 查询 live usage / holder 信息 |
| `launchPopup(profileId, options)` | 启动 popup browser handle |
| `generateFingerprint(options)` | 生成 fingerprint |
| `getPresets()` | 查询 fingerprint presets |
| `getPresetConfig(presetId)` | 查询 preset config |
| `applyPreset(profileId, presetId)` | 将 preset 应用到 profile |
| `randomizeFingerprint(profileId)` | 随机化 fingerprint |
| `regenerateFingerprint(profileId, options)` | 重新生成并应用 fingerprint |
| `validateFingerprint(fingerprint)` | 校验 fingerprint |
| `getDefaultFingerprint(engine)` | 获取默认 fingerprint |

Browser facade 稳定要求：

- 继续屏蔽或迁移私有 browser API，不能把内部控制面直接暴露给 plugin。
- `withAbortSignal()`、popup handle、visibility controls 的外部行为保持兼容。
- 拆分后同步 `docs/plugin-helpers-reference.md`。

## 3. ProfileService

源码：`src/main/duckdb/profile-service.ts`

稳定 facade 方法：

| 方法 | 契约 |
| --- | --- |
| `sweepDeferredPartitionCleanup()` | 扫描并重试 deferred profile partition cleanup |
| `initTable()` | 初始化 profile 表和相关 schema |
| `create(params)` | 创建 profile |
| `get(id)` | 查询单个 profile |
| `getDefault()` | 查询默认 profile |
| `list(params)` | 查询 profile 列表 |
| `update(id, params)` | 更新 profile |
| `delete(id)` | 删除 profile |
| `deleteWithCascade(id)` | cascade 删除 profile 及关联数据 |
| `updateStatus(id, status, error)` | 更新 profile 状态 |
| `incrementUsage(id)` | 增加使用计数 |
| `isAvailable(id)` | 查询可用状态 |
| `resetAllActiveStatus()` | 重置 active 状态 |
| `getStats()` | 查询统计 |

后续拆分要求：

- `ProfileService` 保留 public facade。
- row mapper、fingerprint persistence、partition cleanup、cascade delete 可以迁出。
- DuckDB transaction/statement executor 行为必须由既有 tests 或新增 tests 覆盖。

## 4. SyncLocalApplyService

源码：`src/main/sync/sync-local-apply-service.ts`

稳定入口：

| 方法 | 契约 |
| --- | --- |
| `applyChange(domain, change, options)` | 本地应用 sync pull change 的唯一外部入口 |

稳定返回结构：

| 字段 | 契约 |
| --- | --- |
| `applied` | 是否执行了本地变更 |
| `skipped` | 是否跳过 |
| `localId` | 本地实体 id，可选 |
| `reason` | 跳过或失败原因，可选 |

后续拆分要求：

- `applyChange()` 保持 facade/router 角色。
- mapping resolver、normalizer、各实体 apply service 可以迁出。
- profile-extension binding 的跨实体 local id resolution 必须保留测试覆盖。

## 5. 验收入口

阶段 0 最小验收命令：

```powershell
npm run test:architecture
npm run typecheck
```

涉及实际拆分时继续补跑对应单测：

```powershell
npx vitest run src/main/profile/ruyi-firefox-client.test.ts
npx vitest run src/core/js-plugin/namespaces/profile.test.ts src/core/js-plugin/namespaces/profile.with-lease.test.ts
npx vitest run src/main/duckdb/profile-service.delete-with-cascade.test.ts src/main/duckdb/profile-service.fingerprint-normalization.test.ts src/main/duckdb/profile-service.observation.test.ts
npx vitest run src/main/sync/sync-local-apply-service.test.ts
```
