/**
 * DuckDB查询构造引擎
 * 核心类，协调所有Builder生成优化的SQL查询
 */

import type { IDatasetResolver } from './interfaces/IDatasetResolver';
import type { IQueryDuckDBService } from './interfaces/IQueryDuckDBService';
import type {
  ComputeConfig,
  QueryConfig,
  QueryExecutionResult,
  SQLContext,
  SoftDeleteConfig,
} from './types';
import { ConfigValidator } from './validators/ConfigValidator';
import { FilterBuilder } from './builders/FilterBuilder';
import { ColumnBuilder } from './builders/ColumnBuilder';
import { SortBuilder } from './builders/SortBuilder';
import { CleanBuilder } from './builders/CleanBuilder';
import { ComputeBuilder } from './builders/ComputeBuilder';
import { DedupeBuilder } from './builders/DedupeBuilder';
import { LookupBuilder } from './builders/LookupBuilder';
import { ValidationBuilder } from './builders/ValidationBuilder';
import { SampleBuilder } from './builders/SampleBuilder'; //
import { ExplodeBuilder } from './builders/ExplodeBuilder'; //
import { AggregateBuilder } from './builders/AggregateBuilder'; // 🆕
import { GroupBuilder } from './builders/GroupBuilder'; //
import { QueryEngineError, QueryErrorFactory, QueryErrorCode } from './errors'; // 错误处理
import { LRUCache } from 'lru-cache';
import { LoggerFactory, type ILogger } from './utils/logger';
import { PreviewService } from './services/PreviewService';
import { SQLUtils } from './utils/sql-utils';

export class QueryEngine {
  // 预览服务（公开访问）
  public readonly preview: PreviewService;
  // 默认结果集上限（防止 OOM）
  private static readonly DEFAULT_MAX_ROWS = 1000000; // 100万行

  // 列信息缓存（LRU，带TTL，减少重复查询数据库）
  private columnCache = new LRUCache<
    string,
    {
      allColumns: Set<string>;
      physicalColumns: Set<string>;
      persistedComputedColumns: ComputeConfig;
    }
  >({
    max: 500, // 最多缓存500个数据集
    ttl: 1000 * 60 * 5, // 5分钟过期
    updateAgeOnGet: true, // 访问时更新过期时间
    allowStale: false, // 不返回过期数据
  });

  // 日志记录器
  private logger: ILogger;

  private filterBuilder: FilterBuilder;
  private columnBuilder: ColumnBuilder;
  private sortBuilder: SortBuilder;
  private cleanBuilder: CleanBuilder;
  private computeBuilder: ComputeBuilder;
  private dedupeBuilder: DedupeBuilder;
  private lookupBuilder: LookupBuilder;
  private validationBuilder: ValidationBuilder;
  private sampleBuilder: SampleBuilder; //
  private explodeBuilder: ExplodeBuilder; //
  private aggregateBuilder: AggregateBuilder; //
  private groupBuilder: GroupBuilder; //

  constructor(
    private duckdbService: IQueryDuckDBService,
    datasetResolver?: IDatasetResolver
  ) {
    // 初始化日志记录器
    this.logger = LoggerFactory.create('QueryEngine');

    // 如果没有提供datasetResolver，使用duckdbService作为resolver
    const resolver = datasetResolver || duckdbService;

    this.filterBuilder = new FilterBuilder();
    this.columnBuilder = new ColumnBuilder();
    this.sortBuilder = new SortBuilder();
    this.cleanBuilder = new CleanBuilder();
    this.computeBuilder = new ComputeBuilder();
    this.dedupeBuilder = new DedupeBuilder();
    this.lookupBuilder = new LookupBuilder(resolver);
    this.validationBuilder = new ValidationBuilder();
    this.sampleBuilder = new SampleBuilder(); //
    this.explodeBuilder = new ExplodeBuilder(); //
    this.aggregateBuilder = new AggregateBuilder(); //
    this.groupBuilder = new GroupBuilder(); //

    // 初始化预览服务
    this.preview = new PreviewService({
      duckdbService: this.duckdbService,
      logger: this.logger,
      builders: {
        clean: this.cleanBuilder,
        dedupe: this.dedupeBuilder,
        filter: this.filterBuilder,
        aggregate: this.aggregateBuilder,
        sample: this.sampleBuilder,
        lookup: this.lookupBuilder,
        compute: this.computeBuilder,
        group: this.groupBuilder,
      },
      createBaseContext: (datasetId: string) => this.createBaseContext(datasetId),
      createDedupePreviewContext: (datasetId: string, config: QueryConfig = {}) =>
        this.createDedupePreviewContext(datasetId, config),
      buildQuerySQL: (datasetId: string, config: QueryConfig) => this.buildSQL(datasetId, config),
    });

    this.logger.info('QueryEngine initialized with all builders and preview service');
  }

