import type { DuckDBConnection } from '@duckdb/node-api';
import type { HookBus } from '../../core/hookbus';
import { createLogger } from '../../core/logger';
import {
  partitionRecordFieldsBySchema,
  stripSystemFields,
} from '../../utils/dataset-column-capabilities';
import type { DataRecord, Dataset } from './types';
import type { DatasetMetadataService } from './dataset-metadata-service';
import type { DatasetStorageService } from './dataset-storage-service';
import { sanitizeDatasetId } from './dataset-storage-service';
import { allPrepared, runPrepared } from './statement-executor';
import {
  parseRows,
  quoteIdentifier,
  runInDuckDbTransaction,
} from './utils';

const logger = createLogger('DatasetRecordMutationService');

interface DatasetRecordMutationServiceOptions {
  conn: DuckDBConnection;
  storageService: DatasetStorageService;
  metadataService: DatasetMetadataService;
  getTableName: (safeDatasetId: string) => string;
  ensureAttached: (dataset: Dataset) => Promise<void>;
  hookBus?: HookBus;
}

function safeQuoteColumn(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error(`Invalid column name: ${name}`);
  }

  return quoteIdentifier(name);
}

function getWritableRecordForDataset(dataset: Dataset, record: DataRecord): DataRecord {
  const cleanedRecord = stripSystemFields(record as Record<string, unknown>) as DataRecord;
  const schema = Array.isArray(dataset.schema) ? dataset.schema : [];
  const { accepted, unknownColumns, nonWritableColumns } = partitionRecordFieldsBySchema(
    cleanedRecord as Record<string, unknown>,
    schema
  );

  if (unknownColumns.length > 0) {
    throw new Error(`Unknown columns: ${unknownColumns.join(', ')}`);
  }

  if (nonWritableColumns.length > 0) {
    throw new Error(`Columns are not writable: ${nonWritableColumns.join(', ')}`);
  }

  return accepted as DataRecord;
}

function hasDatasetColumn(dataset: Dataset, columnName: string): boolean {
  return (
    Array.isArray(dataset.schema) && dataset.schema.some((column) => column.name === columnName)
  );
}

export class DatasetRecordMutationService {
  private readonly conn: DuckDBConnection;
  private readonly storageService: DatasetStorageService;
  private readonly metadataService: DatasetMetadataService;
  private readonly getTableName: (safeDatasetId: string) => string;
  private readonly ensureAttached: (dataset: Dataset) => Promise<void>;
  private readonly hookBus?: HookBus;

  constructor(options: DatasetRecordMutationServiceOptions) {
    this.conn = options.conn;
    this.storageService = options.storageService;
    this.metadataService = options.metadataService;
    this.getTableName = options.getTableName;
    this.ensureAttached = options.ensureAttached;
    this.hookBus = options.hookBus;
  }

  async hardDeleteRows(datasetId: string, rowIds: number[]): Promise<number> {
    if (!rowIds || rowIds.length === 0) {
      throw new Error('No row IDs provided for deletion');
    }

    const safeDatasetId = sanitizeDatasetId(datasetId);
    const validRowIds = rowIds.filter((id) => Number.isInteger(id) && id >= 0);
    if (validRowIds.length !== rowIds.length) {
      throw new Error('All row IDs must be non-negative integers');
    }

    const uniqueRowIds = Array.from(new Set(validRowIds));
    if (uniqueRowIds.length === 0) return 0;

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      logger.warn('Permanently deleting dataset rows', {
        datasetId: safeDatasetId,
        tableName,
        rowIdCount: uniqueRowIds.length,
      });

      const BATCH_SIZE = 1000;
      let deletedCount = 0;

      await runInDuckDbTransaction(this.conn, async () => {
        for (let i = 0; i < uniqueRowIds.length; i += BATCH_SIZE) {
          const batch = uniqueRowIds.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => '?').join(', ');
          const countSql = `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE _row_id IN (${placeholders})`;
          const countResult = await allPrepared(this.conn, countSql, batch);

          const batchDeletedCount = Number(parseRows(countResult)[0]?.cnt ?? 0);
          if (!Number.isFinite(batchDeletedCount) || batchDeletedCount <= 0) {
            continue;
          }

          const deleteSql = `DELETE FROM ${tableName} WHERE _row_id IN (${placeholders})`;
          await runPrepared(this.conn, deleteSql, batch);

          deletedCount += batchDeletedCount;
        }
      });

      if (deletedCount > 0) {
        try {
          await this.metadataService.incrementRowCount(safeDatasetId, -deletedCount);
        } catch (countError) {
          logger.warn('Failed to decrement dataset row_count after delete', {
            datasetId: safeDatasetId,
            deletedCount,
            error: countError,
          });
        }
      }

