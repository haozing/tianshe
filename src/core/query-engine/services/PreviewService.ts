/**
 * PreviewService
 * 负责所有预览相关的功能，从QueryEngine中分离出来
 *
 * 主要职责：
 * - 数据清洗预览
 * - SQL预览
 * - 去重预览
 * - 筛选计数预览
 * - 聚合预览
 * - 采样预览
 * - 关联预览
 * - 计算表达式验证
 * - 分组预览
 */

import type { IQueryDuckDBService } from '../interfaces/IQueryDuckDBService';
import type { ILogger } from '../utils/logger';
import type {
  CleanConfig,
  DedupeConfig,
  FilterConfig,
  FilterPreviewResult,
  AggregateConfig,
  SampleConfig,
  LookupConfig,
  GroupConfig,
  AggregatePreviewResult,
  SamplePreviewResult,
  LookupPreviewCore,
  LookupPreviewResult,
  LookupPreviewStep,
  GroupPreviewResult,
  SQLContext,
  QueryConfig,
} from '../types';

import type { CleanBuilder } from '../builders/CleanBuilder';
import type { DedupeBuilder } from '../builders/DedupeBuilder';
import type { FilterBuilder } from '../builders/FilterBuilder';
import type { AggregateBuilder } from '../builders/AggregateBuilder';
import type { SampleBuilder } from '../builders/SampleBuilder';
import type { LookupBuilder } from '../builders/LookupBuilder';
import type { ComputeBuilder } from '../builders/ComputeBuilder';
import type { GroupBuilder } from '../builders/GroupBuilder';
import { SQLUtils } from '../utils/sql-utils';
import { normalizeRuntimeSQL } from '../../../utils/query-runtime';

/**
 * PreviewService构造器参数
 */
export interface PreviewServiceDependencies {
  duckdbService: IQueryDuckDBService;
  logger: ILogger;
  builders: {
    clean: CleanBuilder;
    dedupe: DedupeBuilder;
    filter: FilterBuilder;
    aggregate: AggregateBuilder;
    sample: SampleBuilder;
    lookup: LookupBuilder;
    compute: ComputeBuilder;
    group: GroupBuilder;
  };
  createBaseContext: (datasetId: string) => Promise<SQLContext>;
  createDedupePreviewContext: (datasetId: string, config: QueryConfig) => Promise<SQLContext>;
  buildQuerySQL: (datasetId: string, config: QueryConfig) => Promise<string>;
}

/**
 * 预览服务类
 * 提供各种数据预览功能
 */
export class PreviewService {
  private duckdbService: IQueryDuckDBService;
  private logger: ILogger;
  private builders: PreviewServiceDependencies['builders'];
  private createBaseContext: (datasetId: string) => Promise<SQLContext>;
  private createDedupePreviewContext: (
    datasetId: string,
    config: QueryConfig
  ) => Promise<SQLContext>;
  private buildQuerySQL: (datasetId: string, config: QueryConfig) => Promise<string>;

  constructor(dependencies: PreviewServiceDependencies) {
    this.duckdbService = dependencies.duckdbService;
    this.logger = dependencies.logger;
    this.builders = dependencies.builders;
    this.createBaseContext = dependencies.createBaseContext;
    this.createDedupePreviewContext = dependencies.createDedupePreviewContext;
    this.buildQuerySQL = dependencies.buildQuerySQL;

    this.logger.info('PreviewService initialized');
  }

  private async createPreviewContext(datasetId: string): Promise<SQLContext> {
    return this.createBaseContext(datasetId);
  }

  private buildPreviewSQL(
    context: SQLContext,
    sql: string,
    extraCTEs: Array<{ name: string; sql: string }> = []
  ): string {
    const allCTEs = [...context.ctes, ...extraCTEs];
    if (allCTEs.length === 0) {
      return sql.trim();
    }

    const cteStatements = allCTEs.map((cte) => `${cte.name} AS (\n  ${cte.sql}\n)`).join(',\n');
    return `WITH ${cteStatements}\n${sql.trim()}`;
  }

  private isFilterConfig(value: QueryConfig | FilterConfig | undefined): value is FilterConfig {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as FilterConfig & QueryConfig;
    return (
      (Array.isArray(candidate.conditions) || typeof candidate.combinator === 'string') &&
      candidate.filter === undefined &&
      candidate.sort === undefined &&
      candidate.clean === undefined &&
      candidate.lookup === undefined &&
      candidate.compute === undefined &&
      candidate.dedupe === undefined &&
      candidate.group === undefined &&
      candidate.aggregate === undefined &&
      candidate.sample === undefined &&
      candidate.columns === undefined
    );
  }

  private cloneQueryConfig(config?: QueryConfig): QueryConfig {
    return config ? (JSON.parse(JSON.stringify(config)) as QueryConfig) : {};
  }

  private resolveSamplePreviewConfig(
    sampleConfig: SampleConfig,
    scopeConfig?: QueryConfig | FilterConfig
  ): QueryConfig {
    if (!scopeConfig) {
      return { sample: sampleConfig };
    }

    if (this.isFilterConfig(scopeConfig)) {
      return {
        filter: scopeConfig,
        sample: sampleConfig,
      };
    }

    const queryConfig = this.cloneQueryConfig(scopeConfig);
    return {
      ...queryConfig,
      sample: sampleConfig,
    };
  }

