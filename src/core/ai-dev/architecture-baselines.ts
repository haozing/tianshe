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

export const DIRECT_CONSOLE_CALL_BASELINE: Record<string, number> = {
  'src/core/ai-dev/types.ts': 8,
  'src/core/ai-service/openai.ts': 10,
  'src/core/coordinate/context.ts': 1,
  'src/core/ffi/callback.ts': 1,
  'src/core/ffi/ffi-service.ts': 14,
  'src/core/ffi/library.ts': 5,
  'src/core/js-plugin/helpers.ts': 1,
  'src/core/js-plugin/loader.ts': 12,
  'src/core/js-plugin/namespaces/advanced.ts': 1,
  'src/core/js-plugin/namespaces/button.ts': 8,
  'src/core/js-plugin/namespaces/ffi.ts': 1,
  'src/core/js-plugin/namespaces/utils/interval.ts': 6,
  'src/core/js-plugin/namespaces/window.ts': 12,
  'src/core/js-plugin/ui-extension-manager.ts': 1,
  'src/core/layout/layout-calculator.ts': 2,
  'src/core/observability/observation-service.ts': 2,
  'src/core/query-engine/builders/DedupeBuilder.ts': 1,
  'src/core/query-engine/builders/SampleBuilder.ts': 6,
  'src/core/query-engine/services/data-writeback-service.ts': 11,
  'src/core/query-engine/services/dataset-merger.ts': 7,
  'src/core/query-engine/services/pivot-service.ts': 7,
  'src/core/system-automation/cv/opencvjs-worker.ts': 2,
  'src/main/app-shell-config.ts': 1,
  'src/main/download.ts': 10,
  'src/main/duckdb/dataset-export-plan-builder.ts': 4,
  'src/main/duckdb/dataset-export-service.ts': 6,
  'src/main/duckdb/dataset-folder-service.ts': 13,
  'src/main/duckdb/dataset-group-tab-workflow-service.ts': 1,
  'src/main/duckdb/dataset-import-service.ts': 16,
  'src/main/duckdb/dataset-service.ts': 3,
  'src/main/duckdb/dependency-manager.ts': 1,
  'src/main/duckdb/duckdb-service-dataset-facade.ts': 6,
  'src/main/duckdb/duckdb-service-query-facade.ts': 5,
  'src/main/duckdb/import-worker-csv.ts': 8,
  'src/main/duckdb/import-worker-schema-analysis.ts': 2,
  'src/main/duckdb/import-worker.ts': 3,
  'src/main/duckdb/log-service.ts': 2,
  'src/main/duckdb/plugin-table-bootstrap.ts': 5,
  'src/main/duckdb/scheduled-task-service.ts': 1,
  'src/main/duckdb/sql-template.ts': 1,
  'src/main/duckdb/sql-validator.ts': 2,
  'src/main/duckdb/type-analyzer.ts': 12,
  'src/main/duckdb/validation-engine.ts': 8,
  'src/main/internal-browser-devtools.ts': 1,
  'src/main/ipc.ts': 1,
  'src/main/log-storage-service.ts': 1,
  'src/main/profile/browser-pool-integration-business-shared.ts': 3,
  'src/main/profile/browser-pool-integration-extension.ts': 2,
  'src/main/profile/browser-pool-integration-fingerprint-shared.ts': 1,
  'src/main/profile/browser-pool-integration-smoke-shared.ts': 2,
  'src/main/profile/browser-pool-integration.ts': 3,
  'src/preload/index.ts': 1,
  'src/renderer/src/App.tsx': 5,
  'src/renderer/src/components/AccountCenter/ProfileFormDialog.tsx': 1,
  'src/renderer/src/components/AccountCenter/ProfileList.tsx': 3,
  'src/renderer/src/components/ActivityBar/index.tsx': 7,
  'src/renderer/src/components/DatasetsPage/CustomPageViewer.tsx': 2,
  'src/renderer/src/components/DatasetsPage/DatasetTable.tsx': 5,
  'src/renderer/src/components/DatasetsPage/ExportDialog.tsx': 1,
  'src/renderer/src/components/DatasetsPage/SaveQueryTemplateDialog.tsx': 1,
  'src/renderer/src/components/DatasetsPage/TanStackDataTable/ToolbarButton.tsx': 1,
  'src/renderer/src/components/DatasetsPage/TanStackDataTable/columns.tsx': 1,
  'src/renderer/src/components/DatasetsPage/TanStackDataTable/index.tsx': 4,
  'src/renderer/src/components/DatasetsPage/fields/AttachmentField.tsx': 7,
  'src/renderer/src/components/DatasetsPage/index.tsx': 26,
  'src/renderer/src/components/DatasetsPage/panels/CleanPanel.tsx': 1,
  'src/renderer/src/components/DatasetsPage/panels/ComputePanel.tsx': 1,
  'src/renderer/src/components/DatasetsPage/panels/DedupePanel.tsx': 3,
  'src/renderer/src/components/DatasetsPage/panels/DictionarySelector.tsx': 3,
  'src/renderer/src/components/DatasetsPage/panels/LookupPanel.tsx': 1,
  'src/renderer/src/components/DatasetsPage/panels/SamplePanel.tsx': 1,
  'src/renderer/src/components/DatasetsPage/useDatasetsWorkspaceController.ts': 3,
  'src/renderer/src/components/ErrorBoundary.tsx': 1,
  'src/renderer/src/components/PluginMarket/PluginConfigDialog.tsx': 4,
  'src/renderer/src/components/PluginMarket/ResourceMonitor.tsx': 3,
  'src/renderer/src/components/PluginMarket/UninstallPluginDialog.tsx': 3,
  'src/renderer/src/components/UpdateNotification/index.tsx': 1,
  'src/renderer/src/components/ui/ConfirmDialog.tsx': 1,
  'src/renderer/src/hooks/useCustomPages.ts': 6,
  'src/renderer/src/hooks/useJSPluginUIExtensions.ts': 2,
  'src/renderer/src/services/datasets/workspaceCategoryService.ts': 1,
  'src/renderer/src/stores/accountStore.ts': 9,
  'src/renderer/src/stores/cloudAuthStore.ts': 2,
  'src/renderer/src/stores/dataset/coreSlice.ts': 4,
  'src/renderer/src/stores/dataset/importSlice.ts': 1,
  'src/renderer/src/stores/dataset/queryRuntimeSlice.ts': 1,
  'src/renderer/src/stores/dataset/queryTemplateSlice.ts': 8,
  'src/renderer/src/stores/dataset/workspaceSlice.ts': 1,
  'src/renderer/src/stores/executionStore.ts': 2,
  'src/renderer/src/stores/pluginStore.ts': 2,
  'src/renderer/src/stores/profileStore.ts': 1,
  'src/renderer/src/stores/schedulerStore.ts': 3,
};
