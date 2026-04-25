/**
 * 采样 Builder
 * 支持百分比采样、固定行数采样、分层采样
 */

import { SyncQueryBuilder } from '../interfaces/IQueryBuilder';
import type { SQLContext, SampleConfig } from '../types';
import { QueryErrorFactory } from '../errors';
import { SQLUtils } from '../utils/sql-utils';

export class SampleBuilder extends SyncQueryBuilder<SampleConfig> {
  private static readonly HASH_BUCKETS = 1_000_000;

  /**
   * 构建采样 SQL
   */
  protected buildSync(context: SQLContext, config: SampleConfig): string {
    const { type } = config;

    // 验证配置
    this.validateConfig(config);

    // 1. 简单采样（percentage / rows）
    if (type === 'percentage' || type === 'rows') {
      return this.buildSimpleSample(context, config);
    }

    // 2. 分层采样（stratified）
    if (type === 'stratified') {
      return this.buildStratifiedSample(context, config);
    }

    throw new Error(`Unsupported sample type: ${type}`);
  }

  /**
   * 构建简单采样 SQL（百分比或固定行数）
   */
  private buildSimpleSample(context: SQLContext, config: SampleConfig): string {
    const { type, value, seed } = config;

    const rowIdColumn = context.availableColumns.has('_row_id') ? '_row_id' : null;

    if (seed !== undefined && rowIdColumn) {
      const escapedRowId = SQLUtils.escapeIdentifier(rowIdColumn);
      if (type === 'percentage') {
        const pct = value ?? 10;
        const threshold = pct * (SampleBuilder.HASH_BUCKETS / 100);
        return `SELECT * FROM ${context.currentTable} WHERE (abs(hash(${escapedRowId}, ${seed})) % ${SampleBuilder.HASH_BUCKETS}) < ${threshold}`.trim();
      }
      if (type === 'rows') {
        const rows = value ?? 1000;
        return `SELECT * FROM ${context.currentTable} ORDER BY hash(${escapedRowId}, ${seed}) LIMIT ${rows}`.trim();
      }
    } else if (seed !== undefined) {
      console.warn(
        '[SampleBuilder] Seeded sampling requires _row_id; falling back to non-deterministic sampling.'
      );
    }

    let sampleClause = '';
    if (type === 'percentage') {
      const pct = value ?? 10;
      sampleClause = `USING SAMPLE ${pct}%`;
    } else if (type === 'rows') {
      const rows = value ?? 1000;
      sampleClause = `USING SAMPLE ${rows} ROWS`;
    }

    return `SELECT * FROM ${context.currentTable} ${sampleClause}`.trim();
  }

  /**
   * 构建分层采样 SQL
   * 使用 ROW_NUMBER() OVER (PARTITION BY ...) 实现
   */
  private buildStratifiedSample(context: SQLContext, config: SampleConfig): string {
    const { stratifyBy, value, seed } = config;

    if (!stratifyBy || stratifyBy.length === 0) {
      throw new Error('Stratified sample requires stratifyBy fields');
    }

    for (const field of stratifyBy) {
      if (!context.availableColumns.has(field)) {
        throw QueryErrorFactory.fieldNotFound(field, Array.from(context.availableColumns));
      }
    }

    const partitionBy = stratifyBy.map((f) => SQLUtils.escapeIdentifier(f)).join(', ');
    const limit = value ?? 100;
    const rowIdColumn = context.availableColumns.has('_row_id') ? '_row_id' : null;
    const orderBy =
      seed !== undefined && rowIdColumn
        ? `hash(${SQLUtils.escapeIdentifier(rowIdColumn)}, ${seed})`
        : 'RANDOM()';

    if (seed !== undefined && !rowIdColumn) {
      console.warn(
        '[SampleBuilder] Seeded stratified sampling requires _row_id; falling back to non-deterministic ordering.'
      );
    }

    // 获取所有可用列（排除技术列）
    const columns = Array.from(context.availableColumns)
      .map((col) => SQLUtils.escapeIdentifier(col))
      .join(', ');

    return `
      SELECT ${columns}
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ORDER BY ${orderBy}) AS _sample_rn
        FROM ${context.currentTable}
      ) AS _sampled
      WHERE _sample_rn <= ${limit}
    `.trim();
  }

