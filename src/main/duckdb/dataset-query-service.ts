/**
 * DatasetQueryService - 数据集查询服务
 *
 * 职责：
 * - 数据查询和分页
 * - 预览功能（筛选、聚合、采样、关联、分组）
 * - 词库筛选（Aho-Corasick 算法）
 * - 计算列包装
 *
 * 🔍 与 QueryEngine 紧密协作，提供高性能查询
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetSchemaService } from './dataset-schema-service';
import { DatasetStorageService, sanitizeDatasetId } from './dataset-storage-service';
import { parseRows, quoteIdentifier, quoteQualifiedName } from './utils';
import type { QueryResult } from './types';
import AhoCorasick from 'aho-corasick';

// ✅ 查询超时配置（毫秒）
const QUERY_TIMEOUT_MS = 60000; // 60秒默认超时
const AC_ROW_ID_INSERT_BATCH_SIZE = 1000;

/**
 * 带超时的 Promise 包装器
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export class DatasetQueryService {
  private queryEngine!: import('../../core/query-engine/QueryEngine').QueryEngine;

  constructor(
    private conn: DuckDBConnection,
    private metadataService: DatasetMetadataService,
    private schemaService: DatasetSchemaService,
    private storageService: DatasetStorageService
  ) {}

  /**
   * 设置 QueryEngine 实例（由 DuckDBService 初始化后调用）
   */
  setQueryEngine(queryEngine: import('../../core/query-engine/QueryEngine').QueryEngine): void {
    this.queryEngine = queryEngine;
  }

  private async ensureDatasetAttached(datasetId: string, filePath: string): Promise<void> {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await this.storageService.smartAttach(datasetId, escapedPath);
  }

  /**
   * 🔎 主查询方法
   *
   * 支持自定义 SQL、分页、计算列、插件表
   *
   * @param datasetId 数据集 ID
   * @param sql 自定义 SQL（可选）
   * @param offset 分页偏移量
   * @param limit 每页数量
   */
  async queryDataset(
    datasetId: string,
    sql?: string,
    offset: number = 0,
    limit: number = 50
  ): Promise<QueryResult> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    // 🔄 使用队列机制执行查询，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(safeDatasetId, async () => {
      console.log(`🔍 Querying dataset: ${safeDatasetId} (offset: ${offset}, limit: ${limit})`);

      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error(`Dataset not found: ${safeDatasetId}`);

      // 检查是否有计算列需要添加
      const computedColumns = this.schemaService.extractComputedColumns(dataset);
      const hasComputedColumns = computedColumns.length > 0;

      // 如果没有提供自定义SQL，使用默认分页查询
      const defaultSql = `SELECT * FROM data ORDER BY _row_id ASC LIMIT ${limit} OFFSET ${offset}`;
      let querySql = sql || defaultSql;

      // ✅ 仅对“查询类”SQL 自动追加分页（避免 DELETE/UPDATE/INSERT 被错误追加 LIMIT/OFFSET 导致语法错误）
      if (sql) {
        const trimmed = sql.trimStart().toUpperCase();
        const isQueryLike = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
        if (isQueryLike && !/\bLIMIT\b/i.test(sql)) {
          querySql = `${sql} LIMIT ${limit} OFFSET ${offset}`;
        }
      }

      // ✅ 修复：所有表（包括插件表）都需要 ATTACH，都使用统一的表名格式
      const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

      // 🔄 使用智能 ATTACH，避免重复 ATTACH
      await this.storageService.smartAttach(safeDatasetId, escapedPath);

      try {
        const dataTable = quoteQualifiedName(`ds_${safeDatasetId}`, 'data');
        let finalSql = querySql.replace(/FROM\s+data/gi, `FROM ${dataTable}`);

        // 如果有计算列，包装成 CTE
        if (hasComputedColumns) {
          finalSql = this.schemaService.wrapWithComputedColumns(finalSql, computedColumns);
        }

        console.log(`[Query] Executing SQL: ${finalSql.substring(0, 200)}...`);
        // ✅ 添加查询超时保护
        const result = await withTimeout(
          this.conn.runAndReadAll(finalSql),
          QUERY_TIMEOUT_MS,
          `查询超时（${QUERY_TIMEOUT_MS / 1000}秒），请优化查询条件或减少数据量`
        );
        const rows = parseRows(result);
        const columns = result.columnNames();

        console.log(`[Query] Result: ${rows.length} rows, ${columns.length} columns`);

        // 更新最后查询时间
        const updateStmt = await this.conn.prepare(
          'UPDATE datasets SET last_queried_at = ? WHERE id = ?'
        );
        updateStmt.bind([Date.now(), safeDatasetId]);
        await updateStmt.run();
        updateStmt.destroySync();

        return {
          columns,
          rows,
          rowCount: rows.length,
        };
      } finally {
        // ✅ ATTACH 保持有效，供 VIEW 使用
        // DuckDB 会在连接关闭时自动清理
      }
    });
  }

  // ==================== 预览 API ====================

  /**
   * 🔍 预览筛选计数
   */
  async previewFilterCount(datasetId: string, filterConfig: any): Promise<any> {
    const sanitizedId = sanitizeDatasetId(datasetId);

    // 🔒 使用队列机制确保串行执行，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(sanitizedId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${sanitizedId}`);
      }

      await this.ensureDatasetAttached(sanitizedId, dataset.filePath);

      // ✅ 依赖管理已由 QueryEngine 统一处理
      // QueryEngine.previewFilterCount() 会自动调用 ensureAllDependencies()
      return await this.queryEngine.previewFilterCount(sanitizedId, filterConfig);
    });
  }

  /**
   * 📊 预览聚合结果
   */
  async previewAggregate(datasetId: string, aggregateConfig: any, options?: any): Promise<any> {
    const sanitizedId = sanitizeDatasetId(datasetId);

    // 🔒 使用队列机制确保串行执行
    return this.storageService.executeInQueue(sanitizedId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${sanitizedId}`);
      }

      await this.ensureDatasetAttached(sanitizedId, dataset.filePath);

      // 使用 QueryEngine PreviewService
      return await this.queryEngine.preview.previewAggregate(sanitizedId, aggregateConfig, options);
    });
  }

  /**
   * 🎲 预览采样结果
   */
  async previewSample(datasetId: string, sampleConfig: any, queryConfig?: any): Promise<any> {
    const sanitizedId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(sanitizedId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${sanitizedId}`);
      }

      await this.ensureDatasetAttached(sanitizedId, dataset.filePath);

      // 使用 QueryEngine PreviewService
      return await this.queryEngine.preview.previewSample(sanitizedId, sampleConfig, queryConfig);
    });
  }

  /**
   * 🔗 预览关联结果
   */
  async previewLookup(datasetId: string, lookupConfig: any, options?: any): Promise<any> {
    const sanitizedId = sanitizeDatasetId(datasetId);
    const lookupConfigs = Array.isArray(lookupConfig) ? lookupConfig : [lookupConfig];
    const queueDatasetIds = new Set<string>([sanitizedId]);

    for (const config of lookupConfigs) {
      if (config?.type === 'join' && config.lookupDatasetId) {
        queueDatasetIds.add(sanitizeDatasetId(String(config.lookupDatasetId)));
      }
    }

    return this.storageService.executeInQueues([...queueDatasetIds], async () => {
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${sanitizedId}`);
      }

      // ✅ 确保主表已附加（PreviewService.previewLookup 内部会直接引用 ds_<id>.data）
      await this.ensureDatasetAttached(sanitizedId, dataset.filePath);

      // ✅ JOIN 预览需要确保维表也已附加
      for (const config of lookupConfigs) {
        if (config?.type !== 'join' || !config.lookupDatasetId) {
          continue;
        }

        const lookupId = sanitizeDatasetId(String(config.lookupDatasetId));
        if (lookupId !== sanitizedId) {
          const lookupDataset = await this.metadataService.getDatasetInfo(lookupId);
          if (!lookupDataset) {
            throw new Error(`Lookup dataset not found: ${lookupId}`);
          }

          await this.ensureDatasetAttached(lookupId, lookupDataset.filePath);
        }
      }

      // 使用 QueryEngine PreviewService
      return await this.queryEngine.preview.previewLookup(sanitizedId, lookupConfigs, options);
    });
  }

  /**
   * 📦 预览分组结果
   */
  async previewGroup(datasetId: string, groupConfig: any, _options?: any): Promise<any> {
    const sanitizedId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(sanitizedId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${sanitizedId}`);
      }

      await this.ensureDatasetAttached(sanitizedId, dataset.filePath);

      // 使用 QueryEngine PreviewService
      return await this.queryEngine.preview.previewGroup(sanitizedId, groupConfig);
    });
  }

  /**
   * 🔤 词库筛选（Aho-Corasick 算法）
   *
   * 使用高性能的 Aho-Corasick 多模式匹配算法进行批量词库筛选
   *
   * @param datasetId 主数据集 ID
   * @param targetField 目标字段名
   * @param dictDatasetId 词库数据集 ID
   * @param dictField 词库字段名
   * @param isBlacklist 是否黑名单模式
   * @returns 匹配的行号数组
   */
  async filterWithAhoCorasick(
    datasetId: string,
    targetField: string,
    dictDatasetId: string,
    dictField: string,
    isBlacklist: boolean
  ): Promise<number[]> {
    const sanitizedId = sanitizeDatasetId(datasetId);

    // 🔒 使用队列机制确保串行执行，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(sanitizedId, async () => {
      const startTime = Date.now();
      console.log(`[AC] Starting Aho-Corasick filtering for dataset: ${datasetId}`);
      console.log(
        `[AC] Dictionary: ${dictDatasetId}, Field: ${dictField}, Blacklist: ${isBlacklist}`
      );

      // 🆕 确保数据集已 attach
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (dataset) {
        const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await this.storageService.smartAttach(sanitizedId, escapedPath);
        console.log(`[AC] Attached main dataset: ${sanitizedId}`);
      }

      const sanitizedDictId = sanitizeDatasetId(dictDatasetId);
      const dictDataset = await this.metadataService.getDatasetInfo(sanitizedDictId);
      if (dictDataset) {
        const escapedPath = dictDataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await this.storageService.smartAttach(sanitizedDictId, escapedPath);
        console.log(`[AC] Attached dictionary dataset: ${sanitizedDictId}`);
      }

      // 步骤1: 加载词库
      const escapedDictField = `"${dictField.replace(/"/g, '""')}"`;

      const dictTable = quoteQualifiedName(`ds_${sanitizedDictId}`, 'data');
      const wordsSQL = `SELECT ${escapedDictField} as word FROM ${dictTable}`;
      const wordsResult = await this.conn.runAndReadAll(wordsSQL);
      const words = parseRows(wordsResult)
        .map((row) => String(row.word || ''))
        .filter((w) => w.length > 0);

      console.log(`[AC] Loaded ${words.length} words in ${Date.now() - startTime}ms`);

      if (words.length === 0) {
        console.warn('[AC] Dictionary is empty, returning empty result');
        return [];
      }

      // 步骤2: 构建 Aho-Corasick 自动机
      const acStartTime = Date.now();
      const ac = new AhoCorasick();
      for (const word of words) {
        ac.add(word, word);
      }
      ac.build_fail();
      console.log(`[AC] AC automaton built in ${Date.now() - acStartTime}ms`);

      // 步骤3: 分批处理主数据集
      const BATCH_SIZE = 10000; // 每批处理10000行，避免内存溢出
      const matchedRowIds: number[] = [];

      const escapedTargetField = `"${targetField.replace(/"/g, '""')}"`;

      let offset = 0;
      let totalProcessed = 0;
      let hasMore = true;

      while (hasMore) {
        const batchStartTime = Date.now();

        // 读取一批数据
        const dataTable = quoteQualifiedName(`ds_${sanitizedId}`, 'data');
        const dataSQL = `
          SELECT _row_id, ${escapedTargetField} as text
          FROM ${dataTable}
          LIMIT ${BATCH_SIZE} OFFSET ${offset}
        `;

        const dataResult = await this.conn.runAndReadAll(dataSQL);
        const rows = parseRows(dataResult);

        if (rows.length === 0) {
          hasMore = false;
          break;
        }

        // 使用 AC 算法匹配当前批次
        for (const row of rows) {
          const text = String(row.text || '');
          let hasMatch = false;
          ac.search(text, () => {
            hasMatch = true;
          });

          // 根据黑名单/白名单模式决定是否保留该行
          if (isBlacklist) {
            // 黑名单模式：不包含任何词的行才保留
            if (!hasMatch) {
              matchedRowIds.push(Number(row._row_id));
            }
          } else {
            // 白名单模式：包含任意词的行才保留
            if (hasMatch) {
              matchedRowIds.push(Number(row._row_id));
            }
          }
        }

        totalProcessed += rows.length;
        offset += BATCH_SIZE;

        console.log(
          `[AC] Batch ${Math.floor(offset / BATCH_SIZE)}: processed ${rows.length} rows in ${Date.now() - batchStartTime}ms, total matched: ${matchedRowIds.length}/${totalProcessed}`
        );
      }

      const totalTime = Date.now() - startTime;
      console.log(
        `[AC] Filtering completed: ${matchedRowIds.length} matched out of ${totalProcessed} rows in ${totalTime}ms`
      );

      return matchedRowIds;
    });
  }

  /**
   * ?? 创建 Aho-Corasick 临时 row_id 表
   */
  async createTempRowIdTable(
    datasetId: string,
    tableName: string,
    rowIds: number[]
  ): Promise<void> {
    if (!rowIds || rowIds.length === 0) {
      throw new Error('No row IDs provided for temp table');
    }

    const invalidRowId = rowIds.find((id) => !Number.isInteger(id) || id < 0);
    if (invalidRowId !== undefined) {
      throw new Error(`Invalid row ID: ${invalidRowId}`);
    }

    const sanitizedId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(sanitizedId, async () => {
      const tempTable = quoteIdentifier(tableName);

      await this.conn.run(`DROP TABLE IF EXISTS ${tempTable}`);
      await this.conn.run(`CREATE TEMP TABLE ${tempTable} (_row_id BIGINT)`);

      await this.conn.run('BEGIN TRANSACTION');
      try {
        for (let i = 0; i < rowIds.length; i += AC_ROW_ID_INSERT_BATCH_SIZE) {
          const batch = rowIds.slice(i, i + AC_ROW_ID_INSERT_BATCH_SIZE);
          const values = batch.map((id) => `(${id})`).join(',');
          await this.conn.run(`INSERT INTO ${tempTable} VALUES ${values}`);
        }
        await this.conn.run('COMMIT');
      } catch (error) {
        try {
          await this.conn.run('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw error;
      }
    });
  }

  /**
   * ?? 删除 Aho-Corasick 临时 row_id 表
   */
  async dropTempRowIdTable(datasetId: string, tableName: string): Promise<void> {
    const sanitizedId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(sanitizedId, async () => {
      const tempTable = quoteIdentifier(tableName);
      await this.conn.run(`DROP TABLE IF EXISTS ${tempTable}`);
    });
  }
}
