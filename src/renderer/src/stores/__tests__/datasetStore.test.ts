import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatasetStore } from '../datasetStore';

const mockDuckdbQueryDataset = vi.fn();
const mockDuckdbGetDatasetInfo = vi.fn();
const mockDuckdbListGroupTabs = vi.fn();
const mockDuckdbDeleteDataset = vi.fn();
const mockQueryTemplateQuery = vi.fn();
const mockQueryTemplateRefresh = vi.fn();
const mockQueryTemplateUpdate = vi.fn();
const mockQueryTemplateGet = vi.fn();
const mockQueryTemplateGetOrCreateDefault = vi.fn();
const mockQueryTemplateCreate = vi.fn();
const mockQueryTemplateList = vi.fn();
const mockQueryTemplateDelete = vi.fn();
const mockQueryTemplateReorder = vi.fn();

const originalMethods = (() => {
  const state = useDatasetStore.getState();
  return {
    queryDataset: state.queryDataset,
    loadMoreData: state.loadMoreData,
    refreshActiveQueryTemplate: state.refreshActiveQueryTemplate,
    updateActiveQueryTemplate: state.updateActiveQueryTemplate,
    createQueryTemplateFromConfig: state.createQueryTemplateFromConfig,
  };
})();

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
    queryDataset: originalMethods.queryDataset,
    loadMoreData: originalMethods.loadMoreData,
    refreshActiveQueryTemplate: originalMethods.refreshActiveQueryTemplate,
    updateActiveQueryTemplate: originalMethods.updateActiveQueryTemplate,
    createQueryTemplateFromConfig: originalMethods.createQueryTemplateFromConfig,
  });
};

