import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ErrorCode, createStructuredError, type StructuredError } from '../../../types/error-codes';
import type {
  CapabilityConfirmationGrant,
  OrchestrationCapabilityDefinition,
  OrchestrationConfirmationDecision,
  OrchestrationInvokeRequest,
} from './types';

const TRUSTED_CONFIRMATION_SOURCES = new Set(['plugin-ui', 'workflow-ui', 'agent-ui']);
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

const consumedGrantIds = new Map<string, number>();
let hostConfirmationSigningKey = randomBytes(32);

const pruneConsumedGrantIds = (now: number): void => {
  for (const [grantId, expiresAtMs] of consumedGrantIds) {
    if (expiresAtMs <= now) {
      consumedGrantIds.delete(grantId);
    }
  }
};

const normalizeForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalizeForHash(child)])
    );
  }
  return value;
};

const hashStable = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(normalizeForHash(value))).digest('hex');

const SIGNED_CONFIRMATION_GRANT_FIELDS = [
  'grantId',
  'invocationId',
  'issuer',
  'issuedAt',
  'capability',
  'capabilityVersion',
  'argumentsHash',
  'policyHash',
  'principal',
  'source',
  'sessionId',
  'scopes',
  'idempotencyKey',
  'previewRef',
  'expiresAt',
  'signatureVersion',
] as const;

type SignedConfirmationGrantPayload = Pick<
  CapabilityConfirmationGrant,
  (typeof SIGNED_CONFIRMATION_GRANT_FIELDS)[number]
>;

const createSignedGrantPayload = (
  grant: Omit<CapabilityConfirmationGrant, 'signature'>
): SignedConfirmationGrantPayload =>
  Object.fromEntries(
    SIGNED_CONFIRMATION_GRANT_FIELDS.map((field) => [field, grant[field]])
  ) as SignedConfirmationGrantPayload;

const signCapabilityConfirmationGrantPayload = (
  payload: SignedConfirmationGrantPayload
): string =>
  createHmac('sha256', hostConfirmationSigningKey)
    .update(JSON.stringify(normalizeForHash(payload)))
    .digest('hex');

const secureStringEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const verifyCapabilityConfirmationGrantSignature = (
  grant: CapabilityConfirmationGrant
): boolean => {
  if (grant.issuer !== 'host-local' || grant.signatureVersion !== 1) {
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(grant.signature)) {
    return false;
  }
  const expected = signCapabilityConfirmationGrantPayload(createSignedGrantPayload(grant));
  return secureStringEqual(expected, grant.signature);
};

export const hashCapabilityArguments = (args: Record<string, unknown>): string =>
  hashStable(args || {});

export const createCapabilityPolicyHash = (
  definition: Pick<
    OrchestrationCapabilityDefinition,
    | 'name'
    | 'version'
    | 'sideEffectLevel'
    | 'requiredScopes'
    | 'annotations'
    | 'confirmationPolicy'
  >
): string =>
  hashStable({
    capability: definition.name,
    capabilityVersion: definition.version,
    sideEffectLevel: definition.sideEffectLevel || 'none',
    requiredScopes: [...(definition.requiredScopes || [])].sort(),
    destructiveHint: definition.annotations?.destructiveHint === true,
    confirmationPolicy: definition.confirmationPolicy || null,
  });

