import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatasetQueryRuntimeSlice,
  type DatasetQueryRuntimeState,
} from './queryRuntimeSlice';

const mockDuckdbQueryDataset = vi.fn();
const mockQueryTemplateQuery = vi.fn();
const mockQueryTemplateRefresh = vi.fn();

function createHarness(initialState: Partial<DatasetQueryRuntimeState> = {}) {
  let state: DatasetQueryRuntimeState = {
    activeQueryTemplate: null,
    activeQuerySessionId: 0,
    activeQueryDatasetId: null,
    loading: false,
    loadingMore: false,
    error: null,
    currentOffset: 0,
    hasMore: true,
    dataReady: false,
    pageSize: 2,
    queryResult: null,
    currentDataset: null,
    ...initialState,
  };

  const set = vi.fn((partial: any) => {
    const nextState = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...nextState };
  });
  const get = vi.fn(() => state);
  const runtime = createDatasetQueryRuntimeSlice(set, get);

  return {
    actions: runtime.actions,
    helpers: runtime.helpers,
    getState: () => state,
    setState: (nextState: Partial<DatasetQueryRuntimeState>) => {
      state = { ...state, ...nextState };
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('dataset query runtime slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDuckdbQueryDataset.mockResolvedValue({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: 2,
      },
    });
    mockQueryTemplateQuery.mockResolvedValue({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 10 }],
        rowCount: 1,
        filteredTotalCount: 1,
      },
    });
    mockQueryTemplateRefresh.mockResolvedValue({ success: true });

    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          queryDataset: mockDuckdbQueryDataset,
        },
        queryTemplate: {
          query: mockQueryTemplateQuery,
          refresh: mockQueryTemplateRefresh,
        },
      },
    };
  });

  it('queries a dataset page directly through duckdb', async () => {
    const { actions, getState } = createHarness({ pageSize: 2 });

    await actions.queryDataset('ds1');

    expect(mockDuckdbQueryDataset).toHaveBeenCalledWith('ds1', undefined, 0, 2);
    expect(getState()).toMatchObject({
      activeQueryDatasetId: 'ds1',
      currentOffset: 2,
      hasMore: true,
      loading: false,
      dataReady: true,
    });
    expect(getState().queryResult?.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('uses the active query template snapshot for the matching dataset', async () => {
    const { actions, getState } = createHarness({
      pageSize: 10,
      activeQueryTemplate: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {},
      },
    });

    await actions.queryDataset('ds1');

    expect(mockQueryTemplateQuery).toHaveBeenCalledWith('tpl_1', 0, 10);
    expect(mockDuckdbQueryDataset).not.toHaveBeenCalled();
    expect(getState().queryResult?.rows).toEqual([{ id: 10 }]);
    expect(getState().hasMore).toBe(false);
  });

  it('clears a stale active template before querying another dataset', async () => {
    const { actions, getState } = createHarness({
      activeQueryTemplate: {
        id: 'tpl_other',
        datasetId: 'other_ds',
        queryConfig: {},
      },
    });

    await actions.queryDataset('ds1');

    expect(mockDuckdbQueryDataset).toHaveBeenCalledWith('ds1', undefined, 0, 2);
    expect(mockQueryTemplateQuery).not.toHaveBeenCalled();
    expect(getState().activeQueryTemplate).toBeNull();
  });

  it('appends rows when loading more direct dataset data', async () => {
    mockDuckdbQueryDataset.mockResolvedValueOnce({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 3 }],
        rowCount: 1,
      },
    });
    const { actions, getState } = createHarness({
      queryResult: {
        columns: ['id'],
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: 2,
      },
      currentDataset: { rowCount: 4 },
      currentOffset: 2,
      pageSize: 2,
      hasMore: true,
    });

    await actions.loadMoreData('ds1');

    expect(mockDuckdbQueryDataset).toHaveBeenCalledWith('ds1', undefined, 2, 2);
    expect(getState().queryResult?.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(getState()).toMatchObject({
      currentOffset: 3,
      hasMore: true,
      loadingMore: false,
    });
  });

  it('ignores a stale query result after cancellation', async () => {
    const deferred = createDeferred<{
      success: boolean;
      result: { columns: string[]; rows: Array<{ id: number }>; rowCount: number };
    }>();
    mockDuckdbQueryDataset.mockReturnValueOnce(deferred.promise);
    const { actions, getState } = createHarness({ pageSize: 2 });

    const queryPromise = actions.queryDataset('ds1');
    actions.cancelQuery('ds1');
    deferred.resolve({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
      },
    });
    await queryPromise;

    expect(getState().queryResult).toBeNull();
    expect(getState()).toMatchObject({
      activeQueryDatasetId: null,
      loading: false,
      dataReady: false,
    });
  });
});