  private async countPreviewRows(sql: string, alias: string): Promise<number> {
    const rows = await this.duckdbService.executeSQLWithParams(
      `SELECT COUNT(*) AS total FROM (${sql}) AS ${SQLUtils.escapeIdentifier(alias)}`,
      []
    );

    return Number(rows?.[0]?.total ?? 0);
  }

  private async computeStratifiedSampleQuality(
    baseSQL: string,
    sampleSQL: string,
    sampleConfig: SampleConfig,
    originalRows: number,
    selectedRows: number
  ): Promise<SamplePreviewResult['quality']> {
    if (
      sampleConfig.type !== 'stratified' ||
      !sampleConfig.stratifyBy ||
      sampleConfig.stratifyBy.length === 0 ||
      originalRows <= 0 ||
      selectedRows <= 0
    ) {
      return undefined;
    }

    const groupExpr = `concat_ws(${SQLUtils.quoteValue('¦')}, ${sampleConfig.stratifyBy
      .map((field) => {
        const escapedField = SQLUtils.escapeIdentifier(field);
        return `COALESCE(CAST(source.${escapedField} AS VARCHAR), ${SQLUtils.quoteValue('__NULL__')})`;
      })
      .join(', ')})`;

    const loadDistribution = async (sql: string) => {
      return await this.duckdbService.executeSQLWithParams(
        `
          SELECT ${groupExpr} AS __group_key, COUNT(*) AS __group_count
          FROM (${sql}) AS source
          GROUP BY 1
        `,
        []
      );
    };

    let baseDistribution: any[] = [];
    let sampledDistribution: any[] = [];

    try {
      [baseDistribution, sampledDistribution] = await Promise.all([
        loadDistribution(baseSQL),
        loadDistribution(sampleSQL),
      ]);
    } catch (error) {
      this.logger.warn('Failed to compute stratified sample quality, skipping metrics:', error);
      return undefined;
    }

    const baseCounts = new Map<string, number>();
    const sampledCounts = new Map<string, number>();

    baseDistribution.forEach((row) => {
      baseCounts.set(String(row.__group_key ?? ''), Number(row.__group_count ?? 0));
    });
    sampledDistribution.forEach((row) => {
      sampledCounts.set(String(row.__group_key ?? ''), Number(row.__group_count ?? 0));
    });

    const allGroupKeys = new Set<string>([...baseCounts.keys(), ...sampledCounts.keys()]);
    const coverageScore =
      baseCounts.size > 0 ? Math.min(1, sampledCounts.size / baseCounts.size) : 1;

    let totalVariation = 0;
    allGroupKeys.forEach((groupKey) => {
      const baseRatio = (baseCounts.get(groupKey) ?? 0) / originalRows;
      const sampledRatio = (sampledCounts.get(groupKey) ?? 0) / selectedRows;
      totalVariation += Math.abs(baseRatio - sampledRatio);
    });

    const distributionScore = Math.max(0, 1 - totalVariation / 2);
    const representativeness = Math.max(
      0,
      Math.min(1, Number((coverageScore * distributionScore).toFixed(4)))
    );

    let distributionMatch = '分布偏差较大';
    if (distributionScore >= 0.95) {
      distributionMatch = '分布高度接近';
    } else if (distributionScore >= 0.85) {
      distributionMatch = '分布较为接近';
    } else if (distributionScore >= 0.7) {
      distributionMatch = '分布基本可接受';
    }

    return {
      representativeness,
      distributionMatch,
    };
  }

  // ==================== 预览方法 ====================

