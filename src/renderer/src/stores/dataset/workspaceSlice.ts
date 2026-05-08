import type { DatasetCategory } from '../../components/DatasetsPage/types';
import { datasetFacade } from '../../services/datasets/datasetFacade';
import { createRendererLogger } from '../../lib/logger';
import {
  getDatasetIdFromTableId,
  syncWorkspaceCategoryMetadata as syncWorkspaceCategoriesWithDatasets,
  toTableId,
  type DatasetMeta,
  type WorkspaceSnapshot,
  shouldShowInSidebar,
} from '../../services/datasets/workspaceCategoryService';

const logger = createRendererLogger('DatasetStore');

export type { WorkspaceSnapshot };

export interface GroupTabInfo {
  datasetId: string;
  tabGroupId: string;
  name: string;
  rowCount: number;
  columnCount: number;
  tabOrder: number;
  isGroupDefault: boolean;
}

export interface DatasetWorkspaceState {
  datasets: DatasetMeta[];
  error: string | null;
  currentGroupId: string | null;
  groupTabs: GroupTabInfo[];
  selectedTabDatasetId: string | null;
  workspaceCategories: DatasetCategory[];
  selectedCategory: string | null;
  selectedTableId: string | null;
  isAnalyzingTypes: boolean;
}

export interface DatasetWorkspaceActions {
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
}

type DatasetWorkspaceSet<TState extends DatasetWorkspaceState> = (
  partial: Partial<TState> | TState | ((state: TState) => Partial<TState> | TState)
) => void;

type DatasetWorkspaceGet<TState extends DatasetWorkspaceState> = () => TState;

const toPartial = <TState extends DatasetWorkspaceState>(
  partial: Partial<DatasetWorkspaceState>
) => partial as unknown as Partial<TState>;

export const clearGroupTabState = () => ({
  currentGroupId: null,
  groupTabs: [],
  selectedTabDatasetId: null,
});

function resolveWorkspaceCategoryIdForDataset<TState extends DatasetWorkspaceState>(
  state: TState,
  datasetId: string,
  preferredCategoryId?: string | null,
  snapshot?: WorkspaceSnapshot
) {
  const activeCategories = snapshot?.categories ?? state.workspaceCategories;
  const activeDatasets = snapshot?.datasets ?? state.datasets;
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
}

export function createDatasetWorkspaceSlice<TState extends DatasetWorkspaceState>(
  set: DatasetWorkspaceSet<TState>,
  get: DatasetWorkspaceGet<TState>
): DatasetWorkspaceActions {
  return {
    loadGroupTabs: async (datasetId: string) => {
      if (!datasetId) {
        set(toPartial<TState>(clearGroupTabState()));
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
          set(toPartial<TState>(clearGroupTabState()));
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
        } as Partial<TState>);
      } catch (error: unknown) {
        logger.error('Failed to load group tabs', {
          operation: 'dataset.groupTabs.load',
          datasetId,
          error,
        });
        set(
          toPartial<TState>({
            ...clearGroupTabState(),
            error: error instanceof Error ? error.message : String(error),
          })
        );
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
      } as Partial<TState>);
    },

    selectGroupTab: (datasetId: string | null) => {
      set({ selectedTabDatasetId: datasetId } as Partial<TState>);
    },

    clearGroupTabs: () => {
      set(toPartial<TState>(clearGroupTabState()));
    },

    setWorkspaceCategories: (categories: DatasetCategory[]) => {
      set({ workspaceCategories: categories } as Partial<TState>);
    },

    syncWorkspaceCategoryMetadata: () => {
      set((state) =>
        ({
          workspaceCategories: syncWorkspaceCategoriesWithDatasets(
            state.workspaceCategories,
            state.datasets
          ),
        }) as Partial<TState>
      );
    },

    selectWorkspaceCategory: (categoryId: string | null) => {
      set({
        selectedCategory: categoryId,
        selectedTableId: null,
      } as Partial<TState>);
    },

    selectWorkspaceTable: (tableId: string | null) => {
      set({ selectedTableId: tableId } as Partial<TState>);
    },

    selectWorkspaceDataset: (
      datasetId: string,
      preferredCategoryId?: string | null,
      snapshot?: WorkspaceSnapshot
    ) => {
      const state = get();
      set({
        selectedCategory: resolveWorkspaceCategoryIdForDataset(
          state,
          datasetId,
          preferredCategoryId,
          snapshot
        ),
        selectedTableId: toTableId(datasetId),
      } as Partial<TState>);
    },

    clearWorkspaceSelection: () => {
      set({
        selectedCategory: null,
        selectedTableId: null,
      } as Partial<TState>);
    },

    resetWorkspaceViewState: () => {
      set(
        toPartial<TState>({
          workspaceCategories: [],
          selectedCategory: null,
          selectedTableId: null,
          isAnalyzingTypes: false,
        })
      );
    },

    setWorkspaceAnalyzingTypes: (value: boolean) => {
      set({ isAnalyzingTypes: value } as Partial<TState>);
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
          } as Partial<TState>;
        }

        if (!selectedCategory) {
          return selectedTableId === null
            ? state
            : ({ selectedTableId: null } as Partial<TState>);
        }

        const category = workspaceCategories.find((item) => item.id === selectedCategory);
        if (!category || category.tables.length === 0) {
          return selectedTableId === null
            ? state
            : ({ selectedTableId: null } as Partial<TState>);
        }

        if (selectedTableId && category.tables.some((table) => table.id === selectedTableId)) {
          return state;
        }

        const selectedDatasetId = getDatasetIdFromTableId(selectedTableId);
        const selectedDatasetMeta = selectedDatasetId
          ? state.datasets.find((item) => item.id === selectedDatasetId)
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
          return selectedTableId === null
            ? state
            : ({ selectedTableId: null } as Partial<TState>);
        }

        return {
          selectedTableId: category.tables[0]?.id ?? null,
        } as Partial<TState>;
      });
    },
  };
}
