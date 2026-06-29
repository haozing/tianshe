import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import syncContractSchema from './schemas/sync-contract-v1.schema.json';
import type {
  SyncArtifactDownloadUrlRequest,
  SyncArtifactDownloadUrlResponse,
  SyncArtifactUploadUrlRequest,
  SyncArtifactUploadUrlResponse,
  SyncErrorResponse,
  SyncHandshakeRequest,
  SyncHandshakeResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../../types/sync-contract';

export type SyncSchemaDefinitionName =
  | 'HandshakeRequest'
  | 'HandshakeResponse'
  | 'PushRequest'
  | 'PushResponse'
  | 'PullRequest'
  | 'PullResponse'
  | 'ArtifactUploadUrlRequest'
  | 'ArtifactUploadUrlResponse'
  | 'ArtifactDownloadUrlRequest'
  | 'ArtifactDownloadUrlResponse'
  | 'ErrorResponse';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const validatorCache = new Map<SyncSchemaDefinitionName, ValidateFunction>();

const schemaDefs = (
  (syncContractSchema as { $defs?: Record<string, unknown> }).$defs ?? {}
) as Record<string, unknown>;

function getValidator(definition: SyncSchemaDefinitionName): ValidateFunction {
  const cached = validatorCache.get(definition);
  if (cached) return cached;

  const schema = {
    $ref: `#/$defs/${definition}`,
    $defs: schemaDefs,
  };
  const validator = ajv.compile(schema);
  validatorCache.set(definition, validator);
  return validator;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((error) => {
    const path = error.instancePath ? error.instancePath : '/';
    const message = error.message ? error.message : 'validation failed';
    return `${path} ${message}`.trim();
  });
}

export function validateSyncContractDefinition(
  definition: SyncSchemaDefinitionName,
  payload: unknown
): {
  valid: boolean;
  errors: string[];
} {
  const validator = getValidator(definition);
  const valid = validator(payload) === true;
  return {
    valid,
    errors: valid ? [] : formatAjvErrors(validator.errors),
  };
}

export function isSyncHandshakeRequest(payload: unknown): payload is SyncHandshakeRequest {
  return validateSyncContractDefinition('HandshakeRequest', payload).valid;
}

export function isSyncHandshakeResponse(payload: unknown): payload is SyncHandshakeResponse {
  return validateSyncContractDefinition('HandshakeResponse', payload).valid;
}

export function isSyncPushRequest(payload: unknown): payload is SyncPushRequest {
  return validateSyncContractDefinition('PushRequest', payload).valid;
}

export function isSyncPushResponse(payload: unknown): payload is SyncPushResponse {
  return validateSyncContractDefinition('PushResponse', payload).valid;
}

export function isSyncPullRequest(payload: unknown): payload is SyncPullRequest {
  return validateSyncContractDefinition('PullRequest', payload).valid;
}

export function isSyncPullResponse(payload: unknown): payload is SyncPullResponse {
  return validateSyncContractDefinition('PullResponse', payload).valid;
}

export function isSyncArtifactUploadUrlRequest(
  payload: unknown
): payload is SyncArtifactUploadUrlRequest {
  return validateSyncContractDefinition('ArtifactUploadUrlRequest', payload).valid;
}

export function isSyncArtifactUploadUrlResponse(
  payload: unknown
): payload is SyncArtifactUploadUrlResponse {
  return validateSyncContractDefinition('ArtifactUploadUrlResponse', payload).valid;
}

export function isSyncArtifactDownloadUrlRequest(
  payload: unknown
): payload is SyncArtifactDownloadUrlRequest {
  return validateSyncContractDefinition('ArtifactDownloadUrlRequest', payload).valid;
}

export function isSyncArtifactDownloadUrlResponse(
  payload: unknown
): payload is SyncArtifactDownloadUrlResponse {
  return validateSyncContractDefinition('ArtifactDownloadUrlResponse', payload).valid;
}

export function isSyncErrorResponse(payload: unknown): payload is SyncErrorResponse {
  return validateSyncContractDefinition('ErrorResponse', payload).valid;
}

