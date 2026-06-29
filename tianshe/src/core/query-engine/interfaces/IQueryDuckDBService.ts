import type { IDatasetResolver } from './IDatasetResolver';

export interface QueryDatasetResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  filteredTotalCount?: number;
}

export interface IQueryDuckDBService extends IDatasetResolver {
  queryDataset(datasetId: string, sql: string): Promise<QueryDatasetResult>;
  executeWithParams(sql: string, params: unknown[]): Promise<any>;
  executeSQLWithParams(sql: string, params: unknown[]): Promise<any[]>;
  createTempRowIdTable?(
    datasetId: string,
    tableName: string,
    rowIds: Array<string | number>
  ): Promise<void>;
  dropTempRowIdTable?(datasetId: string, tableName: string): Promise<void>;
}
