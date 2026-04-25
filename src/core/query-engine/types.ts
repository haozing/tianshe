/**
 * DuckDB 查询构造引擎 - 类型定义
 * 支持通过JSON配置生成优化的SQL查询
 */

/**
 * 筛选条件类型
 */
export type FilterConditionType =
  | 'equal' // 等值
  | 'not_equal' // 不等
  | 'greater_than' // 大于
  | 'less_than' // 小于
  | 'greater_equal' // 大于等于
  | 'less_equal' // 小于等于
  | 'between' // 区间
  | 'contains' // 包含（单值）
  | 'not_contains' // 不包含（单值）
  | 'starts_with' // 开头
  | 'ends_with' // 结尾
  | 'regex' // 正则
  | 'in' // IN
  | 'not_in' // NOT IN
  | 'null' // 为空
  | 'not_null' // 非空
  | 'relative_time' // 相对时间
  | 'soft_delete'; // 软删除筛选

/**
 * 软删除显示模式
 */
export type SoftDeleteShow = 'active' | 'deleted' | 'all';

/**
 * 软删除配置（视图级设置）
 */
export interface SoftDeleteConfig {
  field: string; // 软删除字段名 (deleted_at, _is_deleted, is_deleted)
  show: SoftDeleteShow; // 显示模式
}

/**
 * 时间单位
 */
export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * 筛选条件配置
 */
export interface FilterCondition {
  type: FilterConditionType;
  field: string;
  value?: any;
  values?: any[]; // for IN/NOT IN/BETWEEN
  options?: {
    caseSensitive?: boolean; // 大小写敏感
    regexTimeout?: number; // 正则超时（毫秒）
    regexMaxLength?: number; // 正则匹配字符串最大长度
    relativeTimeUnit?: TimeUnit; // 相对时间单位
    relativeTimeValue?: number; // 相对时间值
    relativeTimeDirection?: 'past' | 'future'; // 相对时间方向
    softDeleteStates?: SoftDeleteShow[]; // 软删除状态筛选
  };
}

/**
 * 筛选配置
 */
export interface FilterConfig {
  conditions?: FilterCondition[];
  combinator?: 'AND' | 'OR';
}

/**
 * 选列配置
 */
export interface ColumnConfig {
  select?: string[]; // 选择的列（未指定则为*）
  rename?: Record<string, string>; // 重命名: { oldName: newName }
  hide?: string[]; // 隐藏敏感列（从结果中移除）
  show?: string[]; // 当前视图强制显示的列（覆盖数据集默认隐藏）
}

/**
 * 排序列配置
 */
export interface SortColumn {
  field: string;
  direction: 'ASC' | 'DESC';
  nullsFirst?: boolean;
}

/**
 * 分页配置
 */
export interface PaginationConfig {
  page: number; // 页码（从1开始）
  pageSize: number; // 每页大小
}

/**
 * 排序配置
 */
export interface SortConfig {
  columns?: SortColumn[];
  topK?: number; // TOP K条记录
  pagination?: PaginationConfig; // 分页
}

/**
 * 数据类型（用于类型转换）
 */
export type DataType =
  | 'VARCHAR'
  | 'TEXT'
  | 'STRING'
  | 'INTEGER'
  | 'INT'
  | 'BIGINT'
  | 'SMALLINT'
  | 'TINYINT'
  | 'DOUBLE'
  | 'FLOAT'
  | 'DECIMAL'
  | 'NUMERIC'
  | 'BOOLEAN'
  | 'BOOL'
  | 'DATE'
  | 'TIMESTAMP'
  | 'TIME'
  | 'JSON';

/**
 * 清洗操作类型
 */
