import type { QueryConfig } from '../core/query-engine/types';

export type ExportFormat = 'csv' | 'xlsx' | 'txt' | 'parquet' | 'json';

export type ExportMode = 'structure' | 'data';

export type PostExportAction = 'keep' | 'delete';

export interface ExportQueryTemplate {
  id?: string;
  queryConfig?: QueryConfig;
}

export interface ExportPathParams {
  defaultFileName: string;
  format: ExportFormat;
}

export interface ExportPathResult {
  success: boolean;
  filePath?: string;
  canceled?: boolean;
  error?: string;
}

export interface ExportOptions {
  datasetId: string;
  format: ExportFormat;
  outputPath: string;
  mode: ExportMode;
  includeHeader: boolean;
  selectedRowIds?: number[];
  respectHiddenColumns: boolean;
  columns?: string[];
  applyFilters: boolean;
  applySort: boolean;
  applySample: boolean;
  activeQueryTemplate?: ExportQueryTemplate;
  postExportAction: PostExportAction;
  batchSize?: number;
  encoding?: 'utf8' | 'gbk';
  delimiter?: string;
}

export interface ExportResult {
  success: boolean;
  files: string[];
  totalRows: number;
  deletedRows?: number;
  filesCount: number;
  executionTime: number;
  message?: string;
  error?: string;
}

export interface ExportProgress {
  current: number;
  total: number;
  message: string;
  percentage: number;
}

export type DataTableExportOutput = 'text' | 'base64' | 'file';

export interface DataTableExportOptions {
  datasetId: string;
  format?: ExportFormat;
  outputType?: DataTableExportOutput;
  outputPath?: string;
  filename?: string;
  includeHeader?: boolean;
  delimiter?: string;
  encoding?: 'utf8' | 'gbk';
  mode?: ExportMode;
  respectHiddenColumns?: boolean;
  applyFilters?: boolean;
  applySort?: boolean;
  applySample?: boolean;
  selectedRowIds?: number[];
  activeQueryTemplate?: ExportQueryTemplate;
}

export interface DataTableExportResult {
  outputType: DataTableExportOutput;
  filename: string;
  filePath?: string;
  text?: string;
  base64?: string;
  totalRows: number;
  deletedRows?: number;
  files?: string[];
}
