import type { DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import { generateId } from '../../utils/id-generator';
import type { Dataset, EnhancedColumnSchema } from './types';
import type { DatasetMetadataService } from './dataset-metadata-service';
import type { DatasetStorageService } from './dataset-storage-service';
import { sanitizeDatasetId } from './dataset-storage-service';
import { DatasetTabGroupService, type GroupTabDataset } from './dataset-tab-group-service';
import { getDatasetPath, getFileSize, parseRows, quoteIdentifier, quoteQualifiedName } from './utils';
import { createLogger } from '../../core/logger';

const logger = createLogger('DatasetGroupTabWorkflowService');

interface DatasetGroupTabWorkflowServiceOptions {
  conn: DuckDBConnection;
  metadataService: DatasetMetadataService;
  storageService: DatasetStorageService;
  tabGroupService: DatasetTabGroupService;
  ensureAttached: (dataset: Dataset) => Promise<void>;
  configureRowIdSequence: (
    attachKey: string,
    tableName: string,
    startValue: number
  ) => Promise<void>;
}

function getDescribeColumnName(row: Record<string, unknown>): string {
  const columnName = row.column_name ?? row.column ?? row.name ?? Object.values(row)[0];
  return String(columnName ?? '').trim();
}

function getDescribeColumnType(row: Record<string, unknown>): string {
  const columnType = row.column_type ?? row.type ?? Object.values(row)[1];
  return String(columnType ?? '').trim();
}

function getDescribeNullable(row: Record<string, unknown>): boolean {
  const nullableValue = row.null ?? row.nullable ?? Object.values(row)[2];
  return (
    String(nullableValue ?? 'YES')
      .trim()
      .toUpperCase() !== 'NO'
  );
}

export class DatasetGroupTabWorkflowService {
  private readonly conn: DuckDBConnection;
  private readonly metadataService: DatasetMetadataService;
  private readonly storageService: DatasetStorageService;
  private readonly tabGroupService: DatasetTabGroupService;
  private readonly ensureAttached: (dataset: Dataset) => Promise<void>;
  private readonly configureRowIdSequence: (
    attachKey: string,
    tableName: string,
    startValue: number
  ) => Promise<void>;

  constructor(options: DatasetGroupTabWorkflowServiceOptions) {
    this.conn = options.conn;
    this.metadataService = options.metadataService;
    this.storageService = options.storageService;
    this.tabGroupService = options.tabGroupService;
    this.ensureAttached = options.ensureAttached;
    this.configureRowIdSequence = options.configureRowIdSequence;
  }

  async listGroupTabsByDataset(datasetId: string): Promise<GroupTabDataset[]> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    return this.storageService.executeInQueue(safeDatasetId, async () => {
      return this.tabGroupService.listTabsByDataset(safeDatasetId);
    });
  }

  async reorderGroupTabs(tabGroupId: string, datasetIds: string[]): Promise<void> {
    await this.tabGroupService.reorderTabs(tabGroupId, datasetIds);
  }

  async renameGroupTab(datasetId: string, newName: string): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    const normalizedName = newName.trim();
    if (!normalizedName) {
      throw new Error('Tab name cannot be empty');
    }

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${safeDatasetId}`);
      }

      await this.metadataService.renameDataset(safeDatasetId, normalizedName);
    });
  }

  async cloneDatasetToGroupTab(
    sourceDatasetId: string,
    requestedName?: string
  ): Promise<{ datasetId: string; tabGroupId: string }> {
    const safeSourceId = sanitizeDatasetId(sourceDatasetId);

    return this.storageService.executeInQueue(safeSourceId, async () => {
      const sourceDataset = await this.metadataService.getDatasetInfo(safeSourceId);
      if (!sourceDataset) {
        throw new Error(`Dataset not found: ${safeSourceId}`);
      }

      const tabGroupId = await this.tabGroupService.ensureGroupForDataset(safeSourceId);
      const newDatasetId = generateId('dataset');
      const outputPath = getDatasetPath(newDatasetId);
      const targetAttachKey = `ds_${newDatasetId}`;
      const sourceAttachKey = `ds_${safeSourceId}`;
      const targetTableName = quoteQualifiedName(targetAttachKey, 'data');
      const sourceTableName = quoteQualifiedName(sourceAttachKey, 'data');
      const escapedTargetPath = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

      await this.ensureAttached(sourceDataset);
      await this.conn.run(`ATTACH '${escapedTargetPath}' AS ${quoteIdentifier(targetAttachKey)}`);

      try {
        const physicalColumnNames = await this.createCloneTargetTable(
          targetAttachKey,
          sourceTableName
        );
        await this.copyRowsToCloneTable(sourceTableName, targetTableName, physicalColumnNames);

        if (physicalColumnNames.includes('_row_id')) {
          const finalMaxRowIdResult = await this.conn.runAndReadAll(
            `SELECT COALESCE(MAX(_row_id), 0) AS max_id FROM ${targetTableName}`
          );
          const finalMaxRowId = Number(parseRows(finalMaxRowIdResult)[0]?.max_id ?? 0);
          const safeFinalMax = Number.isFinite(finalMaxRowId) ? finalMaxRowId : 0;
          const nextRowId = safeFinalMax + 1;

          await this.configureRowIdSequence(targetAttachKey, targetTableName, nextRowId);
        }

        const countResult = await this.conn.runAndReadAll(
          `SELECT COUNT(*) AS cnt FROM ${targetTableName}`
        );
        const describeResult = await this.conn.runAndReadAll(`DESCRIBE ${targetTableName}`);
        const rowCount = Number(parseRows(countResult)[0]?.cnt ?? 0);
        const columnCount = parseRows(describeResult).length;
        const nextOrder = await this.tabGroupService.getNextTabOrder(tabGroupId);
        const newName =
          requestedName && requestedName.trim().length > 0
            ? requestedName.trim()
            : `${sourceDataset.name} 副本`;

        await this.metadataService.saveMetadata({
          id: newDatasetId,
          name: newName,
          filePath: outputPath,
          rowCount,
          columnCount,
          sizeBytes: await getFileSize(outputPath),
          createdAt: Date.now(),
          schema: sourceDataset.schema
            ? (JSON.parse(JSON.stringify(sourceDataset.schema)) as EnhancedColumnSchema[])
            : undefined,
          folderId: sourceDataset.folderId ?? null,
          tableOrder: sourceDataset.tableOrder ?? 0,
          tabGroupId,
          tabOrder: nextOrder,
          isGroupDefault: false,
          createdByPlugin: sourceDataset.createdByPlugin ?? null,
        });

        logger.info('Cloned dataset into group tab', {
          sourceDatasetId: safeSourceId,
          datasetId: newDatasetId,
          tabGroupId,
        });

        return { datasetId: newDatasetId, tabGroupId };
      } catch (error) {
        try {
          await this.conn.run(`DETACH ${quoteIdentifier(targetAttachKey)}`);
        } catch {
          // ignore detach errors in cleanup path
        }
        await fs.remove(outputPath).catch(() => undefined);
        throw error;
      } finally {
        try {
          const attached = await this.conn.runAndReadAll(
            `SELECT database_name FROM duckdb_databases() WHERE database_name = ?`,
            [targetAttachKey]
          );
          if (parseRows(attached).length > 0) {
            await this.conn.run(`DETACH ${quoteIdentifier(targetAttachKey)}`);
          }
        } catch {
          // non-critical
        }
      }
    });
  }

  private async createCloneTargetTable(
    targetAttachKey: string,
    sourceTableName: string
  ): Promise<string[]> {
    const describeResult = await this.conn.runAndReadAll(`DESCRIBE ${sourceTableName}`);
    const describeRows = parseRows(describeResult);
    if (describeRows.length === 0) {
      throw new Error('Source dataset table has no physical columns');
    }

    const targetTableName = quoteQualifiedName(targetAttachKey, 'data');
    const targetColumnDefinitions = describeRows.map((row: Record<string, unknown>) => {
      const columnName = getDescribeColumnName(row);
      const columnType = getDescribeColumnType(row);
      const nullable = getDescribeNullable(row);

      if (!columnName || !columnType) {
        throw new Error('Failed to inspect source dataset table schema');
      }

      if (columnName === '_row_id') {
        return `${quoteIdentifier(columnName)} BIGINT PRIMARY KEY`;
      }
      if (columnName === 'created_at' || columnName === 'updated_at') {
        return `${quoteIdentifier(columnName)} ${columnType} DEFAULT (now())`;
      }
      if (columnName === 'deleted_at') {
        return `${quoteIdentifier(columnName)} ${columnType} DEFAULT NULL`;
      }

      return `${quoteIdentifier(columnName)} ${columnType}${nullable ? '' : ' NOT NULL'}`;
    });

    await this.conn.run(`CREATE TABLE ${targetTableName} (${targetColumnDefinitions.join(', ')})`);
    await this.configureRowIdSequence(targetAttachKey, targetTableName, 1);

    return describeRows.map((row: Record<string, unknown>) => getDescribeColumnName(row));
  }

  private async copyRowsToCloneTable(
    sourceTableName: string,
    targetTableName: string,
    columnNames: string[]
  ): Promise<void> {
    const quotedColumns = columnNames.map((name) => quoteIdentifier(name)).join(', ');
    const hasRowIdColumn = columnNames.includes('_row_id');
    const selectedColumns = columnNames
      .map((name) =>
        name === '_row_id'
          ? `${quoteIdentifier('__normalized_row_id')} AS ${quoteIdentifier(name)}`
          : quoteIdentifier(name)
      )
      .join(', ');

    if (hasRowIdColumn) {
      await this.conn.run(`
        INSERT INTO ${targetTableName} (${quotedColumns})
        WITH source_rows AS (
          SELECT
            *,
            CASE
              WHEN ${quoteIdentifier('_row_id')} IS NOT NULL THEN ${quoteIdentifier('_row_id')}
              ELSE COALESCE(MAX(${quoteIdentifier('_row_id')}) OVER (), 0)
                + ROW_NUMBER() OVER (ORDER BY rowid)
            END AS ${quoteIdentifier('__normalized_row_id')}
          FROM ${sourceTableName}
        )
        SELECT ${selectedColumns}
        FROM source_rows
      `);
      return;
    }

    await this.conn.run(`
      INSERT INTO ${targetTableName} (${quotedColumns})
      SELECT ${quotedColumns}
      FROM ${sourceTableName}
    `);
  }
}