export type CleanOperationType =
  // === 文本基础清洗 ===
  | 'trim' // 去除首尾空格
  | 'trim_start' // 去除开头空格
  | 'trim_end' // 去除结尾空格
  | 'upper' // 转大写
  | 'lower' // 转小写
  | 'title' // 首字母大写
  | 'to_halfwidth' // 转半角
  | 'to_fullwidth' // 转全角
  | 'replace' // 替换
  | 'regex_replace' // 正则替换

  // === 空值处理 ===
  | 'fill_null' // 填充空值
  | 'coalesce' // 多字段合并（取首个非空）
  | 'nullif' // 条件转空值

  // === 类型转换 ===
  | 'cast' // 类型转换（严格）
  | 'try_cast' // 安全转换（失败返回NULL）

  // === 数值处理 ===
  | 'unit_convert' // 单位换算
  | 'round' // 四舍五入
  | 'floor' // 向下取整
  | 'ceil' // 向上取整
  | 'abs' // 绝对值

  // === 日期时间 ===
  | 'parse_date' // 解析日期
  | 'format_date' // 格式化日期

  // === 高级清洗（新增）===
  | 'normalize_space' // 标准化空格
  | 'remove_special_chars' // 移除特殊字符
  | 'truncate' // 截断文本
  | 'normalize_email' // 邮箱标准化
  | 'split_part' // 拆分字符串取部分
  | 'concat_fields' // 连接多个字段
  | 'extract_numbers'; // 提取数字

/**
 * 清洗操作配置
 */
export interface CleanOperation {
  type: CleanOperationType;
  params?: {
    // === 通用参数 ===
    value?: any; // 填充/默认值

    // === 字符串操作 ===
    search?: string; // replace
    replaceWith?: string;
    pattern?: string; // regex_replace
    replacement?: string;

    // === 空值处理 ===
    fields?: string[]; // coalesce: 多字段合并
    nullValue?: any; // nullif: 要转为NULL的值

    // === 类型转换 ===
    targetType?: DataType; // cast/try_cast: 目标类型

    // === 数值处理 ===
    fromUnit?: string; // unit_convert
    toUnit?: string;
    conversionFactor?: number;
    decimals?: number; // round: 小数位数

    // === 日期时间 ===
    dateFormat?: string; // parse_date/format_date: 日期格式（如 '%Y-%m-%d'）

    // === 高级清洗（新增）===
    keepPattern?: string; // remove_special_chars: 保留字符的正则模式
    maxLength?: number; // truncate: 最大长度
    suffix?: string; // truncate: 截断后缀（默认'...'）
    delimiter?: string; // split_part: 分隔符
    index?: number; // split_part: 索引位置
    separator?: string; // concat_fields: 连接分隔符
  };
}

/**
 * 清洗字段配置
 */
export interface CleanFieldConfig {
  field: string;
  operations: CleanOperation[];
  outputField?: string; // 输出字段名（未指定则覆盖原字段）
}

/**
 * 清洗配置
 */
export type CleanConfig = CleanFieldConfig[];

/**
 * 计算列类型
 */
export type ComputeColumnType =
  | 'amount' // 金额计算
  | 'discount' // 折扣计算
  | 'bucket' // 分桶
  | 'concat' // 拼接
  | 'custom'; // 自定义表达式

/**
 * 计算列配置
 */
export interface ComputeColumn {
  name: string; // 新列名
  type: ComputeColumnType;
  expression?: string; // SQL表达式（type=custom时必需）
  params?: {
    // amount
    priceField?: string;
    quantityField?: string;

    // discount
    originalPriceField?: string;
    discountedPriceField?: string;
    discountType?: 'percentage' | 'amount';

    // bucket
    field?: string;
    boundaries?: number[]; // 分桶边界
    labels?: string[]; // 桶标签

    // concat
    fields?: string[];
    separator?: string;
  };
}

/**
 * 计算列配置
 */
export type ComputeConfig = ComputeColumn[];

/**
 * 去重类型
 */
export type DedupeType = 'row_number';

/**
 * 去重保留策略
 *
 * 实现状态：
 * - ✅ 'first': 保留排序后的第一条
 * - ✅ 'last': 保留排序后的最后一条
 */
export type DedupeKeepStrategy =
  | 'first' // 保留第一条
  | 'last'; // 保留最后一条

/**
 * 排序字段配置（支持独立方向）
 */
export interface DedupeOrderColumn {
  field: string;
  direction: 'ASC' | 'DESC';
  nullsLast?: boolean; // NULL 排在最后
}

