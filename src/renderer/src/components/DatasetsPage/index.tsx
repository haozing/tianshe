/**
 * Datasets Page - Data Management Workspace
 *
 * Features:
 * - Left sidebar with dataset categories and folders
 * - Grouped tabs for multi-table workspaces
 * - Toolbar with add record, filter, sort, group, field config
 * - TanStack table for data display with inline editing
 * - Search and import/export workflows
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from '../../lib/toast';
import { DatasetSidebar } from './DatasetSidebar';
import { DatasetToolbar } from './DatasetToolbar';
import { DatasetTabs } from './DatasetTabs';
import { SaveQueryTemplateDialog } from './SaveQueryTemplateDialog';
import { DatasetTable } from './DatasetTable';
import { AddRecordDrawer } from './AddRecordDrawer';
import { ExportDialog } from './ExportDialog';
import type { ExportDialogOptions } from './ExportDialog';
import { CustomPageViewer } from './CustomPageViewer';
import { useDatasetsWorkspaceController } from './useDatasetsWorkspaceController';
import { FilterPanel } from './panels/FilterPanel';
import { AggregatePanel } from './panels/AggregatePanel';
import { CleanPanel } from './panels/CleanPanel';
import { LookupPanel } from './panels/LookupPanel';
import { DedupePanel } from './panels/DedupePanel';
import { SortPanel } from './panels/SortPanel';
import { SamplePanel } from './panels/SamplePanel';
import { GroupPanel } from './panels/GroupPanel';
import { ColorPanel } from './panels/ColorPanel';
import { RowHeightPanel } from './panels/RowHeightPanel';
import { AddColumnDialog } from './AddColumnDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LoadingOverlay } from '../ui/LoadingOverlay';
import { getDatasetsWorkspaceViewportMetrics } from './datasetsWorkspaceResponsive';
import {
  selectActiveQueryConfig,
  selectActiveQueryTemplate,
  useDatasetStore,
} from '../../stores/datasetStore';
import { datasetEvents } from '../../services/datasets/datasetEvents';
import { useElectronAPI, useEventSubscription } from '../../hooks/useElectronAPI';
import {
  getMergedHiddenColumnNames,
  isSystemField,
} from '../../../../utils/dataset-column-capabilities';
import type {
  AggregateConfig,
  CleanConfig,
  ColorConfig,
  FilterConfig,
  GroupConfig,
  LookupConfig,
  QueryConfig,
  RowHeightValue,
  SampleConfig,
  SortConfig,
} from '../../../../core/query-engine/types';

const isInternalGroupHelperColumn = (columnName: string) => columnName.startsWith('__group_');

export function DatasetsPage() {
  const electronAPI = useElectronAPI();
  // UI State
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddRecordDrawerOpen, setIsAddRecordDrawerOpen] = useState(false);
  const [showImportProgress, setShowImportProgress] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showAggregatePanel, setShowAggregatePanel] = useState(false);
  const [showCleanPanel, setShowCleanPanel] = useState(false);
  const [showLookupPanel, setShowLookupPanel] = useState(false);
  const [showDedupePanel, setShowDedupePanel] = useState(false);
  const [showSortPanel, setShowSortPanel] = useState(false);
  const [showColumnPanel, setShowColumnPanel] = useState(false);
  const [showSamplePanel, setShowSamplePanel] = useState(false);
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [showColorPanel, setShowColorPanel] = useState(false);
  const [showRowHeightPanel, setShowRowHeightPanel] = useState(false);
  const [currentRowHeight, setCurrentRowHeight] = useState<RowHeightValue>('normal');
  const [viewportWidth, setViewportWidth] = useState(
    () =>
      getDatasetsWorkspaceViewportMetrics(
        typeof window === 'undefined' ? undefined : window.innerWidth
      ).viewportWidth
  );
  const [showAddColumnDialog, setShowAddColumnDialog] = useState(false);
  const [selectedRows, setSelectedRows] = useState<any[]>([]);

  // 🆕 删除表加载状态
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);

  // 🆕 删除确认弹窗状态
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    type: 'dataset' | 'folder' | 'table';
    pluginId?: string | null;
  } | null>(null);
  const [deleteFolderContents, setDeleteFolderContents] = useState(false);

  // 查询模板相关 UI 状态
  const [showSaveQueryTemplateDialog, setShowSaveQueryTemplateDialog] = useState(false);
  const [pendingQueryConfig, setPendingQueryConfig] = useState<QueryConfig | null>(null); // 🆕 待保存的查询配置（通用）

  // 🆕 导出相关 UI 状态
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    message: string;
    percentage: number;
    current: number;
    total: number;
  } | null>(null);

  // Refs
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const groupButtonRef = useRef<HTMLButtonElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const fillColorButtonRef = useRef<HTMLButtonElement>(null);
  const cleanButtonRef = useRef<HTMLButtonElement>(null);
  const dedupeButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLDivElement>(null); // 🆕 "更多"按钮ref

  const {
    datasets,
    importProgress,
    currentDataset,
    queryResult, // 🆕 获取查询结果（包含 filteredTotalCount）
    refreshDatasetView,
    // 查询模板相关
    dataReady,
    createQueryTemplateFromConfig,
    groupTabs,
    selectedTabDatasetId,
    loadGroupTabs,
    consumePendingLocalSchemaRefresh,
    applyLocalDatasetCountDelta,
    applyLocalRecordDeletion,
    updateImportProgress,
    updateActiveQueryTemplate, // ✅ 查询模板配置持久化
  } = useDatasetStore();
  const activeQueryTemplate = useDatasetStore(selectActiveQueryTemplate);
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);
  const effectiveHiddenColumns = useMemo(
    () =>
      getMergedHiddenColumnNames(
        currentDataset?.schema ?? [],
        activeQueryConfig?.columns?.hide,
        activeQueryConfig?.columns?.show,
        activeQueryConfig?.columns?.select
      ),
    [
      activeQueryConfig?.columns?.hide,
      activeQueryConfig?.columns?.select,
      activeQueryConfig?.columns?.show,
      currentDataset?.schema,
    ]
  );
  const exportAvailableColumns = useMemo(() => {
    const orderedColumns: string[] = [];
    const seen = new Set<string>();

    const pushColumn = (name: string) => {
      if (!name || isSystemField(name) || isInternalGroupHelperColumn(name) || seen.has(name)) {
        return;
      }
      seen.add(name);
      orderedColumns.push(name);
    };

    for (const column of currentDataset?.schema ?? []) {
      pushColumn(column.name);
    }

    for (const columnName of queryResult?.columns ?? []) {
      pushColumn(columnName);
    }

    return orderedColumns;
  }, [currentDataset?.schema, queryResult?.columns]);
  const panelColumns = useMemo(() => {
    const ordered = new Map<string, { name: string; type: string }>();

    for (const column of currentDataset?.schema ?? []) {
      ordered.set(column.name, {
        name: column.name,
        type: column.duckdbType || column.fieldType || '',
      });
    }

    for (const columnName of queryResult?.columns ?? []) {
      if (
        isSystemField(columnName) ||
        isInternalGroupHelperColumn(columnName) ||
        ordered.has(columnName)
      ) {
        continue;
      }
      ordered.set(columnName, {
        name: columnName,
        type: '',
      });
    }

    return Array.from(ordered.values());
  }, [currentDataset?.schema, queryResult?.columns]);

  const {
    categories,
    currentCategory,
    currentTable,
    selectedCategory,
    selectedTableId,
    isAnalyzingTypes,
    refreshWorkspace,
    selectCategory,
    selectTable,
    clearSelection,
    selectDataset,
    importDataset,
    createDataset,
    createFolder,
    deleteDatasetAndRefresh,
    deleteFolderAndRefresh,
    createGroupTabCopy,
    renameGroupTab,
    reorderGroupTabs,
    deleteRows,
    exportDatasetWithDialog,
  } = useDatasetsWorkspaceController();
  const workspaceViewportMetrics = useMemo(
    () => getDatasetsWorkspaceViewportMetrics(viewportWidth),
    [viewportWidth]
  );

  // 组内 Tab 默认可写；仅在数据未就绪时禁用操作
  const isDataReadOnly = !dataReady;

  useEffect(() => {
    if (!isDataReadOnly) return;

    if (showAddColumnDialog) {
      setShowAddColumnDialog(false);
    }
    if (isAddRecordDrawerOpen) {
      setIsAddRecordDrawerOpen(false);
    }
  }, [isDataReadOnly, showAddColumnDialog, isAddRecordDrawerOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEventSubscription(datasetEvents.subscribeToImportProgress, updateImportProgress);
  useEventSubscription(electronAPI.duckdb.onExportProgress, setExportProgress);
  useEventSubscription(datasetEvents.subscribeToSchemaUpdated, (updatedDatasetId) => {
    const skipSchemaRefresh = consumePendingLocalSchemaRefresh(updatedDatasetId);

    if (!currentTable?.datasetId || currentTable.isCustomPage) {
      return;
    }

    if (updatedDatasetId !== currentTable.datasetId) {
      return;
    }

    void refreshDatasetView(updatedDatasetId, { refreshSchema: !skipSchemaRefresh });
  });

  useEffect(() => {
    setCurrentRowHeight(activeQueryConfig?.rowHeight ?? 'normal');
  }, [activeQueryConfig?.rowHeight, currentTable?.datasetId]);

  // 监听导入进度变化
  useEffect(() => {
    const hasActiveImport = Array.from(importProgress.values()).some(
      (progress) => progress.status === 'importing' || progress.status === 'pending'
    );
    // 只自动“打开”进度弹窗，不自动关闭：
    // - 导入失败时需要保留弹窗展示错误信息
    // - 导入完成的关闭由后续流程（如类型分析）或用户手动关闭处理
    if (hasActiveImport) {
      setShowImportProgress(true);
    }
  }, [importProgress]);
  const showGroupTabs = Boolean(currentTable && !currentTable.isCustomPage && groupTabs.length > 0);
  const showWorkspaceToolbar = Boolean(currentTable && !currentTable.isCustomPage);
  const showWorkspaceChrome = showGroupTabs || showWorkspaceToolbar;
  const showToolbarCopyAction = Boolean(
    currentTable && !currentTable.isCustomPage && groupTabs.length === 0
  );
  const activeWorkspaceTabId =
    showGroupTabs && selectedTabDatasetId ? `dataset-tab-${selectedTabDatasetId}` : undefined;
  const activeWorkspacePanelId =
    showGroupTabs && selectedTabDatasetId ? `dataset-tabpanel-${selectedTabDatasetId}` : undefined;
  const importProgressEntries = Array.from(importProgress.entries());
  const allImportsSettled =
    importProgressEntries.length > 0 &&
    importProgressEntries.every(
      ([, progress]) => progress.status === 'completed' || progress.status === 'failed'
    );

  const handleSelectTab = async (datasetId: string | null) => {
    if (!datasetId) return;
    selectDataset(datasetId, selectedCategory);
  };

  const handleCreateTabCopy = async () => {
    if (!currentTable?.datasetId || currentTable.isCustomPage) return;

    try {
      await createGroupTabCopy(currentTable.datasetId, currentCategory?.id ?? null);
      toast.success('已创建新标签页副本');
    } catch (error) {
      console.error('[DatasetsPage] Failed to create group tab copy:', error);
      toast.error('复制新标签页失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  const currentEmptyStateTitle = currentCategory?.isFolder
    ? `已进入目录 “${currentCategory.name}”`
    : '请选择一个数据表';
  const currentEmptyStateDescription = currentCategory?.isFolder
    ? '从左侧继续选择数据表，或在当前目录中导入 Excel、创建数据表和子文件夹。'
    : '从左侧选择分类，然后选择或创建表格。';

  // 重命名组内 Tab（真实 dataset）
  const handleRenameTab = async (datasetId: string, newName: string) => {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      toast.warning('数据表名称不能为空');
      return;
    }

    try {
      await renameGroupTab(datasetId, trimmedName, currentCategory?.id ?? null);
      toast.success('已重命名数据表');
    } catch (error) {
      console.error('[DatasetsPage] Failed to rename group tab dataset:', error);
      toast.error('重命名数据表失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // 面板内“保存查询模板”仍走 dataset_query_templates（模板存储）能力
  const handleSaveQueryTemplate = async (name: string, icon?: string, description?: string) => {
    if (!currentTable?.datasetId) return;

    try {
      const queryConfig = pendingQueryConfig || {};
      const templateId = await createQueryTemplateFromConfig({
        datasetId: currentTable.datasetId,
        name,
        description,
        icon,
        queryConfig,
      });

      if (!templateId) {
        toast.error('保存查询模板失败');
        return;
      }

      setPendingQueryConfig(null);
      setShowSaveQueryTemplateDialog(false);

      if (queryConfig.filter) setShowFilterPanel(false);
      if (queryConfig.aggregate) setShowAggregatePanel(false);
      if (queryConfig.group) setShowGroupPanel(false);
      if (queryConfig.sort) setShowSortPanel(false);
      if (queryConfig.clean) setShowCleanPanel(false);
      if (queryConfig.dedupe) setShowDedupePanel(false);
      if (queryConfig.sample) setShowSamplePanel(false);
      if (queryConfig.color) setShowColorPanel(false);
      if (queryConfig.rowHeight !== undefined) setShowRowHeightPanel(false);
    } catch (error) {
      console.error('[DatasetsPage] Failed to create saved query template:', error);
      toast.error('保存查询模板失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // 🆕 通用的面板保存处理器
  const handleSaveFromPanel = (config: QueryConfig) => {
    const baseConfig = activeQueryConfig
      ? (JSON.parse(JSON.stringify(activeQueryConfig)) as QueryConfig)
      : {};
    setPendingQueryConfig({
      ...baseConfig,
      ...config,
    });
    setShowSaveQueryTemplateDialog(true);
  };

  // 🆕 保存筛选为查询模板
  const handleSaveFilterAsTemplate = (filterConfig: FilterConfig) => {
    handleSaveFromPanel({ filter: filterConfig });
  };

  const handleSaveAggregateAsTemplate = (aggregateConfig: AggregateConfig) => {
    handleSaveFromPanel({
      aggregate: aggregateConfig,
      group: undefined,
    });
  };

  // 🆕 保存排序为查询模板
  const handleSaveSortAsTemplate = (sortConfig: SortConfig) => {
    handleSaveFromPanel({ sort: sortConfig });
  };

  // 🆕 保存去重为查询模板
  const handleSaveDedupeAsTemplate = (config: QueryConfig) => {
    handleSaveFromPanel(config);
  };

  // 🆕 保存采样为查询模板
  const handleSaveSampleAsTemplate = (sampleConfig: SampleConfig) => {
    handleSaveFromPanel({ sample: sampleConfig });
  };

  const handleSaveColorAsTemplate = (colorConfig: ColorConfig) => {
    handleSaveFromPanel({ color: colorConfig });
  };

  // 删除组内 Tab（真实 dataset）
  const handleDeleteTab = async (tabDatasetId: string) => {
    const deletingSelected = currentTable?.datasetId === tabDatasetId;
    const remainingTabs = groupTabs.filter((tab) => tab.datasetId !== tabDatasetId);

    try {
      const success = await deleteDatasetAndRefresh(tabDatasetId);
      if (!success) {
        const storeError = useDatasetStore.getState().error;
        toast.error('删除数据表失败', storeError || '未知错误');
        return;
      }

      if (deletingSelected) {
        if (remainingTabs.length > 0) {
          const nextTab = remainingTabs.find((tab) => tab.isGroupDefault) || remainingTabs[0];
          selectDataset(nextTab.datasetId, currentCategory?.id ?? null);
        } else {
          clearSelection();
        }
      } else if (currentTable?.datasetId) {
        await loadGroupTabs(currentTable.datasetId);
      }
    } catch (error) {
      console.error('[DatasetsPage] Failed to delete group tab dataset:', error);
      toast.error('删除数据表失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // 组内 Tab 拖拽排序
  const handleReorderTabs = async (tabDatasetIds: string[]) => {
    try {
      await reorderGroupTabs(tabDatasetIds);
    } catch (error) {
      console.error('[DatasetsPage] Failed to reorder group tabs:', error);
      toast.error('调整 Tab 顺序失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Handle importing Excel
  const openDeleteConfirm = (target: {
    id: string;
    name: string;
    type: 'dataset' | 'folder' | 'table';
    pluginId?: string | null;
  }) => {
    setDeleteFolderContents(false);
    setDeleteTarget(target);
    setDeleteConfirmOpen(true);
  };

  const runImportFlow = async (options?: { folderId?: string | null }) => {
    try {
      setShowImportProgress(true);
      const started = await importDataset(options);
      if (!started) {
        setShowImportProgress(false);
      }
    } catch (error) {
      console.error('[DatasetsPage] Failed to import dataset:', error);
      setShowImportProgress(false);
      toast.error('导入失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  const handleImportExcel = async () => {
    await runImportFlow();
  };

  // Handle creating new dataset
  const handleCreateDataset = async () => {
    try {
      await createDataset();
    } catch (error) {
      console.error('[DatasetsPage] Failed to create dataset:', error);
      toast.error('创建数据表失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Handle creating new folder
  const handleCreateFolder = async () => {
    try {
      const folderCount = categories.filter((c) => c.isFolder).length;
      const folderName = `文件夹 ${folderCount + 1}`;

      await createFolder(folderName);
    } catch (error) {
      console.error('[DatasetsPage] Failed to create folder:', error);
      toast.error('创建文件夹失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Handle importing Excel to folder
  const handleImportExcelToFolder = async (folderId: string) => {
    await runImportFlow({ folderId });
  };

  // Handle creating dataset in folder
  const handleCreateDatasetInFolder = async (folderId: string) => {
    try {
      await createDataset(folderId);
    } catch (error) {
      console.error('[DatasetsPage] Failed to create dataset in folder:', error);
      toast.error('创建数据表失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Handle creating subfolder
  const handleCreateSubfolder = async (parentId: string) => {
    try {
      const subfolderCount = categories.filter((c) => c.isFolder && c.parentId === parentId).length;
      const subfolderName = `子文件夹 ${subfolderCount + 1}`;

      await createFolder(subfolderName, parentId);
    } catch (error) {
      console.error('[DatasetsPage] Failed to create subfolder:', error);
      toast.error('创建子文件夹失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Handle selecting category (清空表选择)
  const handleSelectCategory = selectCategory;
  const handleSelectTable = selectTable;

  // Handle deleting category/dataset
  const handleDeleteCategory = async (categoryId: string) => {
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return;

    // 🆕 如果是插件文件夹，检查是否有数据表
    if (category.isFolder && category.pluginId) {
      if (category.tables.length > 0) {
        toast.warning(`无法删除插件目录 "${category.name}"，请先删除目录中的所有数据表。`);
        return;
      }
    }

    // 🆕 设置删除目标并打开确认弹窗
    openDeleteConfirm({
      id: categoryId,
      name: category.name,
      type: category.isFolder ? 'folder' : 'dataset',
      pluginId: category.pluginId ?? null,
    });
  };

  // 🆕 实际执行删除操作
  const executeDelete = async () => {
    if (!deleteTarget) return;

    try {
      setDeletingItemId(deleteTarget.id);

      if (deleteTarget.type === 'folder') {
        await deleteFolderAndRefresh(deleteTarget.id, deleteFolderContents);
        if (selectedCategory === deleteTarget.id) {
          clearSelection();
        }
      } else {
        const success = await deleteDatasetAndRefresh(deleteTarget.id);
        if (success) {
          if (
            selectedCategory === deleteTarget.id ||
            selectedTableId === `table_${deleteTarget.id}`
          ) {
            clearSelection();
          }
        } else {
          const storeError = useDatasetStore.getState().error;
          if (storeError) {
            toast.error('删除数据表失败', storeError);
          } else {
            toast.error('删除数据表失败，请检查控制台获取详细信息。');
          }
        }
      }
    } catch (error) {
      console.error('[Delete] Failed:', error);
      toast.error('删除失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setDeletingItemId(null);
      setDeleteFolderContents(false);
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    }
  };

  // Handle deleting table from folder
  const handleDeleteTable = async (datasetId: string) => {
    // 查找数据表信息
    const dataset = datasets.find((ds) => ds.id === datasetId);
    if (!dataset) return;

    // 🆕 设置删除目标并打开确认弹窗
    openDeleteConfirm({
      id: datasetId,
      name: dataset.name,
      type: 'table',
    });
  };

  // Handle adding new record
  const handleAddRecord = () => {
    if (isDataReadOnly) {
      toast.warning('数据未就绪，暂不支持新增记录');
      return;
    }
    setIsAddRecordDrawerOpen(true);
  };

  // Handle successful record submission
  const handleRecordSubmitSuccess = async (options?: {
    refreshView?: boolean;
    refreshWorkspace?: boolean;
  }) => {
    if (currentTable?.datasetId) {
      if (options?.refreshView !== false) {
        await refreshDatasetView(currentTable.datasetId, { refreshSchema: false });
      }
      if (options?.refreshWorkspace !== false) {
        await refreshWorkspace();
      }
    }
  };

  // Handle filter panel open
  const handleOpenFilter = () => {
    setShowFilterPanel(true);
  };

  // Handle aggregate panel open
  const handleOpenAggregate = () => {
    setShowGroupPanel(false);
    setShowColorPanel(false);
    setShowAggregatePanel(true);
  };

  const handleApplyAggregate = async (aggregateConfig: AggregateConfig) => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, {
        aggregate: aggregateConfig,
        group: undefined,
      });
      setShowAggregatePanel(false);
    } catch (error) {
      console.error('[AggregatePanel] Failed to apply aggregate config:', error);
      toast.error('应用聚合失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  const handleClearAggregate = async () => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, { aggregate: undefined });
      setShowAggregatePanel(false);
    } catch (error) {
      console.error('[AggregatePanel] Failed to clear aggregate config:', error);
      toast.error('清除聚合失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  // Handle clean panel open
  const handleOpenClean = () => {
    if (isDataReadOnly) {
      toast.warning('数据未就绪，暂不支持清洗');
      return;
    }
    setShowCleanPanel(true);
  };

  // 保存清洗为查询模板
  const handleSaveCleanAsTemplate = (cleanConfig: CleanConfig) => {
    handleSaveFromPanel({ clean: cleanConfig });
  };

  // 应用清洗到当前视图
  const handleApplyClean = async (cleanConfig: CleanConfig) => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, { clean: cleanConfig });
      setShowCleanPanel(false);
    } catch (error) {
      console.error('[CleanPanel] Failed to apply clean config:', error);
      toast.error('应用清洗失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  // 清除当前视图清洗
  const handleClearClean = async () => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, { clean: undefined });
    } catch (error) {
      console.error('[CleanPanel] Failed to clear clean config:', error);
      toast.error('清除清洗失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  // Handle lookup panel open
  const handleOpenLookup = () => {
    setShowLookupPanel(true);
  };

  // Handle lookup apply
  const handleApplyLookup = async (config: LookupConfig[]) => {
    if (!currentTable?.datasetId) return;

    try {
      // ✅ 使用 updateActiveQueryTemplate 持久化配置（与筛选/采样功能一致）
      await updateActiveQueryTemplate(currentTable.datasetId, { lookup: config });
      setShowLookupPanel(false);
    } catch (error) {
      console.error('[Lookup] Failed to apply lookup:', error);
      toast.error('关联错误', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Handle dedupe panel open
  const handleOpenDedupe = () => {
    setShowDedupePanel(true);
  };

  // Handle dedupe apply
  const handleApplyDedupe = async (config: QueryConfig) => {
    if (!currentTable?.datasetId) return;

    try {
      // ✅ 使用 updateActiveQueryTemplate 持久化配置（与筛选/采样功能一致）
      await updateActiveQueryTemplate(currentTable.datasetId, config);
      setShowDedupePanel(false);
    } catch (error) {
      console.error('[DedupePanel] Failed to apply config:', error);
      toast.error('应用失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  const handleClearDedupe = async () => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, { dedupe: undefined });
    } catch (error) {
      console.error('[DedupePanel] Failed to clear dedupe config:', error);
      toast.error('清除去重失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  // Handle sort panel open
  const handleOpenSort = () => {
    setShowSortPanel(true);
  };

  // Handle column panel open
  const handleOpenColumn = () => {
    // 直接打开 TanStackDataTable 中的列管理面板
    setShowColumnPanel(true);
  };

  // Handle sample panel open
  const handleOpenSample = () => {
    setShowSamplePanel(true);
  };

  // Handle sample apply
  const handleApplySample = async (config: SampleConfig) => {
    if (!currentTable?.datasetId) return;

    try {
      // ✅ 使用 updateActiveQueryTemplate 持久化配置（与筛选功能一致）
      await updateActiveQueryTemplate(currentTable.datasetId, { sample: config });
      setShowSamplePanel(false);
    } catch (error) {
      console.error('[Sample] Failed to apply sample:', error);
      toast.error('采样错误', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Handle clear sample
  const handleClearSample = async () => {
    if (!currentTable?.datasetId) return;

    try {
      // ✅ 使用 updateActiveQueryTemplate 清除采样配置
      await updateActiveQueryTemplate(currentTable.datasetId, { sample: undefined });
    } catch (error) {
      console.error('[Sample] Failed to clear sample:', error);
      toast.error('清除采样失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // 🗑️ Handle permanently deleting selected rows
  const handleDeleteRows = async () => {
    if (isDataReadOnly) {
      toast.warning('数据未就绪，暂不支持删除');
      return;
    }

    if (selectedRows.length === 0) {
      toast.warning('请先选择要删除的数据行');
      return;
    }

    if (!currentTable) return;

    const rowIds = selectedRows
      .map((row) => row._row_id as number)
      .filter((id) => id !== undefined);

    if (rowIds.length === 0) {
      toast.warning('所选行缺少有效的 ID');
      return;
    }

    const confirmed = window.confirm(
      `确定要永久删除选中的 ${rowIds.length} 行数据吗？\n\n删除后不可恢复。`
    );
    if (!confirmed) return;

    try {
      const result = await deleteRows(currentTable.datasetId, rowIds);

      // 清空选中状态
      setSelectedRows([]);
      const deletedCount = result.deletedCount;

      const applied = applyLocalRecordDeletion(currentTable.datasetId, rowIds, {
        deletedCount,
      });
      if (!applied) {
        applyLocalDatasetCountDelta(currentTable.datasetId, -deletedCount);
        await refreshDatasetView(currentTable.datasetId);
      }

      toast.success(`已成功删除 ${deletedCount} 行数据`);
    } catch (error) {
      console.error('[DeleteRows] Failed to delete rows:', error);
      toast.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  };

  // Handle group panel open
  const handleOpenGroup = () => {
    setShowAggregatePanel(false);
    setShowColorPanel(false);
    setShowGroupPanel(true);
  };

  const handleApplyGroup = async (config: GroupConfig | null) => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, {
        group: config ?? undefined,
        aggregate: undefined,
      });
      setShowGroupPanel(false);
    } catch (error) {
      console.error('[GroupPanel] Failed to apply group config:', error);
      toast.error('应用分组失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  // Handle color panel open
  const handleOpenColor = () => {
    setShowAggregatePanel(false);
    setShowGroupPanel(false);
    setShowColorPanel(true);
  };

  const handleApplyColor = async (config: ColorConfig) => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, { color: config });
      setShowColorPanel(false);
    } catch (error) {
      console.error('[ColorPanel] Failed to apply color config:', error);
      toast.error('应用条件填色失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  const handleClearColor = async () => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, { color: undefined });
      setShowColorPanel(false);
    } catch (error) {
      console.error('[ColorPanel] Failed to clear color config:', error);
      toast.error('清除条件填色失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  // Handle row height panel open
  const handleOpenRowHeight = () => {
    setShowRowHeightPanel(true);
  };

  const handleSaveRowHeightAsTemplate = (config: { rowHeight: RowHeightValue }) => {
    handleSaveFromPanel({ rowHeight: config.rowHeight });
  };

  // Handle row height apply
  const handleApplyRowHeight = async (config: { rowHeight: RowHeightValue }) => {
    if (!currentTable?.datasetId) return;

    try {
      await updateActiveQueryTemplate(currentTable.datasetId, { rowHeight: config.rowHeight });
      setCurrentRowHeight(config.rowHeight);
      setShowRowHeightPanel(false);
    } catch (error) {
      console.error('[RowHeightPanel] Failed to apply row height:', error);
      toast.error('应用行高失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  };

  // Handle export - 打开导出对话框
  const handleExport = async () => {
    if (!currentTable?.datasetId) return;
    setShowExportDialog(true);
  };

  // Handle export confirm - 实际执行导出
  const handleExportConfirm = async (options: ExportDialogOptions) => {
    if (!currentTable?.datasetId) return;

    setExportProgress(null);

    try {
      const willDeleteExportedRows =
        options.postExportAction === 'delete' && options.mode === 'data';

      if (willDeleteExportedRows) {
        const confirmed = window.confirm(
          '⚠️ 危险操作！\n\n' + '此操作将永久删除已导出的数据，无法恢复。\n\n' + '确定继续吗？'
        );
        if (!confirmed) {
          return;
        }
      }

      const hasSelectedRows = selectedRows.length > 0;
      const selectedRowIds = hasSelectedRows
        ? selectedRows.map((row) => row._row_id as number).filter((id) => id !== undefined)
        : undefined;

      const exportOutcome = await exportDatasetWithDialog({
        datasetId: currentTable.datasetId,
        datasetName: currentTable.name,
        options,
        selectedRowIds,
        activeQueryTemplate: activeQueryTemplate || undefined,
      });

      if (exportOutcome.canceled) {
        return;
      }

      if (willDeleteExportedRows) {
        setSelectedRows([]);
        const deletedCount =
          exportOutcome.result.deletedRows ||
          exportOutcome.result.totalRows ||
          (Array.isArray(exportOutcome.selectedRowIds) ? exportOutcome.selectedRowIds.length : 0);
        const canApplyLocalDelete =
          Array.isArray(exportOutcome.selectedRowIds) && exportOutcome.selectedRowIds.length > 0;

        if (canApplyLocalDelete) {
          const selectedRowIdsForDelete = exportOutcome.selectedRowIds as number[];
          const applied = applyLocalRecordDeletion(
            currentTable.datasetId,
            selectedRowIdsForDelete,
            {
              deletedCount,
            }
          );

          if (applied) {
            return;
          }
        }

        if (deletedCount > 0) {
          applyLocalDatasetCountDelta(currentTable.datasetId, -deletedCount);
        }
        await refreshDatasetView(currentTable.datasetId);
      }
    } catch (error) {
      console.error('[Export] Failed to export:', error);
      toast.error('导出失败', error instanceof Error ? error.message : String(error));
    } finally {
      setTimeout(() => setExportProgress(null), 2000);
    }
  };

  return (
    <div
      className="datasets-workspace shell-content-muted flex min-h-0 flex-1"
      data-datasets-viewport={workspaceViewportMetrics.tier}
    >
      {/* Left Sidebar */}
      <div
        className="shell-sidebar-surface flex shrink-0 flex-col border-r transition-[width] duration-300"
        style={{
          width: sidebarCollapsed
            ? workspaceViewportMetrics.sidebarCollapsedWidth
            : workspaceViewportMetrics.sidebarExpandedWidth,
        }}
      >
        <div className="min-h-0 flex-1">
          <DatasetSidebar
            categories={categories}
            selectedCategory={selectedCategory}
            selectedTableId={selectedTableId}
            onSelectCategory={handleSelectCategory}
            onSelectTable={handleSelectTable}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            onImportExcel={handleImportExcel}
            onCreateDataset={handleCreateDataset}
            onCreateFolder={handleCreateFolder}
            onDeleteCategory={handleDeleteCategory}
            onImportExcelToFolder={handleImportExcelToFolder}
            onCreateDatasetInFolder={handleCreateDatasetInFolder}
            onCreateSubfolder={handleCreateSubfolder}
            onDeleteTable={handleDeleteTable}
            deletingItemId={deletingItemId}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="shell-content-surface flex min-h-0 min-w-0 flex-1 flex-col">
        {showWorkspaceChrome && (
          <div className="datasets-workspace-chrome">
            {/* Group Tabs - 组内数据表切换 */}
            {showGroupTabs && (
              <div className="flex items-center overflow-x-auto">
                <DatasetTabs
                  tabs={groupTabs.map((tab) => ({
                    id: tab.datasetId,
                    name: tab.name,
                    isDefault: tab.isGroupDefault,
                  }))}
                  selectedTabId={selectedTabDatasetId}
                  onSelectTab={(datasetId: string) => {
                    void handleSelectTab(datasetId);
                  }}
                  onCreateTab={() => {
                    void handleCreateTabCopy();
                  }}
                  onRenameTab={(datasetId: string, newName: string) => {
                    void handleRenameTab(datasetId, newName);
                  }}
                  onDeleteTab={handleDeleteTab}
                  onReorder={handleReorderTabs}
                />
              </div>
            )}

            {/* Toolbar */}
            {showWorkspaceToolbar && currentTable && (
              <div>
                <DatasetToolbar
                  datasetId={currentTable.datasetId}
                  selectedRows={selectedRows}
                  onCreateTabCopy={
                    showToolbarCopyAction
                      ? () => {
                          void handleCreateTabCopy();
                        }
                      : undefined
                  }
                  onAddRecord={handleAddRecord}
                  onAddColumn={() => {
                    if (isDataReadOnly) {
                      toast.warning('数据未就绪，暂不支持添加列');
                      return;
                    }
                    setShowAddColumnDialog(true);
                  }}
                  onFilter={handleOpenFilter}
                  onGroup={handleOpenGroup}
                  onAggregate={handleOpenAggregate}
                  onSort={handleOpenSort}
                  onFillColor={handleOpenColor}
                  onClean={handleOpenClean}
                  onLookup={handleOpenLookup}
                  onDedupe={handleOpenDedupe}
                  onColumn={handleOpenColumn}
                  onSample={handleOpenSample}
                  onRowHeight={handleOpenRowHeight}
                  onExport={handleExport}
                  onRefreshData={() =>
                    currentTable?.datasetId && refreshDatasetView(currentTable.datasetId)
                  }
                  filterButtonRef={filterButtonRef}
                  groupButtonRef={groupButtonRef}
                  sortButtonRef={sortButtonRef}
                  fillColorButtonRef={fillColorButtonRef}
                  cleanButtonRef={cleanButtonRef}
                  dedupeButtonRef={dedupeButtonRef}
                  moreButtonRef={moreButtonRef}
                  readOnly={isDataReadOnly}
                />

                {/* 删除操作按钮区域（仅在有选中行时显示） */}
                {!isDataReadOnly && selectedRows.length > 0 && (
                  <div
                    className="shell-content-muted flex flex-wrap items-center gap-3 bg-white/55"
                    style={{
                      paddingInline: workspaceViewportMetrics.bulkBarPaddingInline,
                      paddingBlock: workspaceViewportMetrics.bulkBarPaddingBlock,
                    }}
                  >
                    <span className="shell-field-chip shell-field-chip--ghost px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
                      已选中 {selectedRows.length} 行
                    </span>
                    <button
                      onClick={handleDeleteRows}
                      className="shell-field-control shell-field-control--inline flex h-9 items-center gap-1.5 px-3.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50/85 hover:text-red-700"
                      title="永久删除选中的行（不可恢复）"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      永久删除选中 ({selectedRows.length})
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Data Table / Custom Page */}
        <div className="flex-1 flex flex-col bg-white min-h-0">
          {currentTable ? (
            <>
              {/* 根据表类型显示不同的内容 */}
              {currentTable.isCustomPage ? (
                <CustomPageViewer
                  page={currentTable.customPageInfo!}
                  datasetId={currentTable.datasetId}
                />
              ) : (
                <div
                  id={activeWorkspacePanelId}
                  role={showGroupTabs ? 'tabpanel' : undefined}
                  aria-labelledby={activeWorkspaceTabId}
                  className="min-h-0 flex flex-1 flex-col"
                >
                  <DatasetTable
                    datasetId={currentTable.datasetId}
                    rowHeight={currentRowHeight}
                    readOnly={isDataReadOnly}
                    onAddColumn={() => {
                      if (isDataReadOnly) {
                        toast.warning('数据未就绪，暂不支持添加列');
                        return;
                      }
                      setShowAddColumnDialog(true);
                    }}
                    onRowSelectionChange={(rows) => {
                      setSelectedRows(rows);
                    }}
                    showColumnManager={showColumnPanel}
                    onColumnManagerChange={setShowColumnPanel}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="shell-content-muted flex flex-1 items-center justify-center p-8">
              <div
                className="datasets-workspace-empty-state shell-soft-card text-center"
                style={{
                  maxWidth: workspaceViewportMetrics.emptyStateMaxWidth,
                  paddingInline: workspaceViewportMetrics.emptyStatePaddingInline,
                  paddingBlock: workspaceViewportMetrics.emptyStatePaddingBlock,
                }}
              >
                <p className="mb-2 text-lg font-semibold text-slate-900">
                  {currentEmptyStateTitle}
                </p>
                <p className="text-sm leading-6 text-slate-600">{currentEmptyStateDescription}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add Record Drawer */}
      <AddRecordDrawer
        isOpen={isAddRecordDrawerOpen}
        onClose={() => setIsAddRecordDrawerOpen(false)}
        datasetId={currentTable?.datasetId || ''}
        readOnly={isDataReadOnly}
        onSubmitSuccess={handleRecordSubmitSuccess}
      />

      {/* Import Progress Dialog */}
      {showImportProgress && (
        <div className="shell-floating-backdrop fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="shell-floating-panel mx-4 flex w-full flex-col overflow-hidden"
            style={{
              maxWidth: workspaceViewportMetrics.importPanelMaxWidth,
              maxHeight: workspaceViewportMetrics.importPanelMaxHeight,
            }}
          >
            <div className="shell-floating-panel__header px-6 py-5">
              <h3 className="text-lg font-semibold text-slate-900">导入进度</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                批量导入任务会以紧凑列表显示，便于快速查看状态、进度和异常。
              </p>
            </div>
            <div className="min-h-0 space-y-3 overflow-y-auto px-6 py-5">
              {/* 🆕 如果没有进度数据，显示加载提示 */}
              {importProgressEntries.length === 0 && (
                <div className="shell-soft-card flex flex-col items-center justify-center gap-3 border-dashed px-6 py-8 text-center">
                  <div className="shell-field-chip shell-field-chip--ghost flex h-11 w-11 items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-sky-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">正在启动导入...</p>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      正在连接导入流程并等待首个进度事件。
                    </p>
                  </div>
                  <button
                    onClick={() => setShowImportProgress(false)}
                    className="shell-field-control mt-1 inline-flex h-9 items-center px-3.5 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
                  >
                    取消
                  </button>
                </div>
              )}

              {/* 原有的进度显示 */}
              {importProgressEntries.map(([datasetId, progress]) => {
                const isFailed = progress.status === 'failed';
                const isCompleted = progress.status === 'completed';
                const isActive = progress.status === 'importing' || progress.status === 'pending';
                const statusLabel =
                  progress.status === 'pending'
                    ? '排队中'
                    : progress.status === 'importing'
                      ? `${Math.round(progress.progress)}%`
                      : progress.status === 'completed'
                        ? '完成'
                        : '失败';
                const statusClass = isFailed
                  ? 'border-red-200 bg-red-50/85 text-red-700'
                  : isCompleted
                    ? 'border-emerald-200 bg-emerald-50/85 text-emerald-700'
                    : 'border-sky-200 bg-sky-50/85 text-sky-700';

                return (
                  <div
                    key={datasetId}
                    className={`shell-soft-card space-y-3 border p-4 ${
                      isFailed
                        ? 'border-red-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(255,246,246,0.95))]'
                        : isCompleted
                          ? 'border-emerald-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,253,247,0.95))]'
                          : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{datasetId}</p>
                        {progress.message && (
                          <p className="mt-1 text-xs leading-5 text-slate-600">
                            {progress.message}
                          </p>
                        )}
                      </div>
                      <span
                        className={`shell-field-chip shell-field-chip--ghost shrink-0 border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${statusClass}`}
                      >
                        {statusLabel}
                      </span>
                    </div>

                    {isActive && (
                      <>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/90">
                          <div
                            className="h-2 rounded-full bg-sky-600 transition-all duration-300"
                            style={{ width: `${progress.progress}%` }}
                          />
                        </div>
                        {progress.rowsProcessed !== undefined && (
                          <p className="text-xs text-slate-500">
                            已处理 {progress.rowsProcessed.toLocaleString()} 行
                          </p>
                        )}
                      </>
                    )}

                    {isFailed && progress.error && (
                      <div className="rounded-xl border border-red-200 bg-red-50/80 px-3 py-2 text-xs leading-5 text-red-700">
                        {progress.error}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 🆕 只有当有进度数据且全部完成时才显示关闭按钮 */}
            {allImportsSettled && (
              <div className="shell-floating-panel__footer px-6 py-4">
                <button
                  onClick={() => setShowImportProgress(false)}
                  className="shell-field-control inline-flex h-10 w-full items-center justify-center px-4 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
                >
                  关闭
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Filter Panel */}
      {showFilterPanel && currentTable && (
        <FilterPanel
          datasetId={currentTable.datasetId}
          onClose={() => setShowFilterPanel(false)}
          onSaveAsTemplate={handleSaveFilterAsTemplate}
          anchorEl={filterButtonRef.current}
        />
      )}

      {/* Aggregate Panel */}
      {showAggregatePanel && currentTable && (
        <AggregatePanel
          datasetId={currentTable.datasetId}
          onClose={() => setShowAggregatePanel(false)}
          onApply={handleApplyAggregate}
          onClear={handleClearAggregate}
          onSaveAsTemplate={handleSaveAggregateAsTemplate}
          anchorEl={moreButtonRef.current}
        />
      )}

      {/* Clean Panel */}
      {showCleanPanel && currentTable && (
        <CleanPanel
          datasetId={currentTable.datasetId}
          onClose={() => setShowCleanPanel(false)}
          onApply={handleApplyClean}
          onSaveAsTemplate={handleSaveCleanAsTemplate}
          onClear={handleClearClean}
          anchorEl={cleanButtonRef.current}
        />
      )}

      {/* Lookup Panel */}
      {showLookupPanel && currentTable && (
        <LookupPanel
          datasetId={currentTable.datasetId}
          onClose={() => setShowLookupPanel(false)}
          onApply={handleApplyLookup}
          anchorEl={moreButtonRef.current}
        />
      )}

      {/* Dedupe Panel */}
      {showDedupePanel && currentTable && (
        <DedupePanel
          datasetId={currentTable.datasetId}
          onClose={() => setShowDedupePanel(false)}
          onApply={handleApplyDedupe}
          onSaveAsTemplate={handleSaveDedupeAsTemplate}
          onClear={handleClearDedupe}
          anchorEl={dedupeButtonRef.current}
          readOnly={isDataReadOnly}
        />
      )}

      {/* Sort Panel */}
      {showSortPanel && currentTable && (
        <SortPanel
          datasetId={currentTable.datasetId}
          onClose={() => setShowSortPanel(false)}
          onSaveAsTemplate={handleSaveSortAsTemplate}
          anchorEl={sortButtonRef.current}
        />
      )}

      {/* Sample Panel */}
      {showSamplePanel && currentTable && (
        <SamplePanel
          datasetId={currentTable.datasetId}
          onClose={() => setShowSamplePanel(false)}
          onApply={handleApplySample}
          onSaveAsTemplate={handleSaveSampleAsTemplate}
          onClear={handleClearSample}
          anchorEl={moreButtonRef.current}
        />
      )}

      {/* Group Panel */}
      {showGroupPanel && currentTable && (
        <GroupPanel
          columns={panelColumns}
          onClose={() => setShowGroupPanel(false)}
          onApply={handleApplyGroup}
          anchorEl={groupButtonRef.current}
        />
      )}

      {/* Color Panel */}
      {showColorPanel && currentTable && (
        <ColorPanel
          columns={panelColumns}
          onClose={() => setShowColorPanel(false)}
          onApply={handleApplyColor}
          onClear={handleClearColor}
          onSaveAsTemplate={handleSaveColorAsTemplate}
          anchorEl={fillColorButtonRef.current}
        />
      )}

      {/* Row Height Panel */}
      {showRowHeightPanel && currentTable && (
        <RowHeightPanel
          currentHeight={currentRowHeight}
          onClose={() => setShowRowHeightPanel(false)}
          onApply={handleApplyRowHeight}
          onSaveAsTemplate={handleSaveRowHeightAsTemplate}
          anchorEl={moreButtonRef.current}
        />
      )}

      {/* Add Column Dialog */}
      {currentTable && (
        <AddColumnDialog
          open={showAddColumnDialog && !isDataReadOnly}
          onClose={() => setShowAddColumnDialog(false)}
          datasetId={currentTable.datasetId}
          existingColumns={currentDataset?.schema?.map((col) => col.name) || []}
          onSuccess={async () => {
            setShowAddColumnDialog(false);
          }}
        />
      )}

      {/* Save Query Template Dialog */}
      <SaveQueryTemplateDialog
        isOpen={showSaveQueryTemplateDialog}
        onClose={() => {
          setShowSaveQueryTemplateDialog(false);
          setPendingQueryConfig(null);
        }}
        onSave={async (name: string, description?: string, icon?: string) => {
          await handleSaveQueryTemplate(name, icon, description);
        }}
      />

      {/* Export Dialog */}
      <ExportDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        onExport={handleExportConfirm}
        datasetName={currentTable?.name || '未知数据集'}
        totalRows={
          // 🆕 优先级：选中行数 > 筛选后行数 > 总行数
          selectedRows.length > 0
            ? selectedRows.length // 有选中行 → 显示选中行数
            : (queryResult?.filteredTotalCount ?? currentTable?.rowCount ?? 0) // 无选中 → 显示筛选或总行数
        }
        hasHiddenColumns={effectiveHiddenColumns.length > 0}
        availableColumns={exportAvailableColumns}
        hiddenColumns={effectiveHiddenColumns}
      />

      {/* Analyzing Types Loading Indicator */}
      <LoadingOverlay open={isAnalyzingTypes} message="正在分析字段类型..." size="sm" />

      {/* Export Progress Indicator */}
      {exportProgress && (
        <div className="shell-floating-panel fixed bottom-4 right-4 z-50 min-w-[320px] p-4">
          <div className="flex items-center space-x-3">
            {/* Icon */}
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 animate-spin text-sky-600"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              {/* Message */}
              <div className="mb-1 text-sm font-medium text-slate-900">
                {exportProgress.message}
              </div>

              {/* Progress Bar */}
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-2 rounded-full bg-sky-600 transition-all duration-300 ease-out"
                  style={{ width: `${exportProgress.percentage}%` }}
                />
              </div>

              {/* Percentage */}
              <div className="mt-1 text-xs text-slate-500">
                {exportProgress.percentage}%
                {exportProgress.total > 1 && ` (${exportProgress.current}/${exportProgress.total})`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🆕 删除确认弹窗 */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !deletingItemId) {
            setDeleteConfirmOpen(false);
            setDeleteFolderContents(false);
            setDeleteTarget(null);
          }
        }}
        title={deleteTarget?.type === 'folder' ? '删除文件夹' : '删除数据表'}
        description={
          deleteTarget?.type === 'folder'
            ? deleteFolderContents
              ? `确定要删除文件夹 "${deleteTarget?.name}" 吗？目录中的数据表和子文件夹都会被永久删除。`
              : `确定要删除文件夹 "${deleteTarget?.name}" 吗？文件夹内的表会被保留并移动到根目录。`
            : `确定要删除数据表 "${deleteTarget?.name}" 吗？这将永久删除所有数据。`
        }
        confirmText={
          deleteTarget?.type === 'folder' && deleteFolderContents ? '删除文件夹及内容' : '删除'
        }
        cancelText="取消"
        variant="danger"
        icon={<Trash2 className="w-5 h-5" />}
        loading={deletingItemId !== null}
        onConfirm={executeDelete}
      >
        {deleteTarget?.type === 'folder' && !deleteTarget.pluginId ? (
          <label className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50/70 px-3 py-3 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-red-300 text-red-600 focus:ring-red-500"
              checked={deleteFolderContents}
              onChange={(event) => setDeleteFolderContents(event.target.checked)}
            />
            <span>同时删除该目录下的所有数据表和子文件夹</span>
          </label>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
