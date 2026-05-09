# Codex 自动化测试计划

目标：不额外编写一套 LLM 测试框架，直接让 Codex 作为测试代理来完成代码测试、真实运行测试和模拟人工测试。Codex 负责分析代码、运行现有命令、启动应用、操作 UI、检查结果、整理报告。

## 原则

- 优先使用仓库已有测试脚本：`npm run test:open`、`npm run test:open:full`、`npm run verify:ci` 等。
- 不新增复杂的 LLM 编排代码，避免为了“测试大模型”再维护一套测试系统。
- Codex 可以临时写很小的 fixture、脚本或测试用例，但只在确实需要复现问题时做。
- 所有测试都要有可验证证据：命令输出、日志、HTTP 返回、数据库状态、截图、trace、打包产物。
- 三类测试都由 Codex 自动执行，不需要人工手动点击。

## 代码分析结论

这个仓库是 Electron + Vite/React + TypeScript 桌面应用，主要模块包括：

| 模块 | 位置 | 需要重点测什么 |
| --- | --- | --- |
| 主进程 | `src/main/` | 应用启动、IPC、HTTP/MCP、DuckDB、WebContentsView、打包启动 |
| Preload | `src/preload/` | `window.electronAPI` 暴露面、事件白名单、类型契约 |
| 渲染层 | `src/renderer/` | 数据表、插件市场、账号中心、设置页、状态管理、响应式布局 |
| 插件运行时 | `src/core/js-plugin/` | 插件安装、reload、uninstall、helpers、storage、权限/信任模型 |
| 数据层 | `src/main/duckdb/`, `src/core/query-engine/` | 数据集 CRUD、导入导出、查询流水线、schema、SQL 安全 |
| 浏览器自动化 | `src/core/browser-*` | browser pool、snapshot、act、wait、selector、跨引擎行为 |
| HTTP/MCP | `src/main/mcp*`, `src/main/orchestration*` | 会话、鉴权、scope、幂等、capability surface、错误结构 |
| 构建发布 | `scripts/`, `electron-builder.yml` | 开源边界、供应链、SBOM、Windows 打包、启动健康 |

现有测试基础已经比较好：仓库有大量 Vitest 单元/集成测试，`package.json` 里也已经提供了重点测试、完整测试和 CI 验证脚本。所以第一阶段不需要先写 LLM 测试框架，直接让 Codex 调这些脚本就够。

## 一、代码测试

由 Codex 自动完成：

1. 读取 `git status`、`git diff` 和相关源码。
2. 判断影响范围。
3. 运行对应测试命令。
4. 如果失败，继续读失败日志和源码，给出根因与修复建议。
5. 必要时补充小范围 Vitest 回归测试。

### 必跑命令

| 优先级 | 命令 | 用途 |
| --- | --- | --- |
| P0 | `npm run typecheck` | 类型契约 |
| P0 | `npm run lint` | 静态检查 |
| P0 | `npm run test:open` | 开源版重点测试 |
| P1 | `npm run test:architecture` | 架构和 runtime profile 护栏 |
| P1 | `npm run test:open:full` | 完整 Vitest |
| P1 | `npm run verify:open-source-boundary` | 开源边界 |
| P1 | `npm run verify:supply-chain` | 供应链策略 |
| Release | `npm run verify:ci` | 发布前完整验证 |

### Codex 的判断规则

- 如果改了 `src/core/js-plugin/`，重点跑插件 helpers、插件安装、插件 contract 测试。
- 如果改了 `src/main/duckdb/` 或 `src/core/query-engine/`，重点跑数据集和查询引擎测试。
- 如果改了 `src/main/mcp*`、`src/main/orchestration*`，重点跑 HTTP/MCP 和 capability 测试。
- 如果改了 `src/preload/`，重点跑 preload contract 和 renderer 相关测试。
- 如果改了 `src/renderer/`，重点跑相关组件测试，再做模拟人工 UI 测试。
- 如果改了构建脚本、打包配置或依赖，必须跑开源边界、供应链、SBOM、构建。

## 二、真实运行测试

真实测试也直接由 Codex 执行，不写专门的 LLM runner。

### npm run dev + Playwright/CDP 真实客户端方案

可以用 `npm run dev` 启动完整 Electron 软件，再由 Playwright 通过 Electron 的 CDP 调试端口操控真实窗口。这个方式比只打开 Vite 页面更接近用户真实使用方式，因为它同时覆盖主进程、preload、IPC、renderer、真实窗口尺寸、菜单/弹窗、日志和本地 userData。

启动规则：

```powershell
$env:TIANSHEAI_USER_DATA_DIR='.tmp-test-userdata-run/codex-dev-e2e'
$env:AIRPA_E2E_CDP_PORT='49333'
$env:AIRPA_ENABLE_HTTP='true'
$env:AIRPA_ENABLE_MCP='true'
$env:AIRPA_HTTP_PORT='49334'
npm run dev
```

说明：

