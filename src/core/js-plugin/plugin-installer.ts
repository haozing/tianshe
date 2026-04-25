/**
 * Plugin Installer
 *
 * 负责插件的卸载、数据表创建/删除等功能
 * 从 manager.ts 拆分出来，专注于安装/卸载职责
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import type { DuckDBService } from '../../main/duckdb/service';
import type { JSPluginManifest, DataTableDefinition } from '../../types/js-plugin';
import type { EnhancedColumnSchema } from '../../main/duckdb/types';
import { getFileSize, getImportsDir } from '../../main/duckdb/utils';
import type { PluginLogger } from '../../utils/PluginLogger';
import { createLogger } from '../logger';
import { SQLUtils } from '../query-engine/utils/sql-utils';

const logger = createLogger('PluginInstaller');
const SYSTEM_COLUMN_NAMES = new Set(['_row_id', 'deleted_at', 'created_at', 'updated_at']);

function isSystemColumnName(name: string): boolean {
  return SYSTEM_COLUMN_NAMES.has(name.toLowerCase());
}

/**
 * 插件安装器
 * 处理插件的卸载和数据表管理
 */
export class PluginInstaller {
  constructor(private duckdb: DuckDBService) {}

  // ========== 数据表管理 ==========

  /**
   * 创建插件定义的数据表
   * 返回表名到 datasetId 的映射
   */
  async createTables(
    manifest: JSPluginManifest,
    pluginFolderId: string,
    pluginLogger?: PluginLogger
  ): Promise<Map<string, string>> {
    const tableNameToDatasetId = new Map<string, string>();

    if (!manifest.dataTables || manifest.dataTables.length === 0) {
      return tableNameToDatasetId;
    }

    pluginLogger?.info(
      `[TABLE] Creating ${manifest.dataTables.length} data table(s) for plugin: ${manifest.id}`
    );

    for (const tableDefinition of manifest.dataTables) {
      try {
        const { datasetId } = await this.createSingleTable(
          manifest.id,
          tableDefinition,
          pluginFolderId,
          { skipCheckpoint: true, logger: pluginLogger }
        );
        tableNameToDatasetId.set(tableDefinition.name, datasetId);
      } catch (error: any) {
        pluginLogger?.error(
          `[ERROR] Failed to create table "${tableDefinition.name}":`,
          error.message
        );
        throw error;
      }
    }

    pluginLogger?.info(`[OK] All data tables created for plugin: ${manifest.id}`);

    // 批量创建完成后统一执行 CHECKPOINT
    try {
      await this.duckdb.executeWithParams('CHECKPOINT', []);
      pluginLogger?.info(
        `[OK] CHECKPOINT completed for all ${manifest.dataTables.length} plugin tables`
      );
    } catch (checkpointError: any) {
      pluginLogger?.warn(`[WARN] Final CHECKPOINT failed (non-critical):`, checkpointError.message);
    }

    return tableNameToDatasetId;
  }

