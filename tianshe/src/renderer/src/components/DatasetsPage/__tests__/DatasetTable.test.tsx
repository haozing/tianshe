import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const {
  mockCreateColumnsFromSchema,
  mockRefreshDatasetView,
  mockClearQueryResult,
  mockLoadMoreData,
  mockApplyLocalDatasetSchema,
  mockApplyLocalRecordUpdate,
  mockUpdateActiveQueryTemplate,
  mockUpdateColumnDisplayConfig,
  mockUpdateDatasetColumn,
  mockDeleteDatasetColumn,
  mockUpdateDatasetRecord,
  mockCancelQuery,
  mockTanStackPropsRef,
  mockStoreStateRef,
  useDatasetStoreMock,
} = vi.hoisted(() => {
  const mockCreateColumnsFromSchema = vi.fn((schema: any[]) =>
    schema.map((column) => ({ id: column.name }))
  );
  const mockRefreshDatasetView = vi.fn();
  const mockClearQueryResult = vi.fn();
  const mockLoadMoreData = vi.fn();
  const mockApplyLocalDatasetSchema = vi.fn();
  const mockApplyLocalRecordUpdate = vi.fn();
  const mockUpdateActiveQueryTemplate = vi.fn();
  const mockUpdateColumnDisplayConfig = vi.fn();
  const mockUpdateDatasetColumn = vi.fn();
  const mockDeleteDatasetColumn = vi.fn();
  const mockUpdateDatasetRecord = vi.fn();
  const mockCancelQuery = vi.fn();
  const mockTanStackPropsRef = { current: undefined as any };
  const mockStoreStateRef = { current: undefined as any };
  const useDatasetStoreMock = vi.fn((selector?: (state: any) => unknown) =>
    selector ? selector(mockStoreStateRef.current) : mockStoreStateRef.current
  );

  (useDatasetStoreMock as any).getState = () => mockStoreStateRef.current;

  return {
    mockCreateColumnsFromSchema,
    mockRefreshDatasetView,
    mockClearQueryResult,
    mockLoadMoreData,
    mockApplyLocalDatasetSchema,
    mockApplyLocalRecordUpdate,
    mockUpdateActiveQueryTemplate,
    mockUpdateColumnDisplayConfig,
    mockUpdateDatasetColumn,
    mockDeleteDatasetColumn,
    mockUpdateDatasetRecord,
    mockCancelQuery,
    mockTanStackPropsRef,
    mockStoreStateRef,
    useDatasetStoreMock,
  };
});

vi.mock('../../../stores/datasetStore', () => ({
  useDatasetStore: useDatasetStoreMock,
  selectActiveQueryConfig: (state: any) => state.activeQueryConfig,
}));

vi.mock('../TanStackDataTable/columns', () => ({
  createColumnsFromSchema: mockCreateColumnsFromSchema,
}));

vi.mock('../TanStackDataTable', () => ({
  TanStackDataTable: (props: any) => {
    mockTanStackPropsRef.current = props;
    return <div data-testid="mock-tanstack-table" />;
  },
}));

