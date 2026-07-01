import { createHash } from 'node:crypto';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { ErrorCode, createStructuredError, type StructuredError } from '../../../types/error-codes';
import type { OrchestrationCapabilityDefinition } from './types';

export type CapabilitySchemaPhase = 'input' | 'output';

export interface CapabilitySchemaValidationFailure {
  phase: CapabilitySchemaPhase;
  schemaHash: string;
  errors: Array<{
    path: string;
    schemaPath: string;
    keyword: string;
    message: string;
  }>;
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const validatorCache = new Map<string, ValidateFunction>();

const stableNormalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableNormalize(child)])
    );
  }
  return value;
};

export const hashCapabilitySchema = (schema: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify(stableNormalize(schema))).digest('hex');

export const buildCapabilitySchemaCacheKey = (
  definition: Pick<OrchestrationCapabilityDefinition, 'name' | 'version'>,
  phase: CapabilitySchemaPhase,
  schema: Record<string, unknown>
): string => `${definition.name}@${definition.version}:${phase}:${hashCapabilitySchema(schema)}`;

const summarizeAjvErrors = (
  errors: ErrorObject[] | null | undefined
): CapabilitySchemaValidationFailure['errors'] =>
  (errors || []).slice(0, 8).map((error) => ({
    path: error.instancePath || '/',
    schemaPath: error.schemaPath || '',
    keyword: error.keyword,
    message: error.message || 'failed schema validation',
  }));

export const validateCapabilitySchemaPayload = (
  definition: OrchestrationCapabilityDefinition,
  phase: CapabilitySchemaPhase,
  schema: Record<string, unknown> | undefined,
  payload: unknown
): CapabilitySchemaValidationFailure | undefined => {
  if (!schema) {
    return undefined;
  }

  const cacheKey = buildCapabilitySchemaCacheKey(definition, phase, schema);
  let validator = validatorCache.get(cacheKey);
  if (!validator) {
    validator = ajv.compile(schema);
    validatorCache.set(cacheKey, validator);
  }

  if (validator(payload)) {
    return undefined;
  }

  return {
    phase,
    schemaHash: hashCapabilitySchema(schema),
    errors: summarizeAjvErrors(validator.errors),
  };
};

export const createCapabilitySchemaValidationError = (
  definition: OrchestrationCapabilityDefinition,
  failure: CapabilitySchemaValidationFailure
): StructuredError => {
  const phaseLabel = failure.phase === 'input' ? 'input arguments' : 'structured output';
  return createStructuredError(
    ErrorCode.VALIDATION_ERROR,
    `Capability ${phaseLabel} failed schema validation`,
    {
      details: `Capability "${definition.name}" ${phaseLabel} did not match its declared schema`,
      suggestion:
        failure.phase === 'input'
          ? 'Check required fields, field types, and additional properties before invoking again.'
          : 'Capability handler returned structuredContent that does not match its outputSchema.',
      reasonCode: `capability_${failure.phase}_schema_validation_failed`,
      retryable: false,
      context: {
        capability: definition.name,
        version: definition.version,
        phase: failure.phase,
        schemaHash: failure.schemaHash,
        errors: failure.errors,
      },
    }
  );
};

export const __resetCapabilitySchemaValidatorCacheForTests = (): void => {
  validatorCache.clear();
};
