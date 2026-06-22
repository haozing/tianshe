import { randomUUID } from 'node:crypto';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { HookBus } from '../../core/hookbus';
import { createLogger } from '../../core/logger';
import { getCurrentTraceContext } from '../../core/observability/observation-context';
import {
  partitionRecordFieldsBySchema,
  stripSystemFields,
} from '../../utils/dataset-column-capabilities';
import type { DataRecord, Dataset } from './types';
import type { DatasetMetadataService } from './dataset-metadata-service';
import type { DatasetStorageService } from './dataset-storage-service';
import { sanitizeDatasetId } from './dataset-storage-service';
import { allPrepared, runPrepared } from './statement-executor';
import type {
  DatasetMutationOperation,
  DatasetProvenanceContext,
  DatasetProvenanceService,
} from './dataset-provenance-service';
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
  provenanceService?: DatasetProvenanceService;
}

export type DatasetStagedWriteOperation =
  | { type: 'insert'; record: DataRecord }
  | { type: 'update'; rowId: number; updates: DataRecord }
  | { type: 'delete'; rowIds: number[] };

export interface DatasetStagedWritePlan {
  planId: string;
  datasetId: string;
  createdAt: string;
  operations: DatasetStagedWriteOperation[];
  rowCount: number;
  requiresConfirmation: true;
  provenance?: DatasetProvenanceContext;
}

export interface CommitDatasetStagedWritePlanOptions extends DatasetProvenanceContext {
  confirmRisk: true;
}

export interface DatasetWriteCommitResult {
  planId: string;
  runId: string;
  datasetId: string;
  insertedRowIds: number[];
  updatedRowIds: number[];
  deletedRowIds: number[];
  affectedRowCount: number;
  provenanceRecorded: boolean;
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
  private readonly provenanceService?: DatasetProvenanceService;

  constructor(options: DatasetRecordMutationServiceOptions) {
    this.conn = options.conn;
    this.storageService = options.storageService;
    this.metadataService = options.metadataService;
    this.getTableName = options.getTableName;
    this.ensureAttached = options.ensureAttached;
    this.hookBus = options.hookBus;
    this.provenanceService = options.provenanceService;
  }

  private getProvenanceContext(
    context: DatasetProvenanceContext | undefined
  ): DatasetProvenanceContext {
    const traceContext = getCurrentTraceContext();
    return {
      traceId: context?.traceId ?? traceContext?.traceId ?? null,
      adapterId: context?.adapterId ?? null,
      adapterVersion: context?.adapterVersion ?? null,
      runtimeId: context?.runtimeId ?? traceContext?.browserRuntimeId ?? null,
      sourceUrl: context?.sourceUrl ?? null,
      metadata: context?.metadata ?? null,
    };
  }

  private normalizeStagedOperations(
    dataset: Dataset,
    operations: DatasetStagedWriteOperation[]
  ): DatasetStagedWriteOperation[] {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error('Staged dataset write plan requires at least one operation');
    }

