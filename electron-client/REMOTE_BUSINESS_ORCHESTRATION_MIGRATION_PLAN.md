# 赤狐管家远程业务编排最终改造路线

创建日期：2026-07-07  
最终口径：以更新便利性和功能扩展能力优先，不考虑旧数据迁移，不保留旧业务桥兼容。  
适用范围：`electron-client`、`remote-web/client-shell`、`remote-web/new-remote-web`、`remote-web/scripts`。  
目标架构：远程可见 UI + 远程隐藏任务运行器 + 本地 native capability。

## 1. 最终结论

我们最终采用“纯远程业务编排 + 本地强能力执行层”，但不是把所有长任务直接塞进普通页面组件里跑。

最终形态是：

```text
remote-web 可见 UI
  负责页面展示、交互、筛选、表格、弹窗、结果呈现。

remote-web 隐藏任务运行器
  负责导店、刷新状态、经营/资金/违规拉取、滞销品扫描和执行、进度、取消、快照。

electron-client native capability
  负责 BrowserWindow、preload、partition、Cookie、带登录态 HTTP、执行页面 JS、文件选择/读取、下载、通知、更新、日志。
```

这条路线和小尊宝的核心思路一致：远程页面编排业务，本地提供窗口、Cookie、HTTP、DB/文件等能力桥。  
不同的是，我们当前业务存在更长、更复杂的导店、拉数、滞销品执行任务，所以必须新增“隐藏远程任务运行器”，不能让这些任务依赖可见页面的组件生命周期。

最终目标不是“删除本地能力”，而是“删除本地抖店业务编排”。Electron 以后不再知道：

- 店铺怎么导入。
- 经营/资金/违规接口怎么请求。
- 滞销品怎么判定。
- 字段怎么映射。
- 签名策略怎么组织。
- 任务进度和失败分类怎么表达。

Electron 只保留平台无关的本地能力原语。

## 2. 为什么这样定

### 2.1 小尊宝给我们的参考

小尊宝原版是：

```text
Electron 主窗口加载远程页面
  -> preload 暴露 window.client
  -> 远程 bundle 调本地窗口、Cookie、HTTP、DB、文件、通知、更新
```

它不是纯静态网页，也不是把 Electron 能力迁到远程。它证明了“远程业务 + 本地能力桥”是可行模式。

### 2.2 当前赤狐管家的差异

当前赤狐管家的实际链路是：

```text
remote-web 页面
  -> withDoudianAdapter(...)
  -> window.chihu.stores / window.client.stores*
  -> electron-client/src/main/ipc/stores.js
  -> electron-client/src/main/doudian/service.js
  -> electron-client/src/main/doudian/repository.js
```

这比小尊宝更偏本地服务化。好处是稳定，坏处是抖店规则变化时经常要发 Electron 新版本。

### 2.3 最终取舍

如果只考虑更新便利性和功能能力，我们选择：

```text
remote-web 页面
  -> remote-web/client-shell/src/domain/doudian/*
  -> remote-web 隐藏任务运行器
  -> window.chihuNative.*
  -> electron-client native IPC
```

这能最大化热更新能力：以后抖店接口、字段、页面脚本、签名策略、滞销品规则变化，优先只发 remote-web。

## 3. 当前业务必须覆盖的能力

| 页面 | 当前能力 | 迁移后必须满足 |
|---|---|---|
| 店铺管理 `StoreManagementPage.tsx` | 导店、修复导店、刷新登录态、打开店铺、分组管理、删除店铺、取消任务 | 远程仓库保存店铺/分组；隐藏任务运行器执行导店和刷新；进度、取消、窗口清理正常 |
| 经营数据 `BusinessDataPage.tsx` | 按店铺和日期拉经营数据，latest 快照恢复 | request plan、字段映射、失败分店 details、latest 快照全部在远程 runtime |
| 资金数据 `FundsDataPage.tsx` | 多 source 资金数据、latest、打开平台窗口 | 多 source 部分失败可展示；`openPlatformWindow` 改走 `chihuNative.windows.open` |
| 违规数据 `ViolationsPage.tsx` | 分页、状态/日期筛选、商品 lookup、latest | 分页策略、状态筛选、商品 lookup、latest 快照全部远程实现 |
| 滞销品清理 `SlowMovingCleanupPage.tsx` | 文件导入、扫描候选品、保存快照、二次确认执行、dry-run、下架/删除/回收站、取消 | 文件 raw read 本地提供；Excel/CSV 解析和业务规则远程实现；scan/execute run 可恢复；execute 最后迁 |

