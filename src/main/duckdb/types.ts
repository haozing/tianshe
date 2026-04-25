/**
 * DuckDB 相关类型定义
 */

import type {
  FailureBundle,
  RecentFailureSummary,
  RuntimeArtifact,
  RuntimeEvent,
  TraceTimeline,
  TraceSummary,
} from '../../core/observability/types';

export interface LogEntry {
  id?: number;
  taskId: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  stepIndex?: number;
  message: string;
  data?: any;
}

export interface Dataset {
  id: string;
  name: string;
  filePath: string;
  rowCount: number;
  columnCount: number;
  sizeBytes: number;
  createdAt: number;
  lastQueriedAt?: number;
  schema?: EnhancedColumnSchema[]; // 使用增强schema
  folderId?: string | null; // 所属文件夹ID
  tableOrder?: number; // 文件夹内的排序
  // 内容区 Tab 分组（同组多表）
  tabGroupId?: string | null;
  tabOrder?: number;
  isGroupDefault?: boolean;
  // 插件创建标记（兼容旧字段）
  createdByPlugin?: string | null;
}

export interface DatasetPlacementOptions {
  folderId?: string | null;
}

export interface ColumnSchema {
  name: string;
  type: string;
}

/**
 * 字段类型枚举（业务层面的类型）
 */
export type FieldType =
  // 基础类型
  | 'text' // 普通文本
  | 'number' // 数字
  | 'boolean' // 布尔值
  | 'date' // 日期/时间

  // 选择类型
  | 'single_select' // 单选
  | 'multi_select' // 多选

  // 语义类型（底层是文本，但带验证）
  | 'email' // Email地址
  | 'url' // URL链接
  | 'phone' // 电话号码
  | 'uuid' // UUID标识符
  | 'ip_address' // IP地址

  // 富文本和媒体
  | 'hyperlink' // 超链接
  | 'attachment' // 附件

  // 高级类型
  | 'json' // JSON数据
  | 'array' // 数组

  // 交互类型
  | 'button' // 按钮

  // 自增类型
  | 'auto_increment'; // 自增ID

/**
 * 存储模式（数据列 vs 计算列）
 */
export type StorageMode = 'physical' | 'computed';

/**
 * 计算列配置（从 query-engine 引入）
 */
export interface ComputeColumnConfig {
  type: 'amount' | 'discount' | 'bucket' | 'concat' | 'custom';
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
 * 验证规则（从validation-engine导入）
 */
export interface ValidationRule {
  type: 'required' | 'unique' | 'regex' | 'range' | 'length' | 'check' | 'enum';
  params?: any;
  errorMessage?: string;
}

/**
 * 列显示配置（UI相关）
 */
export interface ColumnDisplayConfig {
  width?: number; // 列宽（px）
  frozen?: boolean; // 是否冻结
  order?: number; // 显示顺序
  hidden?: boolean; // 是否隐藏
  pinned?: 'left' | 'right'; // 固定位置
}

/**
 * 增强的列Schema（包含业务类型元数据）
 */
export interface EnhancedColumnSchema {
  name: string;
  duckdbType: string; // DuckDB物理类型 (VARCHAR, DOUBLE, DATE等)
  fieldType: FieldType; // 业务逻辑类型
  nullable: boolean; // 是否可空

  // 存储模式（新增）
  storageMode?: StorageMode; // 默认 'physical'

  // 验证规则
  validationRules?: ValidationRule[]; // 数据验证规则

  // 显示配置（新增）
  displayConfig?: ColumnDisplayConfig; // UI显示配置

  // 元数据（二选一）
  metadata?: ColumnMetadata; // 数据列的元数据
  computeConfig?: ComputeColumnConfig; // 计算列的配置
}

/**
 * 附件元数据
 */
export interface AttachmentMetadata {
  id: string; // 唯一标识
  filename: string; // 文件名
  size: number; // 文件大小（字节）
  uploadTime: number; // 上传时间戳
  path: string; // 相对路径
  mimeType?: string; // MIME类型
}

/**
 * 列元数据
 */
export interface ColumnMetadata {
  // 通用
  description?: string; // 字段描述
  defaultValue?: any; // 默认值

  // 单选/多选
  options?: string[]; // 可选值列表
  separator?: string; // 多选分隔符（如 ',' 或 ';'）
  colorMap?: Record<string, string>; // 选项颜色映射

  // 数字
  format?: 'integer' | 'decimal' | 'percentage' | 'currency' | 'thousand' | 'thousand_decimal';
  precision?: number;

  // 日期
  dateFormat?: string;
  includeTime?: boolean;

  // 附件/链接
  maxFileSize?: number; // 最大文件大小（字节）
  allowedTypes?: string[]; // 允许的文件类型
  fileType?: string; // 文件类型：'image' | 'document' | 'video' | 'audio' | 'archive'
  isRemote?: boolean; // 是否为远程文件（URL）还是本地路径
  renderAs?: string; // 渲染提示：'image_preview' | 'link' 等
  // 快速判断标记
  isImage?: boolean; // 是否为图片
  isDocument?: boolean; // 是否为文档
  isVideo?: boolean; // 是否为视频
  isAudio?: boolean; // 是否为音频
  isArchive?: boolean; // 是否为压缩包