vi.mock('../../../services/datasets/datasetMutationService', () => ({
  deleteDatasetColumn: mockDeleteDatasetColumn,
  reorderDatasetColumns: vi.fn(),
  updateDatasetColumn: mockUpdateDatasetColumn,
  updateDatasetColumnDisplayConfig: mockUpdateColumnDisplayConfig,
  updateDatasetRecord: mockUpdateDatasetRecord,
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { DatasetTable } from '../DatasetTable';

function createStoreState(overrides: Record<string, unknown> = {}) {
  return {
    queryResult: {
      columns: ['_row_id', 'name'],
      rows: [{ _row_id: 1, name: 'Alice' }],
      filteredTotalCount: 1,
    },
    refreshDatasetView: mockRefreshDatasetView,
    currentDataset: {
      id: 'test-dataset',
      name: 'Test Dataset',
      rowCount: 1,
      columnCount: 3,
      schema: [
        { name: 'name', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true },
        {
          name: 'action',
          fieldType: 'button',
          duckdbType: 'VARCHAR',
          nullable: true,
          metadata: { buttonLabel: 'Run' },
        },
        {
          name: 'files',
          fieldType: 'attachment',
          duckdbType: 'VARCHAR',
          nullable: true,
        },
      ],
    },
    clearQueryResult: mockClearQueryResult,
    loadMoreData: mockLoadMoreData,
    hasMore: false,
    loadingMore: false,
    applyLocalDatasetSchema: mockApplyLocalDatasetSchema,
    applyLocalRecordUpdate: mockApplyLocalRecordUpdate,
    updateActiveQueryTemplate: mockUpdateActiveQueryTemplate,
    activeQueryConfig: undefined,
    cancelQuery: mockCancelQuery,
    ...overrides,
  };
}

function getLastSchemaArg() {
  const lastCall = mockCreateColumnsFromSchema.mock.calls.at(-1);
  expect(lastCall).toBeDefined();
  return lastCall?.[0] as Array<Record<string, unknown>>;
}

function getLastTableProps() {
  expect(mockTanStackPropsRef.current).toBeDefined();
  return mockTanStackPropsRef.current;
}

describe('DatasetTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateDatasetColumn.mockResolvedValue(undefined);
    mockDeleteDatasetColumn.mockResolvedValue({ success: true });
    mockUpdateDatasetRecord.mockResolvedValue(undefined);
    mockApplyLocalRecordUpdate.mockReturnValue(true);
    mockStoreStateRef.current = createStoreState();
  });

  it('retains schema-only virtual columns in the default row-level view', async () => {
    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['name', 'action', 'files']);
    });
  });

  it('does not force virtual columns back into an explicitly projected row-level query', async () => {
    mockStoreStateRef.current = createStoreState({
      activeQueryConfig: {
        columns: {
          select: ['name'],
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['name']);
      expect(getLastTableProps().columnManagerColumns).toEqual([
        expect.objectContaining({ id: 'name', isVisible: true, isViewExcludedByProjection: false }),
        expect.objectContaining({ id: 'action', isVisible: false, isViewExcludedByProjection: true }),
        expect.objectContaining({ id: 'files', isVisible: false, isViewExcludedByProjection: true }),
      ]);
    });
  });

  it('adds projected-out columns back into the explicit view selection', async () => {
    mockStoreStateRef.current = createStoreState({
      activeQueryConfig: {
        columns: {
          select: ['name'],
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastTableProps().columnManagerColumns).toEqual([
        expect.objectContaining({ id: 'name', isVisible: true }),
        expect.objectContaining({ id: 'action', isVisible: false, isViewExcludedByProjection: true }),
        expect.objectContaining({ id: 'files', isVisible: false, isViewExcludedByProjection: true }),
      ]);
    });

    await getLastTableProps().onToggleColumnVisibility('files', true);

    expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('test-dataset', {
      columns: { select: ['name', 'files'] },
    });
  });

  it('keeps non-hidden virtual columns in row-level views when query-template hide is used', async () => {
    mockStoreStateRef.current = createStoreState({
      activeQueryConfig: {
        columns: {
          hide: ['name'],
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['action', 'files']);
    });
  });

  it('does not re-add hidden virtual columns to the visible table', async () => {
    mockStoreStateRef.current = createStoreState({
      activeQueryConfig: {
        columns: {
          hide: ['action'],
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['name', 'files']);
    });
  });

  it('passes hidden schema columns to the column manager and persists visibility changes', async () => {
    mockStoreStateRef.current = createStoreState({
      activeQueryConfig: {
        columns: {
          hide: ['files'],
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastTableProps().columnManagerColumns).toEqual([
        expect.objectContaining({ id: 'name', isVisible: true }),
        expect.objectContaining({ id: 'action', isVisible: true }),
        expect.objectContaining({ id: 'files', isVisible: false }),
      ]);
    });

    await getLastTableProps().onToggleColumnVisibility('files', true);

    expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('test-dataset', {
      columns: undefined,
    });
    expect(mockUpdateColumnDisplayConfig).not.toHaveBeenCalled();
  });

  it('allows the current view to force-show dataset-level hidden columns', async () => {
    mockStoreStateRef.current = createStoreState({
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 3,
        schema: [
          { name: 'name', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true },
          {
            name: 'action',
            fieldType: 'button',
            duckdbType: 'VARCHAR',
            nullable: true,
            metadata: { buttonLabel: 'Run' },
          },
          {
            name: 'files',
            fieldType: 'attachment',
            duckdbType: 'VARCHAR',
            nullable: true,
            displayConfig: { hidden: true },
          },
        ],
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['name', 'action']);
      expect(getLastTableProps().columnManagerColumns).toEqual([
        expect.objectContaining({ id: 'name', isVisible: true }),
        expect.objectContaining({ id: 'action', isVisible: true }),
        expect.objectContaining({
          id: 'files',
          isVisible: false,
          isDefaultHidden: true,
          isViewHidden: false,
          isViewForcedVisible: false,
        }),
      ]);
    });

    await getLastTableProps().onToggleColumnVisibility('files', true);

    expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('test-dataset', {
      columns: { show: ['files'] },
    });
    expect(mockUpdateColumnDisplayConfig).not.toHaveBeenCalled();
  });

  it('treats explicit selection as a view-level override for dataset hidden columns', async () => {
    mockStoreStateRef.current = createStoreState({
      queryResult: {
        columns: ['_row_id', 'name', 'files'],
        rows: [{ _row_id: 1, name: 'Alice', files: null }],
        filteredTotalCount: 1,
      },
      activeQueryConfig: {
        columns: {
          select: ['name', 'files'],
        },
      },
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 3,
        schema: [
          { name: 'name', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true },
          {
            name: 'action',
            fieldType: 'button',
            duckdbType: 'VARCHAR',
            nullable: true,
            metadata: { buttonLabel: 'Run' },
          },
          {
            name: 'files',
            fieldType: 'attachment',
            duckdbType: 'VARCHAR',
            nullable: true,
            displayConfig: { hidden: true },
          },
        ],
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['name', 'files']);
      expect(getLastTableProps().columnManagerColumns).toEqual([
        expect.objectContaining({ id: 'name', isVisible: true }),
        expect.objectContaining({ id: 'action', isVisible: false, isViewExcludedByProjection: true }),
        expect.objectContaining({
          id: 'files',
          isVisible: true,
          isDefaultHidden: true,
          isViewForcedVisible: true,
          isViewExcludedByProjection: false,
        }),
      ]);
    });
  });

  it('hides columns in the current view through query-template hide', async () => {
    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastTableProps().columnManagerColumns).toEqual([
        expect.objectContaining({ id: 'name', isVisible: true }),
        expect.objectContaining({ id: 'action', isVisible: true }),
        expect.objectContaining({ id: 'files', isVisible: true }),
      ]);
    });

    await getLastTableProps().onToggleColumnVisibility('name', false);

    expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('test-dataset', {
      columns: { hide: ['name'] },
    });
    expect(mockUpdateColumnDisplayConfig).not.toHaveBeenCalled();
  });

  it('persists dataset default hidden separately and keeps the current view visible', async () => {
    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastTableProps().columnManagerColumns).toEqual([
        expect.objectContaining({ id: 'name', isVisible: true, isDefaultHidden: false }),
        expect.objectContaining({ id: 'action', isVisible: true, isDefaultHidden: false }),
        expect.objectContaining({ id: 'files', isVisible: true, isDefaultHidden: false }),
      ]);
    });

    await getLastTableProps().onSetDefaultColumnVisibility('name', false);

    expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('test-dataset', {
      columns: { show: ['name'] },
    });
    expect(mockUpdateColumnDisplayConfig).toHaveBeenCalledWith({
      datasetId: 'test-dataset',
      columnName: 'name',
      displayConfig: { hidden: true },
    });
    expect(mockApplyLocalDatasetSchema).toHaveBeenCalled();
  });

  it('keeps aggregate results free of schema-only virtual columns', async () => {
    mockStoreStateRef.current = createStoreState({
      queryResult: {
        columns: ['status', 'count'],
        rows: [{ status: 'active', count: 2 }],
        filteredTotalCount: 1,
      },
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 3,
        schema: [
          { name: 'status', fieldType: 'single_select', duckdbType: 'VARCHAR', nullable: true },
          {
            name: 'action',
            fieldType: 'button',
            duckdbType: 'VARCHAR',
            nullable: true,
          },
          {
            name: 'files',
            fieldType: 'attachment',
            duckdbType: 'VARCHAR',
            nullable: true,
          },
        ],
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      const schema = getLastSchemaArg();
      expect(schema.map((column) => column.name)).toEqual(['status', 'count']);
      expect(schema.find((column) => column.name === 'count')?.locked).toBe(true);
    });
  });

  it('passes the active group field into TanStack grouping and hides internal group helper columns', async () => {
    mockStoreStateRef.current = createStoreState({
      queryResult: {
        columns: ['_row_id', 'status', 'name', '__group_row_num', '__group_count', '__group_sum_amount'],
        rows: [
          {
            _row_id: 1,
            status: 'active',
            name: 'Alice',
            __group_row_num: 1,
            __group_count: 2,
            __group_sum_amount: 30,
          },
        ],
        filteredTotalCount: 1,
      },
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 3,
        schema: [
          { name: 'status', fieldType: 'single_select', duckdbType: 'VARCHAR', nullable: true },
          { name: 'name', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true },
          { name: 'amount', fieldType: 'number', duckdbType: 'DOUBLE', nullable: true },
        ],
      },
      activeQueryConfig: {
        group: {
          field: 'status',
          order: 'asc',
          showStats: true,
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['status', 'name']);
      expect(getLastTableProps().grouping).toEqual(['status']);
    });
  });

  it('maps query grouping to the visible renamed column id', async () => {
    mockStoreStateRef.current = createStoreState({
      queryResult: {
        columns: ['_row_id', 'Customer Status', 'name'],
        rows: [{ _row_id: 1, 'Customer Status': 'active', name: 'Alice' }],
        filteredTotalCount: 1,
      },
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 2,
        schema: [
          { name: 'status', fieldType: 'single_select', duckdbType: 'VARCHAR', nullable: true },
          { name: 'name', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true },
        ],
      },
      activeQueryConfig: {
        group: {
          field: 'status',
          order: 'asc',
          showStats: true,
        },
        columns: {
          rename: {
            status: 'Customer Status',
          },
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['Customer Status', 'name']);
      expect(getLastTableProps().grouping).toEqual(['Customer Status']);
    });
  });

  it('renames query-derived columns through query template columns.rename', async () => {
    mockStoreStateRef.current = createStoreState({
      queryResult: {
        columns: ['status', 'count_label'],
        rows: [{ status: 'active', count_label: 2 }],
        filteredTotalCount: 1,
      },
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 1,
        schema: [{ name: 'status', fieldType: 'single_select', duckdbType: 'VARCHAR', nullable: true }],
      },
      activeQueryConfig: {
        columns: {
          rename: {
            count: 'count_label',
          },
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['status', 'count_label']);
    });

    await getLastTableProps().onRenameColumn('count_label', 'total_count');

    expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('test-dataset', {
      columns: {
        rename: {
          count: 'total_count',
        },
      },
    });
  });

  it('removes query-derived columns from the current view through query-template hide', async () => {
    mockStoreStateRef.current = createStoreState({
      queryResult: {
        columns: ['status', 'count'],
        rows: [{ status: 'active', count: 2 }],
        filteredTotalCount: 1,
      },
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 1,
        schema: [{ name: 'status', fieldType: 'single_select', duckdbType: 'VARCHAR', nullable: true }],
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['status', 'count']);
    });

    await getLastTableProps().onDeleteColumn('count');

    expect(mockUpdateActiveQueryTemplate).toHaveBeenCalledWith('test-dataset', {
      columns: {
        hide: ['count'],
      },
    });
  });

  it('writes renamed physical columns back through their source field', async () => {
    mockStoreStateRef.current = createStoreState({
      queryResult: {
        columns: ['_row_id', 'Customer Name'],
        rows: [{ _row_id: 1, 'Customer Name': 'Alice' }],
        filteredTotalCount: 1,
      },
      currentDataset: {
        id: 'test-dataset',
        name: 'Test Dataset',
        rowCount: 1,
        columnCount: 1,
        schema: [{ name: 'name', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true }],
      },
      activeQueryConfig: {
        columns: {
          rename: {
            name: 'Customer Name',
          },
        },
      },
    });

    render(<DatasetTable datasetId="test-dataset" />);

    await waitFor(() => {
      expect(getLastSchemaArg().map((column) => column.name)).toEqual(['Customer Name']);
    });

    await act(async () => {
      await getLastTableProps().onCellValueChange(1, 'Customer Name', 'Bob');
    });

    expect(mockUpdateDatasetRecord).toHaveBeenCalledWith('test-dataset', 1, {
      name: 'Bob',
    });
    expect(mockApplyLocalRecordUpdate).toHaveBeenCalledWith('test-dataset', 1, {
      'Customer Name': 'Bob',
    });
  });
});