- `npm run dev:open` 等价于开放版完整 dev 启动链路：Vite renderer、main watch、Electron 主程序。
- `TIANSHEAI_USER_DATA_DIR` 必须使用隔离目录，避免污染真实账号、插件和数据表。
- `AIRPA_E2E_CDP_PORT` 会被 dev 启动器转成 `--airpa-e2e-cdp-port`，打开 Electron 远程调试端口，Playwright 可通过 `chromium.connectOverCDP()` 接入真实窗口。
- `AIRPA_ENABLE_HTTP`、`AIRPA_ENABLE_MCP`、`AIRPA_HTTP_PORT` 会被 dev 启动器转成应用启动参数，同时打开 HTTP/MCP，方便把 UI 操作和后端状态互相校验。
- 每轮测试结束必须关闭 Electron/dev 进程，并删除隔离 userData。

Playwright/CDP 操控原则：

- 首先等待 CDP `/json/version` 和 HTTP `/health` 可用。
- 连接 CDP 后选择标题为 `TiansheAI` 或 URL 指向 `127.0.0.1:5273`/`dist/renderer/index.html` 的主页面。
- 每个页面切换后检查：`window.electronAPI` 是否存在、页面是否非空、是否出现 ErrorBoundary、控制台 error 数。
- 对关键用户路径保存截图，截图必须非空且没有明显错位、乱码、遮挡。
- UI 操作优先用可访问名称、文本、按钮角色；找不到时再用 DOM/CSS 兜底。
- 对数据表、插件、HTTP/MCP 等业务状态，用 preload API 或 HTTP capability 做二次确认。

首轮真实客户端自动化测试矩阵：

| 编号 | 类型 | 自动化动作 | 通过标准 |
| --- | --- | --- | --- |
| D1 | 启动健康 | `npm run dev:open` 启动完整 Electron，等待 Vite/main/Electron 就绪 | CDP 可连接，HTTP `/health` 为 ok，主窗口非空 |
| D2 | Preload | 在主窗口执行 `window.electronAPI.getAppInfo()` | `success=true`，`isPackaged=false`，无 `getAppInfo` 崩溃 |
| D3 | 主导航 | 依次点击 数据表、插件市场、账号中心、设置 | 页面切换成功，无 ErrorBoundary，无 console error |
| D4 | 数据表 UI | 创建测试数据表，确认列表展示，再删除 | UI 出现目标表名；删除后目标表消失；preload 列表同步 |
| D5 | 插件市场 | 打开插件市场和已安装区域 | 页面可渲染，开发/本地插件入口状态符合 dev 模式 |
| D6 | 设置页 | 打开设置页，读取 HTTP/MCP 相关区域 | 页面可渲染，HTTP `/health` 与 UI 状态不冲突 |
| D7 | 响应式 | 1366x900、900x700、390x844 三种视口各访问主页面 | 无横向溢出、无明显重叠、截图非空 |
| D8 | 错误恢复 | 构造一次可控失败，如删除已被后台移除的数据表 | UI 显示可理解错误，不崩溃 |
| D9 | 清理 | 关闭进程、删除 userData、检查端口 | 无测试进程和端口残留 |

### 启动方式

每次测试使用独立用户数据目录，避免污染真实环境：

```bash
npm run build:open
npx electron . --airpa-user-data-dir=".tmp-test-userdata-run/codex-real" --airpa-enable-http --airpa-enable-mcp --airpa-http-port=39090
```

Codex 自动检查：

- Electron 进程是否启动。
- `/health` 是否成功。
- `startup-diagnostic.log` 是否有启动错误。
- HTTP/MCP capability 是否正常。

### 真实测试场景

| 场景 | Codex 自动做什么 | 通过标准 |
| --- | --- | --- |
| 应用启动 | 构建并启动 Electron | 窗口非空白，`/health` 成功 |
| HTTP 健康 | 请求 `/health` | 返回版本、协议、runtime flags |
| Capability 列表 | 请求 `/api/v1/orchestration/capabilities` | 公开能力存在，内部能力不外露 |
| Orchestration 会话 | create、heartbeat、invoke、delete | 生命周期完整，关闭后不可再用 |
| MCP 会话 | initialize、tools/list、tools/call | 协议、session id、工具返回正确 |
| 数据集 | 创建/导入 CSV、查询、重命名、删除 | 数据库状态和行列数正确 |
| 查询流水线 | filter、sort、group、aggregate、lookup | 查询结果符合 fixture |
| 插件 | 安装 `examples/minimal-plugin`、reload、status、uninstall | 插件状态正确，无残留 |
| 浏览器自动化 | 打开本地 HTML fixture，observe/search/act/wait | 元素可识别、可点击、状态变化正确 |
| 打包烟测 | `npm run package:open:dir` 后启动 | 打包应用可启动，核心页面可打开 |

这些测试可以先由 Codex 手动运行命令和检查结果，稳定后再把其中最有价值的部分沉淀成普通测试脚本。

## 三、模拟人工测试

模拟人工测试的意思不是让真人点，而是让 Codex 控制浏览器/应用，像用户一样完成任务。

优先方式：

- 用 Playwright/Electron 控制真实窗口。
- Codex 根据截图、accessibility snapshot、DOM 状态决定下一步。
- 每个任务结束后保存截图和日志。

### 必测用户任务