/**
 * 去重配置
 *
 * 核心功能：
 * - row_number: 通过 ROW_NUMBER 窗口函数去重，实际删除重复行
 */
export interface DedupeConfig {
  type: DedupeType;
  partitionBy: string[]; // 分组字段（必填）

  // 排序配置
  orderBy?: DedupeOrderColumn[]; // 排序字段（支持独立方向控制）
  keepStrategy?: DedupeKeepStrategy; // 保留策略（默认 'first'）

  // 确定性排序的 tie-breaker
  tieBreaker?: string; // 唯一标识字段（如 id），强烈推荐设置以保证结果确定性
}

/**
 * 去重预览统计
 */
export interface DedupePreviewStats {
  totalRows: number; // 总行数
  uniqueRows: number; // 唯一行数
  duplicateRows: number; // 重复行数
  duplicateGroups: number; // 重复组数
  willBeRemoved: number; // 将被删除的行数
  willBeKept: number; // 将被保留的行数

  // 重复度分布
  duplicateDistribution: {
    groupSize: number; // 组大小（2条、3条...）
    count: number; // 该大小的组数量
  }[];

  // Top 重复字段组合
  topDuplicates: {
    values: Record<string, any>; // 字段值组合
    count: number; // 出现次数
  }[];
}

/**
 * 去重预览结果
 */
export interface DedupePreviewResult {
  stats: DedupePreviewStats;
  sampleKept: any[]; // 将保留的样本数据
  sampleRemoved: any[]; // 将被删除的样本数据
  generatedSQL: string; // 生成的SQL（供调试）
}

/**
 * Lookup类型
 */
export type LookupType = 'join' | 'map';

/**
 * Lookup配置
 */
export interface LookupConfig {
  type: LookupType;
  lookupDatasetId?: string; // 维表数据集ID
  lookupTable?: string; // 维表名称（直接指定）
  joinKey: string; // 主表关联键
  lookupKey: string; // 维表关联键
  selectColumns?: string[]; // 从维表选择的列
  codeMapping?: Record<string, any>; // 码值映射（type=map时）
  leftJoin?: boolean; // 是否左连接（默认INNER）
}

// 注意：词库筛选已从 QueryConfig 中移除

/**
 * 验证规则类型
 */
export type ValidationRuleType =
  | 'is_numeric' // 是否数值
  | 'is_date' // 是否日期
  | 'is_email' // 是否邮箱
  | 'regex' // 正则校验
  | 'enum' // 枚举校验
  | 'range' // 范围校验
  | 'length' // 长度校验
  | 'cross_field'; // 跨字段比较

/**
 * 验证动作
 */
export type ValidationAction = 'filter' | 'mark';

/**
 * 验证规则配置
 */
export interface ValidationRule {
  type: ValidationRuleType;
  params?: {
    // regex
    pattern?: string;

    // enum
    allowedValues?: any[];

    // range
    min?: number;
    max?: number;

    // length
    minLength?: number;
    maxLength?: number;

    // cross_field
    compareField?: string;
    operator?: '>' | '<' | '>=' | '<=' | '=' | '!=';
  };
  action: ValidationAction;
  markColumn?: string; // 标记列名（action=mark时）
  errorMessage?: string;
}

/**
 * 验证字段配置
 */
export interface ValidationFieldConfig {
  field: string;
  rules: ValidationRule[];
}

/**
 * 验证配置
 */
export type ValidationConfig = ValidationFieldConfig[];

/**
 * 采样类型
 */
export type SampleType = 'percentage' | 'rows' | 'stratified';

/**
 * 采样配置
 */
export interface SampleConfig {
  type: SampleType;
  value?: number; // percentage: 0-100, rows: 正整数
  stratifyBy?: string[]; // 分层采样字段
  seed?: number; // 随机种子（可重现）
}

/**
 * 拆列/展开类型
 */
export type ExplodeType = 'split_columns' | 'unnest_array' | 'unnest_json';

/**
 * 拆列/展开配置
 */
