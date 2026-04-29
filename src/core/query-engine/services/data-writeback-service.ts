/**
 * 数据落库服务 (Data Writeback)
 * 支持将查询结果写回数据库，包括新建表、插入、更新等操作
 */

import type { IQueryDuckDBService } from '../interfaces/IQueryDuckDBService';
import { SQLUtils } from '../utils/sql-utils';
import { createValidator } from '../validators/common-validators';

/**
 * 写回模式
 */
export type WritebackMode =
  | 'create' // 创建新表（如果存在则失败）
  | 'replace' // 替换现有表
  | 'append' // 追加到现有表
  | 'upsert'; // 更新或插入（基于主键）

/**
 * 软删除配置
 */
export interface SoftDeleteConfig {
  /** 启用软删除 */
  enabled: boolean;
  /** 软删除标记列名 */
  columnName?: string; // 默认: 'deleted_at'
  /** 软删除标记值（NULL = 未删除，timestamp = 已删除） */
  valueType?: 'timestamp' | 'boolean'; // 默认: 'timestamp'
}

/**
 * 审计日志配置
 */
export interface AuditConfig {
  /** 启用审计日志 */
  enabled: boolean;
  /** 创建时间列名 */
  createdAtColumn?: string; // 默认: 'created_at'
  /** 更新时间列名 */
  updatedAtColumn?: string; // 默认: 'updated_at'
  /** 创建人列名（可选） */
  createdByColumn?: string;
  /** 更新人列名（可选） */
  updatedByColumn?: string;
  /** 当前用户ID（用于填充创建人/更新人） */
  currentUserId?: string;
}

/**
 * 写回配置
 */
export interface WritebackConfig {
  /** 源数据集ID（来自 QueryEngine 或其他服务） */
  sourceDatasetId: string;

  /** 目标表名 */
  targetTable: string;

  /** 写回模式 */
  mode: WritebackMode;

  /** 主键列（用于 upsert 模式） */
  primaryKeys?: string[];

  /** 列映射（源列 -> 目标列） */
  columnMapping?: Record<string, string>;

  /** 软删除配置（可选） */
  softDelete?: SoftDeleteConfig;

  /** 审计日志配置（可选） */
  audit?: AuditConfig;

  /** 批量写入大小（默认 1000） */
  batchSize?: number;

  /** 启用事务（默认 true） */
  useTransaction?: boolean;

  /** 清理源数据（写入后删除临时视图，默认 false） */
  cleanupSource?: boolean;
}

/**
 * 写回结果
 */
export interface WritebackResult {
  success: boolean;
  /** 目标表名 */
  targetTable?: string;
  /** 写入的行数 */
  rowsAffected?: number;
  /** 执行时间（毫秒） */
  executionTime?: number;
  /** 回滚点名称（用于手动回滚） */
  savepointName?: string;
  error?: string;
}

/**
 * 数据落库服务
 *
 * 功能：
 * - CREATE TABLE AS SELECT (创建新表)
 * - INSERT INTO (追加数据)
 * - UPSERT (更新或插入)
 * - REPLACE (替换表)
 * - 软删除支持
 * - 审计日志（created_at, updated_at, created_by, updated_by）
 * - 事务管理
 * - 批量写入
 * - 回滚机制
 *
 * @example
 * ```typescript
 * const writebackService = new DataWritebackService(duckdbService);
 *
 * // 创建新表
 * const result = await writebackService.writeback({
 *   sourceDatasetId: 'cleaned_sales',
 *   targetTable: 'sales_final',
 *   mode: 'create',
 *   audit: { enabled: true, currentUserId: 'user123' }
 * });
 *
 * // Upsert（更新或插入）
 * const upsertResult = await writebackService.writeback({
 *   sourceDatasetId: 'updated_products',
 *   targetTable: 'products',
 *   mode: 'upsert',
 *   primaryKeys: ['product_id'],
 *   audit: { enabled: true }
 * });
 *
 * // 回滚（如果需要）
 * await writebackService.rollback(result.savepointName!);
 * ```
 */
export class DataWritebackService {
  constructor(private duckdbService: IQueryDuckDBService) {}

