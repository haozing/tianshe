import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import type { ExportOptions, ExportPathParams, ExportProgress } from '../../../types/dataset-export';
import { createDatasetRouteErrorResult } from './dataset-route-errors';

export const MAX_IMPORT_RECORDS_BASE64_BYTES = 500 * 1024 * 1024;

const IMPORT_RECORDS_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const IMPORT_RECORDS_BASE64_DATA_URL_PATTERN = /^data:([^;,]*)(?:;[^,;]+=[^,;]*)*;base64,/i;
const SUPPORTED_IMPORT_RECORDS_BASE64_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.txt',
  '.json',
  '.xlsx',
  '.xls',
]);
const SUPPORTED_IMPORT_RECORDS_BASE64_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/json',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

export type ImportRecordsBase64Payload = {
  payload: string;
  decodedBytes: number;
  extension: string;
  resolvedName: string;
};

function getBase64DecodedByteLength(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

export function normalizeImportRecordsBase64Payload(
  base64: string,
  options: { filename?: string; maxBytes?: number } = {}
): ImportRecordsBase64Payload {
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('Base64 content is required');
  }

  const maxBytes = options.maxBytes ?? MAX_IMPORT_RECORDS_BASE64_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error('Invalid Base64 size limit');
  }

  const trimmed = base64.trim();
  const dataUrlMatch = IMPORT_RECORDS_BASE64_DATA_URL_PATTERN.exec(trimmed);
  const mimeType = dataUrlMatch?.[1]?.toLowerCase() || '';
  if (mimeType && !SUPPORTED_IMPORT_RECORDS_BASE64_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported import content type: ${mimeType}`);
  }

  const payloadStart = dataUrlMatch ? dataUrlMatch[0].length : 0;
  const payload = trimmed.slice(payloadStart).replace(/\s+/g, '');
  if (
    payload.length === 0 ||
    payload.length % 4 === 1 ||
    payload.startsWith('=') ||
    !IMPORT_RECORDS_BASE64_PATTERN.test(payload)
  ) {
    throw new Error('Base64 content is invalid');
  }

  const decodedBytes = getBase64DecodedByteLength(payload);
  if (decodedBytes <= 0) {
    throw new Error('Base64 content is invalid');
  }
  if (decodedBytes > maxBytes) {
    throw new Error(`Base64 content is too large: ${decodedBytes} bytes (max ${maxBytes} bytes)`);
  }

  const resolvedName =
    options.filename && typeof options.filename === 'string' ? options.filename : 'import.csv';
  const extension = (path.extname(resolvedName) || '.csv').toLowerCase();
  if (!SUPPORTED_IMPORT_RECORDS_BASE64_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported import file extension: ${extension}`);
  }

  return { payload, decodedBytes, extension, resolvedName };
}

export function registerDatasetImportExportRoutes(duckdb: DuckDBService): void {
  registerSelectImportFile();
  registerImportDatasetFile(duckdb);
  registerCancelImport(duckdb);
  registerSelectExportPath();
  registerExportDataset(duckdb);
  registerImportRecordsFromBase64(duckdb);
  registerImportRecordsFromFile(duckdb);
}