  /**
   * 内部方法：生成 SQL 并返回元数据（是否应用默认 LIMIT）
   */
  private async buildSQLWithMetadata(
    datasetId: string,
    config: QueryConfig
  ): Promise<{ sql: string; isDefaultLimitApplied: boolean }> {
    // 1. 验证配置
    const validation = ConfigValidator.validate(config);
    if (!validation.success) {
      throw QueryErrorFactory.invalidParam(
        'config',
        config,
        validation.errors?.join(', ') || 'Invalid configuration'
      );
    }

    const validatedConfig = validation.data!;

    // 2. 初始化 SQL 上下文（统一注入持久化计算列）
    const context = await this.createBaseContext(datasetId);

    this.logger.info(`Building SQL for dataset ${datasetId}`);
    this.logger.debug(`Available columns:`, Array.from(context.availableColumns));

    // 3. 按顺序应用各个Builder（CTE链式结构）
    await this.applyPreDedupeOperations(datasetId, context, validatedConfig);

    // 3.9 去重
    if (validatedConfig.dedupe) {
      if (context.isAggregated) {
        throw QueryErrorFactory.unsupportedOperation('dedupe after aggregation', 'dedupe');
      }
      const dedupeSQL = this.dedupeBuilder.build(context, validatedConfig.dedupe);
      context.ctes.push({ name: 'deduped', sql: dedupeSQL });
      context.currentTable = 'deduped';
      context.availableColumns = this.dedupeBuilder.getResultColumns(
        context,
        validatedConfig.dedupe
      );
      this.logger.debug(`Applied dedupe: ${validatedConfig.dedupe.type}`);
    }

    // 3.10 采样（在所有数据处理操作之后，排序和分页之前执行）
    const defaultSampleOrderBy =
      validatedConfig.sample &&
      (validatedConfig.sort?.columns?.length ?? 0) === 0 &&
      context.availableColumns.has('_row_id')
        ? `ORDER BY ${SQLUtils.escapeIdentifier('_row_id')} ASC`
        : '';

    if (validatedConfig.sample) {
      // ✅ 检查：采样和聚合不能同时使用（语义冲突）
      if (context.isAggregated) {
        throw QueryErrorFactory.unsupportedOperation(
          'sampling after aggregation. 采样应用于原始数据或筛选后的数据，不能用于聚合统计结果。建议：移除采样配置或移除聚合配置',
          'sample'
        );
      }

      const sampleSQL = await this.sampleBuilder.build(context, validatedConfig.sample);
      context.ctes.push({ name: 'sampled', sql: sampleSQL });
      context.currentTable = 'sampled';
      // availableColumns 不变（采样不改变列结构）
      this.logger.debug(`Applied sample: ${validatedConfig.sample.type}`);
    }

    // 3.11 选列（投影裁剪 - 倒数第二步）
    const selectList = this.columnBuilder.buildSelectList(context, validatedConfig.columns);
    if (validatedConfig.columns) {
      context.availableColumns = this.columnBuilder.getResultColumns(
        context,
        validatedConfig.columns
      );
    }

    // 3.12 排序和分页（最后执行）
    const orderByClause = this.sortBuilder.buildOrderBy(validatedConfig.sort);
    const limitClause = this.sortBuilder.buildLimit(validatedConfig.sort);

    // 4. 组装最终SQL
    let finalSQL = '';

    if (context.ctes.length > 0) {
      // 使用 CTE
      const cteStatements = context.ctes
        .map((cte) => `${cte.name} AS (\n  ${cte.sql}\n)`)
        .join(',\n');
      finalSQL = `WITH ${cteStatements}\nSELECT ${selectList}\nFROM ${context.currentTable}`;
    } else {
      // 没有 CTE，直接查询
      finalSQL = `SELECT ${selectList}\nFROM ${context.currentTable}`;
    }

    // 添加 ORDER BY
    if (orderByClause) {
      finalSQL += `\n${orderByClause}`;
    } else if (defaultSampleOrderBy) {
      finalSQL += `\n${defaultSampleOrderBy}`;
    }

    // 添加 LIMIT（如果用户未指定，则使用默认上限）
    let isDefaultLimitApplied = false;
    if (limitClause) {
      finalSQL += `\n${limitClause}`;
    } else {
      // 添加默认结果集上限以防止 OOM
      finalSQL += `\nLIMIT ${QueryEngine.DEFAULT_MAX_ROWS}`;
      isDefaultLimitApplied = true;
      this.logger.warn(`Applied default LIMIT: ${QueryEngine.DEFAULT_MAX_ROWS}`);
    }

    this.logger.debug(`Generated SQL:\n${finalSQL}`);

    return { sql: finalSQL, isDefaultLimitApplied };
  }

