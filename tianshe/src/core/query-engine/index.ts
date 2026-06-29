/**
 * Query Engine 统一导出
 */

// 核心引擎
export { QueryEngine } from './QueryEngine';
export { ConfigValidator } from './validators/ConfigValidator';

// 通用验证工具
export {
  createValidator,
  validateRequired,
  validateArrayNotEmpty,
  validateEnum,
  validatePositiveNumber,
  validateColumnsExist,
  validateUniqueColumns,
  validateConditionalRequired,
  combineValidations,
  throwIfInvalid,
} from './validators/common-validators';
export type { ValidationResult } from './validators/common-validators';

// Builders
export { FilterBuilder } from './builders/FilterBuilder';
export { ColumnBuilder } from './builders/ColumnBuilder';
export { SortBuilder } from './builders/SortBuilder';
export { CleanBuilder } from './builders/CleanBuilder';
export { ComputeBuilder } from './builders/ComputeBuilder';
export { DedupeBuilder } from './builders/DedupeBuilder';
export { LookupBuilder } from './builders/LookupBuilder';
// DictBuilder 已移除，请使用 filter 中的 contains_multi/excludes_multi
export { ValidationBuilder } from './builders/ValidationBuilder';
export { SampleBuilder } from './builders/SampleBuilder';
export { ExplodeBuilder } from './builders/ExplodeBuilder'; // 🆕
export { AggregateBuilder } from './builders/AggregateBuilder'; // 🆕

// 独立服务（Standalone Services）
export { DatasetMerger } from './services/dataset-merger'; // 🆕
export { PivotService } from './services/pivot-service';
export { DataWritebackService } from './services/data-writeback-service'; // 🆕

// 工具类
export { SQLUtils } from './utils/sql-utils';
export { ILogger, LogLevel, LoggerFactory, PinoLogger, SilentLogger } from './utils/logger';

// 错误处理
export { QueryEngineError, QueryErrorCode, QueryErrorFactory } from './errors';

// 接口
export {
  IQueryBuilder,
  SyncQueryBuilder,
  BuilderName,
  BuilderMetadata,
} from './interfaces/IQueryBuilder';

// 类型定义
export * from './types';
