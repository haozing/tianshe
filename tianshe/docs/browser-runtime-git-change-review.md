# Browser Runtime Git 变更审查报告

审查日期：2026-05-13  
审查范围：当前工作区未提交的 git 变更，重点覆盖 browser runtime 重构、四类运行时接入、Profile/IPC/UI/HTTP/MCP/测试配套。当前 `git diff --shortstat` 显示 145 个已跟踪文件变更，另有一批未跟踪新增文件（例如 `src/core/browser-runtime/`、Cloak 适配器、运行时 IPC/UI 等），所以本文按功能模块逐项审查，而不是只看 tracked diff。

## 总体结论

这次重构方向是对的：从 `engine` 迁移到更明确的 `runtime`，把 Electron、Chromium extension relay、Firefox Ruyi、CloakBrowser 归入统一运行时模型，后续替换浏览器二进制、做能力发现、做 per-profile/source override 都更自然。

但当前代码还不建议直接合并到稳定分支。核心问题集中在 Cloak 适配器的真实启动行为和能力描述一致性：UI/Provider 层认为自定义路径、下载目录、能力支持已经生效，但 Cloak wrapper 和实际 session 对象并不完全按这个语义工作。这类问题在类型检查里不容易暴露，需要优先补真实契约测试。

此前已执行并通过的验证包括：`npm run typecheck`、`npm run test:architecture`、`npm run test:open`、`npm run test:browser-pool`，以及运行时/IPC/UI/cross-runtime 的定向测试。它们能说明大面积类型和旧测试面没有明显破裂，但还不能覆盖下面列出的运行时行为偏差。

## 必修问题

| ID | 级别 | 文件 | 问题 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| R1 | P0 | `src/main/profile/browser-pool-integration-cloak.ts:295` | Cloak 自定义二进制路径被探测为可用，但启动时没有真正使用 | 用户在设置里选择 Cloak 路径后，状态可能显示正常，实际仍使用 Cloak 默认缓存二进制 | 把路径传入 `launchOptions.executablePath`，并加一条 mock/real contract 测试 |
| R2 | P0 | `src/main/profile/browser-runtime-providers.ts:28`、`src/main/profile/browser-pool-integration-cloak.ts:1279` | Cloak Provider 展示的能力和 live browser descriptor 不一致 | MCP/插件按 `hasCapability()` 判断时可能得到和设置页相反的结果 | 统一 Cloak descriptor 生成入口，Provider 和 live browser 使用同一个函数 |
| R3 | P1 | `src/main/profile/browser-pool-integration-cloak.ts:326` | Cloak 下载目录配置不一定生效 | `setDownloadBehavior()` 只创建目录，下载文件仍可能留在 Playwright 默认临时路径 | 用 Playwright `Download.saveAs()` 落盘，或确认 persistent context 支持的正确选项位置 |
| R4 | P1 | `src/main/profile/browser-pool-integration-cloak.ts:961` | 关闭请求拦截时直接清空 route，没有释放已暂停请求 | 页面请求可能挂起，关闭/禁用拦截后仍有未 resolve 的 Playwright route | disable/clear/close 时遍历 route，统一 continue 或 abort 后再清理 |
| R5 | P1 | `src/main/profile/browser-pool-integration-cloak.ts:794` | `waitForDialog()` 不返回已经打开的 dialog | dialog 先出现、调用后等待，会误超时 | 先检查 `currentDialog`，存在则立即返回 state |
| R6 | P1 | `src/main/profile/browser-pool-integration-cloak.ts:855` | `waitForResponse()` 对未来 response 没有注册监听 | 除非 response 已经捕获，否则必然超时 | 改用 `page.waitForResponse()` 或维护 response waiters |
| R7 | P2 | `src/core/browser-runtime/runtime-manager.ts:229` | `installed` 和 `healthy` 被合并成同一个值 | UI 无法区分“已安装但坏了”和“根本没安装” | Probe 结果增加 installed/sourceExists，状态展示拆开 |
| R8 | P2 | `src/main/ipc-handlers/browser-runtime-ipc-handler.ts:121` | 设置自定义路径时先持久化，再返回 probe 状态 | 错路径会立刻污染全局配置，后续启动失败 | 先临时 probe，再决定是否持久化；或持久化但 UI 明确显示需恢复默认 |

## 关键证据

