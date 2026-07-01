/**
 * DuckDB 共享类型与接口
 *
 * 从 main/duckdb 提取到 types/，供 core/ 层使用。
 */

import type {
  IAccountService,
  IDatasetFolderService,
  IProfileGroupService,
  IProfileService,
  ISavedSiteService,
} from './service-interfaces';
import type { PluginStateStore } from './plugin-state';
import type { CapabilityRunStore } from './capability-run';

// =====================================================
// 字段类型枚举（业务层面的类型）
// =====================================================

export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'single_select'
  | 'multi_select'
  | 'email'
  | 'url'
  | 'phone'
  | 'uuid'
  | 'ip_address'
  | 'hyperlink'
  | 'attachment'
  | 'json'
  | 'array'
  | 'button'
  | 'auto_increment';

export type StorageMode = 'physical' | 'computed';

export interface ComputeColumnConfig {
  type: 'amount' | 'discount' | 'bucket' | 'concat' | 'custom';
  expression?: string;
  params?: {
    priceField?: string;
    quantityField?: string;
    originalPriceField?: string;
    discountedPriceField?: string;
    discountType?: 'percentage' | 'amount';
    field?: string;
    boundaries?: number[];
    labels?: string[];
    fields?: string[];
    separator?: string;
  };
}

export interface ValidationRule {
  type: 'required' | 'unique' | 'regex' | 'range' | 'length' | 'check' | 'enum';
  params?: any;
  errorMessage?: string;
}

export interface ColumnDisplayConfig {
  width?: number;
  frozen?: boolean;
  order?: number;
  hidden?: boolean;
  pinned?: 'left' | 'right';
}

// =====================================================
// 按钮增强类型定义
// =====================================================

export interface ParameterBinding {
  parameterName: string;
  bindingType: 'field' | 'fixed' | 'rowid' | 'datasetId';
  fieldName?: string;
  fixedValue?: any;
}

export interface ReturnBinding {
  returnField: string;
  targetColumn: string;
  updateCondition?: 'always' | 'on_success' | 'on_change';
}

export interface TriggerRule {
  condition: TriggerCondition;
  nextButton: {
    columnName: string;
    delay?: number;
  };
  errorStrategy?: 'stop' | 'continue';
}

export interface TriggerCondition {
  type: 'always' | 'on_success' | 'on_failure' | 'on_return_value';
  returnField?: string;
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'contains' | 'exists';
  value?: any;
}

export interface TriggerChainConfig {
  enabled: boolean;
  maxDepth?: number;
  triggers: TriggerRule[];
  errorStrategy?: {
    onCurrentFail: 'stop' | 'skip_next' | 'continue';
    onChildFail: 'stop' | 'ignore';
  };
}

// =====================================================
// 列元数据
// =====================================================

export interface ColumnMetadata {
  description?: string;
  defaultValue?: any;
  options?: string[];
  separator?: string;
  colorMap?: Record<string, string>;
  format?: 'integer' | 'decimal' | 'percentage' | 'currency' | 'thousand' | 'thousand_decimal';
  precision?: number;
  dateFormat?: string;
  includeTime?: boolean;
  maxFileSize?: number;
  allowedTypes?: string[];
  fileType?: string;
  isRemote?: boolean;
  renderAs?: string;
  isImage?: boolean;
  isDocument?: boolean;
  isVideo?: boolean;
  isAudio?: boolean;
  isArchive?: boolean;
  pluginId?: string;
  pluginType?: 'js';
  methodId?: string;
  buttonLabel?: string;
  buttonIcon?: string;
  buttonColor?: string;
  buttonVariant?: 'default' | 'primary' | 'success' | 'danger';
  confirmMessage?: string;
  showResult?: boolean;
  isSystemColumn?: boolean;
  hidden?: boolean;
  parameterBindings?: ParameterBinding[];
  returnBindings?: ReturnBinding[];
  triggerChain?: TriggerChainConfig;
  executionMode?: 'sync' | 'async' | 'background';
  timeout?: number;
}

export interface EnhancedColumnSchema {
  name: string;
  duckdbType: string;
  fieldType: FieldType;
  nullable: boolean;
  storageMode?: StorageMode;
  validationRules?: ValidationRule[];
  displayConfig?: ColumnDisplayConfig;
  metadata?: ColumnMetadata;
  computeConfig?: ComputeColumnConfig;
}

// =====================================================
// 查询结果类型
// =====================================================

export interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  filteredTotalCount?: number;
}

// =====================================================
// 按钮执行结果
// =====================================================

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

// =====================================================
// DuckDBService 接口（core 层使用的最小方法集）
// =====================================================

export interface IDuckDBService {
  // SQL 执行
  executeSQLWithParams(sql: string, params: any[]): Promise<any>;
  executeWithParams(sql: string, params: any[]): Promise<void>;

  // Dataset 查询
  listDatasets(): Promise<any[]>;
  getDatasetInfo(datasetId: string): Promise<any | null>;
  queryDataset(
    datasetId: string,
    sql: string,
    offset?: number,
    limit?: number
  ): Promise<QueryResult & { schema?: EnhancedColumnSchema[] }>;
  deleteDataset(datasetId: string): Promise<void>;
  exportDataset(options: any, onProgress?: any): Promise<any>;

  // Record 操作
  insertRecord(datasetId: string, record: Record<string, any>): Promise<void>;
  batchInsertRecords(datasetId: string, records: Record<string, any>[]): Promise<void>;
  importRecordsFromFile(
    targetDatasetId: string,
    filePath: string,
    onProgress?: (progress: any) => void
  ): Promise<{ recordsInserted: number }>;
  updateRecord(datasetId: string, rowId: number | string, updates: Record<string, any>): Promise<void>;
  hardDeleteRows(datasetId: string, rowIds: number[]): Promise<number>;

  // Schema 操作
  updateColumnMetadata(datasetId: string, columnName: string, metadata: any): Promise<void>;
  addColumn(params: {
    datasetId: string;
    columnName: string;
    fieldType: FieldType;
    nullable: boolean;
    metadata?: ColumnMetadata;
    storageMode?: StorageMode;
    computeConfig?: ComputeColumnConfig;
  }): Promise<void>;
  deleteColumn(datasetId: string, columnName: string, force?: boolean): Promise<void>;

  // Dataset 附件
  withDatasetAttached<T>(datasetId: string, operation: () => Promise<T>): Promise<T>;

  // 子服务访问器
  getFolderService(): IDatasetFolderService;
  getProfileService(): IProfileService;
  getProfileGroupService(): IProfileGroupService;
  getAccountService(): IAccountService;
  getSavedSiteService(): ISavedSiteService;
  getPluginStateService?(): PluginStateStore;
  getCapabilityRunStore?(): CapabilityRunStore;
}