  /**
   * 执行数据写回操作
   */
  async writeback(config: WritebackConfig): Promise<WritebackResult> {
    const startTime = Date.now();
    let savepointName: string | undefined;

    try {
      // 1. 验证配置
      this.validateConfig(config);

      // 2. 验证源数据集存在
      const sourceDataset = await this.duckdbService.getDatasetInfo(config.sourceDatasetId);
      if (!sourceDataset || !sourceDataset.schema) {
        throw new Error(`Source dataset not found: ${config.sourceDatasetId}`);
      }

      // 3. 启动事务（如果配置了）
      const useTransaction = config.useTransaction ?? true;
      if (useTransaction) {
        savepointName = `savepoint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await this.duckdbService.executeWithParams(`SAVEPOINT ${savepointName}`, []);
        console.log(`[DataWritebackService] Created savepoint: ${savepointName}`);
      }

      // 4. 根据模式执行写回
      let rowsAffected = 0;

      switch (config.mode) {
        case 'create':
          rowsAffected = await this.createTable(config, sourceDataset.schema);
          break;

        case 'replace':
          rowsAffected = await this.replaceTable(config, sourceDataset.schema);
          break;

        case 'append':
          rowsAffected = await this.appendData(config);
          break;

        case 'upsert':
          rowsAffected = await this.upsertData(config);
          break;

        default:
          throw new Error(`Unsupported writeback mode: ${config.mode}`);
      }

      // 5. 清理源数据（如果配置了）
      if (config.cleanupSource) {
        await this.cleanupSourceDataset(config.sourceDatasetId);
      }

      const executionTime = Date.now() - startTime;
      console.log(`[DataWritebackService] Writeback completed: ${rowsAffected} rows affected`);

      return {
        success: true,
        targetTable: config.targetTable,
        rowsAffected,
        executionTime,
        savepointName,
      };
    } catch (error) {
      // 自动回滚（如果启用了事务）
      if (savepointName) {
        try {
          await this.duckdbService.executeWithParams(`ROLLBACK TO SAVEPOINT ${savepointName}`, []);
          console.log(`[DataWritebackService] Rolled back to savepoint: ${savepointName}`);
        } catch (rollbackError) {
          console.error(`[DataWritebackService] Rollback error:`, rollbackError);
        }
      }

      const executionTime = Date.now() - startTime;
      console.error(`[DataWritebackService] Writeback error:`, error);

      return {
        success: false,
        error: (error as Error).message,
        executionTime,
      };
    }
  }

  /**
   * 手动回滚到指定的保存点
   */
  async rollback(savepointName: string): Promise<void> {
    try {
      await this.duckdbService.executeWithParams(`ROLLBACK TO SAVEPOINT ${savepointName}`, []);
      console.log(`[DataWritebackService] Rolled back to savepoint: ${savepointName}`);
    } catch (error) {
      console.error(`[DataWritebackService] Rollback error:`, error);
      throw error;
    }
  }

  /**
   * 释放保存点
   */
  async releaseSavepoint(savepointName: string): Promise<void> {
    try {
      await this.duckdbService.executeWithParams(`RELEASE SAVEPOINT ${savepointName}`, []);
      console.log(`[DataWritebackService] Released savepoint: ${savepointName}`);
    } catch (error) {
      console.error(`[DataWritebackService] Release savepoint error:`, error);
      throw error;
    }
  }

  /**
   * 创建新表
   */
  private async createTable(config: WritebackConfig, schema: any[]): Promise<number> {
    const { targetTable, columnMapping, softDelete, audit } = config;

    // 构建列定义
    const _columnDefs = this.buildColumnDefinitions(schema, columnMapping, softDelete, audit);

    // 构建 SELECT 语句
    const selectSQL = this.buildSelectStatement(config, schema);

    // CREATE TABLE AS SELECT
    const sql = `
      CREATE TABLE ${SQLUtils.escapeIdentifier(targetTable)} AS
      ${selectSQL}
    `;

    await this.duckdbService.executeWithParams(sql, []);

    // 获取插入的行数
    const countResult = await this.duckdbService.executeSQLWithParams(
      `SELECT COUNT(*) as count FROM ${SQLUtils.escapeIdentifier(targetTable)}`,
      []
    );

    return countResult[0]?.count ?? 0;
  }

  /**
   * 替换表
   */
  private async replaceTable(config: WritebackConfig, schema: any[]): Promise<number> {
    const { targetTable } = config;

    // 删除旧表
    await this.duckdbService.executeWithParams(
      `DROP TABLE IF EXISTS ${SQLUtils.escapeIdentifier(targetTable)}`,
      []
    );

    // 创建新表
    return this.createTable(config, schema);
  }

  /**
   * 追加数据
   */
  private async appendData(config: WritebackConfig): Promise<number> {
    const { sourceDatasetId, targetTable } = config;
    const sourceTableName =
      SQLUtils.escapeIdentifier('ds_' + sourceDatasetId) + '.' + SQLUtils.escapeIdentifier('data');

    // 构建 INSERT 语句
    const selectSQL = this.buildSelectStatement(config, []);

    const sql = `
      INSERT INTO ${SQLUtils.escapeIdentifier(targetTable)}
      ${selectSQL}
    `;

    await this.duckdbService.executeWithParams(sql, []);

    // 获取插入的行数（从源数据集）
    const countResult = await this.duckdbService.executeSQLWithParams(
      `SELECT COUNT(*) as count FROM ${sourceTableName}`,
      []
    );

    return countResult[0]?.count ?? 0;
  }

  /**
   * Upsert 数据（更新或插入）
   */
  private async upsertData(config: WritebackConfig): Promise<number> {
    const { sourceDatasetId, targetTable, primaryKeys, columnMapping } = config;
    const sourceTableName =
      SQLUtils.escapeIdentifier('ds_' + sourceDatasetId) + '.' + SQLUtils.escapeIdentifier('data');

    if (!primaryKeys || primaryKeys.length === 0) {
      throw new Error('Upsert mode requires primaryKeys');
    }

    // DuckDB 不直接支持 UPSERT，使用 INSERT OR REPLACE
    // 或者使用 DELETE + INSERT 策略

    // 策略：先删除冲突的行，再插入新行
    const pkConditions = primaryKeys
      .map((pk) => {
        const targetPk = columnMapping?.[pk] ?? pk;
        return `t.${SQLUtils.escapeIdentifier(targetPk)} = s.${SQLUtils.escapeIdentifier(pk)}`;
      })
      .join(' AND ');

    // 1. 删除冲突的行
    await this.duckdbService.executeWithParams(
      `
      DELETE FROM ${SQLUtils.escapeIdentifier(targetTable)} t
      WHERE EXISTS (
        SELECT 1 FROM ${sourceTableName} s
        WHERE ${pkConditions}
      )
    `,
      []
    );

    // 2. 插入新行
    return this.appendData(config);
  }

  /**
   * 构建列定义（用于 CREATE TABLE）
   */
  private buildColumnDefinitions(
    schema: any[],
    columnMapping?: Record<string, string>,
    softDelete?: SoftDeleteConfig,
    audit?: AuditConfig
  ): string[] {
    const columnDefs: string[] = [];

    // 1. 原始列
    schema.forEach((col) => {
      const targetName = columnMapping?.[col.name] ?? col.name;
      columnDefs.push(`${SQLUtils.escapeIdentifier(targetName)} ${col.type}`);
    });

    // 2. 软删除列
    if (softDelete?.enabled) {
      const deletedAtCol = softDelete.columnName ?? 'deleted_at';
      const colType = softDelete.valueType === 'boolean' ? 'BOOLEAN' : 'TIMESTAMP';
      columnDefs.push(`${SQLUtils.escapeIdentifier(deletedAtCol)} ${colType}`);
    }

    // 3. 审计列
    if (audit?.enabled) {
      const createdAtCol = audit.createdAtColumn ?? 'created_at';
      const updatedAtCol = audit.updatedAtColumn ?? 'updated_at';

      columnDefs.push(`${SQLUtils.escapeIdentifier(createdAtCol)} TIMESTAMP`);
      columnDefs.push(`${SQLUtils.escapeIdentifier(updatedAtCol)} TIMESTAMP`);

      if (audit.createdByColumn) {
        columnDefs.push(`${SQLUtils.escapeIdentifier(audit.createdByColumn)} VARCHAR`);
      }

      if (audit.updatedByColumn) {
        columnDefs.push(`${SQLUtils.escapeIdentifier(audit.updatedByColumn)} VARCHAR`);
      }
    }

    return columnDefs;
  }

  /**
   * 构建 SELECT 语句
   */
  private buildSelectStatement(config: WritebackConfig, schema: any[]): string {
    const { sourceDatasetId, columnMapping, softDelete, audit } = config;
    const sourceTableName =
      SQLUtils.escapeIdentifier('ds_' + sourceDatasetId) + '.' + SQLUtils.escapeIdentifier('data');

    const selectItems: string[] = [];

    // 1. 原始列（如果有 schema）
    if (schema.length > 0) {
      schema.forEach((col) => {
        const sourceName = col.name;
        const targetName = columnMapping?.[sourceName] ?? sourceName;

        if (targetName !== sourceName) {
          selectItems.push(
            `${SQLUtils.escapeIdentifier(sourceName)} AS ${SQLUtils.escapeIdentifier(targetName)}`
          );
        } else {
          selectItems.push(SQLUtils.escapeIdentifier(sourceName));
        }
      });
    } else {
      // 没有 schema（append/upsert），选择所有列
      selectItems.push('*');
    }

    // 2. 软删除列（初始值为 NULL 或 false）
    if (softDelete?.enabled) {
      const deletedAtCol = softDelete.columnName ?? 'deleted_at';
      const initialValue = softDelete.valueType === 'boolean' ? 'false' : 'NULL';
      selectItems.push(`${initialValue} AS ${SQLUtils.escapeIdentifier(deletedAtCol)}`);
    }

    // 3. 审计列
    if (audit?.enabled) {
      const createdAtCol = audit.createdAtColumn ?? 'created_at';
      const updatedAtCol = audit.updatedAtColumn ?? 'updated_at';

      selectItems.push(`CURRENT_TIMESTAMP AS ${SQLUtils.escapeIdentifier(createdAtCol)}`);
      selectItems.push(`CURRENT_TIMESTAMP AS ${SQLUtils.escapeIdentifier(updatedAtCol)}`);

      if (audit.createdByColumn) {
        const userId = audit.currentUserId ? SQLUtils.quoteValue(audit.currentUserId) : 'NULL';
        selectItems.push(`${userId} AS ${SQLUtils.escapeIdentifier(audit.createdByColumn)}`);
      }

      if (audit.updatedByColumn) {
        const userId = audit.currentUserId ? SQLUtils.quoteValue(audit.currentUserId) : 'NULL';
        selectItems.push(`${userId} AS ${SQLUtils.escapeIdentifier(audit.updatedByColumn)}`);
      }
    }

    return `SELECT ${selectItems.join(', ')} FROM ${sourceTableName}`;
  }

  /**
   * 清理源数据集（删除临时视图）
   */
  private async cleanupSourceDataset(sourceDatasetId: string): Promise<void> {
    try {
      // 只清理临时视图（名称包含 _view_）
      if (sourceDatasetId.includes('_view_')) {
        await this.duckdbService.executeWithParams(
          `DROP VIEW IF EXISTS ${SQLUtils.escapeIdentifier(sourceDatasetId)}`,
          []
        );
        console.log(`[DataWritebackService] Cleaned up source view: ${sourceDatasetId}`);
      }
    } catch (error) {
      console.warn(`[DataWritebackService] Cleanup error (non-fatal):`, error);
      // 清理失败不影响主流程
    }
  }

  /**
   * 验证配置
   */
  private validateConfig(config: WritebackConfig): void {
    createValidator('Writeback')
      .required(config.sourceDatasetId, 'sourceDatasetId')
      .required(config.targetTable, 'targetTable')
      .enum(config.mode, ['create', 'replace', 'append', 'upsert'], 'mode')
      .conditionalRequired(config.mode, 'upsert', config.primaryKeys, 'primaryKeys')
      .positiveNumber(config.batchSize, 'batchSize')
      .throwIfInvalid();
  }
}
