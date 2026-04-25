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

vi.mock('../DatasetTabs', () => ({
  DatasetTabs: ({
    tabs,
    selectedTabId,
    onSelectTab,
    onCreateTab,
    onRenameTab,
    onDeleteTab,
    onReorder,
  }: any) => (
    <div data-testid="mock-tabs">
      <div data-testid="selected-tab-id">{selectedTabId ?? ''}</div>
      <div data-testid="tab-order">{tabs.map((tab: any) => tab.id).join(',')}</div>
      {tabs.map((tab: any) => (
        <div key={tab.id}>
          <button onClick={() => onSelectTab(tab.id)}>{`tab-${tab.id}`}</button>
          {onRenameTab && (
            <button onClick={() => onRenameTab(tab.id, `${tab.name}-renamed`)}>
              {`rename-tab-${tab.id}`}
            </button>
          )}
          {onDeleteTab && <button onClick={() => onDeleteTab(tab.id)}>{`delete-tab-${tab.id}`}</button>}
        </div>
      ))}
      <button onClick={onCreateTab}>create-tab-copy</button>
      {onDeleteTab && selectedTabId && (
        <button onClick={() => onDeleteTab(selectedTabId)}>delete-selected-tab</button>
      )}
      {onReorder && (
        <button onClick={() => onReorder([...tabs.map((tab: any) => tab.id)].reverse())}>
          reorder-reverse
        </button>
      )}
      {onReorder && tabs.length > 1 && (
        <button onClick={() => onReorder([tabs[0].id, tabs[0].id])}>reorder-invalid</button>
      )}
    </div>
  ),
}));

