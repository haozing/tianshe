import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import { handleIPCError } from '../../ipc-utils';
import type { JSPluginManager } from '../../../core/js-plugin/manager';
import type { ButtonExecutor } from '../../../core/js-plugin/button-executor';

type PluginRouteHandler<T extends any[]> = (
  event: IpcMainInvokeEvent,
  ...args: T
) => Promise<any>;

export interface JSPluginUIExtensionRouteDeps {
  pluginManager: JSPluginManager;
  duckdb: DuckDBService;
  buttonExecutor: ButtonExecutor;
  ensurePluginLoaded: (pluginId: string) => Promise<void>;
}

export function registerJSPluginUIExtensionRoutes(deps: JSPluginUIExtensionRouteDeps): void {
  registerExecuteCommand(deps);
  registerGetToolbarButtons(deps);
  registerExecuteActionColumn(deps);
  registerExecuteToolbarButton(deps);
  registerGetCustomPages(deps);
  registerRenderCustomPage(deps);
  registerHandlePageMessage(deps);
  registerCallPluginAPI(deps);
}

function withPluginLoaded<T extends any[]>(
  ensurePluginLoaded: (pluginId: string) => Promise<void>,
  handler: PluginRouteHandler<T>,
  pluginIdExtractor?: (...args: T) => string
) {
  return async (event: IpcMainInvokeEvent, ...args: T) => {
    try {
      const pluginId = pluginIdExtractor ? pluginIdExtractor(...args) : (args[0] as string);
      await ensurePluginLoaded(pluginId);

      const result = await handler(event, ...args);
      return { success: true, ...result };
    } catch (error: unknown) {
      return handleIPCError(error);
    }
  };
}

function registerExecuteCommand({ pluginManager, ensurePluginLoaded }: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:execute-command',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: withPluginLoaded(
      ensurePluginLoaded,
      async (_event, pluginId: string, commandId: string, params: any) => {
        const result = await pluginManager.executeCommand(pluginId, commandId, params);
        return { result };
      }
    ),
  });
}