### R1：Cloak 自定义路径没有真正参与启动

当前代码在 `buildCloakLaunchOptions()` 里把自定义路径放在顶层：

```ts
// src/main/profile/browser-pool-integration-cloak.ts:312
...(runtime.executablePath ? { executablePath: runtime.executablePath } : {}),
```

但实际依赖的 `cloakbrowser` 包在 `launchPersistentContext()` 中只读取环境变量或 `ensureBinary()`，然后把 `options.launchOptions` 展开到 Playwright：

```js
// node_modules/cloakbrowser/dist/playwright.js:161
const binaryPath = process.env.CLOAKBROWSER_BINARY_PATH || (await ensureBinary());

// node_modules/cloakbrowser/dist/playwright.js:171
const context = await chromium.launchPersistentContext(options.userDataDir, {
  executablePath: binaryPath,
  ...
  ...options.launchOptions,
});
```

因此顶层 `executablePath` 会被 wrapper 忽略。正确做法应是：

```ts
launchOptions: {
  ...(runtime.executablePath ? { executablePath: runtime.executablePath } : {}),
  ...
}
```

因为 wrapper 的 `...options.launchOptions` 位于后面，理论上可以覆盖默认 `executablePath`。如果未来 Cloak 包收紧类型或禁止覆盖，则需要改成启动前临时设置 `CLOAKBROWSER_BINARY_PATH`，但这要注意并发 session 的环境变量污染风险。

### R2：Cloak 能力描述不一致

Provider 层对 Cloak descriptor 做了能力增强：

```ts
// src/main/profile/browser-runtime-providers.ts:28
applyRuntimeCapabilitySupport(...)
```

但真正创建浏览器时使用的是另一个静态 descriptor：

```ts
// src/main/profile/browser-pool-integration-cloak.ts:1279
const browser = new CloakPlaywrightBrowser(..., getCloakRuntimeDescriptor());

// src/main/profile/browser-pool-integration-cloak.ts:1299
return getStaticRuntimeDescriptor(CLOAK_RUNTIME_ID);
```

这会造成设置页/运行时状态说“支持”，真实 `browser.describeRuntime()` 或 `browser.hasCapability()` 却说“不支持”。建议把 Cloak 的 descriptor 增强逻辑放进 `getCloakRuntimeDescriptor()`，Provider 也复用它，避免出现两套真相。

### R3：下载目录语义未完整落地

Cloak 启动参数里设置了：

```ts
// src/main/profile/browser-pool-integration-cloak.ts:326
downloadsPath: downloadDir,
```

但 `cloakbrowser` 的 persistent context wrapper 不是简单透传所有顶层字段；同时 Playwright persistent context 的下载路径语义和普通 `launch()` 不完全一样。当前 `setDownloadBehavior()` 主要是记录路径并创建目录，没有看到 `Download.saveAs()` 这类最终落盘逻辑。结果是 API 看起来支持下载目录，实际文件可能仍在 Playwright 默认临时目录。

### R4：请求拦截清理会丢弃暂停的 route

Cloak 拦截命中后会把 route 存到 `interceptedRequests`，这是正确的暂停语义。但 disable/clear 直接清空 map：

```ts
// src/main/profile/browser-pool-integration-cloak.ts:961
async disableRequestInterception(): Promise<void> {
  await this.page.route('**/*', this.routeHandler).catch(() => undefined);
  this.routeHandler = null;
  this.requestInterception = null;
  this.interceptedRequests.clear();
}

// src/main/profile/browser-pool-integration-cloak.ts:979
clearInterceptedRequests(): void {
  this.interceptedRequests.clear();
}
```

Playwright 的 route 没有 continue/abort 就消失引用，底层请求仍可能悬挂。建议封装 `releaseInterceptedRequests(mode)`，在 disable/clear/close 时统一释放。

### R5：dialog 等待没有处理已存在状态

`currentDialog` 在事件里维护：

```ts
// src/main/profile/browser-pool-integration-cloak.ts:1070
this.currentDialog = { dialog, state };
```

但 `waitForDialog()` 只等待未来 resolver，没有像 Firefox/Ruyi 那样先检查当前 dialog。因此 dialog 如果已经弹出，再调用 wait，会超时。Ruyi 侧 `src/main/profile/ruyi-firefox-dialog-controller.ts:70` 的处理方式可以直接参考。

