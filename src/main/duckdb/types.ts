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
import type { DatasetRecordProvenanceEntry } from './dataset-provenance-service';

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

// Import shared DuckDB types from types/duckdb.ts (single source of truth)
import type {
  FieldType,
  StorageMode,
  ComputeColumnConfig,
  ValidationRule,
  ColumnDisplayConfig,
  ColumnMetadata,
  EnhancedColumnSchema,
  ParameterBinding,
  ReturnBinding,
  TriggerChainConfig,
  TriggerRule,
  TriggerCondition,
  ButtonExecuteResult,
  QueryResult,
} from '../../types/duckdb';

// Re-export for backward compatibility
export type {
  FieldType,
  StorageMode,
  ComputeColumnConfig,
  ValidationRule,
  ColumnDisplayConfig,
  ColumnMetadata,
  EnhancedColumnSchema,
  ParameterBinding,
  ReturnBinding,
  TriggerChainConfig,
  TriggerRule,
  TriggerCondition,
  ButtonExecuteResult,
  QueryResult,
};

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

export interface DatasetRecordEvidenceSource {
  id: string;
  runId: string;
  operation: DatasetRecordProvenanceEntry['operation'];
  occurredAt: number;
  traceId?: string | null;
  adapterId?: string | null;
  adapterVersion?: string | null;
  runtimeId?: string | null;
  sourceUrl?: string | null;
  profileId?: string | null;
}

export interface DatasetRecordEvidenceTrace {
  traceId: string;
  summary: RuntimeObservationTraceSummary | null;
  failureBundle: RuntimeObservationFailureBundle | null;
  timeline: RuntimeObservationTraceTimeline | null;
  error?: string;
}

export interface DatasetRecordEvidenceSummaryBucket {
  key: string;
  count: number;
}

export interface DatasetRecordEvidenceSummary {
  totalProvenanceRecords: number;
  returnedProvenanceRecords: number;
  hasMoreProvenance: boolean;
  operationCounts: DatasetRecordEvidenceSummaryBucket[];
  adapterCounts: DatasetRecordEvidenceSummaryBucket[];
  runtimeCounts: DatasetRecordEvidenceSummaryBucket[];
  traceStatusCounts: DatasetRecordEvidenceSummaryBucket[];
}

export interface DatasetRecordEvidenceBundle {
  datasetId: string;
  rowId: number;
  limit: number;
  summary: DatasetRecordEvidenceSummary;
  provenance: DatasetRecordProvenanceEntry[];
  sources: DatasetRecordEvidenceSource[];
  traceIds: string[];
  traces: DatasetRecordEvidenceTrace[];
}
