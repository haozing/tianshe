export interface ArchitectureSizeRepairTarget {
  owner: string;
  target: string;
  exitCondition: string;
}

export const ARCHITECTURE_SIZE_NOTES: Record<string, string> = {
  'src/constants/fingerprint-defaults.ts':
    'Existing oversized static fingerprint defaults; split by data family when fingerprint presets are next touched.',
  'src/core/ai-dev/capabilities/browser-catalog.ts':
    'Existing oversized AI browser catalog; split by browser capability family during catalog modularization.',
  'src/core/ai-dev/capabilities/dataset-catalog.ts':
    'Existing oversized AI dataset catalog; split dataset read, mutation, import/export, and workspace capability groups during catalog modularization.',
  'src/core/ai-dev/capabilities/browser/handlers/action-verification.ts':
    'Existing oversized action verification handler; split by verification strategy during browser capability cleanup.',
  'src/core/ai-dev/capabilities/plugin-catalog.ts':
    'Existing oversized plugin catalog; split read/write/install capability groups during AI catalog cleanup.',
  'src/core/ai-dev/capabilities/profile-catalog.ts':
    'Existing oversized profile catalog; split profile lifecycle and runtime diagnostics during AI catalog cleanup.',
  'src/core/ai-dev/capabilities/session-catalog.ts':
    'Existing oversized session catalog; split session lifecycle, queue, and browser binding capability groups.',
  'src/core/ai-dev/orchestration/capability-registry.test.ts':
    'Existing oversized orchestration registry contract test; split capability families when adding new registry cases.',
  'src/core/ai-dev/orchestration/capability-registry.ts':
    'Existing oversized orchestration registry; split registry metadata and execution adapters during orchestration cleanup.',
  'src/core/ai-service/openai.ts':
    'Existing oversized OpenAI adapter; split request shaping, retry handling, and response parsing during AI service cleanup.',
  'src/core/browser-automation/integrated-browser.ts':
    'Existing oversized browser facade; ongoing plan extracts role capabilities and shared browser operation helpers.',
  'src/core/browser-extension/extension-browser.ts':
    'Existing oversized extension browser facade; ongoing plan extracts role capabilities and shared browser operation helpers.',
  'src/core/browser-pool/global-pool.ts':
    'Existing oversized global browser pool; split lifecycle, acquire queue, and diagnostics during pool refactor.',
  'src/core/browser-pool/pool-manager.ts':
    'Existing oversized browser pool manager; split acquire, release, profile state sync, and event coordination during pool lifecycle refactor.',
  'src/core/browser-ruyi/ruyi-browser.ts':
    'Existing oversized Ruyi browser facade; ongoing plan extracts role capabilities and shared browser operation helpers.',
  'src/core/js-plugin/manager.test.ts':
    'Existing oversized plugin manager test; split lifecycle, install, and helper contracts when expanding coverage.',
  'src/core/js-plugin/manager.ts':
    'Existing oversized plugin manager; split lifecycle, install/uninstall orchestration, and execution coordination adapters.',
  'src/core/js-plugin/namespaces/database.ts':
    'Existing oversized plugin database namespace; split import/export helpers and SQL execution adapters during plugin API cleanup.',
  'src/core/js-plugin/namespaces/profile.ts':
    'Existing oversized plugin profile namespace; split launch, pool stats, profile CRUD, and lease operations.',
  'src/core/js-plugin/plugin-loader.test.ts':
    'Existing oversized plugin loader test; split manifest, runtime, and dependency loader contracts.',
  'src/core/js-plugin/plugin-installation-coordinator.ts':
    'Existing oversized plugin installation coordinator; split package validation, unpack, persistence, and rollback flows.',
  'src/core/js-plugin/registry.ts':
    'Existing oversized plugin registry; split discovery, persistence, and dependency index responsibilities.',
  'src/core/logger.test.ts':
    'Existing oversized logger contract test; split sink, formatting, and redaction scenarios when touched.',
  'src/core/query-engine/builders/CleanBuilder.test.ts':
    'Existing oversized query builder test; split clean operation scenarios by transform family.',
  'src/core/query-engine/QueryEngine.ts':
    'Existing oversized query engine facade; ongoing plan moves builder execution into pipeline steps.',
  'src/core/query-engine/services/PreviewService.ts':
    'Existing oversized preview service; split preview operation families during query pipeline cleanup.',
  'src/core/query-engine/validators/ConfigValidator.ts':
    'Existing oversized config validator; split validation by query feature family.',
  'src/core/stealth/fingerprint-manager.test.ts':
    'Existing oversized fingerprint manager test; split fingerprint generation, cache, and override contracts.',
  'src/core/stealth/shared-scripts.test.ts':
    'Existing oversized stealth shared scripts test; split browser surface scenarios by script family.',
  'src/core/task-manager/pipeline/pipeline.test.ts':
    'Existing oversized task pipeline test; split queue, lifecycle, and retry contracts.',
  'src/core/task-manager/queue.test.ts':
    'Existing oversized task queue test; split queue ordering, retry, and cancellation scenarios.',
  'src/main/duckdb/__tests__/dataset-operations.integration.test.ts':
    'Existing oversized dataset integration test; split import, schema, row, and query operation suites.',
  'src/main/duckdb/__tests__/dataset-service.integration.test.ts':
    'Existing oversized dataset service integration test; split table lifecycle and query scenarios.',
  'src/main/duckdb/dataset-schema-service.ts':
    'Existing oversized dataset schema service; split column metadata, schema mutation, and validation paths.',
  'src/main/duckdb/dataset-service.ts':
    'Existing oversized dataset facade; ongoing plan moves storage/query/schema/tab responsibilities to subservices.',
  'src/main/duckdb/profile-service.ts':
    'Existing oversized profile service; split profile CRUD, pool metadata, and extension association logic.',
  'src/main/duckdb/utils.test.ts':
    'Existing oversized DuckDB utils test; split SQL identifier, statement, and validation contracts.',
  'src/main/ipc-handlers/dataset-handler.test.ts':
    'Existing oversized dataset IPC test; split dataset CRUD, query, schema, and import IPC contracts.',
  'src/main/ipc-handlers/file-handler.test.ts':
    'Existing oversized file IPC test; split dialog, storage, and import route contracts.',
  'src/main/ipc-handlers/profile-ipc-handler.ts':
    'Existing oversized profile IPC handler; split profile CRUD, group, and browser pool route factories during IPC cleanup.',
  'src/main/ipc-handlers/system-handler.ts':
    'Existing oversized system IPC handler; split logs, diagnostics, downloads, and shell routes during IPC cleanup.',
  'src/main/ipc-handlers/view-handler.test.ts':
    'Existing oversized view IPC test; split view lifecycle, bounds, cloud auth, and dock contracts.',
  'src/main/mcp-http-session-runtime.ts':
    'Existing oversized MCP session runtime; session state has been grouped and further route split remains planned.',
  'src/main/scheduler/scheduler-service.ts':
    'Existing oversized scheduler service; split restore, timer, execution, and lifecycle suppression responsibilities.',
  'src/main/scheduler/scheduler-service.test.ts':
    'Scheduler failure-path coverage now exceeds the size guard; split creation, execution, retry, and recovery scenarios by behavior family.',
  'src/main/mcp-server-http.auth-invoke.test.ts':
    'Focused split from former MCP giant test; shared HTTP/MCP test helpers live in src/main/__tests__/mcp-server-http-test-utils.ts and remaining scenarios should keep moving by route family.',
  'src/main/mcp-server-http.browser-binding.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/mcp-server-http.mcp-surface.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/mcp-server-http.orchestration-routes.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/mcp-server-http.transport-session.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/profile/browser-pool-integration-cloak.ts':
    'New Cloak Playwright adapter owns runtime launch plus advanced Playwright role bridges; split download, dialog, interception, and event helpers after real-browser smoke tests stabilize.',
  'src/main/profile/extension-packages-manager.ts':
    'Existing oversized extension packages manager; split package persistence, binding, import/export, and filesystem cleanup flows.',
  'src/main/profile/ruyi-firefox-client.test.ts':
    'Existing oversized Ruyi Firefox client test; split launch, connection, and protocol contracts.',
  'src/main/profile/ruyi-firefox-client.ts':
    'Existing oversized Ruyi Firefox client; split launch process, protocol client, and browser state adapter.',
  'src/main/sync/sync-local-apply-service.ts':
    'Existing oversized sync apply service; split account/site/tag/profile apply pipelines.',
  'src/renderer/src/components/AccountCenter/ExtensionPackagesPanel.tsx':
    'Existing oversized account-center panel; split package list, actions, and detail dialogs.',
  'src/renderer/src/components/AccountCenter/ProfileFormDialog.tsx':
    'Existing oversized profile form dialog; split form schema, fingerprint, extension, and proxy sections.',
  'src/renderer/src/components/DatasetsPage/__tests__/DatasetsPage.crud-isolation.test.tsx':
    'Existing oversized dataset page test; split CRUD isolation scenarios by workflow.',
  'src/renderer/src/components/DatasetsPage/__tests__/DatasetsPage.tab-flow.test.tsx':
    'Existing oversized dataset page test; split tab flow, selection, and persistence scenarios.',
  'src/renderer/src/components/DatasetsPage/AddColumnDialog.tsx':
    'Existing oversized add-column dialog; split field editors and validation helpers.',
  'src/renderer/src/components/DatasetsPage/DatasetTable.tsx':
    'Existing oversized dataset table; split toolbar, data grid, selection, and pagination views.',
  'src/renderer/src/components/DatasetsPage/index.tsx':
    'Existing oversized datasets page; ongoing store split enables future view decomposition.',
  'src/renderer/src/components/DatasetsPage/panels/CleanPanel.tsx':
    'Existing oversized clean panel; split operation forms and preview result views.',
  'src/renderer/src/components/DatasetsPage/TanStackDataTable/columns.tsx':
    'Existing oversized table column definitions; split action, display, and editor column groups.',
  'src/renderer/src/components/DatasetsPage/TanStackDataTable/index.tsx':
    'Existing oversized TanStack table wrapper; split virtual table, controls, and row operations.',
  'src/renderer/src/components/PluginMarket/PluginMarket.tsx':
    'Existing oversized plugin market page; split catalog, install flow, and package detail panels.',
  'src/renderer/src/stores/__tests__/datasetStore.test.ts':
    'Legacy dataset store compatibility suite; kept under 1500 lines by split contract.',
  'src/types/browser-interface.ts':
    'Existing oversized browser interface compatibility surface; role interfaces are being split out incrementally.',
  'src/types/js-plugin.d.ts':
    'Existing oversized plugin declaration file; split namespace declarations when plugin API versioning lands.',
};