export const requiresCapabilityConfirmation = (
  definition: Pick<
    OrchestrationCapabilityDefinition,
    'sideEffectLevel' | 'annotations' | 'confirmationPolicy'
  >,
  args: Record<string, unknown> = {}
): boolean =>
  definition.sideEffectLevel === 'high' ||
  definition.annotations?.destructiveHint === true ||
  (definition.confirmationPolicy?.requiredWhen || []).some(
    (condition) => args[condition.argument] === condition.equals
  );

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const isCapabilityConfirmationGrant = (
  value: unknown
): value is CapabilityConfirmationGrant => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<CapabilityConfirmationGrant>;
  return (
    isNonEmptyString(record.grantId) &&
    isNonEmptyString(record.invocationId) &&
    record.issuer === 'host-local' &&
    isNonEmptyString(record.issuedAt) &&
    isNonEmptyString(record.capability) &&
    isNonEmptyString(record.capabilityVersion) &&
    isNonEmptyString(record.argumentsHash) &&
    isNonEmptyString(record.policyHash) &&
    isNonEmptyString(record.principal) &&
    isNonEmptyString(record.source) &&
    TRUSTED_CONFIRMATION_SOURCES.has(record.source) &&
    isNonEmptyString(record.sessionId) &&
    Array.isArray(record.scopes) &&
    record.scopes.every(isNonEmptyString) &&
    (record.idempotencyKey === undefined || isNonEmptyString(record.idempotencyKey)) &&
    (record.previewRef === undefined || isNonEmptyString(record.previewRef)) &&
    isNonEmptyString(record.expiresAt) &&
    record.signatureVersion === 1 &&
    isNonEmptyString(record.signature)
  );
};

const createConfirmationError = (
  definition: OrchestrationCapabilityDefinition,
  reason: string,
  context: Record<string, unknown>
): StructuredError =>
  createStructuredError(
    ErrorCode.PERMISSION_DENIED,
    `Capability ${definition.name} requires a valid confirmation grant`,
    {
      details:
        'High-risk or destructive capabilities must be confirmed by a trusted local UI before execution.',
      suggestion:
        'Create a fresh confirmation grant for the exact capability, arguments, session, principal, scopes, and policy before invoking again.',
      reasonCode: 'capability_confirmation_required',
      retryable: false,
      context: {
        capability: definition.name,
        reason,
        ...context,
      },
    }
  );

export interface ValidateCapabilityConfirmationInput {
  definition: OrchestrationCapabilityDefinition;
  request: OrchestrationInvokeRequest;
  idempotencyKey?: string;
  now?: () => number;
}

export interface CapabilityConfirmationValidationResult {
  decision: OrchestrationConfirmationDecision;
  error?: StructuredError;
}