export interface ExplodeConfig {
  field: string; // 要拆分/展开的字段
  type: ExplodeType;
  params?: {
    // split_columns: 拆成多列
    delimiter?: string; // 分隔符，如 ','
    columnNames?: string[]; // 拆分后的列名，如 ['tag1', 'tag2']
    maxSplits?: number; // 最多拆几列

    // unnest_array / unnest_json: 展开成多行
    outputColumn?: string; // 展开后的列名
    jsonPath?: string; // JSON路径，如 '$.tags[*]'
  };
}

/**
 * 聚合函数类型
 */
export type AggregateFunction =
  // 基础聚合
  | 'SUM'
  | 'COUNT'
  | 'AVG'
  | 'MAX'
  | 'MIN'
  | 'COUNT_DISTINCT'
  | 'STDDEV'
  | 'VARIANCE'

  // 数组聚合
  | 'ARRAY_AGG'
  | 'STRING_AGG'
  | 'LIST' // LIST: 去重数组聚合

  // 统计聚合
  | 'MEDIAN'
  | 'MODE' // 中位数、众数
  | 'QUANTILE' // 分位数 (需要 params.q)
  | 'APPROX_COUNT_DISTINCT' // 近似去重计数（快10-100倍）

  // 条件聚合
  | 'ARG_MIN'
  | 'ARG_MAX' // 返回最值对应的字段
  | 'FIRST'
  | 'LAST' // 首尾值

  // 高级聚合
  | 'HISTOGRAM'; // 直方图分桶

/**
 * 需要指定字段的聚合函数列表
 * COUNT(*) 不需要字段，其他聚合函数都需要
 *
 * 用于 ConfigValidator 和 AggregateBuilder 的验证逻辑
 */
export const AGGREGATE_FUNCTIONS_REQUIRING_FIELD: readonly AggregateFunction[] = [
  'SUM',
  'AVG',
  'MAX',
  'MIN',
  'COUNT_DISTINCT',
  'STDDEV',
  'VARIANCE',
  'STRING_AGG',
  'ARRAY_AGG',
  'LIST',
  'MEDIAN',
  'MODE',
  'QUANTILE',
  'APPROX_COUNT_DISTINCT',
  'ARG_MIN',
  'ARG_MAX',
  'FIRST',
  'LAST',
  'HISTOGRAM',
] as const;

/**
 * 聚合指标配置
 */
export interface AggregateMeasure {
  name: string; // 新列名
  function: AggregateFunction;
  field?: string; // COUNT(*) 时不需要
  params?: {
    // COUNT / ARRAY_AGG / STRING_AGG 通用
    distinct?: boolean; // COUNT(DISTINCT field)
    separator?: string; // STRING_AGG 分隔符
    orderBy?: string; // ARRAY_AGG / FIRST / LAST 排序

    // QUANTILE 分位数 (0-1)
    q?: number; // 例: 0.5 = 中位数, 0.95 = 95分位

    // ARG_MIN / ARG_MAX 参数
    argField?: string; // 要返回的字段 (例：找到价格最大的产品名称)

    // HISTOGRAM 参数
    binWidth?: number; // 分桶宽度
    binCount?: number; // 分桶数量
    minValue?: number; // 最小值
    maxValue?: number; // 最大值
  };
}

/**
 * 分组聚合配置
 */
export interface AggregateConfig {
  groupBy: string[]; // 分组字段（必需）
  measures: AggregateMeasure[]; // 聚合指标（必需）
  having?: FilterConfig; // HAVING 条件（可选）
}

/**
 * 优化选项
 *
 * ⚠️ 实验性功能 - 当前版本尚未实现
 *
 * 这些配置项目前被定义但未生效。QueryEngine 内部已经实现了：
 * - 谓词下推：Filter 在 CTE 链早期执行
 * - 投影裁剪：ColumnBuilder 在最后执行 SELECT 投影
 *
 * 这些是隐式优化，无法通过配置控制。
 * 未来版本可能会实现显式控制，届时会移除此警告。
 *
 * @experimental 未实现，配置将被忽略
 */