当前页面还依赖：

```text
window.addEventListener("chihu-stores-progress", ...)
```

迁移后需要统一替换成远程进度系统，例如：

```text
useDoudianProgress()
chihu-doudian-progress
BroadcastChannel("chihu-doudian-task")
```

## 4. 最终模块结构

### 4.1 Electron 最终保留

```text
electron-client/src/main
  config.js
  index.js
  ipc/
    app-info.js
    cookies.js
    files.js
    http.js
    index.js
    logs.js
    notifications.js
    partitions.js
    updates.js
    windows.js
  utils/
  window/

electron-client/src/preload
  index.js
```

这些属于本地能力，必须保留：

- 主窗口、托盘、单实例、preload。
- BrowserWindow 创建、隐藏、销毁、执行 JS。
- Electron session、partition、Cookie 读写、Cookie 复制。
- 带登录态 HTTP 请求和 Set-Cookie 写回。
- 本地文件选择、读取、下载、保存。
- 通知、更新、日志、崩溃信息。

### 4.2 Electron 最终删除

```text
electron-client/src/main/ipc/stores.js
electron-client/src/main/doudian/
```

包括：

```text
adapter.js
failure-classifier.js
operation-executor.js
platform-request.js
policies.js
repository.js
run-logger.js
service.js
status-refresh.js
store-import.js
xzb-signer.js
```

删除条件：所有业务链迁移并验收完成后才能删。

### 4.3 remote-web 新增结构

```text
remote-web/client-shell/src/native/
  client.ts
  types.ts

remote-web/client-shell/src/domain/doudian/
  adapter.ts
  native.ts
  repository.ts
  operation.ts
  taskClient.ts
  taskRunner.ts
  progress.ts
  requestPlan.ts
  signer.ts
  storeGroups.ts
  storeImport.ts
  storeStatus.ts
  businessData.ts
  fundsData.ts
  violationsData.ts
  staleGoods.ts
  fileImport.ts
  errors.ts
  index.ts
```

继续保留并改造：

```text
remote-web/client-shell/src/bridge/doudianAdapter.ts
remote-web/client-shell/src/bridge/doudianScripts.ts
remote-web/client-shell/src/bridge/client.ts
remote-web/client-shell/src/types.ts
remote-web/client-shell/src/components/*.tsx
remote-web/new-remote-web/config/doudian-adapter.json
```

最终 `bridge/client.ts` 不再调用 `stores*`，而是转调 `domain/doudian/*`。

## 5. 新的本地能力 contract

### 5.1 preload 暴露目标

旧业务桥：

```ts
window.client.storesList
window.client.storesFetch
window.client.storesBusinessData
window.client.storesFundsData
window.client.storesViolationsData
window.client.storesStaleGoodsCleanup
window.chihu.stores.*
```

最终替换为：

```ts
window.chihuNative = {
  app,
  windows,
  cookies,
  http,
  files,
  notifications,
  updates,
  logs,
  partitions
}
```

`window.client` 可短期保留通用小尊宝式能力，但业务方法 `stores*` 和 `window.chihu.stores` 最终删除。

### 5.2 `windows`

```ts
type NativeOpenWindowRequest = {
  url: string;
  title?: string;
  partition?: string;
  width?: number;
  height?: number;
  show?: boolean;
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
};

type NativeEvalWindowRequest = {
  winId: number;
  code: string;
  timeoutMs?: number;
};
```

必须支持：

- 打开可见平台窗口。
- 打开隐藏任务运行器窗口。
- 在平台窗口执行 JS。
- 取消任务时销毁相关窗口。

### 5.3 `http.request`

```ts
type NativeHttpRequest = {
  partition?: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: "json" | "text" | "arrayBuffer" | "base64";
  timeoutMs?: number;
  persistSetCookie?: boolean;
};
```

职责：远程业务构造完整请求，本地用指定 partition 发出，并把 Set-Cookie 写回 Electron session。

### 5.4 `cookies`

```ts
type CookieHeaderRequest = {
  partition: string;
  url?: string;
  domain?: string;
  names?: string[];
};

type CookieHeaderResult = {
  ok: boolean;
  cookieHeader: string;
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
};
```

