import type { CleanConfig, QueryConfig, QueryExecutionResult, QueryEngine } from '../../core/query-engine';
import type { DatasetService } from './dataset-service';

export interface DuckDBServiceQueryFacade {
  queryWithEngine(datasetId: string, config: QueryConfig): Promise<QueryExecutionResult>;
  validateQueryConfig(
    datasetId: string,
    config: QueryConfig
  ): Promise<{ success: boolean; errors?: string[]; warnings?: string[] }>;
  previewQuerySQL(
    datasetId: string,
    config: QueryConfig
  ): Promise<{ success: boolean; sql?: string; error?: string }>;
  previewClean(datasetId: string, config: any, options?: any): Promise<any>;
  materializeCleanToNewColumns(
    datasetId: string,
    cleanConfig: CleanConfig
  ): Promise<{ createdColumns: string[]; updatedColumns: string[] }>;
  previewDedupe(datasetId: string, config: any, options?: any): Promise<any>;
  previewFilterCount(datasetId: string, filterConfig: any): Promise<any>;
  previewAggregate(datasetId: string, aggregateConfig: any, options?: any): Promise<any>;
  previewSample(datasetId: string, sampleConfig: any, queryConfig?: any): Promise<any>;
  previewLookup(datasetId: string, lookupConfig: any, options?: any): Promise<any>;
  filterWithAhoCorasick(
    datasetId: string,
    targetField: string,
    dictDatasetId: string,
    dictField: string,
    isBlacklist: boolean
  ): Promise<number[]>;
  createTempRowIdTable(datasetId: string, tableName: string, rowIds: number[]): Promise<void>;
  dropTempRowIdTable(datasetId: string, tableName: string): Promise<void>;
  validateComputeExpression(datasetId: string, expression: string, options?: any): Promise<any>;
  previewGroup(datasetId: string, groupConfig: any, options?: any): Promise<any>;
  buildExportSQL(datasetId: string, queryConfig: QueryConfig): Promise<string>;
  ensureQueryConfigDependenciesAttached(
    datasetId: string,
    config: QueryConfig,
    options: { includeMainDataset: boolean }
  ): Promise<void>;
  ensureDatasetAttached(datasetId: string): Promise<void>;
  exportDataset(options: any, onProgress?: any): Promise<any>;
}

type DuckDBServiceQueryFacadeThis = DuckDBServiceQueryFacade & {
  datasetService: DatasetService | null;
  queryEngine: QueryEngine | null;
};

const duckDBServiceQueryFacadeMethods: DuckDBServiceQueryFacade &
  ThisType<DuckDBServiceQueryFacadeThis> = {
async queryWithEngine(datasetId: string, config: QueryConfig): Promise<QueryExecutionResult> {
  if (!this.queryEngine) {
    throw new Error('QueryEngine not initialized');
  }
  await this.ensureQueryConfigDependenciesAttached(datasetId, config, {
    includeMainDataset: false,
  });
  return await this.queryEngine.execute(datasetId, config);
},

async validateQueryConfig(
  datasetId: string,
  config: QueryConfig
): Promise<{
  success: boolean;
  errors?: string[];
  warnings?: string[];
}> {
  if (!this.queryEngine) {
    throw new Error('QueryEngine not initialized');
  }
  return await this.queryEngine.validateConfig(datasetId, config);
},

async previewQuerySQL(
  datasetId: string,
  config: QueryConfig
): Promise<{
  success: boolean;
  sql?: string;
  error?: string;
}> {
  if (!this.queryEngine) {
    throw new Error('QueryEngine not initialized');
  }
  await this.ensureQueryConfigDependenciesAttached(datasetId, config, {
    includeMainDataset: true,
  });
  return await this.queryEngine.previewSQL(datasetId, config);
},

async previewClean(datasetId: string, config: any, options?: any): Promise<any> {
  if (!this.queryEngine) {
    throw new Error('QueryEngine not initialized');
  }
  return await this.queryEngine.preview.previewClean(datasetId, config, options);
},

async materializeCleanToNewColumns(
  datasetId: string,
  cleanConfig: CleanConfig
): Promise<{ createdColumns: string[]; updatedColumns: string[] }> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }

  const result = await this.datasetService.materializeCleanToNewColumns(datasetId, cleanConfig);

  // QueryEngine 会缓存列信息，schema 变更后需要失效缓存
  this.queryEngine?.clearColumnCache(datasetId);

  return result;
},

async previewDedupe(datasetId: string, config: any, options?: any): Promise<any> {
  if (!this.queryEngine) {
    throw new Error('QueryEngine not initialized');
  }
  return await this.queryEngine.preview.previewDedupe(datasetId, config, options);
},

