import fs from 'node:fs';
import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import type {
  OrchestrationCapabilityDefinition,
  OrchestrationDatasetProvenanceContext,
  OrchestrationDatasetStagedWritePlan,
  OrchestrationDatasetWriteOperation,
  OrchestrationDependencies,
} from '../orchestration/types';
import type { CapabilityHandler } from './types';
import type { RegisteredCapability } from './browser-catalog';
import { createStructuredResult } from './result-utils';
import {
  buildCapabilityAnnotations,
  type CapabilityMetadata,
  createArrayItemsSchema,
  createOpaqueOutputSchema,
  createStructuredEnvelopeSchema,
  toCapabilityTitle,
} from './catalog-utils';

const DATASET_CAPABILITY_VERSION = '1.0.0';

const DATASET_READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 800,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['dataset.read'],
  requires: ['datasetGateway'],
};

const DATASET_WRITE_METADATA: CapabilityMetadata = {
  idempotent: false,
  sideEffectLevel: 'low',
  estimatedLatencyMs: 1000,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['dataset.write'],
  requires: ['datasetGateway'],
};

const DATASET_IMPORT_METADATA: CapabilityMetadata = {
  ...DATASET_WRITE_METADATA,
  sideEffectLevel: 'high',
  estimatedLatencyMs: 30_000,
};

const DATASET_STAGE_WRITE_METADATA: CapabilityMetadata = {
  ...DATASET_WRITE_METADATA,
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 500,
};

const DATASET_COMMIT_WRITE_METADATA: CapabilityMetadata = {
  ...DATASET_WRITE_METADATA,
  sideEffectLevel: 'high',
  estimatedLatencyMs: 2_000,
};

const DATASET_WRITE_OPERATION_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'record'],
      properties: {
        type: { const: 'insert' },
        record: { type: 'object', additionalProperties: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'rowId', 'updates'],
      properties: {
        type: { const: 'update' },
        rowId: { type: 'number', minimum: 0 },
        updates: { type: 'object', additionalProperties: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'rowIds'],
      properties: {
        type: { const: 'delete' },
        rowIds: { type: 'array', minItems: 1, items: { type: 'number', minimum: 0 } },
      },
    },
  ],
};

const DATASET_PROVENANCE_CONTEXT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    traceId: { type: ['string', 'null'] },
    adapterId: { type: ['string', 'null'] },
    adapterVersion: { type: ['string', 'null'] },
    runtimeId: { type: ['string', 'null'] },
    sourceUrl: { type: ['string', 'null'] },
    metadata: { type: ['object', 'null'], additionalProperties: true },
  },
};