必须支持：

- `get`
- `set`
- `copy`
- `getHeader`
- `clear`

签名代码不能直接读 Electron `session`，必须通过 `chihuNative.cookies.getHeader` 获取 Cookie 信息。

### 5.5 `files`

文件能力只做本地文件原语，不做抖店业务解析。

```ts
type SelectFileRequest = {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
};

type SelectFileResult = {
  ok: boolean;
  canceled?: boolean;
  fileName?: string;
  filePath?: string;
};

type ReadFileRequest = {
  filePath: string;
  encoding?: "utf8" | "base64";
  maxBytes?: number;
};

type ReadFileResult = {
  ok: boolean;
  fileName: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
};
```

滞销品的 Excel/CSV 解析、商品 ID 字段别名、指标字段映射都放到 remote-web。

### 5.6 `logs` 和 `notifications`

任务运行过程中必须能写本地日志。任务完成、失败、需要重新登录时，可以发系统通知。  
这些不是业务编排，但对长任务排查非常重要。

## 6. 远程隐藏任务运行器

这是最终路线的关键补强项。

### 6.1 为什么必须有

如果导店、拉数、滞销品执行直接跑在可见页面组件里，会出现：

1. 用户刷新页面后任务中断。
2. 远程资源更新导致页面重载时任务丢失。
3. 路由切换或组件卸载后进度断开。
4. 滞销品 execute 这种平台写操作可能出现“平台执行了一半，页面记录丢了”。

所以长任务必须从可见 UI 的生命周期里抽离。

### 6.2 推荐实现

Electron 打开隐藏远程窗口：

```ts
chihuNative.windows.open({
  url: "https://remote.example.com/task-runner.html?taskId=...",
  show: false,
  partition: "persist:chihu-task-runner"
});
```

如果不单独做 `task-runner.html`，也可以用：

```text
https://remote.example.com/?runner=1&taskId=...
```

隐藏任务窗口同样注入 `window.chihuNative`。

### 6.3 通信方式

推荐：

```text
可见 UI
  -> domain/doudian/taskClient.ts
  -> BroadcastChannel("chihu-doudian-task")
  -> 隐藏任务运行器
  -> chihuNative
  -> Electron native IPC
```

也可以在 Electron 侧增加 task event 转发，但第一版优先用同源 `BroadcastChannel`，实现更轻。

### 6.4 任务状态

远程仓库必须保存：

```text
operations
  operationId
  taskType
  status
  createdAt
  updatedAt
  progress
  resultSummary
  error
  adapterVersion
  ruleVersion
```

可见页面刷新后，先从 repository 恢复任务状态，再重新订阅进度。

## 7. 远程仓库策略

### 7.1 使用受控 IndexedDB

最终采用 remote-web IndexedDB：

```text
db name: chihu20_doudian
```

建议 object stores：

```text
stores
groups
business_latest
funds_latest
violations_latest
stale_scan_runs
stale_candidates
stale_execute_runs
operations
runtime_meta
```

### 7.2 审计脚本同步调整

当前 `remote-web/scripts/audit-web-storage-isolation.mjs` 禁止 IndexedDB。  
采用本路线后必须改成：

- 允许 `remote-web/client-shell/src/domain/doudian/repository.ts` 使用固定库名 `chihu20_doudian`。
- 禁止其他散落的 IndexedDB 使用。
- 审计输出应区分“受控业务仓库”和“旧 Web 存储污染”。

### 7.3 origin 固定要求

不做旧数据迁移，不代表以后可以随便换远程域名。IndexedDB 按 origin 隔离。  
正式上线后必须固定 `CHIHU_HOME_URL` 的 origin；如果未来换域名，需要提前做导出/导入或临时 native storage 迁移桥。

## 8. 签名和请求计划迁移

### 8.1 `requestPlan.ts`

替代本地：

```text
requestPlanEndpoint
requestPlanResponseOk
runDoudianRequestPlan
```

职责：

- 从 adapter 读取 endpoint、method、query、body、headers、retry。
- 根据业务上下文渲染变量。
- 调用 `chihuNative.http.request`。
- 处理重试、响应判定、错误结构。
- 记录每店铺 details。

### 8.2 `signer.ts`

替代：

```text
electron-client/src/main/doudian/xzb-signer.js
```

