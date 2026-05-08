import type { QueryConfig } from '../../../../core/query-engine/types';
import {
  getActiveQueryTemplateFromState,
  hasComplexQueryConfig,
  type QueryResult,
} from './queryRuntimeSlice';
import type { GroupTabInfo } from './workspaceSlice';
import type { DatasetInfo, DatasetSchemaColumn } from './types';

let optimisticRowIdSerial = -1;
let localPatchSerial = 0;

const nextOptimisticRowId = () => optimisticRowIdSerial--;
const nextLocalPatchId = () => `dataset-local-patch-${++localPatchSerial}`;

interface DatasetLocalPatchSnapshot {
  datasets: DatasetInfo[];
  currentDataset: DatasetInfo | null;
  groupTabs: GroupTabInfo[];
  queryResult: QueryResult | null;
  currentOffset: number;
  hasMore: boolean;
  pendingLocalSchemaRefreshDatasets: Set<string>;
}

export interface DatasetLocalPatchTransaction {
  id: string;
  snapshot: DatasetLocalPatchSnapshot;
}

export interface DatasetOptimisticState {
  datasets: DatasetInfo[];
  currentDataset: DatasetInfo | null;
  groupTabs: GroupTabInfo[];
  activeQueryDatasetId: string | null;
  activeQueryTemplate: any | null;
  queryResult: QueryResult | null;
  currentOffset: number;
  pageSize: number;
  hasMore: boolean;
  pendingLocalSchemaRefreshDatasets: Set<string>;
  localPatchTransaction: DatasetLocalPatchTransaction | null;
}

export interface DatasetOptimisticActions {
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
}

type DatasetOptimisticSet<TState extends DatasetOptimisticState> = (
  partial: Partial<TState> | TState | ((state: TState) => Partial<TState> | TState)
) => void;

type DatasetOptimisticGet<TState extends DatasetOptimisticState> = () => TState;

function createLocalPatchSnapshot<TState extends DatasetOptimisticState>(
  state: TState
): DatasetLocalPatchSnapshot {
  return {
    datasets: state.datasets,
    currentDataset: state.currentDataset,
    groupTabs: state.groupTabs,
    queryResult: state.queryResult,
    currentOffset: state.currentOffset,
    hasMore: state.hasMore,
    pendingLocalSchemaRefreshDatasets: new Set(state.pendingLocalSchemaRefreshDatasets),
  };
}

function canApplyLocalQueryPatch<TState extends DatasetOptimisticState>(
  state: TState,
  datasetId: string
) {
  if (state.activeQueryDatasetId !== datasetId || !state.queryResult) {
    return false;
  }

  const activeTemplate = getActiveQueryTemplateFromState(state);
  if (!activeTemplate || activeTemplate.datasetId !== datasetId) {
    return true;
  }

  return !hasComplexQueryConfig(activeTemplate.queryConfig as QueryConfig | undefined);
}

function getDatasetTotalRowCount<TState extends DatasetOptimisticState>(
  state: TState,
  datasetId: string
) {
  if (state.currentDataset?.id === datasetId) {
    return state.currentDataset.rowCount;
  }

  return state.datasets.find((dataset) => dataset.id === datasetId)?.rowCount;
}

const hasDatasetRowCountTargets = <TState extends DatasetOptimisticState>(
  state: TState,
  datasetId: string
) =>
  state.currentDataset?.id === datasetId ||
  state.datasets.some((dataset) => dataset.id === datasetId) ||
  state.groupTabs.some((tab) => tab.datasetId === datasetId);

const hasDatasetColumnTargets = <TState extends DatasetOptimisticState>(
  state: TState,
  datasetId: string
) =>
  state.currentDataset?.id === datasetId ||
  state.datasets.some((dataset) => dataset.id === datasetId) ||
  state.groupTabs.some((tab) => tab.datasetId === datasetId);

const applyDatasetRowCountDelta = <TState extends DatasetOptimisticState>(
  state: TState,
  datasetId: string,
  delta: number
) =>
  ({
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
  }) as Partial<TState>;

const applyDatasetColumnCount = <TState extends DatasetOptimisticState>(
  state: TState,
  datasetId: string,
  columnCount: number
) =>
  ({
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
  }) as Partial<TState>;

