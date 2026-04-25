import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDatasetFieldNames,
  listDatasetSummaries,
  materializeDatasetCleanColumns,
  previewDatasetClean,
  previewDatasetDedupe,
  previewDatasetFilterCount,
} from './datasetPanelService';

describe('datasetPanelService', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          previewClean: vi.fn(),
          previewFilterCount: vi.fn(),
          previewAggregate: vi.fn(),
          previewSample: vi.fn(),
          previewLookup: vi.fn(),
          previewDedupe: vi.fn(),
          deleteRowsByAhoCorasickFilter: vi.fn(),
          materializeCleanToNewColumns: vi.fn(),
          validateComputeExpression: vi.fn(),
          listDatasets: vi.fn(),
          getDatasetInfo: vi.fn(),
        },
      },
    };
  });

  it('returns matched row count from previewFilterCount', async () => {
    (window as any).electronAPI.duckdb.previewFilterCount.mockResolvedValue({
      success: true,
      result: { matchedRows: 12 },
    });

    await expect(previewDatasetFilterCount('ds1', { conditions: [] })).resolves.toBe(12);
  });

  it('returns clean preview payload from previewClean', async () => {
    const cleanPreview = {
      stats: {
        changedRows: 1,
        totalChanges: 1,
        totalRows: 1,
        nullsRemoved: 0,
        nullsAdded: 0,
        byField: {},
        byType: { other: 1 },
      },
      originalData: [{ _row_id: 1, name: ' Alice ' }],
      cleanedData: [{ _row_id: 1, name: 'Alice' }],
      changes: [
        {
          rowIndex: 0,
          field: 'name',
          originalValue: ' Alice ',
          cleanedValue: 'Alice',
          changeType: 'trimmed',
        },
      ],
      sql: 'SELECT 1',
    };

    (window as any).electronAPI.duckdb.previewClean.mockResolvedValue({
      success: true,
      result: cleanPreview,
    });

    await expect(
      previewDatasetClean('ds1', [{ field: 'name', operations: [{ type: 'trim' }] }])
    ).resolves.toEqual(cleanPreview);
  });

  it('throws when materialize clean columns fails', async () => {
    (window as any).electronAPI.duckdb.materializeCleanToNewColumns.mockResolvedValue({
      success: false,
      error: 'materialize failed',
    });

    await expect(materializeDatasetCleanColumns('ds1', [])).rejects.toThrow('materialize failed');
  });

  it('returns dedupe preview payload from previewDedupe', async () => {
    const dedupePreview = {
      stats: {
        totalRows: 10,
        uniqueRows: 8,
        duplicateRows: 2,
        duplicateGroups: 1,
        willBeRemoved: 1,
        willBeKept: 9,
        duplicateDistribution: [],
        topDuplicates: [],
      },
      sampleKept: [],
      sampleRemoved: [],
      generatedSQL: 'SELECT 1',
    };

    (window as any).electronAPI.duckdb.previewDedupe.mockResolvedValue({
      success: true,
      result: dedupePreview,
    });

    await expect(
      previewDatasetDedupe(
        'ds1',
        { type: 'row_number', partitionBy: ['email'] },
        { baseConfig: { filter: { conditions: [] } } }
      )
    ).resolves.toEqual(dedupePreview);
  });

  it('lists datasets through duckdb.listDatasets', async () => {
    (window as any).electronAPI.duckdb.listDatasets.mockResolvedValue({
      success: true,
      datasets: [{ id: 'ds1', name: 'Dataset 1' }],
    });

    await expect(listDatasetSummaries()).resolves.toEqual([{ id: 'ds1', name: 'Dataset 1' }]);
  });

  it('returns schema field names from dataset info', async () => {
    (window as any).electronAPI.duckdb.getDatasetInfo.mockResolvedValue({
      success: true,
      dataset: {
        schema: [{ name: 'name' }, { name: 'age' }],
      },
    });

    await expect(getDatasetFieldNames('ds1')).resolves.toEqual(['name', 'age']);
  });
});
