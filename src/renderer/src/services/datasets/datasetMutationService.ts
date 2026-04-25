import type { ElectronAPI } from '../../../../types/electron';
import { datasetFacade } from './datasetFacade';

type DuckdbAPI = ElectronAPI['duckdb'];

type UpdateColumnParams = Parameters<DuckdbAPI['updateColumn']>[0];
type AddColumnParams = Parameters<DuckdbAPI['addColumn']>[0];
type DeleteColumnParams = Parameters<DuckdbAPI['deleteColumn']>[0] extends string
  ? never
  : Extract<Parameters<DuckdbAPI['deleteColumn']>[0], Record<string, unknown>>;
type ReorderColumnsParams = Parameters<DuckdbAPI['reorderColumns']>[0] extends string
  ? never
  : Extract<Parameters<DuckdbAPI['reorderColumns']>[0], Record<string, unknown>>;

type SuccessResult = {
  success: boolean;
  error?: string;
};

function unwrapResult<T extends SuccessResult>(result: T, fallbackMessage: string): T {
  if (!result.success) {
    throw new Error(result.error || fallbackMessage);
  }

  return result;
}

export async function updateDatasetColumnMetadata(
  datasetId: string,
  columnName: string,
  metadata: Parameters<DuckdbAPI['updateColumnMetadata']>[2]
) {
  const result = await datasetFacade.updateColumnMetadata(datasetId, columnName, metadata);
  return unwrapResult(result, 'Failed to update column metadata');
}

export async function updateDatasetColumnDisplayConfig(
  params: Parameters<DuckdbAPI['updateColumnDisplayConfig']>[0]
) {
  const result = await datasetFacade.updateColumnDisplayConfig(params);
  return unwrapResult(result, 'Failed to update column display config');
}

export async function insertDatasetRecord(
  datasetId: string,
  record: Parameters<DuckdbAPI['insertRecord']>[1]
) {
  const result = await datasetFacade.insertRecord(datasetId, record);
  return unwrapResult(result, 'Failed to insert record');
}

export async function batchInsertDatasetRecords(
  datasetId: string,
  records: Parameters<DuckdbAPI['batchInsertRecords']>[1]
) {
  const result = await datasetFacade.batchInsertRecords(datasetId, records);
  return unwrapResult(result, 'Failed to batch insert records');
}

export async function importDatasetRecordsFromFile(datasetId: string, filePath: string) {
  const result = await datasetFacade.importRecordsFromFile(datasetId, filePath);
  return unwrapResult(result, 'Failed to import records from file');
}

export async function importDatasetRecordsFromBase64(
  datasetId: string,
  base64: string,
  filename: string
) {
  const result = await datasetFacade.importRecordsFromBase64(datasetId, base64, filename);
  return unwrapResult(result, 'Failed to import records from base64');
}

export async function updateDatasetRecord(
  datasetId: string,
  rowId: Parameters<DuckdbAPI['updateRecord']>[1],
  updates: Parameters<DuckdbAPI['updateRecord']>[2]
) {
  const result = await datasetFacade.updateRecord(datasetId, rowId, updates);
  return unwrapResult(result, 'Failed to update record');
}

export async function updateDatasetColumn(params: UpdateColumnParams) {
  const result = await datasetFacade.updateColumn(params);
  return unwrapResult(result, 'Failed to update column');
}

export async function deleteDatasetColumn(params: DeleteColumnParams) {
  return await datasetFacade.deleteColumn(params);
}

export async function reorderDatasetColumns(params: ReorderColumnsParams) {
  const result = await datasetFacade.reorderColumns(params);
  return unwrapResult(result, 'Failed to reorder columns');
}

export async function validateDatasetColumnName(datasetId: string, columnName: string) {
  const result = await datasetFacade.validateColumnName(datasetId, columnName);
  const validated = unwrapResult(result, 'Failed to validate column name');

  return {
    valid: validated.valid !== false,
    message: validated.message,
  };
}

export async function addDatasetColumn(params: AddColumnParams) {
  const result = await datasetFacade.addColumn(params);
  return unwrapResult(result, 'Failed to add column');
}
