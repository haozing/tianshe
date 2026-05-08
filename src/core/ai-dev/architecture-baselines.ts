export interface ArchitectureSizeRepairTarget {
  owner: string;
  target: string;
  exitCondition: string;
}

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
      'src/core/browser-ruyi/ruyi-browser.ts',
    ]
  ),
  ...createSizeRepairTargets(
    'js-plugin-runtime',
    'Split plugin lifecycle, registry, and namespace responsibilities.',
    'Manager and namespace files stay below 900 lines and tests are split by concern.',
    [
      'src/core/js-plugin/manager.test.ts',
      'src/core/js-plugin/namespaces/database.ts',
      'src/core/js-plugin/plugin-loader.test.ts',
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
    'Index/bootstrap code only wires services and each runtime file has a single owner.',
    [
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