const DATASET_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  dataset_list: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['total', 'datasets'],
    properties: {
      total: { type: 'number' },
      datasets: createArrayItemsSchema(),
    },
  }),
  dataset_get_info: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: true,
  }),
  dataset_query: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['datasetId', 'columns', 'rowCount', 'filteredTotalCount', 'rows'],
    properties: {
      datasetId: { type: 'string' },
      columns: {
        type: 'array',
        items: { type: 'string' },
      },
      rowCount: { type: 'number' },
      filteredTotalCount: { type: ['number', 'null'] },
      rows: createArrayItemsSchema(),
    },
  }),
  dataset_create_empty: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['datasetId', 'datasetName', 'folderId', 'created'],
    properties: {
      datasetId: { type: 'string' },
      datasetName: { type: 'string' },
      folderId: { type: ['string', 'null'] },
      created: { type: 'boolean' },
      dataset: createOpaqueOutputSchema(),
    },
  }),
  dataset_import_file: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['datasetId', 'datasetName', 'filePath', 'imported'],
    properties: {
      datasetId: { type: 'string' },
      datasetName: { type: 'string' },
      filePath: { type: 'string' },
      folderId: { type: ['string', 'null'] },
      imported: { type: 'boolean' },
      dataset: createOpaqueOutputSchema(),
    },
  }),
  dataset_stage_write_plan: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['planId', 'datasetId', 'rowCount', 'requiresConfirmation', 'plan'],
    properties: {
      planId: { type: 'string' },
      datasetId: { type: 'string' },
      rowCount: { type: 'number' },
      requiresConfirmation: { type: 'boolean' },
      plan: createOpaqueOutputSchema(),
    },
  }),
  dataset_commit_write_plan: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['planId', 'datasetId', 'runId', 'committed', 'affectedRowCount'],
    properties: {
      planId: { type: 'string' },
      datasetId: { type: 'string' },
      runId: { type: 'string' },
      committed: { type: 'boolean' },
      affectedRowCount: { type: 'number' },
      insertedRowIds: { type: 'array', items: { type: 'number' } },
      updatedRowIds: { type: 'array', items: { type: 'number' } },
      deletedRowIds: { type: 'array', items: { type: 'number' } },
      provenanceRecorded: { type: 'boolean' },
    },
  }),
  dataset_get_record_provenance: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['datasetId', 'rowId', 'total', 'provenance'],
    properties: {
      datasetId: { type: 'string' },
      rowId: { type: 'number' },
      total: { type: 'number' },
      provenance: createArrayItemsSchema(),
    },
  }),
  dataset_rename: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['datasetId', 'newName', 'renamed'],
    properties: {
      datasetId: { type: 'string' },
      newName: { type: 'string' },
      renamed: { type: 'boolean' },
      dataset: createOpaqueOutputSchema(),
    },
  }),
  dataset_delete: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['datasetId', 'deleted'],
    properties: {
      datasetId: { type: 'string' },
      datasetName: { type: 'string' },
      deleted: { type: 'boolean' },
    },
  }),
};

const readStringArg = (
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = { required: true }
): string | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be string`);
  }
  const value = raw.trim();
  if (!value && options.required) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} cannot be empty`);
  }
  return value || undefined;
};

const readNumberArg = (
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number } = {}
): number | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be number`);
  }
  if (options.min !== undefined && raw < options.min) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be >= ${options.min}`
    );
  }
  if (options.max !== undefined && raw > options.max) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be <= ${options.max}`
    );
  }
  return raw;
};

const readObjectArg = (
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = { required: true }
): Record<string, unknown> | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be object`);
  }
  return raw as Record<string, unknown>;
};

const readProvenanceContextArg = (
  args: Record<string, unknown>,
  key = 'provenance'
): OrchestrationDatasetProvenanceContext | undefined => {
  const value = readObjectArg(args, key, { required: false });
  if (!value) {
    return undefined;
  }
  return {
    traceId: typeof value.traceId === 'string' ? value.traceId : null,
    adapterId: typeof value.adapterId === 'string' ? value.adapterId : null,
    adapterVersion: typeof value.adapterVersion === 'string' ? value.adapterVersion : null,
    runtimeId: typeof value.runtimeId === 'string' ? value.runtimeId : null,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : null,
    metadata:
      value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
        ? (value.metadata as Record<string, unknown>)
        : null,
  };
};

const readStagedWritePlanArg = (
  args: Record<string, unknown>
): OrchestrationDatasetStagedWritePlan => {
  const plan = readObjectArg(args, 'plan');
  if (!plan) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, 'Missing required parameter: plan');
  }

  const planId = typeof plan.planId === 'string' ? plan.planId.trim() : '';
  const datasetId = typeof plan.datasetId === 'string' ? plan.datasetId.trim() : '';
  const operations = Array.isArray(plan.operations) ? plan.operations : null;
  if (!planId || !datasetId || !operations || operations.length === 0) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'Parameter plan must be a staged dataset write plan returned by dataset_stage_write_plan',
      {
        context: {
          hasPlanId: Boolean(planId),
          hasDatasetId: Boolean(datasetId),
          operationCount: operations?.length ?? 0,
        },
      }
    );
  }

  return plan as unknown as OrchestrationDatasetStagedWritePlan;
};

