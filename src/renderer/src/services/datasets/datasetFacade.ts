import type { ElectronAPI } from '../../../../types/electron';

type DuckdbAPI = ElectronAPI['duckdb'];

function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

function getDuckdbApi(): DuckdbAPI {
  return getElectronAPI().duckdb;
}

export const datasetFacade = {
  listDatasets: () => getDuckdbApi().listDatasets(),
  getDatasetInfo: (datasetId: string) => getDuckdbApi().getDatasetInfo(datasetId),
  queryDataset: (datasetId: string, sql?: string, offset?: number, limit?: number) =>
    getDuckdbApi().queryDataset(datasetId, sql, offset, limit),
  deleteDataset: (datasetId: string) => getDuckdbApi().deleteDataset(datasetId),
  renameDataset: (datasetId: string, newName: string) =>
    getDuckdbApi().renameDataset(datasetId, newName),
  selectImportFile: () => getDuckdbApi().selectImportFile(),
  importDatasetFile: (
    filePath: string,
    name: string,
    options?: Parameters<DuckdbAPI['importDatasetFile']>[2]
  ) => getDuckdbApi().importDatasetFile(filePath, name, options),
  cancelImport: (datasetId: string) => getDuckdbApi().cancelImport(datasetId),
  listGroupTabs: (datasetId: string) => getDuckdbApi().listGroupTabs(datasetId),
  previewQuerySQL: (datasetId: string, config: Parameters<DuckdbAPI['previewQuerySQL']>[1]) =>
    getDuckdbApi().previewQuerySQL(datasetId, config),
  previewClean: (
    datasetId: string,
    cleanConfig: Parameters<DuckdbAPI['previewClean']>[1],
    options?: Parameters<DuckdbAPI['previewClean']>[2]
  ) => getDuckdbApi().previewClean(datasetId, cleanConfig, options),
  previewFilterCount: (
    datasetId: string,
    filterConfig: Parameters<DuckdbAPI['previewFilterCount']>[1]
  ) => getDuckdbApi().previewFilterCount(datasetId, filterConfig),
  previewAggregate: (
    datasetId: string,
    aggregateConfig: Parameters<DuckdbAPI['previewAggregate']>[1],
    options?: Parameters<DuckdbAPI['previewAggregate']>[2]
  ) => getDuckdbApi().previewAggregate(datasetId, aggregateConfig, options),
  previewSample: (
    datasetId: string,
    sampleConfig: Parameters<DuckdbAPI['previewSample']>[1],
    queryConfig?: Parameters<DuckdbAPI['previewSample']>[2]
  ) => getDuckdbApi().previewSample(datasetId, sampleConfig, queryConfig),
  previewLookup: (
    datasetId: string,
    lookupConfig: Parameters<DuckdbAPI['previewLookup']>[1],
    options?: Parameters<DuckdbAPI['previewLookup']>[2]
  ) => getDuckdbApi().previewLookup(datasetId, lookupConfig, options),
  previewDedupe: (
    datasetId: string,
    config: Parameters<DuckdbAPI['previewDedupe']>[1],
    options?: Parameters<DuckdbAPI['previewDedupe']>[2]
  ) => getDuckdbApi().previewDedupe(datasetId, config, options),
  insertRecord: (datasetId: string, record: Parameters<DuckdbAPI['insertRecord']>[1]) =>
    getDuckdbApi().insertRecord(datasetId, record),
  updateRecord: (
    datasetId: string,
    rowId: Parameters<DuckdbAPI['updateRecord']>[1],
    updates: Parameters<DuckdbAPI['updateRecord']>[2]
  ) => getDuckdbApi().updateRecord(datasetId, rowId, updates),
  batchInsertRecords: (
    datasetId: string,
    records: Parameters<DuckdbAPI['batchInsertRecords']>[1]
  ) => getDuckdbApi().batchInsertRecords(datasetId, records),
  importRecordsFromFile: (datasetId: string, filePath: string) =>
    getDuckdbApi().importRecordsFromFile(datasetId, filePath),
  importRecordsFromBase64: (datasetId: string, base64: string, filename: string) =>
    getDuckdbApi().importRecordsFromBase64(datasetId, base64, filename),
  updateColumnMetadata: (
    datasetId: string,
    columnName: string,
    metadata: Parameters<DuckdbAPI['updateColumnMetadata']>[2]
  ) => getDuckdbApi().updateColumnMetadata(datasetId, columnName, metadata),
  updateColumnDisplayConfig: (
    params: Parameters<DuckdbAPI['updateColumnDisplayConfig']>[0]
  ) => getDuckdbApi().updateColumnDisplayConfig(params),
  validateColumnName: (
    datasetId: string,
    columnName: Parameters<DuckdbAPI['validateColumnName']>[1]
  ) => getDuckdbApi().validateColumnName(datasetId, columnName),
  addColumn: (params: Parameters<DuckdbAPI['addColumn']>[0]) => getDuckdbApi().addColumn(params),
  updateColumn: (params: Parameters<DuckdbAPI['updateColumn']>[0]) =>
    getDuckdbApi().updateColumn(params),
  deleteColumn: (
    params: Parameters<DuckdbAPI['deleteColumn']>[0] extends string
      ? never
      : Extract<Parameters<DuckdbAPI['deleteColumn']>[0], Record<string, unknown>>
  ) => getDuckdbApi().deleteColumn(params),
  materializeCleanToNewColumns: (
    datasetId: string,
    cleanConfig: Parameters<DuckdbAPI['materializeCleanToNewColumns']>[1]
  ) => getDuckdbApi().materializeCleanToNewColumns(datasetId, cleanConfig),
  validateComputeExpression: (
    datasetId: string,
    expression: Parameters<DuckdbAPI['validateComputeExpression']>[1],
    options?: Parameters<DuckdbAPI['validateComputeExpression']>[2]
  ) => getDuckdbApi().validateComputeExpression(datasetId, expression, options),
  analyzeTypes: (datasetId: string) => getDuckdbApi().analyzeTypes(datasetId),
  applySchema: (datasetId: string, schema: Parameters<DuckdbAPI['applySchema']>[1]) =>
    getDuckdbApi().applySchema(datasetId, schema),
  createEmptyDataset: (
    datasetName: string,
    options?: Parameters<DuckdbAPI['createEmptyDataset']>[1]
  ) => getDuckdbApi().createEmptyDataset(datasetName, options),
  createGroupTabCopy: (datasetId: string, newName?: string) =>
    newName === undefined
      ? getDuckdbApi().createGroupTabCopy(datasetId)
      : getDuckdbApi().createGroupTabCopy(datasetId, newName),
  reorderGroupTabs: (groupId: string, datasetIds: Parameters<DuckdbAPI['reorderGroupTabs']>[1]) =>
    getDuckdbApi().reorderGroupTabs(groupId, datasetIds),
  renameGroupTab: (datasetId: string, newName: string) =>
    getDuckdbApi().renameGroupTab(datasetId, newName),
  reorderColumns: (
    params: Parameters<DuckdbAPI['reorderColumns']>[0] extends string
      ? never
      : Extract<Parameters<DuckdbAPI['reorderColumns']>[0], Record<string, unknown>>
  ) => getDuckdbApi().reorderColumns(params),
  hardDeleteRows: (params: Parameters<DuckdbAPI['hardDeleteRows']>[0]) =>
    getDuckdbApi().hardDeleteRows(params),
  deleteRowsByAhoCorasickFilter: (
    params: Parameters<DuckdbAPI['deleteRowsByAhoCorasickFilter']>[0]
  ) => getDuckdbApi().deleteRowsByAhoCorasickFilter(params),
};