      logger.warn('Permanently deleted dataset rows', {
        datasetId: safeDatasetId,
        deletedCount,
      });
      return deletedCount;
    });
  }

  async updateRecord(datasetId: string, rowId: number, updates: DataRecord): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      const writableUpdates = getWritableRecordForDataset(dataset, updates);
      const columns = Object.keys(writableUpdates);
      const values = Object.values(writableUpdates);

      if (columns.length === 0) {
        throw new Error('Updates must have at least one column');
      }

      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      const setExpressions = columns.map((col) => `${safeQuoteColumn(col)} = ?`);
      if (hasDatasetColumn(dataset, 'updated_at')) {
        setExpressions.push(`${safeQuoteColumn('updated_at')} = now()`);
      }
      const setClause = setExpressions.join(', ');
      const sql = `UPDATE ${tableName} SET ${setClause} WHERE _row_id = ?`;

      logger.info('Updating dataset record', { datasetId: safeDatasetId, rowId });

      await runInDuckDbTransaction(this.conn, async () => {
        await runPrepared(this.conn, sql, [...values, rowId]);
      });

      logger.info('Dataset record updated', { datasetId: safeDatasetId, rowId });

      this.hookBus?.emit('webhook:record.updated', {
        datasetId: safeDatasetId,
        rowId,
        updates: writableUpdates,
      });
    });
  }

  async batchUpdateRecords(
    datasetId: string,
    updates: Array<{ rowId: number; updates: DataRecord }>
  ): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      if (updates.length === 0) return;

      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      await runInDuckDbTransaction(this.conn, async () => {
        for (const update of updates) {
          const { rowId, updates: data } = update;
          const writableUpdates = getWritableRecordForDataset(dataset, data);
          const columns = Object.keys(writableUpdates);
          const values = Object.values(writableUpdates);

          if (columns.length === 0) continue;

          const setExpressions = columns.map((col) => `${safeQuoteColumn(col)} = ?`);
          if (hasDatasetColumn(dataset, 'updated_at')) {
            setExpressions.push(`${safeQuoteColumn('updated_at')} = now()`);
          }
          const setClause = setExpressions.join(', ');
          const sql = `UPDATE ${tableName} SET ${setClause} WHERE _row_id = ?`;
          await runPrepared(this.conn, sql, [...values, rowId]);
        }
      });
      logger.info('Dataset records batch updated', {
        datasetId: safeDatasetId,
        updateCount: updates.length,
      });
    });
  }

  async insertRecord(datasetId: string, record: DataRecord): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      await this.insertRecordInCurrentQueue(safeDatasetId, dataset, record);
      logger.info('Dataset record inserted', { datasetId: safeDatasetId });
    });
  }

  private async insertRecordInCurrentQueue(
    safeDatasetId: string,
    dataset: Dataset,
    record: DataRecord
  ): Promise<DataRecord> {
    const cleanedRecord = getWritableRecordForDataset(dataset, record);
    const columns = Object.keys(cleanedRecord);
    const values = Object.values(cleanedRecord);

    if (columns.length === 0) {
      throw new Error('Record must have at least one column');
    }

    const columnNames = columns.map((column) => safeQuoteColumn(column)).join(', ');
    const placeholders = values.map(() => '?').join(', ');

    await this.ensureAttached(dataset);
    const tableName = this.getTableName(safeDatasetId);

    const sql = `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders})`;
    await runPrepared(this.conn, sql, values);

    try {
      await this.metadataService.incrementRowCount(safeDatasetId, 1);
    } catch (countError) {
      logger.warn('Failed to increment dataset row_count after insert', {
        datasetId: safeDatasetId,
        error: countError,
      });
    }

    this.hookBus?.emit('webhook:record.created', {
      datasetId: safeDatasetId,
      record: cleanedRecord,
    });

    return cleanedRecord;
  }

  async batchInsertRecords(datasetId: string, records: DataRecord[]): Promise<void> {
    if (records.length === 0) return;

    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      if (records.length === 1) {
        await this.insertRecordInCurrentQueue(safeDatasetId, dataset, records[0]);
        return;
      }

      const cleanedRecords = records.map((record) => getWritableRecordForDataset(dataset, record));
      const firstColumns = Object.keys(cleanedRecords[0]).sort();
      for (const record of cleanedRecords) {
        const cols = Object.keys(record).sort();
        if (JSON.stringify(cols) !== JSON.stringify(firstColumns)) {
          throw new Error('所有记录必须有相同的列');
        }
      }

      const columns = Object.keys(cleanedRecords[0]);
      if (columns.length === 0) {
        throw new Error('Record must have at least one column');
      }

      const columnNames = columns.map((column) => safeQuoteColumn(column)).join(', ');

      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      const BATCH_SIZE = 100;
      await runInDuckDbTransaction(this.conn, async () => {
        for (let i = 0; i < cleanedRecords.length; i += BATCH_SIZE) {
          const batch = cleanedRecords.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');

          const values: unknown[] = [];
          for (const record of batch) {
            for (const column of columns) {
              values.push(record[column]);
            }
          }

          const sql = `INSERT INTO ${tableName} (${columnNames}) VALUES ${placeholders}`;
          await runPrepared(this.conn, sql, values);
        }
      });

      try {
        await this.metadataService.incrementRowCount(safeDatasetId, cleanedRecords.length);
      } catch (countError) {
        logger.warn('Failed to increment dataset row_count after batch insert', {
          datasetId: safeDatasetId,
          recordCount: cleanedRecords.length,
          error: countError,
        });
      }

      logger.info('Dataset records batch inserted', {
        datasetId: safeDatasetId,
        recordCount: cleanedRecords.length,
      });
    });
  }
}