export interface OptimizationConfig {
  /** @experimental 未实现 - 谓词下推已隐式启用 */
  enablePredicatePushdown?: boolean;
  /** @experimental 未实现 - 投影裁剪已隐式启用 */
  enableProjectionPruning?: boolean;
  /** @experimental 未实现 - DuckDB 本身支持并行执行 */
  enableParallelExecution?: boolean;
}

export type RowHeightValue = 'compact' | 'normal' | 'comfortable' | number;

/**
 * 完整查询配置
 */
export interface QueryConfig {
  // 🎯 视图级配置（顶层）
  softDelete?: SoftDeleteConfig; // 软删除显示设置（在所有操作之前应用）

  // 数据处理配置
  sample?: SampleConfig; // 采样（可选）
  filter?: FilterConfig;
  columns?: ColumnConfig;
  sort?: SortConfig;
  clean?: CleanConfig;
  explode?: ExplodeConfig[]; // 拆列/展开（可选，支持多个）
  compute?: ComputeConfig;
  dedupe?: DedupeConfig;
  lookup?: LookupConfig[];
  validation?: ValidationConfig;
  group?: GroupConfig; // 单层分组（可选）
  aggregate?: AggregateConfig; // 分组聚合（可选）
  // 兼容扩展：填色面板配置
  color?: ColorConfig;
  rowHeight?: RowHeightValue; // 视图行高（仅影响前端展示）
  optimization?: OptimizationConfig;
  // 注意：dictionary 配置已移除
}

/**
 * SQL生成上下文
 */
export interface SQLContext {
  datasetId: string;
  currentTable: string;
  ctes: Array<{ name: string; sql: string }>;
  availableColumns: Set<string>;
  isAggregated?: boolean; // 🆕 标记是否已降维（聚合后）
}

/**
 * 查询执行结果
 */
export interface QueryExecutionResult {
  success: boolean;
  columns?: string[];
  rows?: any[];
  rowCount?: number;
  executionTime?: number;
  generatedSQL?: string;
  error?: string;
  errorDetails?: any; // 错误详情（包含原始 DuckDB 错误）
  isTruncated?: boolean; // 🆕 结果是否被截断（应用了默认 LIMIT）
  warnings?: string[]; // 🆕 警告信息列表
}

/**
 * 单层分组配置（使用 DuckDB 窗口函数）
 */
export interface GroupConfig {
  field: string; // 分组字段
  order: 'asc' | 'desc'; // 分组排序
  showStats?: boolean; // 是否显示分组统计（默认 true）
  statsFields?: string[]; // 需要统计的字段（默认为数值字段）
}

/**
 * 填色规则（单元格级别）
 */
export interface ColorRule {
  id: string;
  column: string;
  operator:
    | 'eq'
    | 'ne'
    | 'gt'
    | 'lt'
    | 'gte'
    | 'lte'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'isEmpty'
    | 'isNotEmpty';
  value: string;
  color: string; // 十六进制颜色值
}

/**
 * 填色配置（单元格级别）
 */
export interface ColorConfig {
  type: 'color';
  rules: ColorRule[];
}

/**
 * 清洗预览选项
 */
export interface CleanPreviewOptions {
  limit?: number; // 预览行数（默认 10）
  offset?: number; // 起始偏移（默认 0）
}

/**
 * 变更类型
 */
export type ChangeType =
  | 'trimmed' // 去除空格
  | 'case_changed' // 大小写变更
  | 'space_normalized' // 空格标准化
  | 'null_filled' // 空值填充
  | 'nullified' // 转为空值
  | 'number_formatted' // 数值格式化
  | 'type_converted' // 类型转换
  | 'date_parsed' // 日期解析
  | 'other'; // 其他变更

/**
 * 变更记录
 */
export interface ChangeRecord {
  rowIndex: number; // 行索引
  field: string; // 字段名
  originalValue: any; // 原始值
  cleanedValue: any; // 清洗后的值
  changeType: ChangeType; // 变更类型
}

/**
 * 预览统计信息
 */
export interface PreviewStats {
  totalRows: number; // 总行数
  changedRows: number; // 修改的行数
  totalChanges: number; // 总变更数
  nullsRemoved: number; // 移除的空值数
  nullsAdded: number; // 新增的空值数
  byField: Record<string, number>; // 按字段统计
  byType: Record<ChangeType, number>; // 按类型统计
}