  private async applyPreDedupeOperations(
    datasetId: string,
    context: SQLContext,
    config: QueryConfig
  ): Promise<void> {
    if (config.softDelete) {
      const softDeleteCTE = this.applySoftDelete(context, config.softDelete);
      if (softDeleteCTE) {
        context.ctes.push(softDeleteCTE);
        context.currentTable = softDeleteCTE.name;
        this.logger.debug(`Applied soft delete filter: ${config.softDelete.show} mode`);
      }
    }

    if (config.filter?.conditions && config.filter.conditions.length > 0) {
      const filterSQL = this.filterBuilder.build(context, config.filter);
      context.ctes.push({ name: 'filtered', sql: filterSQL });
      context.currentTable = 'filtered';
      this.logger.debug(`Applied filter: ${config.filter.conditions.length} conditions`);
    }

    if (config.clean && config.clean.length > 0) {
      const cleanSQL = this.cleanBuilder.build(context, config.clean);
      context.ctes.push({ name: 'cleaned', sql: cleanSQL });
      context.currentTable = 'cleaned';
      context.availableColumns = this.cleanBuilder.getResultColumns(context, config.clean);
      this.logger.debug(`Applied clean: ${config.clean.length} operations`);
    }

    if (config.explode && config.explode.length > 0) {
      const explodeSQL = await this.explodeBuilder.build(context, config.explode);
      context.ctes.push({ name: 'exploded', sql: explodeSQL });
      context.currentTable = 'exploded';
      context.availableColumns = await this.explodeBuilder.getResultColumns(
        context,
        config.explode
      );
      this.logger.debug(`Applied explode: ${config.explode.length} operations`);
    }

    if (config.validation && config.validation.length > 0) {
      const validSQL = this.validationBuilder.build(context, config.validation);
      context.ctes.push({ name: 'validated', sql: validSQL });
      context.currentTable = 'validated';
      context.availableColumns = this.validationBuilder.getResultColumns(
        context,
        config.validation
      );
      this.logger.debug(`Applied validation: ${config.validation.length} rules`);
    }

    if (config.lookup && config.lookup.length > 0) {
      const lookupSQL = await this.lookupBuilder.build(context, config.lookup);
      context.ctes.push({ name: 'enriched', sql: lookupSQL });
      context.currentTable = 'enriched';
      context.availableColumns = await this.lookupBuilder.getResultColumns(context, config.lookup);
      this.logger.debug(`Applied lookup: ${config.lookup.length} lookups`);
    }

    if (config.compute && config.compute.length > 0) {
      for (const compute of config.compute) {
        if (context.availableColumns.has(compute.name)) {
          throw QueryErrorFactory.invalidParam(
            'compute.name',
            compute.name,
            `列名 '${compute.name}' 已存在，请使用不同的列名或先删除已有列`
          );
        }
      }

      const computeSQL = this.computeBuilder.build(context, config.compute);
      context.ctes.push({ name: 'computed', sql: computeSQL });
      context.currentTable = 'computed';
      context.availableColumns = this.computeBuilder.getResultColumns(context, config.compute);
      this.logger.debug(`Applied compute: ${config.compute.length} columns`);
    }

    if (config.group) {
      if (config.aggregate) {
        throw QueryErrorFactory.unsupportedOperation(
          'Cannot use simple grouping with aggregation',
          'group'
        );
      }

      await this.populateDefaultGroupStatsFields(datasetId, config);

      const groupSQL = await this.groupBuilder.build(context, config.group);
      context.ctes.push({ name: 'grouped', sql: groupSQL });
      context.currentTable = 'grouped';
      context.availableColumns = await this.groupBuilder.getResultColumns(context, config.group);
      this.logger.debug(`Applied group: ${config.group.field}`);
    }

    if (config.aggregate) {
      if (context.isAggregated) {
        throw QueryErrorFactory.unsupportedOperation('double aggregation', 'aggregate');
      }

      for (const field of config.aggregate.groupBy) {
        if (!context.availableColumns.has(field)) {
          throw QueryErrorFactory.fieldNotFound(field, Array.from(context.availableColumns));
        }
      }

      for (const measure of config.aggregate.measures) {
        if (measure.field && !context.availableColumns.has(measure.field)) {
          throw QueryErrorFactory.fieldNotFound(
            measure.field,
            Array.from(context.availableColumns)
          );
        }
      }

      const aggregateSQL = await this.aggregateBuilder.build(context, config.aggregate);
      context.ctes.push({ name: 'aggregated', sql: aggregateSQL });
      context.currentTable = 'aggregated';
      context.availableColumns = await this.aggregateBuilder.getResultColumns(
        context,
        config.aggregate
      );
      context.isAggregated = true;
      this.logger.debug(`Applied aggregate: GROUP BY ${config.aggregate.groupBy.join(', ')}`);
    }
  }

  private async populateDefaultGroupStatsFields(
    datasetId: string,
    config: QueryConfig
  ): Promise<void> {
    if (!config.group || config.group.showStats === false || config.group.statsFields) {
      return;
    }

    const numericFields: string[] = [];
    const dataset = await this.duckdbService.getDatasetInfo(datasetId);
    if (dataset?.schema) {
      dataset.schema.forEach((col) => {
        const type = col.duckdbType?.toLowerCase() || '';
        if (
          type.includes('int') ||
          type.includes('float') ||
          type.includes('double') ||
          type.includes('decimal') ||
          type.includes('numeric')
        ) {
          numericFields.push(col.name);
        }
      });
    }

    if (numericFields.length > 0) {
      config.group.statsFields = numericFields.slice(0, 3);
    }
  }

  async createDedupePreviewContext(
    datasetId: string,
    config: QueryConfig = {}
  ): Promise<SQLContext> {
    const validation = ConfigValidator.validate(config);
    if (!validation.success) {
      throw QueryErrorFactory.invalidParam(
        'config',
        config,
        validation.errors?.join(', ') || 'Invalid configuration'
      );
    }

    const validatedConfig = validation.data || {};
    const context = await this.createBaseContext(datasetId);
    await this.applyPreDedupeOperations(datasetId, context, validatedConfig);

    if (context.isAggregated) {
      throw QueryErrorFactory.unsupportedOperation('dedupe after aggregation', 'dedupe');
    }

    return context;
  }

  private cloneComputeConfig(config: ComputeConfig): ComputeConfig {
    return config.map((column) => ({
      ...column,
      params: column.params
        ? {
            ...column.params,
            boundaries: column.params.boundaries ? [...column.params.boundaries] : undefined,
            labels: column.params.labels ? [...column.params.labels] : undefined,
            fields: column.params.fields ? [...column.params.fields] : undefined,
          }
        : undefined,
    }));
  }