迁移要求：

1. 改成 ESM/TypeScript。
2. 去掉 `require("electron")`。
3. 去掉 `require("node:crypto")`，改用 `crypto.subtle` 或纯 JS hash。
4. 从 `chihuNative.cookies.getHeader` 获取 Cookie header。
5. 签名策略、domain、cookie domain、script key 来自 adapter。
6. 至少用经营/资金/违规/滞销品中的一个真实请求计划验证签名可用。

### 8.3 adapter 角色

`doudian-adapter.json` 从“传给 Electron 的配置”升级为“远程业务运行时配置”：

```text
endpoints
requestPlans
operationPlans
responseMappings
selectors
scripts
policies
sign
messages
```

Electron 不再保留抖店真实域名、endpoint、selector、字段映射。

## 9. 分阶段施工路线

### 阶段 0：文档和目标收口

状态：已完成（2026-07-07）。

目标：全项目只保留本文作为最终改造路线。

动作：

1. [x] 以本文为准，不再保留互相冲突的旧审计结论文档。
2. [x] README、回归清单、迁移图后续引用本文。
3. [x] 把“本地增强保守路线”降级为历史分析，不再作为当前目标。

验收：

```powershell
rg -n "小尊宝兼容本地增强模式|不建议现在走：纯远程业务模式" electron-client remote-web
```

结果不应出现在当前路线文档之外。

### 阶段 1：建立 `chihuNative`

状态：已完成（2026-07-07）。

目标：远程端有平台无关 native API。

要改：

```text
electron-client/src/preload/index.js [x]
electron-client/src/main/ipc/http.js [x]
electron-client/src/main/ipc/files.js [x]
electron-client/src/main/ipc/cookies.js [x]
electron-client/src/main/ipc/windows.js [x]
electron-client/src/main/ipc/index.js [x]
electron-client/scripts/check-contract.js [x]
electron-client/src/main/smoke/install-smoke-check.js [x]
remote-web/client-shell/src/types.ts [x]
remote-web/client-shell/src/native/types.ts [x]
remote-web/client-shell/src/native/client.ts [x]
```

验收：

```powershell
cd D:\code\xiaozuibao\electron-client
npm run check
```

```powershell
cd D:\code\xiaozuibao\remote-web\client-shell
npm run typecheck
```

新增 smoke 断言：

- `window.chihuNative` 存在。
- 能打开隐藏窗口。
- 能在窗口执行 JS。
- 能发本地 mock HTTP 请求。
- 能 mock 选择/读取文件。

### 阶段 2：建立隐藏任务运行器

状态：已完成（2026-07-07）。

目标：长任务不依赖可见页面组件生命周期。

新增：

```text
remote-web/client-shell/src/domain/doudian/taskClient.ts [x]
remote-web/client-shell/src/domain/doudian/taskRunner.ts [x]
remote-web/client-shell/src/domain/doudian/operation.ts [x]
remote-web/client-shell/src/domain/doudian/progress.ts [x]
```

动作：

1. [x] 实现任务创建、取消、状态查询。
2. [x] 用隐藏窗口加载 task runner。
3. [x] 用 BroadcastChannel 转发 progress/result/error。
4. [x] operation 状态写入 IndexedDB。
5. [x] 取消任务时关闭相关平台窗口。

验收：

1. [x] 开始 mock 长任务。
2. [x] 切换页面任务不断。
3. [x] 刷新主页面后能恢复任务状态。
4. [x] 取消任务后隐藏窗口关闭。
5. [x] 进度能回到可见页面。

### 阶段 3：远程仓库和审计规则

状态：已完成（2026-07-07）。

目标：remote-web 拥有受控业务仓库。

新增：

```text
remote-web/client-shell/src/domain/doudian/repository.ts [x]
```

修改：

```text
remote-web/scripts/audit-web-storage-isolation.mjs [x]
```

动作：

1. [x] 建 `chihu20_doudian` IndexedDB。
2. [x] 建 stores/groups/latest/stale/operations stores。
3. [x] repository 自检支持写入、读取、删除测试记录。
4. [x] 审计脚本允许固定业务库，禁止散落 IndexedDB。

验收：

```powershell
rg -n "indexedDB|indexeddb" remote-web/client-shell/src
node .\remote-web\scripts\audit-web-storage-isolation.mjs
```

