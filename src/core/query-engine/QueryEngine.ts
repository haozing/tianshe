/**
 * DuckDB查询构造引擎
 * 核心类，协调所有Builder生成优化的SQL查询
 */

import type { IDatasetResolver } from './interfaces/IDatasetResolver';
import type { IQueryDuckDBService } from './interfaces/IQueryDuckDBService';
import type { ComputeConfig, QueryConfig, QueryExecutionResult, SQLContext } from './types';
import { ConfigValidator } from './validators/ConfigValidator';
import { FieldReferenceValidator } from './validators/FieldReferenceValidator';
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
import { QueryPipeline, createBuilderStep, createSoftDeleteStep } from './pipeline';

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
  private pipeline: QueryPipeline;

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

    // 组装查询管道（将硬编码的 Builder 调用链转为可注册步骤）
    this.pipeline = new QueryPipeline()
      .register(createSoftDeleteStep(this.logger))
      .register(
        createBuilderStep(this.filterBuilder, {
          key: 'filter',
          phase: 'pre-dedupe',
          extractConfig: (c) => (c.filter?.conditions?.length ? c.filter : undefined),
          cteName: 'filtered',
        })
      )
      .register(
        createBuilderStep(this.cleanBuilder, {
          key: 'clean',
          phase: 'pre-dedupe',
          extractConfig: (c) => (c.clean?.length ? c.clean : undefined),
          cteName: 'cleaned',
        })
      )
      .register(
        createBuilderStep(this.explodeBuilder, {
          key: 'explode',
          phase: 'pre-dedupe',
          extractConfig: (c) => (c.explode?.length ? c.explode : undefined),
          cteName: 'exploded',
        })
      )
      .register(
        createBuilderStep(this.validationBuilder, {
          key: 'validation',
          phase: 'pre-dedupe',
          extractConfig: (c) => (c.validation?.length ? c.validation : undefined),
          cteName: 'validated',
        })
      )
      .register(
        createBuilderStep(this.lookupBuilder, {
          key: 'lookup',
          phase: 'pre-dedupe',
          extractConfig: (c) => (c.lookup?.length ? c.lookup : undefined),
          cteName: 'enriched',
        })
      )
      .register(
        createBuilderStep(this.computeBuilder, {
          key: 'compute',
          phase: 'pre-dedupe',
          extractConfig: (c) => (c.compute?.length ? c.compute : undefined),
          cteName: 'computed',
          preApply: (computeConfig, context) => {
            for (const compute of computeConfig) {
              if (context.availableColumns.has(compute.name)) {
                throw QueryErrorFactory.invalidParam(
                  'compute.name',
                  compute.name,
                  `列名 '${compute.name}' 已存在，请使用不同的列名或先删除已有列`
                );
              }
            }
          },
        })
      )
      .register(
        createBuilderStep(this.groupBuilder, {
          key: 'group',
          phase: 'pre-dedupe',
          extractConfig: (c) => c.group,
          cteName: 'grouped',
        })
      )
      .register(
        createBuilderStep(this.aggregateBuilder, {
          key: 'aggregate',
          phase: 'pre-dedupe',
          extractConfig: (c) => c.aggregate,
          cteName: 'aggregated',
          preApply: (aggregateConfig, context) => {
            if (context.isAggregated) {
              throw QueryErrorFactory.unsupportedOperation('double aggregation', 'aggregate');
            }
            this.assertAggregateFieldsExist(aggregateConfig, context);
          },
          postApply: (_config, context) => {
            context.isAggregated = true;
          },
        })
      )
      .register(
        createBuilderStep(this.dedupeBuilder, {
          key: 'dedupe',
          phase: 'dedupe',
          extractConfig: (c) => c.dedupe,
          cteName: 'deduped',
          preApply: (_config, context) => {
            if (context.isAggregated) {
              throw QueryErrorFactory.unsupportedOperation('dedupe after aggregation', 'dedupe');
            }
          },
        })
      )
      .register(
        createBuilderStep(this.sampleBuilder, {
          key: 'sample',
          phase: 'post-dedupe',
          extractConfig: (c) => c.sample,
          cteName: 'sampled',
          preApply: (_config, context) => {
            if (context.isAggregated) {
              throw QueryErrorFactory.unsupportedOperation(
                'sampling after aggregation. 采样应用于原始数据或筛选后的数据，不能用于聚合统计结果。建议：移除采样配置或移除聚合配置',
                'sample'
              );
            }
          },
        })
      );

    // 初始化预览服务
    this.preview = new PreviewService({
      duckdbService: this.duckdbService,
      logger: this.logger,
      pipeline: this.pipeline,
      lookupBuilder: this.lookupBuilder,
      createBaseContext: (datasetId: string) => this.createBaseContext(datasetId),
      createDedupePreviewContext: (datasetId: string, config: QueryConfig = {}) =>
        this.createDedupePreviewContext(datasetId, config),
      buildQuerySQL: (datasetId: string, config: QueryConfig) => this.buildSQL(datasetId, config),
    });

    this.logger.info('QueryEngine initialized with all builders and preview service');
  }

  private async buildSQLWithMetadata(
    datasetId: string,
    config: QueryConfig
  ): Promise<{ sql: string; isDefaultLimitApplied: boolean }> {
    const validation = ConfigValidator.validate(config);
    if (!validation.success) {
      throw QueryErrorFactory.invalidParam(
        'config',
        config,
        validation.errors?.join(', ') || 'Invalid configuration'
      );
    }

    const validatedConfig = validation.data!;
    if (validatedConfig.group && validatedConfig.aggregate) {
      throw QueryErrorFactory.unsupportedOperation(
        'Cannot use simple grouping with aggregation',
        'group'
      );
    }

    await this.populateDefaultGroupStatsFields(datasetId, validatedConfig);

    const context = await this.createBaseContext(datasetId);

    this.logger.info(`Building SQL for dataset ${datasetId}`);
    this.logger.debug(`Available columns:`, Array.from(context.availableColumns));

    await this.pipeline.executePhase('pre-dedupe', context, validatedConfig);
    await this.pipeline.executePhase('dedupe', context, validatedConfig);

    const defaultSampleOrderBy =
      validatedConfig.sample &&
      (validatedConfig.sort?.columns?.length ?? 0) === 0 &&
      context.availableColumns.has('_row_id')
        ? `ORDER BY ${SQLUtils.escapeIdentifier('_row_id')} ASC`
        : '';

    await this.pipeline.executePhase('post-dedupe', context, validatedConfig);

    const selectList = this.columnBuilder.buildSelectList(context, validatedConfig.columns);
    if (validatedConfig.columns) {
      context.availableColumns = this.columnBuilder.getResultColumns(
        context,
        validatedConfig.columns
      );
    }

    const orderByClause = this.sortBuilder.buildOrderBy(validatedConfig.sort);
    const limitClause = this.sortBuilder.buildLimit(validatedConfig.sort);

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
    } else if (defaultSampleOrderBy) {
      finalSQL += `\n${defaultSampleOrderBy}`;
    }

    let isDefaultLimitApplied = false;
    if (limitClause) {
      finalSQL += `\n${limitClause}`;
    } else {
      finalSQL += `\nLIMIT ${QueryEngine.DEFAULT_MAX_ROWS}`;
      isDefaultLimitApplied = true;
      this.logger.warn(`Applied default LIMIT: ${QueryEngine.DEFAULT_MAX_ROWS}`);
    }

    this.logger.debug(`Generated SQL:\n${finalSQL}`);

    return { sql: finalSQL, isDefaultLimitApplied };
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
        const type = String(col.duckdbType ?? col.type ?? '').toLowerCase();
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
    if (validatedConfig.group && validatedConfig.aggregate) {
      throw QueryErrorFactory.unsupportedOperation(
        'Cannot use simple grouping with aggregation',
        'group'
      );
    }

    await this.populateDefaultGroupStatsFields(datasetId, validatedConfig);

    const context = await this.createBaseContext(datasetId);
    await this.pipeline.executePhase('pre-dedupe', context, validatedConfig);

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

  private assertAggregateFieldsExist(
    aggregateConfig: NonNullable<QueryConfig['aggregate']>,
    context: SQLContext
  ): void {
    for (const field of aggregateConfig.groupBy) {
      if (!context.availableColumns.has(field)) {
        throw QueryErrorFactory.fieldNotFound(field, Array.from(context.availableColumns));
      }
    }

    for (const measure of aggregateConfig.measures) {
      const referencedFields = [
        measure.field,
        measure.params?.orderBy,
        measure.params?.argField,
      ].filter((field): field is string => Boolean(field));

      for (const field of referencedFields) {
        if (!context.availableColumns.has(field)) {
          throw QueryErrorFactory.fieldNotFound(field, Array.from(context.availableColumns));
        }
      }
    }
  }

  async buildSQL(datasetId: string, config: QueryConfig): Promise<string> {
    const { sql } = await this.buildSQLWithMetadata(datasetId, config);
    return sql;
  }

  async execute(datasetId: string, config: QueryConfig): Promise<QueryExecutionResult> {
    const startTime = Date.now();

    try {
      const { sql, isDefaultLimitApplied } = await this.buildSQLWithMetadata(datasetId, config);
      const result = await this.duckdbService.queryDataset(datasetId, sql);
      const executionTime = Date.now() - startTime;

      this.logger.info(`Query executed in ${executionTime}ms, returned ${result.rowCount} rows`);

      const warnings: string[] = [];
      if (isDefaultLimitApplied) {
        warnings.push(
          `Result automatically limited to ${QueryEngine.DEFAULT_MAX_ROWS.toLocaleString()} rows. ` +
            'Specify an explicit limit in the query configuration to retrieve more rows.'
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

      const friendlyError = this.translateExecutionError(errorObj);

      return {
        success: false,
        error: friendlyError.message,
        executionTime,
        errorDetails: friendlyError.details,
      };
    }
  }

  private translateExecutionError(error: Error): { message: string; details?: any } {
    if (error instanceof QueryEngineError) {
      return {
        message: error.getUserMessage(),
        details: error.details,
      };
    }

    const translatedError = QueryErrorFactory.translateDuckDBError(error);
    return {
      message: translatedError.message,
      details: translatedError.details,
    };
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
    const validation = ConfigValidator.validate(config);
    if (!validation.success) {
      return {
        success: false,
        errors: validation.errors,
      };
    }

    const { allColumns: availableColumns } = await this.getDatasetColumnState(datasetId);
    const validatedConfig = validation.data ?? config;
    const { errors, warnings } = FieldReferenceValidator.validate(
      validatedConfig,
      availableColumns
    );

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