  private cloneColumnState(state: {
    allColumns: Set<string>;
    physicalColumns: Set<string>;
    persistedComputedColumns: ComputeConfig;
  }): {
    allColumns: Set<string>;
    physicalColumns: Set<string>;
    persistedComputedColumns: ComputeConfig;
  } {
    return {
      allColumns: new Set(state.allColumns),
      physicalColumns: new Set(state.physicalColumns),
      persistedComputedColumns: this.cloneComputeConfig(state.persistedComputedColumns),
    };
  }

  private async getDatasetColumnState(datasetId: string): Promise<{
    allColumns: Set<string>;
    physicalColumns: Set<string>;
    persistedComputedColumns: ComputeConfig;
  }> {
    const cached = this.columnCache.get(datasetId);
    if (cached) {
      return this.cloneColumnState(cached);
    }

    const dataset = await this.duckdbService.getDatasetInfo(datasetId);
    if (!dataset || !dataset.schema) {
      throw new QueryEngineError(
        QueryErrorCode.DATASET_NOT_FOUND,
        `Dataset not found or has no schema: ${datasetId}`,
        { datasetId }
      );
    }

    const allColumns = new Set<string>();
    const physicalColumns = new Set<string>();
    const persistedComputedColumns: ComputeConfig = [];

    for (const column of dataset.schema) {
      allColumns.add(column.name);

      if (column.storageMode === 'computed' && column.computeConfig) {
        persistedComputedColumns.push({
          name: column.name,
          ...column.computeConfig,
        });
        continue;
      }

      physicalColumns.add(column.name);
    }

    const state = {
      allColumns,
      physicalColumns,
      persistedComputedColumns,
    };

    this.columnCache.set(datasetId, state);
    return this.cloneColumnState(state);
  }

  private getDatasetDataTableName(datasetId: string): string {
    return SQLUtils.escapeIdentifier('ds_' + datasetId) + '.' + SQLUtils.escapeIdentifier('data');
  }

  private async createBaseContext(datasetId: string): Promise<SQLContext> {
    const { physicalColumns, persistedComputedColumns } =
      await this.getDatasetColumnState(datasetId);

    const context: SQLContext = {
      datasetId,
      currentTable: this.getDatasetDataTableName(datasetId),
      ctes: [],
      availableColumns: physicalColumns,
      isAggregated: false,
    };

    if (persistedComputedColumns.length > 0) {
      const computedSQL = this.computeBuilder.build(context, persistedComputedColumns);
      context.ctes.push({ name: 'computed', sql: computedSQL });
      context.currentTable = 'computed';
      context.availableColumns = this.computeBuilder.getResultColumns(
        context,
        persistedComputedColumns
      );
    }

    return context;
  }

  /**
   * 核心方法：将JSON配置转换为SQL（公共接口）
   */
  async buildSQL(datasetId: string, config: QueryConfig): Promise<string> {
    const { sql } = await this.buildSQLWithMetadata(datasetId, config);
    return sql;
  }