审计应能区分受控 repository 和违规散落用法。

### 阶段 4：迁店铺台账、分组、打开店铺

状态：已完成（2026-07-07）。

目标：先迁不需要大量平台请求的部分。

新增/修改：

```text
remote-web/client-shell/src/domain/doudian/storeGroups.ts [x]
remote-web/client-shell/src/bridge/client.ts [x]
remote-web/client-shell/src/components/StoreManagementPage.tsx [x]
```

迁移能力：

- [x] `listDoudianStores`
- [x] `deleteDoudianStores`
- [x] `createDoudianStoreGroup`
- [x] `renameDoudianStoreGroup`
- [x] `deleteEmptyDoudianStoreGroup`
- [x] `updateGroup`
- [x] `openDoudianStore`

验收：

```powershell
rg -n "storesList|storesDelete|storesUpdateGroup|window\.chihu\?\.stores" remote-web/client-shell/src
```

页面验收：

- [x] 空店铺列表正常。
- [x] 创建/重命名/删除分组正常。
- [x] 删除店铺正常。
- [x] 打开店铺正常。

### 阶段 5：迁导店和状态刷新

状态：已完成（2026-07-07）。

目标：远程任务运行器接管导店、修复导店、刷新登录态。

新增：

```text
remote-web/client-shell/src/domain/doudian/storeImport.ts [x]
remote-web/client-shell/src/domain/doudian/storeStatus.ts [x]
remote-web/client-shell/src/domain/doudian/requestPlan.ts [x]
remote-web/client-shell/src/domain/doudian/signer.ts [x]
```

迁移能力：

- [x] `fetchDoudianStores`
- [x] `refreshDoudianStoreStatus`
- [x] `cancelDoudianStoreOperation`

验收：

```powershell
rg -n "storesFetch|storesRefreshStatus|storesOpen|storesCancel" remote-web/client-shell/src
```

功能验收：

1. [x] 能打开登录窗口。
2. [x] 能导入至少一个店铺。
3. [x] 能刷新店铺在线状态。
4. [x] 能取消导店/刷新任务。
5. [x] 主页面刷新后任务状态可恢复。
6. [x] 任务取消后平台窗口被关闭。

### 阶段 6：迁经营数据

状态：已完成（2026-07-07）。

目标：经营数据完全远程编排。

新增：

```text
remote-web/client-shell/src/domain/doudian/businessData.ts [x]
```

迁移能力：

- [x] `fetchDoudianBusinessData`
- [x] `fetchDoudianBusinessDataLatest`

验收：

```powershell
rg -n "storesBusinessData|storesBusinessDataLatest" remote-web/client-shell/src
```

功能验收：

- [x] 今日/昨日/近 7 天/自定义日期可拉取。
- [x] 部分店铺失败可展示。
- [x] latest 快照可恢复。
- [x] adapterVersion/ruleVersion 写入快照。

### 阶段 7：迁资金数据

状态：已完成（2026-07-07）。

新增：

```text
remote-web/client-shell/src/domain/doudian/fundsData.ts [x]
```

迁移能力：

- [x] `fetchDoudianFundsData`
- [x] `fetchDoudianFundsDataLatest`

验收：

```powershell
rg -n "storesFundsData|storesFundsDataLatest" remote-web/client-shell/src
```

功能验收：

- [x] 资金数据可拉取。
- [x] 多 source 部分失败时有提示和部分数据。
- [x] latest 可恢复。
- [x] `openPlatformWindow` 已改走 `chihuNative.windows.open`。

### 阶段 8：迁违规数据

状态：已完成（2026-07-07）。

新增：

```text
remote-web/client-shell/src/domain/doudian/violationsData.ts [x]
```

迁移能力：

- [x] `fetchDoudianViolationsData`
- [x] `fetchDoudianViolationsDataLatest`

验收：

```powershell
rg -n "storesViolationsData|storesViolationsDataLatest" remote-web/client-shell/src
```

功能验收：

- [x] 按状态/日期拉取正常。
- [x] 分页正常。
- [x] 商品信息 lookup 正常。
- [x] latest 可恢复。

### 阶段 9：迁滞销品扫描

目标：先迁 scan，不迁 execute。

状态：已完成（2026-07-07）。

新增：

```text
remote-web/client-shell/src/domain/doudian/staleGoods.ts [x]
remote-web/client-shell/src/domain/doudian/fileImport.ts [x]
```

