/**
 * DatasetMetadataService - 数据集元数据服务
 *
 * 职责：
 * - 数据集元数据表的初始化
 * - 数据集信息的 CRUD 操作
 * - Schema 的读取和更新（作为单一数据源）
 * - 列元数据和显示配置的管理
 * - 类型分析和推断
 *
 * 🎯 单一数据源原则：所有 schema 更新必须通过此服务
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { createLogger } from '../../core/logger';
import { parseRows, quoteQualifiedName, runInDuckDbTransaction } from './utils';
import { allPrepared, runPrepared } from './statement-executor';
import { sanitizeDatasetId, DatasetStorageService } from './dataset-storage-service';
import { getUnknownErrorMessage } from '../ipc-utils';
import type { Dataset } from './types';
import { SchemaMigrationEngine } from './migration-engine';
import { DATASET_METADATA_SCHEMA_MIGRATIONS } from './schema-migrations';

const logger = createLogger('DatasetMetadataService');

export class DatasetMetadataService {
  constructor(
    private conn: DuckDBConnection,
    private storageService: DatasetStorageService
  ) {}

  /**
   * 📊 初始化元数据表
   * 创建 datasets 表和相关索引
   */
  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS datasets (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        file_path VARCHAR NOT NULL,
        row_count BIGINT,
        column_count INTEGER,
        size_bytes BIGINT,
        created_at BIGINT NOT NULL,
        last_queried_at BIGINT,
        schema JSON,
        folder_id VARCHAR,
        table_order INTEGER DEFAULT 0,
        created_by_plugin VARCHAR,
        tab_group_id VARCHAR,
        tab_order INTEGER DEFAULT 0,
        is_group_default BOOLEAN DEFAULT FALSE
      )
    `);

    await new SchemaMigrationEngine(this.conn).migrate(DATASET_METADATA_SCHEMA_MIGRATIONS);

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_tab_groups (
        id VARCHAR PRIMARY KEY,
        name VARCHAR,
        root_dataset_id VARCHAR NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT
      )
    `);

    // 创建索引优化查询性能
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_datasets_folder
      ON datasets(folder_id)
    `);

    // 为插件创建的数据集创建索引
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_datasets_plugin
      ON datasets(created_by_plugin)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_datasets_tab_group
      ON datasets(tab_group_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_datasets_tab_group_order
      ON datasets(tab_group_id, tab_order)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_tab_groups_root_dataset
      ON dataset_tab_groups(root_dataset_id)
    `);
  }

  /**
   * 💾 保存元数据
   * 插入新的数据集元数据记录
   */
  async saveMetadata(dataset: Dataset): Promise<void> {
    const schema = dataset.schema ? JSON.stringify(dataset.schema) : null;

    await runPrepared(
      this.conn,
      `
      INSERT INTO datasets (
        id, name, file_path, row_count, column_count, size_bytes, created_at, schema,
        folder_id, table_order, created_by_plugin,
        tab_group_id, tab_order, is_group_default
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        dataset.id,
        dataset.name,
        dataset.filePath,
        dataset.rowCount,
        dataset.columnCount,
        dataset.sizeBytes,
        dataset.createdAt,
        schema,
        dataset.folderId ?? null,
        dataset.tableOrder ?? 0,
        dataset.createdByPlugin ?? null,
        dataset.tabGroupId ?? null,
        dataset.tabOrder ?? 0,
        dataset.isGroupDefault ?? false,
      ]
    );

    // 🆕 对于插件数据表，立即执行 CHECKPOINT 确保数据持久化
    // 防止 WAL 未合并导致 datasets 记录在重启时丢失
    if (dataset.id.startsWith('plugin__')) {
      try {
        await this.conn.run('CHECKPOINT');
        logger.info('CHECKPOINT completed for plugin dataset metadata save', {
          datasetId: dataset.id,
        });
      } catch (checkpointError: unknown) {
        logger.warn('CHECKPOINT failed after plugin dataset metadata save', {
          datasetId: dataset.id,
          errorMessage: getUnknownErrorMessage(checkpointError),
        });
      }
    }
  }

  /**
   * 📋 列出所有数据集
   * 按创建时间倒序排列
   */
  async listDatasets(): Promise<Dataset[]> {
    const result = await this.conn.runAndReadAll('SELECT * FROM datasets ORDER BY created_at DESC');
    const rows = parseRows(result);

    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      filePath: row.file_path,
      rowCount: Number(row.row_count),
      columnCount: row.column_count,
      sizeBytes: Number(row.size_bytes),
      createdAt: Number(row.created_at),
      lastQueriedAt: row.last_queried_at ? Number(row.last_queried_at) : undefined,
      schema: row.schema ? JSON.parse(row.schema) : undefined,
      folderId: row.folder_id || null,
      tableOrder: row.table_order !== undefined ? Number(row.table_order) : undefined,
      tabGroupId: row.tab_group_id || null,
      tabOrder: row.tab_order !== undefined ? Number(row.tab_order) : undefined,
      isGroupDefault: Boolean(row.is_group_default),
      createdByPlugin: row.created_by_plugin || null,
    }));
  }

  /**
   * 🔍 获取数据集信息
   * 返回单个数据集的完整元数据
   */
  async getDatasetInfo(datasetId: string): Promise<Dataset | null> {
    logger.info('Getting dataset info', { datasetId });

    const result = await allPrepared(this.conn, 'SELECT * FROM datasets WHERE id = ?', [datasetId]);

    const rows = parseRows(result);

    if (rows.length === 0) {
      logger.info('Dataset not found while getting dataset info', { datasetId });
      return null;
    }

    const row: any = rows[0];
    logger.info('Dataset metadata row loaded', { datasetId, columnCount: row.column_count });

    // ✅ 解析 schema，确保至少返回空数组
    let schema: any[] = [];
    if (row.schema) {
      try {
        const parsed = JSON.parse(String(row.schema));
        schema = Array.isArray(parsed) ? parsed : [];
        logger.info('Parsed dataset schema columns', {
          datasetId,
          columnCount: schema.length,
          columnNames: schema.map((c) => c.name),
        });
      } catch (error) {
        logger.error('Failed to parse dataset schema', { datasetId, error });
        schema = [];
      }
    }

    // ✅ 如果 schema 为空但 columnCount > 0，记录警告
    if (schema.length === 0 && Number(row.column_count) > 0) {
      logger.warn('Dataset has columns but no schema metadata', {
        datasetId,
        columnCount: row.column_count,
      });
    }

    return {
      id: String(row.id),
      name: String(row.name),
      filePath: String(row.file_path),
      rowCount: Number(row.row_count),
      columnCount: Number(row.column_count),
      sizeBytes: Number(row.size_bytes),
      createdAt: Number(row.created_at),
      lastQueriedAt: row.last_queried_at ? Number(row.last_queried_at) : undefined,
      schema: schema, // ✅ 确保始终是数组
      folderId: row.folder_id || null,
      tableOrder: row.table_order !== undefined ? Number(row.table_order) : undefined,
      tabGroupId: row.tab_group_id || null,
      tabOrder: row.tab_order !== undefined ? Number(row.tab_order) : undefined,
      isGroupDefault: Boolean(row.is_group_default),
      createdByPlugin: row.created_by_plugin || null,
    };
  }

  /**
   * ✏️ 重命名数据集
   */
  async renameDataset(datasetId: string, newName: string): Promise<void> {
    await runPrepared(this.conn, 'UPDATE datasets SET name = ? WHERE id = ?', [newName, datasetId]);
  }

  /**
   * 🔢 增加数据集行数计数（用于新增记录后快速同步侧边栏统计）
   */
  async incrementRowCount(datasetId: string, delta: number): Promise<void> {
    if (!Number.isFinite(delta)) return;
    const safeDelta = Math.trunc(delta);
    if (safeDelta === 0) return;

    await runPrepared(
      this.conn,
      `
      UPDATE datasets
      SET row_count = COALESCE(row_count, 0) + ?
      WHERE id = ?
    `,
      [safeDelta, datasetId]
    );
  }

  async setRowCount(datasetId: string, rowCount: number): Promise<void> {
    const normalizedRowCount = Math.max(0, Math.trunc(Number(rowCount) || 0));

    await runPrepared(this.conn, 'UPDATE datasets SET row_count = ? WHERE id = ?', [
      normalizedRowCount,
      datasetId,
    ]);
  }

  async reconcileRowCountInCurrentQueue(dataset: Dataset): Promise<number> {
    const safeDatasetId = sanitizeDatasetId(dataset.id);
    const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await this.storageService.smartAttach(safeDatasetId, escapedPath);

    const tableName = quoteQualifiedName(`ds_${safeDatasetId}`, 'data');
    const result = await this.conn.runAndReadAll(
      `SELECT COUNT(*) AS row_count FROM ${tableName}`
    );
    const rows = parseRows(result);
    const actualRowCount = Number(rows[0]?.row_count ?? 0);
    if (!Number.isFinite(actualRowCount)) {
      throw new Error(`Invalid row_count while reconciling dataset ${safeDatasetId}`);
    }

    await this.setRowCount(safeDatasetId, actualRowCount);
    logger.info('Reconciled dataset row_count from physical table count', {
      datasetId: safeDatasetId,
      rowCount: actualRowCount,
    });
    return actualRowCount;
  }

  async reconcileRowCount(datasetId: string): Promise<number> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.getDatasetInfo(safeDatasetId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${datasetId}`);
      }
      return await this.reconcileRowCountInCurrentQueue(dataset);
    });
  }

  /**
   * 🗑️ 删除元数据记录
   * 级联删除所有关联表的记录，确保数据一致性
   */
  async deleteMetadata(datasetId: string): Promise<void> {
    try {
      await runInDuckDbTransaction(this.conn, async () => {
        const groupResult = await allPrepared(
          this.conn,
          `
        SELECT tab_group_id, is_group_default
        FROM datasets
        WHERE id = ?
      `,
          [datasetId]
        );
        const groupRows = parseRows(groupResult);
        const tabGroupId = groupRows[0]?.tab_group_id ? String(groupRows[0].tab_group_id) : null;
        const deletedWasDefault = Boolean(groupRows[0]?.is_group_default);

        // 1. 删除关联的视图元数据
        await runPrepared(this.conn, `DELETE FROM dataset_query_templates WHERE dataset_id = ?`, [
          datasetId,
        ]);
        logger.info('Deleted dataset query templates metadata', { datasetId });

        // 2. 删除操作列配置
        await runPrepared(this.conn, `DELETE FROM dataset_action_columns WHERE dataset_id = ?`, [
          datasetId,
        ]);
        logger.info('Deleted dataset action columns metadata', { datasetId });

        // 3. 删除插件绑定
        await runPrepared(this.conn, `DELETE FROM dataset_plugin_bindings WHERE dataset_id = ?`, [
          datasetId,
        ]);
        logger.info('Deleted dataset plugin bindings metadata', { datasetId });

        // 4. 删除主记录
        await runPrepared(this.conn, 'DELETE FROM datasets WHERE id = ?', [datasetId]);
        logger.info('Deleted dataset metadata record', { datasetId });

        if (tabGroupId) {
          const countResult = await allPrepared(
            this.conn,
            `
          SELECT COUNT(*) AS cnt
          FROM datasets
          WHERE tab_group_id = ?
        `,
            [tabGroupId]
          );
          const remainingCount = Number(parseRows(countResult)[0]?.cnt ?? 0);

          if (remainingCount <= 0) {
            await runPrepared(this.conn, `DELETE FROM dataset_tab_groups WHERE id = ?`, [
              tabGroupId,
            ]);
          } else if (deletedWasDefault) {
            const nextResult = await allPrepared(
              this.conn,
              `
            SELECT id
            FROM datasets
            WHERE tab_group_id = ?
            ORDER BY tab_order ASC, created_at ASC
            LIMIT 1
          `,
              [tabGroupId]
            );
            const nextDatasetId = String(parseRows(nextResult)[0]?.id ?? '');

            if (nextDatasetId) {
              await runPrepared(
                this.conn,
                `
              UPDATE datasets
              SET is_group_default = CASE WHEN id = ? THEN TRUE ELSE FALSE END
              WHERE tab_group_id = ?
            `,
                [nextDatasetId, tabGroupId]
              );
              await runPrepared(
                this.conn,
                `
              UPDATE dataset_tab_groups
              SET root_dataset_id = ?, updated_at = ?
              WHERE id = ?
            `,
                [nextDatasetId, Date.now(), tabGroupId]
              );
            }
          }
        }
      });
      logger.info('All dataset metadata deleted', { datasetId });
    } catch (error) {
      logger.error('Failed to delete dataset metadata', { datasetId, error });
      throw error;
    }
  }

  /**
   * 🔄 更新数据集 schema
   * 🎯 所有 schema 修改的单一入口
   */
  async updateDatasetSchema(datasetId: string, schema: any[]): Promise<void> {
    logger.info('Updating dataset schema', {
      datasetId,
      columnCount: schema.length,
      columnNames: schema.map((c) => c.name),
    });

    const schemaJson = JSON.stringify(schema);
    await runPrepared(
      this.conn,
      `
      UPDATE datasets
      SET schema = ?, column_count = ?
      WHERE id = ?
    `,
      [schemaJson, schema.length, datasetId]
    );

    logger.info('Dataset schema update completed', { datasetId, columnCount: schema.length });

    // 验证更新
    const verifyResult = await allPrepared(
      this.conn,
      `SELECT schema, column_count FROM datasets WHERE id = ?`,
      [datasetId]
    );
    const rows = parseRows(verifyResult);
    logger.info('Dataset schema update verification column count loaded', {
      datasetId,
      columnCount: rows[0]?.column_count,
    });
    const savedSchema = JSON.parse(String(rows[0]?.schema || '[]'));
    logger.info('Dataset schema update verification saved schema loaded', {
      datasetId,
      columnCount: savedSchema.length,
      columnNames: savedSchema.map((c: any) => c.name),
    });
  }

  /**
   * 📝 更新列元数据
   * 更新指定列的 metadata 字段
   */
  async updateColumnMetadata(datasetId: string, columnName: string, metadata: any): Promise<void> {
    const dataset = await this.getDatasetInfo(datasetId);
    if (!dataset || !dataset.schema) {
      throw new Error(`Dataset not found or has no schema: ${datasetId}`);
    }

    // 更新指定列的metadata
    const updatedSchema = dataset.schema.map((col) => {
      if (col.name === columnName) {
        return { ...col, metadata: { ...col.metadata, ...metadata } };
      }
      return col;
    });

    await this.updateDatasetSchema(datasetId, updatedSchema);
  }

  /**
   * 🎨 更新列显示配置
   * 更新指定列的 displayConfig 字段（列宽、排序等）
   */
  async updateColumnDisplayConfig(
    datasetId: string,
    columnName: string,
    displayConfig: any
  ): Promise<void> {
    const dataset = await this.getDatasetInfo(datasetId);
    if (!dataset || !dataset.schema) {
      throw new Error(`Dataset not found or has no schema: ${datasetId}`);
    }

    // 查找列
    const column = dataset.schema.find((col) => col.name === columnName);
    if (!column) {
      throw new Error(`列 "${columnName}" 不存在`);
    }

    // 更新指定列的displayConfig
    const updatedSchema = dataset.schema.map((col) => {
      if (col.name === columnName) {
        return {
          ...col,
          displayConfig: { ...col.displayConfig, ...displayConfig },
        };
      }
      return col;
    });

    await this.updateDatasetSchema(datasetId, updatedSchema);
  }

  /**
   * 🔢 重新排序列
   * 根据提供的列名顺序重新排列 schema
   */
  async reorderColumns(datasetId: string, columnNames: string[]): Promise<void> {
    const dataset = await this.getDatasetInfo(datasetId);
    if (!dataset || !dataset.schema) {
      throw new Error(`Dataset not found or has no schema: ${datasetId}`);
    }

    // 验证列名列表完整性
    if (columnNames.length !== dataset.schema.length) {
      throw new Error(
        `列名列表不完整: 期望 ${dataset.schema.length} 列，实际 ${columnNames.length} 列`
      );
    }

    const uniqueNames = new Set(columnNames);
    if (uniqueNames.size !== columnNames.length) {
      throw new Error('列名列表包含重复项');
    }

    // 验证所有列名都存在
    const schemaColumnNames = new Set(dataset.schema.map((col) => col.name));
    for (const name of columnNames) {
      if (!schemaColumnNames.has(name)) {
        throw new Error(`列 "${name}" 不存在`);
      }
    }

    // 根据新顺序重排 schema
    const reorderedSchema = columnNames.map((name) => {
      const col = dataset.schema!.find((c) => c.name === name);
      if (!col) {
        throw new Error(`列 "${name}" 不存在`);
      }
      return col;
    });

    // 更新每列的 order 字段
    reorderedSchema.forEach((col, index) => {
      if (!col.displayConfig) {
        col.displayConfig = {};
      }
      col.displayConfig.order = index;
    });

    await this.updateDatasetSchema(datasetId, reorderedSchema);

    logger.info('Dataset columns reordered', { datasetId, columnCount: columnNames.length });
  }

  /**
   * 🔬 分析数据集类型
   * 使用 TypeAnalyzer 进行深度类型推断
   *
   * 返回增强的 schema 和样本数据
   */
  async analyzeDatasetTypes(datasetId: string): Promise<{ schema: any[]; sampleData: any[] }> {
    const sanitizedId = sanitizeDatasetId(datasetId);

    // 🔒 使用队列机制确保串行执行，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(sanitizedId, async () => {
      // 获取数据集信息
      const dataset = await this.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${sanitizedId}`);
      }

      logger.info('Starting dataset type analysis', { datasetId: sanitizedId });

      // 转义路径
      const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

      // 确保数据库已 attached
      await this.storageService.smartAttach(sanitizedId, escapedPath);

      const attachKey = `ds_${sanitizedId}`;
      const tableName = quoteQualifiedName(attachKey, 'data');

      try {
        // 延迟加载 TypeAnalyzer（避免循环依赖）
        // 在打包环境下，CJS 的 dynamic import 可能在 asar/unpacked 场景出现解析问题，改用 require 更稳。
        const { TypeAnalyzer } = require('./type-analyzer') as typeof import('./type-analyzer');

        logger.info('Creating TypeAnalyzer instance', { datasetId: sanitizedId });
        const analyzer = new TypeAnalyzer();

        logger.info('Analyzing dataset table types', { datasetId: sanitizedId, tableName });
        const enhancedSchema = await analyzer.analyzeTable(this.conn, tableName);

        logger.info('Dataset type analysis completed', {
          datasetId: sanitizedId,
          columnCount: enhancedSchema.length,
        });

        // 获取样本数据（前10行）
        const result = await this.conn.runAndReadAll(`SELECT * FROM ${tableName} LIMIT 10`);
        const sampleData = parseRows(result);

        return {
          schema: enhancedSchema,
          sampleData,
        };
      } finally {
        // 使用智能 detach（实际上保持连接）
        // ✅ ATTACH 保持有效，供 VIEW 使用
        // DuckDB 会在连接关闭时自动清理
      }
    });
  }
}