| 用户任务 | Codex 自动操作 |
| --- | --- |
| 首次打开应用 | 检查数据表、插件市场、账号中心、设置页都能进入 |
| 数据工作流 | 创建表、添加字段、添加记录、筛选、排序、导出 |
| 文件导入 | 导入 CSV/XLSX，等待进度结束，检查行列 |
| 插件工作流 | 安装插件、打开插件视图、reload、uninstall |
| HTTP API 设置 | 打开设置页，启用 HTTP/MCP，验证接口 |
| 删除确认 | 删除行/表/文件夹，确认取消和确认两条路径 |
| 响应式布局 | 在桌面和窄屏尺寸下检查主要页面 |
| 异常恢复 | 制造导入失败或插件失败，检查错误是否可见 |

### 视觉检查标准

Codex 需要看截图并判断：

- 页面是否空白。
- 文字是否乱码、重叠、溢出。
- 弹窗是否遮挡主流程。
- 按钮是否可点击。
- 当前页面是否和任务目标一致。
- toast、进度条、错误提示是否出现得合理。

视觉问题必须带截图路径和位置描述。

## 推荐执行顺序

第一轮先做轻量但有效的验证：

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test:open`
4. `npm run verify:open-source-boundary`
5. `npm run build:open`
6. 启动 Electron，检查 `/health`
7. 用 HTTP/MCP 跑 session 和 capability 冒烟
8. 用 Codex 操作 UI 跑首屏导航和数据表基本流程

第二轮再扩大：

1. `npm run test:open:full`
2. 数据集真实导入/导出
3. 插件安装/reload/uninstall
4. 浏览器自动化本地页面
5. 打包目录烟测
6. 多视口模拟人工测试

发布前再跑：

```bash
npm run verify:ci
npm run package:open:dir
```

## 报告格式

Codex 每次测试后直接输出简洁报告即可：

```text
测试时间：
测试范围：
执行命令：
通过项：
失败项：
阻断问题：
截图/日志位置：
建议修复顺序：
是否建议合并/发布：
```

如果需要落文件，可以写到：

```text
artifacts/codex-test-report.md
```

## 首批 10 个 Codex 自动测试任务

- [x] 1. 跑 `typecheck + lint + test:open`。
- [x] 2. 跑 `verify:open-source-boundary`。
- [x] 3. 跑 `build:open`。
- [x] 4. 启动真实 Electron 并请求 `/health`。
- [x] 5. 请求 orchestration capabilities，检查公开能力。
- [x] 6. 创建 orchestration session，调用 `system_get_health`，再关闭 session。
- [x] 7. 初始化 MCP session，检查 tools/list。
- [x] 8. 用真实 CSV fixture 测一次数据集导入、查询、删除。（已通过：真实 CSV 经 renderer preload API 完成导入、查询、删除）
- [x] 9. 安装并卸载 `examples/minimal-plugin`。（已通过：示例 id 改为 `minimal_plugin`，目录安装按真实规则使用 `devMode=true`）
- [x] 10. 用 Codex 操作真实 UI 完成首屏导航和数据表基本流程。（已通过：CDP 模拟点击真实 UI 主导航，并完成数据表创建/显示/删除）

### 当前执行记录

- 2026-05-09 09:30：任务 1 通过。`npm run typecheck`、`npm run lint`、`npm run test:open` 均 exit 0；`lint` 输出 154 个 warning，`test:open` 7 个测试文件 / 25 个测试通过。
- 2026-05-09 09:31：任务 2 通过。`npm run verify:open-source-boundary` exit 0，验证 1157 个开源版文件。
- 2026-05-09 09:32：任务 3 通过。`npm run build:open` exit 0，renderer/main 构建成功，主进程 build stamp 已写入，开源边界再次通过。
- 2026-05-09 09:37：任务 4 通过。使用 `node scripts/launch-electron.js . --airpa-user-data-dir=.tmp-test-userdata-run/codex-real-39091 --airpa-enable-http --airpa-enable-mcp --airpa-http-port=39091` 启动真实 Electron，`GET /health` 返回 `success=true`、`status=ok`、`mcpEnabled=true`、build freshness 为 `fresh`。
- 2026-05-09 09:38：任务 5 通过。`GET /api/v1/orchestration/capabilities` 返回 29 个公开能力；`browser_snapshot`、`browser_act`、`system_get_health`、`plugin_list`、`dataset_create_empty` 等必要能力存在，`browser_get_url`、`browser_evaluate`、`browser_network_start`、`browser_cookies_get` 未暴露。
- 2026-05-09 09:38：任务 6 通过。创建 orchestration session 成功，获得 electron 引擎浏览器；调用 `system_get_health` 返回 `status=ok`；随后 `DELETE /api/v1/orchestration/sessions/:sessionId` 返回 `Session closed`。
- 2026-05-09 09:40：任务 7 通过。MCP `initialize` 返回协议 `2025-11-25` 和 session id；`tools/list` 返回 29 个工具，包含 `system_get_health`、`browser_snapshot`、`plugin_list`；`DELETE /mcp` 返回 204。PowerShell `Invoke-WebRequest` 曾出现客户端侧 NullReferenceException，改用 Node `fetch` 后验证通过。
- 2026-05-09 09:43：任务 8 部分完成。使用真实 CSV fixture `artifacts/codex-fixtures/codex-orders.csv` 调用 `dataset_import_file` 成功，返回 dataset id `dataset_1778290840946_f7c5e625`；`system_bootstrap` 能列出该数据集；调用 `dataset_delete` 成功，删除后 `system_bootstrap` 不再列出该数据集。缺口：当前公开 orchestration/MCP capabilities 不暴露 `dataset_query`，直接调用返回 `404 NOT_FOUND`，因此“查询”步骤未通过公开 HTTP/MCP 完成。
- 2026-05-09 09:45：任务 9 失败。调用 `plugin_install` 安装 `examples/minimal-plugin` 时被运行时拒绝：`Plugin ID must only contain alphanumeric characters and underscores`。示例 manifest 当前为 `"id": "minimal-plugin"`，而 `src/core/js-plugin/loader.ts` 要求 `^[a-zA-Z0-9_]+$`。
- 2026-05-09 09:49：任务 10 失败。真实 Electron 主窗口进入 ErrorBoundary；CDP 检查显示 `window.electronAPI=false`，页面错误为 `Cannot read properties of undefined (reading 'getAppInfo')`。`startup-diagnostic.log` 记录 preload 加载失败：`Unable to load preload script: dist/preload/index.js`，原因是 `Error: module not found: ./api/account`。由于 preload 没有注入，首屏导航和数据表 UI 基本流程无法继续。
- 2026-05-09 09:51：完成阻断修复。`scripts/build-main-with-stamp.js` 在 `tsc -p tsconfig.main.json` 后用 esbuild 将 `src/preload/index.ts` 和 `src/preload/webcontents-view.ts` bundle 成单文件 CJS，保留 Electron `sandbox: true`，并在根 `devDependencies` 显式声明 `esbuild`；同时将 `examples/minimal-plugin`、`README.md` 和开源导出模板中的插件 id 改为 `minimal_plugin`。
- 2026-05-09 09:52：修复后回归通过。`npm run build:open` exit 0，日志显示两个 preload 入口已 bundle；`npm run test:open` 7 个测试文件 / 25 个测试通过；`npm run lint` exit 0，仍为既有 154 个 warning。
- 2026-05-09 10:00：任务 8-10 重测通过。使用隔离目录 `.tmp-test-userdata-run/codex-real-39096` 启动真实 Electron，CDP 页面为 `file:///D:/code/tooltemp/tianshe/tianshe/dist/renderer/index.html`，`window.electronAPI=true` 且页面无 ErrorBoundary。真实 CSV `artifacts/codex-fixtures/codex-orders.csv` 导入为 `dataset_1778292004269_d1399366`，查询返回 3 行，列包含 `id/name/amount/_row_id/created_at/updated_at`，删除后列表中不再存在。`examples/minimal-plugin` 以 `devMode=true` 安装成功，plugin id 为 `minimal_plugin`，runtime `active/idle`，reload 成功，uninstall 成功。真实 UI 主导航 `数据表/插件市场/账号中心/设置` 均被 CDP 点击访问；创建 `Codex UI Dataset ...` 后页面能显示该数据表名称，随后删除成功。
- 2026-05-09 10:03：补充验证通过。`npm run build:main` exit 0，两个 preload bundle 产物重新生成；`npm run verify:open-source-boundary` exit 0，验证 1157 个开源版文件；`npm run verify:supply-chain` exit 0，package-lock 来源和许可证验证通过。