动作：

1. [x] `fileImport.ts` 用 `chihuNative.files.selectFile/readFile` 获取文件内容。
2. [x] remote-web 增加 `xlsx`，在远程解析 Excel。
3. [x] 字段别名、规则、评分、风险等级从 adapter policy 读取。
4. [x] scan run 和 candidates 写入 IndexedDB。

验收：

- [x] CSV/TXT/XLSX 可导入。
- [x] 能扫描候选品。
- [x] scan run 可恢复。
- [x] 不再调用本地 `selectAndParseDelimitedFile` 做业务解析。

### 阶段 10：迁滞销品 execute

目标：最后迁平台写操作。

状态：已完成（2026-07-07）。

动作：

1. [x] execute plan 来自 adapter。
2. [x] 删除本地 `STALE_GOODS_EXECUTE_ALLOWLIST` 依赖。
3. [x] execute 必须引用 `sourceRunId`。
4. [x] dry-run 和 execute 返回结构一致。
5. [x] execute run 写入 IndexedDB。

验收：

```powershell
rg -n "storesStaleGoodsCleanup" remote-web/client-shell/src
```

功能验收：

- [x] dry-run 正常。
- [x] 下架/删除/回收站动作正常。
- [x] 二次确认正常。
- [x] 取消任务正常。
- [x] execute run 和 sourceRunId 关联正确。

### 阶段 11：替换进度、取消、页面桥和类型

目标：remote-web 不再依赖旧业务桥。

状态：已完成（2026-07-07）。

删除：

```text
window.chihu?.stores [x]
window.client?.stores* [x]
storesApi() [x]
chihu-stores-progress [x]
Window.client.stores* [x]
Window.chihu.stores [x]
```

替换：

```text
domain/doudian/* [x]
chihuNative [x]
useDoudianProgress() [x]
chihu-doudian-progress [x]
BroadcastChannel("chihu-doudian-task") [x]
```

验收：

```powershell
rg -n "storesApi|window\.chihu\?\.stores|window\.client\?\.stores|chihu-stores-progress|storesList|storesFetch|storesBusinessData|storesFundsData|storesViolationsData|storesStaleGoodsCleanup" remote-web/client-shell/src
```

应无结果。

### 阶段 12：重写 smoke、contract 和审计

目标：检查项反映新架构。

状态：已完成（2026-07-08）。

修改：

```text
electron-client/src/main/smoke/install-smoke-check.js [x]
electron-client/scripts/check-contract.js [x]
remote-web/new-remote-web/bridge.js [x]
remote-web/scripts/audit-doudian-local-leakage.mjs [x]
remote-web/scripts/audit-doudian-remote-update-matrix.mjs [x]
```

新的 smoke 重点：

- [x] `window.chihuNative` 存在。
- [x] native 能力自检通过。
- [x] 隐藏任务运行器可启动、通信、取消。
- [x] remote repository 可写可读。
- [x] doudian runtime 可加载 adapter。

不再要求：

```text
storesListOk [x]
window.client.stores* [x]
window.chihu.stores [x]
```

如果最终不再保留通用本地 DB，也不再要求：

```text
chihuDataMirrorOk [x]
window.client._db [x]
window.client.db [x]
```

### 阶段 13：删除 Electron 本地业务服务

状态：已完成（2026-07-08）。

只有阶段 4 到阶段 12 全部通过后，才删除：

```text
electron-client/src/main/ipc/stores.js [x]
electron-client/src/main/doudian/ [x]
```

同步修改：

```text
electron-client/src/main/ipc/index.js [x]
electron-client/src/preload/index.js [x]
electron-client/scripts/check-contract.js [x]
electron-client/src/main/smoke/install-smoke-check.js [x]
remote-web/client-shell/src/types.ts [x]
remote-web/client-shell/src/bridge/client.ts [x]
remote-web/new-remote-web/bridge.js [x]
```

验收：

```powershell
rg -n "stores:|stores[A-Z]|window\.chihu\.stores|createDoudianStoreService|src/main/doudian|require\\(\"\\.\\./doudian|require\\(\"\\.\\/doudian" electron-client/src
```

```powershell
rg -n "fxg\\.jinritemai|jinritemai|bytedance|GetMstokenSign|businessData|fundsData|violationsData|staleGoods|/product/tproduct" electron-client/src
```