### R6：waitForResponse 只有历史检查，没有未来等待

`waitForResponse()` 当前先查已有 network entry，然后设置一个纯 timeout promise，没有把未来 response 和 resolver 连接起来。插件或 MCP 调用 `browser.waitForResponse('/api/ping')` 时，只要 response 还没发生，就会等到超时。这个问题风险较高，因为 extension/ruyi 的真实契约测试已经覆盖了类似场景，Cloak 作为新 runtime 也应该补同等 contract。

## 模块逐项审查

### 1. 类型与运行时模型

涉及文件：

- `src/types/browser-runtime.ts`
- `src/types/profile.ts`
- `src/types/http-api.ts`
- `src/core/browser-runtime/*`
- `src/core/browser-pool/runtime-capability-registry.ts`
- `src/core/browser-pool/browser-runtime-create-policy.ts`

判断：架构方向合理。`BrowserRuntimeId`、`BrowserRuntimeSource`、`BrowserRuntimeDescriptor`、capability descriptor 这些抽象能覆盖四类 runtime，也比原来的 `automation-engine` 更贴近真实语义。

风险：`BrowserRuntimeManager` 当前把 `installed` 和 `healthy` 都等同于 `probe.healthy`，会丢掉“已安装但探测失败”的状态。这个不是立即崩溃问题，但会影响设置页排障体验。

建议：Probe 结果扩展为 `{ installed, healthy, reason }`，或者 provider 返回 source path exists 信息，UI 按“未安装 / 已安装但不可用 / 可用”三态展示。

### 2. Profile 数据库与迁移

涉及文件：

- `src/main/duckdb/profile-schema-bootstrap.ts`
- `src/main/duckdb/schema-migrations.ts`
- `src/main/duckdb/profile-row-mapper.ts`
- `src/main/duckdb/profile-service.ts`
- `src/main/duckdb/profile-fingerprint-persistence.ts`
- `src/main/profile/presets/index.ts`

判断：开发阶段不考虑老数据兼容的前提下，新增 `runtimeId`、`runtimeSourceOverride` 的方向是干净的。row mapper 和 service create/update 都已经接上 `runtime_source_override`。

风险：表单 UI 目前只暴露 `runtimeId`，没有暴露 per-profile 的 `runtimeSourceOverride`。如果产品设计是“全局运行时设置 + profile 只选 runtime”，这没问题；如果希望某个 profile 指定某个本机浏览器路径，则 UI 还缺入口。

建议：先明确语义。我的建议是：Settings 管全局默认 source，Profile 只选 runtime；高级场景再在 Profile 里加“覆盖运行时来源”，避免普通用户被路径配置打扰。

### 3. Runtime Provider、Store、IPC、Preload

涉及文件：

- `src/main/profile/browser-runtime-providers.ts`
- `src/main/profile/browser-runtime-store.ts`
- `src/main/ipc-handlers/browser-runtime-ipc-handler.ts`
- `src/preload/api/browser-runtime.ts`
- `src/preload/electron-api.contract.ts`
- `src/preload/index.ts`

判断：主进程注册 provider、preload 暴露 API、渲染端通过 `window.electronAPI.browserRuntime` 调用，这条链路基本完整。中文文案文件本身是 UTF-8，之前终端里看到的乱码是 PowerShell 输出编码问题，不是源码问题。

风险：`set-custom-path` 持久化发生在 probe 之前。错路径会写入 store，之后用户启动该 runtime 会失败。Store 还持久化 probe snapshots，但 manager 每次仍 live probe，没有利用缓存，这更多是性能/体验问题。

建议：自定义路径先 probe 再存；列表页可以先展示 cached status，再异步刷新 live status。

### 4. 设置页 UI

涉及文件：

- `src/renderer/src/components/SettingsPage/BrowserRuntimePanel.tsx`
- `src/renderer/src/components/SettingsPage/index.tsx`
- `src/renderer/src/components/SettingsPage/__tests__/BrowserRuntimePanel.test.tsx`
- `src/renderer/src/test/setup.ts`

判断：设置页把 runtime 管理单独抽成面板是合适的；选择路径、恢复默认、安装托管 runtime、打开下载页的操作都在同一个位置，符合“默认打包 Electron/Chrome，Firefox/Cloak 需要时下载”的产品思路。