  // 按钮字段（仅支持JS插件，固定传递 rowid 和 datasetId）
  pluginId?: string; // JS插件ID
  pluginType?: 'js'; // 插件类型（固定为 'js'）
  methodId?: string; // JS插件方法ID
  buttonLabel?: string; // 按钮文字
  buttonIcon?: string; // 按钮图标
  buttonColor?: string; // 按钮颜色 (blue, cyan, green, orange, red, pink, purple, black)
  buttonVariant?: 'default' | 'primary' | 'success' | 'danger'; // 按钮样式（向后兼容）
  confirmMessage?: string; // 执行前的确认消息
  showResult?: boolean; // 是否显示执行结果

  // 系统列标记
  isSystemColumn?: boolean; // 是否为系统列（如 _row_id）
  hidden?: boolean; // 是否隐藏该列

  // ========== 增强按钮配置 ==========
  /** 参数绑定列表 */
  parameterBindings?: ParameterBinding[];
  /** 返回值绑定列表 */
  returnBindings?: ReturnBinding[];
  /** 触发链配置 */
  triggerChain?: TriggerChainConfig;
  /** 执行模式 */
  executionMode?: 'sync' | 'async' | 'background';
  /** 执行超时时间（毫秒） */
  timeout?: number;
}

// ========== 按钮增强类型定义 ==========

/**
 * 参数绑定
 */
export interface ParameterBinding {
  /** 方法参数名 */
  parameterName: string;
  /** 绑定类型 */
  bindingType: 'field' | 'fixed' | 'rowid' | 'datasetId';
  /** 绑定的字段名（bindingType = 'field' 时） */
  fieldName?: string;
  /** 固定值（bindingType = 'fixed' 时） */
  fixedValue?: any;
}

/**
 * 返回值绑定
 */
export interface ReturnBinding {
  /** 方法返回值中的字段名 */
  returnField: string;
  /** 数据表目标列名 */
  targetColumn: string;
  /** 更新条件 */
  updateCondition?: 'always' | 'on_success' | 'on_change';
}

/**
 * 触发链配置
 */
export interface TriggerChainConfig {
  /** 是否启用触发链 */
  enabled: boolean;
  /** 最大触发深度（默认 5） */
  maxDepth?: number;
  /** 触发规则列表 */
  triggers: TriggerRule[];
  /** 错误处理策略 */
  errorStrategy?: {
    /** 当前按钮失败时的策略 */
    onCurrentFail: 'stop' | 'skip_next' | 'continue';
    /** 子链条失败时的策略 */
    onChildFail: 'stop' | 'ignore';
  };
}

/**
 * 触发规则
 */
export interface TriggerRule {
  /** 触发条件 */
  condition: TriggerCondition;
  /** 下一个按钮配置 */
  nextButton: {
    /** 下一个按钮所在的列名 */
    columnName: string;
    /** 延迟执行时间（毫秒） */
    delay?: number;
  };
  /** 单独的错误处理策略（覆盖全局） */
  errorStrategy?: 'stop' | 'continue';
}

/**
 * 触发条件
 */
export interface TriggerCondition {
  /** 条件类型 */
  type: 'always' | 'on_success' | 'on_failure' | 'on_return_value';
  /** 返回值字段名（type = 'on_return_value' 时） */
  returnField?: string;
  /** 比较操作符 */
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'contains' | 'exists';
  /** 比较值 */
  value?: any;
}

/**
 * 按钮执行结果
 */
export interface ButtonExecuteResult {
  /** 是否成功 */
  success: boolean;
  /** 执行结果 */
  result?: any;
  /** 错误信息 */
  error?: string;
  /** 是否跳过执行 */
  skipped?: boolean;
  /** 是否超过深度限制 */
  depthExceeded?: boolean;
  /** 更新的字段列表 */
  updatedFields?: string[];
  /** 是否触发了下一个按钮 */
  triggeredNext?: boolean;
}

/**
 * 列统计信息（用于类型推断）
 */
export interface ColumnStatistics {
  totalRows: number; // 总行数（采样范围内）
  nullCount: number; // 空值数量
  uniqueValues: number; // 唯一值数量
  sampleValues: any[]; // 采样值
}

export interface ImportTask {
  filePath: string;
  datasetId: string;
  datasetName: string;
  outputPath: string;
}

export interface ImportProgress {
  datasetId: string;
  status: 'pending' | 'importing' | 'completed' | 'failed';
  progress: number; // 0-100
  rowsProcessed?: number;
  error?: string;
  message?: string; // 详细进度消息
}

export interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  filteredTotalCount?: number; // 筛选后的总行数（当有筛选条件时）
}

/**
 * 添加列参数
 */
export interface AddColumnParams {
  datasetId: string;
  columnName: string;
  fieldType: FieldType;
  nullable: boolean;
  metadata?: ColumnMetadata;
}

/**
 * ✅ 记录值类型（替代 any，提供更好的类型安全）
 * 支持 DuckDB 返回和接受的基本值类型
 *
 * 注意：
 * - 不包含 JavaScript Date 对象（DuckDB 返回 timestamp 为 number/string）
 * - 复杂类型（BLOB, ARRAY, STRUCT）由 DuckDB 驱动自动处理
 * - 在 stmt.bind() 调用处可能需要类型断言以适配 DuckDBValue
 */
export type RecordValue = string | number | boolean | null;

/**
 * ✅ 数据记录类型（替代 Record<string, any>）
 */
export type DataRecord = Record<string, RecordValue>;

export type RuntimeObservationEvent = RuntimeEvent;
export type RuntimeObservationArtifact = RuntimeArtifact;
export type RuntimeObservationTraceSummary = TraceSummary;
export type RuntimeObservationFailureBundle = FailureBundle;
export type RuntimeObservationTraceTimeline = TraceTimeline;
export type RuntimeObservationRecentFailureSummary = RecentFailureSummary;
