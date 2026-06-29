import type { QueryConfig } from '../../../../core/query-engine/types';
import { datasetFacade } from '../../services/datasets/datasetFacade';
import { createRendererLogger } from '../../lib/logger';

const logger = createRendererLogger('DatasetStore');

let querySessionSerial = 0;

export interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  filteredTotalCount?: number;
}

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

export const hasComplexQueryConfig = (config?: QueryConfig) =>
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

export const getQueryTemplateApi = (): QueryTemplateApi => {
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

export const getActiveQueryTemplateFromState = (state: { activeQueryTemplate: any | null }) =>
  state.activeQueryTemplate;

export const bindActiveQueryTemplateState = (template: any | null) =>
  template === null
    ? {
        activeQueryTemplate: null,
      }
    : {
        activeQueryTemplate: template,
      };

export interface DatasetQueryRuntimeState {
  activeQueryTemplate: any | null;
  activeQuerySessionId: number;
  activeQueryDatasetId: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  currentOffset: number;
  hasMore: boolean;
  dataReady: boolean;
  pageSize: number;
  queryResult: QueryResult | null;
  currentDataset: { rowCount: number } | null;
}

export interface DatasetQueryRuntimeActions {
  queryDataset: (id: string) => Promise<void>;
  loadMoreData: (id: string) => Promise<void>;
  cancelQuery: (id: string) => void;
  clearQueryResult: () => void;
}

export interface DatasetQueryRuntimeHelpers<TState extends DatasetQueryRuntimeState> {
  isActiveQuerySession: (sessionId: number, datasetId?: string | null) => boolean;
  beginQuerySession: (datasetId: string | null, extraState?: Partial<TState>) => number;
  invalidateQuerySession: (datasetId?: string | null) => void;
  clearDatasetViewState: (extraState?: Partial<TState>) => Partial<TState>;
  deriveHasMore: (result: QueryResult, pageSize: number) => boolean;
  queryTemplateSnapshotInternal: (
    template: { id: string; datasetId: string; isDefault?: boolean },
    sessionId: number,
    options?: {
      offset?: number;
      limit?: number;
      refreshSnapshot?: boolean;
    }
  ) => Promise<QueryResult | null>;
}

type DatasetQueryRuntimeSet<TState extends DatasetQueryRuntimeState> = (
  partial: Partial<TState> | TState | ((state: TState) => Partial<TState> | TState)
) => void;

type DatasetQueryRuntimeGet<TState extends DatasetQueryRuntimeState> = () => TState;

export function createDatasetQueryRuntimeSlice<TState extends DatasetQueryRuntimeState>(
  set: DatasetQueryRuntimeSet<TState>,
  get: DatasetQueryRuntimeGet<TState>
): {
  actions: DatasetQueryRuntimeActions;
  helpers: DatasetQueryRuntimeHelpers<TState>;
} {
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

  const beginQuerySession = (datasetId: string | null, extraState: Partial<TState> = {}) => {
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
    } as Partial<TState>);
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
    } as Partial<TState>);
  };

  const clearDatasetViewState = (extraState: Partial<TState> = {}) =>
    ({
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
    }) as Partial<TState>;

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

  const queryDataset = async (id: string) => {
    const activeQueryTemplate = getActiveQueryTemplateFromState(get());
    const shouldUseActiveTemplate = Boolean(
      activeQueryTemplate && activeQueryTemplate.datasetId === id
    );
    const shouldClearStaleTemplate = Boolean(
      activeQueryTemplate && activeQueryTemplate.datasetId !== id
    );
    const sessionId = beginQuerySession(
      id,
      (shouldClearStaleTemplate
        ? bindActiveQueryTemplateState(null)
        : shouldUseActiveTemplate
          ? bindActiveQueryTemplateState(activeQueryTemplate)
          : {}) as Partial<TState>
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
        } as Partial<TState>);
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
        } as Partial<TState>);
      } else {
        set({
          error: response.error || '查询数据失败',
          loading: false,
          dataReady: false,
        } as Partial<TState>);
      }
    } catch (error: unknown) {
      if (!isActiveQuerySession(sessionId, id)) {
        return;
      }
      set({
        error: error instanceof Error ? error.message : '查询数据失败',
        loading: false,
        dataReady: false,
      } as Partial<TState>);
    }
  };

  const loadMoreData = async (id: string) => {
    const state = get();

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
    } as Partial<TState>);

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
        const totalRowCount = mergedFilteredTotalCount ?? currentState.currentDataset?.rowCount;

        const hasMore =
          totalRowCount !== undefined && totalRowCount !== null
            ? newTotalRows < totalRowCount
            : incomingResult.rows.length === currentState.pageSize;

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
        } as Partial<TState>);
      } else {
        set({ loadingMore: false } as Partial<TState>);
      }
    } catch (error: unknown) {
      if (!isActiveQuerySession(sessionId, id)) {
        return;
      }
      logger.error('Failed to load more dataset rows', {
        operation: 'dataset.query.loadMore',
        datasetId: id,
        error,
      });
      set({
        error: error instanceof Error ? error.message : String(error),
        loadingMore: false,
      } as Partial<TState>);
    }
  };

  return {
    actions: {
      queryDataset,
      loadMoreData,
      cancelQuery: (id: string) => {
        invalidateQuerySession(id);
      },
      clearQueryResult: () => {
        set({
          queryResult: null,
          currentOffset: 0,
          hasMore: true,
          dataReady: false,
        } as Partial<TState>);
      },
    },
    helpers: {
      isActiveQuerySession,
      beginQuerySession,
      invalidateQuerySession,
      clearDatasetViewState,
      deriveHasMore,
      queryTemplateSnapshotInternal,
    },
  };
}
