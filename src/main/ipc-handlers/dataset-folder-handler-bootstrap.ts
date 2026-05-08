import type { DuckDBService } from '../duckdb/service';
import { createLogger } from '../../core/logger';

const logger = createLogger('DatasetFolderIPCBootstrap');

type DatasetFolderHandlersModule = {
  registerDatasetFolderHandlers?: (duckdbService: DuckDBService) => void;
  default?:
    | { registerDatasetFolderHandlers?: (duckdbService: DuckDBService) => void }
    | ((duckdbService: DuckDBService) => void);
};

function getObjectKeys(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' && typeof value !== 'function') return [];
  return Object.keys(value as Record<string, unknown>);
}

function resolveRegisterDatasetFolderHandlers(
  mod: DatasetFolderHandlersModule | null | undefined
): ((duckdbService: DuckDBService) => void) | null {
  const direct = mod?.registerDatasetFolderHandlers;
  if (typeof direct === 'function') return direct;
  const defaultExport = mod?.default;
  if (defaultExport && typeof defaultExport === 'object') {
    const nested = defaultExport.registerDatasetFolderHandlers;
    if (typeof nested === 'function') return nested;
  }
  if (typeof defaultExport === 'function') return defaultExport;
  return null;
}

export function registerDatasetFolderHandlersFromModule(
  mod: unknown,
  duckdbService: DuckDBService
): void {
  const datasetFolderModule = mod as DatasetFolderHandlersModule;
  const registerDatasetFolderHandlers = resolveRegisterDatasetFolderHandlers(datasetFolderModule);
  if (typeof registerDatasetFolderHandlers !== 'function') {
    logger.error('Dataset folder handlers module shape mismatch', {
      moduleKeys: getObjectKeys(datasetFolderModule),
      defaultKeys: getObjectKeys(datasetFolderModule.default),
    });
    throw new TypeError('registerDatasetFolderHandlers is not a function');
  }
  registerDatasetFolderHandlers(duckdbService);
}
