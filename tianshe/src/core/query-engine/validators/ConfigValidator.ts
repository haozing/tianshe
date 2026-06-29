/**
 * 查询配置验证器
 * 使用 Zod 验证 QueryConfig 的合法性
 */

import { z } from 'zod';
import type { QueryConfig } from '../types';
import { AGGREGATE_FUNCTIONS_REQUIRING_FIELD } from '../types';
import { SQLUtils } from '../utils/sql-utils';

// 筛选条件类型
const FilterConditionTypeSchema = z.enum([
  'equal',
  'not_equal',
  'greater_than',
  'less_than',
  'greater_equal',
  'less_equal',
  'between',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'regex',
  'in',
  'not_in',
  'null',
  'not_null',
  'relative_time',
  'soft_delete',
]);

// 软删除显示模式
const SoftDeleteShowSchema = z.enum(['active', 'deleted', 'all']);

// 软删除配置
const SoftDeleteConfigSchema = z.object({
  field: z.string().min(1), // 软删除字段名
  show: SoftDeleteShowSchema, // 显示模式
});

// 时间单位
const TimeUnitSchema = z.enum(['second', 'minute', 'hour', 'day', 'week', 'month', 'year']);

// 筛选条件
const FilterConditionSchema = z.object({
  type: FilterConditionTypeSchema,
  field: z.string().min(1),
  value: z.any().optional(),
  values: z.array(z.any()).optional(),
  options: z
    .object({
      caseSensitive: z.boolean().optional(),
      regexTimeout: z.number().min(0).max(60000).optional(), // 最大60秒
      regexMaxLength: z.number().min(1).max(100000).optional(), // 最大10万字符
      relativeTimeUnit: TimeUnitSchema.optional(),
      relativeTimeValue: z.number().optional(),
      relativeTimeDirection: z.enum(['past', 'future']).optional(),
      // soft_delete
      softDeleteStates: z.array(SoftDeleteShowSchema).optional(),
    })
    .optional(),
});

// 筛选配置
const FilterConfigSchema = z.object({
  conditions: z.array(FilterConditionSchema).optional(),
  combinator: z.enum(['AND', 'OR']).optional().default('AND'),
});

// 选列配置
const ColumnConfigSchema = z.object({
  select: z.array(z.string()).optional(),
  rename: z.record(z.string(), z.string()).optional(),
  hide: z.array(z.string()).optional(),
  show: z.array(z.string()).optional(),
});

// 排序列
const SortColumnSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['ASC', 'DESC']),
  nullsFirst: z.boolean().optional(),
});

// 分页配置
const PaginationConfigSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(10000), // 最大1万条/页
});

// 排序配置
const SortConfigSchema = z.object({
  columns: z.array(SortColumnSchema).optional(),
  topK: z.number().int().min(1).optional(),
  pagination: PaginationConfigSchema.optional(),
});

// 清洗操作类型（与 types.ts CleanOperationType 保持同步）
const CleanOperationTypeSchema = z.enum([
  // === 文本基础清洗 ===
  'trim',
  'trim_start',
  'trim_end',
  'upper',
  'lower',
  'title',
  'to_halfwidth',
  'to_fullwidth',
  'replace',
  'regex_replace',

  // === 空值处理 ===
  'fill_null',
  'coalesce',
  'nullif',

  // === 类型转换 ===
  'cast',
  'try_cast',

  // === 数值处理 ===
  'unit_convert',
  'round',
  'floor',
  'ceil',
  'abs',

  // === 日期时间 ===
  'parse_date',
  'format_date',

  // === 高级清洗 ===
  'normalize_space',
  'remove_special_chars',
  'truncate',
  'normalize_email',
  'split_part',
  'concat_fields',
  'extract_numbers',
]);

