# Browser Runtime Refactor Plan

## 背景

当前项目已经有三条浏览器自动化路径：

- `electron`: Electron 内嵌 `WebContentsView` / `webContents`
- `extension`: 外部 bundled Chrome + 控制扩展中转
- `ruyi`: Firefox + BiDi/专用客户端

准备新增 CloakBrowser / Playwright 后，如果继续把它们都作为平级 `engine` 追加，`engine` 字段会同时承载太多含义：浏览器内核、控制协议、二进制来源、profile 形态、窗口形态、指纹能力和打包策略。这会让后续扩展、替换、能力判断和 UI 表达都变得脆弱。

本方案按开发阶段处理：不考虑旧数据兼容、不做旧 profile 自动迁移、不保留旧字段语义。目标是一次性把浏览器运行时架构理顺。

## 目标

1. 将“自动化引擎”拆成清晰的运行时模型。
2. 支持四类默认 runtime：
   - Electron 内嵌 Chromium
   - Chromium extension relay，默认使用打包的 `chrome/chrome.exe`
   - Firefox BiDi，按需下载或自定义路径
   - Cloak Playwright，按需通过官方机制下载或自定义路径
3. 允许 `chromium-extension-relay` 使用本机 Chrome、Edge、Brave、Chromium 等自定义路径，但作为兼容模式处理。
4. 新增浏览器或替换实现时，只需要新增 provider，而不是改散落的 `if (engine === ...)`。
5. 让业务层基于 capability 使用浏览器，不直接依赖具体 runtime 名称。
6. 让打包策略、下载策略、健康检查、指纹映射有统一入口。

## 非目标

1. 不迁移旧 profile 数据。
2. 不保留 `electron | extension | ruyi` 作为长期公共语义。
3. 不承诺所有 Chromium 派生浏览器都能跑 extension relay。
4. 不把 Firefox 或 Cloak binary 默认打包进应用。
5. 不尝试把 Electron 内嵌 Chromium 替换成 Cloak。Electron 内嵌视图只能使用 Electron 自带 Chromium。

## 当前问题

### 1. `engine` 含义过载

当前 `AutomationEngine` 是：

```ts
export const AUTOMATION_ENGINES = ['electron', 'extension', 'ruyi'] as const;
```

这三个值不是同一维度：

- `electron` 是宿主 UI 内嵌能力。
- `extension` 是控制协议，且当前实现其实是 bundled Chrome + extension relay。
- `ruyi` 是 Firefox runtime + BiDi/专用协议组合。

新增 Cloak 后会出现第四个值，但 Cloak 本质是 Chromium binary + Playwright 控制协议 + 特殊反检测能力。

### 2. 二进制来源没有统一模型

现在：

- Electron 随应用必然打包。
- `chrome/` 通过 `electron-builder.yml` 的 `extraResources` 打包。
- Firefox 已有路径解析与错误提示，但不是统一 runtime manager。
- Cloak 受 binary license 限制，不能默认再分发。

这些规则不应该散落在各个 factory 里。

### 3. Capability 声明和 runtime 绑定太硬

`engine-capability-registry.ts` 直接以 `electron | extension | ruyi` 为 key。未来如果支持：

- bundled Chrome extension relay
- system Chrome extension relay
- Edge extension relay
- Cloak Playwright
- 普通 Playwright Chromium

能力可能相似但不完全一样，静态声明需要叠加 runtime probe 的结果。

### 4. Profile 和 runtime 耦合

Profile 当前用 `engine` 表示启动方式。更合理的是 profile 绑定一个 `runtimeId`，runtime 决定浏览器家族、协议、二进制来源和 profile 存储方式。

## 新模型概览

将旧 `engine` 拆成以下概念：

