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

vi.mock('../DatasetToolbar', () => ({
  DatasetToolbar: ({ onCreateTabCopy }: any) => (
    <div data-testid="mock-toolbar">
      {onCreateTabCopy ? <button onClick={onCreateTabCopy}>复制为新标签页</button> : null}
    </div>
  ),
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId }: any) => {
    const queryResult = useDatasetStore((state) => state.queryResult);
    const queryDataset = useDatasetStore((state) => state.queryDataset);

    useEffect(() => {
      if (datasetId) {
        void queryDataset(datasetId);
      }
    }, [datasetId, queryDataset]);

    return (
      <div data-testid="mock-table">
        <div data-testid="current-dataset-id">{datasetId}</div>
        <div data-testid="current-row-count">{queryResult?.rows?.length ?? 0}</div>
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

const clickSidebarCategory = (name: string) => {
  const candidate = screen
    .getAllByText(name)
    .find(
      (node) =>
        node.closest('[role="treeitem"],[role="button"]') && !node.closest('.shell-tab-strip')
    );
  const clickable = candidate?.closest('[role="treeitem"],[role="button"]') as HTMLElement | null;
  expect(clickable).toBeTruthy();
  fireEvent.click(clickable!);
};

const clickDatasetTab = (name: string) => {
  const tabNode = screen.getByRole('tab', { name: new RegExp(name) });
  fireEvent.click(tabNode);
};

describe('DatasetsPage low-mock integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
  });

  it('should run sidebar -> copy tab -> auto switch -> manual switch back using real Sidebar and Tabs', async () => {
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
      expect(screen.getByPlaceholderText('搜索')).toBeInTheDocument();
      expect(screen.getByText('Dataset 1')).toBeInTheDocument();
    });

    clickSidebarCategory('Dataset 1');

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds1');
      expect(screen.getByTestId('current-row-count').textContent).toBe('1');
    });

    fireEvent.click(screen.getByText('复制为新标签页'));

    await waitFor(() => {
      expect(createGroupTabCopy).toHaveBeenCalledWith('ds1');
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds2');
    });

    await waitFor(() => {
      expect(screen.getAllByText('Dataset 2 Copy').length).toBeGreaterThan(0);
    });

    clickDatasetTab('Dataset 1');

    await waitFor(() => {
      expect(screen.getByTestId('current-dataset-id').textContent).toBe('ds1');
    });
  });
});