vi.mock('../DatasetToolbar', () => ({
  DatasetToolbar: () => <div data-testid="mock-toolbar" />,
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: () => <div data-testid="mock-table" />,
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

describe('DatasetsPage tab group flow', () => {
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

  it('should copy current dataset to new tab and auto-switch, then allow switching back', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
      tabGroupId: 'grp1',
      isGroupDefault: true,
    };
    const ds2 = {
      id: 'ds2',
      name: 'Dataset 2 Copy',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now + 1,
      tabGroupId: 'grp1',
      isGroupDefault: false,
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

    const listGroupTabs = vi.fn(async (_datasetId: string) => ({
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

    const deleteDataset = vi.fn(async () => ({ success: true }));
    const reorderGroupTabs = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
    });

    fireEvent.click(screen.getByText('create-tab-copy'));

    await waitFor(() => {
      expect(createGroupTabCopy).toHaveBeenCalledWith('ds1');
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds2');
      expect(screen.getByText('tab-ds2')).toBeInTheDocument();
      expect(screen.queryByText('table-ds2')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('tab-ds1'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
    });
  });

  it('should rename group tab and refresh lists', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
    };

    let renamed = false;

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [
        {
          ...ds1,
          name: renamed ? 'Dataset 1-renamed' : 'Dataset 1',
        },
      ],
    }));

    const getDatasetInfo = vi.fn(async () => ({
      success: true,
      dataset: {
        ...ds1,
        name: renamed ? 'Dataset 1-renamed' : 'Dataset 1',
        schema: [],
      },
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
        {
          datasetId: 'ds1',
          tabGroupId: 'grp1',
          name: renamed ? 'Dataset 1-renamed' : 'Dataset 1',
          rowCount: 10,
          columnCount: 2,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
    }));

    const renameGroupTab = vi.fn(async () => {
      renamed = true;
      return { success: true };
    });

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy: vi.fn(async () => ({
          success: true,
          datasetId: 'ds2',
          tabGroupId: 'grp1',
        })),
        renameGroupTab,
        deleteDataset: vi.fn(async () => ({ success: true })),
        reorderGroupTabs: vi.fn(async () => ({ success: true })),
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
    });

    fireEvent.click(screen.getByText('rename-tab-ds1'));

    await waitFor(() => {
      expect(renameGroupTab).toHaveBeenCalledWith('ds1', 'Dataset 1-renamed');
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('已重命名数据表');
    });
  });

  it('should clear tab group state when listGroupTabs returns empty', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
    };

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [ds1],
    }));

    const getDatasetInfo = vi.fn(async () => ({
      success: true,
      dataset: {
        ...ds1,
        schema: [],
      },
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [],
    }));

    const createGroupTabCopy = vi.fn(async () => ({
      success: true,
      datasetId: 'ds2',
      tabGroupId: 'grp1',
    }));
    const deleteDataset = vi.fn(async () => ({ success: true }));
    const reorderGroupTabs = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
      expect(useDatasetStore.getState().selectedTabDatasetId).toBeNull();
      expect(useDatasetStore.getState().groupTabs).toEqual([]);
      expect(screen.queryByTestId('mock-tabs')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '复制为新标签页' })).toBeInTheDocument();
    });
  });

  it('should clear tab group state when listGroupTabs throws', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
    };

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [ds1],
    }));

    const getDatasetInfo = vi.fn(async () => ({
      success: true,
      dataset: {
        ...ds1,
        schema: [],
      },
    }));

    const listGroupTabs = vi.fn(async () => {
      throw new Error('list tabs failed');
    });

    const createGroupTabCopy = vi.fn(async () => ({
      success: true,
      datasetId: 'ds2',
      tabGroupId: 'grp1',
    }));
    const deleteDataset = vi.fn(async () => ({ success: true }));
    const reorderGroupTabs = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
      expect(useDatasetStore.getState().selectedTabDatasetId).toBeNull();
      expect(useDatasetStore.getState().groupTabs).toEqual([]);
      expect(screen.queryByTestId('mock-tabs')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '复制为新标签页' })).toBeInTheDocument();
    });
  });

  it('should create and switch to copied tab inside folder category', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
      folderId: 'fd1',
      tabGroupId: 'grp1',
      isGroupDefault: true,
    };
    const ds2 = {
      id: 'ds2',
      name: 'Dataset 2 Copy',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now + 1,
      folderId: 'fd1',
      tabGroupId: 'grp1',
      isGroupDefault: false,
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

    const deleteDataset = vi.fn(async () => ({ success: true }));
    const reorderGroupTabs = vi.fn(async () => ({ success: true }));
    const getTree = vi.fn(async () => ({
      success: true,
      tree: [
        {
          id: 'fd1',
          name: 'Folder A',
          icon: null,
          pluginId: null,
          datasets: copied
            ? [
                {
                  id: 'ds1',
                  name: 'Dataset 1',
                  rowCount: 10,
                  columnCount: 2,
                },
                {
                  id: 'ds2',
                  name: 'Dataset 2 Copy',
                  rowCount: 10,
                  columnCount: 2,
                },
              ]
            : [
                {
                  id: 'ds1',
                  name: 'Dataset 1',
                  rowCount: 10,
                  columnCount: 2,
                },
              ],
          children: [],
        },
      ],
    }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree,
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

    fireEvent.click(screen.getByText('create-tab-copy'));

    await waitFor(() => {
      expect(createGroupTabCopy).toHaveBeenCalledWith('ds1');
    });

    await waitFor(() => {
      expect(screen.queryByText('table-ds2')).not.toBeInTheDocument();
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds2');
    });
  });

  it('should keep current tab and show error when copy fails in root category', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
    };

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [ds1],
    }));

    const getDatasetInfo = vi.fn(async () => ({
      success: true,
      dataset: {
        ...ds1,
        schema: [],
      },
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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

    const createGroupTabCopy = vi.fn(async () => ({
      success: false,
      error: 'copy failed',
    }));

    const deleteDataset = vi.fn(async () => ({ success: true }));
    const reorderGroupTabs = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
    });

    fireEvent.click(screen.getByText('create-tab-copy'));

    await waitFor(() => {
      expect(createGroupTabCopy).toHaveBeenCalledWith('ds1');
      expect(mockToast.error).toHaveBeenCalledWith('复制新标签页失败', 'copy failed');
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.queryByText('tab-ds2')).not.toBeInTheDocument();
    });
  });

  it('should keep current folder tab and show error when copy fails', async () => {
    const now = Date.now();
    const ds1 = {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 10,
      columnCount: 2,
      sizeBytes: 100,
      createdAt: now,
      folderId: 'fd1',
    };

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [ds1],
    }));

    const getDatasetInfo = vi.fn(async () => ({
      success: true,
      dataset: {
        ...ds1,
        schema: [],
      },
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs: [
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

    const createGroupTabCopy = vi.fn(async () => ({
      success: false,
      error: 'copy failed in folder',
    }));

    const deleteDataset = vi.fn(async () => ({ success: true }));
    const reorderGroupTabs = vi.fn(async () => ({ success: true }));
    const getTree = vi.fn(async () => ({
      success: true,
      tree: [
        {
          id: 'fd1',
          name: 'Folder A',
          icon: null,
          pluginId: null,
          datasets: [
            {
              id: 'ds1',
              name: 'Dataset 1',
              rowCount: 10,
              columnCount: 2,
            },
          ],
          children: [],
        },
      ],
    }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
        onExportProgress: vi.fn(() => vi.fn()),
      },
      folder: {
        getTree,
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

    fireEvent.click(screen.getByText('create-tab-copy'));

    await waitFor(() => {
      expect(createGroupTabCopy).toHaveBeenCalledWith('ds1');
      expect(mockToast.error).toHaveBeenCalledWith('复制新标签页失败', 'copy failed in folder');
    });

    await waitFor(() => {
      expect(screen.getByText('table-ds1')).toBeInTheDocument();
      expect(screen.queryByText('table-ds2')).not.toBeInTheDocument();
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
    });
  });

  it('should switch to another tab when deleting currently selected tab', async () => {
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

    let datasets = [ds1, ds2];
    let tabs = [
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
    ];

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets,
    }));

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...(datasetId === 'ds2' ? ds2 : ds1),
        schema: [],
      },
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs,
    }));

    const deleteDataset = vi.fn(async (datasetId: string) => {
      datasets = datasets.filter((dataset) => dataset.id !== datasetId);
      tabs = tabs
        .filter((tab) => tab.datasetId !== datasetId)
        .map((tab, index) => ({ ...tab, tabOrder: index }));
      return { success: true };
    });

    const createGroupTabCopy = vi.fn(async () => ({
      success: true,
      datasetId: 'ds3',
      tabGroupId: 'grp1',
    }));

    const reorderGroupTabs = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
      expect(screen.getByText('tab-ds2')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('tab-ds2'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds2');
    });

    fireEvent.click(screen.getByText('delete-selected-tab'));

    await waitFor(() => {
      expect(deleteDataset).toHaveBeenCalledWith('ds2');
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds1');
      expect(screen.queryByText('tab-ds2')).not.toBeInTheDocument();
    });
  });

  it('should reorder group tabs and refresh tab order from API', async () => {
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

    const datasets = [ds1, ds2];
    let tabs = [
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
    ];

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets,
    }));

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...(datasetId === 'ds2' ? ds2 : ds1),
        schema: [],
      },
    }));

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs,
    }));

    const reorderGroupTabs = vi.fn(async (_groupId: string, datasetIds: string[]) => {
      const tabById = new Map(tabs.map((tab) => [tab.datasetId, tab]));
      tabs = datasetIds.map((datasetId, index) => {
        const tab = tabById.get(datasetId)!;
        return {
          ...tab,
          tabOrder: index,
        };
      });
      return { success: true };
    });

    const deleteDataset = vi.fn(async () => ({ success: true }));
    const createGroupTabCopy = vi.fn(async () => ({
      success: true,
      datasetId: 'ds3',
      tabGroupId: 'grp1',
    }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
      expect(screen.getByTestId('tab-order').textContent).toBe('ds1,ds2');
    });

    fireEvent.click(screen.getByText('reorder-reverse'));

    await waitFor(() => {
      expect(reorderGroupTabs).toHaveBeenCalledWith('grp1', ['ds2', 'ds1']);
    });

    await waitFor(() => {
      expect(screen.getByTestId('tab-order').textContent).toBe('ds2,ds1');
    });
  });

  it('should reject invalid reorder payload on frontend without calling API', async () => {
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

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [ds1, ds2],
    }));

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...(datasetId === 'ds2' ? ds2 : ds1),
        schema: [],
      },
    }));

    const tabs = [
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
    ];

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs,
    }));

    const reorderGroupTabs = vi.fn(async () => ({
      success: true,
    }));
    const createGroupTabCopy = vi.fn(async () => ({
      success: true,
      datasetId: 'ds3',
      tabGroupId: 'grp1',
    }));
    const deleteDataset = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
      expect(screen.getByTestId('tab-order').textContent).toBe('ds1,ds2');
    });

    fireEvent.click(screen.getByText('reorder-invalid'));

    await waitFor(() => {
      expect(reorderGroupTabs).not.toHaveBeenCalled();
      expect(mockToast.error).toHaveBeenCalledWith('调整 Tab 顺序失败', '非法排序数据');
    });

    await waitFor(() => {
      expect(screen.getByTestId('tab-order').textContent).toBe('ds1,ds2');
    });
  });

  it('should keep selected tab when deleting selected tab fails', async () => {
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

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [ds1, ds2],
    }));

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...(datasetId === 'ds2' ? ds2 : ds1),
        schema: [],
      },
    }));

    const tabs = [
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
    ];

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs,
    }));

    const deleteDataset = vi.fn(async () => ({
      success: false,
      error: 'delete failed',
    }));

    const createGroupTabCopy = vi.fn(async () => ({
      success: true,
      datasetId: 'ds3',
      tabGroupId: 'grp1',
    }));

    const reorderGroupTabs = vi.fn(async () => ({ success: true }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
      expect(screen.getByText('tab-ds2')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('tab-ds2'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds2');
    });

    fireEvent.click(screen.getByText('delete-selected-tab'));

    await waitFor(() => {
      expect(deleteDataset).toHaveBeenCalledWith('ds2');
      expect(mockToast.error).toHaveBeenCalledWith('删除数据表失败', 'delete failed');
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-tab-id').textContent).toBe('ds2');
      expect(screen.getByTestId('tab-order').textContent).toBe('ds1,ds2');
    });
  });

  it('should rollback tab order when reorder fails', async () => {
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

    const listDatasets = vi.fn(async () => ({
      success: true,
      datasets: [ds1, ds2],
    }));

    const getDatasetInfo = vi.fn(async (datasetId: string) => ({
      success: true,
      dataset: {
        ...(datasetId === 'ds2' ? ds2 : ds1),
        schema: [],
      },
    }));

    const tabs = [
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
    ];

    const listGroupTabs = vi.fn(async () => ({
      success: true,
      tabs,
    }));

    const reorderGroupTabs = vi.fn(async () => ({
      success: false,
      error: 'reorder failed',
    }));

    const deleteDataset = vi.fn(async () => ({ success: true }));
    const createGroupTabCopy = vi.fn(async () => ({
      success: true,
      datasetId: 'ds3',
      tabGroupId: 'grp1',
    }));

    (window as any).electronAPI = {
      duckdb: {
        listDatasets,
        getDatasetInfo,
        listGroupTabs,
        createGroupTabCopy,
        deleteDataset,
        reorderGroupTabs,
        onImportProgress: vi.fn(() => vi.fn()),
        onDatasetImported: vi.fn(() => vi.fn()),
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
      expect(screen.getByTestId('tab-order').textContent).toBe('ds1,ds2');
    });

    fireEvent.click(screen.getByText('reorder-reverse'));

    await waitFor(() => {
      expect(reorderGroupTabs).toHaveBeenCalledWith('grp1', ['ds2', 'ds1']);
      expect(mockToast.error).toHaveBeenCalledWith('调整 Tab 顺序失败', 'reorder failed');
    });

    await waitFor(() => {
      expect(screen.getByTestId('tab-order').textContent).toBe('ds1,ds2');
    });
  });
});
