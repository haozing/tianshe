/**
 * 数据集状态管理 Store
 * 使用 Zustand 管理 DuckDB 数据集的全局状态
 */

import { create } from 'zustand';
import type { QueryConfig } from '../../../core/query-engine/types';
import type { DatasetCategory } from '../components/DatasetsPage/types';
import { datasetFacade } from '../services/datasets/datasetFacade';
import { datasetEvents } from '../services/datasets/datasetEvents';
import {
  getDatasetIdFromTableId,
  syncWorkspaceCategoryMetadata as syncWorkspaceCategoriesWithDatasets,
  toTableId,
  type DatasetMeta,
  type WorkspaceSnapshot,
  shouldShowInSidebar,
} from '../services/datasets/workspaceCategoryService';
import { normalizeRuntimeSQL } from '../../../utils/query-runtime';

let datasetInfoRequestSerial = 0;
let querySessionSerial = 0;
let optimisticRowIdSerial = -1;
const pendingLocalSchemaRefreshDatasets = new Set<string>();

const nextOptimisticRowId = () => optimisticRowIdSerial--;

const hasComplexQueryConfig = (config?: QueryConfig) =>
  !!(
    (config?.filter?.conditions?.length ?? 0) > 0 ||
    (config?.sort?.columns?.length ?? 0) > 0 ||
    config?.sort?.pagination ||
    config?.sort?.topK ||
    (config?.clean?.length ?? 0) > 0 ||
    (config?.lookup?.length ?? 0) > 0 ||
    config?.dedupe ||
    config?.group ||
    config?.aggregate ||
    config?.sample ||
    config?.columns
  );

interface QueryTemplateApi {
  create: (params: {
    datasetId: string;
    name: string;
    description?: string;
    icon?: string;
    queryConfig: any;
    generatedSQL: string;
  }) => Promise<{ success: boolean; templateId?: string; error?: string }>;
  list: (datasetId: string) => Promise<{ success: boolean; templates?: any[]; error?: string }>;
  get: (templateId: string) => Promise<{
    success: boolean;
    template?: any;
    error?: string;
  }>;
  update: (params: {
    templateId: string;
    name?: string;
    description?: string;
    icon?: string;
    queryConfig?: any;
    generatedSQL?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  refresh: (templateId: string) => Promise<{ success: boolean; error?: string }>;
  delete: (templateId: string) => Promise<{ success: boolean; error?: string }>;
  reorder: (
    datasetId: string,
    templateIds: string[]
  ) => Promise<{ success: boolean; error?: string }>;
  query: (
    templateId: string,
    offset?: number,
    limit?: number
  ) => Promise<{
    success: boolean;
    result?: any;
    error?: string;
  }>;
  getOrCreateDefault: (datasetId: string) => Promise<{
    success: boolean;
    template?: any;
    error?: string;
  }>;
}

// 统一 queryTemplate 语义（templateId/template/templates）
const getQueryTemplateApi = (): QueryTemplateApi => {
  const queryTemplateApi = window.electronAPI.queryTemplate as any;
  const ensureMethod = (methodName: string, fn: any) => {
    if (typeof fn !== 'function') {
      throw new Error(`queryTemplate.${methodName} is not available`);
    }
    return fn as (...args: any[]) => Promise<any>;
  };

  return {
    create: async (params) => {
      return await ensureMethod('create', queryTemplateApi?.create)(params);
    },
    list: async (datasetId) => {
      return await ensureMethod('list', queryTemplateApi?.list)(datasetId);
    },
    get: async (templateId) => {
      return await ensureMethod('get', queryTemplateApi?.get)(templateId);
    },
    update: async (params) => {
      return await ensureMethod('update', queryTemplateApi?.update)(params);
    },
    refresh: async (templateId) => {
      return await ensureMethod('refresh', queryTemplateApi?.refresh)(templateId);
    },
    delete: async (templateId) => {
      return await ensureMethod('delete', queryTemplateApi?.delete)(templateId);
    },
    reorder: async (datasetId, templateIds) => {
      return await ensureMethod('reorder', queryTemplateApi?.reorder)(datasetId, templateIds);
    },
    query: async (templateId, offset, limit) => {
      return await ensureMethod('query', queryTemplateApi?.query)(templateId, offset, limit);
    },
    getOrCreateDefault: async (datasetId) => {
      return await ensureMethod(
        'getOrCreateDefault',
        queryTemplateApi?.getOrCreateDefault
      )(datasetId);
    },
  };
};

const getActiveQueryTemplateFromState = (state: { activeQueryTemplate: any | null }) =>
  state.activeQueryTemplate;

const bindActiveQueryTemplateState = (template: any | null) =>
  template === null
    ? {
        activeQueryTemplate: null,
      }
    : {
        activeQueryTemplate: template,
      };

interface DatasetInfo {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  sizeBytes: number;
  createdAt: number;
  lastQueriedAt?: number;
  schema?: Array<{
    name: string;
    duckdbType: string; // 与后端保持一致
    fieldType?: string;
    nullable?: boolean;
    metadata?: any;
    storageMode?: string;
    computeConfig?: any;
    validationRules?: any[];
    displayConfig?: {
      width?: number;
      frozen?: boolean;
      order?: number;
      hidden?: boolean;
      pinned?: 'left' | 'right';
    };
  }>;
  folderId?: string | null; // 所属文件夹ID
  tableOrder?: number; // 文件夹内的排序
  tabGroupId?: string | null;
  tabOrder?: number;
  isGroupDefault?: boolean;
}

type DatasetSchemaColumn = NonNullable<DatasetInfo['schema']>[number];

interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  filteredTotalCount?: number; // 筛选后的总行数（当有筛选条件时）
}

interface ImportProgress {
  datasetId: string;
  status: 'pending' | 'importing' | 'completed' | 'failed';
  progress: number;
  rowsProcessed?: number;
  error?: string;
  message?: string;
}

export interface GroupTabInfo {
  datasetId: string;
  tabGroupId: string;
  name: string;
  rowCount: number;
  columnCount: number;
  tabOrder: number;
  isGroupDefault: boolean;
}

interface DatasetStore {
  // 状态
  datasets: DatasetInfo[];
  currentDataset: DatasetInfo | null;
  queryResult: QueryResult | null;
  importProgress: Map<string, ImportProgress>;
  processedImports: Set<string>; // 已处理的导入（防止重复类型分析）
  datasetInfoRequestId: number;
  activeQuerySessionId: number;
  activeQueryDatasetId: string | null;
  loading: boolean;
  loadingMore: boolean; // 加载更多数据时的状态
  error: string | null;
  hasMore: boolean; // 是否还有更多数据可以加载
  currentOffset: number; // 当前加载的偏移量
  pageSize: number; // 每页加载的数据量
  // ✅ 已删除所有 active*Config - 改为使用持久化的查询模板