const createSizeRepairTargets = (
  owner: string,
  target: string,
  exitCondition: string,
  filePaths: readonly string[]
): Record<string, ArchitectureSizeRepairTarget> =>
  Object.fromEntries(
    filePaths.map((filePath) => [
      filePath,
      {
        owner,
        target,
        exitCondition,
      },
    ])
  ) as Record<string, ArchitectureSizeRepairTarget>;

export const ARCHITECTURE_SIZE_REPAIR_TARGETS: Record<string, ArchitectureSizeRepairTarget> = {
  ...createSizeRepairTargets(
    'core-foundations',
    'Split shared compatibility surfaces into focused domain modules.',
    'Each shared compatibility surface stays below 900 lines and owns one domain.',
    [
      'src/constants/fingerprint-defaults.ts',
      'src/types/browser-interface.ts',
      'src/types/js-plugin.d.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'ai-dev-catalogs',
    'Split AI-dev capability families and orchestration registry by capability group.',
    'Each catalog or registry file stays below 900 lines and capability groups live in dedicated modules.',
    [
      'src/core/ai-dev/capabilities/browser-catalog.ts',
      'src/core/ai-dev/capabilities/dataset-catalog.ts',
      'src/core/ai-dev/capabilities/browser/handlers/action-verification.ts',
      'src/core/ai-dev/capabilities/plugin-catalog.ts',
      'src/core/ai-dev/capabilities/profile-catalog.ts',
      'src/core/ai-dev/capabilities/session-catalog.ts',
      'src/core/ai-dev/orchestration/capability-registry.ts',
      'src/core/ai-dev/orchestration/capability-registry.test.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'browser-runtime',
    'Split browser facades and pool coordination by lifecycle responsibility.',
    'Acquisition, release, lifecycle, and diagnostics live in separate modules.',
    [
      'src/core/browser-automation/integrated-browser.ts',
      'src/core/browser-extension/extension-browser.ts',
      'src/core/browser-pool/global-pool.ts',
      'src/core/browser-pool/pool-manager.ts',
      'src/core/browser-ruyi/ruyi-browser.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'js-plugin-runtime',
    'Split plugin lifecycle, registry, and namespace responsibilities.',
    'Manager and namespace files stay below 900 lines and tests are split by concern.',
    [
      'src/core/js-plugin/manager.test.ts',
      'src/core/js-plugin/manager.ts',
      'src/core/js-plugin/namespaces/database.ts',
      'src/core/js-plugin/plugin-loader.test.ts',
      'src/core/js-plugin/plugin-installation-coordinator.ts',
      'src/core/js-plugin/registry.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'query-stealth',
    'Split AI service, query preview, logger, and stealth responsibilities.',
    'Each service or test family stays below 900 lines and preview/validation logic has focused modules.',
    [
      'src/core/ai-service/openai.ts',
      'src/core/logger.test.ts',
      'src/core/query-engine/builders/CleanBuilder.test.ts',
      'src/core/query-engine/services/PreviewService.ts',
      'src/core/query-engine/validators/ConfigValidator.ts',
      'src/core/stealth/fingerprint-manager.test.ts',
      'src/core/stealth/shared-scripts.test.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'task-manager',
    'Split scheduler and queue test suites by behavior family.',
    'Each suite remains below 900 lines with one workflow focus.',
    [
      'src/core/task-manager/pipeline/pipeline.test.ts',
      'src/core/task-manager/queue.test.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'duckdb-core',
    'Split DuckDB facade/service responsibilities and dataset test suites.',
    'Facade files stay below 900 lines and dataset/service logic is broken into subservices.',
    [
      'src/main/duckdb/__tests__/dataset-operations.integration.test.ts',
      'src/main/duckdb/__tests__/dataset-service.integration.test.ts',
      'src/main/duckdb/dataset-schema-service.ts',
      'src/main/duckdb/dataset-service.ts',
      'src/main/duckdb/utils.test.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'main-runtime',
    'Split main-process composition, profile runtime, and window management.',
    'Index/bootstrap code only wires services and runtime bridges are split by lifecycle, events, and domain capability.',
    [
      'src/main/profile/browser-pool-integration-cloak.ts',
      'src/main/profile/extension-packages-manager.ts',
      'src/main/profile/ruyi-firefox-client.test.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'ipc-mcp',
    'Split IPC and MCP surfaces by route family and transport concern.',
    'Each handler or test family stays below 900 lines and route metadata is declared once.',
    [
      'src/main/ipc-handlers/dataset-handler.test.ts',
      'src/main/ipc-handlers/file-handler.test.ts',
      'src/main/ipc-handlers/profile-ipc-handler.ts',
      'src/main/ipc-handlers/system-handler.ts',
      'src/main/ipc-handlers/view-handler.test.ts',
      'src/main/mcp-http-session-runtime.ts',
      'src/main/mcp-server-http.auth-invoke.test.ts',
      'src/main/mcp-server-http.browser-binding.test.ts',
      'src/main/mcp-server-http.mcp-surface.test.ts',
      'src/main/mcp-server-http.orchestration-routes.test.ts',
      'src/main/mcp-server-http.transport-session.test.ts',
      'src/main/scheduler/scheduler-service.ts',
      'src/main/scheduler/scheduler-service.test.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'renderer-datasets',
    'Split dataset and account UI into page, table, dialog, and panel modules.',
    'Page shells stay under 900 lines and pure forwarding layers are removed.',
    [
      'src/renderer/src/components/AccountCenter/ExtensionPackagesPanel.tsx',
      'src/renderer/src/components/AccountCenter/ProfileFormDialog.tsx',
      'src/renderer/src/components/DatasetsPage/__tests__/DatasetsPage.crud-isolation.test.tsx',
      'src/renderer/src/components/DatasetsPage/__tests__/DatasetsPage.tab-flow.test.tsx',
      'src/renderer/src/components/DatasetsPage/AddColumnDialog.tsx',
      'src/renderer/src/components/DatasetsPage/DatasetTable.tsx',
      'src/renderer/src/components/DatasetsPage/index.tsx',
      'src/renderer/src/components/DatasetsPage/panels/CleanPanel.tsx',
      'src/renderer/src/components/DatasetsPage/TanStackDataTable/columns.tsx',
      'src/renderer/src/components/DatasetsPage/TanStackDataTable/index.tsx',
      'src/renderer/src/components/PluginMarket/PluginMarket.tsx',
      'src/renderer/src/stores/__tests__/datasetStore.test.ts',
    ]
  ),
};

export const DIRECT_CONSOLE_CALL_BASELINE: Record<string, number> = {};