| 概念 | 含义 | 示例 |
| --- | --- | --- |
| `runtimeId` | 用户选择的完整运行时 | `electron-webcontents`, `chromium-extension-relay`, `firefox-bidi`, `chromium-cloak-playwright` |
| `browserFamily` | 浏览器家族 | `electron`, `chromium`, `firefox` |
| `controlProtocol` | 自动化控制协议 | `webcontents`, `extension-relay`, `playwright`, `bidi`, `cdp` |
| `runtimeSource` | 浏览器二进制来源 | `bundled`, `managed-download`, `custom-path`, `system-detected` |
| `profileMode` | profile 生命周期 | `ephemeral`, `persistent` |
| `visibilityMode` | 窗口形态 | `embedded-view`, `external-window`, `direct-window`, `headless` |
| `fingerprintBackend` | 指纹物化方式 | `electron-stealth`, `chromium-ruyi-file`, `firefox-fpfile`, `cloak-flags`, `none` |

## Runtime 命名

删除旧的长期命名：

- `electron`
- `extension`
- `ruyi`

替换为明确 runtime id：

```ts
export const BROWSER_RUNTIME_IDS = [
  'electron-webcontents',
  'chromium-extension-relay',
  'firefox-bidi',
  'chromium-cloak-playwright',
] as const;
```

说明：

- `electron-webcontents`: Electron 内嵌视图。
- `chromium-extension-relay`: Chromium 系浏览器，通过内置控制扩展和 relay 控制。
- `firefox-bidi`: Firefox runtime，通过 BiDi/专用客户端控制。
- `chromium-cloak-playwright`: CloakBrowser Chromium，通过 Playwright 控制。

后续可新增：

- `chromium-playwright`
- `chromium-cdp`
- `firefox-extension-relay`
- `edge-extension-relay`

是否单独拆 `edge-extension-relay` 取决于 UI 是否要把品牌作为 runtime，而不是 path 配置。

## Runtime Source 策略

```ts
export type BrowserRuntimeSource =
  | { type: 'bundled' }
  | { type: 'managed-download'; channel: string; version?: string }
  | { type: 'custom-path'; executablePath: string }
  | { type: 'system-detected'; detectedPath: string };
```

默认策略：

| Runtime | 默认 source | 是否打包 | 可替换 |
| --- | --- | --- | --- |
| `electron-webcontents` | `bundled` | 是，Electron 自带 | 不建议 |
| `chromium-extension-relay` | `bundled` | 是，`chrome/chrome.exe` | 可替换为自定义 Chromium 系浏览器 |
| `firefox-bidi` | `managed-download` | 否 | 可替换为自定义 Firefox |
| `chromium-cloak-playwright` | `managed-download` | 否 | 可指定 Cloak binary/cache |

### 打包策略

保留：

- Electron runtime
- `chrome/` bundled runtime

移除或不再默认包含：

- `firefox/` extraResources，除非明确存在企业内部分发许可和体积需求
- Cloak binary，禁止默认再分发

`electron-builder.yml` 建议最终保留：

```yml
extraResources:
  - from: build/models/
    to: models/
    filter:
      - '**/*.onnx'
  - from: chrome/
    to: chrome/
```

Firefox 和 Cloak 交给 runtime manager。

## Provider Registry

新增 provider registry，主进程只负责注册 provider，不写分支逻辑。

```ts
export interface BrowserRuntimeProvider {
  id: BrowserRuntimeId;
  label: string;
  browserFamily: BrowserFamily;
  controlProtocol: BrowserControlProtocol;
  defaultSource: BrowserRuntimeSource;
  profileMode: BrowserProfileMode;
  visibilityMode: BrowserVisibilityMode;
  fingerprintBackend: BrowserFingerprintBackend;
  capabilities: BrowserRuntimeDescriptor;

  resolveRuntime(input: ResolveRuntimeInput): Promise<ResolvedBrowserRuntime>;
  probeRuntime(runtime: ResolvedBrowserRuntime): Promise<BrowserRuntimeProbeResult>;
  create(session: RuntimeSessionConfig): Promise<BrowserRuntimeCreateResult>;
}
```

`main-service-composition.ts` 不再这样写：

```ts
if (engine === 'extension') return extensionBrowserFactory(session);
if (engine === 'ruyi') return ruyiBrowserFactory(session);
return electronBrowserFactory(session);
```

改成：

```ts
const provider = browserRuntimeRegistry.get(session.runtimeId);
return provider.create(session);
```

