/**
 * Plugin Installer
 *
 * 负责插件的卸载、数据表创建/删除等功能
 * 从 manager.ts 拆分出来，专注于安装/卸载职责
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import type { IDuckDBService } from '../../types/duckdb';
import type { JSPluginManifest, DataTableDefinition } from '../../types/js-plugin';
import type { EnhancedColumnSchema } from '../../types/duckdb';
import { getFileSize, getImportsDir } from '../../utils/data-paths';
import type { PluginLogger } from '../../utils/PluginLogger';
import { createLogger } from '../logger';
import { SQLUtils } from '../query-engine/utils/sql-utils';
import { getUnknownErrorMessage } from '../../utils/error-message';


const logger = createLogger('PluginInstaller');
const SYSTEM_COLUMN_NAMES = new Set(['_row_id', 'deleted_at', 'created_at', 'updated_at']);

function isSystemColumnName(name: string): boolean {
  return SYSTEM_COLUMN_NAMES.has(name.toLowerCase());
}

export type PluginTableCreationAction = 'created' | 'reused' | 'restored_orphan';

export interface PluginTableCreationResult {
  datasetId: string;
  tableName: string;
  action: PluginTableCreationAction;
  previousFolderId?: string | null;
}

export interface PluginTableCleanupFailure {
  datasetId?: string;
  tableName?: string;
  stage:
    | 'delete_table'
    | 'delete_folder'
    | 'delete_state'
    | 'orphan_tables'
    | 'orphan_folder'
    | 'orphan_state';
  error: string;
}

export class PluginTableCleanupError extends Error {
  constructor(
    message: string,
    public readonly pluginId: string,
    public readonly operation: 'delete' | 'orphan',
    public readonly failures: PluginTableCleanupFailure[]
  ) {
    super(message);
    this.name = 'PluginTableCleanupError';
  }
}

/**
 * 插件安装器
 * 处理插件的卸载和数据表管理
 */
export class PluginInstaller {
  constructor(private duckdb: IDuckDBService) {}

  // ========== 数据表管理 ==========

  private async cleanupPluginStateNamespace(
    pluginId: string,
    operation: 'delete' | 'orphan',
    stage: 'delete_state' | 'orphan_state'
  ): Promise<void> {
    const statements = [
      `DELETE FROM plugin_data WHERE plugin_id = ?`,
      `DELETE FROM plugin_configurations WHERE plugin_id = ?`,
      `DELETE FROM plugin_secure_data WHERE plugin_id = ?`,
      `DELETE FROM plugin_relational_state WHERE plugin_id = ?`,
      `DELETE FROM plugin_state_migrations WHERE plugin_id = ?`,
    ];

    try {
      logger.info(`  [DELETE] Clearing plugin state namespace...`);
      for (const sql of statements) {
        await this.duckdb.executeWithParams(sql, [pluginId]);
      }
      logger.info(`  [OK] Plugin state namespace cleared`);
    } catch (error: unknown) {
      const message = getUnknownErrorMessage(error);
      logger.error(`  [ERROR] Failed to clear plugin state namespace:`, message);
      throw new PluginTableCleanupError(
        `Failed to clear plugin state namespace for ${pluginId}`,
        pluginId,
        operation,
        [{ stage, error: message }]
      );
    }
  }

