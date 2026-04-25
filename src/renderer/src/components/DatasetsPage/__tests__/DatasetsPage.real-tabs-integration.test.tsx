import React, { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DatasetsPage } from '../index';
import { useDatasetStore } from '../../../stores/datasetStore';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('../../../lib/toast', () => ({
  toast: mockToast,
}));

vi.mock('../../../hooks/useCustomPages', () => ({
  usePluginPagesGrouped: () => ({ pluginGroups: [] }),
}));

vi.mock('../DatasetSidebar', () => ({
  DatasetSidebar: ({ categories, onSelectCategory, onSelectTable }: any) => (
    <div data-testid="mock-sidebar">
      {categories.map((category: any) => (
        <div key={category.id}>
          {category.tables.map((table: any) => (
            <button
              key={table.id}
              onClick={() => {
                onSelectCategory(category.id);
                onSelectTable(table.id);
              }}
            >
              {`table-${table.datasetId}`}
            </button>
          ))}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../DatasetToolbar', () => ({
  DatasetToolbar: () => <div data-testid="mock-toolbar" />,
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId }: any) => {
    const queryResult = useDatasetStore((state) => state.queryResult);
    const queryDataset = useDatasetStore((state) => state.queryDataset);
    const refreshActiveQueryTemplate = useDatasetStore((state) => state.refreshActiveQueryTemplate);
    const rows = (queryResult?.rows as Array<Record<string, any>>) || [];
    const firstRow = rows[0];

    useEffect(() => {
      if (datasetId) {
        void queryDataset(datasetId);
      }
    }, [datasetId, queryDataset]);

    return (
      <div data-testid="mock-table">
        <div data-testid="current-dataset-id">{datasetId}</div>
        <div data-testid="current-row-count">{rows.length}</div>
        <div data-testid="current-first-name">{firstRow?.name ?? ''}</div>
        <button
          onClick={() => {
            void (async () => {
              await window.electronAPI.duckdb.insertRecord(datasetId, {
                name: `new-${datasetId}`,
              });
              await refreshActiveQueryTemplate(datasetId);
            })();
          }}
        >
          insert-current-row
        </button>
        <button
          onClick={() => {
            if (!firstRow?._row_id) return;
            void (async () => {
              await window.electronAPI.duckdb.updateRecord(datasetId, Number(firstRow._row_id), {
                name: `updated-${datasetId}`,
              });
              await refreshActiveQueryTemplate(datasetId);
            })();
          }}
        >
          update-first-row
        </button>
      </div>
    );
  },
}));

vi.mock('../SaveQueryTemplateDialog', () => ({
  SaveQueryTemplateDialog: () => null,
}));

vi.mock('../AddRecordDrawer', () => ({
  AddRecordDrawer: () => null,
}));

vi.mock('../ExportDialog', () => ({
  ExportDialog: () => null,
}));

vi.mock('../CustomPageViewer', () => ({
  CustomPageViewer: () => null,
}));

vi.mock('../CustomPagePopup', () => ({
  CustomPagePopup: () => null,
}));

vi.mock('../AddColumnDialog', () => ({
  AddColumnDialog: () => null,
}));

vi.mock('../../ui/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('../../ui/LoadingOverlay', () => ({
  LoadingOverlay: () => null,
}));

vi.mock('../panels/FilterPanel', () => ({
  FilterPanel: () => null,
}));

vi.mock('../panels/AggregatePanel', () => ({
  AggregatePanel: () => null,
}));

vi.mock('../panels/CleanPanel', () => ({
  CleanPanel: () => null,
}));

vi.mock('../panels/LookupPanel', () => ({
  LookupPanel: () => null,
}));

vi.mock('../panels/DedupePanel', () => ({
  DedupePanel: () => null,
}));

vi.mock('../panels/SortPanel', () => ({
  SortPanel: () => null,
}));

vi.mock('../panels/SamplePanel', () => ({
  SamplePanel: () => null,
}));

vi.mock('../panels/GroupPanel', () => ({
  GroupPanel: () => null,
}));

vi.mock('../panels/ColorPanel', () => ({
  ColorPanel: () => null,
}));

vi.mock('../panels/RowHeightPanel', () => ({
  RowHeightPanel: () => null,
}));