  // 查询模板状态（当前激活模板）
  activeQueryTemplate: any | null; // 新语义字段
  dataReady: boolean; // 当前数据是否已完成加载

  // 内容区 Tab 组状态（同组多表）
  currentGroupId: string | null;
  groupTabs: GroupTabInfo[];
  selectedTabDatasetId: string | null;
  workspaceCategories: DatasetCategory[];
  selectedCategory: string | null;
  selectedTableId: string | null;
  isAnalyzingTypes: boolean;

  // 数据集操作
  loadDatasets: () => Promise<void>;
  getDatasetInfo: (id: string) => Promise<void>;
  refreshDatasetView: (id: string, options?: { refreshSchema?: boolean }) => Promise<void>;
  queryDataset: (id: string) => Promise<void>;
  loadMoreData: (id: string) => Promise<void>; // 加载更多数据
  cancelQuery: (id: string) => void; // 取消查询
  deleteDataset: (id: string) => Promise<boolean>;
  renameDataset: (id: string, newName: string) => Promise<boolean>;

  // CSV 导入
  importDatasetFile: (
    filePath: string,
    name: string,
    options?: Parameters<typeof datasetFacade.importDatasetFile>[2]
  ) => Promise<string>;
  cancelImport: (datasetId: string) => Promise<void>;
  updateImportProgress: (progress: ImportProgress) => void;
  applyLocalDatasetSchema: (datasetId: string, schema: DatasetSchemaColumn[]) => boolean;
  consumePendingLocalSchemaRefresh: (datasetId: string) => boolean;
  applyLocalDatasetCountDelta: (datasetId: string, delta: number) => boolean;
  applyLocalRecordInsert: (
    datasetId: string,
    record: Record<string, unknown>,
    options?: { insertedCount?: number }
  ) => { rowAppended: boolean; countUpdated: boolean };
  applyLocalRecordUpdate: (
    datasetId: string,
    rowId: number,
    updates: Record<string, unknown>
  ) => boolean;
  applyLocalRecordDeletion: (
    datasetId: string,
    rowIds: number[],
    options?: { deletedCount?: number }
  ) => boolean;
  markImportAsProcessed: (datasetId: string) => void; // 标记导入已处理
  isImportProcessed: (datasetId: string) => boolean; // 检查导入是否已处理

  // 查询模板管理
  createQueryTemplate: (params: {
    datasetId: string;
    name: string;
    description?: string;
    icon?: string;
    queryConfig: any;
    generatedSQL: string;
  }) => Promise<string | null>;
  createQueryTemplateFromConfig: (params: {
    datasetId: string;
    name: string;
    description?: string;
    icon?: string;
    queryConfig: QueryConfig;
  }) => Promise<string | null>;
  applyQueryTemplate: (templateId: string) => Promise<void>;
  refreshActiveQueryTemplate: (datasetId: string) => Promise<void>;
  resetQueryTemplateState: () => void;
  loadGroupTabs: (datasetId: string) => Promise<void>;
  setGroupTabs: (tabs: GroupTabInfo[]) => void;
  selectGroupTab: (datasetId: string | null) => void;
  clearGroupTabs: () => void;
  setWorkspaceCategories: (categories: DatasetCategory[]) => void;
  syncWorkspaceCategoryMetadata: () => void;
  selectWorkspaceCategory: (categoryId: string | null) => void;
  selectWorkspaceTable: (tableId: string | null) => void;
  selectWorkspaceDataset: (
    datasetId: string,
    preferredCategoryId?: string | null,
    snapshot?: WorkspaceSnapshot
  ) => void;
  clearWorkspaceSelection: () => void;
  resetWorkspaceViewState: () => void;
  setWorkspaceAnalyzingTypes: (value: boolean) => void;
  reconcileWorkspaceSelection: () => void;

  // 🆕 默认查询模板方法（持久化）
  loadDefaultQueryTemplate: (datasetId: string) => Promise<void>;
  updateActiveQueryTemplate: (
    datasetId: string,
    partialConfig: Partial<QueryConfig>
  ) => Promise<void>;
  clearAllProcessing: (datasetId: string) => Promise<void>;