## 推荐目录结构

```text
src/
  types/
    browser-runtime.ts
    browser-interface.ts
    profile.ts

  core/
    browser-runtime/
      index.ts
      ids.ts
      types.ts
      capability-registry.ts
      provider-registry.ts
      runtime-source.ts
      runtime-probe.ts
      runtime-errors.ts

    browser-runtime-providers/
      electron-webcontents/
        provider.ts
        electron-browser.ts
        capability.ts

      chromium-extension-relay/
        provider.ts
        chromium-runtime-resolver.ts
        chromium-runtime-probe.ts
        extension-relay-browser.ts
        extension-control/
        capability.ts

      firefox-bidi/
        provider.ts
        firefox-runtime-manager.ts
        firefox-runtime-probe.ts
        firefox-bidi-browser.ts
        capability.ts

      chromium-cloak-playwright/
        provider.ts
        cloak-runtime-manager.ts
        playwright-browser.ts
        capability.ts

  main/
    runtime-manager/
      managed-download-service.ts
      runtime-install-service.ts
      runtime-path-store.ts
      runtime-health-service.ts
```

重构时可以先不物理移动全部代码，但新代码应按这个边界创建。

## Profile 数据模型

不考虑旧数据，直接改 profile schema。

旧字段：

```ts
engine: AutomationEngine;
```

新字段：

```ts
runtimeId: BrowserRuntimeId;
runtimeSourceOverride?: BrowserRuntimeSource | null;
browserBrand?: BrowserBrand | null;
fingerprintProfile?: FingerprintProfileConfig;
```

建议最小 profile：

```ts
export interface BrowserProfile {
  id: string;
  name: string;
  groupId?: string | null;
  runtimeId: BrowserRuntimeId;
  runtimeSourceOverride?: BrowserRuntimeSource | null;
  proxy?: ProxyConfig | null;
  fingerprint?: FingerprintConfig;
  quota: 1;
  idleTimeoutMs: number;
  lockTimeoutMs: number;
  createdAt: number;
  updatedAt: number;
}
```

Profile 创建默认值：

```ts
runtimeId: 'electron-webcontents'
runtimeSourceOverride: null
```

`chromium-extension-relay` 默认使用 bundled Chrome。用户选择本机浏览器时，只写入：

```ts
runtimeSourceOverride: {
  type: 'custom-path',
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}
```

## Runtime Manager

新增统一 runtime manager，负责：

1. 解析 runtime source。
2. 下载 managed runtime。
3. 校验 hash/version。
4. 缓存安装状态。
5. 探测 runtime 能力。
6. 暴露 UI/API 状态。

接口：

```ts
export interface BrowserRuntimeManager {
  listRuntimes(): Promise<BrowserRuntimeStatus[]>;
  resolve(runtimeId: BrowserRuntimeId, source?: BrowserRuntimeSource): Promise<ResolvedBrowserRuntime>;
  ensureInstalled(runtimeId: BrowserRuntimeId): Promise<ResolvedBrowserRuntime>;
  probe(runtimeId: BrowserRuntimeId, source?: BrowserRuntimeSource): Promise<BrowserRuntimeProbeResult>;
  setCustomPath(runtimeId: BrowserRuntimeId, executablePath: string): Promise<void>;
  clearCustomPath(runtimeId: BrowserRuntimeId): Promise<void>;
}
```

状态：

```ts
export interface BrowserRuntimeStatus {
  runtimeId: BrowserRuntimeId;
  installed: boolean;
  source: BrowserRuntimeSource;
  executablePath?: string;
  version?: string;
  healthy: boolean;
  probe?: BrowserRuntimeProbeResult;
  license?: {
    name: string;
    url: string;
    requiresUserAcknowledgement: boolean;
  };
}
```

## Capability 设计

Capability 分两层：

1. Static capability: provider 声明理论能力。
2. Probe capability: 启动后真实检测能力。

最终能力：

```ts
finalCapability = staticCapability AND probeCapability
```

`BrowserRuntimeDescriptor` 增加 runtime 元信息：

