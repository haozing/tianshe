import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  DatasetToolbar: () => null,
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId }: any) => <div data-testid="mock-table">{datasetId}</div>,
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

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
};

const getWorkspaceRoot = () =>
  document.querySelector('[data-datasets-viewport]') as HTMLElement | null;

const getSidebarSurface = () =>
  (Array.from(document.querySelectorAll('.shell-sidebar-surface')).find(
    (element) => (element as HTMLElement).style.width
  ) as HTMLElement | undefined) ?? null;

describe('DatasetsPage responsive matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
    setViewportWidth(1440);

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

  it.each([
    [390, 'narrow', '15rem'],
    [768, 'regular', '16rem'],
    [1440, 'wide', '17rem'],
  ] as const)(
    'applies the high-density workspace metrics for viewport %s',
    async (viewportWidth, expectedTier, expectedSidebarWidth) => {
      setViewportWidth(viewportWidth);
      render(<DatasetsPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('搜索')).toBeInTheDocument();
      });

      expect(getWorkspaceRoot()).toHaveAttribute('data-datasets-viewport', expectedTier);
      expect(getSidebarSurface()?.style.width).toBe(expectedSidebarWidth);
    }
  );

  it('updates the workspace detail metrics after resize and keeps collapsed navigation usable', async () => {
    render(<DatasetsPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('搜索')).toBeInTheDocument();
    });

    expect(getWorkspaceRoot()).toHaveAttribute('data-datasets-viewport', 'wide');
    expect(getSidebarSurface()?.style.width).toBe('17rem');

    act(() => {
      setViewportWidth(390);
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(getWorkspaceRoot()).toHaveAttribute('data-datasets-viewport', 'narrow');
      expect(getSidebarSurface()?.style.width).toBe('15rem');
    });

    fireEvent.click(screen.getByTitle('收起侧边栏'));

    await screen.findByTitle('快速搜索');
    const collapsedSidebarSurface = getSidebarSurface();

    expect(collapsedSidebarSurface?.style.width).toBe('4rem');
  });
});