  // 其他 UI 状态
  setCurrentDataset: (dataset: DatasetInfo | null) => void;
  clearQueryResult: () => void;
  clearError: () => void;
}

export const useDatasetStore = create<DatasetStore>((set, get) => {
  const isLatestDatasetInfoRequest = (requestId: number) =>
    get().datasetInfoRequestId === requestId;

  const beginDatasetInfoRequest = () => {
    const requestId = ++datasetInfoRequestSerial;
    set({ datasetInfoRequestId: requestId, loading: true, error: null });
    return requestId;
  };

  const isActiveQuerySession = (sessionId: number, datasetId?: string | null) => {
    const state = get();
    if (state.activeQuerySessionId !== sessionId) {
      return false;
    }
    if (datasetId === undefined) {
      return true;
    }
    return state.activeQueryDatasetId === datasetId;
  };

  const beginQuerySession = (datasetId: string | null, extraState: Partial<DatasetStore> = {}) => {
    const sessionId = ++querySessionSerial;
    set({
      activeQuerySessionId: sessionId,
      activeQueryDatasetId: datasetId,
      loading: true,
      loadingMore: false,
      error: null,
      currentOffset: 0,
      hasMore: true,
      dataReady: false,
      ...extraState,
    });
    return sessionId;
  };

  const invalidateQuerySession = (datasetId?: string | null) => {
    const state = get();
    if (
      datasetId !== undefined &&
      state.activeQueryDatasetId !== null &&
      state.activeQueryDatasetId !== datasetId
    ) {
      return;
    }

    const sessionId = ++querySessionSerial;
    set({
      activeQuerySessionId: sessionId,
      activeQueryDatasetId: null,
      loading: false,
      loadingMore: false,
      dataReady: false,
    });
  };

  const clearGroupTabState = () => ({
    currentGroupId: null,
    groupTabs: [],
    selectedTabDatasetId: null,
  });

  const clearDatasetViewState = (extraState: Partial<DatasetStore> = {}) => ({
    activeQuerySessionId: ++querySessionSerial,
    activeQueryDatasetId: null,
    queryResult: null,
    currentOffset: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    dataReady: false,
    ...bindActiveQueryTemplateState(null),
    ...extraState,
  });

  const resolveWorkspaceCategoryIdForDataset = (
    datasetId: string,
    preferredCategoryId?: string | null,
    snapshot?: WorkspaceSnapshot
  ) => {
    const state = get();
    const activeCategories = snapshot?.categories ?? state.workspaceCategories;
    const activeDatasets = snapshot?.datasets ?? (state.datasets as DatasetMeta[]);
    const targetTableId = toTableId(datasetId);
    const categoryFromTable = activeCategories.find((category) =>
      category.tables.some((table) => table.id === targetTableId)
    );

    if (categoryFromTable) {
      return categoryFromTable.id;
    }

    if (preferredCategoryId) {
      return preferredCategoryId;
    }

    const dataset = activeDatasets.find((item) => item.id === datasetId);
    if (dataset?.folderId) {
      return dataset.folderId;
    }

    const groupDefaultDatasetId = dataset?.tabGroupId
      ? activeDatasets.find(
          (item) => item.tabGroupId === dataset.tabGroupId && item.isGroupDefault === true
        )?.id
      : null;

    return groupDefaultDatasetId || state.selectedCategory || datasetId;
  };

  const deriveHasMore = (result: QueryResult, pageSize: number) =>
    typeof result.filteredTotalCount === 'number'
      ? result.rows.length < result.filteredTotalCount
      : result.rows.length === pageSize;

  const queryTemplateSnapshotInternal = async (
    template: { id: string; datasetId: string; isDefault?: boolean },
    sessionId: number,
    options: {
      offset?: number;
      limit?: number;
      refreshSnapshot?: boolean;
    } = {}
  ): Promise<QueryResult | null> => {
    if (options.refreshSnapshot && !template.isDefault) {
      const refreshResponse = await getQueryTemplateApi().refresh(template.id);
      if (!isActiveQuerySession(sessionId, template.datasetId)) {
        return null;
      }
      if (!refreshResponse.success) {
        throw new Error(refreshResponse.error || '刷新查询模板快照失败');
      }
    }

    const queryResponse = await getQueryTemplateApi().query(
      template.id,
      options.offset,
      options.limit
    );
    if (!isActiveQuerySession(sessionId, template.datasetId)) {
      return null;
    }

    if (queryResponse.success && queryResponse.result) {
      return queryResponse.result as QueryResult;
    }

    throw new Error(queryResponse.error || '查询模板数据失败');
  };

  const canApplyLocalQueryPatch = (state: DatasetStore, datasetId: string) => {
    if (state.activeQueryDatasetId !== datasetId || !state.queryResult) {
      return false;
    }

    const activeTemplate = getActiveQueryTemplateFromState(state);
    if (!activeTemplate || activeTemplate.datasetId !== datasetId) {
      return true;
    }

    return !hasComplexQueryConfig(activeTemplate.queryConfig as QueryConfig | undefined);
  };

  const getDatasetTotalRowCount = (state: DatasetStore, datasetId: string) => {
    if (state.currentDataset?.id === datasetId) {
      return state.currentDataset.rowCount;
    }

    return state.datasets.find((dataset) => dataset.id === datasetId)?.rowCount;
  };

  const hasDatasetRowCountTargets = (state: DatasetStore, datasetId: string) =>
    state.currentDataset?.id === datasetId ||
    state.datasets.some((dataset) => dataset.id === datasetId) ||
    state.groupTabs.some((tab) => tab.datasetId === datasetId);

  const hasDatasetColumnTargets = (state: DatasetStore, datasetId: string) =>
    state.currentDataset?.id === datasetId ||
    state.datasets.some((dataset) => dataset.id === datasetId) ||
    state.groupTabs.some((tab) => tab.datasetId === datasetId);

  const applyDatasetRowCountDelta = (state: DatasetStore, datasetId: string, delta: number) => ({
    datasets: state.datasets.map((dataset) =>
      dataset.id === datasetId
        ? {
            ...dataset,
            rowCount: Math.max(0, dataset.rowCount + delta),
          }
        : dataset
    ),
    currentDataset:
      state.currentDataset?.id === datasetId
        ? {
            ...state.currentDataset,
            rowCount: Math.max(0, state.currentDataset.rowCount + delta),
          }
        : state.currentDataset,
    groupTabs: state.groupTabs.map((tab) =>
      tab.datasetId === datasetId
        ? {
            ...tab,
            rowCount: Math.max(0, tab.rowCount + delta),
          }
        : tab
    ),
  });

  const applyDatasetColumnCount = (
    state: DatasetStore,
    datasetId: string,
    columnCount: number
  ) => ({
    datasets: state.datasets.map((dataset) =>
      dataset.id === datasetId
        ? {
            ...dataset,
            columnCount,
          }
        : dataset
    ),
    currentDataset:
      state.currentDataset?.id === datasetId
        ? {
            ...state.currentDataset,
            columnCount,
          }
        : state.currentDataset,
    groupTabs: state.groupTabs.map((tab) =>
      tab.datasetId === datasetId
        ? {
            ...tab,
            columnCount,
          }
        : tab
    ),
  });

  const applyQueryTemplateInternal = async (templateId: string, sessionId: number) => {
    const templateResponse = await getQueryTemplateApi().get(templateId);
    if (!isActiveQuerySession(sessionId)) {
      return;
    }

    const template = templateResponse.template;
    if (!templateResponse.success || !template) {
      throw new Error(templateResponse.error || '查询模板不存在');
    }

    set({
      activeQueryDatasetId: template.datasetId,
      ...bindActiveQueryTemplateState(template),
    });

    const pageSize = get().pageSize;
    const result = await queryTemplateSnapshotInternal(template, sessionId, {
      offset: 0,
      limit: pageSize,
    });
    if (!result) {
      return;
    }

    set({
      activeQueryDatasetId: template.datasetId,
      ...bindActiveQueryTemplateState(template),
      queryResult: result,
      currentOffset: result.rows.length,
      hasMore: deriveHasMore(result, pageSize),
      loading: false,
      dataReady: true,
    });
  };

  const loadDefaultQueryTemplateInternal = async (datasetId: string, sessionId: number) => {
    const response = await getQueryTemplateApi().getOrCreateDefault(datasetId);
    if (!isActiveQuerySession(sessionId, datasetId)) {
      return;
    }

    const template = response.template;
    if (!response.success || !template) {
      throw new Error(response.error || 'Failed to load default query template');
    }

    set({
      activeQueryDatasetId: datasetId,
      ...bindActiveQueryTemplateState(template),
    });

    const pageSize = get().pageSize;
    const result = await queryTemplateSnapshotInternal(template, sessionId, {
      offset: 0,
      limit: pageSize,
    });
    if (!result) {
      return;
    }

    set({
      activeQueryDatasetId: datasetId,
      queryResult: result,
      currentOffset: result.rows.length,
      hasMore: deriveHasMore(result, pageSize),
      loading: false,
      dataReady: true,
    });
  };

  return {
    // 初始状态
    datasets: [],
    currentDataset: null,
    queryResult: null,
    importProgress: new Map(),
    processedImports: new Set(), // 初始化为空 Set
    datasetInfoRequestId: 0,
    activeQuerySessionId: 0,
    activeQueryDatasetId: null,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: true,
    currentOffset: 0,
    pageSize: 50, // 减少每页加载数量以提升性能
    // ✅ 删除所有 active*Config 初始化 - 改为使用查询模板状态

    // 查询模板状态初始化
    activeQueryTemplate: null,
    dataReady: false,
    currentGroupId: null,
    groupTabs: [],
    selectedTabDatasetId: null,
    workspaceCategories: [],
    selectedCategory: null,
    selectedTableId: null,
    isAnalyzingTypes: false,

    // 加载数据集列表
    loadDatasets: async () => {
      set({ loading: true, error: null });
      try {
        const response = await datasetFacade.listDatasets();
        if (response.success && response.datasets) {
          set({ datasets: response.datasets, loading: false });
        } else {
          set({ error: response.error || 'Failed to load datasets', loading: false });
        }
      } catch (error: any) {
        set({ error: error.message, loading: false });
      }
    },

    // 获取数据集详情
    getDatasetInfo: async (id: string) => {
      const requestId = beginDatasetInfoRequest();

      try {
        const response = await datasetFacade.getDatasetInfo(id);
        if (!isLatestDatasetInfoRequest(requestId)) {
          return;
        }

        if (response.success && response.dataset) {
          const dataset = response.dataset;

          // 统计有多少列缺少 fieldType
          if (dataset.schema && Array.isArray(dataset.schema)) {
            const missingFieldType = dataset.schema.filter((col) => !col.fieldType);
            if (missingFieldType.length > 0) {
              console.warn(
                `[datasetStore] ${missingFieldType.length} columns missing fieldType:`,
                missingFieldType.map((col) => col.name)
              );
            }
          } else {
            console.warn('[datasetStore] Dataset has no valid schema');
          }

          set({ currentDataset: response.dataset, loading: false });
        } else {
          console.error('[datasetStore] Failed to get dataset info:', response.error);
          set({ error: response.error || 'Dataset not found', loading: false });
        }
      } catch (error: any) {
        if (!isLatestDatasetInfoRequest(requestId)) {
          return;
        }
        console.error('[datasetStore] Exception in getDatasetInfo:', error);
        set({ error: error.message, loading: false });
      }
    },

    refreshDatasetView: async (id: string, options = {}) => {
      if (options.refreshSchema !== false) {
        await get().getDatasetInfo(id);
      }

      await get().refreshActiveQueryTemplate(id);
    },

    // 查询数据集（初始加载/刷新）
    queryDataset: async (id: string) => {
      const activeQueryTemplate = getActiveQueryTemplateFromState(get());
      const shouldUseActiveTemplate = Boolean(
        activeQueryTemplate && activeQueryTemplate.datasetId === id
      );
      const shouldClearStaleTemplate = Boolean(
        activeQueryTemplate && activeQueryTemplate.datasetId !== id
      );
      const sessionId = beginQuerySession(
        id,
        shouldClearStaleTemplate
          ? bindActiveQueryTemplateState(null)
          : shouldUseActiveTemplate
            ? bindActiveQueryTemplateState(activeQueryTemplate)
            : {}
      );

      try {
        const pageSize = get().pageSize;
        if (shouldUseActiveTemplate && activeQueryTemplate) {
          const result = await queryTemplateSnapshotInternal(activeQueryTemplate, sessionId, {
            offset: 0,
            limit: pageSize,
          });
          if (!result) {
            return;
          }

          set({
            activeQueryDatasetId: id,
            queryResult: result,
            currentOffset: result.rows.length,
            hasMore: deriveHasMore(result, pageSize),
            loading: false,
            dataReady: true,
          });
          return;
        }

        const response = await datasetFacade.queryDataset(id, undefined, 0, pageSize);
        if (!isActiveQuerySession(sessionId, id)) {
          return;
        }

        if (response.success && response.result) {
          set({
            queryResult: response.result,
            currentOffset: response.result.rows.length,
            hasMore: deriveHasMore(response.result as QueryResult, pageSize),
            loading: false,
            dataReady: true,
          });
        } else {
          set({
            error: response.error || '查询数据失败',
            loading: false,
            dataReady: false,
          });
        }
      } catch (error: any) {
        if (!isActiveQuerySession(sessionId, id)) {
          return;
        }
        set({
          error: error.message || '查询数据失败',
          loading: false,
          dataReady: false,
        });
      }
    },

    // 加载更多数据
    loadMoreData: async (id: string) => {
      const state = get();

      // 如果正在加载或没有更多数据，直接返回
      if (state.loadingMore || !state.hasMore || state.loading) {
        return;
      }

      const activeQueryTemplate = getActiveQueryTemplateFromState(state);
      const needsSessionBootstrap =
        !state.activeQuerySessionId || state.activeQueryDatasetId !== id;
      const sessionId = needsSessionBootstrap ? ++querySessionSerial : state.activeQuerySessionId;

      set({
        activeQuerySessionId: sessionId,
        activeQueryDatasetId: id,
        ...(activeQueryTemplate ? bindActiveQueryTemplateState(activeQueryTemplate) : {}),
        loading: false,
        loadingMore: true,
        error: null,
      });

      try {
        let incomingResult: QueryResult | null = null;

        if (activeQueryTemplate && activeQueryTemplate.datasetId === id) {
          incomingResult = await queryTemplateSnapshotInternal(activeQueryTemplate, sessionId, {
            offset: state.currentOffset,
            limit: state.pageSize,
          });
        } else {
          const response = await datasetFacade.queryDataset(
            id,
            undefined,
            state.currentOffset,
            state.pageSize
          );
          if (!isActiveQuerySession(sessionId, id)) {
            return;
          }
          if (!response.success || !response.result) {
            throw new Error(response.error || 'Load more failed');
          }
          incomingResult = response.result as QueryResult;
        }

        if (!isActiveQuerySession(sessionId, id)) {
          return;
        }

        if (!incomingResult) {
          return;
        }

        const currentState = get();
        const currentResult = currentState.queryResult;
        if (currentResult) {
          const newTotalRows = currentResult.rows.length + incomingResult.rows.length;
          const newOffset = currentState.currentOffset + incomingResult.rows.length;
          const mergedFilteredTotalCount =
            currentResult.filteredTotalCount ?? incomingResult.filteredTotalCount;

          // 获取数据集总行数（优先使用筛选后的总数）
          const totalRowCount = mergedFilteredTotalCount ?? currentState.currentDataset?.rowCount;

          // 判断是否还有更多数据：优先使用总行数，其次使用返回行数判断
          let hasMore: boolean;
          if (totalRowCount !== undefined && totalRowCount !== null) {
            hasMore = newTotalRows < totalRowCount;
          } else {
            hasMore = incomingResult.rows.length === currentState.pageSize;
          }

          set({
            queryResult: {
              ...currentResult,
              rows: [...currentResult.rows, ...incomingResult.rows],
              rowCount: newTotalRows,
              filteredTotalCount: mergedFilteredTotalCount,
            },
            loadingMore: false,
            currentOffset: newOffset,
            hasMore,
          });
        } else {
          set({ loadingMore: false });
        }
      } catch (error: any) {
        if (!isActiveQuerySession(sessionId, id)) {
          return;
        }
        console.error('[datasetStore] Load more error:', error);
        set({ error: error.message, loadingMore: false });
      }
    },

    // 删除数据集
    deleteDataset: async (id: string) => {
      set({ loading: true, error: null });
      try {
        const response = await datasetFacade.deleteDataset(id);
        if (response.success) {
          set((state) => ({
            ...(() => {
              const activeTemplate = getActiveQueryTemplateFromState(state);
              const deletingActiveDataset =
                state.currentDataset?.id === id ||
                state.activeQueryDatasetId === id ||
                activeTemplate?.datasetId === id;
              const remainingGroupTabs = state.groupTabs.filter((tab) => tab.datasetId !== id);
              const nextSelectedTabDatasetId =
                state.selectedTabDatasetId === id
                  ? (remainingGroupTabs.find((tab) => tab.isGroupDefault)?.datasetId ??
                    remainingGroupTabs[0]?.datasetId ??
                    null)
                  : state.selectedTabDatasetId;

              const nextGroupTabState =
                remainingGroupTabs.length > 0
                  ? {
                      currentGroupId: remainingGroupTabs[0]?.tabGroupId || null,
                      groupTabs: remainingGroupTabs,
                      selectedTabDatasetId: nextSelectedTabDatasetId,
                    }
                  : clearGroupTabState();

              return {
                datasets: state.datasets.filter((d) => d.id !== id),
                currentDataset: deletingActiveDataset
                  ? null
                  : state.currentDataset?.id === id
                    ? null
                    : state.currentDataset,
                ...(deletingActiveDataset
                  ? clearDatasetViewState()
                  : activeTemplate?.datasetId === id
                    ? bindActiveQueryTemplateState(null)
                    : {}),
                ...nextGroupTabState,
              };
            })(),
            loading: false,
          }));
          return true;
        } else {
          set({ error: response.error || 'Failed to delete dataset', loading: false });
          return false;
        }
      } catch (error: any) {
        set({ error: error.message, loading: false });
        return false;
      }
    },

    // 重命名数据集
    renameDataset: async (id: string, newName: string) => {
      set({ loading: true, error: null });
      try {
        const response = await datasetFacade.renameDataset(id, newName);
        if (response.success) {
          set((state) => ({
            datasets: state.datasets.map((d) => (d.id === id ? { ...d, name: newName } : d)),
            currentDataset:
              state.currentDataset?.id === id
                ? { ...state.currentDataset, name: newName }
                : state.currentDataset,
            loading: false,
          }));
          return true;
        } else {
          set({ error: response.error || 'Failed to rename dataset', loading: false });
          return false;
        }
      } catch (error: any) {
        set({ error: error.message, loading: false });
        return false;
      }
    },

    // 导入 CSV
    importDatasetFile: async (
      filePath: string,
      name: string,
      options?: Parameters<typeof datasetFacade.importDatasetFile>[2]
    ) => {
      set({ loading: true, error: null });
      try {
        const response = await datasetFacade.importDatasetFile(filePath, name, options);
        if (response.success && response.datasetId) {
          // 导入已启动，进度将通过事件更新
          set({ loading: false });
          return response.datasetId;
        } else {
          const errorMsg = response.error || 'Failed to start import';
          set({ error: errorMsg, loading: false });
          throw new Error(errorMsg); // 🆕 抛出错误，让调用者能够捕获
        }
      } catch (error: any) {
        const errorMsg = error.message || 'Unknown error';
        set({ error: errorMsg, loading: false });
        throw error; // 🆕 重新抛出错误，让调用者能够捕获
      }
    },

    // 取消导入
    cancelImport: async (datasetId: string) => {
      try {
        await datasetFacade.cancelImport(datasetId);
        set((state) => {
          const newProgress = new Map(state.importProgress);
          newProgress.delete(datasetId);
          return { importProgress: newProgress };
        });
      } catch (error: any) {
        console.error('[datasetStore] Failed to cancel import:', error);
      }
    },

    // 更新导入进度
    updateImportProgress: (progress: ImportProgress) => {
      set((state) => {
        const newProgress = new Map(state.importProgress);
        newProgress.set(progress.datasetId, progress);

        return { importProgress: newProgress };
      });
    },

    applyLocalDatasetCountDelta: (datasetId: string, delta: number) => {
      const normalizedDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
      let updated = false;

      set((state) => {
        updated = hasDatasetRowCountTargets(state, datasetId);
        if (!updated || normalizedDelta === 0) {
          return state;
        }

        return applyDatasetRowCountDelta(state, datasetId, normalizedDelta);
      });

      return updated;
    },

    applyLocalDatasetSchema: (datasetId: string, schema: DatasetSchemaColumn[]) => {
      const nextSchema = schema.map((column) => ({ ...column }));
      const nextColumnCount = nextSchema.length;
      let updated = false;

      set((state) => {
        const nextCounts = applyDatasetColumnCount(state, datasetId, nextColumnCount);
        const shouldUpdateCurrentDatasetSchema = state.currentDataset?.id === datasetId;
        updated = hasDatasetColumnTargets(state, datasetId);

        if (!updated) {
          return state;
        }

        if (shouldUpdateCurrentDatasetSchema) {
          pendingLocalSchemaRefreshDatasets.add(datasetId);
        }

        return {
          ...nextCounts,
          currentDataset:
            shouldUpdateCurrentDatasetSchema && nextCounts.currentDataset
              ? {
                  ...nextCounts.currentDataset,
                  schema: nextSchema,
                }
              : nextCounts.currentDataset,
        };
      });

      return updated;
    },

    consumePendingLocalSchemaRefresh: (datasetId: string) => {
      const pending = pendingLocalSchemaRefreshDatasets.has(datasetId);
      pendingLocalSchemaRefreshDatasets.delete(datasetId);
      return pending;
    },

    applyLocalRecordInsert: (datasetId: string, record: Record<string, unknown>, options = {}) => {
      const insertedCount = Math.max(1, options.insertedCount ?? 1);
      let rowAppended = false;
      let countUpdated = false;

      set((state) => {
        const nextCounts = applyDatasetRowCountDelta(state, datasetId, insertedCount);
        const currentTotal = getDatasetTotalRowCount(state, datasetId);
        countUpdated = hasDatasetRowCountTargets(state, datasetId);

        if (!canApplyLocalQueryPatch(state, datasetId) || !state.queryResult) {
          return nextCounts;
        }

        const canAppendVisibleRow =
          insertedCount === 1 && state.queryResult.rows.length < state.pageSize;
        if (!canAppendVisibleRow) {
          const nextTotal = Math.max(0, (currentTotal ?? state.currentOffset) + insertedCount);
          return {
            ...nextCounts,
            hasMore: state.currentOffset < nextTotal,
          };
        }

        rowAppended = true;
        const nextRows = [
          ...state.queryResult.rows,
          {
            _row_id: nextOptimisticRowId(),
            ...record,
          },
        ];
        const nextLoadedCount = nextRows.length;
        const nextTotal = Math.max(0, (currentTotal ?? state.currentOffset) + insertedCount);

        return {
          ...nextCounts,
          queryResult: {
            ...state.queryResult,
            rows: nextRows,
            rowCount: nextLoadedCount,
          },
          currentOffset: nextLoadedCount,
          hasMore: nextLoadedCount < nextTotal,
        };
      });

      return {
        rowAppended,
        countUpdated,
      };
    },

    applyLocalRecordUpdate: (
      datasetId: string,
      rowId: number,
      updates: Record<string, unknown>
    ) => {
      let applied = false;

      set((state) => {
        if (!canApplyLocalQueryPatch(state, datasetId) || !state.queryResult) {
          return state;
        }

        const nextRows = state.queryResult.rows.map((row) => {
          if ((row as Record<string, unknown>)._row_id !== rowId) {
            return row;
          }

          applied = true;
          return {
            ...(row as Record<string, unknown>),
            ...updates,
          };
        });

        if (!applied) {
          return state;
        }

        return {
          queryResult: {
            ...state.queryResult,
            rows: nextRows,
          },
        };
      });

      return applied;
    },

    applyLocalRecordDeletion: (datasetId: string, rowIds: number[], options = {}) => {
      const deletedCount = Math.max(0, options.deletedCount ?? rowIds.length);
      let applied = false;

      set((state) => {
        if (!canApplyLocalQueryPatch(state, datasetId) || !state.queryResult) {
          return state;
        }

        const rowIdSet = new Set(rowIds);
        const nextRows = state.queryResult.rows.filter(
          (row) => !rowIdSet.has(Number((row as Record<string, unknown>)._row_id))
        );
        const removedVisibleCount = state.queryResult.rows.length - nextRows.length;
        if (removedVisibleCount === 0) {
          return state;
        }

        applied = true;
        const nextCounts = applyDatasetRowCountDelta(state, datasetId, -deletedCount);
        const nextCurrentOffset = Math.max(0, state.currentOffset - removedVisibleCount);
        const nextTotal = Math.max(
          0,
          (getDatasetTotalRowCount(state, datasetId) ?? state.currentOffset) - deletedCount
        );

        return {
          ...nextCounts,
          queryResult: {
            ...state.queryResult,
            rows: nextRows,
            rowCount: nextRows.length,
            filteredTotalCount:
              typeof state.queryResult.filteredTotalCount === 'number'
                ? Math.max(0, state.queryResult.filteredTotalCount - deletedCount)
                : state.queryResult.filteredTotalCount,
          },
          currentOffset: nextCurrentOffset,
          hasMore: nextCurrentOffset < nextTotal,
        };
      });

      return applied;
    },

    // 设置当前数据集
    setCurrentDataset: (dataset: DatasetInfo | null) => {
      set({ currentDataset: dataset });
    },

    // 清除查询结果
    clearQueryResult: () => {
      set({
        queryResult: null,
        currentOffset: 0,
        hasMore: true,
        dataReady: false,
        // ✅ 不再清除激活查询模板 - 配置保存在数据库中
      });
    },

    // 清除错误
    clearError: () => {
      set({ error: null });
    },

    // 标记导入已处理（防止重复类型分析）
    markImportAsProcessed: (datasetId: string) => {
      set((state) => {
        const newProcessedImports = new Set(state.processedImports);
        newProcessedImports.add(datasetId);
        return { processedImports: newProcessedImports };
      });
    },

    // 检查导入是否已处理
    isImportProcessed: (datasetId: string) => {
      return get().processedImports.has(datasetId);
    },

    // ========== 查询模板管理（新增）==========

    /**
     * 创建查询模板
     */
    createQueryTemplate: async (params: {
      datasetId: string;
      name: string;
      description?: string;
      icon?: string;
      queryConfig: any;
      generatedSQL: string;
    }) => {
      try {
        const cleanedSQL = params.generatedSQL
          ? normalizeRuntimeSQL(params.generatedSQL, params.queryConfig)
          : params.generatedSQL;

        const response = await getQueryTemplateApi().create({
          ...params,
          generatedSQL: cleanedSQL,
        });

        const templateId = response.templateId;
        if (response.success && templateId) {
          return templateId;
        } else {
          console.error(`[datasetStore] Failed to create query template:`, response.error);
          set({ error: response.error || '创建查询模板失败' });
          return null;
        }
      } catch (error) {
        console.error(`[datasetStore] Error creating query template:`, error);
        set({ error: '创建查询模板失败' });
        return null;
      }
    },
    /**
     * 应用查询模板（查询模板数据）
     */
    createQueryTemplateFromConfig: async (params: {
      datasetId: string;
      name: string;
      description?: string;
      icon?: string;
      queryConfig: QueryConfig;
    }) => {
      try {
        const sqlResponse = await datasetFacade.previewQuerySQL(
          params.datasetId,
          params.queryConfig
        );

        if (!sqlResponse.success || !sqlResponse.sql) {
          const errorMessage = sqlResponse.error || 'Failed to generate query template SQL';
          set({ error: errorMessage });
          return null;
        }

        return await get().createQueryTemplate({
          ...params,
          generatedSQL: sqlResponse.sql,
        });
      } catch (error) {
        console.error(`[datasetStore] Error generating query template SQL:`, error);
        set({ error: 'Failed to create query template' });
        return null;
      }
    },
    applyQueryTemplate: async (templateId: string) => {
      const currentDatasetId =
        getActiveQueryTemplateFromState(get())?.datasetId ?? get().currentDataset?.id ?? null;
      const sessionId = beginQuerySession(currentDatasetId);

      try {
        await applyQueryTemplateInternal(templateId, sessionId);
      } catch (error) {
        if (!isActiveQuerySession(sessionId)) {
          return;
        }
        console.error('[datasetStore] Error applying query template:', error);
        set({
          error: error instanceof Error ? error.message : '应用查询模板失败',
          loading: false,
          dataReady: false,
        });
      }
    },
    refreshActiveQueryTemplate: async (datasetId: string) => {
      const state = get();
      const activeQueryTemplate = getActiveQueryTemplateFromState(state);
      if (activeQueryTemplate && activeQueryTemplate.datasetId === datasetId) {
        const sessionId = beginQuerySession(
          datasetId,
          bindActiveQueryTemplateState(activeQueryTemplate)
        );

        try {
          const result = await queryTemplateSnapshotInternal(activeQueryTemplate, sessionId, {
            offset: 0,
            limit: get().pageSize,
            refreshSnapshot: true,
          });
          if (!result) {
            return;
          }

          set({
            activeQueryDatasetId: datasetId,
            queryResult: result,
            currentOffset: result.rows.length,
            hasMore: deriveHasMore(result, get().pageSize),
            loading: false,
            dataReady: true,
          });
        } catch (error) {
          if (!isActiveQuerySession(sessionId, datasetId)) {
            return;
          }
          console.error('[datasetStore] Failed to refresh active query template:', error);
          set({
            error: error instanceof Error ? error.message : '刷新数据失败',
            loading: false,
            dataReady: false,
          });
        }
        return;
      }

      await state.queryDataset(datasetId);
    },
    resetQueryTemplateState: () => {
      set({
        ...bindActiveQueryTemplateState(null),
        dataReady: false,
        queryResult: null,
        currentOffset: 0,
        hasMore: true,
      });
    },

    loadGroupTabs: async (datasetId: string) => {
      if (!datasetId) {
        set(clearGroupTabState());
        return;
      }

      try {
        const response = await datasetFacade.listGroupTabs(datasetId);
        if (!response.success) {
          throw new Error(response.error || '加载组内 Tab 失败');
        }

        const tabs = Array.isArray(response.tabs)
          ? [...response.tabs].sort((a, b) => a.tabOrder - b.tabOrder)
          : [];
        if (tabs.length === 0) {
          set(clearGroupTabState());
          return;
        }

        const state = get();
        const selectedIdFromState = state.selectedTabDatasetId;
        const selectedExists = selectedIdFromState
          ? tabs.some((tab) => tab.datasetId === selectedIdFromState)
          : false;
        const datasetExists = tabs.some((tab) => tab.datasetId === datasetId);
        const nextSelectedId = selectedExists
          ? selectedIdFromState
          : datasetExists
            ? datasetId
            : (tabs.find((tab) => tab.isGroupDefault)?.datasetId ?? tabs[0].datasetId);

        set({
          currentGroupId: tabs[0]?.tabGroupId || null,
          groupTabs: tabs,
          selectedTabDatasetId: nextSelectedId,
        });
      } catch (error) {
        console.error('[datasetStore] Failed to load group tabs:', error);
        set({
          ...clearGroupTabState(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    setGroupTabs: (tabs: GroupTabInfo[]) => {
      const sortedTabs = [...tabs].sort((a, b) => a.tabOrder - b.tabOrder);
      const selectedId = get().selectedTabDatasetId;
      const selectedExists = selectedId
        ? sortedTabs.some((tab) => tab.datasetId === selectedId)
        : false;
      const nextSelectedId =
        sortedTabs.find((tab) => tab.isGroupDefault)?.datasetId ?? sortedTabs[0]?.datasetId ?? null;

      set({
        currentGroupId: sortedTabs[0]?.tabGroupId || null,
        groupTabs: sortedTabs,
        selectedTabDatasetId: selectedExists ? selectedId : nextSelectedId,
      });
    },

    selectGroupTab: (datasetId: string | null) => {
      set({ selectedTabDatasetId: datasetId });
    },

    clearGroupTabs: () => {
      set({
        currentGroupId: null,
        groupTabs: [],
        selectedTabDatasetId: null,
      });
    },

    setWorkspaceCategories: (categories: DatasetCategory[]) => {
      set({ workspaceCategories: categories });
    },

    syncWorkspaceCategoryMetadata: () => {
      set((state) => ({
        workspaceCategories: syncWorkspaceCategoriesWithDatasets(
          state.workspaceCategories,
          state.datasets as DatasetMeta[]
        ),
      }));
    },

    selectWorkspaceCategory: (categoryId: string | null) => {
      set({
        selectedCategory: categoryId,
        selectedTableId: null,
      });
    },

    selectWorkspaceTable: (tableId: string | null) => {
      set({ selectedTableId: tableId });
    },

    selectWorkspaceDataset: (
      datasetId: string,
      preferredCategoryId?: string | null,
      snapshot?: WorkspaceSnapshot
    ) => {
      set({
        selectedCategory: resolveWorkspaceCategoryIdForDataset(
          datasetId,
          preferredCategoryId,
          snapshot
        ),
        selectedTableId: toTableId(datasetId),
      });
    },

    clearWorkspaceSelection: () => {
      set({
        selectedCategory: null,
        selectedTableId: null,
      });
    },

    resetWorkspaceViewState: () => {
      set({
        workspaceCategories: [],
        selectedCategory: null,
        selectedTableId: null,
        isAnalyzingTypes: false,
      });
    },

    setWorkspaceAnalyzingTypes: (value: boolean) => {
      set({ isAnalyzingTypes: value });
    },

    reconcileWorkspaceSelection: () => {
      set((state) => {
        const { workspaceCategories, selectedCategory, selectedTableId } = state;

        if (
          selectedCategory &&
          !workspaceCategories.some((category) => category.id === selectedCategory)
        ) {
          return {
            selectedCategory: null,
            selectedTableId: null,
          };
        }

        if (!selectedCategory) {
          return selectedTableId === null ? state : { selectedTableId: null };
        }

        const category = workspaceCategories.find((item) => item.id === selectedCategory);
        if (!category || category.tables.length === 0) {
          return selectedTableId === null ? state : { selectedTableId: null };
        }

        if (selectedTableId && category.tables.some((table) => table.id === selectedTableId)) {
          return state;
        }

        const selectedDatasetId = getDatasetIdFromTableId(selectedTableId);
        const selectedDatasetMeta = selectedDatasetId
          ? (state.datasets as DatasetMeta[]).find((item) => item.id === selectedDatasetId)
          : undefined;
        const selectedIsHiddenGroupTab =
          (!!selectedDatasetId && state.selectedTabDatasetId === selectedDatasetId) ||
          (!!selectedDatasetId &&
            state.groupTabs.some((tab) => tab.datasetId === selectedDatasetId)) ||
          !shouldShowInSidebar(selectedDatasetMeta);

        if (selectedIsHiddenGroupTab) {
          return state;
        }

        if (category.isFolder) {
          return selectedTableId === null ? state : { selectedTableId: null };
        }

        return {
          selectedTableId: category.tables[0]?.id ?? null,
        };
      });
    },

    // ========== 🆕 默认查询模板方法（持久化）==========

    /**
     * 加载默认查询模板
     */
    loadDefaultQueryTemplate: async (datasetId: string) => {
      const sessionId = beginQuerySession(datasetId);

      try {
        await loadDefaultQueryTemplateInternal(datasetId, sessionId);
      } catch (error) {
        if (!isActiveQuerySession(sessionId, datasetId)) {
          return;
        }
        console.error(`[datasetStore] Failed to load default query template:`, error);
        set({
          error: error instanceof Error ? error.message : String(error),
          loading: false,
          dataReady: false,
        });
      }
    },
    /**
     * 更新当前激活查询模板（默认模板与自定义模板统一走 query-template:update）
     */
    updateActiveQueryTemplate: async (datasetId: string, partialConfig: Partial<QueryConfig>) => {
      const sessionId = beginQuerySession(datasetId);

      try {
        let state = get();
        let activeTemplate = getActiveQueryTemplateFromState(state);

        // 未选中模板时，先确保默认模板已加载，再走统一 update 链路
        if (!activeTemplate) {
          await loadDefaultQueryTemplateInternal(datasetId, sessionId);
          if (!isActiveQuerySession(sessionId, datasetId)) {
            return;
          }
          state = get();
          activeTemplate = getActiveQueryTemplateFromState(state);
          if (!activeTemplate) {
            throw new Error('当前无可更新查询模板');
          }
        }

        const baseConfig = activeTemplate.queryConfig
          ? (JSON.parse(JSON.stringify(activeTemplate.queryConfig)) as QueryConfig)
          : ({} as QueryConfig);
        const mergedConfig: QueryConfig = {
          ...baseConfig,
          ...partialConfig,
        };

        const updateResponse = await getQueryTemplateApi().update({
          templateId: activeTemplate.id,
          queryConfig: mergedConfig,
        });
        if (!isActiveQuerySession(sessionId, datasetId)) {
          return;
        }

        if (!updateResponse.success) {
          throw new Error(updateResponse.error || '更新查询模板失败');
        }

        await applyQueryTemplateInternal(activeTemplate.id, sessionId);
      } catch (error) {
        if (!isActiveQuerySession(sessionId, datasetId)) {
          return;
        }
        console.error('[datasetStore] Failed to update active query template:', error);
        set({
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      }
    },
    /**
     * 清除所有处理（重置为空配置）
     */
    clearAllProcessing: async (datasetId: string) => {
      try {
        const emptyConfig: Partial<QueryConfig> = {
          filter: undefined,
          sort: undefined,
          clean: undefined,
          dedupe: undefined,
          group: undefined,
          aggregate: undefined,
          sample: undefined,
          columns: undefined,
          color: undefined,
        };

        await get().updateActiveQueryTemplate(datasetId, emptyConfig);
      } catch (error) {
        console.error(`[datasetStore] Failed to clear processing:`, error);
        set({ error: error instanceof Error ? error.message : String(error), loading: false });
      }
    },

    // ========== 查询取消管理（新增）==========

    /**
     * 取消指定数据集的查询
     * @param id 数据集ID
     */
    cancelQuery: (id: string) => {
      invalidateQuerySession(id);
    },
  };
});

// 查询模板语义选择器（与“Tab 视图”概念解耦）
export const selectActiveQueryTemplate = (state: ReturnType<typeof useDatasetStore.getState>) =>
  getActiveQueryTemplateFromState(state);

export const selectActiveQueryConfig = (state: ReturnType<typeof useDatasetStore.getState>) =>
  getActiveQueryTemplateFromState(state)?.queryConfig as QueryConfig | undefined;

// 订阅导入进度事件（应该在应用启动时调用一次）
export const subscribeToImportProgress = () => {
  return datasetEvents.subscribeToImportProgress((progress) => {
    useDatasetStore.getState().updateImportProgress(progress);
  });
};
