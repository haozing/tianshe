/**
 * 插件数据表管理器兼容层
 *
 * 说明：
 * - 真实的数据表生命周期实现统一收敛到 PluginInstaller
 * - DataTableManager 保留为兼容包装层，避免现有导出和潜在调用方中断
 */

import type { DuckDBService } from '../../main/duckdb/service';
import type { EnhancedColumnSchema } from '../../main/duckdb/types';
import type { DataTableDefinition, JSPluginManifest } from '../../types/js-plugin';
import type { PluginLogger } from '../../utils/PluginLogger';
import { PluginInstaller } from './plugin-installer';

export interface DataTableManagerConfig {
  duckdb: DuckDBService;
}

export interface TableCreateOptions {
  logger?: PluginLogger;
  skipCheckpoint?: boolean;
}

export interface TableCreateResult {
  datasetId: string;
  tableName: string;
}

export interface SchemaComparisonResult {
  compatible: boolean;
  differences: string[];
}

export class DataTableManager {
  private readonly installer: PluginInstaller;

  constructor(config: DataTableManagerConfig) {
    this.installer = new PluginInstaller(config.duckdb);
  }

  async createTables(
    manifest: JSPluginManifest,
    pluginFolderId: string
  ): Promise<Map<string, string>> {
    return this.installer.createTables(manifest, pluginFolderId);
  }

  async createSingleTable(
    pluginId: string,
    tableDefinition: DataTableDefinition,
    pluginFolderId: string,
    options?: TableCreateOptions
  ): Promise<TableCreateResult> {
    return this.installer.createSingleTable(pluginId, tableDefinition, pluginFolderId, options);
  }

  async deletePluginTables(pluginId: string): Promise<void> {
    await this.installer.deletePluginTables(pluginId);
  }

  async orphanPluginTables(pluginId: string): Promise<void> {
    await this.installer.orphanPluginTables(pluginId);
  }

  compareTableSchemas(
    userColumns: Array<{ name: string; type: string }>,
    existingSchema: EnhancedColumnSchema[]
  ): SchemaComparisonResult {
    return this.installer.compareTableSchemas(userColumns, existingSchema);
  }
}