```ts
export interface BrowserRuntimeDescriptor {
  runtimeId: BrowserRuntimeId;
  browserFamily: BrowserFamily;
  controlProtocol: BrowserControlProtocol;
  profileMode: BrowserProfileMode;
  visibilityMode: BrowserVisibilityMode;
  source: BrowserRuntimeSource;
  capabilities: Record<BrowserCapabilityName, BrowserCapabilityDescriptor>;
}
```

业务层只调用：

```ts
browser.hasCapability('network.responseBody')
```

不要再写：

```ts
if (engine === 'ruyi') ...
```

## 四个默认 Runtime 细节

### 1. `electron-webcontents`

定位：

- 内嵌浏览器
- 应用内可见视图
- 与 Electron window/view manager 深度集成

Source：

```ts
{ type: 'bundled' }
```

特点：

- 不能替换成 Cloak。
- 保留 `viewId`。
- 适合内部预览、轻量自动化、与桌面 UI 融合的工作流。

不适合：

- 高反检测目标。
- 需要真实外部浏览器 profile 的场景。

### 2. `chromium-extension-relay`

定位：

- 外部 Chromium 系浏览器
- 通过内置控制扩展 + relay 控制
- 默认使用 bundled `chrome/chrome.exe`

默认 Source：

```ts
{ type: 'bundled' }
```

可选 Source：

```ts
{ type: 'custom-path', executablePath: '...' }
```

支持目标：

- Chrome
- Chromium
- Edge
- Brave
- 其他 Chromium 派生浏览器

但必须 probe：

- 支持 MV3
- 支持 unpacked extension
- 支持 `chrome.debugger`
- 支持 `chrome.scripting`
- 支持 `chrome.tabs`
- 支持 CDP domains: `Page`, `Runtime`, `Network`, `Fetch`, `Input`, `Emulation`
- 支持独立 `--user-data-dir`
- 支持代理参数

说明：

- Chrome/Edge 成功率最高。
- Brave 可能与其隐私保护和指纹保护冲突，应标记为 experimental。
- 不承诺所有 Chromium 派生浏览器支持。

### 3. `firefox-bidi`

定位：

- Firefox runtime
- 使用 BiDi/专用客户端
- 覆盖 Firefox 家族和跨内核验证

默认 Source：

```ts
{ type: 'managed-download', channel: 'firefox' }
```

可选 Source：

```ts
{ type: 'custom-path', executablePath: '...' }
```

下载策略：

- 首次选择时提示下载。
- 下载到用户数据目录，例如 `runtime/firefox/<version>/`。
- 下载后 hash 校验。
- 下载失败允许用户选择本机 Firefox。

### 4. `chromium-cloak-playwright`

定位：

- CloakBrowser Chromium
- Playwright 控制
- 高隐身外部 Chromium 自动化

默认 Source：

```ts
{ type: 'managed-download', channel: 'cloakbrowser' }
```

实现原则：

- 不把 Cloak binary 打包进应用。
- 只依赖官方 npm wrapper 或官方下载机制。
- UI 提示 Cloak binary license。
- 支持 custom binary/cache path。
- 主进程 CommonJS 下使用动态 import。

示例：

```ts
const cloak = await import('cloakbrowser');
const context = await cloak.launchPersistentContext({
  userDataDir,
  headless: false,
  proxy,
  locale,
  timezone,
  viewport,
  humanize: true,
});
```

## 指纹模型

保留统一 `FingerprintConfig`，但新增 projection 层：

```ts
export interface FingerprintProjector {
  backend: BrowserFingerprintBackend;
  project(input: FingerprintConfig, runtime: ResolvedBrowserRuntime): Promise<ProjectedFingerprint>;
}
```

后端：

```ts
export type BrowserFingerprintBackend =
  | 'electron-stealth'
  | 'chromium-ruyi-file'
  | 'firefox-fpfile'
  | 'cloak-flags'
  | 'none';
```

映射：

| Runtime | Fingerprint backend |
| --- | --- |
| `electron-webcontents` | `electron-stealth` |
| `chromium-extension-relay` | `chromium-ruyi-file` |
| `firefox-bidi` | `firefox-fpfile` |
| `chromium-cloak-playwright` | `cloak-flags` |