export function createDatasetOptimisticSlice<TState extends DatasetOptimisticState>(
  set: DatasetOptimisticSet<TState>,
  get: DatasetOptimisticGet<TState>
): DatasetOptimisticActions {
  const beginLocalPatch = () => {
    const patchId = nextLocalPatchId();
    let activePatchId: string | null = null;

    set((state) => {
      if (state.localPatchTransaction) {
        activePatchId = state.localPatchTransaction.id;
        return state;
      }

      return {
        localPatchTransaction: {
          id: patchId,
          snapshot: createLocalPatchSnapshot(state),
        },
      } as Partial<TState>;
    });

    if (activePatchId) {
      throw new Error(`Local patch transaction already active: ${activePatchId}`);
    }

    return patchId;
  };

  const commitLocalPatch = (patchId: string) => {
    let committed = false;

    set((state) => {
      if (state.localPatchTransaction?.id !== patchId) {
        return state;
      }

      committed = true;
      return {
        localPatchTransaction: null,
      } as Partial<TState>;
    });

    return committed;
  };

  const rollbackLocalPatch = (patchId: string) => {
    let rolledBack = false;

    set((state) => {
      const transaction = state.localPatchTransaction;
      if (transaction?.id !== patchId) {
        return state;
      }

      rolledBack = true;
      return {
        ...transaction.snapshot,
        pendingLocalSchemaRefreshDatasets: new Set(
          transaction.snapshot.pendingLocalSchemaRefreshDatasets
        ),
        localPatchTransaction: null,
      } as Partial<TState>;
    });

    return rolledBack;
  };

  const applyLocalDatasetCountDelta = (datasetId: string, delta: number) => {
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
  };

  const applyLocalDatasetSchema = (datasetId: string, schema: DatasetSchemaColumn[]) => {
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
        const nextPendingLocalSchemaRefreshDatasets = new Set(
          state.pendingLocalSchemaRefreshDatasets
        );
        nextPendingLocalSchemaRefreshDatasets.add(datasetId);

        return {
          ...nextCounts,
          currentDataset: nextCounts.currentDataset
            ? {
                ...nextCounts.currentDataset,
                schema: nextSchema,
              }
            : nextCounts.currentDataset,
          pendingLocalSchemaRefreshDatasets: nextPendingLocalSchemaRefreshDatasets,
        } as Partial<TState>;
      }

      return nextCounts;
    });

    return updated;
  };

  const consumePendingLocalSchemaRefresh = (datasetId: string) => {
    const pending = get().pendingLocalSchemaRefreshDatasets.has(datasetId);
    if (!pending) {
      return false;
    }

    set((state) => {
      if (!state.pendingLocalSchemaRefreshDatasets.has(datasetId)) {
        return state;
      }

      const nextPendingLocalSchemaRefreshDatasets = new Set(
        state.pendingLocalSchemaRefreshDatasets
      );
      nextPendingLocalSchemaRefreshDatasets.delete(datasetId);

      return {
        pendingLocalSchemaRefreshDatasets: nextPendingLocalSchemaRefreshDatasets,
      } as Partial<TState>;
    });

    return pending;
  };

  const applyLocalRecordInsert = (
    datasetId: string,
    record: Record<string, unknown>,
    options: { insertedCount?: number } = {}
  ) => {
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
        } as Partial<TState>;
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
      } as Partial<TState>;
    });

    return {
      rowAppended,
      countUpdated,
    };
  };

  const applyLocalRecordUpdate = (
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
      } as Partial<TState>;
    });

    return applied;
  };

  const applyLocalRecordDeletion = (
    datasetId: string,
    rowIds: number[],
    options: { deletedCount?: number } = {}
  ) => {
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
      } as Partial<TState>;
    });

    return applied;
  };

  return {
    beginLocalPatch,
    commitLocalPatch,
    rollbackLocalPatch,
    applyLocalDatasetSchema,
    consumePendingLocalSchemaRefresh,
    applyLocalDatasetCountDelta,
    applyLocalRecordInsert,
    applyLocalRecordUpdate,
    applyLocalRecordDeletion,
  };
}