风险：UI 的状态可信度依赖 Provider probe。由于 R1/R2，Cloak 的“路径已设置”和“能力支持”可能误导用户。修完 Provider 和 live descriptor 后，UI 本身问题不大。

建议：状态文案区分“已设置路径但启动未验证”和“已启动验证通过”。如果后面要做真实 smoke test，可以在 UI 增加“测试启动”按钮，但不必作为第一阶段必需项。

### 5. Browser Pool 与 session 解析

涉及文件：

- `src/core/browser-pool/acquire-session-resolver.ts`
- `src/core/browser-pool/browser-creation-strategy.ts`
- `src/core/browser-pool/global-pool.ts`
- `src/core/browser-pool/pool-manager.ts`
- `src/core/browser-pool/types.ts`
- `src/main/profile/browser-pool-integration.ts`

判断：从 profile 解析 runtime，再交给 browser creation strategy 的路径是正确的。`runtimeSourceOverride` 已在 `acquire-session-resolver.ts:21` 进入 session config，后续 extension/firefox/cloak 都能读取。

风险：新增 runtime 后，pool 复用策略必须确保 runtime/source/userDataDir 参与隔离。已有测试有覆盖 pool manager，但建议为 `runtimeSourceOverride` 加一个明确的“不复用不同 source session”的测试，避免以后优化 pool key 时误伤。

### 6. Extension Runtime

涉及文件：

- `src/main/profile/browser-pool-integration-extension.ts`
- `src/main/profile/chrome-runtime-shared.ts`
- `src/core/browser-extension/extension-browser.ts`
- extension 相关 smoke/real/canary 测试

判断：extension 分类的抽象是成立的。当前实现默认使用打包的 `chromium-extension-relay/chrome/chrome.exe`，同时已经支持 `session.runtimeSourceOverride?.type === 'custom-path'` 时改用用户本机 Chrome/Edge/Brave/Chromium 派生浏览器路径（见 `browser-pool-integration-extension.ts:189`）。

注意：这并不等于“所有能装插件的浏览器都 100% 支持”。它要求浏览器兼容 Chrome extension API、启动参数、远程调试/用户数据目录语义，以及我们的 relay 扩展加载方式。Chrome/Edge/Brave/多数 Chromium 派生浏览器概率较高；Firefox 不属于这个分类。

建议：Provider descriptor 可命名为 `chromium-extension-relay`，UI 展示可写“Chrome/Edge/Brave/Chromium 兼容”，避免用户误以为 Firefox/Safari 也可走 extension relay。

### 7. Firefox/Ruyi Runtime

涉及文件：

- `src/main/profile/browser-pool-integration-ruyi.ts`
- `src/main/profile/ruyi-runtime-shared.ts`
- `src/main/profile/ruyi-firefox-*`
- `src/core/browser-ruyi/ruyi-browser.ts`

判断：Firefox 侧自定义路径已接入，`prepareRuyiFirefoxLaunch()` 在 `session.runtimeSourceOverride?.type === 'custom-path'` 时会使用覆盖路径（`ruyi-runtime-shared.ts:335`）。Ruyi 的 dialog controller 已有“已有 dialog 立即返回”的正确模式，可作为 Cloak 修复参考。

风险：Firefox/Ruyi 是特有协议通道，和 extension relay 的能力重叠有限；保留它有意义，尤其是需要 Firefox 指纹/协议能力时。主要维护成本在协议稳定性和真实浏览器测试。

### 8. Cloak Runtime

涉及文件：

- `src/main/profile/browser-pool-integration-cloak.ts`
- `src/main/profile/browser-runtime-providers.ts`
- `package.json`
- `package-lock.json`

判断：作为第四类 runtime，Cloak 使用 Playwright persistent context 的路线是合理的，和 Electron/extension/firefox 都不是完全重叠能力。它更像“托管的反指纹 Chromium + Playwright 控制面”。

主要问题：Cloak 当前是风险最高模块，原因是文件很大且新代码集中，多个行为是“接口看起来实现了，但底层没有完整接上”：自定义 executable、下载目录、dialog 已存在状态、request route 释放、waitForResponse 未来等待、能力描述一致性。

建议：先修 R1/R2/R4/R5/R6，再考虑拆文件。拆分方向可以是：

