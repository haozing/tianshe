import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import { handleIPCError } from '../../ipc-utils';
import type { JSPluginManager } from '../../../core/js-plugin/manager';
import { readManifest } from '../../../core/js-plugin/loader';

export function registerJSPluginLifecycleRoutes(
  pluginManager: JSPluginManager,
  duckdb: DuckDBService
): void {
  registerList(pluginManager);
  registerListRuntimeStatuses(pluginManager);
  registerGet(pluginManager);
  registerGetRuntimeStatus(pluginManager);
  registerUninstall(pluginManager);
  registerCancelPluginTasks(pluginManager);
  registerGetPluginTables(duckdb);
  registerReload(pluginManager);
  registerRepair(pluginManager);
  registerEnable(pluginManager);
  registerDisable(pluginManager);
}

function registerList(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:list',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        const plugins = await pluginManager.listPlugins();
        return { success: true, plugins };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGet(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const plugin = await pluginManager.getPluginInfo(pluginId);

        if (!plugin) {
          return { success: false, error: 'Plugin not found' };
        }

        try {
          const manifest = await readManifest(plugin.path);
          return {
            success: true,
            plugin: {
              ...plugin,
              manifest,
            },
          };
        } catch (error) {
          console.warn(`Failed to read manifest for plugin ${pluginId}:`, error);
          return { success: true, plugin };
        }
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerListRuntimeStatuses(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:list-runtime-statuses',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        const statuses = await pluginManager.listRuntimeStatuses();
        return { success: true, statuses };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGetRuntimeStatus(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-runtime-status',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const status = await pluginManager.getRuntimeStatus(pluginId);
        if (!status) {
          return { success: false, error: 'Plugin not found' };
        }
        return { success: true, status };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerUninstall(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:uninstall',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Uninstall a plugin and optionally delete plugin-owned data tables.',
      args: [
        { name: 'pluginId', type: 'string', required: true },
        { name: 'deleteTables', type: 'boolean', required: false },
      ],
      result: { success: 'boolean', error: 'string?' },
    },
    handler: async (
      event: IpcMainInvokeEvent,
      pluginId: string,
      deleteTables: boolean = false
    ) => {
      try {
        await pluginManager.uninstall(pluginId, deleteTables);

        event.sender.send('js-plugin:state-changed', {
          pluginId,
          state: 'uninstalled',
        });

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerCancelPluginTasks(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:cancel-plugin-tasks',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const result = await pluginManager.cancelPluginTasks(pluginId);
        return { success: true, ...result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGetPluginTables(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-tables',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const tables = await duckdb.executeSQLWithParams(
          `SELECT id, name, row_count, column_count, size_bytes
           FROM datasets
           WHERE created_by_plugin = ?
           ORDER BY name`,
          [pluginId]
        );

        return {
          success: true,
          tables: tables.map((t: any) => ({
            id: t.id,
            name: t.name,
            rowCount: t.row_count,
            columnCount: t.column_count,
            sizeBytes: t.size_bytes,
          })),
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerReload(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:reload',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        await pluginManager.reload(pluginId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerRepair(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:repair',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        console.log(`[IPC] Repairing plugin: ${pluginId}`);

        const result = await pluginManager.repairPlugin(pluginId);

        if (result.success) {
          event.sender.send('js-plugin:state-changed', {
            pluginId,
            state: 'repaired',
          });
        }

        return { success: true, result };
      } catch (error: unknown) {
        console.error(`[IPC] Repair failed:`, error);
        return handleIPCError(error);
      }
    },
  });
}

function registerEnable(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:enable',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        await pluginManager.enable(pluginId);

        event.sender.send('js-plugin:state-changed', {
          pluginId,
          state: 'enabled',
        });

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerDisable(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:disable',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        await pluginManager.disable(pluginId);

        event.sender.send('js-plugin:state-changed', {
          pluginId,
          state: 'disabled',
        });

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}