  /**
   * 创建单个数据表
   */
  async createSingleTable(
    pluginId: string,
    tableDefinition: DataTableDefinition,
    pluginFolderId: string,
    options?: {
      logger?: PluginLogger;
      skipCheckpoint?: boolean;
    }
  ): Promise<{ datasetId: string; tableName: string }> {
    const pluginLogger = options?.logger;

    // 验证 code 字段
    if (!tableDefinition.code) {
      throw new Error(`数据表配置必须包含 code 字段: ${JSON.stringify(tableDefinition)}`);
    }

    if (!/^[a-zA-Z0-9_]+$/.test(tableDefinition.code)) {
      throw new Error(
        `Invalid table code: ${tableDefinition.code}\n` +
          `Table code must only contain alphanumeric characters and underscores (a-z, A-Z, 0-9, _).`
      );
    }

    const datasetId = `plugin__${pluginId}__${tableDefinition.code}`;
    const outputPath = path.join(getImportsDir(), `${datasetId}.db`);

    // 检查 ID 冲突
    const existingDataset = await this.duckdb.executeSQLWithParams(
      `SELECT id, name, file_path, created_by_plugin, schema FROM datasets WHERE id = ?`,
      [datasetId]
    );

    if (existingDataset.length > 0) {
      const existing = existingDataset[0];
      const existingPluginId = existing.created_by_plugin;

      // 情况1：表属于其他插件
      if (existingPluginId && existingPluginId !== pluginId) {
        throw new Error(
          `数据表ID冲突: ${datasetId} 已被插件 ${existingPluginId} 使用，请使用不同的 code`
        );
      }

      // 情况2：表属于当前插件
      if (existingPluginId === pluginId) {
        pluginLogger?.info(`  [INFO] Table already exists for this plugin: ${datasetId}`);
        pluginLogger?.info(`  [SKIP] Skipping table creation (using existing table)`);

        const existingFilePath = existing.file_path || outputPath;
        if (await fs.pathExists(existingFilePath)) {
          pluginLogger?.info(`  [OK] Database file exists, reusing: ${existingFilePath}`);
          return { datasetId, tableName: existing.name };
        } else {
          throw new Error(
            `数据表记录存在但文件缺失: ${existingFilePath}\n` +
              `请先手动删除损坏的记录，或使用数据完整性检查工具修复。`
          );
        }
      }

      // 情况3：孤立表
      if (!existingPluginId) {
        pluginLogger?.info(`  [WARN] Found orphaned table: ${datasetId}`);
        pluginLogger?.info(
          `  [RECOVERY] Attempting to restore association with plugin: ${pluginId}`
        );

        const existingFilePath = existing.file_path || outputPath;
        if (await fs.pathExists(existingFilePath)) {
          // 验证 Schema 兼容性
          let existingSchema: EnhancedColumnSchema[] = [];
          try {
            existingSchema = existing.schema ? JSON.parse(existing.schema) : [];
          } catch (_parseError) {
            throw new Error(
              `孤立表 ${datasetId} 的 schema 数据损坏，无法验证兼容性。\n` +
                `请手动删除该表记录后重试。`
            );
          }

          const schemaComparison = this.compareTableSchemas(
            tableDefinition.columns,
            existingSchema
          );

          if (!schemaComparison.compatible) {
            throw new Error(
              `发现孤立表 "${datasetId}"，但表结构不兼容，无法恢复。\n\n` +
                `表结构差异:\n${schemaComparison.differences.map((d) => `  • ${d}`).join('\n')}\n\n` +
                `解决方案:\n` +
                `  1. 如果不需要旧数据，请先手动删除该表\n` +
                `  2. 如果需要保留旧数据，请更改插件的 table.code`
            );
          }

          // 恢复关联
          await this.duckdb.executeWithParams(
            `UPDATE datasets SET created_by_plugin = ?, folder_id = ? WHERE id = ?`,
            [pluginId, pluginFolderId, datasetId]
          );

          pluginLogger?.info(`  [OK] Successfully restored orphaned table to plugin: ${pluginId}`);
          return { datasetId, tableName: existing.name };
        } else {
          // 清理无效记录
          await this.duckdb.executeWithParams(`DELETE FROM datasets WHERE id = ?`, [datasetId]);
          pluginLogger?.info(`  [OK] Invalid record removed, will create new table`);
        }
      }
    }

    // 清理残留文件
    if (await fs.pathExists(outputPath)) {
      pluginLogger?.info(`  [WARN] Found database file without metadata: ${outputPath}`);
      pluginLogger?.info(`  [CLEANUP] Removing orphaned file...`);

      try {
        try {
          await this.duckdb.executeWithParams(
            `DETACH ${SQLUtils.escapeIdentifier(`ds_${datasetId}`)}`,
            []
          );
        } catch {
          // DETACH 失败不是问题
        }

        if (process.platform === 'win32') {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        await fs.remove(outputPath);
        const walPath = `${outputPath}.wal`;
        if (await fs.pathExists(walPath)) {
          await fs.remove(walPath);
        }
        pluginLogger?.info(`  [OK] Cleaned up orphaned files`);
      } catch (cleanupError: any) {
        pluginLogger?.warn(`  [WARN] Failed to cleanup files: ${cleanupError.message}`);
      }
    }

    const tableName = `${tableDefinition.name} (${pluginId})`;

    // 构建 schema
    const rejectedColumns = tableDefinition.columns
      .map((col) => col.name)
      .filter((name) => isSystemColumnName(name));
    const userColumns =
      rejectedColumns.length > 0
        ? tableDefinition.columns.filter((col) => !isSystemColumnName(col.name))
        : tableDefinition.columns;

    if (rejectedColumns.length > 0) {
      const message = `Table "${tableDefinition.name}" includes reserved system columns (${rejectedColumns.join(
        ', '
      )}); they will be ignored.`;
      if (pluginLogger) {
        pluginLogger.warn(message);
      } else {
        logger.warn(message);
      }
    }

    const schema: EnhancedColumnSchema[] = [
      ...userColumns.map((col) => ({
        name: col.name,
        duckdbType: col.type,
        fieldType: col.fieldType,
        nullable: col.nullable !== false,
        storageMode: 'physical' as const,
        metadata: col.metadata,
      })),
      {
        name: '_row_id',
        duckdbType: 'BIGINT',
        fieldType: 'auto_increment',
        nullable: false,
        storageMode: 'physical' as const,
        metadata: { isSystemColumn: true, hidden: true },
      },
      {
        name: 'deleted_at',
        duckdbType: 'TIMESTAMP',
        fieldType: 'date',
        nullable: true,
        storageMode: 'physical' as const,
        metadata: { isSystemColumn: true, hidden: true },
      },
      {
        name: 'created_at',
        duckdbType: 'TIMESTAMP',
        fieldType: 'date',
        nullable: false,
        storageMode: 'physical' as const,
        metadata: { isSystemColumn: true, hidden: true },
      },
      {
        name: 'updated_at',
        duckdbType: 'TIMESTAMP',
        fieldType: 'date',
        nullable: false,
        storageMode: 'physical' as const,
        metadata: { isSystemColumn: true, hidden: true },
      },
    ];

    // 确保目录存在
    const importsDir = getImportsDir();
    await fs.ensureDir(importsDir);

    // 构建 CREATE TABLE 语句
    const columnDefs = schema
      .map((col) => {
        if (col.name === '_row_id') {
          return `${SQLUtils.escapeIdentifier(col.name)} ${col.duckdbType} PRIMARY KEY`;
        }
        if (col.name === 'deleted_at') {
          return `${SQLUtils.escapeIdentifier(col.name)} ${col.duckdbType} DEFAULT NULL`;
        }
        if (col.name === 'created_at' || col.name === 'updated_at') {
          return `${SQLUtils.escapeIdentifier(col.name)} ${col.duckdbType} DEFAULT (now())`;
        }
        return `${SQLUtils.escapeIdentifier(col.name)} ${col.duckdbType}`;
      })
      .join(', ');

    // 创建数据库
    const escapedPath = outputPath.replace(/'/g, "''");
    const schemaIdent = SQLUtils.escapeIdentifier(`ds_${datasetId}`);
    const qualifiedTableName = `${schemaIdent}.${SQLUtils.escapeIdentifier('data')}`;
    await this.duckdb.executeWithParams(`ATTACH '${escapedPath}' AS ${schemaIdent}`, []);

    try {
      await this.duckdb.executeWithParams(`CREATE TABLE ${qualifiedTableName} (${columnDefs})`, []);

      const sequenceName = `seq_data_row_id`;
      const qualifiedSequenceName = `${schemaIdent}.${SQLUtils.escapeIdentifier(sequenceName)}`;
      await this.duckdb.executeWithParams(
        `CREATE SEQUENCE IF NOT EXISTS ${qualifiedSequenceName} START 1 INCREMENT 1`,
        []
      );
      await this.duckdb.executeWithParams(
        `ALTER TABLE ${qualifiedTableName} ALTER COLUMN "_row_id" SET DEFAULT nextval(${SQLUtils.quoteValue(qualifiedSequenceName)})`,
        []
      );

      if (pluginLogger) {
        pluginLogger.dataTable('create', tableDefinition.code, {
          tableName,
          datasetId,
          columns: schema.length,
        });
      }
    } finally {
      await this.duckdb.executeWithParams(
        `DETACH ${SQLUtils.escapeIdentifier(`ds_${datasetId}`)}`,
        []
      );
    }

    // 保存元数据
    const fileSize = await getFileSize(outputPath);
    await this.duckdb.executeWithParams(
      `INSERT INTO datasets (id, name, file_path, row_count, column_count, size_bytes, created_at, schema, folder_id, table_order, created_by_plugin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datasetId,
        tableName,
        outputPath,
        0,
        schema.length,
        fileSize,
        Date.now(),
        JSON.stringify(schema),
        pluginFolderId,
        0,
        pluginId,
      ]
    );

    if (!options?.skipCheckpoint) {
      try {
        await this.duckdb.executeWithParams('CHECKPOINT', []);
        pluginLogger?.info(`  ✓ CHECKPOINT completed for table: ${tableName}`);
      } catch (checkpointError: any) {
        pluginLogger?.warn(`  [WARN] CHECKPOINT failed (non-critical):`, checkpointError.message);
      }
    }

    return { datasetId, tableName };
  }

  /**
   * 删除插件创建的所有数据表
   */
  async deletePluginTables(pluginId: string): Promise<void> {
    logger.info(`[DELETE] Deleting tables created by plugin: ${pluginId}`);

    const tables = await this.duckdb.executeSQLWithParams(
      `SELECT id, name FROM datasets WHERE created_by_plugin = ?`,
      [pluginId]
    );

    if (tables.length === 0) {
      logger.info(`  [INFO] No tables found for plugin: ${pluginId}`);
    } else {
      logger.info(`  [INFO] Found ${tables.length} table(s) to delete`);

      for (const table of tables) {
        try {
          logger.info(`  [DELETE] Deleting table: ${table.name} (${table.id})`);
          await this.duckdb.deleteDataset(table.id);
          logger.info(`  [OK] Deleted table: ${table.name}`);
        } catch (error: any) {
          logger.error(`  [ERROR] Failed to delete table ${table.id}:`, error.message);
        }
      }

      logger.info(`[OK] All plugin tables deleted for: ${pluginId}`);
    }

    // 删除插件文件夹
    try {
      logger.info(`  [DELETE] Deleting plugin folder...`);
      await this.duckdb.executeWithParams(`DELETE FROM dataset_folders WHERE plugin_id = ?`, [
        pluginId,
      ]);
      logger.info(`  [OK] Plugin folder deleted`);
    } catch (error: any) {
      logger.error(`  [WARN] Failed to delete plugin folder:`, error.message);
    }
  }

  /**
   * 将插件的数据表转为"孤儿表"
   */
  async orphanPluginTables(pluginId: string): Promise<void> {
    logger.info(`🔓 Orphaning tables for plugin: ${pluginId}`);

    try {
      const tables = await this.duckdb.executeSQLWithParams(
        `SELECT id, name, folder_id FROM datasets WHERE created_by_plugin = ?`,
        [pluginId]
      );

      if (tables.length === 0) {
        logger.info(`  [INFO] No tables found for plugin: ${pluginId}`);
        return;
      }

      logger.info(`  [INFO] Found ${tables.length} table(s) to orphan`);

      // 解除表与插件的关联
      await this.duckdb.executeWithParams(
        `UPDATE datasets SET created_by_plugin = NULL WHERE created_by_plugin = ?`,
        [pluginId]
      );

      logger.info(`  [OK] Unlinked ${tables.length} table(s) from plugin`);

      // 将插件文件夹转为普通文件夹
      await this.duckdb.executeWithParams(
        `UPDATE dataset_folders SET plugin_id = NULL WHERE plugin_id = ?`,
        [pluginId]
      );

      logger.info(`  [OK] Converted plugin folder to regular folder`);

      for (const table of tables) {
        logger.info(`    - ${table.name} (${table.id})`);
      }

      logger.info(`[OK] Tables successfully orphaned`);
    } catch (error: any) {
      logger.error(`[ERROR] Failed to orphan tables:`, error.message);
    }
  }

  /**
   * 比对表 schema 是否兼容
   */
  compareTableSchemas(
    userColumns: Array<{ name: string; type: string }>,
    existingSchema: EnhancedColumnSchema[]
  ): { compatible: boolean; differences: string[] } {
    const differences: string[] = [];

    const userDefinedColumns = existingSchema.filter((col) => !col.metadata?.isSystemColumn);

    if (userColumns.length !== userDefinedColumns.length) {
      differences.push(
        `列数量不匹配: 期望 ${userColumns.length} 列，实际 ${userDefinedColumns.length} 列`
      );
    }

    const maxLen = Math.max(userColumns.length, userDefinedColumns.length);
    for (let i = 0; i < maxLen; i++) {
      const userCol = userColumns[i];
      const existingCol = userDefinedColumns[i];

      if (!userCol && existingCol) {
        differences.push(`缺少列: "${existingCol.name}" (${existingCol.duckdbType})`);
        continue;
      }

      if (userCol && !existingCol) {
        differences.push(`多余列: "${userCol.name}" (${userCol.type})`);
        continue;
      }

      if (userCol.name !== existingCol.name) {
        differences.push(
          `第 ${i + 1} 列名称不匹配: 期望 "${userCol.name}"，实际 "${existingCol.name}"`
        );
      }

      if (userCol.type.toUpperCase() !== existingCol.duckdbType.toUpperCase()) {
        differences.push(
          `列 "${userCol.name}" 类型不匹配: 期望 ${userCol.type}，实际 ${existingCol.duckdbType}`
        );
      }
    }

    return {
      compatible: differences.length === 0,
      differences,
    };
  }
}