    return operations.map((operation) => {
      if (operation.type === 'insert') {
        return {
          type: 'insert',
          record: getWritableRecordForDataset(dataset, operation.record || {}),
        };
      }
      if (operation.type === 'update') {
        if (!Number.isInteger(operation.rowId) || operation.rowId < 0) {
          throw new Error('Update operation rowId must be a non-negative integer');
        }
        return {
          type: 'update',
          rowId: operation.rowId,
          updates: getWritableRecordForDataset(dataset, operation.updates || {}),
        };
      }
      if (operation.type === 'delete') {
        const rowIds = Array.from(new Set(operation.rowIds || []));
        if (rowIds.length === 0 || rowIds.some((rowId) => !Number.isInteger(rowId) || rowId < 0)) {
          throw new Error('Delete operation rowIds must be non-negative integers');
        }
        return {
          type: 'delete',
          rowIds,
        };
      }
      throw new Error(`Unsupported staged dataset write operation: ${(operation as any).type}`);
    });
  }

  private getPlannedRowCount(operations: DatasetStagedWriteOperation[]): number {
    return operations.reduce((count, operation) => {
      if (operation.type === 'delete') {
        return count + operation.rowIds.length;
      }
      return count + 1;
    }, 0);
  }

  private async getRecentInsertedRowIds(tableName: string, count: number): Promise<number[]> {
    if (count <= 0) {
      return [];
    }
    const result = await this.conn.runAndReadAll(
      `SELECT _row_id FROM ${tableName} ORDER BY _row_id DESC LIMIT ${Math.trunc(count)}`
    );
    return parseRows(result)
      .map((row) => Number(row._row_id))
      .filter((rowId) => Number.isFinite(rowId))
      .reverse();
  }

  private async recordMutationProvenanceBestEffort(params: {
    datasetId: string;
    operation: DatasetMutationOperation;
    rowIds: number[];
    context?: DatasetProvenanceContext;
  }): Promise<void> {
    if (!this.provenanceService || params.rowIds.length === 0) {
      return;
    }

    const context = this.getProvenanceContext(params.context);
    const finishedAt = Date.now();
    try {
      const run = await this.provenanceService.recordRun({
        ...context,
        datasetId: params.datasetId,
        operation: params.operation,
        status: 'completed',
        rowCount: params.rowIds.length,
        startedAt: finishedAt,
        finishedAt,
      });
      await this.provenanceService.recordRows(
        params.rowIds.map((rowId) => ({
          ...context,
          datasetId: params.datasetId,
          rowId,
          runId: run.runId,
          operation: params.operation,
          occurredAt: finishedAt,
        }))
      );
    } catch (error) {
      logger.warn('Failed to record dataset mutation provenance', {
        datasetId: params.datasetId,
        operation: params.operation,
        error,
      });
    }
  }

  async createStagedWritePlan(
    datasetId: string,
    operations: DatasetStagedWriteOperation[],
    context?: DatasetProvenanceContext
  ): Promise<DatasetStagedWritePlan> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
    if (!dataset) {
      throw new Error('Dataset not found');
    }

    const normalizedOperations = this.normalizeStagedOperations(dataset, operations);
    return {
      planId: randomUUID(),
      datasetId: safeDatasetId,
      createdAt: new Date().toISOString(),
      operations: normalizedOperations,
      rowCount: this.getPlannedRowCount(normalizedOperations),
      requiresConfirmation: true,
      provenance: this.getProvenanceContext(context),
    };
  }

  async commitStagedWritePlan(
    plan: DatasetStagedWritePlan,
    options: CommitDatasetStagedWritePlanOptions
  ): Promise<DatasetWriteCommitResult> {
    if (options.confirmRisk !== true) {
      throw new Error('confirmRisk must be true to commit a staged dataset write plan');
    }

    const safeDatasetId = sanitizeDatasetId(plan.datasetId);
    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) {
        throw new Error('Dataset not found');
      }

      const normalizedOperations = this.normalizeStagedOperations(dataset, plan.operations);
      await this.ensureAttached(dataset);
      await this.provenanceService?.ensureDatasetSidecarTables(safeDatasetId);
      const tableName = this.getTableName(safeDatasetId);
      const context = this.getProvenanceContext({
        ...(plan.provenance || {}),
        ...options,
      });
      const startedAt = Date.now();
      const insertedRowIds: number[] = [];
      const updatedRowIds: number[] = [];
      const deletedRowIds: number[] = [];
      const runId = plan.planId || randomUUID();

      await runInDuckDbTransaction(this.conn, async () => {
        for (const operation of normalizedOperations) {
          if (operation.type === 'insert') {
            const rowId = await this.insertRecordInCurrentQueue(
              safeDatasetId,
              dataset,
              operation.record,
              { updateRowCount: false }
            );
            insertedRowIds.push(rowId);
          } else if (operation.type === 'update') {
            await this.updateRecordInCurrentQueue(
              safeDatasetId,
              dataset,
              tableName,
              operation.rowId,
              operation.updates
            );
            updatedRowIds.push(operation.rowId);
          } else if (operation.type === 'delete') {
            const deleted = await this.hardDeleteRowsInCurrentQueue(
              safeDatasetId,
              tableName,
              operation.rowIds
            );
            deletedRowIds.push(...deleted);
          }
        }

        if (this.provenanceService) {
          const finishedAt = Date.now();
          const affectedRowIds = [...insertedRowIds, ...updatedRowIds, ...deletedRowIds];
          await this.provenanceService.recordRun({
            ...context,
            runId,
            datasetId: safeDatasetId,
            operation: 'staged_write',
            status: 'completed',
            rowCount: affectedRowIds.length,
            startedAt,
            finishedAt,
          }, { datasetSidecar: safeDatasetId });
          await this.provenanceService.recordRows([
            ...insertedRowIds.map((rowId) => ({
              ...context,
              datasetId: safeDatasetId,
              rowId,
              runId,
              operation: 'insert' as const,
              occurredAt: finishedAt,
            })),
            ...updatedRowIds.map((rowId) => ({
              ...context,
              datasetId: safeDatasetId,
              rowId,
              runId,
              operation: 'update' as const,
              occurredAt: finishedAt,
            })),
            ...deletedRowIds.map((rowId) => ({
              ...context,
              datasetId: safeDatasetId,
              rowId,
              runId,
              operation: 'delete' as const,
              occurredAt: finishedAt,
            })),
          ], { datasetSidecar: safeDatasetId });
        }
      });

      const rowDelta = insertedRowIds.length - deletedRowIds.length;
      if (rowDelta !== 0) {
        try {
          await this.metadataService.incrementRowCount(safeDatasetId, rowDelta);
        } catch (countError) {
          await this.reconcileRowCountAfterDeltaFailure(dataset, rowDelta, countError);
        }
      }

      return {
        planId: plan.planId,
        runId,
        datasetId: safeDatasetId,
        insertedRowIds,
        updatedRowIds,
        deletedRowIds,
        affectedRowCount: insertedRowIds.length + updatedRowIds.length + deletedRowIds.length,
        provenanceRecorded: Boolean(this.provenanceService),
      };
    });
  }

  private async reconcileRowCountAfterDeltaFailure(
    dataset: Dataset,
    delta: number,
    error: unknown
  ): Promise<void> {
    try {
      const actualRowCount = await this.metadataService.reconcileRowCountInCurrentQueue(dataset);
      logger.warn('Reconciled dataset row_count after delta update failed', {
        datasetId: dataset.id,
        delta,
        actualRowCount,
        error,
      });
    } catch (reconcileError) {
      logger.error('Failed to reconcile dataset row_count after delta update failed', {
        datasetId: dataset.id,
        delta,
        originalError: error,
        reconcileError,
      });
    }
  }

  private async hardDeleteRowsInCurrentQueue(
    safeDatasetId: string,
    tableName: string,
    uniqueRowIds: number[]
  ): Promise<number[]> {
    const BATCH_SIZE = 1000;
    const deletedRowIds: number[] = [];

    for (let i = 0; i < uniqueRowIds.length; i += BATCH_SIZE) {
      const batch = uniqueRowIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(', ');
      const existingSql = `SELECT _row_id FROM ${tableName} WHERE _row_id IN (${placeholders})`;
      const existingResult = await allPrepared(this.conn, existingSql, batch);
      const existingRowIds = parseRows(existingResult)
        .map((row) => Number(row._row_id))
        .filter((rowId) => Number.isFinite(rowId));
      if (existingRowIds.length === 0) {
        continue;
      }

      const deletePlaceholders = existingRowIds.map(() => '?').join(', ');
      const deleteSql = `DELETE FROM ${tableName} WHERE _row_id IN (${deletePlaceholders})`;
      await runPrepared(this.conn, deleteSql, existingRowIds);
      deletedRowIds.push(...existingRowIds);
    }

    logger.warn('Permanently deleted dataset rows in current queue', {
      datasetId: safeDatasetId,
      deletedCount: deletedRowIds.length,
    });
    return deletedRowIds;
  }

  private async updateRecordInCurrentQueue(
    safeDatasetId: string,
    dataset: Dataset,
    tableName: string,
    rowId: number,
    updates: DataRecord
  ): Promise<DataRecord> {
    const writableUpdates = getWritableRecordForDataset(dataset, updates);
    const columns = Object.keys(writableUpdates);
    const values = Object.values(writableUpdates);

    if (columns.length === 0) {
      throw new Error('Updates must have at least one column');
    }

    const setExpressions = columns.map((col) => `${safeQuoteColumn(col)} = ?`);
    if (hasDatasetColumn(dataset, 'updated_at')) {
      setExpressions.push(`${safeQuoteColumn('updated_at')} = now()`);
    }
    const setClause = setExpressions.join(', ');
    const sql = `UPDATE ${tableName} SET ${setClause} WHERE _row_id = ?`;

    logger.info('Updating dataset record', { datasetId: safeDatasetId, rowId });
    await runPrepared(this.conn, sql, [...values, rowId]);
    return writableUpdates;
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

      let deletedRowIds: number[] = [];
      await runInDuckDbTransaction(this.conn, async () => {
        deletedRowIds = await this.hardDeleteRowsInCurrentQueue(
          safeDatasetId,
          tableName,
          uniqueRowIds
        );
      });

      if (deletedRowIds.length > 0) {
        try {
          await this.metadataService.incrementRowCount(safeDatasetId, -deletedRowIds.length);
        } catch (countError) {
          await this.reconcileRowCountAfterDeltaFailure(dataset, -deletedRowIds.length, countError);
        }
        await this.recordMutationProvenanceBestEffort({
          datasetId: safeDatasetId,
          operation: 'delete',
          rowIds: deletedRowIds,
        });
      }

      logger.warn('Permanently deleted dataset rows', {
        datasetId: safeDatasetId,
        deletedCount: deletedRowIds.length,
      });
      return deletedRowIds.length;
    });
  }

  async updateRecord(datasetId: string, rowId: number, updates: DataRecord): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);
      let writableUpdates: DataRecord = {};

      await runInDuckDbTransaction(this.conn, async () => {
        writableUpdates = await this.updateRecordInCurrentQueue(
          safeDatasetId,
          dataset,
          tableName,
          rowId,
          updates
        );
      });

      logger.info('Dataset record updated', { datasetId: safeDatasetId, rowId });
      await this.recordMutationProvenanceBestEffort({
        datasetId: safeDatasetId,
        operation: 'update',
        rowIds: [rowId],
      });

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
      const updatedRowIds: number[] = [];

      await runInDuckDbTransaction(this.conn, async () => {
        for (const update of updates) {
          const writableUpdates = getWritableRecordForDataset(dataset, update.updates);
          if (Object.keys(writableUpdates).length === 0) {
            continue;
          }
          await this.updateRecordInCurrentQueue(
            safeDatasetId,
            dataset,
            tableName,
            update.rowId,
            writableUpdates
          );
          updatedRowIds.push(update.rowId);
        }
      });
      logger.info('Dataset records batch updated', {
        datasetId: safeDatasetId,
        updateCount: updates.length,
      });
      await this.recordMutationProvenanceBestEffort({
        datasetId: safeDatasetId,
        operation: 'update',
        rowIds: updatedRowIds,
      });
    });
  }

  async insertRecord(datasetId: string, record: DataRecord): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      const rowId = await this.insertRecordInCurrentQueue(safeDatasetId, dataset, record);
      logger.info('Dataset record inserted', { datasetId: safeDatasetId });
      await this.recordMutationProvenanceBestEffort({
        datasetId: safeDatasetId,
        operation: 'insert',
        rowIds: Number.isFinite(rowId) ? [rowId] : [],
      });
    });
  }

  private async insertRecordInCurrentQueue(
    safeDatasetId: string,
    dataset: Dataset,
    record: DataRecord,
    options: { updateRowCount?: boolean } = {}
  ): Promise<number> {
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
    const [rowId] = await this.getRecentInsertedRowIds(tableName, 1);

    if (options.updateRowCount !== false) {
      try {
        await this.metadataService.incrementRowCount(safeDatasetId, 1);
      } catch (countError) {
        await this.reconcileRowCountAfterDeltaFailure(dataset, 1, countError);
      }
    }

    this.hookBus?.emit('webhook:record.created', {
      datasetId: safeDatasetId,
      record: cleanedRecord,
    });

    return rowId;
  }

  async batchInsertRecords(datasetId: string, records: DataRecord[]): Promise<void> {
    if (records.length === 0) return;

    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      if (records.length === 1) {
        const rowId = await this.insertRecordInCurrentQueue(safeDatasetId, dataset, records[0]);
        await this.recordMutationProvenanceBestEffort({
          datasetId: safeDatasetId,
          operation: 'insert',
          rowIds: Number.isFinite(rowId) ? [rowId] : [],
        });
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
      let insertedRowIds: number[] = [];
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
        insertedRowIds = await this.getRecentInsertedRowIds(tableName, cleanedRecords.length);
      });

      try {
        await this.metadataService.incrementRowCount(safeDatasetId, cleanedRecords.length);
      } catch (countError) {
        await this.reconcileRowCountAfterDeltaFailure(dataset, cleanedRecords.length, countError);
      }
      await this.recordMutationProvenanceBestEffort({
        datasetId: safeDatasetId,
        operation: 'insert',
        rowIds: insertedRowIds,
      });

      logger.info('Dataset records batch inserted', {
        datasetId: safeDatasetId,
        recordCount: cleanedRecords.length,
      });
    });
  }
}