  /**
   * 预览清洗结果（对比原始值和清洗后的值）
   */
  async previewClean(
    datasetId: string,
    config: CleanConfig,
    options: import('../types').CleanPreviewOptions = {}
  ): Promise<import('../types').CleanPreviewResult> {
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    const context = await this.createPreviewContext(datasetId);
    const hasStableRowId = context.availableColumns.has('_row_id');
    const stableOrderBy = hasStableRowId
      ? ` ORDER BY ${SQLUtils.escapeIdentifier('_row_id')} ASC`
      : '';

    // 1. 获取原始数据（前 N 行），复用 createBaseContext 以保留持久化计算列等上下文。
    const originalSQL = this.buildPreviewSQL(
      context,
      `SELECT * FROM ${context.currentTable}${stableOrderBy} LIMIT ${limit} OFFSET ${offset}`
    );
    const originalData = await this.duckdbService.executeSQLWithParams(originalSQL, []);

    // 2. 构建清洗 SQL
    const cleanSQL = this.builders.clean.build(context, config);

    // 3. 执行清洗（仅预览，不修改数据）
    const previewSQL = this.buildPreviewSQL(
      context,
      `SELECT * FROM cleaned${stableOrderBy} LIMIT ${limit} OFFSET ${offset}`,
      [{ name: 'cleaned', sql: cleanSQL }]
    );
    const cleanedData = await this.duckdbService.executeSQLWithParams(previewSQL, []);

    // 4. 对比分析：找出哪些字段被修改了
    const affectedFields = new Set(config.map((c) => c.outputField || c.field));
    const changes: import('../types').ChangeRecord[] = [];
    let changedRows = 0;
    let nullsRemoved = 0;
    let nullsAdded = 0;
    const rowChanges = new Set<number>();

    if (hasStableRowId) {
      const originalByRowId = new Map<any, any>(
        originalData.map((row: any) => [row._row_id, row] as const)
      );
      const cleanedByRowId = new Map<any, any>(
        cleanedData.map((row: any) => [row._row_id, row] as const)
      );
      const rowIds = Array.from(
        new Set([...originalByRowId.keys(), ...cleanedByRowId.keys()])
      ).sort((left, right) => Number(left) - Number(right));

      rowIds.forEach((rowId, rowIndex) => {
        const original = originalByRowId.get(rowId) ?? {};
        const cleaned = cleanedByRowId.get(rowId) ?? {};

        for (const field of affectedFields) {
          const originalValue = original[field];
          const cleanedValue = cleaned[field];

          if (originalValue !== cleanedValue) {
            rowChanges.add(rowIndex);
            changes.push({
              rowIndex,
              field,
              originalValue,
              cleanedValue,
              changeType: this.detectChangeType(originalValue, cleanedValue),
            });

            if (originalValue === null || originalValue === undefined) nullsRemoved++;
            if (cleanedValue === null || cleanedValue === undefined) nullsAdded++;
          }
        }
      });
    } else {
      for (let i = 0; i < originalData.length; i++) {
        const original = originalData[i];
        const cleaned = cleanedData[i];

        for (const field of affectedFields) {
          const originalValue = original[field];
          const cleanedValue = cleaned[field];

          if (originalValue !== cleanedValue) {
            rowChanges.add(i);
            changes.push({
              rowIndex: i,
              field,
              originalValue,
              cleanedValue,
              changeType: this.detectChangeType(originalValue, cleanedValue),
            });

            if (originalValue === null || originalValue === undefined) nullsRemoved++;
            if (cleanedValue === null || cleanedValue === undefined) nullsAdded++;
          }
        }
      }
    }

    changedRows = rowChanges.size;

    // 5. 统计信息
    const byField: Record<string, number> = {};
    const byType: Record<import('../types').ChangeType, number> = {
      trimmed: 0,
      case_changed: 0,
      space_normalized: 0,
      null_filled: 0,
      nullified: 0,
      number_formatted: 0,
      type_converted: 0,
      date_parsed: 0,
      other: 0,
    };

    changes.forEach((change) => {
      byField[change.field] = (byField[change.field] || 0) + 1;
      byType[change.changeType]++;
    });

    const stats: import('../types').PreviewStats = {
      totalRows: originalData.length,
      changedRows,
      totalChanges: changes.length,
      nullsRemoved,
      nullsAdded,
      byField,
      byType,
    };

    return {
      originalData,
      cleanedData,
      changes,
      stats,
      sql: cleanSQL,
    };
  }

  /**
   * 检测变更类型（用于UI高亮）
   */
  private detectChangeType(original: any, cleaned: any): import('../types').ChangeType {
    if (original === null || original === undefined) {
      return 'null_filled';
    }
    if (cleaned === null || cleaned === undefined) {
      return 'nullified';
    }

    if (typeof original === 'string' && typeof cleaned === 'string') {
      if (original.trim() !== original && cleaned === original.trim()) {
        return 'trimmed';
      }
      if (original.toLowerCase() === cleaned || original.toUpperCase() === cleaned) {
        return 'case_changed';
      }
      if (original.replace(/\s+/g, ' ') === cleaned) {
        return 'space_normalized';
      }
    }

    if (typeof original === 'number' || typeof cleaned === 'number') {
      return 'number_formatted';
    }

    // 检查是否是日期类型转换
    if (typeof original === 'string' && cleaned instanceof Date) {
      return 'date_parsed';
    }

    // 检查类型是否变化
    if (typeof original !== typeof cleaned) {
      return 'type_converted';
    }

    return 'other';
  }

  // 注意：previewSQL 已迁移到 QueryEngine.previewSQL
  // PreviewService 不再提供此方法，请直接使用 QueryEngine.previewSQL