const readWriteOperationsArg = (
  args: Record<string, unknown>
): OrchestrationDatasetWriteOperation[] => {
  const raw = args.operations;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'Parameter operations must be a non-empty array'
    );
  }

  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        `operations[${index}] must be object`
      );
    }
    const operation = item as Record<string, unknown>;
    if (operation.type === 'insert') {
      if (!operation.record || typeof operation.record !== 'object' || Array.isArray(operation.record)) {
        throw createStructuredError(
          ErrorCode.INVALID_PARAMETER,
          `operations[${index}].record must be object`
        );
      }
      return {
        type: 'insert',
        record: operation.record as Record<string, unknown>,
      };
    }
    if (operation.type === 'update') {
      if (typeof operation.rowId !== 'number' || !Number.isInteger(operation.rowId)) {
        throw createStructuredError(
          ErrorCode.INVALID_PARAMETER,
          `operations[${index}].rowId must be integer`
        );
      }
      if (!operation.updates || typeof operation.updates !== 'object' || Array.isArray(operation.updates)) {
        throw createStructuredError(
          ErrorCode.INVALID_PARAMETER,
          `operations[${index}].updates must be object`
        );
      }
      return {
        type: 'update',
        rowId: operation.rowId,
        updates: operation.updates as Record<string, unknown>,
      };
    }
    if (operation.type === 'delete') {
      if (
        !Array.isArray(operation.rowIds) ||
        operation.rowIds.length === 0 ||
        operation.rowIds.some((rowId) => typeof rowId !== 'number' || !Number.isInteger(rowId))
      ) {
        throw createStructuredError(
          ErrorCode.INVALID_PARAMETER,
          `operations[${index}].rowIds must be a non-empty integer array`
        );
      }
      return {
        type: 'delete',
        rowIds: operation.rowIds,
      };
    }
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Unsupported dataset write operation type at operations[${index}]`
    );
  });
};

const readOptionalFolderIdArg = (
  args: Record<string, unknown>,
  key: string
): string | null | undefined => {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be string or null`);
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }
  return value;
};

const readRequiredConfirmationArg = (args: Record<string, unknown>, key: string): true => {
  const raw = args[key];
  if (raw !== true) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be true for this high-risk dataset operation`,
      {
        suggestion: `Re-issue the call with ${key}: true only after verifying the dataset import source and expected side effects.`,
        context: {
          parameter: key,
          expected: true,
        },
      }
    );
  }
  return true;
};

const isAbsoluteLocalPath = (value: string): boolean =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');

const readExistingFileArg = (args: Record<string, unknown>, key: string): string => {
  const value = readStringArg(args, key) || '';
  if (!isAbsoluteLocalPath(value)) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be an absolute local file path`,
      {
        suggestion: 'Pass an absolute file path on the current machine instead of a relative path.',
        context: { parameter: key, value },
      }
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(value);
  } catch {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Path not found: ${value}`, {
      suggestion: 'Verify the dataset source file exists on the host running Airpa before retrying.',
      context: { parameter: key, value },
    });
  }

  if (!stats.isFile()) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must point to a file`,
      {
        context: { parameter: key, value },
      }
    );
  }

  return value;
};

const ensureDatasetGateway = (deps: OrchestrationDependencies) => {
  if (!deps.datasetGateway) {
    throw createStructuredError(ErrorCode.OPERATION_FAILED, 'Dataset gateway is not configured', {
      suggestion: '请在 orchestration 依赖中注入 datasetGateway',
    });
  }
  return deps.datasetGateway;
};

const datasetListHandler: CapabilityHandler<OrchestrationDependencies> = async (_args, deps) => {
  const gateway = ensureDatasetGateway(deps);
  const datasets = await gateway.listDatasets();
  return createStructuredResult(
    {
      summary: `Found ${datasets.length} dataset(s).`,
      data: {
        total: datasets.length,
        datasets,
      },
      nextActionHints: [
        'Use dataset_get_info to inspect one dataset before querying.',
        'Use dataset_query with a limit to keep result size manageable.',
      ],
    },
    { includeJsonInText: true }
  );
};

const datasetGetInfoHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureDatasetGateway(deps);
  const datasetId = readStringArg(args, 'datasetId');
  const dataset = await gateway.getDatasetInfo(datasetId || '');
  if (!dataset) {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Dataset not found: ${datasetId}`, {
      context: { datasetId },
    });
  }
  return createStructuredResult(
    {
      summary: `Loaded dataset metadata for ${datasetId}.`,
      data: {
        datasetId,
        dataset,
      },
      nextActionHints: ['Use dataset_query with a limit to preview rows.'],
    },
    { includeJsonInText: true }
  );
};

const datasetQueryHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureDatasetGateway(deps);
  const datasetId = readStringArg(args, 'datasetId');
  const sql = readStringArg(args, 'sql', { required: false });
  const offset = readNumberArg(args, 'offset', { required: false, min: 0 });
  const limit = readNumberArg(args, 'limit', { required: false, min: 1, max: 10000 });

  const result = await gateway.queryDataset(datasetId || '', sql, offset, limit);
  return createStructuredResult(
    {
      summary: `Query returned ${result.rowCount} row(s) from dataset ${datasetId}.`,
      data: {
        datasetId,
        columns: result.columns,
        rowCount: result.rowCount,
        filteredTotalCount: result.filteredTotalCount ?? null,
        rows: result.rows,
      },
      truncated:
        typeof limit === 'number' &&
        Array.isArray(result.rows) &&
        result.rows.length >= limit &&
        (result.filteredTotalCount ?? result.rowCount) > result.rows.length,
      nextActionHints: [
        'Tighten limit/offset to page through large datasets.',
        'Add SQL when you need server-side filtering or aggregation.',
      ],
    },
    { includeJsonInText: true }
  );
};

const datasetCreateEmptyHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps
) => {
  const gateway = ensureDatasetGateway(deps);
  const datasetName = readStringArg(args, 'datasetName');
  const folderId = readOptionalFolderIdArg(args, 'folderId');
  const datasetId = await gateway.createEmptyDataset(datasetName || '', { folderId });
  const dataset = await gateway.getDatasetInfo(datasetId);

  return createStructuredResult({
    summary: `Created empty dataset ${datasetId}.`,
    data: {
      datasetId,
      datasetName,
      folderId: folderId ?? null,
      created: true,
      ...(dataset ? { dataset } : {}),
    },
    nextActionHints: [
      'Use system_bootstrap when you want a refreshed resource preview after creating a dataset.',
      'Use observation_get_trace_summary if the create operation failed and you already have the traceId.',
    ],
    recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    authoritativeFields: ['structuredContent.data.datasetId', 'structuredContent.data.created'],
  });
};

const datasetImportFileHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureDatasetGateway(deps);
  readRequiredConfirmationArg(args, 'confirmRisk');

  const filePath = readExistingFileArg(args, 'filePath');
  const datasetName = readStringArg(args, 'datasetName') || '';
  const folderId = readOptionalFolderIdArg(args, 'folderId');

  const datasetId = await gateway.importDatasetFile(filePath, datasetName, { folderId });
  const dataset = await gateway.getDatasetInfo(datasetId);

  return createStructuredResult({
    summary: `Imported dataset ${datasetId} from ${filePath}.`,
    data: {
      datasetId,
      datasetName,
      filePath,
      folderId: folderId ?? null,
      imported: true,
      ...(dataset ? { dataset } : {}),
    },
    nextActionHints: [
      'Use system_bootstrap when you want a refreshed framework-level resource summary after the import.',
      'Use observation_get_trace_summary if the import failed and you already have the traceId.',
    ],
    recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    authoritativeFields: [
      'structuredContent.data.datasetId',
      'structuredContent.data.filePath',
      'structuredContent.data.imported',
    ],
  });
};

const datasetStageWritePlanHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps
) => {
  const gateway = ensureDatasetGateway(deps);
  if (!gateway.stageWritePlan) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Dataset gateway does not support staged write plans'
    );
  }

  const datasetId = readStringArg(args, 'datasetId') || '';
  const operations = readWriteOperationsArg(args);
  const provenance = readProvenanceContextArg(args);
  const plan = await gateway.stageWritePlan(datasetId, operations, provenance);

  return createStructuredResult({
    summary: `Prepared staged dataset write plan ${plan.planId}.`,
    data: {
      planId: plan.planId,
      datasetId: plan.datasetId,
      rowCount: plan.rowCount,
      requiresConfirmation: true,
      plan,
    },
    nextActionHints: [
      'Review the staged plan before committing.',
      'Call dataset_commit_write_plan with confirmRisk=true only after confirming the intended row changes.',
    ],
    recommendedNextTools: ['dataset_commit_write_plan', 'dataset_get_record_provenance'],
    authoritativeFields: [
      'structuredContent.data.planId',
      'structuredContent.data.plan',
      'structuredContent.data.requiresConfirmation',
    ],
  });
};

const datasetCommitWritePlanHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps
) => {
  const gateway = ensureDatasetGateway(deps);
  if (!gateway.commitWritePlan) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Dataset gateway does not support staged write commits'
    );
  }
  readRequiredConfirmationArg(args, 'confirmRisk');

  const plan = readStagedWritePlanArg(args);
  const provenance = readProvenanceContextArg(args);
  const result = await gateway.commitWritePlan(plan, {
    ...(provenance || {}),
    confirmRisk: true,
  });

  return createStructuredResult({
    summary: `Committed staged dataset write plan ${result.planId}.`,
    data: {
      ...result,
      committed: true,
    },
    nextActionHints: [
      'Use dataset_get_record_provenance for a row-level trace of the committed changes.',
      'Use observation_get_trace_summary when the commit was associated with a traceId.',
    ],
    recommendedNextTools: ['dataset_get_record_provenance', 'observation_get_trace_summary'],
    authoritativeFields: [
      'structuredContent.data.runId',
      'structuredContent.data.committed',
      'structuredContent.data.provenanceRecorded',
    ],
  });
};

const datasetGetRecordProvenanceHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps
) => {
  const gateway = ensureDatasetGateway(deps);
  if (!gateway.listRecordProvenance) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Dataset gateway does not support record provenance lookup'
    );
  }

  const datasetId = readStringArg(args, 'datasetId') || '';
  const rowId = readNumberArg(args, 'rowId', { required: true, min: 0 }) || 0;
  const limit = readNumberArg(args, 'limit', { required: false, min: 1, max: 500 });
  const provenance = await gateway.listRecordProvenance(datasetId, rowId, limit);

  return createStructuredResult(
    {
      summary: `Loaded ${provenance.length} provenance entr${provenance.length === 1 ? 'y' : 'ies'} for row ${rowId}.`,
      data: {
        datasetId,
        rowId,
        total: provenance.length,
        provenance,
      },
      nextActionHints: [
        'Use traceId/runId from provenance to inspect related observation bundles.',
      ],
      recommendedNextTools: ['observation_get_trace_summary'],
      authoritativeFields: [
        'structuredContent.data.datasetId',
        'structuredContent.data.rowId',
        'structuredContent.data.provenance',
      ],
    },
    { includeJsonInText: true }
  );
};

const datasetRenameHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureDatasetGateway(deps);
  const datasetId = readStringArg(args, 'datasetId');
  const newName = readStringArg(args, 'newName');
  const before = await gateway.getDatasetInfo(datasetId || '');
  if (!before) {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Dataset not found: ${datasetId}`, {
      context: { datasetId },
    });
  }

  await gateway.renameDataset(datasetId || '', newName || '');
  const dataset = await gateway.getDatasetInfo(datasetId || '');

  return createStructuredResult({
    summary: `Renamed dataset ${datasetId} to ${newName}.`,
    data: {
      datasetId,
      newName,
      renamed: true,
      ...(dataset ? { dataset } : {}),
    },
    nextActionHints: [
      'Use system_bootstrap when you want a refreshed resource preview after renaming a dataset.',
      'Use observation_get_trace_summary if the rename failed and you already have the traceId.',
    ],
    recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    authoritativeFields: ['structuredContent.data.datasetId', 'structuredContent.data.newName'],
  });
};

const datasetDeleteHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureDatasetGateway(deps);
  const datasetId = readStringArg(args, 'datasetId');
  const before = await gateway.getDatasetInfo(datasetId || '');
  if (!before) {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Dataset not found: ${datasetId}`, {
      context: { datasetId },
    });
  }

  const datasetName =
    typeof (before as { name?: unknown }).name === 'string'
      ? String((before as { name?: string }).name || '').trim()
      : undefined;
  await gateway.deleteDataset(datasetId || '');

  return createStructuredResult({
    summary: `Deleted dataset ${datasetId}.`,
    data: {
      datasetId,
      ...(datasetName ? { datasetName } : {}),
      deleted: true,
    },
    nextActionHints: [
      'Use system_bootstrap when you want a refreshed resource preview after deleting a dataset.',
      'Use observation_get_trace_summary if the delete failed and you already have the traceId.',
    ],
    recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    authoritativeFields: ['structuredContent.data.datasetId', 'structuredContent.data.deleted'],
  });
};

const DATASET_CAPABILITIES: Array<{
  key: string;
  metadata: CapabilityMetadata;
  definition: Omit<OrchestrationCapabilityDefinition, keyof CapabilityMetadata | 'version'>;
  handler: CapabilityHandler<OrchestrationDependencies>;
}> = [
  {
    key: 'dataset_list',
    metadata: DATASET_READ_METADATA,
    definition: {
      name: 'dataset_list',
      description: 'List available datasets for orchestration clients.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_list,
    },
    handler: datasetListHandler,
  },
  {
    key: 'dataset_get_info',
    metadata: DATASET_READ_METADATA,
    definition: {
      name: 'dataset_get_info',
      description: 'Get metadata for a dataset by id.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetId'],
        properties: {
          datasetId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_get_info,
    },
    handler: datasetGetInfoHandler,
  },
  {
    key: 'dataset_query',
    metadata: DATASET_READ_METADATA,
    definition: {
      name: 'dataset_query',
      description: 'Query dataset rows with optional SQL/offset/limit.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetId'],
        properties: {
          datasetId: { type: 'string', minLength: 1 },
          sql: { type: 'string' },
          offset: { type: 'number', minimum: 0 },
          limit: { type: 'number', minimum: 1, maximum: 10000 },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_query,
    },
    handler: datasetQueryHandler,
  },
  {
    key: 'dataset_import_file',
    metadata: DATASET_IMPORT_METADATA,
    definition: {
      name: 'dataset_import_file',
      description:
        'Import one dataset from an absolute local file path. This is high-risk and requires explicit confirmation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['filePath', 'datasetName', 'confirmRisk'],
        properties: {
          filePath: { type: 'string', minLength: 1 },
          datasetName: { type: 'string', minLength: 1 },
          folderId: { type: ['string', 'null'] },
          confirmRisk: { type: 'boolean' },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_import_file,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use only when the model intentionally needs to import a local file into a new dataset and has already verified the absolute source path.',
        preferredTargetKind: 'dataset',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Import one CSV file into a dataset',
            arguments: {
              filePath: 'D:\\data\\orders.csv',
              datasetName: 'Orders',
              folderId: null,
              confirmRisk: true,
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: datasetImportFileHandler,
  },
  {
    key: 'dataset_stage_write_plan',
    metadata: DATASET_STAGE_WRITE_METADATA,
    definition: {
      name: 'dataset_stage_write_plan',
      description:
        'Create a staged dataset write plan for inserts, updates, or deletes without mutating rows.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetId', 'operations'],
        properties: {
          datasetId: { type: 'string', minLength: 1 },
          operations: {
            type: 'array',
            minItems: 1,
            items: DATASET_WRITE_OPERATION_SCHEMA,
          },
          provenance: DATASET_PROVENANCE_CONTEXT_SCHEMA,
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_stage_write_plan,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use before any high-risk dataset row mutation so the model can inspect the exact staged write plan.',
        preferredTargetKind: 'dataset_write_plan',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['dataset_commit_write_plan'],
        examples: [
          {
            title: 'Stage one row insert',
            arguments: {
              datasetId: 'dataset_123',
              operations: [{ type: 'insert', record: { name: 'Alice' } }],
              provenance: {
                traceId: 'trace_abc',
                adapterVersion: '1.0.0',
                runtimeId: 'electron-webcontents',
                sourceUrl: 'https://example.test/source',
              },
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: datasetStageWritePlanHandler,
  },
  {
    key: 'dataset_commit_write_plan',
    metadata: DATASET_COMMIT_WRITE_METADATA,
    definition: {
      name: 'dataset_commit_write_plan',
      description:
        'Commit a staged dataset write plan after explicit confirmation; rows and provenance are written transactionally.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['plan', 'confirmRisk'],
        properties: {
          plan: createOpaqueOutputSchema(),
          provenance: DATASET_PROVENANCE_CONTEXT_SCHEMA,
          confirmRisk: { type: 'boolean' },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_commit_write_plan,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use only after reviewing a staged dataset write plan and confirming that the mutation should be applied.',
        preferredTargetKind: 'dataset',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['dataset_get_record_provenance', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Commit a reviewed write plan',
            arguments: {
              plan: { planId: 'plan-id-from-dataset_stage_write_plan' },
              confirmRisk: true,
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: datasetCommitWritePlanHandler,
  },
  {
    key: 'dataset_get_record_provenance',
    metadata: DATASET_READ_METADATA,
    definition: {
      name: 'dataset_get_record_provenance',
      description: 'List row-level dataset provenance entries for one dataset row.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetId', 'rowId'],
        properties: {
          datasetId: { type: 'string', minLength: 1 },
          rowId: { type: 'number', minimum: 0 },
          limit: { type: 'number', minimum: 1, maximum: 500 },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_get_record_provenance,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use when a row must be traced back to the run, adapter version, runtime, traceId, or source URL that produced it.',
        preferredTargetKind: 'dataset_record_provenance',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['observation_get_trace_summary'],
        examples: [
          {
            title: 'Trace one dataset row',
            arguments: { datasetId: 'dataset_123', rowId: 7, limit: 20 },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: datasetGetRecordProvenanceHandler,
  },
  {
    key: 'dataset_create_empty',
    metadata: DATASET_WRITE_METADATA,
    definition: {
      name: 'dataset_create_empty',
      description: 'Create an empty dataset with an optional folderId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetName'],
        properties: {
          datasetName: { type: 'string', minLength: 1 },
          folderId: { type: ['string', 'null'] },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_create_empty,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use when the model explicitly needs a new empty dataset shell before later manual or automated population.',
        preferredTargetKind: 'dataset',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Create one empty dataset',
            arguments: { datasetName: 'Leads Queue', folderId: null },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: datasetCreateEmptyHandler,
  },
  {
    key: 'dataset_rename',
    metadata: DATASET_WRITE_METADATA,
    definition: {
      name: 'dataset_rename',
      description: 'Rename one dataset by datasetId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetId', 'newName'],
        properties: {
          datasetId: { type: 'string', minLength: 1 },
          newName: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_rename,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use for low-risk dataset housekeeping when the model needs to correct or normalize one dataset name.',
        preferredTargetKind: 'dataset',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Rename one dataset',
            arguments: { datasetId: 'dataset_123', newName: 'Qualified Leads' },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: datasetRenameHandler,
  },
  {
    key: 'dataset_delete',
    metadata: DATASET_WRITE_METADATA,
    definition: {
      name: 'dataset_delete',
      description: 'Delete one dataset by datasetId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetId'],
        properties: {
          datasetId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: DATASET_OUTPUT_SCHEMAS.dataset_delete,
      assistantGuidance: {
        workflowStage: 'teardown',
        whenToUse:
          'Use for explicit low-risk cleanup when the model intends to remove one dataset from the workspace.',
        preferredTargetKind: 'dataset',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Delete one dataset',
            arguments: { datasetId: 'dataset_123' },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: datasetDeleteHandler,
  },
];

export function createDatasetCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    DATASET_CAPABILITIES.map((capability) => [
      capability.key,
      {
        definition: {
          ...capability.definition,
          title: toCapabilityTitle(capability.definition.name),
          annotations: buildCapabilityAnnotations(capability.metadata, {
            destructiveHint: capability.key === 'dataset_delete',
          }),
          version: DATASET_CAPABILITY_VERSION,
          ...capability.metadata,
        },
        handler: capability.handler,
      },
    ])
  );
}
