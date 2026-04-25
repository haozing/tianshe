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

vi.mock('../../../lib/toast', () => ({
  toast: mockToast,
}));

vi.mock('../../../hooks/useCustomPages', () => ({
  usePluginPagesGrouped: () => ({ pluginGroups: [] }),
}));

vi.mock('../DatasetSidebar', () => ({
  DatasetSidebar: ({
    categories,
    selectedCategory,
    selectedTableId,
    onSelectCategory,
    onSelectTable,
    onImportExcelToFolder,
    onCreateDatasetInFolder,
  }: any) => (
    <div data-testid="mock-sidebar">
      <div data-testid="selected-category">{selectedCategory ?? ''}</div>
      <div data-testid="selected-table-id">{selectedTableId ?? ''}</div>
      <button onClick={() => onImportExcelToFolder?.('folder-1')}>import-folder-1</button>
      <button onClick={() => onCreateDatasetInFolder?.('folder-1')}>create-folder-1</button>
      {categories.map((category: any) => (
        <section key={category.id} data-testid={`category-${category.id}`}>
          <div>{`category:${category.id}:${category.name}`}</div>
          <div data-testid={`tables-${category.id}`}>
            {category.tables.map((table: any) => table.datasetId ?? table.id).join(',')}
          </div>
          <button
            onClick={() => onSelectCategory(category.id)}
          >{`select-category:${category.id}`}</button>
          {category.tables.map((table: any) => (
            <button
              key={table.id}
              onClick={() => {
                onSelectCategory(category.id);
                onSelectTable(table.id);
              }}
            >
              {`select-table:${category.id}:${table.datasetId ?? table.id}`}
            </button>
          ))}
        </section>
      ))}
    </div>
  ),
}));

vi.mock('../DatasetTabs', () => ({
  DatasetTabs: () => null,
}));

vi.mock('../DatasetToolbar', () => ({
  DatasetToolbar: () => <div data-testid="mock-toolbar" />,
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId }: any) => {
    useEffect(() => {
      const probe = (window as any).__datasetTableProbe;
      if (datasetId && typeof probe === 'function') {
        void probe(datasetId);
      }
    }, [datasetId]);

    return <div data-testid="current-dataset-id">{datasetId}</div>;
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

const resetStoreState = () => {
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
    workspaceCategories: [],
    selectedCategory: null,
    selectedTableId: null,
    isAnalyzingTypes: false,
  });
};

