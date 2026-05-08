import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatasetWorkspaceSlice,
  type DatasetWorkspaceState,
  type GroupTabInfo,
} from './workspaceSlice';

const mockListGroupTabs = vi.fn();

function createHarness(initialState: Partial<DatasetWorkspaceState> = {}) {
  let state: DatasetWorkspaceState = {
    datasets: [],
    error: null,
    currentGroupId: null,
    groupTabs: [],
    selectedTabDatasetId: null,
    workspaceCategories: [],
    selectedCategory: null,
    selectedTableId: null,
    isAnalyzingTypes: false,
    ...initialState,
  };

  const set = vi.fn((partial: any) => {
    const nextState = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...nextState };
  });
  const get = vi.fn(() => state);
  const actions = createDatasetWorkspaceSlice(set, get);

  return {
    actions,
    getState: () => state,
  };
}

const makeTab = (datasetId: string, tabOrder: number, isGroupDefault = false): GroupTabInfo => ({
  datasetId,
  tabGroupId: 'grp1',
  name: datasetId,
  rowCount: 0,
  columnCount: 0,
  tabOrder,
  isGroupDefault,
});

describe('dataset workspace slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          listGroupTabs: mockListGroupTabs,
        },
      },
    };
  });

  it('sorts group tabs and selects the default tab', () => {
    const { actions, getState } = createHarness();

    actions.setGroupTabs([makeTab('ds_late', 2), makeTab('ds_default', 1, true)]);

    expect(getState().groupTabs.map((tab) => tab.datasetId)).toEqual(['ds_default', 'ds_late']);
    expect(getState().selectedTabDatasetId).toBe('ds_default');
    expect(getState().currentGroupId).toBe('grp1');
  });

  it('loads group tabs from the API and preserves an existing selected tab', async () => {
    mockListGroupTabs.mockResolvedValue({
      success: true,
      tabs: [makeTab('ds1', 0, true), makeTab('ds2', 1)],
    });
    const { actions, getState } = createHarness({ selectedTabDatasetId: 'ds2' });

    await actions.loadGroupTabs('ds1');

    expect(mockListGroupTabs).toHaveBeenCalledWith('ds1');
    expect(getState().selectedTabDatasetId).toBe('ds2');
    expect(getState().groupTabs).toHaveLength(2);
  });

  it('selects a workspace dataset from a snapshot category', () => {
    const { actions, getState } = createHarness();

    actions.selectWorkspaceDataset('ds1', null, {
      datasets: [],
      categories: [
        {
          id: 'folder1',
          name: 'Folder',
          isFolder: true,
          tables: [{ id: 'table_ds1', name: 'Data', datasetId: 'ds1' }],
        },
      ],
    });

    expect(getState().selectedCategory).toBe('folder1');
    expect(getState().selectedTableId).toBe('table_ds1');
  });

  it('reconciles stale workspace selection', () => {
    const { actions, getState } = createHarness({
      selectedCategory: 'missing',
      selectedTableId: 'table_ds1',
      workspaceCategories: [],
    });

    actions.reconcileWorkspaceSelection();

    expect(getState().selectedCategory).toBeNull();
    expect(getState().selectedTableId).toBeNull();
  });
});
