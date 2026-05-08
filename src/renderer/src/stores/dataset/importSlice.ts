import { datasetFacade } from '../../services/datasets/datasetFacade';
import { createRendererLogger } from '../../lib/logger';

const logger = createRendererLogger('DatasetStore');

export interface ImportProgress {
  datasetId: string;
  status: 'pending' | 'importing' | 'completed' | 'failed';
  progress: number;
  rowsProcessed?: number;
  error?: string;
  message?: string;
}

export interface DatasetImportState {
  loading: boolean;
  error: string | null;
  importProgress: Map<string, ImportProgress>;
  processedImports: Set<string>;
}

export interface DatasetImportActions {
  importDatasetFile: (
    filePath: string,
    name: string,
    options?: Parameters<typeof datasetFacade.importDatasetFile>[2]
  ) => Promise<string>;
  cancelImport: (datasetId: string) => Promise<void>;
  updateImportProgress: (progress: ImportProgress) => void;
  markImportAsProcessed: (datasetId: string) => void;
  isImportProcessed: (datasetId: string) => boolean;
}

type DatasetImportSet<TState extends DatasetImportState> = (
  partial: Partial<TState> | ((state: TState) => Partial<TState>)
) => void;

type DatasetImportGet<TState extends DatasetImportState> = () => TState;

const getErrorMessage = (error: unknown, fallback = 'Unknown error') =>
  error instanceof Error ? error.message : String(error || fallback);

export function createDatasetImportSlice<TState extends DatasetImportState>(
  set: DatasetImportSet<TState>,
  get: DatasetImportGet<TState>
): DatasetImportActions {
  return {
    importDatasetFile: async (
      filePath: string,
      name: string,
      options?: Parameters<typeof datasetFacade.importDatasetFile>[2]
    ) => {
      set({ loading: true, error: null } as Partial<TState>);
      try {
        const response = await datasetFacade.importDatasetFile(filePath, name, options);
        if (response.success && response.datasetId) {
          set({ loading: false } as Partial<TState>);
          return response.datasetId;
        }

        const errorMessage = response.error || 'Failed to start import';
        set({ error: errorMessage, loading: false } as Partial<TState>);
        throw new Error(errorMessage);
      } catch (error: unknown) {
        set({ error: getErrorMessage(error), loading: false } as Partial<TState>);
        throw error;
      }
    },

    cancelImport: async (datasetId: string) => {
      try {
        await datasetFacade.cancelImport(datasetId);
        set((state) => {
          const nextProgress = new Map(state.importProgress);
          nextProgress.delete(datasetId);
          return { importProgress: nextProgress } as Partial<TState>;
        });
      } catch (error: unknown) {
        logger.error('Failed to cancel dataset import', {
          operation: 'dataset.import.cancel',
          datasetId,
          error,
        });
      }
    },

    updateImportProgress: (progress: ImportProgress) => {
      set((state) => {
        const nextProgress = new Map(state.importProgress);
        nextProgress.set(progress.datasetId, progress);
        return { importProgress: nextProgress } as Partial<TState>;
      });
    },

    markImportAsProcessed: (datasetId: string) => {
      set((state) => {
        const nextProcessedImports = new Set(state.processedImports);
        nextProcessedImports.add(datasetId);
        return { processedImports: nextProcessedImports } as Partial<TState>;
      });
    },

    isImportProcessed: (datasetId: string) => {
      return get().processedImports.has(datasetId);
    },
  };
}
