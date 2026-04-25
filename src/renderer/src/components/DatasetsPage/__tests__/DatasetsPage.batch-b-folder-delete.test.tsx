import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DatasetsPage } from '../index';
import { useDatasetStore } from '../../../stores/datasetStore';

const mockDeleteFolderAndRefresh = vi.fn();
const mockClearSelection = vi.fn();

const originalMethods = (() => {
  const state = useDatasetStore.getState();
  return {
    refreshDatasetView: state.refreshDatasetView,
    loadGroupTabs: state.loadGroupTabs,
    consumePendingLocalSchemaRefresh: state.consumePendingLocalSchemaRefresh,
    applyLocalDatasetCountDelta: state.applyLocalDatasetCountDelta,
    applyLocalRecordDeletion: state.applyLocalRecordDeletion,
    updateImportProgress: state.updateImportProgress,
    updateActiveQueryTemplate: state.updateActiveQueryTemplate,
    createQueryTemplateFromConfig: state.createQueryTemplateFromConfig,
  };
})();

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('../../../hooks/useElectronAPI', () => ({
  useElectronAPI: () => ({
    duckdb: {
      onExportProgress: vi.fn(() => vi.fn()),
    },
  }),
  useEventSubscription: vi.fn(),
}));

vi.mock('../useDatasetsWorkspaceController', () => ({
  useDatasetsWorkspaceController: () => ({
    categories: [
      {
        id: 'folder-1',
        name: 'Folder 1',
        isFolder: true,
        pluginId: null,
        tables: [],
      },
    ],
    currentCategory: null,
    currentTable: null,
    selectedCategory: null,
    selectedTableId: null,
    isAnalyzingTypes: false,
    refreshWorkspace: vi.fn(),
    selectCategory: vi.fn(),
    selectTable: vi.fn(),
    clearSelection: mockClearSelection,
    selectDataset: vi.fn(),
    importDataset: vi.fn(),
    createDataset: vi.fn(),
    createFolder: vi.fn(),
    deleteDatasetAndRefresh: vi.fn(),
    deleteFolderAndRefresh: mockDeleteFolderAndRefresh,
    createGroupTabCopy: vi.fn(),
    renameGroupTab: vi.fn(),
    reorderGroupTabs: vi.fn(),
    deleteRows: vi.fn(),
    exportDatasetWithDialog: vi.fn(),
  }),
}));

vi.mock('../DatasetSidebar', () => ({
  DatasetSidebar: ({ onDeleteCategory }: any) => (
    <div data-testid="mock-sidebar">
      <button onClick={() => onDeleteCategory?.('folder-1')}>delete-folder</button>
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
  DatasetTable: () => null,
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
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmText,
    children,
    onConfirm,
  }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{description}</div>
        <div>{children}</div>
        <button onClick={() => void onConfirm()}>{confirmText}</button>
      </div>
    ) : null,
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
    hasMore: false,
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
    refreshDatasetView: originalMethods.refreshDatasetView,
    loadGroupTabs: originalMethods.loadGroupTabs,
    consumePendingLocalSchemaRefresh: originalMethods.consumePendingLocalSchemaRefresh,
    applyLocalDatasetCountDelta: originalMethods.applyLocalDatasetCountDelta,
    applyLocalRecordDeletion: originalMethods.applyLocalRecordDeletion,
    updateImportProgress: originalMethods.updateImportProgress,
    updateActiveQueryTemplate: originalMethods.updateActiveQueryTemplate,
    createQueryTemplateFromConfig: originalMethods.createQueryTemplateFromConfig,
  });
};

describe('DatasetsPage Batch B folder deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
    mockDeleteFolderAndRefresh.mockResolvedValue(true);
  });

  it('deletes folders with keep-contents mode by default', async () => {
    render(<DatasetsPage />);

    fireEvent.click(screen.getByText('delete-folder'));

    expect(screen.getByText('删除文件夹')).toBeInTheDocument();
    expect(screen.getByText(/移动到根目录/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => {
      expect(mockDeleteFolderAndRefresh).toHaveBeenCalledWith('folder-1', false);
    });
  });

  it('passes deleteContents=true when recursive deletion is selected', async () => {
    render(<DatasetsPage />);

    fireEvent.click(screen.getByText('delete-folder'));
    fireEvent.click(screen.getByLabelText('同时删除该目录下的所有数据表和子文件夹'));

    expect(screen.getByText(/都会被永久删除/)).toBeInTheDocument();
    expect(screen.getByText('删除文件夹及内容')).toBeInTheDocument();

    fireEvent.click(screen.getByText('删除文件夹及内容'));

    await waitFor(() => {
      expect(mockDeleteFolderAndRefresh).toHaveBeenCalledWith('folder-1', true);
    });
  });
});
