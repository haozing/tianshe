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
import { parseRows, quoteQualifiedName } from './utils';
import { sanitizeDatasetId, DatasetStorageService } from './dataset-storage-service';
import type { Dataset } from './types';

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

    // Backward compatibility: existing databases may have been created
    // before some metadata columns were introduced.
    await this.ensureDatasetColumnExists('folder_id', `ALTER TABLE datasets ADD COLUMN folder_id VARCHAR`);
    await this.ensureDatasetColumnExists(
      'table_order',
      `ALTER TABLE datasets ADD COLUMN table_order INTEGER DEFAULT 0`
    );
    await this.ensureDatasetColumnExists(
      'created_by_plugin',
      `ALTER TABLE datasets ADD COLUMN created_by_plugin VARCHAR`
    );
    await this.ensureDatasetColumnExists(
      'tab_group_id',
      `ALTER TABLE datasets ADD COLUMN tab_group_id VARCHAR`
    );
    await this.ensureDatasetColumnExists(
      'tab_order',
      `ALTER TABLE datasets ADD COLUMN tab_order INTEGER DEFAULT 0`
    );
    await this.ensureDatasetColumnExists(
      'is_group_default',
      `ALTER TABLE datasets ADD COLUMN is_group_default BOOLEAN DEFAULT FALSE`
    );

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

  private async ensureDatasetColumnExists(columnName: string, alterSQL: string): Promise<void> {
    const result = await this.conn.runAndReadAll(`PRAGMA table_info('datasets')`);
    const rows = parseRows(result);
    const existing = new Set(
      rows.map((row: any) => String(row.name ?? row.column_name ?? '').trim().toLowerCase())
    );
    if (existing.has(columnName.toLowerCase())) return;
    await this.conn.run(alterSQL);
  }

  /**
   * 💾 保存元数据
   * 插入新的数据集元数据记录
   */
  async saveMetadata(dataset: Dataset): Promise<void> {
    const schema = dataset.schema ? JSON.stringify(dataset.schema) : null;

    const stmt = await this.conn.prepare(`
      INSERT INTO datasets (
        id, name, file_path, row_count, column_count, size_bytes, created_at, schema,
        folder_id, table_order, created_by_plugin,
        tab_group_id, tab_order, is_group_default
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
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
    ]);

    await stmt.run();
    stmt.destroySync();

    // 🆕 对于插件数据表，立即执行 CHECKPOINT 确保数据持久化
    // 防止 WAL 未合并导致 datasets 记录在重启时丢失
    if (dataset.id.startsWith('plugin__')) {
      try {
        await this.conn.run('CHECKPOINT');
        console.log(`  ✓ CHECKPOINT completed for dataset: ${dataset.id}`);
      } catch (checkpointError: any) {
        console.warn(`  [WARN] CHECKPOINT failed (non-critical):`, checkpointError.message);
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
    console.log(`[MetadataService] getDatasetInfo called for dataset: ${datasetId}`);

    const stmt = await this.conn.prepare('SELECT * FROM datasets WHERE id = ?');
    stmt.bind([datasetId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);

    if (rows.length === 0) {
      console.log(`[MetadataService] Dataset not found: ${datasetId}`);
      return null;
    }

    const row: any = rows[0];
    console.log(`[MetadataService] Raw column_count from DB:`, row.column_count);

    // ✅ 解析 schema，确保至少返回空数组
    let schema: any[] = [];
    if (row.schema) {
      try {
        const parsed = JSON.parse(String(row.schema));
        schema = Array.isArray(parsed) ? parsed : [];
        console.log(
          `[MetadataService] Parsed schema columns (${schema.length}):`,
          schema.map((c) => c.name)
        );
      } catch (error) {
        console.error(`⚠️ Failed to parse schema for dataset ${datasetId}:`, error);
        schema = [];
      }
    }

    // ✅ 如果 schema 为空但 columnCount > 0，记录警告
    if (schema.length === 0 && Number(row.column_count) > 0) {
      console.warn(
        `⚠️ Dataset ${datasetId} has columns (count: ${row.column_count}) but no schema metadata`
      );
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
    const stmt = await this.conn.prepare('UPDATE datasets SET name = ? WHERE id = ?');
    stmt.bind([newName, datasetId]);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 🔢 增加数据集行数计数（用于新增记录后快速同步侧边栏统计）
   */
  async incrementRowCount(datasetId: string, delta: number): Promise<void> {
    if (!Number.isFinite(delta)) return;
    const safeDelta = Math.trunc(delta);
    if (safeDelta === 0) return;

    const stmt = await this.conn.prepare(`
      UPDATE datasets
      SET row_count = COALESCE(row_count, 0) + ?
      WHERE id = ?
    `);
    stmt.bind([safeDelta, datasetId]);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 🗑️ 删除元数据记录
   * 级联删除所有关联表的记录，确保数据一致性
   */
  async deleteMetadata(datasetId: string): Promise<void> {
    // 使用事务确保原子性
    await this.conn.run('BEGIN TRANSACTION');

    try {
      const groupStmt = await this.conn.prepare(`
        SELECT tab_group_id, is_group_default
        FROM datasets
        WHERE id = ?
      `);
      groupStmt.bind([datasetId]);
      const groupResult = await groupStmt.runAndReadAll();
      groupStmt.destroySync();
      const groupRows = parseRows(groupResult);
      const tabGroupId = groupRows[0]?.tab_group_id ? String(groupRows[0].tab_group_id) : null;
      const deletedWasDefault = Boolean(groupRows[0]?.is_group_default);

      // 1. 删除关联的视图元数据
      await this.conn.run(`DELETE FROM dataset_query_templates WHERE dataset_id = ?`, [datasetId]);
      console.log(`  ✓ [DeleteMeta] Deleted query templates for: ${datasetId}`);

      // 2. 删除操作列配置
      await this.conn.run(`DELETE FROM dataset_action_columns WHERE dataset_id = ?`, [datasetId]);
      console.log(`  ✓ [DeleteMeta] Deleted action columns for: ${datasetId}`);

      // 3. 删除插件绑定
      await this.conn.run(`DELETE FROM dataset_plugin_bindings WHERE dataset_id = ?`, [datasetId]);
      console.log(`  ✓ [DeleteMeta] Deleted plugin bindings for: ${datasetId}`);

      // 4. 删除主记录
      const stmt = await this.conn.prepare('DELETE FROM datasets WHERE id = ?');
      stmt.bind([datasetId]);
      await stmt.run();
      stmt.destroySync();
      console.log(`  ✓ [DeleteMeta] Deleted dataset record: ${datasetId}`);

      if (tabGroupId) {
        const countStmt = await this.conn.prepare(`
          SELECT COUNT(*) AS cnt
          FROM datasets
          WHERE tab_group_id = ?
        `);
        countStmt.bind([tabGroupId]);
        const countResult = await countStmt.runAndReadAll();
        countStmt.destroySync();
        const remainingCount = Number(parseRows(countResult)[0]?.cnt ?? 0);

        if (remainingCount <= 0) {
          await this.conn.run(`DELETE FROM dataset_tab_groups WHERE id = ?`, [tabGroupId]);
        } else if (deletedWasDefault) {
          const nextStmt = await this.conn.prepare(`
            SELECT id
            FROM datasets
            WHERE tab_group_id = ?
            ORDER BY tab_order ASC, created_at ASC
            LIMIT 1
          `);
          nextStmt.bind([tabGroupId]);
          const nextResult = await nextStmt.runAndReadAll();
          nextStmt.destroySync();
          const nextDatasetId = String(parseRows(nextResult)[0]?.id ?? '');

          if (nextDatasetId) {
            await this.conn.run(
              `
              UPDATE datasets
              SET is_group_default = CASE WHEN id = ? THEN TRUE ELSE FALSE END
              WHERE tab_group_id = ?
            `,
              [nextDatasetId, tabGroupId]
            );
            await this.conn.run(
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

      await this.conn.run('COMMIT');
      console.log(`✅ [DeleteMeta] All metadata deleted for: ${datasetId}`);
    } catch (error) {
      await this.conn.run('ROLLBACK');
      console.error(`❌ [DeleteMeta] Failed to delete metadata:`, error);
      throw error;
    }
  }

  /**
   * 🔄 更新数据集 schema
   * 🎯 所有 schema 修改的单一入口
   */
  async updateDatasetSchema(datasetId: string, schema: any[]): Promise<void> {
    console.log(`[MetadataService] updateDatasetSchema called for dataset: ${datasetId}`);
    console.log(
      `[MetadataService] New schema columns (${schema.length}):`,
      schema.map((c) => c.name)
    );

    const schemaJson = JSON.stringify(schema);
    const stmt = await this.conn.prepare(`
      UPDATE datasets
      SET schema = ?, column_count = ?
      WHERE id = ?
    `);
    stmt.bind([schemaJson, schema.length, datasetId]);
    await stmt.run();
    stmt.destroySync();

    console.log(`[MetadataService] ✅ Schema update completed for dataset: ${datasetId}`);

    // 验证更新
    const verifyStmt = await this.conn.prepare(
      `SELECT schema, column_count FROM datasets WHERE id = ?`
    );
    verifyStmt.bind([datasetId]);
    const verifyResult = await verifyStmt.runAndReadAll();
    const rows = parseRows(verifyResult);
    console.log(`[MetadataService] Verification - column_count in DB:`, rows[0]?.column_count);
    const savedSchema = JSON.parse(String(rows[0]?.schema || '[]'));
    console.log(
      `[MetadataService] Verification - saved schema columns (${savedSchema.length}):`,
      savedSchema.map((c: any) => c.name)
    );
    verifyStmt.destroySync();
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

    console.log(`✅ 成功重排序 ${columnNames.length} 列`);
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

      console.log('[MetadataService] Starting type analysis for dataset:', sanitizedId);

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

        console.log('[MetadataService] Creating TypeAnalyzer instance...');
        const analyzer = new TypeAnalyzer();

        console.log('[MetadataService] Analyzing table:', tableName);
        const enhancedSchema = await analyzer.analyzeTable(this.conn, tableName);

        console.log(
          '[MetadataService] Type analysis completed, schema length:',
          enhancedSchema.length
        );

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
