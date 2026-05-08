import type { QueryConfig } from '../../../../core/query-engine/types';
import { normalizeRuntimeSQL } from '../../../../utils/query-runtime';
import { datasetFacade } from '../../services/datasets/datasetFacade';
import {
  bindActiveQueryTemplateState,
  getActiveQueryTemplateFromState,
  getQueryTemplateApi,
  type DatasetQueryRuntimeHelpers,
  type DatasetQueryRuntimeState,
} from './queryRuntimeSlice';

export interface DatasetQueryTemplateState extends DatasetQueryRuntimeState {
  currentDataset: { id: string; rowCount: number } | null;
  queryDataset: (id: string) => Promise<void>;
}

export interface DatasetQueryTemplateActions {
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
  loadDefaultQueryTemplate: (datasetId: string) => Promise<void>;
  updateActiveQueryTemplate: (
    datasetId: string,
    partialConfig: Partial<QueryConfig>
  ) => Promise<void>;
  clearAllProcessing: (datasetId: string) => Promise<void>;
}

type DatasetQueryTemplateSet<TState extends DatasetQueryTemplateState> = (
  partial: Partial<TState> | TState | ((state: TState) => Partial<TState> | TState)
) => void;

type DatasetQueryTemplateGet<TState extends DatasetQueryTemplateState> = () => TState;

type QueryTemplateRuntimeHelpers<TState extends DatasetQueryTemplateState> = Pick<
  DatasetQueryRuntimeHelpers<TState>,
  'beginQuerySession' | 'deriveHasMore' | 'isActiveQuerySession' | 'queryTemplateSnapshotInternal'
>;

export function createDatasetQueryTemplateSlice<TState extends DatasetQueryTemplateState>(
  set: DatasetQueryTemplateSet<TState>,
  get: DatasetQueryTemplateGet<TState>,
  runtimeHelpers: QueryTemplateRuntimeHelpers<TState>
): DatasetQueryTemplateActions {
  const {
    beginQuerySession,
    deriveHasMore,
    isActiveQuerySession,
    queryTemplateSnapshotInternal,
  } = runtimeHelpers;

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
    } as Partial<TState>);

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
    } as Partial<TState>);
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
    } as Partial<TState>);

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
    } as Partial<TState>);
  };

  const createQueryTemplate = async (params: {
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
      }

      console.error('[datasetStore] Failed to create query template:', response.error);
      set({ error: response.error || '创建查询模板失败' } as Partial<TState>);
      return null;
    } catch (error) {
      console.error('[datasetStore] Error creating query template:', error);
      set({ error: '创建查询模板失败' } as Partial<TState>);
      return null;
    }
  };

  const createQueryTemplateFromConfig = async (params: {
    datasetId: string;
    name: string;
    description?: string;
    icon?: string;
    queryConfig: QueryConfig;
  }) => {
    try {
      const sqlResponse = await datasetFacade.previewQuerySQL(params.datasetId, params.queryConfig);

      if (!sqlResponse.success || !sqlResponse.sql) {
        const errorMessage = sqlResponse.error || 'Failed to generate query template SQL';
        set({ error: errorMessage } as Partial<TState>);
        return null;
      }

      return await createQueryTemplate({
        ...params,
        generatedSQL: sqlResponse.sql,
      });
    } catch (error) {
      console.error('[datasetStore] Error generating query template SQL:', error);
      set({ error: 'Failed to create query template' } as Partial<TState>);
      return null;
    }
  };

  const applyQueryTemplate = async (templateId: string) => {
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
      } as Partial<TState>);
    }
  };

  const refreshActiveQueryTemplate = async (datasetId: string) => {
    const state = get();
    const activeQueryTemplate = getActiveQueryTemplateFromState(state);
    if (activeQueryTemplate && activeQueryTemplate.datasetId === datasetId) {
      const sessionId = beginQuerySession(
        datasetId,
        bindActiveQueryTemplateState(activeQueryTemplate) as Partial<TState>
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
        } as Partial<TState>);
      } catch (error) {
        if (!isActiveQuerySession(sessionId, datasetId)) {
          return;
        }
        console.error('[datasetStore] Failed to refresh active query template:', error);
        set({
          error: error instanceof Error ? error.message : '刷新数据失败',
          loading: false,
          dataReady: false,
        } as Partial<TState>);
      }
      return;
    }

    await state.queryDataset(datasetId);
  };

  const resetQueryTemplateState = () => {
    set({
      ...bindActiveQueryTemplateState(null),
      dataReady: false,
      queryResult: null,
      currentOffset: 0,
      hasMore: true,
    } as Partial<TState>);
  };

  const loadDefaultQueryTemplate = async (datasetId: string) => {
    const sessionId = beginQuerySession(datasetId);

    try {
      await loadDefaultQueryTemplateInternal(datasetId, sessionId);
    } catch (error) {
      if (!isActiveQuerySession(sessionId, datasetId)) {
        return;
      }
      console.error('[datasetStore] Failed to load default query template:', error);
      set({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
        dataReady: false,
      } as Partial<TState>);
    }
  };

  const updateActiveQueryTemplate = async (
    datasetId: string,
    partialConfig: Partial<QueryConfig>
  ) => {
    const sessionId = beginQuerySession(datasetId);

    try {
      let state = get();
      let activeTemplate = getActiveQueryTemplateFromState(state);

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
      } as Partial<TState>);
    }
  };

  const clearAllProcessing = async (datasetId: string) => {
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

      await updateActiveQueryTemplate(datasetId, emptyConfig);
    } catch (error) {
      console.error('[datasetStore] Failed to clear processing:', error);
      set({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      } as Partial<TState>);
    }
  };

  return {
    createQueryTemplate,
    createQueryTemplateFromConfig,
    applyQueryTemplate,
    refreshActiveQueryTemplate,
    resetQueryTemplateState,
    loadDefaultQueryTemplate,
    updateActiveQueryTemplate,
    clearAllProcessing,
  };
}