  /**
   * 执行查询
   */
  async execute(datasetId: string, config: QueryConfig): Promise<QueryExecutionResult> {
    const startTime = Date.now();

    try {
      // 2. 生成SQL（使用内部方法获取元数据）
      const { sql, isDefaultLimitApplied } = await this.buildSQLWithMetadata(datasetId, config);

      // 3. 执行SQL
      const result = await this.duckdbService.queryDataset(datasetId, sql);

      const executionTime = Date.now() - startTime;

      this.logger.info(`Query executed in ${executionTime}ms, returned ${result.rowCount} rows`);

      // 构建警告信息
      const warnings: string[] = [];
      if (isDefaultLimitApplied) {
        warnings.push(
          `结果已自动限制为 ${QueryEngine.DEFAULT_MAX_ROWS.toLocaleString()} 行。` +
            `如需获取更多数据，请在查询配置中明确指定 limit 参数。`
        );
      }

      return {
        success: true,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        executionTime,
        generatedSQL: sql,
        isTruncated: isDefaultLimitApplied,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error: unknown) {
      const executionTime = Date.now() - startTime;
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Query failed:`, errorObj);

      // 翻译 DuckDB 错误为用户友好的消息
      const friendlyError = this.translateExecutionError(errorObj);

      return {
        success: false,
        error: friendlyError.message,
        executionTime,
        errorDetails: friendlyError.details,
      };
    }
  }

  /**
   * Execute dictionary filter with Aho-Corasick.
   * AC path applies the same builder chain as the normal path.
   */
  private async executeWithAhoCorasick(
    datasetId: string,
    config: QueryConfig,
    _unsupportedConfigs: string[] = []
  ): Promise<QueryExecutionResult> {
    throw QueryErrorFactory.unsupportedOperation(
      'Aho-Corasick dictionary filtering has been removed',
      'filter'
    );
    /*
    const startTime = Date.now();
    let tempRowIdTable: string | null = null;

    try {
      // 1. 使用公共方法提取并执行 AC 匹配
      const { matchedRowIds, otherConditions } = await this.extractAndExecuteAC(
        datasetId,
        config.filter!
      );

      // 2. 没有匹配的行时，提前返回
      if (matchedRowIds.length === 0) {
        return {
          success: true,
          columns: [],
          rows: [],
          rowCount: 0,
          executionTime: Date.now() - startTime,
          generatedSQL: '-- No rows matched by Aho-Corasick',
        };
      }

      // 3. Build base table reference (use temp table for large row_id list)
      const availableColumns = await this.getDatasetColumns(datasetId);

      const useRowIdTempTable = matchedRowIds.length > QueryEngine.AC_ROW_ID_TEMP_TABLE_THRESHOLD;

      if (useRowIdTempTable) {
        tempRowIdTable = `ac_row_ids_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await this.duckdbService.createTempRowIdTable(datasetId, tempRowIdTable, matchedRowIds);
      }

      const baseTable =
        SQLUtils.escapeIdentifier('ds_' + datasetId) + '.' + SQLUtils.escapeIdentifier('data');

      let baseDataSQL: string;
      if (useRowIdTempTable && tempRowIdTable) {
        const tempTableRef = SQLUtils.escapeIdentifier(tempRowIdTable);
        baseDataSQL = `
SELECT t.* FROM ${baseTable} t
INNER JOIN ${tempTableRef} r ON t._row_id = r._row_id
`.trim();
      } else {
        const rowIdList = matchedRowIds.join(', ');
        baseDataSQL = `
SELECT * FROM ${baseTable}
WHERE _row_id IN (${rowIdList})
`.trim();
      }

      const context: SQLContext = {
        datasetId,
        currentTable: 'base_data',
        ctes: [{ name: 'base_data', sql: baseDataSQL }],
        availableColumns,
        isAggregated: false,
      };

      // 4. Apply builder chain
      if (config.softDelete) {
        const softDeleteCTE = this.applySoftDelete(context, config.softDelete);
        if (softDeleteCTE) {
          context.ctes.push(softDeleteCTE);
          context.currentTable = softDeleteCTE.name;
          this.logger.debug(`[AhoCorasick] Applied softDelete: ${config.softDelete.show} mode`);
        }
      }

      if (otherConditions.length > 0) {
        this.logger.info(
          `[AhoCorasick] Applying ${otherConditions.length} additional filter conditions`
        );

        const additionalFilterConfig: FilterConfig = {
          conditions: otherConditions,
          combinator: config.filter?.combinator,
        };

        const filterSQL = this.filterBuilder.build(context, additionalFilterConfig);
        context.ctes.push({ name: 'filtered', sql: filterSQL });
        context.currentTable = 'filtered';
        this.logger.debug(`Applied filter: ${otherConditions.length} conditions`);
      }

      if (config.clean && config.clean.length > 0) {
        const cleanSQL = this.cleanBuilder.build(context, config.clean);
        context.ctes.push({ name: 'cleaned', sql: cleanSQL });
        context.currentTable = 'cleaned';
        context.availableColumns = this.cleanBuilder.getResultColumns(context, config.clean);
        this.logger.debug(`Applied clean: ${config.clean.length} operations`);
      }

      if (config.explode && config.explode.length > 0) {
        const explodeSQL = await this.explodeBuilder.build(context, config.explode);
        context.ctes.push({ name: 'exploded', sql: explodeSQL });
        context.currentTable = 'exploded';
        context.availableColumns = await this.explodeBuilder.getResultColumns(
          context,
          config.explode
        );
        this.logger.debug(`Applied explode: ${config.explode.length} operations`);
      }

      if (config.validation && config.validation.length > 0) {
        const validSQL = this.validationBuilder.build(context, config.validation);
        context.ctes.push({ name: 'validated', sql: validSQL });
        context.currentTable = 'validated';
        context.availableColumns = this.validationBuilder.getResultColumns(
          context,
          config.validation
        );
        this.logger.debug(`Applied validation: ${config.validation.length} rules`);
      }

      if (config.lookup && config.lookup.length > 0) {
        const lookupSQL = await this.lookupBuilder.build(context, config.lookup);
        context.ctes.push({ name: 'enriched', sql: lookupSQL });
        context.currentTable = 'enriched';
        context.availableColumns = await this.lookupBuilder.getResultColumns(
          context,
          config.lookup
        );
        this.logger.debug(`Applied lookup: ${config.lookup.length} lookups`);
      }

      if (config.compute && config.compute.length > 0) {
        for (const compute of config.compute) {
          if (context.availableColumns.has(compute.name)) {
            throw QueryErrorFactory.invalidParam(
              'compute.name',
              compute.name,
              `列名 '${compute.name}' 已存在，请使用不同的列名或先删除已有列`
            );
          }
        }

        const computeSQL = this.computeBuilder.build(context, config.compute);
        context.ctes.push({ name: 'computed', sql: computeSQL });
        context.currentTable = 'computed';
        context.availableColumns = this.computeBuilder.getResultColumns(context, config.compute);
        this.logger.debug(`Applied compute: ${config.compute.length} columns`);
      }

      if (config.group) {
        if (config.aggregate) {
          throw QueryErrorFactory.unsupportedOperation(
            'Cannot use simple grouping with aggregation',
            'group'
          );
        }

        const groupConfig = { ...config.group };

        if (groupConfig.showStats !== false && !groupConfig.statsFields) {
          const numericFields: string[] = [];
          const dataset = await this.duckdbService.getDatasetInfo(datasetId);
          if (dataset && dataset.schema) {
            dataset.schema.forEach((col) => {
              const type = col.duckdbType?.toLowerCase() || '';
              if (
                type.includes('int') ||
                type.includes('float') ||
                type.includes('double') ||
                type.includes('decimal') ||
                type.includes('numeric')
              ) {
                numericFields.push(col.name);
              }
            });
          }

          if (numericFields.length > 0) {
            groupConfig.statsFields = numericFields.slice(0, 3);
          }
        }

        const groupSQL = await this.groupBuilder.build(context, groupConfig);
        context.ctes.push({ name: 'grouped', sql: groupSQL });
        context.currentTable = 'grouped';
        context.availableColumns = await this.groupBuilder.getResultColumns(context, groupConfig);
        this.logger.debug(`Applied group: ${groupConfig.field}`);
      }

      if (config.aggregate) {
        if (context.isAggregated) {
          throw QueryErrorFactory.unsupportedOperation('double aggregation', 'aggregate');
        }

        for (const field of config.aggregate.groupBy) {
          if (!context.availableColumns.has(field)) {
            throw QueryErrorFactory.fieldNotFound(field, Array.from(context.availableColumns));
          }
        }

        for (const measure of config.aggregate.measures) {
          if (measure.field && !context.availableColumns.has(measure.field)) {
            throw QueryErrorFactory.fieldNotFound(
              measure.field,
              Array.from(context.availableColumns)
            );
          }
        }

        const aggregateSQL = await this.aggregateBuilder.build(context, config.aggregate);
        context.ctes.push({ name: 'aggregated', sql: aggregateSQL });
        context.currentTable = 'aggregated';
        context.availableColumns = await this.aggregateBuilder.getResultColumns(
          context,
          config.aggregate
        );
        context.isAggregated = true;
        this.logger.debug(`Applied aggregate: GROUP BY ${config.aggregate.groupBy.join(', ')}`);
      }

      if (config.dedupe) {
        if (context.isAggregated) {
          throw QueryErrorFactory.unsupportedOperation('dedupe after aggregation', 'dedupe');
        }
        const dedupeSQL = this.dedupeBuilder.build(context, config.dedupe);
        context.ctes.push({ name: 'deduped', sql: dedupeSQL });
        context.currentTable = 'deduped';
        context.availableColumns = this.dedupeBuilder.getResultColumns(context, config.dedupe);
        this.logger.debug(`Applied dedupe: ${config.dedupe.type}`);
      }

      if (config.sample) {
        if (context.isAggregated) {
          throw QueryErrorFactory.unsupportedOperation(
            'sampling after aggregation. 采样应用于原始数据或筛选后的数据，不能用于聚合统计结果。建议：移除采样配置或移除聚合配置',
            'sample'
          );
        }

        const sampleSQL = await this.sampleBuilder.build(context, config.sample);
        context.ctes.push({ name: 'sampled', sql: sampleSQL });
        context.currentTable = 'sampled';
        this.logger.debug(`Applied sample: ${config.sample.type}`);
      }

      const selectList = this.columnBuilder.buildSelectList(context, config.columns);
      if (config.columns) {
        context.availableColumns = this.columnBuilder.getResultColumns(context, config.columns);
      }

      const orderByClause = this.sortBuilder.buildOrderBy(config.sort);
      const limitClause = this.sortBuilder.buildLimit(config.sort);

      let finalSQL = '';

      if (context.ctes.length > 0) {
        const cteStatements = context.ctes
          .map((cte) => `${cte.name} AS (\n  ${cte.sql}\n)`)
          .join(',\n');
        finalSQL = `WITH ${cteStatements}\nSELECT ${selectList}\nFROM ${context.currentTable}`;
      } else {
        finalSQL = `SELECT ${selectList}\nFROM ${context.currentTable}`;
      }

      if (orderByClause) {
        finalSQL += `\n${orderByClause}`;
      }

      let isDefaultLimitApplied = false;
      if (limitClause) {
        finalSQL += `\n${limitClause}`;
      } else {
        finalSQL += `\nLIMIT ${QueryEngine.DEFAULT_MAX_ROWS}`;
        isDefaultLimitApplied = true;
        this.logger.warn(`[AhoCorasick] Applied default LIMIT: ${QueryEngine.DEFAULT_MAX_ROWS}`);
      }

      // 8. 执行最终查询
      const result = await this.duckdbService.queryDataset(datasetId, finalSQL);

      const executionTime = Date.now() - startTime;

      this.logger.info(
        `[AhoCorasick] Query executed in ${executionTime}ms, returned ${result.rowCount} rows`
      );

      // 9. 构建警告信息
      const warnings: string[] = [];
      if (unsupportedConfigs.length > 0) {
        warnings.push(
          `词库筛选模式（Aho-Corasick）不支持以下配置，已被忽略：${unsupportedConfigs.join('、')}。` +
            `如需使用这些功能，请改用非词库筛选方式。`
        );
      }
      if (isDefaultLimitApplied) {
        warnings.push(
          `结果已自动限制为 ${QueryEngine.DEFAULT_MAX_ROWS.toLocaleString()} 行。` +
            `如需获取更多数据，请在查询配置中明确指定 limit 或 pagination 参数。`
        );
      }

      return {
        success: true,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        executionTime,
        generatedSQL: finalSQL,
        isTruncated: isDefaultLimitApplied,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error: unknown) {
      const executionTime = Date.now() - startTime;
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`[AhoCorasick] Query failed:`, errorObj);

      const friendlyError = this.translateExecutionError(errorObj);

      return {
        success: false,
        error: friendlyError.message,
        executionTime,
        errorDetails: friendlyError.details,
      };
    } finally {
      if (tempRowIdTable) {
        try {
          await this.duckdbService.dropTempRowIdTable(datasetId, tempRowIdTable);
        } catch (dropError) {
          this.logger.warn(`[AhoCorasick] Failed to drop temp table ${tempRowIdTable}:`, dropError);
        }
      }
    }
    */
  }

