import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatasetQueryRuntimeSlice } from './queryRuntimeSlice';
import { createDatasetCoreSlice, type DatasetCoreState } from './coreSlice';
import type { DatasetInfo } from './types';

const mockListDatasets = vi.fn();
const mockGetDatasetInfo = vi.fn();
const mockDeleteDataset = vi.fn();
const mockRenameDataset = vi.fn();

interface HarnessState extends DatasetCoreState {}

const makeDataset = (id: string, name = id): DatasetInfo => ({
  id,
  name,
  rowCount: 1,
  columnCount: 1,
  sizeBytes: 0,
  createdAt: 1,
  schema: [],
});

function createHarness(initialState: Partial<HarnessState> = {}) {
  let state: HarnessState = {
    datasets: [],
    currentDataset: null,
    queryResult: null,
    datasetInfoRequestId: 0,
    activeQueryTemplate: null,
    activeQuerySessionId: 0,
    activeQueryDatasetId: null,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: true,
    currentOffset: 0,
    pageSize: 50,
    dataReady: false,
    currentGroupId: null,
    groupTabs: [],
    selectedTabDatasetId: null,
    getDatasetInfo: vi.fn(),
    refreshActiveQueryTemplate: vi.fn(),
    ...initialState,
  };

  const set = vi.fn((partial: any) => {
    const nextState = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...nextState };
  });
  const get = vi.fn(() => state);
  const queryRuntime = createDatasetQueryRuntimeSlice(set, get);
  const actions = createDatasetCoreSlice(set, get, queryRuntime.helpers);

  return {
    actions,
    getState: () => state,
    setState: (nextState: Partial<HarnessState>) => {
      state = { ...state, ...nextState };
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('dataset core slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDatasets.mockResolvedValue({
      success: true,
      datasets: [makeDataset('ds1')],
    });
    mockGetDatasetInfo.mockResolvedValue({
      success: true,
      dataset: makeDataset('ds1'),
    });
    mockDeleteDataset.mockResolvedValue({ success: true });
    mockRenameDataset.mockResolvedValue({ success: true });

    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          listDatasets: mockListDatasets,
          getDatasetInfo: mockGetDatasetInfo,
          deleteDataset: mockDeleteDataset,
          renameDataset: mockRenameDataset,
        },
      },
    };
  });

  it('loads dataset metadata from the API', async () => {
    const { actions, getState } = createHarness();

    await actions.loadDatasets();

    expect(mockListDatasets).toHaveBeenCalled();
    expect(getState().datasets).toEqual([makeDataset('ds1')]);
    expect(getState()).toMatchObject({ loading: false, error: null });
  });

  it('ignores stale getDatasetInfo responses', async () => {
    const first = createDeferred<{ success: boolean; dataset: DatasetInfo }>();
    const second = createDeferred<{ success: boolean; dataset: DatasetInfo }>();
    mockGetDatasetInfo.mockImplementation((datasetId: string) =>
      datasetId === 'ds1' ? first.promise : second.promise
    );
    const { actions, getState } = createHarness();

    const firstRequest = actions.getDatasetInfo('ds1');
    const secondRequest = actions.getDatasetInfo('ds2');

    second.resolve({ success: true, dataset: makeDataset('ds2') });
    await secondRequest;
    first.resolve({ success: true, dataset: makeDataset('ds1') });
    await firstRequest;

    expect(getState().currentDataset?.id).toBe('ds2');
  });

  it('renames datasets in both list and current metadata', async () => {
    const { actions, getState } = createHarness({
      datasets: [makeDataset('ds1', 'Old')],
      currentDataset: makeDataset('ds1', 'Old'),
    });

    await expect(actions.renameDataset('ds1', 'New')).resolves.toBe(true);

    expect(mockRenameDataset).toHaveBeenCalledWith('ds1', 'New');
    expect(getState().datasets[0].name).toBe('New');
    expect(getState().currentDataset?.name).toBe('New');
  });

  it('deletes the active dataset and clears related view state', async () => {
    const { actions, getState } = createHarness({
      datasets: [makeDataset('ds1'), makeDataset('ds2')],
      currentDataset: makeDataset('ds1'),
      activeQueryDatasetId: 'ds1',
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1' },
      queryResult: { columns: ['id'], rows: [{ id: 1 }], rowCount: 1 },
      currentOffset: 1,
      hasMore: false,
      dataReady: true,
      currentGroupId: 'grp1',
      groupTabs: [
        {
          datasetId: 'ds1',
          tabGroupId: 'grp1',
          name: 'Dataset 1',
          rowCount: 1,
          columnCount: 1,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
      selectedTabDatasetId: 'ds1',
    });

    await expect(actions.deleteDataset('ds1')).resolves.toBe(true);

    expect(mockDeleteDataset).toHaveBeenCalledWith('ds1');
    expect(getState().datasets.map((dataset) => dataset.id)).toEqual(['ds2']);
    expect(getState()).toMatchObject({
      currentDataset: null,
      activeQueryDatasetId: null,
      activeQueryTemplate: null,
      queryResult: null,
      currentGroupId: null,
      groupTabs: [],
      selectedTabDatasetId: null,
      loading: false,
    });
  });
});