Cloak 映射注意事项：

- Cloak 的 fingerprint seed、timezone、locale、platform、screen、hardware concurrency 等应通过 Cloak 支持的 flags/options 映射。
- 不要把现有 Ruyi txt 文件直接塞给 Cloak。
- `humanize` 是 Cloak wrapper 层能力，不是通用 capability。

## Browser Pool 调整

旧：

```ts
SessionConfig.engine?: AutomationEngine;
```

新：

```ts
SessionConfig.runtimeId: BrowserRuntimeId;
SessionConfig.runtimeSourceOverride?: BrowserRuntimeSource | null;
```

等待队列 key 从：

```ts
sessionId + engine
```

改为：

```ts
sessionId + runtimeId
```

`PooledBrowser` 增加：

```ts
runtimeId: BrowserRuntimeId;
runtimeDescriptor: BrowserRuntimeDescriptor;
resolvedRuntime: ResolvedBrowserRuntime;
```

`BrowserHandle` 返回：

```ts
runtimeId
browserFamily
controlProtocol
capabilities
```

## UI 调整

Profile 表单不要展示旧的 “Engine: Electron / Extension / Ruyi”。

改为两级展示：

1. 运行时类型
2. 浏览器来源

运行时类型：

- Electron 内嵌浏览器
- Chromium 扩展中转
- Firefox BiDi
- Cloak Playwright

浏览器来源：

- 使用内置浏览器
- 下载托管运行时
- 使用本机浏览器路径

`chromium-extension-relay` UI：

- 默认：内置 Chrome
- 可选：选择本机浏览器
- 按钮：检测兼容性
- 检测结果显示：版本、MV3、debugger、CDP、代理、扩展加载

`firefox-bidi` UI：

- 未安装时显示“下载 Firefox runtime”
- 支持“选择本机 Firefox”

`chromium-cloak-playwright` UI：

- 未安装时显示“安装 CloakBrowser runtime”
- 显示第三方 license 提示
- 支持 `humanize` 开关

## API / MCP / HTTP 调整

请求参数从：

```json
{ "engine": "extension" }
```

改为：

```json
{ "runtimeId": "chromium-extension-relay" }
```

兼容性不考虑，所以直接删除旧参数。

HTTP 错误提示：

```text
Unsupported runtimeId "extension".
Supported runtimeIds: electron-webcontents, chromium-extension-relay, firefox-bidi, chromium-cloak-playwright.
```

MCP `session_prepare` 参数同样改为 `runtimeId`。

## 配置调整

旧配置命名：

```ts
AIRPA_RUNTIME_CONFIG.extension.*
AIRPA_RUNTIME_CONFIG.ruyi.*
```

新配置：

```ts
AIRPA_RUNTIME_CONFIG.browserRuntimes = {
  chromiumExtensionRelay: {
    bundledChromeEnabled: true,
    defaultRuntimeSource: 'bundled',
    customExecutablePath: '',
    extraLaunchArgs: [],
    expectedVersion: '',
    expectedVersionPrefix: '',
    expectedSha256: '',
    fingerprintStrict: false,
  },
  firefoxBidi: {
    defaultRuntimeSource: 'managed-download',
    customExecutablePath: '',
    managedVersion: '',
  },
  chromiumCloakPlaywright: {
    defaultRuntimeSource: 'managed-download',
    customExecutablePath: '',
    humanizeDefault: true,
  },
};
```


## Implementation Status

Status date: 2026-05-13.

Implemented in this working tree:

- Phase 1: Added `BrowserRuntimeId`, runtime source/family/protocol/profile/visibility/fingerprint types, and static runtime descriptors for `electron-webcontents`, `chromium-extension-relay`, `firefox-bidi`, and `chromium-cloak-playwright`.
- Phase 2: Replaced profile `engine` with `runtimeId` and `runtimeSourceOverride` across shared types, profile persistence, schema bootstrap/migrations, sync apply, IPC/preload, HTTP, MCP, plugin helper APIs, and renderer AccountCenter UI.
- Phase 3: Migrated browser pool session/acquire/handle identity from `engine` to `runtimeId`, including wait queues, reuse, plugin leases, create policy, metrics, and UI-facing pool browser info.
- Phase 4: Introduced runtime provider registry and registered Electron WebContents, Chromium Extension Relay, Firefox BiDi, and Cloak Playwright providers. Runtime creation now dispatches by provider instead of scattered engine branches.
- Phase 5: Added `BrowserRuntimeManager`, persisted runtime source overrides/probe snapshots, runtime source/default resolution, executable path validation, Chrome/Firefox/Cloak probe hooks, and `system_bootstrap.browserRuntimes.statuses` exposure through HTTP/MCP system gateway composition.
- Phase 6: Added a Playwright-backed `chromium-cloak-playwright` adapter using dynamic `cloakbrowser` import, persistent context launch, custom/binary cache path resolution, cookies, screenshots, PDF export, DOM text/snapshot/search, selector actions, coordinate/native input, tabs, viewport/identity application, console/network capture, download management, JS dialog handling, request interception, runtime events, and close/release plumbing.
- Phase 7: Runtime status now distinguishes bundled/custom-path/managed-installed/missing/unknown states and reports healthy/installed/version/path/errors/warnings. Static descriptors remain the contract surface; probe results are exposed as runtime status rather than mutating descriptors.
- Phase 8: Removed the old public automation-engine type/module and migrated source/tests away from `electron | extension | ruyi` as browser runtime ids. Historical cross-engine browser contract test filenames were renamed to cross-runtime/runtime-feature contracts. Remaining `engine` naming is unrelated domain language such as query/OCR/sync engine, or historical explanation in this document.
- UI/IPC: Added trusted renderer IPC routes and preload API for browser runtime status/config (`browserRuntime.listStatuses/getStatus/selectExecutable/setCustomPath/setDefaultSource/installManaged/openDownloadPage`), plus a settings page runtime panel showing registered runtimes, health, source, version/path, probe capabilities, warnings, errors, custom path selection, default reset, Cloak managed install, and download links.

Verification completed:

- `npm run typecheck`
- `npm run test:architecture`
- `npm run test:open`
- `npm run test:browser-pool`
- `npx vitest run src/core/browser-runtime/runtime-manager.test.ts src/main/ipc-handlers/browser-runtime-ipc-handler.test.ts src/renderer/src/components/SettingsPage/__tests__/BrowserRuntimePanel.test.tsx src/renderer/src/components/SettingsPage/__tests__/SettingsPage.test.tsx`
- `npx vitest run src/types/browser-runtime.test.ts src/core/js-plugin/namespaces/profile.test.ts src/core/js-plugin/namespaces/profile.with-lease.test.ts src/core/js-plugin/helpers.behavior.contract.test.ts src/main/http-browser-pool-adapter.test.ts src/main/mcp-http-types.test.ts src/main/mcp-http-session-runtime.test.ts src/main/mcp-http-runtime-availability.test.ts`
- `npx vitest run src/types/browser-runtime.test.ts src/core/ai-dev/capabilities/runtime-descriptor-surface.test.ts src/main/app-runtime.test.ts src/main/http-server-composition.test.ts src/main/mcp-http-runtime-availability.test.ts`
- `npx vitest run src/main/mcp-server-http.browser-binding.test.ts src/main/mcp-server-http.transport-session.test.ts src/main/mcp-server-http.mcp-surface.test.ts src/main/mcp-server-http.auth-invoke.test.ts src/main/mcp-server-http.orchestration-routes.test.ts`

Known follow-ups:

- Firefox still uses system detection/custom-path/open-download-page rather than a built-in binary downloader. This is intentional until we choose an official, hash-pinned managed Firefox distribution.
- Cloak has managed install via `cloakbrowser.ensureBinary()` and UI entry points, but still needs real-browser smoke coverage in environments where downloading the binary is allowed.
## 实施步骤

### Phase 0: 冻结旧模型

目标：禁止继续扩展旧 `engine` 模型。

动作：