  /**
   * 创建插件定义的数据表
   * 返回表名到 datasetId 的映射
   */
  async createTables(
    manifest: JSPluginManifest,
    pluginFolderId: string,
    pluginLogger?: PluginLogger,
    options?: {
      onTableResult?: (result: PluginTableCreationResult) => void;
    }
  ): Promise<Map<string, string>> {
    const tableNameToDatasetId = new Map<string, string>();
    const createdResults: PluginTableCreationResult[] = [];

    if (!manifest.dataTables || manifest.dataTables.length === 0) {
      return tableNameToDatasetId;
    }

    pluginLogger?.info(
      `[TABLE] Creating ${manifest.dataTables.length} data table(s) for plugin: ${manifest.id}`
    );

    for (const tableDefinition of manifest.dataTables) {
      try {
        const result = await this.createSingleTable(
          manifest.id,
          tableDefinition,
          pluginFolderId,
          { skipCheckpoint: true, logger: pluginLogger }
        );
        createdResults.push(result);
        options?.onTableResult?.(result);
        tableNameToDatasetId.set(tableDefinition.name, result.datasetId);
      } catch (error: unknown) {
        pluginLogger?.error(
          `[ERROR] Failed to create table "${tableDefinition.name}":`,
          getUnknownErrorMessage(error)
        );
        await this.rollbackTableCreationResults(createdResults, pluginLogger);
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
    } catch (checkpointError: unknown) {
      pluginLogger?.warn(`[WARN] Final CHECKPOINT failed (non-critical):`, getUnknownErrorMessage(checkpointError));
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
  ): Promise<PluginTableCreationResult> {
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
      `SELECT id, name, file_path, created_by_plugin, folder_id, schema FROM datasets WHERE id = ?`,
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
          return { datasetId, tableName: existing.name, action: 'reused' };
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
          const previousFolderId = existing.folder_id ?? null;
          await this.duckdb.executeWithParams(
            `UPDATE datasets SET created_by_plugin = ?, folder_id = ? WHERE id = ?`,
            [pluginId, pluginFolderId, datasetId]
          );

          pluginLogger?.info(`  [OK] Successfully restored orphaned table to plugin: ${pluginId}`);
          return {
            datasetId,
            tableName: existing.name,
            action: 'restored_orphan',
            previousFolderId,
          };
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
      } catch (cleanupError: unknown) {
        pluginLogger?.warn(`  [WARN] Failed to cleanup files: ${getUnknownErrorMessage(cleanupError)}`);
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
    } catch (error: unknown) {
      await this.cleanupPhysicalDatasetFiles(datasetId, outputPath, pluginLogger);
      throw error;
    } finally {
      try {
        await this.duckdb.executeWithParams(
          `DETACH ${SQLUtils.escapeIdentifier(`ds_${datasetId}`)}`,
          []
        );
      } catch (detachError: unknown) {
        pluginLogger?.warn(
          `  [WARN] Failed to detach plugin dataset after table creation:`,
          getUnknownErrorMessage(detachError)
        );
      }
    }

    // 保存元数据
    const fileSize = await getFileSize(outputPath);
    try {
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
    } catch (metadataError: unknown) {
      await this.cleanupPhysicalDatasetFiles(datasetId, outputPath, pluginLogger);
      throw metadataError;
    }

    if (!options?.skipCheckpoint) {
      try {
        await this.duckdb.executeWithParams('CHECKPOINT', []);
        pluginLogger?.info(`  ✓ CHECKPOINT completed for table: ${tableName}`);
      } catch (checkpointError: unknown) {
        pluginLogger?.warn(`  [WARN] CHECKPOINT failed (non-critical):`, getUnknownErrorMessage(checkpointError));
      }
    }

    return { datasetId, tableName, action: 'created' };
  }

  async rollbackTableCreationResults(
    results: PluginTableCreationResult[],
    pluginLogger?: PluginLogger
  ): Promise<void> {
    for (const result of [...results].reverse()) {
      try {
        if (result.action === 'created') {
          await this.duckdb.deleteDataset(result.datasetId);
          pluginLogger?.info(`  [ROLLBACK] Deleted plugin table: ${result.datasetId}`);
          continue;
        }

        if (result.action === 'restored_orphan') {
          await this.duckdb.executeWithParams(
            `UPDATE datasets SET created_by_plugin = NULL, folder_id = ? WHERE id = ?`,
            [result.previousFolderId ?? null, result.datasetId]
          );
          pluginLogger?.info(`  [ROLLBACK] Restored orphan table: ${result.datasetId}`);
        }
      } catch (rollbackError: unknown) {
        pluginLogger?.error(
          `  [ROLLBACK] Failed to rollback table ${result.datasetId}:`,
          getUnknownErrorMessage(rollbackError)
        );
      }
    }
  }

  private async cleanupPhysicalDatasetFiles(
    datasetId: string,
    outputPath: string,
    pluginLogger?: PluginLogger
  ): Promise<void> {
    try {
      try {
        await this.duckdb.executeWithParams(
          `DETACH ${SQLUtils.escapeIdentifier(`ds_${datasetId}`)}`,
          []
        );
      } catch {
        // The schema may already be detached by the caller.
      }

      if (process.platform === 'win32') {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      if (await fs.pathExists(outputPath)) {
        await fs.remove(outputPath);
      }

      const walPath = `${outputPath}.wal`;
      if (await fs.pathExists(walPath)) {
        await fs.remove(walPath);
      }

      pluginLogger?.info(`  [ROLLBACK] Removed physical dataset files: ${datasetId}`);
    } catch (cleanupError: unknown) {
      pluginLogger?.warn(
        `  [WARN] Failed to cleanup physical dataset files for ${datasetId}:`,
        getUnknownErrorMessage(cleanupError)
      );
    }
  }

  /**
   * 删除插件创建的所有数据表
   */
  async deletePluginTables(pluginId: string): Promise<void> {
    logger.info(`[DELETE] Deleting tables created by plugin: ${pluginId}`);
    const failures: PluginTableCleanupFailure[] = [];

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
        } catch (error: unknown) {
          const message = getUnknownErrorMessage(error);
          failures.push({
            datasetId: table.id,
            tableName: table.name,
            stage: 'delete_table',
            error: message,
          });
          logger.error(`  [ERROR] Failed to delete table ${table.id}:`, message);
        }
      }

      if (failures.length > 0) {
        throw new PluginTableCleanupError(
          `Failed to delete ${failures.length} plugin table(s) for ${pluginId}`,
          pluginId,
          'delete',
          failures
        );
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
    } catch (error: unknown) {
      const message = getUnknownErrorMessage(error);
      logger.error(`  [ERROR] Failed to delete plugin folder:`, message);
      throw new PluginTableCleanupError(
        `Failed to delete plugin table folder for ${pluginId}`,
        pluginId,
        'delete',
        [{ stage: 'delete_folder', error: message }]
      );
    }

    await this.cleanupPluginStateNamespace(pluginId, 'delete', 'delete_state');
  }

