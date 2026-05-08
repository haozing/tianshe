import type { DuckDBConnection } from '@duckdb/node-api';
import { CleanBuilder } from '../../core/query-engine';
import type { CleanConfig, SQLContext } from '../../core/query-engine/types';
import { buildMaterializedCleanColumnSpecs } from '../../utils/clean-materialization';
import { isSystemField } from '../../utils/dataset-column-capabilities';
import type { Dataset } from './types';
import type { DatasetMetadataService } from './dataset-metadata-service';
import type { DatasetQueryService } from './dataset-query-service';
import type { DatasetSchemaService } from './dataset-schema-service';
import type { DatasetStorageService } from './dataset-storage-service';
import { sanitizeDatasetId } from './dataset-storage-service';
import { quoteIdentifier } from './utils';

interface DatasetMaterializationServiceOptions {
  conn: DuckDBConnection;
  metadataService: DatasetMetadataService;
  queryService: DatasetQueryService;
  schemaService: DatasetSchemaService;
  storageService: DatasetStorageService;
  getTableName: (safeDatasetId: string) => string;
  ensureAttached: (dataset: Dataset) => Promise<void>;
}

function safeQuoteColumn(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error(`Invalid column name: ${name}`);
  }

  return quoteIdentifier(name);
}

export class DatasetMaterializationService {
  private readonly conn: DuckDBConnection;
  private readonly metadataService: DatasetMetadataService;
  private readonly queryService: DatasetQueryService;
  private readonly schemaService: DatasetSchemaService;
  private readonly storageService: DatasetStorageService;
  private readonly getTableName: (safeDatasetId: string) => string;
  private readonly ensureAttached: (dataset: Dataset) => Promise<void>;

  constructor(options: DatasetMaterializationServiceOptions) {
    this.conn = options.conn;
    this.metadataService = options.metadataService;
    this.queryService = options.queryService;
    this.schemaService = options.schemaService;
    this.storageService = options.storageService;
    this.getTableName = options.getTableName;
    this.ensureAttached = options.ensureAttached;
  }

  async validateComputeExpression(
    datasetId: string,
    expression: string,
    options?: unknown
  ): Promise<unknown> {
    return await this.queryService.validateComputeExpression(datasetId, expression, options);
  }

  async materializeCleanToNewColumns(
    datasetId: string,
    cleanConfig: CleanConfig
  ): Promise<{
    createdColumns: string[];
    updatedColumns: string[];
  }> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
    if (!dataset) throw new Error(`Dataset not found: ${safeDatasetId}`);
    if (!dataset.schema) throw new Error(`Dataset has no schema: ${safeDatasetId}`);

    const materializeTargets = (cleanConfig || [])
      .map((config) => ({
        ...config,
        outputField: config.outputField?.trim(),
      }))
      .filter((config) => !!config.outputField);

    if (materializeTargets.length === 0) {
      throw new Error('请为至少一个清洗字段设置“输出列名”，用于写入新列');
    }

    const outputFields = materializeTargets.map((config) => config.outputField!) as string[];
    const outputFieldSet = new Set<string>();
    for (const fieldConfig of materializeTargets) {
      const outputField = fieldConfig.outputField!;
      if (outputFieldSet.has(outputField)) {
        throw new Error(`输出列名重复：${outputField}`);
      }
      outputFieldSet.add(outputField);

      if (isSystemField(outputField)) {
        throw new Error(`输出列名不能为系统字段：${outputField}`);
      }

      if (outputField === fieldConfig.field) {
        throw new Error(
          `输出列名不能与源字段同名：${outputField}。如需覆盖原字段，请使用“应用清洗”（视图）或在列面板中操作。`
        );
      }
    }

    const existingColumns = new Set(dataset.schema.map((column) => column.name));
    const inferredColumns = buildMaterializedCleanColumnSpecs(materializeTargets, dataset.schema);
    const inferredColumnsByName = new Map(inferredColumns.map((column) => [column.name, column]));
    const createdColumns: string[] = [];

    for (const outputField of outputFields) {
      if (existingColumns.has(outputField)) continue;

      const inferredColumn = inferredColumnsByName.get(outputField);
      if (!inferredColumn) {
        throw new Error(`无法推断清洗输出列类型：${outputField}`);
      }

      await this.schemaService.addColumn({
        datasetId: safeDatasetId,
        columnName: outputField,
        fieldType: inferredColumn.fieldType,
        duckdbTypeOverride: inferredColumn.duckdbType,
        nullable: inferredColumn.nullable,
        metadata: {
          description: '清洗生成列（物化）',
        },
        storageMode: 'physical',
      });

      createdColumns.push(outputField);
      existingColumns.add(outputField);
    }

    await this.storageService.executeInQueue(safeDatasetId, async () => {
      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);
      const requiredColumns = new Set<string>(['_row_id']);
      for (const fieldConfig of materializeTargets) {
        requiredColumns.add(fieldConfig.field);
      }

      const context: SQLContext = {
        datasetId: safeDatasetId,
        currentTable: tableName,
        ctes: [],
        availableColumns: requiredColumns,
      };

      const cleanSQL = new CleanBuilder().build(context, materializeTargets);
      const setClause = outputFields
        .map((column) => `${safeQuoteColumn(column)} = cleaned.${safeQuoteColumn(column)}`)
        .join(', ');

      const updateSQL = `
WITH cleaned AS (
  ${cleanSQL}
)
UPDATE ${tableName} AS t
SET ${setClause}
FROM cleaned
WHERE t._row_id = cleaned._row_id
      `.trim();

      await this.conn.run(updateSQL);
    });

    return { createdColumns, updatedColumns: outputFields };
  }
}