  /**
   * 获取结果列集合（采样不改变列结构）
   */
  protected getResultColumnsSync(context: SQLContext, _config: SampleConfig): Set<string> {
    // 采样不改变列结构，直接返回原列集合
    return context.availableColumns;
  }

  /**
   * 验证配置
   */
  private validateConfig(config: SampleConfig): void {
    const { type, value, stratifyBy } = config;

    // 安全限制常量
    const MAX_SAMPLE_ROWS = 10_000_000; // 最多采样1000万行
    const MIN_SAMPLE_PERCENTAGE = 0.001; // 最小0.001%
    const MAX_SAMPLE_PERCENTAGE = 99.9; // 最大99.9%（建议100%直接查询全量）
    const WARN_SAMPLE_PERCENTAGE = 80; // 超过80%会警告

    // 1. 验证 type
    if (!['percentage', 'rows', 'stratified'].includes(type)) {
      throw new Error(`Invalid sample type: ${type}`);
    }

    // 2. 验证 value
    if (type === 'percentage') {
      if (value === undefined) {
        throw new Error('Sample percentage requires a value');
      }

      // 🆕 严格范围检查
      if (value < MIN_SAMPLE_PERCENTAGE) {
        throw new Error(
          `采样百分比太小（${value}%），最小值: ${MIN_SAMPLE_PERCENTAGE}%。` +
            `这可能导致数据不具代表性。`
        );
      }
      if (value > MAX_SAMPLE_PERCENTAGE) {
        throw new Error(
          `采样百分比过高（${value}%），最大值: ${MAX_SAMPLE_PERCENTAGE}%。` +
            `如需查看全部数据，请直接清除采样配置。`
        );
      }
      if (!SQLUtils.isInRange(value, 0, 100)) {
        throw new Error(`Sample percentage must be between 0 and 100, got ${value}`);
      }

      // 🆕 性能警告
      if (value > WARN_SAMPLE_PERCENTAGE) {
        console.warn(
          `[SampleBuilder] 采样百分比较高(${value}%)，可能无法显著提升性能。` +
            `建议：如需查看大部分数据，考虑直接查询全量。`
        );
      }
    } else if (type === 'rows') {
      if (value === undefined) {
        throw new Error('Sample rows requires a value');
      }
      if (value <= 0) {
        throw new Error(`Sample rows must be positive, got ${value}`);
      }
      if (!Number.isInteger(value)) {
        throw new Error(`Sample rows must be an integer, got ${value}`);
      }

      // 🆕 最大行数限制
      if (value > MAX_SAMPLE_ROWS) {
        throw new Error(
          `采样行数超过上限（${value.toLocaleString()} 行），最大允许: ${MAX_SAMPLE_ROWS.toLocaleString()} 行。` +
            `建议：对于大数据集，请使用百分比采样。`
        );
      }

      // 🆕 合理性警告
      if (value > 1_000_000) {
        console.warn(
          `[SampleBuilder] 采样行数较大(${value.toLocaleString()})，可能影响性能和内存使用。` +
            `建议：考虑降低采样数量或使用百分比采样。`
        );
      }
    } else if (type === 'stratified') {
      if (!stratifyBy || stratifyBy.length === 0) {
        throw new Error('Stratified sample requires stratifyBy fields');
      }
      if (value !== undefined && value <= 0) {
        throw new Error(`Stratified sample limit must be positive, got ${value}`);
      }

      // 🆕 分层采样限制
      if (value !== undefined && value > 100_000) {
        console.warn(
          `[SampleBuilder] 分层采样每组行数较大(${value.toLocaleString()})，` +
            `在高基数字段上可能导致内存问题。建议每组不超过10,000行。`
        );
      }

      // 🆕 分层字段数量限制
      if (stratifyBy.length > 5) {
        console.warn(
          `[SampleBuilder] 分层字段过多(${stratifyBy.length}个)，` +
            `会产生大量分组，可能影响性能。建议不超过3个字段。`
        );
      }
    }

    // 3. 验证 seed（可选）
    if (config.seed !== undefined) {
      if (config.seed < 0) {
        throw new Error(`Sample seed must be non-negative, got ${config.seed}`);
      }
      if (!Number.isInteger(config.seed)) {
        throw new Error(`Sample seed must be an integer, got ${config.seed}`);
      }
    }
  }
}
