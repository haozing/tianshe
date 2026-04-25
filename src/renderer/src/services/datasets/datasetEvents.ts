import type { ElectronAPI } from '../../../../types/electron';

type DuckdbAPI = ElectronAPI['duckdb'];
type ListenerPayload<T> = T extends (callback: (payload: infer P) => void) => unknown ? P : never;

export type DatasetImportProgressEvent = ListenerPayload<DuckdbAPI['onImportProgress']>;
export type DatasetImportRecordsProgressEvent = ListenerPayload<
  DuckdbAPI['onImportRecordsProgress']
>;
export type DatasetSchemaUpdatedEvent = ListenerPayload<DuckdbAPI['onSchemaUpdated']>;

function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

function getDuckdbApi(): DuckdbAPI {
  return getElectronAPI().duckdb;
}

export const datasetEvents = {
  subscribeToImportProgress: (callback: (progress: DatasetImportProgressEvent) => void) =>
    getDuckdbApi().onImportProgress(callback),
  subscribeToImportRecordsProgress: (
    callback: (progress: DatasetImportRecordsProgressEvent) => void
  ) => getDuckdbApi().onImportRecordsProgress(callback),
  subscribeToSchemaUpdated: (callback: (datasetId: DatasetSchemaUpdatedEvent) => void) =>
    getDuckdbApi().onSchemaUpdated?.(callback),
};