### 本轮结论

- 已通过：任务 1-10。
- 已修复：真实 Electron preload 加载失败、示例插件 id 与运行时校验规则冲突。
- 已验证：代码测试、真实运行测试、模拟人工 UI 测试均由 Codex 自动执行完成。
- 后续扩展：再跑 `test:open:full`、打包目录烟测、浏览器自动化本地 fixture、更多数据表筛选/排序/导出路径。

这个方案更简单：Codex 就是测试执行者和判断者，现有测试脚本就是底座。等某条测试链路被反复使用、稳定且价值高，再把它沉淀成普通自动化测试，而不是一开始就写复杂的 LLM 测试平台。

## 第二轮 Codex 自动测试任务

- [x] 11. 跑 `npm run test:open:full`，覆盖完整 Vitest。（已通过；先修复了同步 builder 测试断言）
- [x] 12. 跑发布前静态链路：`verify:supply-chain`、`verify:open-source-boundary`、`sbom`。（已通过）
- [x] 13. 跑 `npm run package:open:dir` 并启动打包目录产物做烟测。（已通过）
- [x] 14. 用真实数据表 API 扩展测试 CSV/XLSX/JSON 导入、查询、重命名、删除。（已通过）
- [x] 15. 用本地 HTML fixture 测浏览器自动化 `snapshot/search/act/wait`。（已通过）
- [x] 16. 做插件负向测试：非法 manifest、非法路径、卸载不存在插件。（已通过）
- [x] 17. 做 HTTP/MCP 负向测试：缺 session、关闭后复用、未知 capability。（已通过）
- [x] 18. 真实 UI 追加测试：删除确认、错误提示、主要页面截图检查。（已通过）

### 第二轮执行记录