async previewFilterCount(datasetId: string, filterConfig: any): Promise<any> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.previewFilterCount(datasetId, filterConfig);
},

async previewAggregate(datasetId: string, aggregateConfig: any, options?: any): Promise<any> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.previewAggregate(datasetId, aggregateConfig, options);
},

async previewSample(datasetId: string, sampleConfig: any, queryConfig?: any): Promise<any> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.previewSample(datasetId, sampleConfig, queryConfig);
},

async previewLookup(datasetId: string, lookupConfig: any, options?: any): Promise<any> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.previewLookup(datasetId, lookupConfig, options);
},

async filterWithAhoCorasick(
  datasetId: string,
  targetField: string,
  dictDatasetId: string,
  dictField: string,
  isBlacklist: boolean
): Promise<number[]> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.filterWithAhoCorasick(
    datasetId,
    targetField,
    dictDatasetId,
    dictField,
    isBlacklist
  );
},

async createTempRowIdTable(
  datasetId: string,
  tableName: string,
  rowIds: number[]
): Promise<void> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  await this.datasetService.createTempRowIdTable(datasetId, tableName, rowIds);
},

async dropTempRowIdTable(datasetId: string, tableName: string): Promise<void> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  await this.datasetService.dropTempRowIdTable(datasetId, tableName);
},

async validateComputeExpression(
  datasetId: string,
  expression: string,
  options?: any
): Promise<any> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.validateComputeExpression(datasetId, expression, options);
},

async previewGroup(datasetId: string, groupConfig: any, options?: any): Promise<any> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.previewGroup(datasetId, groupConfig, options);
},

async buildExportSQL(datasetId: string, queryConfig: QueryConfig): Promise<string> {
  if (!this.queryEngine) {
    throw new Error('QueryEngine not initialized');
  }

  // ? 导出场景：主数据集通常已由导出服务在队列中 smartAttach，这里只确保依赖数据集已附加
  await this.ensureQueryConfigDependenciesAttached(datasetId, queryConfig, {
    includeMainDataset: false,
  });

  // 1. 深拷贝配置，移除分页参数
  const configWithoutPagination: QueryConfig = {
    ...queryConfig,
    sort: queryConfig.sort
      ? {
          ...queryConfig.sort,
          pagination: undefined, // ← 移除分页限制
          topK: undefined, // ← 移除TopK限制（导出全部数据）
        }
      : undefined,
  };

  console.log('[DuckDBService] Building export SQL without pagination');
  console.log('[DuckDBService] Original sort config:', queryConfig.sort);
  console.log('[DuckDBService] Export sort config:', configWithoutPagination.sort);

  // 2. 使用 QueryEngine 生成SQL
  let sql = await this.queryEngine.buildSQL(datasetId, configWithoutPagination);

  // ? 导出场景：若未指定分页/TopK，移除默认 LIMIT/OFFSET
  const hasExplicitLimit = !!(
    configWithoutPagination.sort?.pagination || configWithoutPagination.sort?.topK
  );
  if (!hasExplicitLimit) {
    sql = sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/gi, '');
  }

  console.log('[DuckDBService] Export SQL generated (without LIMIT/OFFSET)');
  return sql;
},

async ensureQueryConfigDependenciesAttached(
  datasetId: string,
  config: QueryConfig,
  options: { includeMainDataset: boolean }
): Promise<void> {
  const dependencyIds = new Set<string>();

  if (options.includeMainDataset) {
    dependencyIds.add(datasetId);
  }

  // 1) Lookup JOIN 依赖
  if (Array.isArray(config.lookup)) {
    for (const lookup of config.lookup) {
      if (lookup?.type === 'join' && lookup.lookupDatasetId) {
        dependencyIds.add(lookup.lookupDatasetId);
      }
    }
  }

  for (const id of dependencyIds) {
    await this.ensureDatasetAttached(id);
  }
},

async ensureDatasetAttached(datasetId: string): Promise<void> {
  if (!this.datasetService) {
    throw new Error('Services not initialized');
  }

  // ? 使用队列保护的 ATTACH 方法（方案A）
  return await this.datasetService.withDatasetAttached(datasetId, async () => {
    console.log(`[Service] Database attached: ds_${datasetId}`);
  });
},

async exportDataset(options: any, onProgress?: any): Promise<any> {
  if (!this.datasetService) {
    throw new Error('DatasetService not initialized');
  }
  return await this.datasetService.exportDataset(options, onProgress);
}
};

export function installDuckDBServiceQueryFacade(prototype: object): void {
  Object.assign(prototype, duckDBServiceQueryFacadeMethods);
}