// 清洗操作
const CleanOperationSchema = z.object({
  type: CleanOperationTypeSchema,
  params: z
    .object({
      // === 通用参数 ===
      value: z.any().optional(), // 填充/默认值

      // === 字符串操作 ===
      search: z.string().optional(), // replace
      replaceWith: z.string().optional(),
      pattern: z.string().optional(), // regex_replace
      replacement: z.string().optional(),

      // === 空值处理 ===
      fields: z.array(z.string()).optional(), // coalesce: 多字段合并
      nullValue: z.any().optional(), // nullif: 要转为NULL的值

      // === 类型转换 ===
      targetType: z
        .enum([
          'VARCHAR',
          'TEXT',
          'STRING',
          'INTEGER',
          'INT',
          'BIGINT',
          'SMALLINT',
          'TINYINT',
          'DOUBLE',
          'FLOAT',
          'DECIMAL',
          'NUMERIC',
          'BOOLEAN',
          'BOOL',
          'DATE',
          'TIMESTAMP',
          'TIME',
          'JSON',
        ])
        .optional(), // cast/try_cast: 目标类型

      // === 数值处理 ===
      fromUnit: z.string().optional(), // unit_convert
      toUnit: z.string().optional(),
      conversionFactor: z.number().optional(),
      decimals: z.number().int().min(0).max(10).optional(), // round: 小数位数

      // === 日期时间 ===
      dateFormat: z.string().optional(), // parse_date/format_date

      // === 高级清洗 ===
      keepPattern: z.string().optional(), // remove_special_chars: 保留字符模式
      maxLength: z.number().int().min(1).optional(), // truncate: 最大长度
      suffix: z.string().optional(), // truncate: 截断后缀
      delimiter: z.string().optional(), // split_part: 分隔符
      index: z.number().int().optional(), // split_part: 索引位置
      separator: z.string().optional(), // concat_fields: 连接分隔符
    })
    .optional(),
});

// 清洗字段配置
const CleanFieldConfigSchema = z.object({
  field: z.string().min(1),
  operations: z.array(CleanOperationSchema).min(1),
  outputField: z.string().optional(),
});

// 清洗配置
const CleanConfigSchema = z.array(CleanFieldConfigSchema);

// 计算列类型
const ComputeColumnTypeSchema = z.enum(['amount', 'discount', 'bucket', 'concat', 'custom']);

// 计算列
const ComputeColumnSchema = z.object({
  name: z.string().min(1),
  type: ComputeColumnTypeSchema,
  expression: z.string().optional(),
  params: z
    .object({
      priceField: z.string().optional(),
      quantityField: z.string().optional(),
      originalPriceField: z.string().optional(),
      discountedPriceField: z.string().optional(),
      discountType: z.enum(['percentage', 'amount']).optional(),
      field: z.string().optional(),
      boundaries: z.array(z.number()).optional(),
      labels: z.array(z.string()).optional(),
      fields: z.array(z.string()).optional(),
      separator: z.string().optional(),
    })
    .optional(),
});

// 计算列配置
const ComputeConfigSchema = z.array(ComputeColumnSchema);

// 去重类型
const DedupeTypeSchema = z.enum(['row_number']);

// 去重保留策略
const DedupeKeepStrategySchema = z.enum(['first', 'last']);

// 去重排序列
const DedupeOrderColumnSchema = z.object({
  field: z.string(),
  direction: z.enum(['ASC', 'DESC']),
  nullsLast: z.boolean().optional(),
});

// 去重配置
const DedupeConfigSchema = z.object({
  type: DedupeTypeSchema,
  partitionBy: z.array(z.string()).min(1),
  orderBy: z.array(DedupeOrderColumnSchema).optional(),
  keepStrategy: DedupeKeepStrategySchema.optional(),
  tieBreaker: z.string().optional(),
});

// Lookup类型
const LookupTypeSchema = z.enum(['join', 'map']);

// Lookup配置
const LookupConfigSchema = z.object({
  type: LookupTypeSchema,
  lookupDatasetId: z.string().optional(),
  lookupTable: z.string().optional(),
  joinKey: z.string().min(1),
  lookupKey: z.string().min(1),
  selectColumns: z.array(z.string()).optional(),
  codeMapping: z.record(z.string(), z.any()).optional(),
  leftJoin: z.boolean().optional().default(false),
});

// 注意：词库筛选已从 QueryConfig 中移除

// 验证规则类型
const ValidationRuleTypeSchema = z.enum([
  'is_numeric',
  'is_date',
  'is_email',
  'regex',
  'enum',
  'range',
  'length',
  'cross_field',
]);

// 验证动作
const ValidationActionSchema = z.enum(['filter', 'mark']);

