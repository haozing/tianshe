import { useCallback, useEffect, useMemo } from 'react';
import { toast } from '../../lib/toast';
import { datasetFacade } from '../../services/datasets/datasetFacade';
import { workspaceFacade } from '../../services/datasets/workspaceFacade';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useDatasetStore } from '../../stores/datasetStore';
import type {
  ExportOptions as ExportRequest,
  ExportPathParams,
  ExportResult as ExportResponse,
} from '../../../../types/electron';
import type { ExportDialogOptions } from './ExportDialog';
import type { TableInfo } from './types';
import {
  buildWorkspaceCategories,
  getDatasetIdFromTableId,
  toTableId,
  type DatasetMeta,
  type WorkspaceSnapshot,
} from '../../services/datasets/workspaceCategoryService';

export function useDatasetsWorkspaceController() {
  const electronAPI = useElectronAPI();
  const {
    datasets,
    loadDatasets,
    isImportProcessed,
    markImportAsProcessed,
    currentGroupId,
    groupTabs,
    selectedTabDatasetId,
    selectGroupTab,
    loadGroupTabs,
    setGroupTabs,
    clearGroupTabs,
    resetQueryTemplateState,
    deleteDataset,
    importDatasetFile: startImportDatasetFile,
    workspaceCategories: categories,
    selectedCategory,
    selectedTableId,
    isAnalyzingTypes,
    setWorkspaceCategories,
    syncWorkspaceCategoryMetadata: syncStoredWorkspaceCategoryMetadata,
    selectWorkspaceCategory,
    selectWorkspaceTable,
    selectWorkspaceDataset,
    clearWorkspaceSelection,
    resetWorkspaceViewState,
    setWorkspaceAnalyzingTypes,
    reconcileWorkspaceSelection,
  } = useDatasetStore();

  const currentCategory = useMemo(
    () => categories.find((category) => category.id === selectedCategory) || null,
    [categories, selectedCategory]
  );

  const currentTable = useMemo(() => {
    if (currentCategory?.tables) {
      const matched = currentCategory.tables.find((table) => table.id === selectedTableId);
      if (matched) {
        return matched;
      }
    }

    const selectedDatasetId = getDatasetIdFromTableId(selectedTableId);
    if (!selectedDatasetId) {
      return null;
    }

    const dataset = datasets.find((item) => item.id === selectedDatasetId);
    if (!dataset) {
      return null;
    }

    return {
      id: toTableId(dataset.id),
      name: dataset.name,
      datasetId: dataset.id,
      rowCount: dataset.rowCount,
      columnCount: dataset.columnCount,
    } satisfies TableInfo;
  }, [currentCategory, datasets, selectedTableId]);

  const refreshWorkspace = useCallback(async (): Promise<WorkspaceSnapshot> => {
    await loadDatasets();
    const nextDatasets = useDatasetStore.getState().datasets as DatasetMeta[];
    const nextCategories = await buildWorkspaceCategories(nextDatasets);
    setWorkspaceCategories(nextCategories);
    useDatasetStore.getState().reconcileWorkspaceSelection();
    return {
      datasets: nextDatasets,
      categories: nextCategories,
    };
  }, [loadDatasets, setWorkspaceCategories]);

  const selectDataset = useCallback(
    (datasetId: string, preferredCategoryId?: string | null, snapshot?: WorkspaceSnapshot) => {
      selectWorkspaceDataset(datasetId, preferredCategoryId, snapshot);
    },
    [selectWorkspaceDataset]
  );

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  useEffect(() => {
    return () => {
      clearGroupTabs();
      resetWorkspaceViewState();
    };
  }, [clearGroupTabs, resetWorkspaceViewState]);

  useEffect(() => {
    syncStoredWorkspaceCategoryMetadata();
  }, [datasets, syncStoredWorkspaceCategoryMetadata]);

  useEffect(() => {
    reconcileWorkspaceSelection();
  }, [
    categories,
    datasets,
    groupTabs,
    reconcileWorkspaceSelection,
    selectedCategory,
    selectedTabDatasetId,
    selectedTableId,
  ]);

  useEffect(() => {
    let mounted = true;

    const syncGroupTabs = async () => {
      if (!currentTable?.datasetId || currentTable.isCustomPage) {
        if (mounted) {
          clearGroupTabs();
        }
        return;
      }

      resetQueryTemplateState();
      selectGroupTab(currentTable.datasetId);
      await loadGroupTabs(currentTable.datasetId);
    };

    void syncGroupTabs();

    return () => {
      mounted = false;
    };
  }, [
    clearGroupTabs,
    currentTable?.datasetId,
    currentTable?.isCustomPage,
    loadGroupTabs,
    resetQueryTemplateState,
    selectGroupTab,
  ]);

  const analyzeImportedDataset = useCallback(
    async (datasetId: string) => {
      if (isImportProcessed(datasetId)) {
        return;
      }

      setWorkspaceAnalyzingTypes(true);

      try {
        await new Promise((resolve) => setTimeout(resolve, 300));

        const result = await datasetFacade.analyzeTypes(datasetId);
        if (!result.success || !result.schema || !result.sampleData) {
          console.error('[Import] Type analysis failed:', result.error);
          toast.error('类型分析失败', result.error || '未知错误');
          return;
        }

        const applyResult = await datasetFacade.applySchema(datasetId, result.schema);
        if (!applyResult.success) {
          console.error('[Import] Failed to apply schema:', applyResult.error);
          toast.error('应用字段类型失败', applyResult.error || '未知错误');
          return;
        }

        markImportAsProcessed(datasetId);
        useDatasetStore.getState().applyLocalDatasetSchema(datasetId, result.schema as any);
      } catch (error) {
        console.error('[Import] Type analysis error:', error);
        toast.error('类型分析错误', error instanceof Error ? error.message : '未知错误');
      } finally {
        setWorkspaceAnalyzingTypes(false);
      }
    },
    [isImportProcessed, markImportAsProcessed, setWorkspaceAnalyzingTypes]
  );

  const importDataset = useCallback(
    async (options?: { folderId?: string | null }): Promise<boolean> => {
      const folderId = options?.folderId ?? null;
      const selectResponse = await datasetFacade.selectImportFile();
      if (selectResponse.canceled) {
        return false;
      }

      if (!selectResponse.success || !selectResponse.filePath) {
        throw new Error(selectResponse.error || '选择文件失败');
      }

      const fileName = selectResponse.filePath.split(/[/\\]/).pop() || 'dataset';
      const datasetName = fileName.replace(/\.(csv|xlsx?|xls|json)$/i, '');

      let datasetId: string | null = null;

      try {
        datasetId = await startImportDatasetFile(selectResponse.filePath, datasetName, {
          folderId,
        });
        await analyzeImportedDataset(datasetId);

        return true;
      } finally {
        if (datasetId) {
          const snapshot = await refreshWorkspace();
          selectDataset(datasetId, folderId, snapshot);
        }
      }
    },
    [analyzeImportedDataset, refreshWorkspace, selectDataset, startImportDatasetFile]
  );

  const createDataset = useCallback(
    async (folderId?: string | null) => {
      const datasetName = `Sheet${datasets.length + 1}`;
      const response = await datasetFacade.createEmptyDataset(datasetName, { folderId });
      if (!response.success || !response.datasetId) {
        throw new Error(response.error || 'Failed to create dataset');
      }

      const snapshot = await refreshWorkspace();
      selectDataset(response.datasetId, folderId, snapshot);
      return response.datasetId;
    },
    [datasets.length, refreshWorkspace, selectDataset]
  );

  const createFolder = useCallback(
    async (name: string, parentId?: string | null, pluginId?: string | null, options?: any) => {
      const response = await workspaceFacade.createFolder(
        name,
        parentId || undefined,
        pluginId || undefined,
        options
      );
      if (!response.success) {
        throw new Error(response.error || 'Failed to create folder');
      }

      await refreshWorkspace();
      return response.folderId as string | undefined;
    },
    [refreshWorkspace]
  );

  const deleteDatasetAndRefresh = useCallback(
    async (datasetId: string) => {
      const success = await deleteDataset(datasetId);
      if (success) {
        await refreshWorkspace();
      }
      return success;
    },
    [deleteDataset, refreshWorkspace]
  );

  const deleteFolderAndRefresh = useCallback(
    async (folderId: string, deleteContents = false) => {
      const response = await workspaceFacade.deleteFolder(folderId, deleteContents);
      if (!response.success) {
        throw new Error(response.error || 'Failed to delete folder');
      }
      await refreshWorkspace();
      return true;
    },
    [refreshWorkspace]
  );

  const createGroupTabCopy = useCallback(
    async (datasetId: string, preferredCategoryId?: string | null, newName?: string) => {
      const result = await datasetFacade.createGroupTabCopy(datasetId, newName);
      if (!result.success || !result.datasetId) {
        throw new Error(result.error || 'Failed to duplicate dataset');
      }

      selectGroupTab(result.datasetId);
      const snapshot = await refreshWorkspace();
      selectDataset(result.datasetId, preferredCategoryId, snapshot);
      return result.datasetId;
    },
    [refreshWorkspace, selectDataset, selectGroupTab]
  );

  const renameGroupTab = useCallback(
    async (datasetId: string, newName: string, preferredCategoryId?: string | null) => {
      const response = await datasetFacade.renameGroupTab(datasetId, newName);
      if (!response.success) {
        throw new Error(response.error || '重命名数据表失败');
      }

      const snapshot = await refreshWorkspace();
      selectDataset(selectedTabDatasetId || datasetId, preferredCategoryId, snapshot);
    },
    [refreshWorkspace, selectDataset, selectedTabDatasetId]
  );

  const reorderGroupTabs = useCallback(
    async (tabDatasetIds: string[]) => {
      if (!currentTable?.datasetId || groupTabs.length <= 1) {
        return;
      }

      const groupId = currentGroupId || groupTabs[0]?.tabGroupId;
      if (!groupId) {
        return;
      }

      const currentIds = groupTabs.map((tab) => tab.datasetId);
      const currentIdSet = new Set(currentIds);
      const uniqueIds = new Set(tabDatasetIds);
      const hasInvalidPayload =
        tabDatasetIds.length !== currentIds.length ||
        uniqueIds.size !== tabDatasetIds.length ||
        tabDatasetIds.some((id) => !currentIdSet.has(id));

      if (hasInvalidPayload) {
        throw new Error('非法排序数据');
      }

      const previousTabs = [...groupTabs];
      const tabById = new Map(groupTabs.map((tab) => [tab.datasetId, tab] as const));
      const reorderedTabs = tabDatasetIds
        .map((id, index) => {
          const tab = tabById.get(id);
          if (!tab) return null;
          return { ...tab, tabOrder: index };
        })
        .filter((item): item is NonNullable<typeof item> => !!item);

      if (reorderedTabs.length > 0) {
        setGroupTabs(reorderedTabs);
      }

      try {
        const response = await datasetFacade.reorderGroupTabs(groupId, tabDatasetIds);
        if (!response.success) {
          throw new Error(response.error || '调整顺序失败');
        }

        const tabsResponse = await datasetFacade.listGroupTabs(currentTable.datasetId);
        if (tabsResponse.success && tabsResponse.tabs) {
          setGroupTabs(tabsResponse.tabs);
        }
      } catch (error) {
        setGroupTabs(previousTabs);
        throw error;
      }
    },
    [currentGroupId, currentTable?.datasetId, groupTabs, setGroupTabs]
  );

  const deleteRows = useCallback(async (datasetId: string, rowIds: number[]) => {
    const result = await datasetFacade.hardDeleteRows({ datasetId, rowIds });

    if (!result.success) {
      throw new Error(result.error || 'Failed to delete rows');
    }

    return {
      deletedCount: result.deletedCount ?? rowIds.length,
    };
  }, []);

  const exportDatasetWithDialog = useCallback(
    async (params: {
      datasetId: string;
      datasetName?: string | null;
      options: ExportDialogOptions;
      selectedRowIds?: number[];
      activeQueryTemplate?: ExportRequest['activeQueryTemplate'];
    }) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const defaultFileName = `${params.datasetName || 'export'}_${timestamp}.${params.options.format}`;

      const pathResult = await electronAPI.duckdb.selectExportPath({
        defaultFileName,
        format: params.options.format,
      } satisfies ExportPathParams);

      if (pathResult.canceled || !pathResult.filePath) {
        return { canceled: true as const };
      }

      if (!pathResult.success) {
        throw new Error('Failed to select export path');
      }

      const hasSelectedRows =
        Array.isArray(params.selectedRowIds) && params.selectedRowIds.length > 0;
      const shouldApplyQueryView = Boolean(params.activeQueryTemplate?.queryConfig);

      const result = await electronAPI.duckdb.exportDataset({
        datasetId: params.datasetId,
        format: params.options.format,
        outputPath: pathResult.filePath,
        mode: params.options.mode,
        includeHeader: true,
        respectHiddenColumns: params.options.respectHiddenColumns,
        columns: params.options.columns,
        selectedRowIds: hasSelectedRows ? params.selectedRowIds : undefined,
        applyFilters: shouldApplyQueryView,
        applySort: shouldApplyQueryView,
        applySample: shouldApplyQueryView,
        postExportAction: params.options.postExportAction,
        activeQueryTemplate: shouldApplyQueryView ? params.activeQueryTemplate : undefined,
      } satisfies ExportRequest);

      if (!result.success) {
        throw new Error(result.error || 'Failed to export dataset');
      }

      return {
        canceled: false as const,
        outputPath: pathResult.filePath,
        result: result as ExportResponse,
        selectedRowIds: hasSelectedRows ? params.selectedRowIds : undefined,
      };
    },
    [electronAPI.duckdb]
  );

  const selectCategory = useCallback(
    (categoryId: string) => {
      selectWorkspaceCategory(categoryId);
    },
    [selectWorkspaceCategory]
  );

  const selectTable = useCallback(
    (tableId: string) => {
      selectWorkspaceTable(tableId);
    },
    [selectWorkspaceTable]
  );

  const clearSelection = useCallback(() => {
    clearWorkspaceSelection();
  }, [clearWorkspaceSelection]);

  return {
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
  };
}