describe('DatasetsPage workspace regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
    (window as any).__datasetTableProbe = vi.fn();
  });

  it('keeps folder context selected without auto-opening the first table', async () => {
    const now = Date.now();
    const dataset = {
      id: 'ds1',
      name: 'Leads',
      rowCount: 5,
      columnCount: 2,
      sizeBytes: 96,
      createdAt: now,
      folderId: 'folder-1',
    };

    (window as any).electronAPI = {
      duckdb: {
        listDatasets: vi.fn(async () => ({
          success: true,
          datasets: [dataset],
        })),
        getDatasetInfo: vi.fn(async () => ({
          success: true,
          dataset: {
            ...dataset,
            schema: [],
          },
        })),
        listGroupTabs: vi.fn(async () => ({ success: true, tabs: [] })),
        queryDataset: vi.fn(async () => ({
          success: true,
          result: {
            columns: ['id'],
            rows: [],
            rowCount: 0,
          },
        })),
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree: vi.fn(async () => ({
          success: true,
          tree: [
            {
              id: 'folder-1',
              name: 'Folder 1',
              datasets: [
                {
                  id: 'ds1',
                  name: 'Leads',
                },
              ],
              children: [],
            },
          ],
        })),
      },
      jsPlugin: {
        getCustomPages: vi.fn(async () => ({ success: true, pages: [] })),
      },
    };

    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByText('category:folder-1:Folder 1')).toBeInTheDocument();
      expect(screen.getByTestId('tables-folder-1').textContent).toContain('ds1');
    });

    fireEvent.click(screen.getByText('select-category:folder-1'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-category').textContent).toBe('folder-1');
      expect(screen.getByTestId('selected-table-id').textContent).toBe('');
      expect(screen.queryByTestId('current-dataset-id')).not.toBeInTheDocument();
      expect(screen.getByText('已进入目录 “Folder 1”')).toBeInTheDocument();
    });
  });

  it('keeps the folder selected after importing into a folder and opens the imported dataset', async () => {
    const importedDatasetId = 'dataset-imported';
    const importedDataset = {
      id: importedDatasetId,
      name: 'contacts',
      rowCount: 8,
      columnCount: 3,
      sizeBytes: 128,
      createdAt: Date.now(),
      folderId: 'folder-1',
    };

    let imported = false;

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: imported ? [importedDataset] : [],
    }));

    const analyzeTypes = vi.fn(async () => ({
      success: true,
      schema: [],
      sampleData: [],
    }));
    const applySchema = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo: vi.fn(async () => ({
          success: true,
          dataset: {
            ...importedDataset,
            schema: [],
          },
        })),
        listGroupTabs: vi.fn(async () => ({ success: true, tabs: [] })),
        queryDataset: vi.fn(async () => ({
          success: true,
          result: {
            columns: ['id'],
            rows: [],
            rowCount: 0,
          },
        })),
        selectImportFile: vi.fn(async () => ({
          success: true,
          canceled: false,
          filePath: 'C:\\imports\\contacts.csv',
        })),
        importDatasetFile: vi.fn(async (_filePath: string, _name: string, options?: any) => {
          imported = true;
          expect(options).toEqual({ folderId: 'folder-1' });
          return {
            success: true,
            datasetId: importedDatasetId,
          };
        }),
        analyzeTypes,
        applySchema,
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree: vi.fn(async () => ({
          success: true,
          tree: [
            {
              id: 'folder-1',
              name: 'Folder 1',
              children: [],
              datasets: imported
                ? [
                    {
                      id: importedDatasetId,
                      name: importedDataset.name,
                    },
                  ]
                : [],
            },
          ],
        })),
      },
      jsPlugin: {
        getCustomPages: vi.fn(async () => ({ success: true, pages: [] })),
      },
    };

    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByText('category:folder-1:Folder 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('import-folder-1'));

    await waitFor(
      () => {
        expect(analyzeTypes).toHaveBeenCalledWith(importedDatasetId);
        expect(applySchema).toHaveBeenCalledWith(importedDatasetId, []);
        expect(screen.getByTestId('selected-category').textContent).toBe('folder-1');
        expect(screen.getByTestId('selected-table-id').textContent).toBe(
          `table_${importedDatasetId}`
        );
        expect(screen.getByTestId('current-dataset-id').textContent).toBe(importedDatasetId);
        expect(screen.getByTestId('tables-folder-1').textContent).toContain(importedDatasetId);
      },
      { timeout: 3000 }
    );

    expect(screen.queryByText(`select-category:${importedDatasetId}`)).not.toBeInTheDocument();
  });

  it('does not mark an import as processed when type analysis fails', async () => {
    const importedDatasetId = 'dataset-import-failed';
    const importedDataset = {
      id: importedDatasetId,
      name: 'contacts-failed',
      rowCount: 8,
      columnCount: 3,
      sizeBytes: 128,
      createdAt: Date.now(),
      folderId: 'folder-1',
    };

    let imported = false;

    const analyzeTypes = vi.fn(async () => ({
      success: false,
      error: 'analyze failed',
    }));
    const applySchema = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets: vi.fn(async () => ({
          success: true,
          datasets: imported ? [importedDataset] : [],
        })),
        getDatasetInfo: vi.fn(async () => ({
          success: true,
          dataset: {
            ...importedDataset,
            schema: [],
          },
        })),
        listGroupTabs: vi.fn(async () => ({ success: true, tabs: [] })),
        queryDataset: vi.fn(async () => ({
          success: true,
          result: {
            columns: ['id'],
            rows: [],
            rowCount: 0,
          },
        })),
        selectImportFile: vi.fn(async () => ({
          success: true,
          canceled: false,
          filePath: 'C:\\imports\\contacts.csv',
        })),
        importDatasetFile: vi.fn(async () => {
          imported = true;
          return {
            success: true,
            datasetId: importedDatasetId,
          };
        }),
        analyzeTypes,
        applySchema,
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree: vi.fn(async () => ({
          success: true,
          tree: [
            {
              id: 'folder-1',
              name: 'Folder 1',
              children: [],
              datasets: imported
                ? [
                    {
                      id: importedDatasetId,
                      name: importedDataset.name,
                    },
                  ]
                : [],
            },
          ],
        })),
      },
      jsPlugin: {
        getCustomPages: vi.fn(async () => ({ success: true, pages: [] })),
      },
    };

    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByText('category:folder-1:Folder 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('import-folder-1'));

    await waitFor(() => {
      expect(analyzeTypes).toHaveBeenCalledWith(importedDatasetId);
    });

    await waitFor(() => {
      expect(applySchema).not.toHaveBeenCalled();
      expect(useDatasetStore.getState().processedImports.has(importedDatasetId)).toBe(false);
      expect(screen.getByTestId('selected-category').textContent).toBe('folder-1');
      expect(screen.getByTestId('selected-table-id').textContent).toBe(
        `table_${importedDatasetId}`
      );
      expect(screen.getByTestId('current-dataset-id').textContent).toBe(importedDatasetId);
      expect(screen.getByTestId('tables-folder-1').textContent).toContain(importedDatasetId);
    });
  });

  it('creates a dataset directly inside the target folder and selects it', async () => {
    const createdDatasetId = 'dataset-created';
    const createdDataset = {
      id: createdDatasetId,
      name: 'Sheet1',
      rowCount: 0,
      columnCount: 4,
      sizeBytes: 64,
      createdAt: Date.now(),
      folderId: 'folder-1',
    };

    let created = false;

    const createEmptyDataset = vi.fn(async (_name: string, options?: any) => {
      created = true;
      expect(options).toEqual({ folderId: 'folder-1' });
      return {
        success: true,
        datasetId: createdDatasetId,
      };
    });

    (window as any).electronAPI = {
      duckdb: {
        listDatasets: vi.fn(async () => ({
          success: true,
          datasets: created ? [createdDataset] : [],
        })),
        getDatasetInfo: vi.fn(async () => ({
          success: true,
          dataset: {
            ...createdDataset,
            schema: [],
          },
        })),
        createEmptyDataset,
        listGroupTabs: vi.fn(async () => ({ success: true, tabs: [] })),
        queryDataset: vi.fn(async () => ({
          success: true,
          result: {
            columns: ['id'],
            rows: [],
            rowCount: 0,
          },
        })),
        onImportProgress: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree: vi.fn(async () => ({
          success: true,
          tree: [
            {
              id: 'folder-1',
              name: 'Folder 1',
              children: [],
              datasets: created
                ? [
                    {
                      id: createdDatasetId,
                      name: createdDataset.name,
                    },
                  ]
                : [],
            },
          ],
        })),
      },
      jsPlugin: {
        getCustomPages: vi.fn(async () => ({ success: true, pages: [] })),
      },
    };

    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByText('category:folder-1:Folder 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('create-folder-1'));

    await waitFor(() => {
      expect(createEmptyDataset).toHaveBeenCalledWith('Sheet1', { folderId: 'folder-1' });
      expect(screen.getByTestId('selected-category').textContent).toBe('folder-1');
      expect(screen.getByTestId('selected-table-id').textContent).toBe(`table_${createdDatasetId}`);
      expect(screen.getByTestId('current-dataset-id').textContent).toBe(createdDatasetId);
      expect(screen.getByTestId('tables-folder-1').textContent).toContain(createdDatasetId);
    });
  });

  it('does not fetch dataset info twice when the page switches to a dataset table', async () => {
    const dataset = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 4,
      columnCount: 2,
      sizeBytes: 64,
      createdAt: Date.now(),
    };

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...dataset,
        id: datasetId,
        schema: [],
      },
    }));

    (window as any).__datasetTableProbe = vi.fn(async (datasetId: string) => {
      await (window as any).electronAPI.duckdb.getDatasetInfo(datasetId);
    });

    (window as any).electronAPI = {
      duckdb: {
        listDatasets: vi.fn(async () => ({
          success: true,
          datasets: [dataset],
        })),
        getDatasetInfo,
        listGroupTabs: vi.fn(async () => ({ success: true, tabs: [] })),
        queryDataset: vi.fn(async () => ({
          success: true,
          result: {
            columns: ['id'],
            rows: [],
            rowCount: 0,
          },
        })),
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
      expect(screen.getByText(`select-table:${dataset.id}:${dataset.id}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(`select-table:${dataset.id}:${dataset.id}`));

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe(dataset.id);
      expect(getDatasetInfo).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the import progress dialog compact and closable after all imports settle', async () => {
    useDatasetStore.setState({
      importProgress: new Map([
        [
          'dataset-import-1',
          {
            datasetId: 'dataset-import-1',
            status: 'importing',
            progress: 42,
            rowsProcessed: 4200,
            message: '正在写入 DuckDB',
          },
        ],
      ]),
    });

    (window as any).electronAPI = {
      duckdb: {
        listDatasets: vi.fn(async () => ({
          success: true,
          datasets: [],
        })),
        listGroupTabs: vi.fn(async () => ({ success: true, tabs: [] })),
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

    const { container } = render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByText('导入进度')).toBeInTheDocument();
      expect(
        screen.getByText('批量导入任务会以紧凑列表显示，便于快速查看状态、进度和异常。')
      ).toBeInTheDocument();
      expect(screen.getByText('dataset-import-1')).toBeInTheDocument();
      expect(screen.getByText('正在写入 DuckDB')).toBeInTheDocument();
      expect(screen.getByText('42%')).toBeInTheDocument();
    });

    expect(container.querySelector('.shell-floating-panel')).toBeInTheDocument();

    act(() => {
      useDatasetStore.setState({
        importProgress: new Map([
          [
            'dataset-import-1',
            {
              datasetId: 'dataset-import-1',
              status: 'completed',
              progress: 100,
              rowsProcessed: 4200,
              message: '导入完成',
            },
          ],
        ]),
      });
    });

    await waitFor(() => {
      const closeButton = screen.getByRole('button', { name: '关闭' });
      expect(closeButton).toBeInTheDocument();
      expect(closeButton.className).toContain('shell-field-control');
      expect(screen.getByText('完成')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    await waitFor(() => {
      expect(screen.queryByText('导入进度')).not.toBeInTheDocument();
    });
  });
});