// 验证规则
const ValidationRuleSchema = z.object({
  type: ValidationRuleTypeSchema,
  params: z
    .object({
      pattern: z.string().optional(),
      allowedValues: z.array(z.any()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      minLength: z.number().optional(),
      maxLength: z.number().optional(),
      compareField: z.string().optional(),
      operator: z.enum(['>', '<', '>=', '<=', '=', '!=']).optional(),
    })
    .optional(),
  action: ValidationActionSchema,
  markColumn: z.string().optional(),
  errorMessage: z.string().optional(),
});

// 验证字段配置
const ValidationFieldConfigSchema = z.object({
  field: z.string().min(1),
  rules: z.array(ValidationRuleSchema).min(1),
});

// 验证配置
const ValidationConfigSchema = z.array(ValidationFieldConfigSchema);

// 优化选项
const OptimizationConfigSchema = z.object({
  enablePredicatePushdown: z.boolean().optional().default(true),
  enableProjectionPruning: z.boolean().optional().default(true),
  enableParallelExecution: z.boolean().optional().default(false),
});

// 采样类型
const SampleTypeSchema = z.enum(['percentage', 'rows', 'stratified']);

// 采样配置
const SampleConfigSchema = z.object({
  type: SampleTypeSchema,
  value: z.number().optional(),
  stratifyBy: z.array(z.string()).optional(),
  seed: z.number().int().min(0).optional(),
});

// 拆列/展开类型
const ExplodeTypeSchema = z.enum(['split_columns', 'unnest_array', 'unnest_json']);

// 拆列/展开配置
const ExplodeConfigSchema = z.object({
  field: z.string().min(1),
  type: ExplodeTypeSchema,
  params: z
    .object({
      delimiter: z.string().optional(),
      columnNames: z.array(z.string()).optional(),
      maxSplits: z.number().int().min(1).optional(),
      outputColumn: z.string().optional(),
      jsonPath: z.string().optional(),
    })
    .optional(),
});

// 单层分组配置
const GroupConfigSchema = z.object({
  field: z.string().min(1),
  order: z.enum(['asc', 'desc']),
  showStats: z.boolean().optional().default(true),
  statsFields: z.array(z.string()).optional(),
});

// 聚合函数类型
const AggregateFunctionSchema = z.enum([
  // 基础聚合
  'SUM',
  'COUNT',
  'AVG',
  'MAX',
  'MIN',
  'COUNT_DISTINCT',
  'STDDEV',
  'VARIANCE',
  // 数组聚合
  'ARRAY_AGG',
  'STRING_AGG',
  'LIST',
  // 统计聚合
  'MEDIAN',
  'MODE',
  'QUANTILE',
  'APPROX_COUNT_DISTINCT',
  // 条件聚合
  'ARG_MIN',
  'ARG_MAX',
  'FIRST',
  'LAST',
  // 高级聚合
  'HISTOGRAM',
]);

// 聚合指标配置
const AggregateMeasureSchema = z.object({
  name: z.string().min(1),
  function: AggregateFunctionSchema,
  field: z.string().optional(),
  params: z
    .object({
      distinct: z.boolean().optional(),
      separator: z.string().optional(),
      orderBy: z.string().optional(),
      q: z.number().min(0).max(1).optional(),
      argField: z.string().optional(),
      binWidth: z.number().positive().optional(),
      binCount: z.number().int().positive().optional(),
      minValue: z.number().optional(),
      maxValue: z.number().optional(),
    })
    .optional(),
});

// 分组聚合配置
const AggregateConfigSchema = z.object({
  groupBy: z.array(z.string().min(1)).min(1),
  measures: z.array(AggregateMeasureSchema).min(1),
  having: FilterConfigSchema.optional(),
});

const RowHeightValueSchema = z.union([
  z.enum(['compact', 'normal', 'comfortable']),
  z.number().min(16).max(100),
]);

// 完整查询配置 Schema
const QueryConfigSchema = z.object({
  // 视图级配置（顶层）
  softDelete: SoftDeleteConfigSchema.optional(),

  // 数据处理配置
  sample: SampleConfigSchema.optional(),
  filter: FilterConfigSchema.optional(),
  columns: ColumnConfigSchema.optional(),
  sort: SortConfigSchema.optional(),
  clean: CleanConfigSchema.optional(),
  explode: z.array(ExplodeConfigSchema).optional(),
  compute: ComputeConfigSchema.optional(),
  dedupe: DedupeConfigSchema.optional(),
  lookup: z.array(LookupConfigSchema).optional(),
  // 注意：dictionary 已移除
  validation: ValidationConfigSchema.optional(),
  group: GroupConfigSchema.optional(),
  aggregate: AggregateConfigSchema.optional(),
  rowHeight: RowHeightValueSchema.optional(),
  optimization: OptimizationConfigSchema.optional(),
});

/**
 * 配置验证器类
 */
export class ConfigValidator {
  /**
   * 验证查询配置
   * @returns 验证结果，包含成功/失败、数据、错误和警告
   */
  static validate(config: unknown): {
    success: boolean;
    data?: QueryConfig;
    errors?: string[];
    warnings?: string[];
  } {
    try {
      const result = QueryConfigSchema.safeParse(config);

      if (result.success) {
        // 额外的业务逻辑验证
        const businessValidation = this.validateBusinessLogic(result.data);
        if (!businessValidation.success) {
          return {
            success: false,
            errors: businessValidation.errors,
            warnings: businessValidation.warnings,
          };
        }

        return {
          success: true,
          data: result.data,
          warnings: businessValidation.warnings,
        };
      } else {
        return {
          success: false,
          errors: result.error.errors.map((err) => `${err.path.join('.')}: ${err.message}`),
        };
      }
    } catch (error) {
      return {
        success: false,
        errors: [(error as Error).message],
      };
    }
  }

  /**
   * 业务逻辑验证
   */
  private static validateBusinessLogic(config: QueryConfig): {
    success: boolean;
    errors?: string[];
    warnings?: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 🆕 检查 optimization 配置（实验性功能警告）
    if (config.optimization) {
      const optKeys = Object.keys(config.optimization).filter(
        (k) => (config.optimization as any)[k] !== undefined
      );
      if (optKeys.length > 0) {
        warnings.push(
          `optimization 配置（${optKeys.join(', ')}）当前为实验性功能，尚未实现。` +
            `这些配置将被忽略。QueryEngine 内部已隐式启用谓词下推和投影裁剪优化。`
        );
      }
    }

    // 验证 filter 条件
    if (config.filter?.conditions) {
      for (const condition of config.filter.conditions) {
        // IN/NOT IN 必须提供 values
        if ((condition.type === 'in' || condition.type === 'not_in') && !condition.values) {
          errors.push(`Filter condition '${condition.type}' requires 'values' array`);
        }

        // BETWEEN 必须提供 values 且长度为2
        if (condition.type === 'between') {
          if (!condition.values || condition.values.length !== 2) {
            errors.push(
              `Filter condition 'between' requires 'values' array with exactly 2 elements`
            );
          }
        }

        // REGEX 建议提供超时和长度限制
        if (condition.type === 'regex') {
          if (!condition.options?.regexTimeout) {
            warnings.push(`字段 '${condition.field}' 的正则筛选未设置超时，将使用默认值 5000ms`);
          }
          if (!condition.options?.regexMaxLength) {
            warnings.push(
              `字段 '${condition.field}' 的正则筛选未设置最大长度，将使用默认值 1000 字符`
            );
          }
        }

        // RELATIVE_TIME 必须提供单位和值
        if (condition.type === 'relative_time') {
          if (
            !condition.options?.relativeTimeUnit ||
            condition.options?.relativeTimeValue === undefined
          ) {
            errors.push(
              `Filter condition 'relative_time' requires 'options.relativeTimeUnit' and 'options.relativeTimeValue'`
            );
          }
        }
      }
    }

    // 验证 clean 操作
    if (config.clean) {
      for (const cleanField of config.clean) {
        for (const operation of cleanField.operations) {
          // REPLACE 必须提供 search 和 replaceWith
          if (operation.type === 'replace') {
            if (!operation.params?.search || operation.params?.replaceWith === undefined) {
              errors.push(
                `Clean operation 'replace' on field '${cleanField.field}' requires 'params.search' and 'params.replaceWith'`
              );
            }
          }

          // REGEX_REPLACE 必须提供 pattern 和 replacement
          if (operation.type === 'regex_replace') {
            if (!operation.params?.pattern || operation.params?.replacement === undefined) {
              errors.push(
                `Clean operation 'regex_replace' on field '${cleanField.field}' requires 'params.pattern' and 'params.replacement'`
              );
            }
          }

          // UNIT_CONVERT 必须提供所有参数
          if (operation.type === 'unit_convert') {
            if (!operation.params?.conversionFactor) {
              errors.push(
                `Clean operation 'unit_convert' on field '${cleanField.field}' requires 'params.conversionFactor'`
              );
            }
          }

          // COALESCE 必须提供 fields 数组
          if (operation.type === 'coalesce') {
            if (!operation.params?.fields || operation.params.fields.length === 0) {
              errors.push(
                `Clean operation 'coalesce' on field '${cleanField.field}' requires 'params.fields' array`
              );
            }
          }

          // NULLIF 必须提供 nullValue
          if (operation.type === 'nullif') {
            if (operation.params?.nullValue === undefined) {
              errors.push(
                `Clean operation 'nullif' on field '${cleanField.field}' requires 'params.nullValue'`
              );
            }
          }

          // CAST/TRY_CAST 必须提供 targetType
          if (operation.type === 'cast' || operation.type === 'try_cast') {
            if (!operation.params?.targetType) {
              errors.push(
                `Clean operation '${operation.type}' on field '${cleanField.field}' requires 'params.targetType'`
              );
            }
          }

          // SPLIT_PART 必须提供 delimiter 和 index
          if (operation.type === 'split_part') {
            if (!operation.params?.delimiter || operation.params?.index === undefined) {
              errors.push(
                `Clean operation 'split_part' on field '${cleanField.field}' requires 'params.delimiter' and 'params.index'`
              );
            }
          }

          // CONCAT_FIELDS 必须提供 fields 数组
          if (operation.type === 'concat_fields') {
            if (!operation.params?.fields || operation.params.fields.length === 0) {
              errors.push(
                `Clean operation 'concat_fields' on field '${cleanField.field}' requires 'params.fields' array`
              );
            }
          }
        }
      }
    }

    // 验证 compute 列
    if (config.compute) {
      for (const compute of config.compute) {
        // CUSTOM 类型必须提供 expression
        if (compute.type === 'custom' && !compute.expression) {
          errors.push(`Compute column '${compute.name}' with type 'custom' requires 'expression'`);
        }

        // AMOUNT 必须提供 price 和 quantity 字段
        if (compute.type === 'amount') {
          if (!compute.params?.priceField || !compute.params?.quantityField) {
            errors.push(
              `Compute column '${compute.name}' with type 'amount' requires 'params.priceField' and 'params.quantityField'`
            );
          }
        }

        // DISCOUNT 必须提供原价和折扣价字段
        if (compute.type === 'discount') {
          if (!compute.params?.originalPriceField || !compute.params?.discountedPriceField) {
            errors.push(
              `Compute column '${compute.name}' with type 'discount' requires 'params.originalPriceField' and 'params.discountedPriceField'`
            );
          }
        }

        // BUCKET 必须提供 field 和 boundaries
        if (compute.type === 'bucket') {
          if (!compute.params?.field || !compute.params?.boundaries) {
            errors.push(
              `Compute column '${compute.name}' with type 'bucket' requires 'params.field' and 'params.boundaries'`
            );
          }
        }

        // CONCAT 必须提供 fields
        if (compute.type === 'concat') {
          if (!compute.params?.fields || compute.params.fields.length === 0) {
            errors.push(
              `Compute column '${compute.name}' with type 'concat' requires 'params.fields' array`
            );
          }
        }
      }
    }

    // 验证 lookup
    if (config.lookup) {
      const mapOutputFields = new Set<string>();
      for (const lookup of config.lookup) {
        // JOIN 类型必须提供 lookupDatasetId 或 lookupTable
        if (lookup.type === 'join') {
          if (!lookup.lookupDatasetId && !lookup.lookupTable) {
            errors.push(
              `Lookup with type 'join' requires either 'lookupDatasetId' or 'lookupTable'`
            );
          }
          if (lookup.lookupTable && !SQLUtils.isValidTableReference(String(lookup.lookupTable))) {
            errors.push(
              `Lookup lookupTable '${lookup.lookupTable}' is invalid. Expected identifier or schema.table`
            );
          }
        }

        // MAP 类型必须提供 codeMapping
        if (lookup.type === 'map' && !lookup.codeMapping) {
          errors.push(`Lookup with type 'map' requires 'codeMapping'`);
        }

        if (lookup.type === 'map') {
          if (mapOutputFields.has(lookup.lookupKey)) {
            errors.push(`Duplicate map lookup output column '${lookup.lookupKey}'`);
          }
          mapOutputFields.add(lookup.lookupKey);
        }
      }
    }

    // 验证 validation
    if (config.validation) {
      for (const validField of config.validation) {
        for (const rule of validField.rules) {
          // MARK 动作必须提供 markColumn
          if (rule.action === 'mark' && !rule.markColumn) {
            errors.push(
              `Validation rule on field '${validField.field}' with action 'mark' requires 'markColumn'`
            );
          }

          // REGEX 必须提供 pattern
          if (rule.type === 'regex' && !rule.params?.pattern) {
            errors.push(
              `Validation rule 'regex' on field '${validField.field}' requires 'params.pattern'`
            );
          }

          // ENUM 必须提供 allowedValues
          if (rule.type === 'enum' && !rule.params?.allowedValues) {
            errors.push(
              `Validation rule 'enum' on field '${validField.field}' requires 'params.allowedValues'`
            );
          }

          // RANGE 必须提供 min 或 max
          if (
            rule.type === 'range' &&
            rule.params?.min === undefined &&
            rule.params?.max === undefined
          ) {
            errors.push(
              `Validation rule 'range' on field '${validField.field}' requires at least 'params.min' or 'params.max'`
            );
          }

          // LENGTH 必须提供 minLength 或 maxLength
          if (
            rule.type === 'length' &&
            rule.params?.minLength === undefined &&
            rule.params?.maxLength === undefined
          ) {
            errors.push(
              `Validation rule 'length' on field '${validField.field}' requires at least 'params.minLength' or 'params.maxLength'`
            );
          }

          // CROSS_FIELD 必须提供 compareField 和 operator
          if (
            rule.type === 'cross_field' &&
            (!rule.params?.compareField || !rule.params?.operator)
          ) {
            errors.push(
              `Validation rule 'cross_field' on field '${validField.field}' requires 'params.compareField' and 'params.operator'`
            );
          }
        }
      }
    }

    // 验证 sort 和 pagination 的互斥性
    if (config.sort?.topK && config.sort?.pagination) {
      errors.push(`Sort config cannot have both 'topK' and 'pagination' enabled`);
    }

    // 🆕 验证 sample
    if (config.sample) {
      const { type, value, stratifyBy } = config.sample;

      // percentage: 0.001 - 99.9
      if (type === 'percentage') {
        if (value === undefined) {
          errors.push(`Sample percentage requires 'value'`);
        } else if (value < 0.001 || value > 99.9) {
          errors.push(`Sample percentage must be between 0.001 and 99.9, got ${value}`);
        }
      }

      // rows: 正整数
      if (type === 'rows') {
        if (value === undefined) {
          errors.push(`Sample rows requires 'value'`);
        } else if (value <= 0 || !Number.isInteger(value)) {
          errors.push(`Sample rows must be a positive integer, got ${value}`);
        } else if (value > 10_000_000) {
          errors.push(`Sample rows cannot exceed 10000000, got ${value}`);
        }
      }

      // stratified: 必须提供 stratifyBy
      if (type === 'stratified' && (!stratifyBy || stratifyBy.length === 0)) {
        errors.push(`Sample type 'stratified' requires 'stratifyBy' fields`);
      }
      if (type === 'stratified' && value !== undefined && value <= 0) {
        errors.push(`Stratified sample value must be positive, got ${value}`);
      }
    }

    // 🆕 验证 explode
    if (config.explode) {
      for (const explode of config.explode) {
        // split_columns: 必须提供 delimiter
        if (explode.type === 'split_columns' && !explode.params?.delimiter) {
          errors.push(
            `Explode type 'split_columns' on field '${explode.field}' requires 'params.delimiter'`
          );
        }

        // unnest_array/unnest_json: 必须提供 outputColumn
        if (
          (explode.type === 'unnest_array' || explode.type === 'unnest_json') &&
          !explode.params?.outputColumn
        ) {
          errors.push(
            `Explode type '${explode.type}' on field '${explode.field}' requires 'params.outputColumn'`
          );
        }

        // unnest_json: 建议提供 jsonPath
        if (explode.type === 'unnest_json' && !explode.params?.jsonPath) {
          warnings.push(`字段 '${explode.field}' 的 unnest_json 未设置 jsonPath，将展开整个 JSON`);
        }
      }
    }

    // 🆕 验证 aggregate
    if (config.aggregate) {
      const { groupBy, measures, having } = config.aggregate;

      // 验证 measures
      for (const measure of measures) {
        // 检查需要 field 的聚合函数（使用共享常量）
        if (
          AGGREGATE_FUNCTIONS_REQUIRING_FIELD.includes(measure.function as any) &&
          !measure.field
        ) {
          errors.push(
            `Aggregate measure '${measure.name}' with function '${measure.function}' requires 'field'`
          );
        }

        // STRING_AGG: 验证 separator 长度
        if (
          measure.function === 'STRING_AGG' &&
          measure.params?.separator &&
          measure.params.separator.length > 10
        ) {
          warnings.push(
            `聚合指标 '${measure.name}' 的 STRING_AGG 分隔符过长（${measure.params.separator.length} 字符）`
          );
        }

        // ARRAY_AGG: 验证 orderBy 字段不为空
        if (
          measure.function === 'ARRAY_AGG' &&
          measure.params?.orderBy &&
          measure.params.orderBy.trim() === ''
        ) {
          errors.push(`ARRAY_AGG measure '${measure.name}' has empty 'params.orderBy'`);
        }

        // QUANTILE: 必须提供 q 参数
        if (
          measure.function === 'QUANTILE' &&
          (measure.params?.q === undefined || measure.params.q < 0 || measure.params.q > 1)
        ) {
          errors.push(`QUANTILE measure '${measure.name}' requires 'params.q' between 0 and 1`);
        }

        // ARG_MIN / ARG_MAX: 必须提供 argField
        if (
          (measure.function === 'ARG_MIN' || measure.function === 'ARG_MAX') &&
          !measure.params?.argField
        ) {
          errors.push(
            `${measure.function} measure '${measure.name}' requires 'params.argField' (the field to return)`
          );
        }

        // HISTOGRAM: 必须提供 binWidth 或 binCount
        if (
          measure.function === 'HISTOGRAM' &&
          !measure.params?.binWidth &&
          !measure.params?.binCount
        ) {
          errors.push(
            `HISTOGRAM measure '${measure.name}' requires either 'params.binWidth' or 'params.binCount'`
          );
        }
      }

      // 验证 HAVING 条件中的字段
      // HAVING 只能引用 GROUP BY 字段或聚合函数结果
      if (having && having.conditions) {
        const validHavingFields = new Set([...groupBy, ...measures.map((m) => m.name)]);

        for (const condition of having.conditions) {
          if (!validHavingFields.has(condition.field)) {
            errors.push(
              `HAVING condition references field '${condition.field}' which is not in GROUP BY or aggregate measures. Valid fields: ${Array.from(validHavingFields).join(', ')}`
            );
          }
        }
      }

      // 验证聚合指标名称不与分组字段重名
      const measureNames = new Set(measures.map((m) => m.name));
      for (const groupField of groupBy) {
        if (measureNames.has(groupField)) {
          errors.push(
            `Aggregate measure name '${groupField}' conflicts with GROUP BY field name. Please use a different name.`
          );
        }
      }
    }

    // 🆕 验证 aggregate 和 group 互斥
    if (config.aggregate && config.group) {
      errors.push(
        `Cannot use both 'aggregate' and 'group' in the same query. Use 'aggregate' for multi-field grouping with aggregations, or 'group' for single-field UI grouping.`
      );
    }

    return {
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}