  /**
   * 翻译执行错误
   */
  private translateExecutionError(error: Error): { message: string; details?: any } {
    // 如果已经是 QueryEngineError，直接返回
    if (error instanceof QueryEngineError) {
      return {
        message: error.getUserMessage(),
        details: error.details,
      };
    }

    // 否则使用 DuckDB 错误翻译器
    const translatedError = QueryErrorFactory.translateDuckDBError(error);
    return {
      message: translatedError.message,
      details: translatedError.details,
    };
  }

  /**
   * 应用软删除过滤（视图级设置）
   *
   * @param context SQL上下文
   * @param config 软删除配置
   * @returns CTE定义，如果字段不存在则返回null
   */
  private applySoftDelete(
    context: SQLContext,
    config: SoftDeleteConfig
  ): { name: string; sql: string } | null {
    const { field, show } = config;

    // 检查字段是否存在
    if (!context.availableColumns.has(field)) {
      this.logger.warn(
        `Soft delete field "${field}" not found in dataset ${context.datasetId}, skipping`
      );
      return null;
    }

    // 根据 show 模式生成 WHERE 子句
    let whereClause = '';
    if (show === 'active') {
      // 只显示活跃行（deleted_at IS NULL）
      whereClause = `WHERE "${field}" IS NULL`;
    } else if (show === 'deleted') {
      // 只显示已删除行（deleted_at IS NOT NULL）
      whereClause = `WHERE "${field}" IS NOT NULL`;
    } else if (show === 'all') {
      // 显示所有行（不过滤）
      whereClause = '';
    }

    const cteName = 'cte_soft_delete';
    const sql = `SELECT * FROM ${context.currentTable} ${whereClause}`.trim();

    this.logger.debug(`Generated soft delete SQL: ${sql}`);

    return { name: cteName, sql };
  }

