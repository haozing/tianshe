import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDatasetColumn,
  deleteDatasetColumn,
  updateDatasetRecord,
  validateDatasetColumnName,
} from './datasetMutationService';

describe('datasetMutationService', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      electronAPI: {
        duckdb: {
          updateRecord: vi.fn(),
          updateColumnMetadata: vi.fn(),
          insertRecord: vi.fn(),
          batchInsertRecords: vi.fn(),
          importRecordsFromFile: vi.fn(),
          importRecordsFromBase64: vi.fn(),
          updateColumn: vi.fn(),
          deleteColumn: vi.fn(),
          reorderColumns: vi.fn(),
          validateColumnName: vi.fn(),
          addColumn: vi.fn(),
        },
      },
    };
  });

  it('throws when updateRecord returns an unsuccessful response', async () => {
    (window as any).electronAPI.duckdb.updateRecord.mockResolvedValue({
      success: false,
      error: 'write failed',
    });

    await expect(updateDatasetRecord('ds1', 1, { name: 'next' })).rejects.toThrow('write failed');
  });

  it('returns validation details when column-name validation succeeds but is invalid', async () => {
    (window as any).electronAPI.duckdb.validateColumnName.mockResolvedValue({
      success: true,
      valid: false,
      message: 'duplicate name',
    });

    await expect(validateDatasetColumnName('ds1', 'name')).resolves.toEqual({
      valid: false,
      message: 'duplicate name',
    });
  });

  it('creates a column through duckdb.addColumn', async () => {
    (window as any).electronAPI.duckdb.addColumn.mockResolvedValue({
      success: true,
    });

    await expect(
      addDatasetColumn({
        datasetId: 'ds1',
        columnName: 'status',
        fieldType: 'text',
        nullable: true,
      })
    ).resolves.toEqual({ success: true });
  });

  it('keeps deleteColumn as a raw result for force-delete flows', async () => {
    (window as any).electronAPI.duckdb.deleteColumn.mockResolvedValue({
      success: false,
      error: 'has dependencies',
    });

    await expect(
      deleteDatasetColumn({
        datasetId: 'ds1',
        columnName: 'status',
        force: false,
      })
    ).resolves.toEqual({
      success: false,
      error: 'has dependencies',
    });
  });
});
