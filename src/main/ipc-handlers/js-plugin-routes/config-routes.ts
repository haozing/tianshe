import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import type { JSPluginManager } from '../../../core/js-plugin/manager';
import { readManifest } from '../../../core/js-plugin/loader';

export function registerJSPluginConfigRoutes(
  pluginManager: JSPluginManager,
  duckdb: DuckDBService
): void {
  registerGetConfig(pluginManager, duckdb);
  registerSetConfig(pluginManager, duckdb);
}

function registerGetConfig(pluginManager: JSPluginManager, duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-config',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string, key: string) => {
      try {
        const info = await pluginManager.getPluginInfo(pluginId);
        if (!info) {
          throw new Error(`Plugin "${pluginId}" not found`);
        }

        const sql = `
          SELECT value FROM plugin_configurations
          WHERE plugin_id = ? AND key = ?
        `;
        const result = await duckdb.executeSQLWithParams(sql, [pluginId, key]);

        if (result.length === 0) {
          try {
            const manifest = await readManifest(info.path);
            return manifest.configuration?.properties?.[key]?.default;
          } catch (error) {
            console.warn(`Failed to read manifest for default value:`, error);
            return undefined;
          }
        }

        return JSON.parse(result[0].value);
      } catch (error: unknown) {
        console.error(`Failed to get config "${key}" for plugin "${pluginId}":`, error);
        throw error;
      }
    },
  });
}

function registerSetConfig(pluginManager: JSPluginManager, duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:set-config',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string, key: string, value: any) => {
      try {
        const info = await pluginManager.getPluginInfo(pluginId);
        if (!info) {
          throw new Error(`Plugin "${pluginId}" not found`);
        }

        const sql = `
          INSERT INTO plugin_configurations (plugin_id, key, value, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (plugin_id, key)
          DO UPDATE SET value = ?, updated_at = ?
        `;
        await duckdb.executeWithParams(sql, [
          pluginId,
          key,
          JSON.stringify(value),
          Date.now(),
          JSON.stringify(value),
          Date.now(),
        ]);

        return { success: true };
      } catch (error: unknown) {
        console.error(`Failed to set config "${key}" for plugin "${pluginId}":`, error);
        throw error;
      }
    },
  });
}
