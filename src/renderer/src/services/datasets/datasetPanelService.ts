import type { ElectronAPI } from '../../../../types/electron';
import { datasetFacade } from './datasetFacade';

type DuckdbAPI = ElectronAPI['duckdb'];

type PreviewResult<T> = {
  success: boolean;
  result?: T;
  error?: string;
};

type DatasetsListResponse = Awaited<ReturnType<DuckdbAPI['listDatasets']>>;
type DatasetInfoResponse = Awaited<ReturnType<DuckdbAPI['getDatasetInfo']>>;
type DeleteRowsResponse = Awaited<ReturnType<DuckdbAPI['deleteRowsByAhoCorasickFilter']>>;

function unwrapPreviewResult<T>(response: PreviewResult<T>, fallbackMessage: string): T {
  if (!response.success || response.result == null) {
    throw new Error(response.error || fallbackMessage);
  }

  return response.result;
}

export async function previewDatasetFilterCount(
  datasetId: string,
  filterConfig: Parameters<DuckdbAPI['previewFilterCount']>[1]
) {
  const result = unwrapPreviewResult(
    await datasetFacade.previewFilterCount(datasetId, filterConfig),
    'Failed to preview filter count'
  ) as { matchedRows?: number };

  return result.matchedRows ?? 0;
}

export async function previewDatasetClean(
  datasetId: string,
  cleanConfig: Parameters<DuckdbAPI['previewClean']>[1],
  options?: Parameters<DuckdbAPI['previewClean']>[2]
) {
  return unwrapPreviewResult(
    await datasetFacade.previewClean(datasetId, cleanConfig, options),
    'Failed to preview clean'
  );
}

export async function previewDatasetAggregate(
  datasetId: string,
  aggregateConfig: Parameters<DuckdbAPI['previewAggregate']>[1],
  options?: Parameters<DuckdbAPI['previewAggregate']>[2]
) {
  return unwrapPreviewResult(
    await datasetFacade.previewAggregate(datasetId, aggregateConfig, options),
    'Failed to preview aggregate'
  );
}

export async function previewDatasetSample(
  datasetId: string,
  sampleConfig: Parameters<DuckdbAPI['previewSample']>[1],
  queryConfig?: Parameters<DuckdbAPI['previewSample']>[2]
) {
  return unwrapPreviewResult(
    await datasetFacade.previewSample(datasetId, sampleConfig, queryConfig),
    'Failed to preview sample'
  );
}

export async function previewDatasetLookup(
  datasetId: string,
  lookupConfig: Parameters<DuckdbAPI['previewLookup']>[1],
  options?: Parameters<DuckdbAPI['previewLookup']>[2]
) {
  return unwrapPreviewResult(
    await datasetFacade.previewLookup(datasetId, lookupConfig, options),
    'Failed to preview lookup'
  );
}

export async function previewDatasetDedupe(
  datasetId: string,
  config: Parameters<DuckdbAPI['previewDedupe']>[1],
  options?: Parameters<DuckdbAPI['previewDedupe']>[2]
) {
  return unwrapPreviewResult(
    await datasetFacade.previewDedupe(datasetId, config, options),
    'Failed to preview dedupe'
  );
}

export async function deleteDatasetRowsByDictionaryFilter(
  params: Parameters<DuckdbAPI['deleteRowsByAhoCorasickFilter']>[0]
) {
  const result = (await datasetFacade.deleteRowsByAhoCorasickFilter(params)) as DeleteRowsResponse;

  if (!result.success) {
    throw new Error(result.error || 'Failed to delete rows by dictionary filter');
  }

  return {
    deletedCount: result.deletedCount ?? 0,
  };
}

export async function materializeDatasetCleanColumns(
  datasetId: string,
  cleanConfig: Parameters<DuckdbAPI['materializeCleanToNewColumns']>[1]
) {
  return unwrapPreviewResult(
    await datasetFacade.materializeCleanToNewColumns(datasetId, cleanConfig),
    'Failed to materialize clean columns'
  );
}

export async function validateDatasetComputeExpression(
  datasetId: string,
  expression: Parameters<DuckdbAPI['validateComputeExpression']>[1],
  options?: Parameters<DuckdbAPI['validateComputeExpression']>[2]
) {
  return unwrapPreviewResult(
    await datasetFacade.validateComputeExpression(datasetId, expression, options),
    'Failed to validate compute expression'
  );
}

export async function listDatasetSummaries() {
  const response = (await datasetFacade.listDatasets()) as DatasetsListResponse;

  if (!response.success) {
    throw new Error(response.error || 'Failed to list datasets');
  }

  return response.datasets || [];
}

export async function getDatasetFieldNames(datasetId: string) {
  const response = (await datasetFacade.getDatasetInfo(datasetId)) as DatasetInfoResponse;

  if (!response.success || !response.dataset) {
    throw new Error(response.error || 'Failed to load dataset info');
  }

  return response.dataset.schema?.map((column: any) => column.name) || [];
}
