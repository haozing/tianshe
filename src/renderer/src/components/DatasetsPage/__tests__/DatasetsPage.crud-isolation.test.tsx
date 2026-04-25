import React, { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DatasetsPage } from '../index';
import { useDatasetStore } from '../../../stores/datasetStore';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));

const mockExportDialogOptions = vi.hoisted(() => ({
  value: {
    format: 'csv',
    mode: 'data',
    respectHiddenColumns: true,
    postExportAction: 'delete',
  } as {
    format: 'csv' | 'json';
    mode: 'data' | 'structure';
    respectHiddenColumns: boolean;
    postExportAction: 'delete' | 'keep';
  },
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

vi.mock('../DatasetTabs', () => ({
  DatasetTabs: ({ tabs, selectedTabId, onSelectTab }: any) => (
    <div data-testid="mock-tabs">
      <div data-testid="selected-tab-id">{selectedTabId ?? ''}</div>
      {tabs.map((tab: any) => (
        <button key={tab.id} onClick={() => onSelectTab(tab.id)}>
          {`tab-${tab.id}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../DatasetToolbar', () => ({
  DatasetToolbar: ({ onExport }: any) => (
    <div data-testid="mock-toolbar">
      <button onClick={() => onExport?.()}>open-export-dialog</button>
    </div>
  ),
}));

// 保留关键写路径：通过 DatasetTable mock 触发 insert/update，并调用 store.queryDataset 刷新
vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId, onRowSelectionChange }: any) => {
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
        <button onClick={() => onRowSelectionChange?.(firstRow ? [firstRow] : [])}>
          select-first-row
        </button>
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
        <button
          onClick={() => {
            if (!firstRow?._row_id) return;
            void (async () => {
              await window.electronAPI.duckdb.hardDeleteRows({
                datasetId,
                rowIds: [Number(firstRow._row_id)],
              });
              await refreshActiveQueryTemplate(datasetId);
            })();
          }}
        >
          hard-delete-first-row
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
  ExportDialog: ({ isOpen, onClose, onExport, totalRows }: any) =>
    isOpen ? (
      <div data-testid="mock-export-dialog">
        <div data-testid="export-total-rows">{String(totalRows)}</div>
        <button
          onClick={() => {
            void onExport(mockExportDialogOptions.value).then(() => onClose?.());
          }}
        >
          confirm-export-delete
        </button>
      </div>
    ) : null,
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

describe('DatasetsPage CRUD isolation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportDialogOptions.value = {
      format: 'csv',
      mode: 'data',
      respectHiddenColumns: true,
      postExportAction: 'delete',
    };

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

  it('should keep default tab data isolated after writing in copied tab', async () => {
    const now = Date.now();

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
      ds2: [{ _row_id: 1, name: 'copy-row' }],
    };

    const buildDatasets = () => [
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
        name: 'Dataset 1 Copy',
        rowCount: recordsByDataset.ds2.length,
        columnCount: 2,
        sizeBytes: 100,
        createdAt: now + 1,
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
        if (target) {
          if (updates.name !== undefined) {
            target.name = String(updates.name);
          }
        }
        return { success: true };
      }
    );

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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
          name: 'Dataset 1 Copy',
          rowCount: recordsByDataset.ds2.length,
          columnCount: 2,
          tabOrder: 1,
          isGroupDefault: false,
        },
      ],
    }));

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
        insertRecord,
        updateRecord,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });

    fireEvent.click(screen.getByText('tab-ds2'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds2');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('copy-row');
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

    fireEvent.click(screen.getByText('tab-ds1'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });

    expect(recordsByDataset.ds2).toHaveLength(2);
    expect(recordsByDataset.ds1).toHaveLength(1);
    expect(recordsByDataset.ds1[0].name).toBe('source-row');
  });

  it('should keep default tab data isolated after hard-delete in copied tab', async () => {
    const now = Date.now();

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
      ds2: [{ _row_id: 1, name: 'copy-row' }],
    };

    const buildDatasets = () => [
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
        name: 'Dataset 1 Copy',
        rowCount: recordsByDataset.ds2.length,
        columnCount: 2,
        sizeBytes: 100,
        createdAt: now + 1,
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

    const hardDeleteRows = vi.fn(async ({ datasetId, rowIds }: { datasetId: string; rowIds: number[] }) => {
      const rows = recordsByDataset[datasetId] || [];
      recordsByDataset[datasetId] = rows.filter((row) => !rowIds.includes(row._row_id));
      return { success: true, deletedCount: rowIds.length };
    });

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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
          name: 'Dataset 1 Copy',
          rowCount: recordsByDataset.ds2.length,
          columnCount: 2,
          tabOrder: 1,
          isGroupDefault: false,
        },
      ],
    }));

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
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });

    fireEvent.click(screen.getByText('tab-ds2'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds2');
      expect(screen.getByTestId('current-first-name').textContent).toBe('copy-row');
    });

    fireEvent.click(screen.getByText('hard-delete-first-row'));

    await waitFor(() => {
      expect(hardDeleteRows).toHaveBeenCalledWith({ datasetId: 'ds2', rowIds: [1] });
      expect(screen.getByTestId('current-row-count').textContent).toBe('0');
      expect(screen.getByTestId('current-first-name').textContent).toBe('');
    });

    fireEvent.click(screen.getByText('tab-ds1'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });

    expect(recordsByDataset.ds1).toHaveLength(1);
    expect(recordsByDataset.ds2).toHaveLength(0);
  });

  it('should locally remove selected rows after export-delete without refreshing the workspace', async () => {
    const now = Date.now();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
    };

    const buildDatasets = () => [
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

    const selectExportPath = vi.fn(async () => ({
      success: true,
      canceled: false,
      filePath: 'C:/tmp/dataset-export.csv',
    }));

    const exportDataset = vi.fn(async (options: { selectedRowIds?: number[] }) => {
      const selectedRowIds = options.selectedRowIds ?? [];
      recordsByDataset.ds1 = recordsByDataset.ds1.filter(
        (row) => !selectedRowIds.includes(row._row_id)
      );

      return {
        success: true,
        files: ['C:/tmp/dataset-export.csv'],
        totalRows: selectedRowIds.length,
        filesCount: 1,
        executionTime: 12,
      };
    });

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {},
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
        selectExportPath,
        exportDataset,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });

    const initialQueryDatasetCalls = queryDataset.mock.calls.length;
    const initialListDatasetsCalls = listDatasets.mock.calls.length;

    fireEvent.click(screen.getByText('select-first-row'));
    fireEvent.click(screen.getByText('open-export-dialog'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-export-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('export-total-rows').textContent).toBe('1');
    });

    fireEvent.click(screen.getByText('confirm-export-delete'));

    await waitFor(() => {
      expect(selectExportPath).toHaveBeenCalled();
      expect(exportDataset).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: 'ds1',
          selectedRowIds: [1],
          postExportAction: 'delete',
        })
      );
      expect(screen.getByTestId('current-row-count').textContent).toBe('0');
      expect(screen.getByTestId('current-first-name').textContent).toBe('');
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(queryDataset).toHaveBeenCalledTimes(initialQueryDatasetCalls);
    expect(listDatasets).toHaveBeenCalledTimes(initialListDatasetsCalls);
    expect(recordsByDataset.ds1).toHaveLength(0);

    confirmSpy.mockRestore();
  });

  it('should keep the active query view when exporting selected rows', async () => {
    const now = Date.now();
    mockExportDialogOptions.value = {
      format: 'json',
      mode: 'data',
      respectHiddenColumns: true,
      postExportAction: 'keep',
    };

    const recordsByDataset: Record<
      string,
      Array<{ _row_id: number; name: string; category_name: string }>
    > = {
      ds1: [{ _row_id: 1, name: 'source-row', category_name: 'Alpha' }],
    };

    const buildDatasets = () => [
      {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: recordsByDataset.ds1.length,
        columnCount: 3,
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
          columns: ['_row_id', 'name', 'category_name'],
          rows: rows.map((row) => ({ ...row })),
          rowCount: rows.length,
        },
      };
    });

    const selectExportPath = vi.fn(async () => ({
      success: true,
      canceled: false,
      filePath: 'C:/tmp/dataset-export.json',
    }));

    const exportDataset = vi.fn(async () => ({
      success: true,
      files: ['C:/tmp/dataset-export.json'],
      totalRows: 1,
      filesCount: 1,
      executionTime: 6,
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
        {
          datasetId: 'ds1',
          tabGroupId: 'grp1',
          name: 'Dataset 1',
          rowCount: recordsByDataset.ds1.length,
          columnCount: 3,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
    }));

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {},
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
        selectExportPath,
        exportDataset,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
    });

    act(() => {
      useDatasetStore.setState({
        activeQueryTemplate: {
          id: 'qt1',
          queryConfig: {
            lookup: [
              {
                type: 'join',
                lookupDatasetId: 'lookup_ds',
                joinKey: 'category',
                lookupKey: 'code',
                selectColumns: ['category_name'],
                leftJoin: true,
              },
            ],
            sample: { type: 'rows', value: 1, seed: 7 },
          },
        },
      });
    });

    fireEvent.click(screen.getByText('select-first-row'));
    fireEvent.click(screen.getByText('open-export-dialog'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-export-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('confirm-export-delete'));

    await waitFor(() => {
      expect(exportDataset).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: 'ds1',
          format: 'json',
          selectedRowIds: [1],
          applyFilters: true,
          applySort: true,
          applySample: true,
          activeQueryTemplate: expect.objectContaining({
            id: 'qt1',
            queryConfig: expect.objectContaining({
              lookup: expect.any(Array),
              sample: expect.objectContaining({ value: 1 }),
            }),
          }),
        })
      );
    });
  });

  it('should treat a canceled export path selection as a normal cancel', async () => {
    const now = Date.now();
    mockExportDialogOptions.value = {
      format: 'csv',
      mode: 'data',
      respectHiddenColumns: true,
      postExportAction: 'keep',
    };

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
    };

    const buildDatasets = () => [
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

    const selectExportPath = vi.fn(async () => ({
      success: true,
      canceled: true,
    }));

    const exportDataset = vi.fn(async () => ({
      success: true,
      files: ['C:/tmp/dataset-export.csv'],
      totalRows: 1,
      filesCount: 1,
      executionTime: 8,
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {},
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
        selectExportPath,
        exportDataset,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
    });

    fireEvent.click(screen.getByText('open-export-dialog'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-export-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('confirm-export-delete'));

    await waitFor(() => {
      expect(selectExportPath).toHaveBeenCalled();
    });

    expect(exportDataset).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('current-row-count').textContent).toBe('1');
  });

  it('should treat structure export with delete option as non-destructive in the renderer', async () => {
    const now = Date.now();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockExportDialogOptions.value = {
      format: 'csv',
      mode: 'structure',
      respectHiddenColumns: true,
      postExportAction: 'delete',
    };

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
    };

    const buildDatasets = () => [
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

    const selectExportPath = vi.fn(async () => ({
      success: true,
      canceled: false,
      filePath: 'C:/tmp/dataset-export.csv',
    }));

    const exportDataset = vi.fn(async () => ({
      success: true,
      files: ['C:/tmp/dataset-export.csv'],
      totalRows: 0,
      filesCount: 1,
      executionTime: 8,
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {},
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
        selectExportPath,
        exportDataset,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
    });

    const initialQueryDatasetCalls = queryDataset.mock.calls.length;
    const initialListDatasetsCalls = listDatasets.mock.calls.length;

    fireEvent.click(screen.getByText('open-export-dialog'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-export-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('confirm-export-delete'));

    await waitFor(() => {
      expect(selectExportPath).toHaveBeenCalled();
      expect(exportDataset).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: 'ds1',
          mode: 'structure',
          postExportAction: 'delete',
        })
      );
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(queryDataset).toHaveBeenCalledTimes(initialQueryDatasetCalls);
    expect(listDatasets).toHaveBeenCalledTimes(initialListDatasetsCalls);
    expect(recordsByDataset.ds1).toHaveLength(1);
    expect(screen.getByTestId('current-row-count').textContent).toBe('1');

    confirmSpy.mockRestore();
  });

  it('should refresh only the dataset view after export-delete without selected rows', async () => {
    const now = Date.now();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockExportDialogOptions.value = {
      format: 'csv',
      mode: 'data',
      respectHiddenColumns: true,
      postExportAction: 'delete',
    };

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
    };

    const buildDatasets = () => [
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

    const selectExportPath = vi.fn(async () => ({
      success: true,
      canceled: false,
      filePath: 'C:/tmp/dataset-export.csv',
    }));

    const exportDataset = vi.fn(async () => {
      recordsByDataset.ds1 = [];

      return {
        success: true,
        files: ['C:/tmp/dataset-export.csv'],
        totalRows: 1,
        filesCount: 1,
        executionTime: 15,
      };
    });

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {},
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
        selectExportPath,
        exportDataset,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
    });

    const initialQueryDatasetCalls = queryDataset.mock.calls.length;
    const initialListDatasetsCalls = listDatasets.mock.calls.length;

    fireEvent.click(screen.getByText('open-export-dialog'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-export-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('export-total-rows').textContent).toBe('1');
    });

    fireEvent.click(screen.getByText('confirm-export-delete'));

    await waitFor(() => {
      expect(selectExportPath).toHaveBeenCalled();
      expect(exportDataset).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: 'ds1',
          postExportAction: 'delete',
          selectedRowIds: undefined,
        })
      );
      expect(queryDataset).toHaveBeenCalledTimes(initialQueryDatasetCalls + 1);
      expect(screen.getByTestId('current-row-count').textContent).toBe('0');
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(listDatasets).toHaveBeenCalledTimes(initialListDatasetsCalls);
    expect(recordsByDataset.ds1).toHaveLength(0);
    expect(useDatasetStore.getState().currentDataset?.rowCount).toBe(0);
    expect(useDatasetStore.getState().datasets.find((dataset) => dataset.id === 'ds1')?.rowCount).toBe(0);

    confirmSpy.mockRestore();
  });

  it('should refresh the current dataset when schema-updated is emitted for the selected table', async () => {
    const now = Date.now();
    let schemaUpdatedListener: ((datasetId: string) => void) | undefined;

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
      ds2: [{ _row_id: 1, name: 'other-row' }],
    };

    const buildDatasets = () => [
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
        name: 'Dataset 2',
        rowCount: recordsByDataset.ds2.length,
        columnCount: 2,
        sizeBytes: 100,
        createdAt: now + 1,
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

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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
          name: 'Dataset 2',
          rowCount: recordsByDataset.ds2.length,
          columnCount: 2,
          tabOrder: 1,
          isGroupDefault: false,
        },
      ],
    }));

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {},
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
        deleteDataset: vi.fn(async () => ({ success: true })),
        reorderGroupTabs: vi.fn(async () => ({ success: true })),
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
        onSchemaUpdated: vi.fn((callback: (datasetId: string) => void) => {
          schemaUpdatedListener = callback;
          return vi.fn();
        }),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-first-name').textContent).toBe('source-row');
    });

    const initialGetDatasetInfoCalls = getDatasetInfo.mock.calls.length;
    const initialQueryDatasetCalls = queryDataset.mock.calls.length;

    await act(async () => {
      schemaUpdatedListener?.('ds2');
    });

    expect(getDatasetInfo).toHaveBeenCalledTimes(initialGetDatasetInfoCalls);
    expect(queryDataset).toHaveBeenCalledTimes(initialQueryDatasetCalls);

    await act(async () => {
      schemaUpdatedListener?.('ds1');
    });

    await waitFor(() => {
      expect(getDatasetInfo).toHaveBeenCalledTimes(initialGetDatasetInfoCalls + 1);
      expect(queryDataset).toHaveBeenCalledTimes(initialQueryDatasetCalls + 1);
    });
  });

  it('should skip schema refetch after a local schema patch when schema-updated is emitted', async () => {
    const now = Date.now();
    let schemaUpdatedListener: ((datasetId: string) => void) | undefined;

    const recordsByDataset: Record<string, Array<{ _row_id: number; name: string }>> = {
      ds1: [{ _row_id: 1, name: 'source-row' }],
    };

    const buildDatasets = () => [
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

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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

    (window as any).electronAPI = {
      getAppInfo: vi.fn(async () => ({
        success: true,
        info: {},
      })),
      duckdb: {
        listDatasets,
        getDatasetInfo,
        queryDataset,
        listGroupTabs,
        insertRecord: vi.fn(async () => ({ success: true })),
        updateRecord: vi.fn(async () => ({ success: true })),
        hardDeleteRows: vi.fn(async () => ({ success: true, deletedCount: 1 })),
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
        deleteDataset: vi.fn(async () => ({ success: true })),
        reorderGroupTabs: vi.fn(async () => ({ success: true })),
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
        onSchemaUpdated: vi.fn((callback: (datasetId: string) => void) => {
          schemaUpdatedListener = callback;
          return vi.fn();
        }),
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
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
    });

    await act(async () => {
      useDatasetStore.setState({
        currentDataset: {
          ...buildDatasets()[0],
          schema: [
            { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
            { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
          ],
        },
      });
      useDatasetStore.getState().applyLocalDatasetSchema('ds1', [
        { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
        { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        { name: 'name_clean', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      ]);
    });

    const initialGetDatasetInfoCalls = getDatasetInfo.mock.calls.length;
    const initialQueryDatasetCalls = queryDataset.mock.calls.length;

    await act(async () => {
      schemaUpdatedListener?.('ds1');
    });

    await waitFor(() => {
      expect(getDatasetInfo).toHaveBeenCalledTimes(initialGetDatasetInfoCalls);
      expect(queryDataset).toHaveBeenCalledTimes(initialQueryDatasetCalls + 1);
    });
  });
});