function registerSelectImportFile(): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:select-import-file',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        const result = await dialog.showOpenDialog(
          BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0],
          {
            properties: ['openFile'],
            filters: [
              { name: 'Data Files', extensions: ['csv', 'xlsx', 'xls', 'json'] },
              { name: 'CSV Files', extensions: ['csv'] },
              { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
              { name: 'JSON Files', extensions: ['json'] },
              { name: 'All Files', extensions: ['*'] },
            ],
          }
        );

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, canceled: true, error: 'No file selected' };
        }

        return { success: true, canceled: false, filePath: result.filePaths[0] };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerImportDatasetFile(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:import-dataset-file',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      event: IpcMainInvokeEvent,
      filePath: string,
      name: string,
      options?: { folderId?: string | null }
    ) => {
      try {
        const datasetId = await duckdb.importDatasetFile(filePath, name, options, (progress) => {
          event.sender.send('duckdb:import-progress', progress);
        });

        return { success: true, datasetId };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerCancelImport(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:cancel-import',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        await duckdb.cancelImport(datasetId);
        return { success: true };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerSelectExportPath(): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:select-export-path',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, params: ExportPathParams) => {
      try {
        const { defaultFileName, format } = params;
        const filters: { name: string; extensions: string[] }[] = [];
        switch (format) {
          case 'csv':
            filters.push({ name: 'CSV Files', extensions: ['csv'] });
            break;
          case 'xlsx':
            filters.push({ name: 'Excel Files', extensions: ['xlsx'] });
            break;
          case 'txt':
            filters.push({ name: 'Text Files', extensions: ['txt'] });
            break;
          case 'parquet':
            filters.push({ name: 'Parquet Files', extensions: ['parquet'] });
            break;
          case 'json':
            filters.push({ name: 'JSON Files', extensions: ['json'] });
            break;
          default:
            filters.push({ name: 'All Files', extensions: ['*'] });
        }
        filters.push({ name: 'All Files', extensions: ['*'] });

        const result = await dialog.showSaveDialog(
          BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0],
          {
            title: '导出数据',
            defaultPath: defaultFileName,
            filters,
          }
        );

        if (result.canceled || !result.filePath) {
          return { success: true, canceled: true };
        }

        return { success: true, filePath: result.filePath };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerExportDataset(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:export-dataset',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (event: IpcMainInvokeEvent, options: ExportOptions) => {
      try {
        return await duckdb.exportDataset(options, (progress: ExportProgress) => {
          event.sender.send('duckdb:export-progress', progress);
        });
      } catch (error: unknown) {
        console.error('[Dataset] Error exporting dataset:', error);
        const errorResult = createDatasetRouteErrorResult(error);
        return {
          success: false,
          files: [],
          totalRows: 0,
          filesCount: 0,
          executionTime: 0,
          error: errorResult.error,
          code: errorResult.code,
        };
      }
    },
  });
}

function registerImportRecordsFromBase64(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:import-records-from-base64',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description:
        'Import records into an existing dataset from a Base64 payload after size, MIME, and extension validation.',
      args: [
        { name: 'datasetId', type: 'string', required: true },
        { name: 'base64', type: 'string', required: true },
        { name: 'filename', type: 'string', required: false },
      ],
      result: {
        success: 'boolean',
        recordsInserted: 'number?',
        error: 'string?',
        code: 'string?',
      },
    },
    handler: async (
      event: IpcMainInvokeEvent,
      datasetId: string,
      base64: string,
      filename?: string
    ) => {
      let tempFilePath = '';
      try {
        const {
          payload: normalized,
          decodedBytes,
          extension,
          resolvedName,
        } = normalizeImportRecordsBase64Payload(base64, { filename });
        const tempDir = path.join(os.tmpdir(), 'airpa', 'tmp');
        await fs.ensureDir(tempDir);

        const baseName = path.basename(resolvedName, path.extname(resolvedName)) || 'import';
        const safeBaseName = baseName.replace(/[^\w.-]/g, '_') || 'import';
        const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        tempFilePath = path.join(tempDir, `${safeBaseName}_${suffix}${extension}`);

        const buffer = Buffer.from(normalized, 'base64');
        if (buffer.byteLength !== decodedBytes) {
          throw new Error('Base64 content is invalid');
        }
        await fs.writeFile(tempFilePath, buffer);

        const result = await duckdb.importRecordsFromFile(datasetId, tempFilePath, (progress) => {
          event.sender.send('duckdb:import-records-progress', progress);
        });

        return {
          success: true,
          recordsInserted: result.recordsInserted,
        };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      } finally {
        if (tempFilePath) {
          try {
            await fs.remove(tempFilePath);
          } catch {
            // Ignore best-effort temp cleanup failures.
          }
        }
      }
    },
  });
}

function registerImportRecordsFromFile(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:import-records-from-file',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description:
        'Import records into an existing dataset from a local file path selected by the trusted renderer.',
      args: [
        { name: 'datasetId', type: 'string', required: true },
        { name: 'filePath', type: 'string', required: true },
      ],
      result: {
        success: 'boolean',
        recordsInserted: 'number?',
        error: 'string?',
        code: 'string?',
      },
    },
    handler: async (event: IpcMainInvokeEvent, datasetId: string, filePath: string) => {
      try {
        const result = await duckdb.importRecordsFromFile(datasetId, filePath, (progress) => {
          event.sender.send('duckdb:import-records-progress', progress);
        });

        return {
          success: true,
          recordsInserted: result.recordsInserted,
        };
      } catch (error: unknown) {
        console.error('[Dataset] Error importing records from file:', error);
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}
