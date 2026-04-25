import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DatasetsPage } from '../index';
import { useDatasetStore } from '../../../stores/datasetStore';

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('../../../hooks/useCustomPages', () => ({
  usePluginPagesGrouped: () => ({ pluginGroups: [] }),
}));

vi.mock('../DatasetTabs', () => ({
  DatasetTabs: () => null,
}));

vi.mock('../DatasetToolbar', () => ({
  DatasetToolbar: ({ onCreateTabCopy }: any) =>
    onCreateTabCopy ? <button onClick={onCreateTabCopy}>复制为新标签页</button> : null,
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId, searchQuery }: any) => (
    <div data-testid="mock-table">
      <div data-testid="table-dataset-id">{datasetId}</div>
      <div data-testid="table-search-prop">{searchQuery ?? ''}</div>
    </div>
  ),
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
  const target = screen.getByText(name).closest('[role="treeitem"],[role="button"]');
  expect(target).toBeTruthy();
  fireEvent.click(target!);
};

const getSidebarFrameFor = (element: HTMLElement | null) =>
  (element?.closest('.shell-sidebar-surface')?.parentElement
    ?.parentElement as HTMLElement | null) ?? null;

describe('DatasetsPage sidebar search wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();

    const now = Date.now();
    (window as any).electronAPI = {
      duckdb: {
        listDatasets: vi.fn(async () => ({
          success: true,
          datasets: [
            {
              id: 'ds1',
              name: 'Dataset 1',
              rowCount: 3,
              columnCount: 2,
              sizeBytes: 100,
              createdAt: now,
            },
          ],
        })),
        getDatasetInfo: vi.fn(async () => ({
          success: true,
          dataset: {
            id: 'ds1',
            name: 'Dataset 1',
            rowCount: 3,
            columnCount: 2,
            sizeBytes: 100,
            createdAt: now,
            schema: [],
          },
        })),
        listGroupTabs: vi.fn(async () => ({ success: true, tabs: [] })),
        queryDataset: vi.fn(async () => ({
          success: true,
          result: {
            columns: ['id'],
            rows: [{ id: 1 }],
            rowCount: 1,
          },
        })),
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
  });

  it('should keep sidebar search local and never forward it into DatasetTable props', async () => {
    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('搜索')).toBeInTheDocument();
      expect(screen.getByText('Dataset 1')).toBeInTheDocument();
    });

    clickSidebarCategory('Dataset 1');

    await waitFor(() => {
      expect(screen.getByTestId('table-dataset-id').textContent).toBe('ds1');
      expect(screen.getByRole('button', { name: '复制为新标签页' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('搜索'), {
      target: { value: 'not-found' },
    });

    await waitFor(() => {
      expect(screen.getByText('未找到匹配的数据表')).toBeInTheDocument();
      expect(screen.getByTestId('table-dataset-id').textContent).toBe('ds1');
      expect(screen.getByTestId('table-search-prop').textContent).toBe('');
    });
  });

  it('should preserve responsive sidebar collapse while opening the quick-search overlay in the real page shell', async () => {
    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('搜索')).toBeInTheDocument();
    });

    const expandedSidebarContainer = getSidebarFrameFor(screen.getByPlaceholderText('搜索'));

    expect(expandedSidebarContainer).toBeTruthy();

    fireEvent.click(screen.getByTitle('收起侧边栏'));

    const collapsedQuickSearch = await screen.findByTitle('快速搜索');
    const collapsedSidebarContainer = getSidebarFrameFor(collapsedQuickSearch);

    expect(collapsedSidebarContainer).toBeTruthy();
    await waitFor(() => {
      expect(collapsedSidebarContainer?.style.width).toBe('4.5rem');
    });
    expect(screen.getByTitle('Dataset 1')).toBeInTheDocument();

    fireEvent.click(collapsedQuickSearch);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('搜索')).toHaveFocus();
    });
    expect(screen.getByText('快速搜索')).toBeInTheDocument();
    expect(collapsedSidebarContainer?.style.width).toBe('4.5rem');
  });
});