describe('DatasetsPage real tabs integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useDatasetStore.setState({
      datasets: [],
      currentDataset: null,
      queryResult: null,
      importProgress: new Map(),
      processedImports: new Set(),
      datasetInfoRequestId: 0,
      activeQuerySessionId: 0,
      activeQueryDatasetId: null,
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: true,
      currentOffset: 0,
      pageSize: 50,
      activeQueryTemplate: null,
      dataReady: false,
      currentGroupId: null,
      groupTabs: [],
      selectedTabDatasetId: null,
    });
  });

  it('should use real DatasetTabs to copy and switch tabs in content area', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
    };
    const ds2 = {
      id: 'ds2',
      name: 'Dataset 2 Copy',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now + 1,
    };

    let copied = false;

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: copied ? [ds1, ds2] : [ds1],
    }));

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...(datasetId === 'ds2' ? ds2 : ds1),
        schema: [],
      },
    }));

    const queryDataset = vi.fn(async () => ({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
      },
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: copied
        ? [
            {
              datasetId: 'ds1',
              tabGroupId: 'grp1',
              name: 'Dataset 1',
              rowCount: 10,
              columnCount: 2,
              tabOrder: 0,
              isGroupDefault: true,
            },
            {
              datasetId: 'ds2',
              tabGroupId: 'grp1',
              name: 'Dataset 2 Copy',
              rowCount: 10,
              columnCount: 2,
              tabOrder: 1,
              isGroupDefault: false,
            },
          ]
        : [
            {
              datasetId: 'ds1',
              tabGroupId: 'grp1',
              name: 'Dataset 1',
              rowCount: 10,
              columnCount: 2,
              tabOrder: 0,
              isGroupDefault: true,
            },
          ],
    }));

    const createGroupTabCopy = vi.fn(async () => {
      copied = true;
      return {
        success: true,
        datasetId: 'ds2',
        tabGroupId: 'grp1',
      };
    });

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {        },
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset: vi.fn(async () => ({ success: true })),
        reorderGroupTabs: vi.fn(async () => ({ success: true })),
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree: vi.fn(async () => ({ success: true, tree: [] })),
      },
      jsPlugin: {
        getCustomPages: vi.fn(async () => ({ success: true, pages: [] })),
      },
    };

    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByText('table-ds1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('table-ds1'));

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds1');
    });

    fireEvent.click(screen.getByText('复制为新标签页'));

    await waitFor(() => {
      expect(createGroupTabCopy).toHaveBeenCalledWith('ds1');
    });

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds2');
      expect(screen.getByText('Dataset 2 Copy')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dataset 1'));

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds1');
    });
  });

  it('should keep source tab data isolated after copy tab writes with real DatasetTabs', async () => {
    const now = Date.now();

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
      ds2: [{ _row_id: 1, name: 'source-row' }],
    };

    let copied = false;

    const buildDatasets = () =>
      copied
        ? [
            {
              id: 'ds1',
              name: 'Dataset 1',
              rowCount: recordsByDataset.ds1.length,
              columnCount: 2,
              sizeBytes: 100,
              createdAt: now,
            },
            {
              id: 'ds2',
              name: 'Dataset 2 Copy',
              rowCount: recordsByDataset.ds2.length,
              columnCount: 2,
              sizeBytes: 100,
              createdAt: now + 1,
            },
          ]
        : [
            {
              id: 'ds1',
              name: 'Dataset 1',
              rowCount: recordsByDataset.ds1.length,
              columnCount: 2,
              sizeBytes: 100,
              createdAt: now,
            },
          ];

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: buildDatasets(),
    }));

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...buildDatasets().find((ds) => ds.id === datasetId),
        schema: [
          { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
          { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        ],
      },
    }));

    const queryDataset = vi.fn(async (datasetId: string) => {
      const rows = recordsByDataset[datasetId] || [];
      return {
        success: true,
        result: {
          columns: ['_row_id', 'name'],
          rows: rows.map((row) => ({ ...row })),
          rowCount: rows.length,
        },
      };
    });

    const insertRecord = vi.fn(async (datasetId: string, record: Record<string, unknown>) => {
      const rows = recordsByDataset[datasetId] || [];
      const nextId = rows.length > 0 ? Math.max(...rows.map((row) => row._row_id)) + 1 : 1;
      rows.push({
        _row_id: nextId,
        name: String(record.name ?? ''),
      });
      recordsByDataset[datasetId] = rows;
      return { success: true };
    });

    const updateRecord = vi.fn(
      async (datasetId: string, rowId: number, updates: Record<string, unknown>) => {
        const rows = recordsByDataset[datasetId] || [];
        const target = rows.find((row) => row._row_id === rowId);
        if (target && updates.name !== undefined) {
          target.name = String(updates.name);
        }
        return { success: true };
      }
    );

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: copied
        ? [
            {
              datasetId: 'ds1',
              tabGroupId: 'grp1',
              name: 'Dataset 1',
              rowCount: recordsByDataset.ds1.length,
              columnCount: 2,
              tabOrder: 0,
              isGroupDefault: true,
            },
            {
              datasetId: 'ds2',
              tabGroupId: 'grp1',
              name: 'Dataset 2 Copy',
              rowCount: recordsByDataset.ds2.length,
              columnCount: 2,
              tabOrder: 1,
              isGroupDefault: false,
            },
          ]
        : [
            {
              datasetId: 'ds1',
              tabGroupId: 'grp1',
              name: 'Dataset 1',
              rowCount: recordsByDataset.ds1.length,
              columnCount: 2,
              tabOrder: 0,
              isGroupDefault: true,
            },
          ],
    }));

    const createGroupTabCopy = vi.fn(async () => {
      copied = true;
      recordsByDataset.ds2 = recordsByDataset.ds1.map((row) => ({ ...row }));
      return {
        success: true,
        datasetId: 'ds2',
        tabGroupId: 'grp1',
      };
    });

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {        },
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        createGroupTabCopy,
        insertRecord,
        updateRecord,
        deleteDataset: vi.fn(async () => ({ success: true })),
        reorderGroupTabs: vi.fn(async () => ({ success: true })),
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree: vi.fn(async () => ({ success: true, tree: [] })),
      },
      jsPlugin: {
        getCustomPages: vi.fn(async () => ({ success: true, pages: [] })),
      },
    };

    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByText('table-ds1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('table-ds1'));

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });

    fireEvent.click(screen.getByText('复制为新标签页'));

    await waitFor(() => {
      expect(createGroupTabCopy).toHaveBeenCalledWith('ds1');
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds2');
    });

    fireEvent.click(screen.getByText('insert-current-row'));

    await waitFor(() => {
      expect(insertRecord).toHaveBeenCalledWith('ds2', { name: 'new-ds2' });
      expect(screen.getByTestId('current-row-count').textContent).toBe('2');
    });

    fireEvent.click(screen.getByText('update-first-row'));

    await waitFor(() => {
      expect(updateRecord).toHaveBeenCalledWith('ds2', 1, { name: 'updated-ds2' });
      expect(screen.getByTestId('current-first-name').textContent).toBe('updated-ds2');
    });

    fireEvent.click(screen.getByText('Dataset 1'));

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });
  });
});
