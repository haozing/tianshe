import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryConfig } from '../../../../core/query-engine/types';
import { createDatasetQueryRuntimeSlice } from './queryRuntimeSlice';
import {
  createDatasetQueryTemplateSlice,
  type DatasetQueryTemplateState,
} from './queryTemplateSlice';

const mockPreviewQuerySQL = vi.fn();
const mockQueryTemplateCreate = vi.fn();
const mockQueryTemplateGet = vi.fn();
const mockQueryTemplateGetOrCreateDefault = vi.fn();
const mockQueryTemplateQuery = vi.fn();
const mockQueryTemplateRefresh = vi.fn();
const mockQueryTemplateUpdate = vi.fn();

interface HarnessState extends DatasetQueryTemplateState {}

function createHarness(initialState: Partial<HarnessState> = {}) {
  let state: HarnessState = {
    activeQueryTemplate: null,
    activeQuerySessionId: 0,
    activeQueryDatasetId: null,
    loading: false,
    loadingMore: false,
    error: null,
    currentOffset: 0,
    hasMore: true,
    dataReady: false,
    pageSize: 5,
    queryResult: null,
    currentDataset: null,
    queryDataset: vi.fn(),
    ...initialState,
  };

  const set = vi.fn((partial: any) => {
    const nextState = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...nextState };
  });
  const get = vi.fn(() => state);
  const queryRuntime = createDatasetQueryRuntimeSlice(set, get);
  const actions = createDatasetQueryTemplateSlice(set, get, queryRuntime.helpers);

  return {
    actions,
    getState: () => state,
    setState: (nextState: Partial<HarnessState>) => {
      state = { ...state, ...nextState };
    },
  };
}

describe('dataset query template slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewQuerySQL.mockResolvedValue({
      success: true,
      sql: 'SELECT * FROM data LIMIT 50',
    });
    mockQueryTemplateCreate.mockResolvedValue({ success: true, templateId: 'tpl_1' });
    mockQueryTemplateGet.mockResolvedValue({
      success: true,
      template: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {},
      },
    });
    mockQueryTemplateGetOrCreateDefault.mockResolvedValue({
      success: true,
      template: {
        id: 'default_tpl',
        datasetId: 'ds1',
        queryConfig: { sort: { columns: ['name'] } },
        isDefault: true,
      },
    });
    mockQueryTemplateQuery.mockResolvedValue({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
        filteredTotalCount: 1,
      },
    });
    mockQueryTemplateRefresh.mockResolvedValue({ success: true });
    mockQueryTemplateUpdate.mockResolvedValue({ success: true });

    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          previewQuerySQL: mockPreviewQuerySQL,
        },
        queryTemplate: {
          create: mockQueryTemplateCreate,
          get: mockQueryTemplateGet,
          getOrCreateDefault: mockQueryTemplateGetOrCreateDefault,
          query: mockQueryTemplateQuery,
          refresh: mockQueryTemplateRefresh,
          update: mockQueryTemplateUpdate,
        },
      },
    };
  });

  it('creates a template from preview SQL and strips implicit pagination', async () => {
    const { actions } = createHarness();

    const templateId = await actions.createQueryTemplateFromConfig({
      datasetId: 'ds1',
      name: 'Template 1',
      queryConfig: {} as QueryConfig,
    });

    expect(templateId).toBe('tpl_1');
    expect(mockPreviewQuerySQL).toHaveBeenCalledWith('ds1', {});
    expect(mockQueryTemplateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: 'ds1',
        name: 'Template 1',
        generatedSQL: 'SELECT * FROM data',
      })
    );
  });

  it('applies a template and hydrates the query result snapshot', async () => {
    const { actions, getState } = createHarness({ pageSize: 10 });

    await actions.applyQueryTemplate('tpl_1');

    expect(mockQueryTemplateGet).toHaveBeenCalledWith('tpl_1');
    expect(mockQueryTemplateQuery).toHaveBeenCalledWith('tpl_1', 0, 10);
    expect(getState().activeQueryTemplate).toMatchObject({
      id: 'tpl_1',
      datasetId: 'ds1',
    });
    expect(getState()).toMatchObject({
      activeQueryDatasetId: 'ds1',
      currentOffset: 1,
      hasMore: false,
      loading: false,
      dataReady: true,
    });
  });

  it('refreshes a non-default active template snapshot', async () => {
    const { actions, getState } = createHarness({
      pageSize: 7,
      activeQueryTemplate: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {},
      },
    });

    await actions.refreshActiveQueryTemplate('ds1');

    expect(mockQueryTemplateRefresh).toHaveBeenCalledWith('tpl_1');
    expect(mockQueryTemplateQuery).toHaveBeenCalledWith('tpl_1', 0, 7);
    expect(getState().queryResult?.rows).toEqual([{ id: 1 }]);
  });

  it('falls back to queryDataset when no matching active template exists', async () => {
    const queryDataset = vi.fn().mockResolvedValue(undefined);
    const { actions } = createHarness({ queryDataset });

    await actions.refreshActiveQueryTemplate('ds1');

    expect(queryDataset).toHaveBeenCalledWith('ds1');
    expect(mockQueryTemplateRefresh).not.toHaveBeenCalled();
    expect(mockQueryTemplateQuery).not.toHaveBeenCalled();
  });

  it('loads the default template before updating when nothing is active', async () => {
    const { actions, getState } = createHarness();

    await actions.updateActiveQueryTemplate('ds1', {
      filter: { conditions: [] },
    } as Partial<QueryConfig>);

    expect(mockQueryTemplateGetOrCreateDefault).toHaveBeenCalledWith('ds1');
    expect(mockQueryTemplateUpdate).toHaveBeenCalledWith({
      templateId: 'default_tpl',
      queryConfig: {
        sort: { columns: ['name'] },
        filter: { conditions: [] },
      },
    });
    expect(mockQueryTemplateGet).toHaveBeenCalledWith('default_tpl');
    expect(getState().activeQueryTemplate).toMatchObject({
      id: 'tpl_1',
      datasetId: 'ds1',
    });
  });

  it('resets query template view state without touching loading flags', () => {
    const { actions, getState } = createHarness({
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1' },
      queryResult: { columns: ['id'], rows: [{ id: 1 }], rowCount: 1 },
      currentOffset: 1,
      hasMore: false,
      dataReady: true,
    });

    actions.resetQueryTemplateState();

    expect(getState()).toMatchObject({
      activeQueryTemplate: null,
      queryResult: null,
      currentOffset: 0,
      hasMore: true,
      dataReady: false,
    });
  });
});