- 2026-05-09 10:14：任务 11 首次失败。`npm run test:open:full` 暴露 6 个失败，集中在 `ExplodeBuilder.test.ts` 和 `GroupBuilder.test.ts`：测试使用 `.rejects/.resolves` 断言同步 `SyncQueryBuilder.build()` 的同步异常/同步返回值，导致异常未被 Promise matcher 捕获。
- 2026-05-09 10:19：修复任务 11 暴露的问题。将 `src/core/query-engine/builders/ExplodeBuilder.test.ts` 和 `src/core/query-engine/builders/GroupBuilder.test.ts` 中同步 builder 的断言改为 `expect(() => builder.build(...)).toThrow(...)` 或直接检查同步返回值；随后定向运行 `npx vitest run src/core/query-engine/builders/ExplodeBuilder.test.ts src/core/query-engine/builders/GroupBuilder.test.ts`，2 个文件 / 36 个测试通过。
- 2026-05-09 10:24：任务 11 重测通过。`npm run test:open:full` exit 0；执行过程中仍有若干预期内负向用例日志和 React act warning，但无失败测试。
- 2026-05-09 10:25：任务 12 通过。`npm run verify:supply-chain` exit 0，package-lock 来源和许可证验证通过；`npm run verify:open-source-boundary` exit 0，验证 1157 个开源版文件；`npm run sbom` exit 0，生成 `artifacts/sbom.cdx.json`。
- 2026-05-09 10:27：任务 13 打包通过。`npm run package:open:dir` exit 0，生成 `release-build/win-unpacked/tiansheai-open.exe` 和 `resources/app.asar`。
- 2026-05-09 10:30：任务 13 打包目录烟测通过。首次直接启动 packaged exe 时继承了 shell 中的 `ELECTRON_RUN_AS_NODE=1`，导致自定义参数被 Node 模式识别为 bad option；清理该环境变量后重测通过。`GET /health` 返回 `status=ok`、`mcpEnabled=true`；CDP 验证页面为 `resources/app.asar/dist/renderer/index.html`，`window.electronAPI.getAppInfo()` 可用，返回 `isPackaged=true`、`isFromAsar=true`、Electron `35.7.5`，页面无 ErrorBoundary。
- 2026-05-09 10:32：任务 14 通过。通过真实 Electron renderer preload API 创建 `artifacts/codex-fixtures/codex-orders-extended.csv/json/xlsx` 三种 fixture，分别导入为真实数据集，查询均返回 3 行，列包含 `id/name/amount/region/_row_id/created_at/updated_at`；随后重命名成功，删除成功，删除后 `listDatasets` 中不再存在对应 dataset id。XLSX 导入路径也通过，DuckDB excel extension 可用。
- 2026-05-09 10:38：任务 15 通过。创建本地 HTML fixture `artifacts/codex-fixtures/codex-browser-fixture.html`，用隔离真实 Electron 和 orchestration REST 打开 `file:///.../codex-browser-fixture.html`；`browser_observe` 等到 `Ready` 且标题匹配，`browser_snapshot` 返回交互元素且 viewport `ready`，`browser_search` 精确找到 `Add item` 按钮并返回 `elementRef`，`browser_act` 完成输入 `Codex` 和文本目标点击，`browser_wait_for` 等到 `Clicked 1: Codex`，最终快照确认 DOM 中出现 `Item 1 for Codex`。
- 2026-05-09 10:42：任务 16 通过。创建坏插件 fixture `artifacts/codex-fixtures/plugin-negative/invalid-id-plugin`，并用隔离真实 Electron 调用 orchestration REST 负向验证。不存在本地路径安装返回 HTTP 404 / `NOT_FOUND` / `Path not found`；非法 manifest id `bad-plugin` 安装返回结构化失败，消息包含 `Plugin ID must only contain alphanumeric characters and underscores` 和 manifest 路径；卸载不存在插件 `codex_missing_plugin` 返回 HTTP 404 / `NOT_FOUND` / `Plugin not found`。前后 `plugin_list` 总数均为 0，确认负向测试没有污染插件状态。
- 2026-05-09 10:45：任务 17 通过。隔离真实 Electron 中验证 REST 和 MCP 负向边界：REST `/api/v1/orchestration/invoke` 使用不存在 session 返回 HTTP 404 / `NOT_FOUND`；已创建 session 调用未知 capability 返回 HTTP 404 / `NOT_FOUND`；关闭 session 后复用也返回 HTTP 404 / `NOT_FOUND`。MCP `/mcp` 缺少 `mcp-session-id` 的 `tools/call` 返回 HTTP 400 / JSON-RPC `-32000`；未知工具通过 HTTP 200 的工具级错误表达，`result.isError=true` 且 `structuredContent.error.code=NOT_FOUND`；`DELETE /mcp` 后复用已关闭 session 返回 HTTP 404 / JSON-RPC `-32000` / `Session not found`。
- 2026-05-09 11:01：任务 18 通过。先运行 `npm run build:open` 确保 renderer/main/preload dist 新鲜；随后用隔离真实 Electron + CDP 自动操作 UI。创建 `Codex UI Error ...` 数据表，打开侧边栏“更多操作”并点击 `删除数据表`，确认弹窗包含目标表名、`取消`、`删除`；在确认前用真实 preload API 预先删除后端数据集，再点击 UI `删除`，页面出现删除失败提示并匹配 `删除数据表失败` / `Dataset not found`。截图健康检查通过，产物包括 `artifacts/ui-screenshots/task18-datasets-current.png`、`task18-delete-confirm.png`、`task18-error-toast.png`、`task18-plugin-market.png`、`task18-account-center.png`、`task18-settings.png`；全部为 1366x900 非空截图，页面无 ErrorBoundary/崩溃标记。