- `cloak-runtime-resolver.ts`：探测、安装、source 解析
- `cloak-launch-options.ts`：启动参数和路径构造
- `cloak-network-controller.ts`：capture/interception/waitForResponse
- `cloak-dialog-controller.ts`：dialog wait/handle
- `cloak-download-controller.ts`：download behavior/finalize
- `browser-pool-integration-cloak.ts`：只保留 session 创建和对象组装

### 9. HTTP/MCP/AI Dev 能力面

涉及文件：

- `src/main/mcp-http-runtime-availability.ts`
- `src/main/mcp-http-session-runtime.ts`
- `src/main/mcp-http-session-snapshot.ts`
- `src/main/mcp-http-types.ts`
- `src/main/http-runtime-diagnostics.ts`
- `src/core/ai-dev/capabilities/*`
- `src/core/ai-dev/orchestration/*`

判断：把 runtime 信息暴露到 MCP/HTTP/capability catalog 是必要的，否则四引擎体系只停留在本地 UI，外部调用无法做能力判断。测试文件同步改名为 cross-runtime，也符合新模型。

风险：MCP/HTTP 这层会放大 R2 的影响。如果 live browser descriptor 和 runtime availability descriptor 不一致，外部 agent 可能选择了错误能力路径。

建议：增加一个端到端 contract：从 runtime provider status、HTTP availability、实际 browser.describeRuntime() 三者读取同一 runtime，关键 capability 必须一致。

### 10. 测试与架构护栏

涉及文件：

- `src/core/ai-dev/architecture-maintenance-guard.test.ts`
- `src/core/ai-dev/architecture-baselines.ts`
- `src/core/browser-automation/browser-runtime.cross-runtime-contract.test.ts`
- `src/core/browser-pool/browser-runtime-create-policy.test.ts`
- `src/types/browser-runtime.test.ts`

判断：测试命名从 engine 改 runtime、架构基线补 Cloak 大文件例外，都是当前阶段可以接受的。已有类型和架构测试通过，说明迁移面没有大面积遗漏。

风险：`browser-pool-integration-cloak.ts` 1300 行左右，已经超过长期维护舒适区。现在通过架构 guard 放行是务实的，但不能长期留成大单体。

建议：把 Cloak 行数例外标记成临时债务，并在修完行为 bug 后拆分；拆分时不要同时改外部接口，避免行为修复和结构重排互相遮挡。

## 确认无问题或方向正确的点

- 坐标归一化没有问题：项目坐标契约是 0-100，Cloak 中除以 100 再映射 viewport 的方向正确。
- Extension runtime 支持自定义 Chromium 系浏览器路径，这和“默认打包 chrome.exe，同时允许替换本机浏览器”的设想一致。
- Firefox/Ruyi 不建议并入 extension 分类，它是独立协议运行时，和 Chromium extension relay 不是同一类控制面。
- Electron 原生仍适合作为默认内嵌 runtime；Cloak 更适合按需下载/安装，不建议直接替换 Electron，除非产品目标明确转向反指纹/Playwright-first。
- 当前不考虑旧数据兼容时，删除 `automation-engine` 并迁移到 `browser-runtime` 是可以接受的，减少了两套概念并存。

## 建议修复顺序

1. 修 R1：Cloak custom executable 真正传入 `launchOptions.executablePath`，补测试断言 launch 参数。
2. 修 R2：统一 Cloak capability descriptor，补 provider/live browser descriptor 一致性测试。
3. 修 R6/R5：补齐 `waitForResponse()` 和 `waitForDialog()` 的基本契约，优先保障插件/MCP 常用等待能力。
4. 修 R4/R3：释放拦截 route，补下载目录落盘语义。
5. 修 R7/R8：优化 runtime status 三态和自定义路径持久化流程。
6. 拆分 Cloak 大文件，把架构 guard 中的临时例外收窄或移除。

## 建议新增测试

- `browser-pool-integration-cloak.test.ts`：mock `cloakbrowser.launchPersistentContext()`，断言 custom path 落到 `launchOptions.executablePath`。
- `browser-runtime-providers.test.ts`：Cloak provider descriptor 与 `getCloakRuntimeDescriptor()` 的关键 capability 一致。
- `browser-pool-integration-cloak.real-contract.test.ts`：覆盖 `waitForResponse('/api/ping')`、dialog 先出现再 wait、拦截 disable 后请求不挂起。
- `browser-runtime-ipc-handler.test.ts`：错误 custom path 不应静默污染 store，或至少返回明确 unhealthy 状态。
- `pool-manager.runtime-source.test.ts`：不同 `runtimeSourceOverride` 的 profile/session 不复用同一个 browser instance。

