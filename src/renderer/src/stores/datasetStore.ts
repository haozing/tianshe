/**
 * 数据集状态管理 Store
 * 使用 Zustand 管理 DuckDB 数据集的全局状态
 */

import { create } from 'zustand';
import type { QueryConfig } from '../../../core/query-engine/types';
import type { DatasetCategory } from '../components/DatasetsPage/types';
import { datasetFacade } from '../services/datasets/datasetFacade';
import { datasetEvents } from '../services/datasets/datasetEvents';
import { createDatasetImportSlice, type ImportProgress } from './dataset/importSlice';
import { createDatasetCoreSlice } from './dataset/coreSlice';
import {
  createDatasetOptimisticSlice,
  type DatasetLocalPatchTransaction,
} from './dataset/optimisticSlice';
import {
  createDatasetQueryRuntimeSlice,
  getActiveQueryTemplateFromState,
  type QueryResult,
} from './dataset/queryRuntimeSlice';
import { createDatasetQueryTemplateSlice } from './dataset/queryTemplateSlice';
import {
  createDatasetWorkspaceSlice,
  type GroupTabInfo,
  type WorkspaceSnapshot,
} from './dataset/workspaceSlice';
import type { DatasetInfo, DatasetSchemaColumn } from './dataset/types';

interface DatasetStore {
  // 状态
  datasets: DatasetInfo[];
  currentDataset: DatasetInfo | null;
  queryResult: QueryResult | null;
  importProgress: Map<string, ImportProgress>;
  processedImports: Set<string>; // 已处理的导入（防止重复类型分析）
  pendingLocalSchemaRefreshDatasets: Set<string>;
  localPatchTransaction: DatasetLocalPatchTransaction | null;
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
  beginLocalPatch: () => string;
  commitLocalPatch: (patchId: string) => boolean;
  rollbackLocalPatch: (patchId: string) => boolean;
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
  const queryRuntime = createDatasetQueryRuntimeSlice<DatasetStore>(set, get);

  return {
    // 初始状态
    datasets: [],
    currentDataset: null,
    queryResult: null,
    importProgress: new Map(),
    processedImports: new Set(), // 初始化为空 Set
    pendingLocalSchemaRefreshDatasets: new Set(),
    localPatchTransaction: null,
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

    ...createDatasetCoreSlice<DatasetStore>(set, get, queryRuntime.helpers),

    ...queryRuntime.actions,

    // 导入 CSV
    ...createDatasetImportSlice(set, get),

    ...createDatasetOptimisticSlice<DatasetStore>(set, get),

    ...createDatasetQueryTemplateSlice<DatasetStore>(set, get, queryRuntime.helpers),

    ...createDatasetWorkspaceSlice(set, get),
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