## 第三轮 Codex 深度自动测试任务

- [x] 19. 代码级专项深测：架构边界、主进程启动、浏览器池、数据 IPC、DuckDB 集成/导出/预览管线。（已通过）
- [x] 20. 真实 Electron 数据深测：导入、追加、批量更新、列增删改、预览、导出、导出后删除。（已通过）
- [x] 21. 真实 Electron 账号与浏览器配置深测：profile group/profile/account/saved site/tag CRUD 与状态统计。（已通过）
- [x] 22. HTTP/MCP 并发与幂等深测：多 session、并发调用、重复关闭、能力元数据一致性、观测读取。（已通过）
- [x] 23. 打包产物业务烟测：`win-unpacked` 产物内真实 preload 数据链路、插件链路和 UI 无崩溃。（已通过）
- [x] 24. 真实 UI 响应式深测：桌面/平板/手机视口主导航、数据表页面、插件市场、账号中心、设置页截图健康检查。（已通过）
- [x] 25. 插件生命周期深测：重复安装/重载/状态读取/卸载/再安装，确认插件状态不污染。（已通过）
- [x] 26. 收尾污染检查：临时 userData、端口监听、测试 fixture、工作区 diff 与剩余风险。（已通过）

### 第三轮执行记录

- 2026-05-09 11:13：任务 19 通过。运行 `npx vitest run ... --no-file-parallelism` 覆盖架构边界、runtime profile contract、主进程 bootstrap、浏览器池、数据 IPC、DuckDB dataset service、dataset operations/export、preview pipeline consistency；19 个测试文件 / 359 个测试通过。执行中出现预期内的负向用例日志；`dataset-service.integration.test.ts` 结束清理临时 DuckDB 文件时有一次 `EBUSY` cleanup warning，但命令 exit 0，未影响断言。
- 2026-05-09 11:16：任务 20 首次脚本断言失败。真实 Electron 数据链已跑到导入、追加、插入、批量插入、更新、批量更新、列增删改、列显示配置、筛选预览、查询执行、清洗预览；在聚合预览处脚本误判返回结构，真实 API 返回 `sampleRows` / `stats` / `generatedSQL`，而脚本断言使用了不存在的 `rows`。测试数据集已通过 finally 清理，下一步修正断言后重跑完整链路。
- 2026-05-09 11:27：任务 20 重跑进展。修正聚合预览断言后，真实 Electron preload 链路通过导入、追加、插入、批量插入、更新、批量更新、列增删改、列显示配置、筛选预览、`executeQuery`、清洗预览、聚合预览、CSV 导出和 CSV 内容校验。随后 CDP 在下一次 `queryDataset` 返回时出现 `Cannot find default execution context`，主进程日志显示该查询已完成；判断为调试连接上下文抖动，后续将导出后删除拆成更小脚本单独验证。
- 2026-05-09 11:43：任务 20 通过。补跑独立导出后删除专项：真实 Electron preload 导入 4 行 CSV，选中 2 个 `_row_id` 执行 `exportDataset(... postExportAction: 'delete')` 到 JSON，返回 `totalRows=2`、`deletedRows=2`，导出文件含 2 行，随后 `queryDataset` 确认数据集剩余 2 行。任务 20 覆盖项合并判定通过：导入、追加、插入、批量插入、更新、批量更新、列增删改、列显示配置、筛选/清洗/聚合预览、查询执行、CSV 导出、JSON 导出后删除均由真实 Electron preload API 完成。
- 2026-05-09 12:16：任务 21 通过。使用 `release-build/win-unpacked/tiansheai-open.exe` 打包产物和隔离 userData，经 CDP 调用真实 preload API，确认 `getAppInfo().info.isPackaged=true`、`isFromAsar=true`。完成 profile group 创建/更新/删除，profile 创建/更新/状态 active/idle/可用性/过滤列表/删除，browserPool getConfig/applyPreset('light')/setConfig/resetConfig，saved site 创建/更新/getByName/incrementUsage/删除，tag 创建/更新/exists/删除，account 创建/revealSecret/update/listByProfile/listByPlatform/delete。额外验证 saved site 在被账号引用时删除被阻止，返回 `平台仍被 1 个账号引用，请先处理相关账号`；删除账号后平台可删除。最终 profile/account 清理检查通过。
- 2026-05-09 12:42：任务 22 通过。使用 `release-build/win-unpacked/tiansheai-open.exe` 打包产物、隔离 userData 和随机 HTTP 端口启动真实 HTTP/MCP 服务；`GET /api/v1/orchestration/capabilities` 返回 29 个公开能力，且与两个 MCP session 的 `tools/list` 工具名完全一致，未泄漏 `browser_get_url` 等内部能力。先验证同 default profile 并发创建 REST session 会被 live-session lease 正常限制并在 30 秒后返回 HTTP 408/TIMEOUT；随后通过 `profile_create` 创建 3 个临时 electron profile，分别并发创建 3 个 REST session，并与 2 个 MCP session 同时调用 `system_get_health` / `observation_search_recent_failures`，全部返回成功。幂等链路验证：同一 `Idempotency-Key` 首次 `stored`、第二次 `replayed`、同 key 不同参数返回 HTTP 409 / `REQUEST_FAILED`。关闭 REST session 后复用返回 HTTP 404 / `NOT_FOUND`；`DELETE /mcp` 后复用 MCP session 返回 HTTP 404 / `Session not found`。测试最后删除临时 profile、关闭 session 并移除隔离 userData。
- 2026-05-09 13:23：任务 23 首次深测暴露真实打包问题。`win-unpacked` 中 UI 和 `getAppInfo().info.isPackaged/isFromAsar` 正常，但 packaged preload 调 `duckdb:import-dataset-file` 失败：先是 import worker 位于 `app.asar.unpacked/dist/main/duckdb` 后无法解析相对依赖 `../../core/logger`；补齐解包依赖后又发现 worker 线程误判为 development，导致 `core/logger` 试图加载未解包的 `pino-pretty` transport，报 `unable to determine transport target for "pino-pretty"`。
- 2026-05-09 13:26：完成任务 23 阻断修复并重打包。`electron-builder.yml` 的 `asarUnpack` 补入 import worker 运行所需的相对依赖：`dist/core/logger.js`、`dist/constants/runtime-config.js`、`dist/main/ipc-utils.js`、`dist/main/ipc-handlers/errors.js`、`dist/types/error-codes.js`、`dist/utils/data-paths.js`、`dist/utils/error-message.js`、`dist/utils/redaction.js`，以及 `pino` 及其运行依赖。`src/constants/runtime-config.ts` 增强 packaged worker 模式检测：当 `process.resourcesPath` 指向 resources 目录且存在 `app.asar` 时识别为 production，避免 worker 中启用 dev-only `pino-pretty`。随后 `npm run package:open:dir` exit 0。
- 2026-05-09 13:28：任务 23 通过。使用重打包后的 `release-build/win-unpacked/tiansheai-open.exe`、隔离 userData 和 CDP 控制真实 packaged 窗口：首屏 `file:///.../resources/app.asar/dist/renderer/index.html`，`electronAPI` 注入正常，`getAppInfo()` 返回 `isPackaged=true`、`isFromAsar=true`、Electron `35.7.5`，截图 `artifacts/ui-screenshots/task23-packaged-smoke-1778304163417.png` 为 1400x900 非空且无崩溃标记。preload 数据链路导入 3 行 CSV、查询、重命名、列表校验、删除全部成功；packaged 默认不显示开发选项，测试在隔离配置中临时设置 `httpApiConfig.enableDevMode=true` 后安装 `examples/minimal-plugin`，完成 `import/getRuntimeStatus/reload/listRuntimeStatuses/uninstall`，最后恢复 HTTP 配置并删除测试数据集、移除隔离 userData。
- 2026-05-09 13:35：任务 24 通过。使用重打包后的 `release-build/win-unpacked/tiansheai-open.exe`、隔离 userData 和 CDP `Emulation.setDeviceMetricsOverride` 自动模拟 1366x900 桌面、900x700 平板、390x844 手机视口；逐一点击真实主导航 `数据表/插件市场/账号中心/设置`，保存 12 张截图到 `artifacts/ui-screenshots/task24-*-1778304412021.png`，并生成 `artifacts/ui-screenshots/task24-responsive-report-1778304412021.json`。所有页面 body 非空，截图非空，`consoleErrorCount=0`，无 ErrorBoundary/崩溃标记，`maxOverflowX=0`，`maxClippedControls=0`；隔离 userData 已删除。启动 stderr 中出现一次 `resources/app-update.yml` 缺失日志，未影响 UI 渲染，作为打包目录更新配置的非阻断风险留到收尾项核对。
- 2026-05-09 13:31：任务 25 通过。使用真实 packaged 应用、隔离 userData 和 CDP 调用 preload `jsPlugin` API，临时开启隔离配置中的 `httpApiConfig.enableDevMode=true` 后，对 `examples/minimal-plugin` / `minimal_plugin` 执行完整生命周期：安装、详情读取、运行状态读取、`listRuntimeStatuses`、插件配置 `setConfig/getConfig` 往返、工具栏按钮读取、热重载状态读取、禁用、启用、连续 3 次 `reload`、重复安装并确认列表中仍只有 1 个同 id 插件、卸载、卸载后状态读取返回结构化 `PLUGIN_NOT_FOUND`、再安装、最终卸载。报告写入 `artifacts/plugin-lifecycle/task25-plugin-lifecycle-1778304684767.json`：`consoleErrorCount=0`，事件计数为 state 7 / runtime 32 / reload 3 / notification 7，HTTP 配置已恢复，隔离 userData 已删除，最终 `plugin_list` 不含 `minimal_plugin`。
- 2026-05-09 13:47：任务 26 通过。收尾检查确认本轮 `task24-*`、`task25-*`、`task26-*` 隔离 userData 均已删除，未发现 `tiansheai-open.exe` 测试进程残留；39080-64050 范围内监听端口对应系统、VS Code、Docker、Apifox 等既有进程，不属于测试应用残留。`git diff --check` 无空白错误，仅有 Windows 行尾提示；工作区中 `tianshe-review/runtime-profile-contract-baseline.md` 和 `tianshe-review/runtime-profile-error-governance-plan.md` 的删除是既有脏改，未处理。收尾过程中将任务 24 发现的 packaged 自动更新噪声修复：`UpdateManager` 现在检测 `app-update.yml`/`dev-app-update.yml` 是否存在，缺失时注册 updater IPC 但跳过自动更新检查，避免 10 秒后产生 `app-update.yml` / `ENOENT` 错误；新增 `src/main/updater.test.ts` 覆盖缺失配置和存在配置两条路径。最终验证：`npx vitest run src/main/updater.test.ts src/constants/runtime-config.test.ts` 2 文件 / 7 测试通过，`npm run typecheck` 通过，`npm run lint` 0 error / 154 既有 warning，`npm run verify:open-source-boundary` 通过（1158 文件），`npm run build:open` 通过，`npm run package:open:dir` 通过，packaged exe 启动等待 13 秒后未再出现更新配置缺失错误。

