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
  DatasetToolbar: ({ onAggregate, onGroup, onFillColor }: any) => (
    <div data-testid="mock-toolbar">
      <button onClick={onAggregate}>open-aggregate</button>
      <button onClick={onGroup}>open-group</button>
      <button onClick={onFillColor}>open-color</button>
    </div>
  ),
}));

vi.mock('../DatasetTable', () => ({
  DatasetTable: ({ datasetId }: any) => <div data-testid="mock-table">{datasetId}</div>,
}));

vi.mock('../SaveQueryTemplateDialog', () => ({
  SaveQueryTemplateDialog: ({ isOpen, onSave, onClose }: any) =>
    isOpen ? (
      <div data-testid="save-query-template-dialog">
        <button onClick={() => onSave('Saved Template', 'desc', 'bookmark')}>
          confirm-save-template
        </button>
        <button onClick={onClose}>close-save-template</button>
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
  AggregatePanel: ({ onApply, onSaveAsTemplate, onClear }: any) => (
    <div data-testid="aggregate-panel">
      <button
        onClick={() =>
          onApply({
            groupBy: ['status'],
            measures: [{ name: 'total_amount', function: 'SUM', field: 'amount' }],
          })
        }
      >
        apply-aggregate
      </button>
      <button
        onClick={() =>
          onSaveAsTemplate?.({
            groupBy: ['status'],
            measures: [{ name: 'total_amount', function: 'SUM', field: 'amount' }],
          })
        }
      >
        save-aggregate
      </button>
      <button onClick={() => onClear?.()}>clear-aggregate</button>
    </div>
  ),
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
  GroupPanel: ({ onApply }: any) => (
    <div data-testid="group-panel">
      <button
        onClick={() =>
          onApply({
            field: 'status',
            order: 'asc',
            showStats: true,
          })
        }
      >
        apply-group
      </button>
      <button onClick={() => onApply(null)}>clear-group</button>
    </div>
  ),
}));

vi.mock('../panels/ColorPanel', () => ({
  ColorPanel: ({ onApply, onSaveAsTemplate, onClear }: any) => (
    <div data-testid="color-panel">
      <button
        onClick={() =>
          onApply({
            type: 'color',
            rules: [
              {
                id: 'rule-1',
                column: 'status',
                operator: 'eq',
                value: 'VIP',
                color: '#fef3c7',
              },
            ],
          })
        }
      >
        apply-color
      </button>
      <button
        onClick={() =>
          onSaveAsTemplate?.({
            type: 'color',
            rules: [
              {
                id: 'rule-1',
                column: 'status',
                operator: 'eq',
                value: 'VIP',
                color: '#fef3c7',
              },
            ],
          })
        }
      >
        save-color
      </button>
      <button onClick={() => onClear?.()}>clear-color</button>
    </div>
  ),
}));

vi.mock('../panels/RowHeightPanel', () => ({
  RowHeightPanel: () => null,
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
      queryConfig: {},
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

describe('DatasetsPage Batch A panel wiring', () => {
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

  it('opens aggregate, group, and color panels from the toolbar', async () => {
    render(<DatasetsPage />);

    fireEvent.click(screen.getByText('open-aggregate'));
    expect(screen.getByTestId('aggregate-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByText('open-group'));
    expect(screen.getByTestId('group-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('aggregate-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('open-color'));
    expect(screen.getByTestId('color-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('group-panel')).not.toBeInTheDocument();
  });

  it('applies aggregate, group, and color configs through updateActiveQueryTemplate', async () => {
    render(<DatasetsPage />);

    fireEvent.click(screen.getByText('open-aggregate'));
    fireEvent.click(screen.getByText('apply-aggregate'));

    await waitFor(() => {
      expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        aggregate: {
          groupBy: ['status'],
          measures: [{ name: 'total_amount', function: 'SUM', field: 'amount' }],
        },
        group: undefined,
      });
    });

    fireEvent.click(screen.getByText('open-group'));
    fireEvent.click(screen.getByText('apply-group'));

    await waitFor(() => {
      expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        group: {
          field: 'status',
          order: 'asc',
          showStats: true,
        },
        aggregate: undefined,
      });
    });

    fireEvent.click(screen.getByText('open-color'));
    fireEvent.click(screen.getByText('apply-color'));

    await waitFor(() => {
      expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        color: {
          type: 'color',
          rules: [
            {
              id: 'rule-1',
              column: 'status',
              operator: 'eq',
              value: 'VIP',
              color: '#fef3c7',
            },
          ],
        },
      });
    });
  });

  it('supports clearing aggregate, group, and color configs', async () => {
    render(<DatasetsPage />);

    fireEvent.click(screen.getByText('open-aggregate'));
    fireEvent.click(screen.getByText('clear-aggregate'));

    await waitFor(() => {
      expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        aggregate: undefined,
      });
    });

    fireEvent.click(screen.getByText('open-group'));
    fireEvent.click(screen.getByText('clear-group'));

    await waitFor(() => {
      expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        group: undefined,
        aggregate: undefined,
      });
    });

    fireEvent.click(screen.getByText('open-color'));
    fireEvent.click(screen.getByText('clear-color'));

    await waitFor(() => {
      expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        color: undefined,
      });
    });
  });

  it('opens the save-template dialog for aggregate and color configs and persists the merged queryConfig', async () => {
    useDatasetStore.setState({
      activeQueryTemplate: {
        id: 'tpl_active',
        datasetId: 'ds1',
        queryConfig: {
          filter: {
            conditions: [{ field: 'status', type: 'equal', value: 'VIP' }],
          },
        },
      } as any,
    });

    render(<DatasetsPage />);

    fireEvent.click(screen.getByText('open-aggregate'));
    fireEvent.click(screen.getByText('save-aggregate'));

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
          },
          aggregate: {
            groupBy: ['status'],
            measures: [{ name: 'total_amount', function: 'SUM', field: 'amount' }],
          },
          group: undefined,
        },
      });
    });

    fireEvent.click(screen.getByText('open-color'));
    fireEvent.click(screen.getByText('save-color'));

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
          },
          color: {
            type: 'color',
            rules: [
              {
                id: 'rule-1',
                column: 'status',
                operator: 'eq',
                value: 'VIP',
                color: '#fef3c7',
              },
            ],
          },
        },
      });
    });
  });
});