/**
 * 清洗预览结果
 */
export interface CleanPreviewResult {
  originalData: any[]; // 原始数据
  cleanedData: any[]; // 清洗后的数据
  changes: ChangeRecord[]; // 变更记录
  stats: PreviewStats; // 统计信息
  sql: string; // 生成的 SQL
}

// ========== 🆕 操作预览相关类型 ==========

/**
 * 筛选预览结果（仅返回计数）
 */
export interface FilterPreviewResult {
  totalRows: number; // 原始总行数
  matchedRows: number; // 匹配的行数
  filteredRows: number; // 被过滤的行数
  matchRate: number; // 匹配率（0-1）
  executionTime?: number; // 执行时间（毫秒）
}

/**
 * 聚合预览结果
 */
export interface AggregatePreviewResult {
  estimatedRows: number; // 预估聚合后行数
  reductionRatio: number; // 数据降维比例（0-1）
  sampleRows: any[]; // 前N条样本数据
  stats: {
    originalRows: number; // 原始行数
    groupCount: number; // 分组数量
    avgGroupSize: number; // 平均组大小
    maxGroupSize: number; // 最大组大小
    minGroupSize: number; // 最小组大小
  };
  generatedSQL: string; // 生成的SQL
}

/**
 * 采样预览结果
 */
export interface SamplePreviewResult {
  sampleSize: number; // 采样后数据量
  samplingRatio: number; // 采样比例（0-1）
  stats: {
    originalRows: number; // 原始行数
    selectedRows: number; // 采样行数
    method: SampleType; // 采样方法
    seed?: number; // 随机种子
    stratifyBy?: string[]; // 分层字段
  };
  quality?: {
    representativeness?: number; // 代表性评分（0-1，仅分层采样）
    distributionMatch?: string; // 分布匹配度描述
  };
}

export interface LookupPreviewCore {
  stats: {
    totalRows: number; // 主表总行数
    matchedRows: number; // 匹配成功的行数
    unmatchedRows: number; // 未匹配的行数
    matchRate: number; // 匹配率（0-1）
    resultRows: number; // 按当前 JOIN 配置执行后的结果行数
    duplicatedRows?: number; // JOIN导致的重复行数
  };
  sampleMatched: any[]; // 匹配成功的样本（前5条）
  sampleUnmatched: any[]; // 未匹配的样本（前5条）
  warnings?: string[]; // 警告信息（如匹配率过低）
  generatedSQL: string; // 生成的SQL
}

export interface LookupPreviewStep extends LookupPreviewCore {
  index: number;
  lookup: LookupConfig;
}

/**
 * 关联预览结果
 */
export interface LookupPreviewResult extends LookupPreviewCore {
  steps?: LookupPreviewStep[];
}

/**
 * 计算列验证结果
 */
export interface ComputeValidationResult {
  valid: boolean; // 表达式是否有效
  error?: string; // 错误信息
  previewValues: any[]; // 前N行的计算结果
  stats?: {
    nullCount: number; // NULL值数量
    distinctCount: number; // 唯一值数量
    dataType?: string; // 推断的数据类型
  };
}

/**
 * 分组预览结果
 */
export interface GroupPreviewResult {
  groupCount: number; // 分组数量
  sampleGroups: any[]; // 样本分组数据（前5组）
  stats: {
    avgGroupSize: number; // 平均组大小
    maxGroupSize: number; // 最大组大小
    minGroupSize: number; // 最小组大小
  };
}

/**
 * 去重预览选项
 */
export interface DedupePreviewOptions {
  sampleSize?: number; // 样本数量限制（默认0，0 表示不返回样本）
  limitStats?: number; // Top 重复组合数量限制（默认10）
  baseConfig?: QueryConfig; // 预览前先应用的基础查询配置（不包含 dedupe）
}

/**
 * 通用预览选项
 */
export interface PreviewOptions {
  limit?: number; // 返回的样本数量（默认5）
  timeout?: number; // 超时时间（毫秒，默认5000）
}