export const validateCapabilityConfirmationGrant = (
  input: ValidateCapabilityConfirmationInput
): CapabilityConfirmationValidationResult => {
  const { definition, request } = input;
  const required = requiresCapabilityConfirmation(definition, request.arguments || {});
  const argumentsHash = hashCapabilityArguments(request.arguments || {});
  const policyHash = createCapabilityPolicyHash(definition);

  if (!required) {
    return {
      decision: {
        required: false,
        status: 'not_required',
        argumentsHash,
        policyHash,
      },
    };
  }

  const grant = request.auth?.confirmationGrant;
  const baseDecision: OrchestrationConfirmationDecision = {
    required: true,
    status: 'rejected',
    argumentsHash,
    policyHash,
  };

  const reject = (
    reason: string,
    context: Record<string, unknown> = {}
  ): CapabilityConfirmationValidationResult => ({
    decision: {
      ...baseDecision,
      reason,
      ...(isCapabilityConfirmationGrant(grant)
        ? {
            grantId: grant.grantId,
            invocationId: grant.invocationId,
            principal: grant.principal,
            sessionId: grant.sessionId,
            source: grant.source,
            expiresAt: grant.expiresAt,
          }
        : {}),
    },
    error: createConfirmationError(definition, reason, {
      requiredScopes: definition.requiredScopes || [],
      providedScopes: request.auth?.scopes || [],
      ...context,
    }),
  });

  if (!isCapabilityConfirmationGrant(grant)) {
    return reject('missing_or_invalid_grant');
  }
  if (!verifyCapabilityConfirmationGrantSignature(grant)) {
    return reject('invalid_grant_signature', { grantId: grant.grantId });
  }

  const now = input.now?.() ?? Date.now();
  pruneConsumedGrantIds(now);
  if (consumedGrantIds.has(grant.grantId)) {
    return reject('grant_already_consumed', { grantId: grant.grantId });
  }

  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    return reject('grant_expired', { grantId: grant.grantId, expiresAt: grant.expiresAt });
  }
  if (expiresAtMs - now > DEFAULT_CONFIRMATION_TTL_MS) {
    return reject('grant_ttl_too_long', { grantId: grant.grantId, expiresAt: grant.expiresAt });
  }

  const expectedPrincipal = request.auth?.principal || 'anonymous';
  const expectedSessionId = request.auth?.sessionId || '';
  const providedScopes = request.auth?.scopes || [];
  const requiredScopes = definition.requiredScopes || [];

  if (grant.capability !== definition.name) {
    return reject('capability_mismatch', { grantCapability: grant.capability });
  }
  if (grant.capabilityVersion !== definition.version) {
    return reject('capability_version_mismatch', {
      grantCapabilityVersion: grant.capabilityVersion,
    });
  }
  if (grant.argumentsHash !== argumentsHash) {
    return reject('arguments_hash_mismatch', { grantArgumentsHash: grant.argumentsHash });
  }
  if (grant.policyHash !== policyHash) {
    return reject('policy_hash_mismatch', { grantPolicyHash: grant.policyHash });
  }
  if (grant.principal !== expectedPrincipal) {
    return reject('principal_mismatch', { grantPrincipal: grant.principal, expectedPrincipal });
  }
  if (!expectedSessionId || grant.sessionId !== expectedSessionId) {
    return reject('session_mismatch', { grantSessionId: grant.sessionId, expectedSessionId });
  }
  if (input.idempotencyKey && grant.idempotencyKey !== input.idempotencyKey) {
    return reject('idempotency_key_mismatch', {
      grantIdempotencyKey: grant.idempotencyKey || null,
      expectedIdempotencyKey: input.idempotencyKey,
    });
  }
  if (!input.idempotencyKey && grant.idempotencyKey) {
    return reject('unexpected_idempotency_key', { grantIdempotencyKey: grant.idempotencyKey });
  }

  const missingRequiredScopes = requiredScopes.filter((scope) => !grant.scopes.includes(scope));
  if (missingRequiredScopes.length > 0) {
    return reject('grant_missing_required_scopes', { missingRequiredScopes });
  }
  const scopesNotProvided = grant.scopes.filter((scope) => !providedScopes.includes(scope));
  if (scopesNotProvided.length > 0) {
    return reject('grant_scope_not_provided', { scopesNotProvided });
  }

  consumedGrantIds.set(grant.grantId, expiresAtMs);
  return {
    decision: {
      required: true,
      status: 'accepted',
      grantId: grant.grantId,
      invocationId: grant.invocationId,
      argumentsHash,
      policyHash,
      principal: grant.principal,
      sessionId: grant.sessionId,
      source: grant.source,
      expiresAt: grant.expiresAt,
    },
  };
};

export const createCapabilityConfirmationGrant = (input: {
  definition: OrchestrationCapabilityDefinition;
  arguments: Record<string, unknown>;
  grantId: string;
  invocationId: string;
  principal: string;
  source: CapabilityConfirmationGrant['source'];
  sessionId: string;
  scopes: string[];
  expiresAt?: string;
  idempotencyKey?: string;
  previewRef?: string;
  now?: () => number;
}): CapabilityConfirmationGrant => {
  const now = input.now?.() ?? Date.now();
  const issuedAt = new Date(now).toISOString();
  const unsignedGrant: Omit<CapabilityConfirmationGrant, 'signature'> = {
    grantId: input.grantId,
    invocationId: input.invocationId,
    issuer: 'host-local',
    issuedAt,
    capability: input.definition.name,
    capabilityVersion: input.definition.version,
    argumentsHash: hashCapabilityArguments(input.arguments),
    policyHash: createCapabilityPolicyHash(input.definition),
    principal: input.principal,
    source: input.source,
    sessionId: input.sessionId,
    scopes: [...input.scopes],
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.previewRef ? { previewRef: input.previewRef } : {}),
    expiresAt: input.expiresAt || new Date(now + DEFAULT_CONFIRMATION_TTL_MS).toISOString(),
    signatureVersion: 1,
  };
  return {
    ...unsignedGrant,
    signature: signCapabilityConfirmationGrantPayload(createSignedGrantPayload(unsignedGrant)),
  };
};

export const __resetCapabilityConfirmationGrantsForTests = (): void => {
  consumedGrantIds.clear();
  hostConfirmationSigningKey = randomBytes(32);
};