  /**
   * 获取数据集的列信息（带缓存）
   * 缓存可以显著减少对数据库的重复查询，提升性能
   */
  private async getDatasetColumns(datasetId: string): Promise<Set<string>> {
    const { allColumns } = await this.getDatasetColumnState(datasetId);
    return allColumns;
  }

  /**
   * 清除列信息缓存
   *
   * @param datasetId - 可选，指定要清除的数据集ID。如果不指定，清除所有缓存
   */
  clearColumnCache(datasetId?: string): void {
    if (datasetId) {
      this.columnCache.delete(datasetId);
    } else {
      this.columnCache.clear();
    }
  }

  /**
   * 验证查询配置（不执行）
   */
  async validateConfig(
    datasetId: string,
    config: QueryConfig
  ): Promise<{
    success: boolean;
    errors?: string[];
    warnings?: string[];
  }> {
    // 1. 验证JSON Schema
    const validation = ConfigValidator.validate(config);
    if (!validation.success) {
      return {
        success: false,
        errors: validation.errors,
      };
    }

    // 2. 验证字段存在性
    const { allColumns: availableColumns } = await this.getDatasetColumnState(datasetId);
    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查 filter 中的字段
    if (config.filter?.conditions) {
      for (const condition of config.filter.conditions) {
        if (!availableColumns.has(condition.field)) {
          errors.push(`Filter field '${condition.field}' does not exist in dataset`);
        }
      }
    }

    // 检查 columns 中的字段
    if (config.columns?.select) {
      for (const col of config.columns.select) {
        if (!availableColumns.has(col)) {
          errors.push(`Column '${col}' does not exist in dataset`);
        }
      }
    }

    // 检查 sort 中的字段
    if (config.sort?.columns) {
      for (const sortCol of config.sort.columns) {
        if (!availableColumns.has(sortCol.field)) {
          errors.push(`Sort field '${sortCol.field}' does not exist in dataset`);
        }
      }
    }

    // 检查 clean 中的字段
    if (config.clean) {
      for (const cleanField of config.clean) {
        if (!availableColumns.has(cleanField.field)) {
          errors.push(`Clean field '${cleanField.field}' does not exist in dataset`);
        }
      }
    }

    // 检查 dedupe 中的字段
    if (config.dedupe) {
      for (const field of config.dedupe.partitionBy) {
        if (!availableColumns.has(field)) {
          errors.push(`Dedupe partitionBy field '${field}' does not exist in dataset`);
        }
      }
      // 检查 orderBy 字段
      if (config.dedupe.orderBy) {
        for (const orderCol of config.dedupe.orderBy) {
          if (!availableColumns.has(orderCol.field)) {
            errors.push(`Dedupe orderBy field '${orderCol.field}' does not exist in dataset`);
          }
        }
      }
      // 检查 tieBreaker 字段
      if (config.dedupe.tieBreaker && !availableColumns.has(config.dedupe.tieBreaker)) {
        errors.push(
          `Dedupe tieBreaker field '${config.dedupe.tieBreaker}' does not exist in dataset`
        );
      }
    }

    // 🆕 检查 compute 中的字段
    if (config.compute) {
      for (const compute of config.compute) {
        // 检查 bucket 字段
        if (compute.type === 'bucket' && compute.params?.field) {
          if (!availableColumns.has(compute.params.field)) {
            errors.push(`Compute bucket field '${compute.params.field}' does not exist in dataset`);
          }
        }
        // 检查 amount 字段
        if (compute.type === 'amount') {
          if (compute.params?.priceField && !availableColumns.has(compute.params.priceField)) {
            errors.push(
              `Compute priceField '${compute.params.priceField}' does not exist in dataset`
            );
          }
          if (
            compute.params?.quantityField &&
            !availableColumns.has(compute.params.quantityField)
          ) {
            errors.push(
              `Compute quantityField '${compute.params.quantityField}' does not exist in dataset`
            );
          }
        }
        // 检查 discount 字段
        if (compute.type === 'discount') {
          if (
            compute.params?.originalPriceField &&
            !availableColumns.has(compute.params.originalPriceField)
          ) {
            errors.push(
              `Compute originalPriceField '${compute.params.originalPriceField}' does not exist in dataset`
            );
          }
          if (
            compute.params?.discountedPriceField &&
            !availableColumns.has(compute.params.discountedPriceField)
          ) {
            errors.push(
              `Compute discountedPriceField '${compute.params.discountedPriceField}' does not exist in dataset`
            );
          }
        }
        // 检查 concat 字段
        if (compute.type === 'concat' && compute.params?.fields) {
          for (const field of compute.params.fields) {
            if (!availableColumns.has(field)) {
              errors.push(`Compute concat field '${field}' does not exist in dataset`);
            }
          }
        }
      }
    }

    // 🆕 检查 validation 中的字段
    if (config.validation) {
      for (const validField of config.validation) {
        if (!availableColumns.has(validField.field)) {
          errors.push(`Validation field '${validField.field}' does not exist in dataset`);
        }
        // 检查 cross_field 引用的字段
        for (const rule of validField.rules) {
          if (rule.type === 'cross_field' && rule.params?.compareField) {
            if (!availableColumns.has(rule.params.compareField)) {
              errors.push(
                `Validation cross_field compareField '${rule.params.compareField}' does not exist in dataset`
              );
            }
          }
        }
      }
    }

    // 🆕 检查 explode 中的字段
    if (config.explode) {
      for (const explode of config.explode) {
        if (!availableColumns.has(explode.field)) {
          errors.push(`Explode field '${explode.field}' does not exist in dataset`);
        }
      }
    }

    // 🆕 检查 group 中的字段
    if (config.group) {
      if (!availableColumns.has(config.group.field)) {
        errors.push(`Group field '${config.group.field}' does not exist in dataset`);
      }
      if (config.group.statsFields) {
        for (const field of config.group.statsFields) {
          if (!availableColumns.has(field)) {
            errors.push(`Group statsField '${field}' does not exist in dataset`);
          }
        }
      }
    }

    // 🆕 检查 aggregate 中的字段
    if (config.aggregate) {
      // 检查 groupBy 字段
      for (const field of config.aggregate.groupBy) {
        if (!availableColumns.has(field)) {
          errors.push(`Aggregate groupBy field '${field}' does not exist in dataset`);
        }
      }
      // 检查 measures 字段
      for (const measure of config.aggregate.measures) {
        if (measure.field && !availableColumns.has(measure.field)) {
          errors.push(`Aggregate measure field '${measure.field}' does not exist in dataset`);
        }
        // 检查 argField（ARG_MIN/ARG_MAX）
        if (measure.params?.argField && !availableColumns.has(measure.params.argField)) {
          errors.push(
            `Aggregate measure argField '${measure.params.argField}' does not exist in dataset`
          );
        }
      }
    }

    // 🆕 检查 softDelete 字段
    if (config.softDelete) {
      if (!availableColumns.has(config.softDelete.field)) {
        warnings.push(
          `SoftDelete field '${config.softDelete.field}' does not exist in dataset, will be ignored`
        );
      }
    }

    // 🆕 检查 columns.rename / hide / show 中的字段
    if (config.columns?.rename) {
      for (const oldName of Object.keys(config.columns.rename)) {
        if (!availableColumns.has(oldName)) {
          errors.push(`Column rename source '${oldName}' does not exist in dataset`);
        }
      }
    }
    if (config.columns?.hide) {
      for (const col of config.columns.hide) {
        if (!availableColumns.has(col)) {
          warnings.push(`Column to hide '${col}' does not exist in dataset, will be ignored`);
        }
      }
    }
    if (config.columns?.show) {
      for (const col of config.columns.show) {
        if (!availableColumns.has(col)) {
          warnings.push(`Column to show '${col}' does not exist in dataset, will be ignored`);
        }
      }
    }

    // 合并 ConfigValidator 的 warnings
    if (validation.warnings) {
      warnings.push(...validation.warnings);
    }

    return {
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // previewClean 已迁移到 PreviewService
  // 使用方式: queryEngine.preview.previewClean(...)

  /**
   * 预览SQL（不执行）
   */
  async previewSQL(
    datasetId: string,
    config: QueryConfig
  ): Promise<{
    success: boolean;
    sql?: string;
    error?: string;
  }> {
    try {
      const sql = await this.buildSQL(datasetId, config);
      return {
        success: true,
        sql,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  // previewDedupe 已迁移到 PreviewService
  // 使用方式: queryEngine.preview.previewDedupe(...)

  // ========== 🆕 预览方法（用于各面板的实时预览） ==========

  /**
   * 预览筛选结果（仅返回计数）
   */
  async previewFilterCount(
    datasetId: string,
    filterConfig: import('./types').FilterConfig
  ): Promise<import('./types').FilterPreviewResult> {
    return await this.preview.previewFilterCount(datasetId, filterConfig);
  }

  // previewAggregate, previewSample, previewLookup, validateComputeExpression, previewGroup
  // 已迁移到 PreviewService
  // 使用方式: queryEngine.preview.methodName(...)
}
