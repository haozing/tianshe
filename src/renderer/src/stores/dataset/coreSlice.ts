import { datasetFacade } from '../../services/datasets/datasetFacade';
import {
  bindActiveQueryTemplateState,
  getActiveQueryTemplateFromState,
  type DatasetQueryRuntimeHelpers,
  type DatasetQueryRuntimeState,
} from './queryRuntimeSlice';
import { clearGroupTabState, type GroupTabInfo } from './workspaceSlice';
import type { DatasetInfo } from './types';

let datasetInfoRequestSerial = 0;

export interface DatasetCoreState extends DatasetQueryRuntimeState {
  datasets: DatasetInfo[];
  currentDataset: DatasetInfo | null;
  datasetInfoRequestId: number;
  currentGroupId: string | null;
  groupTabs: GroupTabInfo[];
  selectedTabDatasetId: string | null;
  getDatasetInfo: (id: string) => Promise<void>;
  refreshActiveQueryTemplate: (datasetId: string) => Promise<void>;
}

export interface DatasetCoreActions {
  loadDatasets: () => Promise<void>;
  getDatasetInfo: (id: string) => Promise<void>;
  refreshDatasetView: (id: string, options?: { refreshSchema?: boolean }) => Promise<void>;
  deleteDataset: (id: string) => Promise<boolean>;
  renameDataset: (id: string, newName: string) => Promise<boolean>;
  setCurrentDataset: (dataset: DatasetInfo | null) => void;
  clearError: () => void;
}

type DatasetCoreSet<TState extends DatasetCoreState> = (
  partial: Partial<TState> | TState | ((state: TState) => Partial<TState> | TState)
) => void;

type DatasetCoreGet<TState extends DatasetCoreState> = () => TState;

type DatasetCoreRuntimeHelpers<TState extends DatasetCoreState> = Pick<
  DatasetQueryRuntimeHelpers<TState>,
  'clearDatasetViewState'
>;

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function createDatasetCoreSlice<TState extends DatasetCoreState>(
  set: DatasetCoreSet<TState>,
  get: DatasetCoreGet<TState>,
  runtimeHelpers: DatasetCoreRuntimeHelpers<TState>
): DatasetCoreActions {
  const isLatestDatasetInfoRequest = (requestId: number) =>
    get().datasetInfoRequestId === requestId;

  const beginDatasetInfoRequest = () => {
    const requestId = ++datasetInfoRequestSerial;
    set({ datasetInfoRequestId: requestId, loading: true, error: null } as Partial<TState>);
    return requestId;
  };

  const loadDatasets = async () => {
    set({ loading: true, error: null } as Partial<TState>);
    try {
      const response = await datasetFacade.listDatasets();
      if (response.success && response.datasets) {
        set({ datasets: response.datasets as DatasetInfo[], loading: false } as Partial<TState>);
      } else {
        set({
          error: response.error || 'Failed to load datasets',
          loading: false,
        } as Partial<TState>);
      }
    } catch (error: unknown) {
      set({ error: getErrorMessage(error, 'Failed to load datasets'), loading: false } as Partial<TState>);
    }
  };

  const getDatasetInfo = async (id: string) => {
    const requestId = beginDatasetInfoRequest();

    try {
      const response = await datasetFacade.getDatasetInfo(id);
      if (!isLatestDatasetInfoRequest(requestId)) {
        return;
      }

      if (response.success && response.dataset) {
        const dataset = response.dataset as DatasetInfo;

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

        set({ currentDataset: dataset, loading: false } as Partial<TState>);
      } else {
        console.error('[datasetStore] Failed to get dataset info:', response.error);
        set({
          error: response.error || 'Dataset not found',
          loading: false,
        } as Partial<TState>);
      }
    } catch (error: unknown) {
      if (!isLatestDatasetInfoRequest(requestId)) {
        return;
      }
      console.error('[datasetStore] Exception in getDatasetInfo:', error);
      set({ error: getErrorMessage(error, 'Dataset not found'), loading: false } as Partial<TState>);
    }
  };

  const refreshDatasetView = async (
    id: string,
    options: { refreshSchema?: boolean } = {}
  ) => {
    if (options.refreshSchema !== false) {
      await getDatasetInfo(id);
    }

    await get().refreshActiveQueryTemplate(id);
  };

  const deleteDataset = async (id: string) => {
    set({ loading: true, error: null } as Partial<TState>);
    try {
      const response = await datasetFacade.deleteDataset(id);
      if (response.success) {
        set((state) => {
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
            datasets: state.datasets.filter((dataset) => dataset.id !== id),
            currentDataset: deletingActiveDataset
              ? null
              : state.currentDataset?.id === id
                ? null
                : state.currentDataset,
            ...(deletingActiveDataset
              ? runtimeHelpers.clearDatasetViewState()
              : activeTemplate?.datasetId === id
                ? bindActiveQueryTemplateState(null)
                : {}),
            ...nextGroupTabState,
            loading: false,
          } as Partial<TState>;
        });
        return true;
      }

      set({
        error: response.error || 'Failed to delete dataset',
        loading: false,
      } as Partial<TState>);
      return false;
    } catch (error: unknown) {
      set({ error: getErrorMessage(error, 'Failed to delete dataset'), loading: false } as Partial<TState>);
      return false;
    }
  };

  const renameDataset = async (id: string, newName: string) => {
    set({ loading: true, error: null } as Partial<TState>);
    try {
      const response = await datasetFacade.renameDataset(id, newName);
      if (response.success) {
        set((state) =>
          ({
            datasets: state.datasets.map((dataset) =>
              dataset.id === id ? { ...dataset, name: newName } : dataset
            ),
            currentDataset:
              state.currentDataset?.id === id
                ? { ...state.currentDataset, name: newName }
                : state.currentDataset,
            loading: false,
          }) as Partial<TState>
        );
        return true;
      }

      set({
        error: response.error || 'Failed to rename dataset',
        loading: false,
      } as Partial<TState>);
      return false;
    } catch (error: unknown) {
      set({ error: getErrorMessage(error, 'Failed to rename dataset'), loading: false } as Partial<TState>);
      return false;
    }
  };

  return {
    loadDatasets,
    getDatasetInfo,
    refreshDatasetView,
    deleteDataset,
    renameDataset,
    setCurrentDataset: (dataset: DatasetInfo | null) => {
      set({ currentDataset: dataset } as Partial<TState>);
    },
    clearError: () => {
      set({ error: null } as Partial<TState>);
    },
  };
}
