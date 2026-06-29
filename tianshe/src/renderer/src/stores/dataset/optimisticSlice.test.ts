import { describe, expect, it, vi } from 'vitest';
import { createDatasetOptimisticSlice, type DatasetOptimisticState } from './optimisticSlice';
import type { DatasetInfo } from './types';

const makeDataset = (id: string, rowCount = 1, columnCount = 1): DatasetInfo => ({
  id,
  name: id,
  rowCount,
  columnCount,
  sizeBytes: 0,
  createdAt: 1,
  schema: [],
});

function createHarness(initialState: Partial<DatasetOptimisticState> = {}) {
  let state: DatasetOptimisticState = {
    datasets: [],
    currentDataset: null,
    groupTabs: [],
    activeQueryDatasetId: null,
    activeQueryTemplate: null,
    queryResult: null,
    currentOffset: 0,
    pageSize: 50,
    hasMore: true,
    pendingLocalSchemaRefreshDatasets: new Set(),
    localPatchTransaction: null,
    ...initialState,
  };

  const set = vi.fn((partial: any) => {
    const nextState = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...nextState };
  });
  const get = vi.fn(() => state);
  const actions = createDatasetOptimisticSlice(set, get);

  return {
    actions,
    getState: () => state,
  };
}

describe('dataset optimistic slice', () => {
  it('appends a visible inserted row and updates metadata counts', () => {
    const { actions, getState } = createHarness({
      datasets: [makeDataset('ds1', 1)],
      currentDataset: makeDataset('ds1', 1),
      groupTabs: [
        {
          datasetId: 'ds1',
          tabGroupId: 'grp1',
          name: 'Dataset 1',
          rowCount: 1,
          columnCount: 1,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ],
      activeQueryDatasetId: 'ds1',
      queryResult: {
        columns: ['name'],
        rows: [{ _row_id: 1, name: 'row-1' }],
        rowCount: 1,
      },
      currentOffset: 1,
      pageSize: 50,
      hasMore: false,
    });

    const result = actions.applyLocalRecordInsert('ds1', { name: 'row-2' });

    expect(result).toEqual({ rowAppended: true, countUpdated: true });
    expect(getState().queryResult?.rows).toHaveLength(2);
    expect(getState().datasets[0].rowCount).toBe(2);
    expect(getState().currentDataset?.rowCount).toBe(2);
    expect(getState().groupTabs[0].rowCount).toBe(2);
  });

  it('refuses row patching when complex query processing is active', () => {
    const { actions, getState } = createHarness({
      activeQueryDatasetId: 'ds1',
      activeQueryTemplate: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: { filter: { conditions: [{}] } },
      },
      queryResult: {
        columns: ['name'],
        rows: [{ _row_id: 1, name: 'row-1' }],
        rowCount: 1,
      },
    });

    const applied = actions.applyLocalRecordUpdate('ds1', 1, { name: 'updated' });

    expect(applied).toBe(false);
    expect(getState().queryResult?.rows).toEqual([{ _row_id: 1, name: 'row-1' }]);
  });

  it('updates local schema metadata and consumes the refresh marker once', () => {
    const { actions, getState } = createHarness({
      datasets: [makeDataset('ds1', 1, 1)],
      currentDataset: makeDataset('ds1', 1, 1),
    });

    const updated = actions.applyLocalDatasetSchema('ds1', [
      { name: 'id', duckdbType: 'INTEGER', fieldType: 'number' },
      { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text' },
    ]);

    expect(updated).toBe(true);
    expect(getState().datasets[0].columnCount).toBe(2);
    expect(getState().currentDataset?.schema?.map((column) => column.name)).toEqual(['id', 'name']);
    expect(actions.consumePendingLocalSchemaRefresh('ds1')).toBe(true);
    expect(actions.consumePendingLocalSchemaRefresh('ds1')).toBe(false);
  });

  it('keeps pending local schema refresh markers scoped to each store instance', () => {
    const first = createHarness({
      datasets: [makeDataset('ds1', 1, 1)],
      currentDataset: makeDataset('ds1', 1, 1),
    });
    const second = createHarness({
      datasets: [makeDataset('ds1', 1, 1)],
      currentDataset: makeDataset('ds1', 1, 1),
    });

    first.actions.applyLocalDatasetSchema('ds1', [
      { name: 'id', duckdbType: 'INTEGER', fieldType: 'number' },
    ]);

    expect(second.actions.consumePendingLocalSchemaRefresh('ds1')).toBe(false);
    expect(first.actions.consumePendingLocalSchemaRefresh('ds1')).toBe(true);
  });

  it('deletes visible rows and decrements row counts', () => {
    const { actions, getState } = createHarness({
      datasets: [makeDataset('ds1', 3)],
      currentDataset: makeDataset('ds1', 3),
      activeQueryDatasetId: 'ds1',
      queryResult: {
        columns: ['name'],
        rows: [
          { _row_id: 1, name: 'row-1' },
          { _row_id: 2, name: 'row-2' },
        ],
        rowCount: 2,
        filteredTotalCount: 3,
      },
      currentOffset: 2,
      hasMore: true,
    });

    const applied = actions.applyLocalRecordDeletion('ds1', [1], { deletedCount: 1 });

    expect(applied).toBe(true);
    expect(getState().queryResult?.rows).toEqual([{ _row_id: 2, name: 'row-2' }]);
    expect(getState().queryResult?.filteredTotalCount).toBe(2);
    expect(getState().datasets[0].rowCount).toBe(2);
    expect(getState().currentOffset).toBe(1);
  });

  it('rolls back a local patch transaction to the captured snapshot', () => {
    const { actions, getState } = createHarness({
      datasets: [makeDataset('ds1', 1)],
      currentDataset: makeDataset('ds1', 1),
      activeQueryDatasetId: 'ds1',
      queryResult: {
        columns: ['name'],
        rows: [{ _row_id: 1, name: 'row-1' }],
        rowCount: 1,
      },
      currentOffset: 1,
      hasMore: false,
    });

    const patchId = actions.beginLocalPatch();
    actions.applyLocalRecordInsert('ds1', { name: 'row-2' });

    expect(getState().queryResult?.rows).toHaveLength(2);
    expect(getState().datasets[0].rowCount).toBe(2);

    expect(actions.rollbackLocalPatch(patchId)).toBe(true);
    expect(getState().queryResult?.rows).toEqual([{ _row_id: 1, name: 'row-1' }]);
    expect(getState().datasets[0].rowCount).toBe(1);
    expect(getState().localPatchTransaction).toBeNull();
  });

  it('commits a local patch transaction without reverting state', () => {
    const { actions, getState } = createHarness({
      datasets: [makeDataset('ds1', 1, 1)],
      currentDataset: makeDataset('ds1', 1, 1),
    });

    const patchId = actions.beginLocalPatch();
    actions.applyLocalDatasetSchema('ds1', [
      { name: 'id', duckdbType: 'INTEGER', fieldType: 'number' },
    ]);

    expect(actions.commitLocalPatch(patchId)).toBe(true);
    expect(getState().currentDataset?.schema?.map((column) => column.name)).toEqual(['id']);
    expect(actions.rollbackLocalPatch(patchId)).toBe(false);
    expect(getState().localPatchTransaction).toBeNull();
  });

  it('prevents nested local patch transactions', () => {
    const { actions } = createHarness();

    actions.beginLocalPatch();

    expect(() => actions.beginLocalPatch()).toThrow('Local patch transaction already active');
  });
});