1. 新建本文档。
2. 新建 `src/types/browser-runtime.ts`。
3. 标记 `src/types/automation-engine.ts` 为待删除。
4. 新代码禁止引用 `AutomationEngine`。

验收：

- 文档存在。
- 新 runtime id 类型存在。
- 不新增旧 engine 分支。

### Phase 1: 新建 Runtime 类型和 Registry

动作：

1. 创建 `BrowserRuntimeId`。
2. 创建 `BrowserRuntimeProvider`。
3. 创建 `BrowserRuntimeRegistry`。
4. 将 `engine-capability-registry.ts` 改为 `runtime-capability-registry.ts`。
5. 注册四个静态 provider stub。

验收：

- 可以列出四个 runtime。
- 每个 runtime 有静态 descriptor。
- 单测覆盖 registry 重复注册、未知 runtime、capability clone。

### Phase 2: Profile Schema 破坏性重建

动作：

1. 删除 profile 表旧 `engine` 语义。
2. 新增 `runtime_id`。
3. 新增 `runtime_source_override` JSON。
4. Profile service 默认创建 `electron-webcontents`。
5. Profile UI 改用 runtime selector。

验收：

- 新建 profile 写入 `runtime_id`。
- 旧 engine UI 消失。
- 测试不再断言 `electron | extension | ruyi`。

### Phase 3: Browser Pool 切换到 Runtime

动作：

1. `SessionConfig.engine` 改为 `runtimeId`。
2. `AcquireOptions.engine` 改为 `runtimeId`。
3. wait queue key 改为 runtime id。
4. `GlobalPool` 使用 provider registry 创建浏览器。
5. `BrowserHandle` 返回 runtime descriptor。

验收：

- pool 单测全部使用 runtime id。
- 创建逻辑不再有 `engine === 'extension'` 这类分支。

### Phase 4: Provider 迁移

动作：

1. `createBrowserFactory` 迁移为 `electron-webcontents/provider.ts`。
2. `createExtensionBrowserFactory` 迁移为 `chromium-extension-relay/provider.ts`。
3. `createRuyiBrowserFactory` 迁移为 `firefox-bidi/provider.ts`。
4. 新增 `chromium-cloak-playwright/provider.ts` stub。

验收：

- 三个现有 runtime 以 provider 注册方式启动。
- 主进程 composition 不再手动分发 runtime。

### Phase 5: Runtime Manager

动作：

1. 新增 runtime install/status store。
2. 实现 bundled Chrome resolver。
3. 实现 custom path resolver。
4. 实现 Firefox managed-download stub 或最小下载器。
5. 实现 Cloak wrapper 检测和官方下载触发。

验收：

- UI/API 可查询 runtime status。
- bundled Chrome 可检测。
- custom path 可保存和 probe。
- Firefox/Cloak 未安装时有明确状态。

### Phase 6: Cloak Playwright Provider

动作：

1. 安装 `cloakbrowser` 和 `playwright-core`。
2. 用动态 import 加载 ESM package。
3. 实现 `PlaywrightBrowser` adapter。
4. 实现 persistent context。
5. 实现基础能力：goto、evaluate、click、type、screenshot、cookies、tabs、network、console、dialog。
6. 暂时将不稳定能力标记为 experimental。

验收：

- Cloak runtime 能启动。
- 能打开页面、截图、输入、读取 cookie。
- 能关闭并释放 profile。
- 不把 Cloak binary 打包到 release。

### Phase 7: Runtime Probe

动作：

1. `chromium-extension-relay` probe：
   - executable exists
   - version
   - launch with temp userDataDir
   - load temp extension
   - attach debugger
   - run CDP command
2. `firefox-bidi` probe：
   - executable exists
   - launch temp profile
   - BiDi connect
3. `cloak` probe：
   - wrapper import
   - binary info
   - launch temp context

验收：

- Runtime status 能区分 installed/healthy/capability degraded。
- custom Brave/Edge 失败时能解释原因。

### Phase 8: 删除旧模型

动作：