  /**
   * 将插件的数据表转为"孤儿表"
   */
  async orphanPluginTables(pluginId: string): Promise<void> {
    logger.info(`🔓 Orphaning tables for plugin: ${pluginId}`);

    const tables = await this.duckdb.executeSQLWithParams(
      `SELECT id, name, folder_id FROM datasets WHERE created_by_plugin = ?`,
      [pluginId]
    );

    if (tables.length === 0) {
      logger.info(`  [INFO] No tables found for plugin: ${pluginId}`);
    } else {
      logger.info(`  [INFO] Found ${tables.length} table(s) to orphan`);
    }

    // 解除表与插件的关联
    try {
      if (tables.length > 0) {
        await this.duckdb.executeWithParams(
          `UPDATE datasets SET created_by_plugin = NULL WHERE created_by_plugin = ?`,
          [pluginId]
        );
      }
    } catch (error: unknown) {
      const message = getUnknownErrorMessage(error);
      logger.error(`[ERROR] Failed to orphan plugin tables:`, message);
      throw new PluginTableCleanupError(
        `Failed to orphan plugin tables for ${pluginId}`,
        pluginId,
        'orphan',
        [{ stage: 'orphan_tables', error: message }]
      );
    }

    if (tables.length > 0) {
      logger.info(`  [OK] Unlinked ${tables.length} table(s) from plugin`);
    }

    // 将插件文件夹转为普通文件夹
    try {
      await this.duckdb.executeWithParams(
        `UPDATE dataset_folders SET plugin_id = NULL WHERE plugin_id = ?`,
        [pluginId]
      );
    } catch (error: unknown) {
      const message = getUnknownErrorMessage(error);
      logger.error(`[ERROR] Failed to orphan plugin folder:`, message);
      throw new PluginTableCleanupError(
        `Failed to orphan plugin table folder for ${pluginId}`,
        pluginId,
        'orphan',
        [{ stage: 'orphan_folder', error: message }]
      );
    }

    logger.info(`  [OK] Converted plugin folder to regular folder`);

    await this.cleanupPluginStateNamespace(pluginId, 'orphan', 'orphan_state');

    for (const table of tables) {
      logger.info(`    - ${table.name} (${table.id})`);
    }

    logger.info(`[OK] Tables successfully orphaned`);
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