## 第四轮：`npm run dev` 完整 Electron 模拟人工测试

- [x] 27. 让 `npm run dev` 支持隔离 userData、HTTP/MCP 和 CDP 调试端口，用于连接真实 Electron 主窗口。（已通过）
- [x] 28. 修复 dev watch 覆盖 preload bundle 导致 `window.electronAPI` 缺失的问题。（已通过）
- [x] 29. 使用完整 `npm run dev` 启动的真实 Electron 窗口执行 CDP 模拟人工测试。（已通过）

### 第四轮执行记录

- 2026-05-09 14:10：补齐 dev 自动化入口。`scripts/launch-electron.js` 新增 `AIRPA_E2E_CDP_PORT`、`AIRPA_ENABLE_HTTP`、`AIRPA_ENABLE_MCP` 到应用启动参数的映射；`src/constants/runtime-config.ts` 新增 `--airpa-e2e-cdp-port` 读取逻辑。验证：`npx vitest run scripts/launch-electron.test.js src/constants/runtime-config.test.ts` 2 文件 / 15 测试通过，`npm run typecheck` 通过，`npm run test:open` 8 文件 / 26 测试通过。
- 2026-05-09 14:15：首次按方案启动 `npm run dev`，真实 Electron、HTTP 和 CDP 均就绪，但 CDP 检查发现主窗口 `window.electronAPI=false`，页面显示 `客户端桥接未加载`。`startup-diagnostic.log` 记录 `Unable to load preload script: dist/preload/index.js` 和 `Error: module not found: ./api/account`。根因：`predev` 先生成了 bundle preload，但 `run-dev-base` 里的 `tsc --watch` 首次编译又把 `dist/preload/index.js` 覆盖成未 bundle 版本；Electron sandbox preload 无法加载这些相对模块。
- 2026-05-09 14:18：修复 dev preload 链路。`scripts/build-main-with-stamp.js` 导出 `bundlePreloadEntries()`，`scripts/run-dev-base.js` 在 main watch 首次成功后、启动 Electron 前重新 bundle `src/preload/index.ts` 和 `src/preload/webcontents-view.ts`。验证：`npx vitest run scripts/launch-electron.test.js src/constants/runtime-config.test.ts src/main/main-build-freshness.test.ts` 3 文件 / 18 测试通过，`npm run typecheck` 通过，`npm run build:main` 通过。
- 2026-05-09 14:20：重启 `npm run dev` 后真实 Electron UI 自动化通过。使用隔离 userData `.tmp-test-userdata-run/codex-dev-e2e-49334`、CDP 端口 `49333`、HTTP 端口 `49334`，原生 CDP 控制标题为 `TiansheAI` 的主窗口。验证 `window.electronAPI=true`，`getAppInfo().info.isPackaged=false`，无 ErrorBoundary；真实点击主导航 `数据表/插件市场/账号中心/设置`；通过 preload 创建并删除数据表 `dataset_1778307704192_ae40569e`；模拟 1366x900、900x700、390x844 三种视口；生成 9 张非空截图和报告 `artifacts/dev-e2e/dev-e2e-report-1778307699427.json`，`consoleErrorCount=0`。该轮 `/health` 为 `success=true` 但 `data.status=degraded`，原因是 dev watch 编译后 main build stamp 未刷新。
- 2026-05-09 14:26：修复 dev build stamp 健康状态。`scripts/run-dev-base.js` 在 bundle preload 后调用 `writeMainBuildStamp()`，避免 `/health` 因 `build_stamp_out_of_sync` 降级。验证：`npx vitest run scripts/launch-electron.test.js src/constants/runtime-config.test.ts src/main/main-build-freshness.test.ts` 3 文件 / 18 测试通过，`npm run typecheck` 通过，`npm run test:open` 8 文件 / 26 测试通过；重新启动完整 `npm run dev` 后 `/health` 返回 `data.status=ok`。
- 2026-05-09 14:26：最终真实客户端模拟人工测试通过。使用完整 `npm run dev` 启动真实 Electron 软件，CDP 控制真实主窗口完成启动健康、preload、主导航、数据表创建/删除、响应式截图检查。最终报告 `artifacts/dev-e2e/dev-e2e-report-1778307920538.json`，截图 9 张，`consoleErrorCount=0`，测试数据表 `dataset_1778307925019_37b3ede3` 已删除。