1. 删除 `src/types/automation-engine.ts`。
2. 删除旧 `engine` 参数。
3. 删除旧 `normalizeAutomationEngine`。
4. 删除旧 UI 文案。
5. 删除旧 tests 中 `extension`/`ruyi` engine 假设。

验收：

- `rg "AutomationEngine|engine === 'extension'|engine === 'ruyi'|engine === 'electron'" src` 无业务分支残留。
- 允许日志、文档、测试 fixture 中有限保留 runtime 名称。

## 关键文件清单

优先改：

- `src/types/automation-engine.ts`
- `src/types/browser-interface.ts`
- `src/types/profile.ts`
- `src/core/browser-pool/types.ts`
- `src/core/browser-pool/global-pool.ts`
- `src/core/browser-pool/wait-queue.ts`
- `src/core/browser-pool/engine-capability-registry.ts`
- `src/main/bootstrap/main-service-composition.ts`
- `src/main/profile/browser-pool-integration.ts`
- `src/main/profile/browser-pool-integration-extension.ts`
- `src/main/profile/browser-pool-integration-ruyi.ts`
- `src/main/profile/chrome-runtime-shared.ts`
- `src/main/profile/ruyi-runtime-shared.ts`
- `src/main/duckdb/profile-service.ts`
- `src/main/http-request-utils.ts`
- `src/renderer/src/components/AccountCenter/ProfileFormDialog.tsx`
- `src/renderer/src/components/AccountCenter/ProfileList.tsx`
- `src/renderer/src/components/AccountCenter/RunningBrowsersPanel.tsx`

## 测试策略

### 单元测试

- runtime id helper
- provider registry
- runtime source resolver
- capability merge
- profile persistence
- wait queue runtime isolation
- custom path validation

### 集成测试

- bundled Chrome extension relay smoke
- custom Chromium path probe
- Firefox BiDi smoke，允许未安装时 skip
- Cloak Playwright smoke，允许未安装时 skip
- HTTP/MCP `runtimeId` acquisition

### 真实契约测试

保留现有 real-contract 思路，但按 runtime 命名：

- `browser-runtime-electron-webcontents.real-contract.test.ts`
- `browser-runtime-chromium-extension-relay.real-contract.test.ts`
- `browser-runtime-firefox-bidi.real-contract.test.ts`
- `browser-runtime-chromium-cloak-playwright.real-contract.test.ts`

## 风险和取舍

### 1. 打包体积

保留 bundled Chrome 会增加包体积。当前 `chrome/` 目录约 300MB 级别，但它换来默认可用性。开发阶段建议保留。

### 2. 自定义 Chromium 不稳定

Edge/Brave/Chromium 理论可用，但必须 probe。失败不代表 bug，而是 runtime 不满足 extension relay 契约。

### 3. Cloak 许可

Cloak binary 不能默认再分发。只能按需通过官方机制下载，或用户自定义路径。UI 必须暴露 license 链接和确认。

### 4. Playwright 引入新协议栈

Cloak provider 会引入 Playwright 依赖，和现有 extension relay/CDP 形成能力重叠。长期可能将 `chromium-extension-relay` 降级为 advanced/legacy runtime，但短期先并存。

### 5. 指纹一致性

不同 runtime 的指纹物化能力不同。统一配置只能作为意图层，真实结果必须通过 runtime probe 和 real-contract 验证。

## 最终状态

重构完成后，系统中不再有模糊的 `engine` 概念。Profile 选择的是 `runtimeId`，runtime provider 决定如何解析二进制、如何启动、如何控制、支持哪些能力。

默认体验：

- 用户无需配置即可使用 Electron 内嵌浏览器和 bundled Chrome extension relay。
- 需要 Firefox 时，点击下载或选择本机 Firefox。
- 需要 Cloak 时，按需安装官方 runtime，并接受第三方 binary license。
- 需要 Chrome/Edge/Brave 本机路径时，可以为 `chromium-extension-relay` 配置 custom path，并通过 probe 判断是否可用。

长期收益：

- 新增浏览器只新增 provider。
- 业务层按 capability 编程。
- 打包、下载、路径、健康检查统一。
- 旧的 `extension`/`ruyi` 命名不再污染未来架构。