function registerGetToolbarButtons({ duckdb }: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-toolbar-buttons',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        const datasetInfo = await duckdb.executeSQLWithParams(
          `
          SELECT created_by_plugin
          FROM datasets
          WHERE id = ?
        `,
          [datasetId]
        );

        const createdByPlugin = datasetInfo[0]?.created_by_plugin || null;

        const rows = await duckdb.executeSQLWithParams(
          `
          SELECT
            id, plugin_id, contribution_id, label, icon, confirm_message,
            command_id, requires_selection, min_selection, max_selection,
            button_order, applies_to
          FROM js_plugin_toolbar_buttons
          ORDER BY button_order, created_at
        `,
          []
        );

        const filteredButtons = rows.filter((row: any) => {
          const appliesTo = row.applies_to ? JSON.parse(row.applies_to) : { type: 'all' };

          if (appliesTo.type === 'all') {
            return true;
          }

          if (appliesTo.type === 'plugin-tables') {
            return createdByPlugin === row.plugin_id;
          }

          if (appliesTo.type === 'specific' && appliesTo.datasetIds) {
            return appliesTo.datasetIds.includes(datasetId);
          }

          return false;
        });

        const toolbarButtons = filteredButtons.map((row: any) => ({
          id: row.id,
          pluginId: row.plugin_id,
          contributionId: row.contribution_id,
          label: row.label,
          icon: row.icon,
          confirmMessage: row.confirm_message,
          commandId: row.command_id,
          requiresSelection: row.requires_selection,
          minSelection: row.min_selection,
          maxSelection: row.max_selection,
          order: row.button_order,
        }));

        return { success: true, toolbarButtons };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerExecuteActionColumn({
  pluginManager,
  duckdb,
  buttonExecutor,
  ensurePluginLoaded,
}: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:execute-action-column',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      pluginId: string,
      commandId: string,
      rowid: number,
      datasetId: string
    ) => {
      try {
        await ensurePluginLoaded(pluginId);

        console.log(`⚡ Executing button field command: ${pluginId}:${commandId}`);
        console.log(`📦 rowid: ${rowid}, datasetId: ${datasetId}`);

        const queryResult = await duckdb.queryDataset(
          datasetId,
          `SELECT * FROM data WHERE _row_id = ${rowid}`
        );
        const rowData = queryResult.rows[0];

        if (!rowData) {
          return { success: false, error: `Row ${rowid} not found` };
        }

        const datasetInfo = await duckdb.getDatasetInfo(datasetId);
        const buttonColumn = datasetInfo?.schema?.find(
          (col) =>
            col.fieldType === 'button' &&
            col.metadata?.pluginId === pluginId &&
            col.metadata?.methodId === commandId
        );

        if (buttonColumn?.metadata) {
          const result = await buttonExecutor.execute({
            datasetId,
            rowId: rowid,
            rowData,
            buttonMetadata: buttonColumn.metadata,
          });

          return {
            success: result.success,
            result: result.result,
            error: result.error,
            updatedFields: result.updatedFields,
            triggeredNext: result.triggeredNext,
          };
        }

        const params = {
          rowid,
          datasetId,
          rowData,
        };

        const result = await pluginManager.executeCommand(pluginId, commandId, params);
        return { success: true, result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerExecuteToolbarButton({
  pluginManager,
  ensurePluginLoaded,
}: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:execute-toolbar-button',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      pluginId: string,
      commandId: string,
      selectedRows: any[],
      datasetId?: string,
      parameterMapping?: any
    ) => {
      try {
        await ensurePluginLoaded(pluginId);

        const params: any = {
          selectedRows,
          count: selectedRows.length,
        };

        if (datasetId) {
          params.datasetId = datasetId;
        }

        if (parameterMapping) {
          for (const [paramKey, mappingValue] of Object.entries(parameterMapping)) {
            if (mappingValue === '$datasetId' && datasetId) {
              params[paramKey] = datasetId;
            } else if (mappingValue === '$selectedRows') {
              params[paramKey] = selectedRows;
            } else if (mappingValue === '$count') {
              params[paramKey] = selectedRows.length;
            } else if (typeof mappingValue === 'string' && mappingValue.startsWith('$')) {
              console.warn(`Unknown parameter mapping variable: ${mappingValue}`);
            } else {
              params[paramKey] = mappingValue;
            }
          }
        }

        console.log(`⚡ Executing toolbar button command: ${pluginId}:${commandId}`);
        console.log(`📦 Params:`, params);

        const result = await pluginManager.executeCommand(pluginId, commandId, params);
        return { success: true, result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGetCustomPages({ pluginManager }: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-custom-pages',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string, datasetId?: string) => {
      try {
        const pages = await pluginManager.getCustomPages(pluginId, datasetId);
        return { success: true, pages };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerRenderCustomPage({ pluginManager }: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:render-custom-page',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      pluginId: string,
      pageId: string,
      datasetId?: string
    ) => {
      try {
        const html = await pluginManager.renderCustomPage(pluginId, pageId, datasetId);
        return { success: true, html };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerHandlePageMessage({
  pluginManager,
  ensurePluginLoaded,
}: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:page-message',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: withPluginLoaded(
      ensurePluginLoaded,
      async (_event, message: any) => {
        const result = await pluginManager.handlePageMessage(message);
        return { result };
      },
      (message: any) => message.pluginId
    ),
  });
}

function registerCallPluginAPI({
  pluginManager,
  ensurePluginLoaded,
}: JSPluginUIExtensionRouteDeps): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:call-api',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: withPluginLoaded(
      ensurePluginLoaded,
      async (_event, pluginId: string, apiName: string, args: any[]) => {
        const result = await pluginManager.callPluginAPI(pluginId, apiName, args);
        return { result };
      }
    ),
  });
}