describe('datasetStore query/template behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();

    mockDuckdbQueryDataset.mockResolvedValue({
      success: true,
      result: { columns: ['id'], rows: [{ id: 1 }], rowCount: 1 },
    });
    mockDuckdbGetDatasetInfo.mockResolvedValue({
      success: true,
      dataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 1,
        columnCount: 1,
        sizeBytes: 0,
        createdAt: Date.now(),
        schema: [],
      },
    });
    mockDuckdbListGroupTabs.mockResolvedValue({
      success: true,
      tabs: [],
    });
    mockDuckdbDeleteDataset.mockResolvedValue({ success: true });
    mockQueryTemplateQuery.mockResolvedValue({
      success: true,
      result: { columns: ['id'], rows: [{ id: 2 }], rowCount: 1, filteredTotalCount: 2 },
    });
    mockQueryTemplateRefresh.mockResolvedValue({ success: true });
    mockQueryTemplateUpdate.mockResolvedValue({ success: true });
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
        queryConfig: {},
      },
    });
    mockQueryTemplateCreate.mockResolvedValue({ success: true, templateId: 'tpl_1' });
    mockQueryTemplateList.mockResolvedValue({ success: true, templates: [] });
    mockQueryTemplateDelete.mockResolvedValue({ success: true });
    mockQueryTemplateReorder.mockResolvedValue({ success: true });

    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          queryDataset: mockDuckdbQueryDataset,
          getDatasetInfo: mockDuckdbGetDatasetInfo,
          listGroupTabs: mockDuckdbListGroupTabs,
          deleteDataset: mockDuckdbDeleteDataset,
          previewQuerySQL: vi.fn(),
        },
        queryTemplate: {
          query: mockQueryTemplateQuery,
          refresh: mockQueryTemplateRefresh,
          update: mockQueryTemplateUpdate,
          get: mockQueryTemplateGet,
          getOrCreateDefault: mockQueryTemplateGetOrCreateDefault,
          create: mockQueryTemplateCreate,
          list: mockQueryTemplateList,
          delete: mockQueryTemplateDelete,
          reorder: mockQueryTemplateReorder,
        },
      },
    };
  });

  it('queryDataset should read from the active template snapshot without persisting config', async () => {
    useDatasetStore.setState({
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
      pageSize: 20,
    });

    await useDatasetStore.getState().queryDataset('ds1');

    expect(mockQueryTemplateQuery).toHaveBeenCalledWith('tpl_1', 0, 20);
    expect(mockQueryTemplateRefresh).not.toHaveBeenCalled();
    expect(mockQueryTemplateUpdate).not.toHaveBeenCalled();
    expect(mockDuckdbQueryDataset).not.toHaveBeenCalled();
    expect(useDatasetStore.getState().queryResult?.rows).toEqual([{ id: 2 }]);
  });

  it('queryDataset should clear stale active template and query dataset directly', async () => {
    useDatasetStore.setState({
      activeQueryTemplate: { id: 'tpl_stale', datasetId: 'other_ds', queryConfig: {} },
      pageSize: 20,
    });

    await useDatasetStore.getState().queryDataset('ds1');

    const state = useDatasetStore.getState();
    expect(mockDuckdbQueryDataset).toHaveBeenCalledWith('ds1', undefined, 0, 20);
    expect(state.activeQueryTemplate).toBeNull();
    expect(state.dataReady).toBe(true);
  });

  it('refreshActiveQueryTemplate should rebuild the active template snapshot without updating config', async () => {
    useDatasetStore.setState({
      activeQueryTemplate: { id: 'tpl_2', datasetId: 'ds1', queryConfig: {} },
      pageSize: 20,
    });

    await useDatasetStore.getState().refreshActiveQueryTemplate('ds1');

    expect(mockQueryTemplateRefresh).toHaveBeenCalledWith('tpl_2');
    expect(mockQueryTemplateQuery).toHaveBeenCalledWith('tpl_2', 0, 20);
    expect(mockQueryTemplateUpdate).not.toHaveBeenCalled();
    expect(mockDuckdbQueryDataset).not.toHaveBeenCalled();
    expect(useDatasetStore.getState().queryResult?.rows).toEqual([{ id: 2 }]);
  });

  it('refreshActiveQueryTemplate should skip snapshot refresh for the default live template', async () => {
    useDatasetStore.setState({
      activeQueryTemplate: {
        id: 'default_tpl',
        datasetId: 'ds1',
        queryConfig: {},
        isDefault: true,
      },
      pageSize: 20,
    });

    await useDatasetStore.getState().refreshActiveQueryTemplate('ds1');

    expect(mockQueryTemplateRefresh).not.toHaveBeenCalled();
    expect(mockQueryTemplateQuery).toHaveBeenCalledWith('default_tpl', 0, 20);
    expect(mockQueryTemplateUpdate).not.toHaveBeenCalled();
    expect(mockDuckdbQueryDataset).not.toHaveBeenCalled();
    expect(useDatasetStore.getState().queryResult?.rows).toEqual([{ id: 2 }]);
  });

  it('refreshDatasetView should reload schema and refresh the current result set', async () => {
    useDatasetStore.setState({
      pageSize: 20,
    });

    await useDatasetStore.getState().refreshDatasetView('ds1');

    expect(mockDuckdbGetDatasetInfo).toHaveBeenCalledWith('ds1');
    expect(mockDuckdbQueryDataset).toHaveBeenCalledWith('ds1', undefined, 0, 20);
    expect(useDatasetStore.getState().currentDataset?.id).toBe('ds1');
    expect(useDatasetStore.getState().queryResult?.rows).toEqual([{ id: 1 }]);
  });

  it('loadMoreData should page via queryTemplate.query when active query template is set', async () => {
    useDatasetStore.setState({
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
      queryResult: {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
        filteredTotalCount: 3,
      },
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 10,
        columnCount: 1,
        sizeBytes: 0,
        createdAt: Date.now(),
      },
      currentOffset: 1,
      pageSize: 2,
      hasMore: true,
      loading: false,
      loadingMore: false,
    });

    mockQueryTemplateQuery.mockResolvedValue({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 2 }],
        rowCount: 1,
        filteredTotalCount: 3,
      },
    });

    await useDatasetStore.getState().loadMoreData('ds1');

    const state = useDatasetStore.getState();
    expect(mockQueryTemplateQuery).toHaveBeenCalledWith('tpl_1', 1, 2);
    expect(mockDuckdbQueryDataset).not.toHaveBeenCalled();
    expect(state.queryResult?.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(state.queryResult?.filteredTotalCount).toBe(3);
    expect(state.hasMore).toBe(true);
  });

  it('loadMoreData should prefer queryTemplate alias when available', async () => {
    const localMockQueryTemplateQuery = vi.fn().mockResolvedValue({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 3 }],
        rowCount: 1,
        filteredTotalCount: 3,
      },
    });

    (globalThis as any).window.electronAPI.queryTemplate = {
      query: localMockQueryTemplateQuery,
      refresh: mockQueryTemplateRefresh,
      update: mockQueryTemplateUpdate,
      get: mockQueryTemplateGet,
      getOrCreateDefault: mockQueryTemplateGetOrCreateDefault,
      create: mockQueryTemplateCreate,
      list: mockQueryTemplateList,
      delete: mockQueryTemplateDelete,
      reorder: mockQueryTemplateReorder,
    };

    useDatasetStore.setState({
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
      queryResult: {
        columns: ['id'],
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: 2,
        filteredTotalCount: 3,
      },
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 10,
        columnCount: 1,
        sizeBytes: 0,
        createdAt: Date.now(),
      },
      currentOffset: 2,
      pageSize: 2,
      hasMore: true,
      loading: false,
      loadingMore: false,
    });

    await useDatasetStore.getState().loadMoreData('ds1');

    expect(localMockQueryTemplateQuery).toHaveBeenCalledWith('tpl_1', 2, 2);
  });

  it('updateActiveQueryTemplate should call queryTemplate.update with templateId', async () => {
    const localMockQueryTemplateUpdate = vi.fn().mockResolvedValue({ success: true });
    const localMockQueryTemplateGet = vi.fn().mockResolvedValue({
      success: true,
      template: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {},
      },
    });
    const localMockQueryTemplateQuery = vi.fn().mockResolvedValue({
      success: true,
      result: { columns: ['id'], rows: [], rowCount: 0 },
    });

    (globalThis as any).window.electronAPI.queryTemplate = {
      update: localMockQueryTemplateUpdate,
      get: localMockQueryTemplateGet,
      query: localMockQueryTemplateQuery,
      refresh: mockQueryTemplateRefresh,
      getOrCreateDefault: mockQueryTemplateGetOrCreateDefault,
      create: mockQueryTemplateCreate,
      list: mockQueryTemplateList,
      delete: mockQueryTemplateDelete,
      reorder: mockQueryTemplateReorder,
    };

    useDatasetStore.setState({
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
    });

    await useDatasetStore.getState().updateActiveQueryTemplate('ds1', { filter: undefined });

    expect(localMockQueryTemplateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'tpl_1',
      })
    );
  });

  it('createQueryTemplateFromConfig should generate SQL before creating the template', async () => {
    const mockPreviewQuerySQL = vi.fn().mockResolvedValue({
      success: true,
      sql: 'SELECT * FROM data LIMIT 50',
    });

    (globalThis as any).window.electronAPI.duckdb.previewQuerySQL = mockPreviewQuerySQL;

    const templateId = await useDatasetStore.getState().createQueryTemplateFromConfig({
      datasetId: 'ds1',
      name: 'Template 1',
      queryConfig: {},
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

  it('loadMoreData should page via duckdb.queryDataset when no active query template', async () => {
    useDatasetStore.setState({
      activeQueryTemplate: null,
      queryResult: {
        columns: ['id'],
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: 2,
      },
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 4,
        columnCount: 1,
        sizeBytes: 0,
        createdAt: Date.now(),
      },
      currentOffset: 2,
      pageSize: 2,
      hasMore: true,
      loading: false,
      loadingMore: false,
    });

    mockDuckdbQueryDataset.mockResolvedValue({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 3 }, { id: 4 }],
        rowCount: 2,
      },
    });

    await useDatasetStore.getState().loadMoreData('ds1');

    const state = useDatasetStore.getState();
    expect(mockDuckdbQueryDataset).toHaveBeenCalledWith('ds1', undefined, 2, 2);
    expect(mockQueryTemplateQuery).not.toHaveBeenCalled();
    expect(state.queryResult?.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(state.hasMore).toBe(false);
  });

  it('applyQueryTemplate should set activeQueryTemplate and keep query result in sync', async () => {
    const localMockQueryTemplateGet = vi.fn().mockResolvedValue({
      success: true,
      template: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {},
      },
    });
    const localMockQueryTemplateQuery = vi.fn().mockResolvedValue({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
      },
    });

    (globalThis as any).window.electronAPI.queryTemplate = {
      get: localMockQueryTemplateGet,
      query: localMockQueryTemplateQuery,
      refresh: mockQueryTemplateRefresh,
      update: mockQueryTemplateUpdate,
      getOrCreateDefault: mockQueryTemplateGetOrCreateDefault,
      create: mockQueryTemplateCreate,
      list: mockQueryTemplateList,
      delete: mockQueryTemplateDelete,
      reorder: mockQueryTemplateReorder,
    };

    useDatasetStore.setState({
      activeQueryTemplate: null,
      pageSize: 50,
    });

    await useDatasetStore.getState().applyQueryTemplate('tpl_1');

    const state = useDatasetStore.getState();
    expect(state.activeQueryTemplate).toMatchObject({
      id: 'tpl_1',
      datasetId: 'ds1',
    });
    expect(state.queryResult?.rows).toEqual([{ id: 1 }]);
  });

  it('loadGroupTabs should hydrate group tab state and select current dataset tab', async () => {
    mockDuckdbListGroupTabs.mockResolvedValue({
      success: true,
      tabs: [
        {
          datasetId: 'ds2',
          tabGroupId: 'grp1',
          name: 'Dataset 2',
          rowCount: 8,
          columnCount: 2,
          tabOrder: 1,
          isGroupDefault: false,
        },
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
    });

    await useDatasetStore.getState().loadGroupTabs('ds1');

    const state = useDatasetStore.getState();
    expect(state.currentGroupId).toBe('grp1');
    expect(state.groupTabs.map((tab) => tab.datasetId)).toEqual(['ds1', 'ds2']);
    expect(state.selectedTabDatasetId).toBe('ds1');
  });

  it('loadGroupTabs should clear group tab state when API returns empty tabs', async () => {
    useDatasetStore.setState({
      currentGroupId: 'grp_prev',
      groupTabs: [
        {
          datasetId: 'ds_prev',
          tabGroupId: 'grp_prev',
          name: 'Prev Dataset',
          rowCount: 1,
          columnCount: 1,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
      selectedTabDatasetId: 'ds_prev',
      error: null,
    });

    mockDuckdbListGroupTabs.mockResolvedValue({
      success: true,
      tabs: [],
    });

    await useDatasetStore.getState().loadGroupTabs('ds1');

    const state = useDatasetStore.getState();
    expect(state.currentGroupId).toBeNull();
    expect(state.groupTabs).toEqual([]);
    expect(state.selectedTabDatasetId).toBeNull();
    expect(state.error).toBeNull();
  });

  it('loadGroupTabs should clear group tab state when API throws', async () => {
    useDatasetStore.setState({
      currentGroupId: 'grp_prev',
      groupTabs: [
        {
          datasetId: 'ds_prev',
          tabGroupId: 'grp_prev',
          name: 'Prev Dataset',
          rowCount: 1,
          columnCount: 1,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
      selectedTabDatasetId: 'ds_prev',
      error: null,
    });

    mockDuckdbListGroupTabs.mockRejectedValue(new Error('list tabs failed'));

    await useDatasetStore.getState().loadGroupTabs('ds1');

    const state = useDatasetStore.getState();
    expect(state.currentGroupId).toBeNull();
    expect(state.groupTabs).toEqual([]);
    expect(state.selectedTabDatasetId).toBeNull();
    expect(state.error).toContain('list tabs failed');
  });

  it('selectGroupTab and clearGroupTabs should update and reset group tab state', () => {
    useDatasetStore.getState().setGroupTabs([
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
        name: 'Dataset 2',
        rowCount: 8,
        columnCount: 2,
        tabOrder: 1,
        isGroupDefault: false,
      },
    ]);

    useDatasetStore.getState().selectGroupTab('ds2');
    expect(useDatasetStore.getState().selectedTabDatasetId).toBe('ds2');

    useDatasetStore.getState().clearGroupTabs();
    const state = useDatasetStore.getState();
    expect(state.currentGroupId).toBeNull();
    expect(state.groupTabs).toEqual([]);
    expect(state.selectedTabDatasetId).toBeNull();
  });

  it('workspace selection should not eagerly change selected group tab', () => {
    useDatasetStore.setState({
      selectedTabDatasetId: 'ds_prev',
    });

    useDatasetStore.getState().selectWorkspaceTable('table_ds1');
    expect(useDatasetStore.getState().selectedTableId).toBe('table_ds1');
    expect(useDatasetStore.getState().selectedTabDatasetId).toBe('ds_prev');

    useDatasetStore.getState().selectWorkspaceDataset('ds2');
    expect(useDatasetStore.getState().selectedTableId).toBe('table_ds2');
    expect(useDatasetStore.getState().selectedTabDatasetId).toBe('ds_prev');
  });

  it('resetWorkspaceViewState should clear workspace-only state', () => {
    useDatasetStore.setState({
      workspaceCategories: [
        {
          id: 'folder-1',
          name: 'Folder 1',
          isFolder: true,
          tables: [],
        },
      ],
      selectedCategory: 'folder-1',
      selectedTableId: 'table_ds1',
      isAnalyzingTypes: true,
    });

    useDatasetStore.getState().resetWorkspaceViewState();

    const state = useDatasetStore.getState();
    expect(state.workspaceCategories).toEqual([]);
    expect(state.selectedCategory).toBeNull();
    expect(state.selectedTableId).toBeNull();
    expect(state.isAnalyzingTypes).toBe(false);
  });

  it('getDatasetInfo should ignore stale responses from previous dataset switches', async () => {
    let resolveFirst: ((value: any) => void) | undefined;
    let resolveSecond: ((value: any) => void) | undefined;

    mockDuckdbGetDatasetInfo.mockImplementation((datasetId: string) => {
      return new Promise((resolve) => {
        if (datasetId === 'ds1') {
          resolveFirst = resolve;
        } else {
          resolveSecond = resolve;
        }
      });
    });

    const firstRequest = useDatasetStore.getState().getDatasetInfo('ds1');
    const secondRequest = useDatasetStore.getState().getDatasetInfo('ds2');

    resolveSecond?.({
      success: true,
      dataset: {
        id: 'ds2',
        name: 'Dataset 2',
        rowCount: 1,
        columnCount: 1,
        sizeBytes: 0,
        createdAt: Date.now(),
        schema: [],
      },
    });
    await secondRequest;

    resolveFirst?.({
      success: true,
      dataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 1,
        columnCount: 1,
        sizeBytes: 0,
        createdAt: Date.now(),
        schema: [],
      },
    });
    await firstRequest;

    const state = useDatasetStore.getState();
    expect(state.currentDataset?.id).toBe('ds2');
    expect(state.error).toBeNull();
  });

  it('queryDataset should ignore stale results after switching to another dataset', async () => {
    let resolveFirst: ((value: any) => void) | undefined;
    let resolveSecond: ((value: any) => void) | undefined;

    mockDuckdbQueryDataset.mockImplementation((datasetId: string, _filters, offset = 0) => {
      return new Promise((resolve) => {
        if (datasetId === 'ds1' && offset === 0) {
          resolveFirst = resolve;
        } else {
          resolveSecond = resolve;
        }
      });
    });

    const firstQuery = useDatasetStore.getState().queryDataset('ds1');
    const secondQuery = useDatasetStore.getState().queryDataset('ds2');

    resolveSecond?.({
      success: true,
      result: { columns: ['id'], rows: [{ id: 'ds2-row' }], rowCount: 1 },
    });
    await secondQuery;

    resolveFirst?.({
      success: true,
      result: { columns: ['id'], rows: [{ id: 'ds1-row' }], rowCount: 1 },
    });
    await firstQuery;

    const state = useDatasetStore.getState();
    expect(state.activeQueryDatasetId).toBe('ds2');
    expect(state.queryResult?.rows).toEqual([{ id: 'ds2-row' }]);
  });

  it('loadMoreData should ignore late pages from an invalidated query session', async () => {
    useDatasetStore.setState({ pageSize: 1 });

    const resolvers = new Map<string, (value: any) => void>();
    mockDuckdbQueryDataset.mockImplementation((datasetId: string, _filters, offset = 0) => {
      return new Promise((resolve) => {
        resolvers.set(`${datasetId}:${offset}`, resolve);
      });
    });

    const initialQuery = useDatasetStore.getState().queryDataset('ds1');
    resolvers.get('ds1:0')?.({
      success: true,
      result: { columns: ['id'], rows: [{ id: 'ds1-row-1' }], rowCount: 1 },
    });
    await initialQuery;

    const loadMorePromise = useDatasetStore.getState().loadMoreData('ds1');
    const switchQuery = useDatasetStore.getState().queryDataset('ds2');

    resolvers.get('ds2:0')?.({
      success: true,
      result: { columns: ['id'], rows: [{ id: 'ds2-row-1' }], rowCount: 1 },
    });
    await switchQuery;

    resolvers.get('ds1:1')?.({
      success: true,
      result: { columns: ['id'], rows: [{ id: 'ds1-row-2' }], rowCount: 1 },
    });
    await loadMorePromise;

    const state = useDatasetStore.getState();
    expect(state.activeQueryDatasetId).toBe('ds2');
    expect(state.queryResult?.rows).toEqual([{ id: 'ds2-row-1' }]);
  });

  it('cancelQuery should invalidate the active session so late responses do not land', async () => {
    let resolveQuery: ((value: any) => void) | undefined;

    mockDuckdbQueryDataset.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveQuery = resolve;
      });
    });

    const queryPromise = useDatasetStore.getState().queryDataset('ds1');
    useDatasetStore.getState().cancelQuery('ds1');

    resolveQuery?.({
      success: true,
      result: { columns: ['id'], rows: [{ id: 'late-row' }], rowCount: 1 },
    });
    await queryPromise;

    const state = useDatasetStore.getState();
    expect(state.activeQueryDatasetId).toBeNull();
    expect(state.queryResult).toBeNull();
    expect(state.dataReady).toBe(false);
  });

  it('applyLocalRecordInsert should append an optimistic row and update counts for plain dataset views', () => {
    useDatasetStore.setState({
      datasets: [
        {
          id: 'ds1',
          name: 'Dataset 1',
          rowCount: 1,
          columnCount: 2,
          sizeBytes: 0,
          createdAt: Date.now(),
        },
      ],
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 1,
        columnCount: 2,
        sizeBytes: 0,
        createdAt: Date.now(),
      },
      queryResult: {
        columns: ['_row_id', 'name'],
        rows: [{ _row_id: 1, name: 'row-1' }],
        rowCount: 1,
      },
      activeQueryDatasetId: 'ds1',
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
      currentOffset: 1,
      pageSize: 50,
      hasMore: false,
      groupTabs: [
        {
          datasetId: 'ds1',
          tabGroupId: 'grp1',
          name: 'Dataset 1',
          rowCount: 1,
          columnCount: 2,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
    });

    const result = useDatasetStore.getState().applyLocalRecordInsert('ds1', { name: 'row-2' });
    const state = useDatasetStore.getState();

    expect(result).toEqual({ rowAppended: true, countUpdated: true });
    expect(state.queryResult?.rows).toHaveLength(2);
    expect(state.queryResult?.rows[1]).toEqual(
      expect.objectContaining({
        name: 'row-2',
      })
    );
    expect(Number((state.queryResult?.rows[1] as any)._row_id)).toBeLessThan(0);
    expect(state.currentDataset?.rowCount).toBe(2);
    expect(state.datasets.find((dataset) => dataset.id === 'ds1')?.rowCount).toBe(2);
    expect(state.groupTabs[0]?.rowCount).toBe(2);
  });

  it('applyLocalRecordUpdate should patch visible rows without a full refresh in plain dataset views', () => {
    useDatasetStore.setState({
      queryResult: {
        columns: ['_row_id', 'name'],
        rows: [
          { _row_id: 1, name: 'before' },
          { _row_id: 2, name: 'keep' },
        ],
        rowCount: 2,
      },
      activeQueryDatasetId: 'ds1',
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
    });

    const applied = useDatasetStore.getState().applyLocalRecordUpdate('ds1', 1, {
      name: 'after',
    });

    expect(applied).toBe(true);
    expect(useDatasetStore.getState().queryResult?.rows).toEqual([
      { _row_id: 1, name: 'after' },
      { _row_id: 2, name: 'keep' },
    ]);
  });

  it('applyLocalRecordDeletion should remove visible rows and decrement counts', () => {
    useDatasetStore.setState({
      datasets: [
        {
          id: 'ds1',
          name: 'Dataset 1',
          rowCount: 2,
          columnCount: 2,
          sizeBytes: 0,
          createdAt: Date.now(),
        },
      ],
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 2,
        columnCount: 2,
        sizeBytes: 0,
        createdAt: Date.now(),
      },
      queryResult: {
        columns: ['_row_id', 'name'],
        rows: [
          { _row_id: 1, name: 'delete-me' },
          { _row_id: 2, name: 'keep' },
        ],
        rowCount: 2,
      },
      activeQueryDatasetId: 'ds1',
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
      currentOffset: 2,
      hasMore: false,
      groupTabs: [
        {
          datasetId: 'ds1',
          tabGroupId: 'grp1',
          name: 'Dataset 1',
          rowCount: 2,
          columnCount: 2,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
    });

    const applied = useDatasetStore.getState().applyLocalRecordDeletion('ds1', [1], {
      deletedCount: 1,
    });
    const state = useDatasetStore.getState();

    expect(applied).toBe(true);
    expect(state.queryResult?.rows).toEqual([{ _row_id: 2, name: 'keep' }]);
    expect(state.currentDataset?.rowCount).toBe(1);
    expect(state.datasets.find((dataset) => dataset.id === 'ds1')?.rowCount).toBe(1);
    expect(state.groupTabs[0]?.rowCount).toBe(1);
  });

  it('applyLocalRecordUpdate should refuse local patching when query processing is active', () => {
    useDatasetStore.setState({
      queryResult: {
        columns: ['_row_id', 'name'],
        rows: [{ _row_id: 1, name: 'before' }],
        rowCount: 1,
      },
      activeQueryDatasetId: 'ds1',
      activeQueryTemplate: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {
          filter: {
            combinator: 'AND',
            conditions: [{ type: 'equal', field: 'name', value: 'before' }],
          },
        },
      },
    });

    const applied = useDatasetStore.getState().applyLocalRecordUpdate('ds1', 1, {
      name: 'after',
    });

    expect(applied).toBe(false);
    expect(useDatasetStore.getState().queryResult?.rows).toEqual([{ _row_id: 1, name: 'before' }]);
  });

  it('applyLocalDatasetCountDelta should update metadata counts without mutating query rows', () => {
    useDatasetStore.setState({
      datasets: [
        {
          id: 'ds1',
          name: 'Dataset 1',
          rowCount: 10,
          columnCount: 2,
          sizeBytes: 0,
          createdAt: Date.now(),
        },
      ],
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 10,
        columnCount: 2,
        sizeBytes: 0,
        createdAt: Date.now(),
      },
      queryResult: {
        columns: ['_row_id', 'name'],
        rows: [
          { _row_id: 1, name: 'keep-visible-1' },
          { _row_id: 2, name: 'keep-visible-2' },
        ],
        rowCount: 2,
        filteredTotalCount: 6,
      },
      activeQueryDatasetId: 'ds1',
      activeQueryTemplate: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {
          filter: {
            combinator: 'AND',
            conditions: [{ type: 'equal', field: 'name', value: 'keep-visible-1' }],
          },
        },
      },
      currentOffset: 2,
      hasMore: true,
      groupTabs: [
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
    });

    const updated = useDatasetStore.getState().applyLocalDatasetCountDelta('ds1', -3);
    const state = useDatasetStore.getState();

    expect(updated).toBe(true);
    expect(state.currentDataset?.rowCount).toBe(7);
    expect(state.datasets.find((dataset) => dataset.id === 'ds1')?.rowCount).toBe(7);
    expect(state.groupTabs[0]?.rowCount).toBe(7);
    expect(state.queryResult?.rows).toEqual([
      { _row_id: 1, name: 'keep-visible-1' },
      { _row_id: 2, name: 'keep-visible-2' },
    ]);
    expect(state.queryResult?.filteredTotalCount).toBe(6);
    expect(state.currentOffset).toBe(2);
    expect(state.hasMore).toBe(true);
  });

  it('applyLocalDatasetSchema should update schema metadata and mark the next schema refresh as local', () => {
    useDatasetStore.setState({
      datasets: [
        {
          id: 'ds1',
          name: 'Dataset 1',
          rowCount: 10,
          columnCount: 2,
          sizeBytes: 0,
          createdAt: Date.now(),
        },
      ],
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 10,
        columnCount: 2,
        sizeBytes: 0,
        createdAt: Date.now(),
        schema: [
          { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
          { name: 'amount', duckdbType: 'DOUBLE', fieldType: 'number', nullable: true },
        ],
      },
      groupTabs: [
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
    });

    const applied = useDatasetStore.getState().applyLocalDatasetSchema('ds1', [
      { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      { name: 'amount', duckdbType: 'DOUBLE', fieldType: 'number', nullable: true },
      { name: 'email_clean', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
    ]);
    const state = useDatasetStore.getState();

    expect(applied).toBe(true);
    expect(state.currentDataset?.columnCount).toBe(3);
    expect(state.currentDataset?.schema?.map((column) => column.name)).toEqual([
      'name',
      'amount',
      'email_clean',
    ]);
    expect(state.datasets.find((dataset) => dataset.id === 'ds1')?.columnCount).toBe(3);
    expect(state.groupTabs[0]?.columnCount).toBe(3);
    expect(useDatasetStore.getState().consumePendingLocalSchemaRefresh('ds1')).toBe(true);
    expect(useDatasetStore.getState().consumePendingLocalSchemaRefresh('ds1')).toBe(false);
  });

  it('deleteDataset should clear active dataset view state when deleting the current dataset', async () => {
    useDatasetStore.setState({
      datasets: [
        {
          id: 'ds1',
          name: 'Dataset 1',
          rowCount: 10,
          columnCount: 2,
          sizeBytes: 0,
          createdAt: Date.now(),
        },
        {
          id: 'ds2',
          name: 'Dataset 2',
          rowCount: 8,
          columnCount: 2,
          sizeBytes: 0,
          createdAt: Date.now(),
        },
      ],
      currentDataset: {
        id: 'ds1',
        name: 'Dataset 1',
        rowCount: 10,
        columnCount: 2,
        sizeBytes: 0,
        createdAt: Date.now(),
      },
      queryResult: {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
      },
      activeQueryTemplate: { id: 'tpl_1', datasetId: 'ds1', queryConfig: {} },
      activeQueryDatasetId: 'ds1',
      currentOffset: 50,
      hasMore: false,
      dataReady: true,
      currentGroupId: 'grp1',
      groupTabs: [
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
          name: 'Dataset 2',
          rowCount: 8,
          columnCount: 2,
          tabOrder: 1,
          isGroupDefault: false,
        },
      ],
      selectedTabDatasetId: 'ds1',
    });

    const deleted = await useDatasetStore.getState().deleteDataset('ds1');

    const state = useDatasetStore.getState();
    expect(deleted).toBe(true);
    expect(mockDuckdbDeleteDataset).toHaveBeenCalledWith('ds1');
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(['ds2']);
    expect(state.currentDataset).toBeNull();
    expect(state.queryResult).toBeNull();
    expect(state.currentOffset).toBe(0);
    expect(state.hasMore).toBe(true);
    expect(state.dataReady).toBe(false);
    expect(state.activeQueryTemplate).toBeNull();
    expect(state.activeQueryDatasetId).toBeNull();
    expect(state.groupTabs.map((tab) => tab.datasetId)).toEqual(['ds2']);
    expect(state.selectedTabDatasetId).toBe('ds2');
  });
});
