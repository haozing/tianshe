import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DatasetsPage } from '../index';
import { useDatasetStore } from '../../../stores/datasetStore';

const mockUpdateActiveQueryTemplate = vi.fn();
const mockCreateQueryTemplateFromConfig = vi.fn();

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
    categories: [],
    currentCategory: null,
    currentTable: {
      datasetId: 'ds1',
      name: 'Dataset 1',
      rowCount: 3,
      isCustomPage: false,
    },
    selectedCategory: null,
    selectedTableId: 'table_ds1',
    isAnalyzingTypes: false,
    refreshWorkspace: vi.fn(),
    selectCategory: vi.fn(),
    selectTable: vi.fn(),
    clearSelection: vi.fn(),
    selectDataset: vi.fn(),
    importDataset: vi.fn(),
    createDataset: vi.fn(),
    createFolder: vi.fn(),
    deleteDatasetAndRefresh: vi.fn(),
    deleteFolderAndRefresh: vi.fn(),
    createGroupTabCopy: vi.fn(),
    renameGroupTab: vi.fn(),
    reorderGroupTabs: vi.fn(),
    deleteRows: vi.fn(),
    exportDatasetWithDialog: vi.fn(),
  }),
}));

vi.mock('../DatasetSidebar', () => ({
  DatasetSidebar: () => <div data-testid="mock-sidebar" />,
}));

vi.mock('../DatasetTabs', () => ({
  DatasetTabs: () => null,
}));

vi.mock('../DatasetToolbar', () => ({
  DatasetToolbar: ({ onRowHeight }: any) => (
    <div data-testid="mock-toolbar">
      <button onClick={onRowHeight}>open-row-height</button>
    </div>
  ),
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId, rowHeight }: any) => (
    <div data-testid="mock-table">{`${datasetId}:${String(rowHeight)}`}</div>
  ),
}));

vi.mock('../SaveQueryTemplateDialog', () => ({
  SaveQueryTemplateDialog: ({ isOpen, onSave }: any) =>
    isOpen ? (
      <div data-testid="save-query-template-dialog">
        <button onClick={() => onSave('Saved Template', 'desc', 'bookmark')}>
          confirm-save-template
        </button>
      </div>
    ) : null,
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
  RowHeightPanel: ({ currentHeight, onApply, onSaveAsTemplate }: any) => (
    <div data-testid="row-height-panel">
      <div data-testid="current-height">{String(currentHeight)}</div>
      <button onClick={() => onApply({ rowHeight: 'comfortable' })}>apply-row-height</button>
      <button onClick={() => onSaveAsTemplate?.({ rowHeight: 64 })}>save-row-height</button>
    </div>
  ),
}));

const resetStoreState = () => {
  useDatasetStore.setState({
    datasets: [],
    currentDataset: {
      id: 'ds1',
      name: 'Dataset 1',
      rowCount: 3,
      columnCount: 2,
      sizeBytes: 128,
      createdAt: Date.now(),
      schema: [
        { name: 'status', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        { name: 'amount', duckdbType: 'DOUBLE', fieldType: 'number', nullable: true },
      ],
    } as any,
    queryResult: {
      columns: ['_row_id', 'status', 'amount'],
      rows: [{ _row_id: 1, status: 'VIP', amount: 42 }],
      rowCount: 1,
      filteredTotalCount: 1,
    },
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
    activeQueryTemplate: {
      id: 'tpl_active',
      datasetId: 'ds1',
      queryConfig: {
        filter: {
          conditions: [{ field: 'status', type: 'equal', value: 'VIP' }],
          combinator: 'AND',
        },
        rowHeight: 52,
      },
    } as any,
    dataReady: true,
    currentGroupId: null,
    groupTabs: [],
    selectedTabDatasetId: null,
    workspaceCategories: [],
    selectedCategory: null,
    selectedTableId: 'table_ds1',
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

describe('DatasetsPage Batch C row height persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
    mockUpdateActiveQueryTemplate.mockResolvedValue(undefined);
    mockCreateQueryTemplateFromConfig.mockResolvedValue('tpl_saved');

    useDatasetStore.setState({
      updateActiveQueryTemplate: mockUpdateActiveQueryTemplate as any,
      createQueryTemplateFromConfig: mockCreateQueryTemplateFromConfig as any,
      consumePendingLocalSchemaRefresh: vi.fn(() => false) as any,
      applyLocalDatasetCountDelta: vi.fn() as any,
      applyLocalRecordDeletion: vi.fn(() => true) as any,
      updateImportProgress: vi.fn() as any,
    });
  });

  it('hydrates row height from active query config and applies updates through updateActiveQueryTemplate', async () => {
    render(<DatasetsPage />);

    expect(screen.getByTestId('mock-table').textContent).toBe('ds1:52');

    fireEvent.click(screen.getByText('open-row-height'));
    expect(screen.getByTestId('current-height').textContent).toBe('52');

    fireEvent.click(screen.getByText('apply-row-height'));

    await waitFor(() => {
      expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        rowHeight: 'comfortable',
      });
    });

    expect(screen.queryByTestId('row-height-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-table').textContent).toBe('ds1:comfortable');
  });

  it('saves row height as query template with merged active config', async () => {
    render(<DatasetsPage />);

    fireEvent.click(screen.getByText('open-row-height'));
    fireEvent.click(screen.getByText('save-row-height'));

    expect(screen.getByTestId('save-query-template-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByText('confirm-save-template'));

    await waitFor(() => {
      expect(mockCreateQueryTemplateFromConfig).toHaveBeenCalledWith({
        datasetId: 'ds1',
        name: 'Saved Template',
        description: 'desc',
        icon: 'bookmark',
        queryConfig: {
          filter: {
            conditions: [{ field: 'status', type: 'equal', value: 'VIP' }],
            combinator: 'AND',
          },
          rowHeight: 64,
        },
      });
    });

    expect(screen.queryByTestId('row-height-panel')).not.toBeInTheDocument();
  });
});