## 合并建议

不建议现在直接合并。建议先把 P0 修完并补最小契约测试；P1 至少修 `waitForResponse()` 和 dialog，因为它们会直接影响插件和 MCP 自动化流程。P2 可以排到下一轮，但需要在 issue 或计划文档里保留，不然设置页状态会在后期变成排障成本。

## 修复记录（2026-05-13）

本轮已按上面的 R1-R8 做了修复，并额外修复了真实 extension smoke 暴露出的 dialog/click/network 竞态。

已修复项：

- R1：Cloak 自定义 executable 改为写入 `launchOptions.executablePath`，避免被 `cloakbrowser` wrapper 忽略。
- R2：Cloak provider 和 live browser 共用 `getCloakRuntimeDescriptor()`，能力描述保持一致。
- R3：Cloak 下载完成时使用 `Download.saveAs()` 落到配置目录，并补文件名清理。
- R4：Cloak request interception 在 disable/clear/close 时释放 pending route，避免请求悬挂。
- R5：Cloak `waitForDialog()` 先返回已经打开的 dialog。
- R6：Cloak `waitForResponse()` 支持等待未来 response，不再只查历史缓存。
- R7：runtime status 拆开 `installed` 与 `healthy`，provider 可显式返回 installed 状态。
- R8：设置自定义路径时先 probe 临时 source，只有 installed 且 healthy 才持久化。
- Extension 补强：`waitForResponse()` 轮询 relay 侧 `network.snapshot`，避免事件丢失导致等待超时。
- Extension 补强：普通 click 对非 dialog 场景 DOM 优先、native fallback；已 arm dialog 的 click native 优先，避免 DOM click 触发同步 alert 后卡住。
- Extension 补强：`handleDialog()` 改为阻塞等待后台真正处理完成，消除后续 `getText()` 抢跑到未关闭弹窗上的竞态。

本轮真实验证：

- `AIRPA_RUN_EXTENSION_SMOKE=1 npx vitest run src/main/profile/browser-pool-integration-extension.smoke.test.ts`：通过，覆盖 bundled Chrome + extension relay、网络捕获、alert、截图、snapshot。
- `AIRPA_RUN_RUYI_SMOKE=1 npx vitest run src/main/profile/browser-pool-integration-ruyi.smoke.test.ts`：通过，覆盖 Firefox/Ruyi dialog、tabs、interception。

本轮回归验证：

- `npm run typecheck`：通过。
- `npm run test:browser-pool`：通过，125 tests。
- `npm run test:architecture`：通过，39 tests。
- `npx vitest run src/main/ipc-handlers/browser-runtime-ipc-handler.test.ts src/main/profile/browser-pool-integration-cloak.test.ts src/core/browser-runtime/runtime-manager.test.ts src/main/profile/browser-pool-integration-extension.test.ts src/main/profile/chrome-ruyi-shared.test.ts src/main/profile/ruyi-runtime-shared.test.ts`：通过，29 tests。
- `npx vitest run src/core/browser-automation/browser-capability-truth.test.ts src/core/browser-automation/browser-runtime.cross-runtime-contract.test.ts src/core/ai-dev/capabilities/browser/handlers/browser-handlers.cross-runtime-contract.test.ts src/core/ai-dev/capabilities/browser/handlers/browser-handlers.runtime-features.test.ts src/core/browser-pool/browser-runtime-create-policy.test.ts`：通过，24 tests。
- `npx vitest run src/core/browser-extension/extension-browser.lifecycle.test.ts src/main/profile/browser-pool-integration-extension.test.ts`：通过，12 tests。

剩余建议：

- Cloak 目前主要是 mock/contract 覆盖，还缺少本机真实 Cloak 二进制 smoke。等下载/安装入口稳定后，应补 `AIRPA_RUN_CLOAK_SMOKE=1` 一类的真实启动验证。
- `browser-pool-integration-cloak.ts` 仍然偏大。行为修复已经落地，下一步可以按 runtime resolver、launch options、network、dialog、download controller 拆分，降低长期维护成本。