应无结果。抖店业务词允许出现在 remote-web。

### 阶段 14：清理依赖和文档

状态：已完成（2026-07-08）。

Electron 端如果不再使用本地 DB 和本地 Excel 解析，可以移除：

```text
better-sqlite3 [x]
nedb [x]
xlsx [x]
```

确认：smoke、`window.client._db`、`window.client.db`、本地文件解析均已确认不再需要。

文档同步更新：

```text
electron-client/README.md [x]
electron-client/REGRESSION_CHECKLIST.md [x]
electron-client/MIGRATION_MAP.md [x]
docs/window-client-contract.md [x]
docs/bridge-permission-matrix.md [x]
```

## 10. 最终验收门槛

### Gate A：native capability

必须通过：

```text
chihuNative.windows.open/eval/destroy
chihuNative.cookies.get/getHeader/copy
chihuNative.http.request
chihuNative.files.selectFile/readFile/download
chihuNative.logs
```

### Gate B：隐藏任务运行器

必须证明：

1. 任务不依赖可见页面组件生命周期。
2. 可见页面刷新后能重新订阅进度。
3. 取消任务能关闭相关窗口。
4. 任务失败能返回结构化错误。
5. operation 状态可恢复。

### Gate C：远程仓库

必须证明：

1. stores/groups 可持久化。
2. business/funds/violations latest 可恢复。
3. stale scan/execute run 可恢复。
4. adapterVersion/ruleVersion 能写入快照。

### Gate D：业务链

必须逐条完成：

- 店铺管理。
- 导店和状态刷新。
- 经营数据。
- 资金数据。
- 违规数据。
- 滞销品 scan。
- 滞销品 execute。

### Gate E：旧桥完全移除

Remote 侧：

```powershell
rg -n "window\.chihu\?\.stores|window\.client\?\.stores|storesApi|storesList|storesFetch|storesBusinessData|storesFundsData|storesViolationsData|storesStaleGoodsCleanup|chihu-stores-progress" remote-web/client-shell/src
```

Electron 侧：

```powershell
rg -n "stores:|createDoudianStoreService|src/main/doudian|xzb-signer" electron-client/src
```

都应无结果。

### Gate F：构建和审计

```powershell
cd D:\code\xiaozuibao\electron-client
npm run check
npm run smoke
npm run smoke:http
npm run smoke:cookie
npm run smoke:files
npm run smoke:logs
npm run smoke:ui-contract
```

```powershell
cd D:\code\xiaozuibao\remote-web\client-shell
npm run typecheck
npm run build
```

```powershell
cd D:\code\xiaozuibao
node .\remote-web\scripts\audit-web-storage-isolation.mjs
node .\remote-web\scripts\audit-doudian-local-leakage.mjs
node .\remote-web\scripts\audit-doudian-remote-update-matrix.mjs
```

## 11. 禁止提前做的事

这些动作必须等对应阶段完成后再做：

1. 不要在 `chihuNative` 和隐藏任务运行器完成前删除 `stores.js`。
2. 不要在 latest 快照恢复完成前删除本地 `repository.js`。
3. 不要在签名浏览器化验证前删除 `xzb-signer.js`。
4. 不要在滞销品 execute 验收前删除本地滞销品执行逻辑。
5. [x] smoke 重写完成后删除 `better-sqlite3`、`nedb`、`xlsx`。
6. 不要在 `audit-web-storage-isolation.mjs` 放开受控 IndexedDB 前实现散落 IndexedDB。

## 12. 推荐执行顺序

严格按下面顺序：

1. 收口文档和目标。
2. 建 `chihuNative`。
3. 建隐藏任务运行器。
4. 建 remote IndexedDB repository 并更新存储审计。
5. 迁店铺台账、分组、打开店铺。
6. 迁导店和状态刷新。
7. 迁经营数据。
8. 迁资金数据。
9. 迁违规数据。
10. 迁滞销品扫描。
11. 迁滞销品 execute。
12. 替换进度、取消、页面桥和类型。
13. 重写 smoke、contract、审计脚本。
14. 删除 Electron `stores.js` 和 `src/main/doudian/`。
15. 清理依赖和文档。

完成后，赤狐管家的抖店业务更新将主要发生在 remote-web；Electron 只在本地能力本身变化时才需要发新版。
