import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatasetImportSlice,
  type DatasetImportState,
  type ImportProgress,
} from './importSlice';

const mockImportDatasetFile = vi.fn();
const mockCancelImport = vi.fn();

function createHarness() {
  let state: DatasetImportState = {
    loading: false,
    error: null,
    importProgress: new Map(),
    processedImports: new Set(),
  };

  const set = vi.fn((partial: any) => {
    const nextState = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...nextState };
  });
  const get = vi.fn(() => state);
  const actions = createDatasetImportSlice(set, get);

  return {
    actions,
    getState: () => state,
    setState: (nextState: Partial<DatasetImportState>) => {
      state = { ...state, ...nextState };
    },
  };
}

describe('dataset import slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          importDatasetFile: mockImportDatasetFile,
          cancelImport: mockCancelImport,
        },
      },
    };
  });

  it('starts an import and clears loading after success', async () => {
    mockImportDatasetFile.mockResolvedValue({ success: true, datasetId: 'ds1' });
    const { actions, getState } = createHarness();

    await expect(actions.importDatasetFile('/tmp/data.csv', 'Data')).resolves.toBe('ds1');

    expect(mockImportDatasetFile).toHaveBeenCalledWith('/tmp/data.csv', 'Data', undefined);
    expect(getState().loading).toBe(false);
    expect(getState().error).toBeNull();
  });

  it('stores and rethrows import startup errors', async () => {
    mockImportDatasetFile.mockResolvedValue({ success: false, error: 'bad csv' });
    const { actions, getState } = createHarness();

    await expect(actions.importDatasetFile('/tmp/bad.csv', 'Bad')).rejects.toThrow('bad csv');

    expect(getState().loading).toBe(false);
    expect(getState().error).toBe('bad csv');
  });

  it('updates progress immutably and can cancel an import', async () => {
    mockCancelImport.mockResolvedValue(undefined);
    const { actions, getState } = createHarness();
    const progress: ImportProgress = {
      datasetId: 'ds1',
      status: 'importing',
      progress: 40,
    };

    actions.updateImportProgress(progress);
    const firstProgressMap = getState().importProgress;
    actions.updateImportProgress({ ...progress, progress: 60 });

    expect(getState().importProgress).not.toBe(firstProgressMap);
    expect(getState().importProgress.get('ds1')?.progress).toBe(60);

    await actions.cancelImport('ds1');

    expect(mockCancelImport).toHaveBeenCalledWith('ds1');
    expect(getState().importProgress.has('ds1')).toBe(false);
  });

  it('tracks processed imports immutably', () => {
    const { actions, getState } = createHarness();

    actions.markImportAsProcessed('ds1');

    expect(actions.isImportProcessed('ds1')).toBe(true);
    expect(getState().processedImports).toEqual(new Set(['ds1']));
  });
});
