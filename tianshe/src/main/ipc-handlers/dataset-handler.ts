/**
 * DatasetIPCHandler - dataset management IPC handler.
 * Keeps register() as a compatibility entry point while route families live in focused modules.
 */

import type { DuckDBService } from '../duckdb/service';
import { registerDatasetGroupTabRoutes } from './dataset-routes/group-tab-routes';
import { registerDatasetImportExportRoutes } from './dataset-routes/import-export-routes';
import { registerDatasetMetadataRoutes } from './dataset-routes/metadata-routes';
import { registerDatasetQueryPreviewRoutes } from './dataset-routes/query-preview-routes';
import { registerDatasetRecordRoutes } from './dataset-routes/record-routes';
import { registerDatasetSchemaRoutes } from './dataset-routes/schema-routes';
export {
  MAX_IMPORT_RECORDS_BASE64_BYTES,
  normalizeImportRecordsBase64Payload,
  type ImportRecordsBase64Payload,
} from './dataset-routes/import-export-routes';

export class DatasetIPCHandler {
  constructor(private duckdb: DuckDBService) {}

  register(): void {
    registerDatasetImportExportRoutes(this.duckdb);
    registerDatasetMetadataRoutes(this.duckdb);
    registerDatasetGroupTabRoutes(this.duckdb);
    registerDatasetRecordRoutes(this.duckdb);
    registerDatasetQueryPreviewRoutes(this.duckdb);
    registerDatasetSchemaRoutes(this.duckdb);
  }
}