  /**
   * 预览去重效果（不实际执行去重）
   * 返回详细的统计信息和样本数据
   */
  async previewDedupe(
    datasetId: string,
    config: DedupeConfig,
    options: import('../types').DedupePreviewOptions = {}
  ): Promise<import('../types').DedupePreviewResult> {
    const sampleSize = options.sampleSize ?? 0;
    const limitStats = options.limitStats ?? 10;

    try {
      const context = options.baseConfig
        ? await this.createDedupePreviewContext(datasetId, options.baseConfig)
        : await this.createPreviewContext(datasetId);

      // 1. 构建统计分析SQL
      const statsSQL = this.buildDedupeStatsSQL(context, config, limitStats);
      this.logger.debug('Dedupe stats SQL:', statsSQL);

      const statsResult = await this.duckdbService.executeSQLWithParams(statsSQL, []);

      // 2. 解析统计结果
      const statsRows = Array.isArray(statsResult) ? statsResult : (statsResult as any).rows || [];
      const stats = this.parseDedupeStats(statsRows[0]);

      let keptRows: any[] = [];
      let removedRows: any[] = [];
      if (sampleSize > 0) {
        const { keptSQL, removedSQL } = this.buildDedupeSampleSQL(context, config, sampleSize);
        const keptResult = await this.duckdbService.executeSQLWithParams(keptSQL, []);
        const removedResult = await this.duckdbService.executeSQLWithParams(removedSQL, []);

        keptRows = Array.isArray(keptResult) ? keptResult : (keptResult as any).rows || [];
        removedRows = Array.isArray(removedResult)
          ? removedResult
          : (removedResult as any).rows || [];
      }

      const dedupeSQL = this.builders.dedupe.build(context, config);

      return {
        stats,
        sampleKept: keptRows,
        sampleRemoved: removedRows,
        generatedSQL: this.buildPreviewSQL(context, dedupeSQL),
      };
    } catch (error: unknown) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Preview dedupe failed:', errorObj);
      throw errorObj;
    }
  }

  /**
   * 构建去重统计SQL
   */
  private buildDedupeStatsSQL(
    context: SQLContext,
    config: DedupeConfig,
    limitTopDuplicates: number
  ): string {
    const partitionBy = config.partitionBy.map((f) => SQLUtils.escapeIdentifier(f)).join(', ');
    const partitionFields = config.partitionBy.map((f) => SQLUtils.escapeIdentifier(f)).join(', ');
    const sourceTable = context.currentTable;

    // ✅ 使用共享的排序逻辑，确保预览与执行一致
    const orderByClause = SQLUtils.buildDedupeOrderByClause({
      orderBy: config.orderBy,
      tieBreaker: config.tieBreaker,
      keepStrategy: config.keepStrategy,
    });

    const dedupeAnalysisSQL = `
      SELECT
        *,
        COUNT(*) OVER (PARTITION BY ${partitionBy}) AS _dup_count,
        ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ${orderByClause}) AS _dup_rank
      FROM ${sourceTable}
    `.trim();

    const statsSQL = `
      SELECT
        COUNT(*) AS total_rows,
        COUNT(CASE WHEN _dup_count = 1 THEN 1 END) AS unique_rows,
        SUM(CASE WHEN _dup_count > 1 THEN 1 ELSE 0 END) AS duplicate_rows,
        SUM(CASE WHEN _dup_count > 1 AND _dup_rank = 1 THEN 1 ELSE 0 END) AS duplicate_groups,
        SUM(CASE WHEN _dup_rank > 1 THEN 1 ELSE 0 END) AS will_be_removed,
        SUM(CASE WHEN _dup_rank = 1 THEN 1 ELSE 0 END) AS will_be_kept
      FROM dedupe_analysis
    `.trim();

    const distributionSQL = `
      SELECT
        _dup_count AS group_size,
        COUNT(*) / _dup_count AS count
      FROM dedupe_analysis
      WHERE _dup_count > 1
      GROUP BY _dup_count
      ORDER BY _dup_count
    `.trim();

    const topDuplicatesSQL = `
      SELECT
        ${partitionFields},
        COUNT(*) AS count
      FROM ${sourceTable}
      GROUP BY ${partitionBy}
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT ${limitTopDuplicates}
    `.trim();

    return this.buildPreviewSQL(
      context,
      `
      SELECT
        s.*,
        (SELECT LIST(STRUCT_PACK(group_size := group_size, count := count)) FROM distribution) AS duplicate_distribution,
        (SELECT LIST(STRUCT_PACK(${config.partitionBy.map((f) => `${SQLUtils.escapeIdentifier(f)} := ${SQLUtils.escapeIdentifier(f)}`).join(', ')}, count := count)) FROM top_duplicates) AS top_duplicates
      FROM stats s
    `.trim(),
      [
        { name: 'dedupe_analysis', sql: dedupeAnalysisSQL },
        { name: 'stats', sql: statsSQL },
        { name: 'distribution', sql: distributionSQL },
        { name: 'top_duplicates', sql: topDuplicatesSQL },
      ]
    );
  }

  /**
   * 构建样本数据SQL（保留的和删除的）
   */
  private buildDedupeSampleSQL(
    context: SQLContext,
    config: DedupeConfig,
    sampleSize: number
  ): { keptSQL: string; removedSQL: string } {
    const partitionBy = config.partitionBy.map((f) => SQLUtils.escapeIdentifier(f)).join(', ');
    const sourceTable = context.currentTable;

    // ✅ 使用共享的排序逻辑，确保预览与执行一致
    const orderByClause = SQLUtils.buildDedupeOrderByClause({
      orderBy: config.orderBy,
      tieBreaker: config.tieBreaker,
      keepStrategy: config.keepStrategy,
    });

    const dedupeAnalysisSQL = `
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ${orderByClause}) AS _dup_rank
      FROM ${sourceTable}
    `.trim();

    // 将保留的记录（_dup_rank = 1）
    const keptSQL = this.buildPreviewSQL(
      context,
      `
      SELECT * EXCLUDE (_dup_rank)
      FROM dedupe_analysis
      WHERE _dup_rank = 1
      LIMIT ${sampleSize}
    `.trim(),
      [{ name: 'dedupe_analysis', sql: dedupeAnalysisSQL }]
    );

    // 将被删除的记录（_dup_rank > 1）
    const removedSQL = this.buildPreviewSQL(
      context,
      `
      SELECT * EXCLUDE (_dup_rank)
      FROM dedupe_analysis
      WHERE _dup_rank > 1
      LIMIT ${sampleSize}
    `.trim(),
      [{ name: 'dedupe_analysis', sql: dedupeAnalysisSQL }]
    );

    return { keptSQL, removedSQL };
  }

  /**
   * 解析统计结果
   */
  private parseDedupeStats(statsRow: any): import('../types').DedupePreviewStats {
    return {
      totalRows: statsRow.total_rows || 0,
      uniqueRows: statsRow.unique_rows || 0,
      duplicateRows: statsRow.duplicate_rows || 0,
      duplicateGroups: statsRow.duplicate_groups || 0,
      willBeRemoved: statsRow.will_be_removed || 0,
      willBeKept: statsRow.will_be_kept || 0,
      duplicateDistribution: Array.isArray(statsRow.duplicate_distribution)
        ? statsRow.duplicate_distribution
        : [],
      topDuplicates: Array.isArray(statsRow.top_duplicates)
        ? statsRow.top_duplicates.map((item: any) => {
            const { count = 0, ...values } = item || {};
            return { values, count };
          })
        : [],
    };
  }

  async previewFilterCount(
    datasetId: string,
    filterConfig: FilterConfig
  ): Promise<FilterPreviewResult> {
    const startTime = Date.now();

    try {
      const context = await this.createPreviewContext(datasetId);

      const totalRowsSQL = this.buildPreviewSQL(
        context,
        `SELECT COUNT(*) AS total FROM ${context.currentTable}`
      );
      const totalResult = await this.duckdbService.executeSQLWithParams(totalRowsSQL, []);
      const totalRows = totalResult[0]?.total || 0;

      const filterSQL = this.builders.filter.build(context, filterConfig);
      const countSQL = this.buildPreviewSQL(context, `SELECT COUNT(*) AS matched FROM filtered`, [
        { name: 'filtered', sql: filterSQL },
      ]);
      const countResult = await this.duckdbService.executeSQLWithParams(countSQL, []);
      const matchedRows = countResult[0]?.matched || 0;

      return {
        totalRows,
        matchedRows,
        filteredRows: totalRows - matchedRows,
        matchRate: totalRows > 0 ? matchedRows / totalRows : 0,
        executionTime: Date.now() - startTime,
      };
    } catch (error: any) {
      this.logger.error('previewFilterCount error:', error);
      throw new Error(`筛选预览失败: ${error.message}`);
    }
  }

  /**
   * 预览聚合结果（返回样本和统计信息）
   */
  async previewAggregate(
    datasetId: string,
    aggregateConfig: AggregateConfig,
    options: import('../types').PreviewOptions = {}
  ): Promise<AggregatePreviewResult> {
    const limit = options.limit || 5;

    try {
      const context = await this.createPreviewContext(datasetId);

      // 1. 获取原始行数
      const totalRowsSQL = this.buildPreviewSQL(
        context,
        `SELECT COUNT(*) AS total FROM ${context.currentTable}`
      );
      const totalResult = await this.duckdbService.executeSQLWithParams(totalRowsSQL, []);
      const originalRows = totalResult[0]?.total || 0;

      // 2. 构建聚合SQL
      const aggregateSQL = await this.builders.aggregate.build(context, aggregateConfig);

      // 3. 获取分组数量
      const countSQL = this.buildPreviewSQL(context, `SELECT COUNT(*) AS group_count FROM agg`, [
        { name: 'agg', sql: aggregateSQL },
      ]);
      const countResult = await this.duckdbService.executeSQLWithParams(countSQL, []);
      const groupCount = countResult[0]?.group_count || 0;

      // 4. 获取样本数据
      const sampleSQL = this.buildPreviewSQL(context, `SELECT * FROM agg LIMIT ${limit}`, [
        { name: 'agg', sql: aggregateSQL },
      ]);
      const sampleResult = await this.duckdbService.executeSQLWithParams(sampleSQL, []);

      // 5. 计算分组大小统计
      const groupSizeSQL = `
        SELECT ${aggregateConfig.groupBy.map((f) => `"${f}"`).join(', ')}, COUNT(*) AS _group_size
        FROM ${context.currentTable}
        GROUP BY ${aggregateConfig.groupBy.map((f) => `"${f}"`).join(', ')}
      `;
      const sizeStatsSQL = this.buildPreviewSQL(
        context,
        `
          SELECT
            AVG(_group_size) AS avg_size,
            MAX(_group_size) AS max_size,
            MIN(_group_size) AS min_size
          FROM agg
        `,
        [{ name: 'agg', sql: groupSizeSQL }]
      );
      const sizeStatsResult = await this.duckdbService.executeSQLWithParams(sizeStatsSQL, []);
      const sizeStats = sizeStatsResult[0] || {};

      return {
        estimatedRows: groupCount,
        reductionRatio: originalRows > 0 ? groupCount / originalRows : 0,
        sampleRows: sampleResult,
        stats: {
          originalRows,
          groupCount,
          avgGroupSize: sizeStats.avg_size || 0,
          maxGroupSize: sizeStats.max_size || 0,
          minGroupSize: sizeStats.min_size || 0,
        },
        generatedSQL: this.buildPreviewSQL(context, aggregateSQL),
      };
    } catch (error: any) {
      this.logger.error('previewAggregate error:', error);
      throw new Error(`聚合预览失败: ${error.message}`);
    }
  }

  /**
   * 预览采样结果
   */
  async previewSample(
    datasetId: string,
    sampleConfig: SampleConfig,
    scopeConfig?: QueryConfig | FilterConfig
  ): Promise<SamplePreviewResult> {
    try {
      const effectiveConfig = this.resolveSamplePreviewConfig(sampleConfig, scopeConfig);
      const baseConfig = this.cloneQueryConfig(effectiveConfig);
      delete baseConfig.sample;

      const [baseSQL, sampledSQL] = await Promise.all([
        this.buildQuerySQL(datasetId, baseConfig),
        this.buildQuerySQL(datasetId, effectiveConfig),
      ]);

      const normalizedBaseSQL = normalizeRuntimeSQL(baseSQL, baseConfig);
      const normalizedSampledSQL = normalizeRuntimeSQL(sampledSQL, effectiveConfig);

      const [originalRows, selectedRows] = await Promise.all([
        this.countPreviewRows(normalizedBaseSQL, '__airpa_sample_preview_base'),
        this.countPreviewRows(normalizedSampledSQL, '__airpa_sample_preview_result'),
      ]);

      const quality = await this.computeStratifiedSampleQuality(
        normalizedBaseSQL,
        normalizedSampledSQL,
        sampleConfig,
        originalRows,
        selectedRows
      );

      return {
        sampleSize: selectedRows,
        samplingRatio: originalRows > 0 ? selectedRows / originalRows : 0,
        stats: {
          originalRows,
          selectedRows,
          method: sampleConfig.type,
          seed: sampleConfig.seed,
          stratifyBy: sampleConfig.stratifyBy,
        },
        quality,
      };
    } catch (error: any) {
      this.logger.error('previewSample error:', error);
      throw new Error(`采样预览失败: ${error.message}`);
    }
  }

  /**
   * MAP 预览匹配条件：源字段值命中 codeMapping 键集合即视为匹配。
   */
  private buildMapLookupMatchCondition(lookupConfig: LookupConfig): string {
    const joinField = SQLUtils.escapeIdentifier(lookupConfig.joinKey);
    const mappingKeys = Object.keys(lookupConfig.codeMapping || {});
    if (mappingKeys.length === 0) {
      return 'FALSE';
    }
    const quotedCodes = mappingKeys.map((code) => SQLUtils.quoteValue(code)).join(', ');
    return `${joinField} IN (${quotedCodes})`;
  }

  private async buildLookupPreviewStep(
    context: SQLContext,
    lookupConfig: LookupConfig,
    options: import('../types').PreviewOptions = {}
  ): Promise<LookupPreviewCore> {
    const limit = options.limit || 5;

    // 1. 获取主表总行数
    const totalRowsSQL = this.buildPreviewSQL(
      context,
      `SELECT COUNT(*) AS total FROM ${context.currentTable}`
    );
    const totalResult = await this.duckdbService.executeSQLWithParams(totalRowsSQL, []);
    const totalRows = totalResult[0]?.total || 0;

    // 2. 构建关联 SQL 与匹配分析 SQL
    const matchAlias = '__lookup_match_key';
    const matchField = SQLUtils.escapeIdentifier(matchAlias);
    const mainRowAlias = '__lookup_main_row_id';
    const mainRowField = SQLUtils.escapeIdentifier(mainRowAlias);

    let lookupSQL: string;
    let previewSQL: string;
    let statsSourceSQL: string;
    let matchedSourceSQL: string;
    let unmatchedSourceSQL: string;
    let matchedWhereClause: string;
    let unmatchedWhereClause: string;
    let selectExcludeClause = '';

    if (lookupConfig.type === 'join') {
      let lookupTableName: string;
      if (lookupConfig.lookupTable) {
        const tableRef = lookupConfig.lookupTable.trim();
        if (!SQLUtils.isValidTableReference(tableRef)) {
          throw new Error(`Invalid lookupTable: ${lookupConfig.lookupTable}`);
        }
        lookupTableName = tableRef;
      } else if (lookupConfig.lookupDatasetId) {
        lookupTableName = await this.duckdbService.getDatasetTableName(
          lookupConfig.lookupDatasetId
        );
      } else {
        throw new Error(`Lookup join requires 'lookupTable' or 'lookupDatasetId'`);
      }

      const joinKey = SQLUtils.escapeIdentifier(lookupConfig.joinKey);
      const lookupKey = SQLUtils.escapeIdentifier(lookupConfig.lookupKey);

      const usedNames = new Set<string>(context.availableColumns);
      const lookupSelectItems = await this.builders.lookup.buildJoinSelectItems(
        lookupConfig,
        usedNames,
        'lookup_table'
      );

      const joinType = lookupConfig.leftJoin ? 'LEFT JOIN' : 'INNER JOIN';
      previewSQL = `
        SELECT main_table.*${lookupSelectItems.length > 0 ? `, ${lookupSelectItems.join(', ')}` : ''}
        FROM ${context.currentTable} AS main_table
        ${joinType} ${lookupTableName} AS lookup_table
          ON main_table.${joinKey} = lookup_table.${lookupKey}
      `.trim();

      const analysisSQL = `
        WITH main_base AS (
          SELECT *,
            ROW_NUMBER() OVER () AS ${mainRowField}
          FROM ${context.currentTable}
        )
        SELECT main_table.*,
          main_table.${mainRowField} AS ${mainRowField},
          lookup_table.${lookupKey} AS ${matchField}${lookupSelectItems.length > 0 ? `, ${lookupSelectItems.join(', ')}` : ''}
        FROM main_base AS main_table
        LEFT JOIN ${lookupTableName} AS lookup_table
          ON main_table.${joinKey} = lookup_table.${lookupKey}
      `.trim();

      statsSourceSQL = analysisSQL;
      matchedSourceSQL = analysisSQL;
      unmatchedSourceSQL = analysisSQL;
      matchedWhereClause = `${matchField} IS NOT NULL`;
      unmatchedWhereClause = `${matchField} IS NULL`;
      selectExcludeClause = ` EXCLUDE (${matchField}, ${mainRowField})`;
      lookupSQL = previewSQL;
    } else {
      lookupSQL = await this.builders.lookup.build(context, [lookupConfig]);
      previewSQL = lookupSQL;
      statsSourceSQL = previewSQL;
      matchedSourceSQL = previewSQL;
      unmatchedSourceSQL = previewSQL;
      const mapMatchCondition = this.buildMapLookupMatchCondition(lookupConfig);
      matchedWhereClause = mapMatchCondition;
      unmatchedWhereClause = `NOT (${mapMatchCondition})`;
    }

    const statsSQL = this.buildPreviewSQL(
      context,
      lookupConfig.type === 'join'
        ? `
            SELECT
              COUNT(DISTINCT ${mainRowField}) AS total,
              COUNT(DISTINCT CASE WHEN ${matchedWhereClause} THEN ${mainRowField} END) AS matched,
              COUNT(DISTINCT CASE WHEN ${unmatchedWhereClause} THEN ${mainRowField} END) AS unmatched
            FROM lookup_result
          `
        : `
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN ${matchedWhereClause} THEN 1 ELSE 0 END) AS matched,
              SUM(CASE WHEN ${unmatchedWhereClause} THEN 1 ELSE 0 END) AS unmatched
            FROM lookup_result
          `,
      [{ name: 'lookup_result', sql: statsSourceSQL }]
    );
    const statsResult = await this.duckdbService.executeSQLWithParams(statsSQL, []);
    const stats = statsResult[0] || {};

    const matchedRows = stats.matched || 0;
    const unmatchedRows = stats.unmatched || 0;
    const matchRate = totalRows > 0 ? matchedRows / totalRows : 0;
    const resultRows =
      lookupConfig.type === 'join'
        ? (
            await this.duckdbService.executeSQLWithParams(
              this.buildPreviewSQL(context, `SELECT COUNT(*) AS total FROM lookup_result`, [
                { name: 'lookup_result', sql: previewSQL },
              ]),
              []
            )
          )[0]?.total || 0
        : totalRows;

    const duplicatedRows =
      lookupConfig.type === 'join'
        ? Math.max(resultRows - (lookupConfig.leftJoin ? totalRows : matchedRows), 0)
        : 0;

    const matchedSQL = this.buildPreviewSQL(
      context,
      `
        SELECT *${selectExcludeClause} FROM lookup_result
        WHERE ${matchedWhereClause}
        LIMIT ${limit}
      `,
      [{ name: 'lookup_result', sql: matchedSourceSQL }]
    );
    const matchedResult = await this.duckdbService.executeSQLWithParams(matchedSQL, []);

    const unmatchedSQL = this.buildPreviewSQL(
      context,
      `
        SELECT *${selectExcludeClause} FROM lookup_result
        WHERE ${unmatchedWhereClause}
        LIMIT ${limit}
      `,
      [{ name: 'lookup_result', sql: unmatchedSourceSQL }]
    );
    const unmatchedResult = await this.duckdbService.executeSQLWithParams(unmatchedSQL, []);

    const warnings: string[] = [];
    if (matchRate < 0.5) {
      warnings.push(`匹配率较低（${(matchRate * 100).toFixed(1)}%），请检查关联字段是否正确。`);
    }
    if (unmatchedRows > totalRows * 0.3) {
      warnings.push(
        `有 ${unmatchedRows} 条记录未匹配（${((unmatchedRows / totalRows) * 100).toFixed(1)}%）。`
      );
    }
    if (duplicatedRows > 0) {
      warnings.push(`关联产生了 ${duplicatedRows} 条额外记录（可能存在一对多匹配）。`);
    }

    return {
      stats: {
        totalRows,
        matchedRows,
        unmatchedRows,
        matchRate,
        resultRows,
        duplicatedRows,
      },
      sampleMatched: matchedResult,
      sampleUnmatched: unmatchedResult,
      warnings: warnings.length > 0 ? warnings : undefined,
      generatedSQL: this.buildPreviewSQL(context, lookupSQL),
    };
  }

  private async advanceLookupPreviewContext(
    context: SQLContext,
    lookupConfig: LookupConfig,
    stepIndex: number
  ): Promise<SQLContext> {
    const stepName = `__lookup_preview_step_${stepIndex}`;
    const nextSQL = await this.builders.lookup.build(context, [lookupConfig]);
    const nextColumns = await this.builders.lookup.getResultColumns(context, [lookupConfig]);

    return {
      ...context,
      currentTable: stepName,
      ctes: [...context.ctes, { name: stepName, sql: nextSQL }],
      availableColumns: nextColumns,
    };
  }

  /**
   * 预览关联结果（返回匹配统计）
   */
  async previewLookup(
    datasetId: string,
    lookupConfig: LookupConfig | LookupConfig[],
    options: import('../types').PreviewOptions = {}
  ): Promise<LookupPreviewResult> {
    try {
      const lookupConfigs = Array.isArray(lookupConfig) ? lookupConfig : [lookupConfig];
      if (lookupConfigs.length === 0) {
        throw new Error('Lookup preview requires at least one config');
      }

      let context = await this.createPreviewContext(datasetId);
      const steps: LookupPreviewStep[] = [];
      let lastStep: LookupPreviewCore | null = null;

      for (let index = 0; index < lookupConfigs.length; index += 1) {
        const config = lookupConfigs[index];
        const stepResult = await this.buildLookupPreviewStep(context, config, options);
        steps.push({
          index,
          lookup: config,
          ...stepResult,
        });
        lastStep = stepResult;

        if (index < lookupConfigs.length - 1) {
          context = await this.advanceLookupPreviewContext(context, config, index);
        }
      }

      if (!lastStep) {
        throw new Error('Lookup preview produced no result');
      }

      return lookupConfigs.length > 1
        ? {
            ...lastStep,
            steps,
          }
        : lastStep;
    } catch (error: any) {
      this.logger.error('previewLookup error:', error);
      throw new Error(`关联预览失败: ${error.message}`);
    }
  }

  /**
   * 验证计算列表达式
   */
  async validateComputeExpression(
    datasetId: string,
    expression: string,
    options: import('../types').PreviewOptions = {}
  ): Promise<import('../types').ComputeValidationResult> {
    const limit = options.limit || 3;

    try {
      const context = await this.createPreviewContext(datasetId);

      // 1. 尝试执行表达式并获取前N行结果
      const testSQL = this.buildPreviewSQL(
        context,
        `
          SELECT ${expression} AS computed_value
          FROM ${context.currentTable}
          LIMIT ${limit}
        `
      );

      const result = await this.duckdbService.executeSQLWithParams(testSQL, []);

      // 2. 统计NULL值和唯一值
      const statsSQL = this.buildPreviewSQL(
        context,
        `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN (${expression}) IS NULL THEN 1 ELSE 0 END) AS null_count,
            COUNT(DISTINCT ${expression}) AS distinct_count
          FROM ${context.currentTable}
          LIMIT 1000
        `
      );
      const statsResult = await this.duckdbService.executeSQLWithParams(statsSQL, []);
      const stats = statsResult[0] || {};

      // 3. 推断数据类型
      const previewValues = result.map((row: any) => row.computed_value);
      let dataType = 'UNKNOWN';
      if (previewValues.length > 0 && previewValues[0] !== null) {
        const firstValue = previewValues[0];
        if (typeof firstValue === 'number') {
          dataType = Number.isInteger(firstValue) ? 'INTEGER' : 'DOUBLE';
        } else if (typeof firstValue === 'string') {
          dataType = 'VARCHAR';
        } else if (typeof firstValue === 'boolean') {
          dataType = 'BOOLEAN';
        }
      }

      return {
        valid: true,
        previewValues,
        stats: {
          nullCount: stats.null_count || 0,
          distinctCount: stats.distinct_count || 0,
          dataType,
        },
      };
    } catch (error: any) {
      this.logger.error('validateComputeExpression error:', error);
      return {
        valid: false,
        error: error.message,
        previewValues: [],
      };
    }
  }

  /**
   * 预览分组结果
   */
  async previewGroup(
    datasetId: string,
    groupConfig: GroupConfig,
    options: import('../types').PreviewOptions = {}
  ): Promise<GroupPreviewResult> {
    const limit = options.limit || 5;

    try {
      const context = await this.createPreviewContext(datasetId);

      // 1. 统计分组数量和大小
      const statsSQL = this.buildPreviewSQL(
        context,
        `
          SELECT
            COUNT(DISTINCT "${groupConfig.field}") AS group_count,
            AVG(group_size) AS avg_size,
            MAX(group_size) AS max_size,
            MIN(group_size) AS min_size
          FROM (
            SELECT "${groupConfig.field}", COUNT(*) AS group_size
            FROM ${context.currentTable}
            GROUP BY "${groupConfig.field}"
          )
        `
      );
      const statsResult = await this.duckdbService.executeSQLWithParams(statsSQL, []);
      const stats = statsResult[0] || {};

      // 2. 获取样本分组数据（前N组）
      const sampleSQL = this.buildPreviewSQL(
        context,
        `
          SELECT "${groupConfig.field}", COUNT(*) AS group_size
          FROM ${context.currentTable}
          GROUP BY "${groupConfig.field}"
          ORDER BY "${groupConfig.field}" ${groupConfig.order || 'ASC'}
          LIMIT ${limit}
        `
      );
      const sampleResult = await this.duckdbService.executeSQLWithParams(sampleSQL, []);

      return {
        groupCount: stats.group_count || 0,
        sampleGroups: sampleResult,
        stats: {
          avgGroupSize: stats.avg_size || 0,
          maxGroupSize: stats.max_size || 0,
          minGroupSize: stats.min_size || 0,
        },
      };
    } catch (error: any) {
      this.logger.error('previewGroup error:', error);
      throw new Error(`分组预览失败: ${error.message}`);
    }
  }
}
