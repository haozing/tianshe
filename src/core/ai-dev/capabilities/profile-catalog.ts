import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import type {
  CreateProfileParams,
  FingerprintConfig,
  ProxyConfig,
  UpdateProfileParams,
} from '../../../types/profile';
import type {
  OrchestrationCapabilityDefinition,
  OrchestrationDependencies,
  OrchestrationProfileInfo,
} from '../orchestration/types';
import type { CapabilityHandler } from './types';
import type { RegisteredCapability } from './browser-catalog';
import {
  buildCapabilityAnnotations,
  type CapabilityMetadata,
  createBrowserRuntimeDescriptorSchema,
  createOpaqueOutputSchema,
  createStructuredEnvelopeSchema,
  toCapabilityTitle,
} from './catalog-utils';
import {
  createProfileResolutionError,
  inspectProfileResolution,
} from './profile-resolution-utils';
import { createStructuredResult } from './result-utils';
import { getStaticEngineRuntimeDescriptor } from '../../browser-pool/engine-capability-registry';

const PROFILE_CAPABILITY_VERSION = '1.0.0';

const PROFILE_READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 300,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['profile.read'],
  requires: ['profileGateway'],
};

const PROFILE_WRITE_METADATA: CapabilityMetadata = {
  idempotent: false,
  sideEffectLevel: 'high',
  estimatedLatencyMs: 1500,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['profile.write'],
  requires: ['profileGateway'],
};

const asText = (value: unknown): string => String(value == null ? '' : value).trim();

const normalizeEngine = (value: unknown): 'electron' | 'extension' | 'ruyi' | undefined => {
  const normalized = asText(value).toLowerCase();
  if (normalized === 'electron' || normalized === 'extension' || normalized === 'ruyi') {
    return normalized;
  }
  return undefined;
};

const BROWSER_RUNTIME_DESCRIPTOR_SCHEMA = createBrowserRuntimeDescriptorSchema();

const resolveProfileEngineRuntimeDescriptor = (engine: unknown) => {
  const normalized = normalizeEngine(engine);
  return normalized ? getStaticEngineRuntimeDescriptor(normalized) : null;
};

const PROFILE_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'engine', 'status', 'isSystem', 'engineRuntimeDescriptor'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    engine: { type: 'string' },
    status: { type: 'string' },
    partition: { type: 'string' },
    isSystem: { type: 'boolean' },
    totalUses: { type: 'number' },
    lastActiveAt: { type: 'string' },
    updatedAt: { type: 'string' },
    engineRuntimeDescriptor: {
      anyOf: [{ type: 'null' }, BROWSER_RUNTIME_DESCRIPTOR_SCHEMA],
    },
  },
} as const;

const PROFILE_OUTPUT_SCHEMAS: Partial<Record<string, Record<string, unknown>>> = {
  profile_list: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['total', 'profiles'],
    properties: {
      total: { type: 'number' },
      profiles: {
        type: 'array',
        items: PROFILE_INFO_SCHEMA,
      },
    },
  }),
  profile_resolve: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['query', 'matchedBy', 'profile'],
    properties: {
      query: { type: 'string' },
      matchedBy: { type: 'string', enum: ['id', 'name'] },
      profile: PROFILE_INFO_SCHEMA,
    },
  }),
  profile_get: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['profileId', 'profile'],
    properties: {
      profileId: { type: 'string' },
      profile: PROFILE_INFO_SCHEMA,
    },
  }),
  profile_start_session: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['query', 'matchedBy', 'profile', 'sessionPlan', 'note'],
    properties: {
      query: { type: 'string' },
      matchedBy: { type: 'string', enum: ['id', 'name'] },
      profile: PROFILE_INFO_SCHEMA,
      sessionPlan: {
        type: 'object',
        additionalProperties: false,
        required: ['mcpHeaders', 'orchestrationSessionCreate'],
        properties: {
          mcpHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          orchestrationSessionCreate: {
            type: 'object',
            additionalProperties: false,
            required: ['profileId', 'visible'],
            properties: {
              profileId: { type: 'string' },
              engine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
              visible: { type: 'boolean' },
            },
          },
        },
      },
      note: { type: 'string' },
    },
  }),
  profile_create: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['profileId', 'created', 'profile'],
    properties: {
      profileId: { type: 'string' },
      created: { type: 'boolean' },
      profile: PROFILE_INFO_SCHEMA,
    },
  }),
  profile_update: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['profileId', 'updated', 'runtimeResetExpected', 'profile'],
    properties: {
      profileId: { type: 'string' },
      updated: { type: 'boolean' },
      runtimeResetExpected: { type: 'boolean' },
      profile: PROFILE_INFO_SCHEMA,
    },
  }),
  profile_delete: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['profileId', 'deleted'],
    properties: {
      profileId: { type: 'string' },
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

const readBooleanArg = (
  args: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean => {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be boolean`);
  }
  return raw;
};

const readOptionalLimitArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be a positive integer`);
  }
  return raw;
};

const readRequiredConfirmationArg = (
  args: Record<string, unknown>,
  key: string,
  label: string
): true => {
  const raw = args[key];
  if (raw !== true) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be true for ${label}`,
      {
        suggestion: `Re-issue the call with ${key}: true only after verifying the intended profile change and its runtime side effects.`,
        context: {
          parameter: key,
          expected: true,
        },
      }
    );
  }
  return true;
};

const readNullableStringArg = (
  args: Record<string, unknown>,
  key: string
): string | null | undefined => {
  if (!(key in args)) {
    return undefined;
  }
  const raw = args[key];
  if (raw === null) {
    return null;
  }
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be string or null`);
  }
  const value = raw.trim();
  return value || null;
};

const readOptionalStringArrayArg = (args: Record<string, unknown>, key: string): string[] | undefined => {
  if (!(key in args)) {
    return undefined;
  }
  const raw = args[key];
  if (!Array.isArray(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be an array of strings`);
  }
  const values = raw.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must contain only non-empty strings`);
    }
    return item.trim();
  });
  return values;
};

const readOptionalObjectArg = <T>(
  args: Record<string, unknown>,
  key: string
): T | null | undefined => {
  if (!(key in args)) {
    return undefined;
  }
  const raw = args[key];
  if (raw === null) {
    return null;
  }
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be an object or null`);
  }
  return raw as T;
};

const readOptionalNumericArg = (
  args: Record<string, unknown>,
  key: string,
  options: { integer?: boolean; min?: number } = {}
): number | undefined => {
  if (!(key in args)) {
    return undefined;
  }
  const raw = args[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be number`);
  }
  if (options.integer && !Number.isInteger(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be an integer`);
  }
  if (typeof options.min === 'number' && raw < options.min) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be >= ${options.min}`
    );
  }
  return raw;
};

const readOptionalEngineArg = (
  args: Record<string, unknown>,
  key: string
): 'electron' | 'extension' | 'ruyi' | undefined => {
  if (!(key in args)) {
    return undefined;
  }
  const value = normalizeEngine(args[key]);
  if (!value) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be "electron", "extension", or "ruyi"`
    );
  }
  return value;
};

const hasProfileRuntimeMutation = (params: UpdateProfileParams): boolean =>
  params.fingerprint !== undefined ||
  params.engine !== undefined ||
  params.proxy !== undefined ||
  params.idleTimeoutMs !== undefined ||
  params.lockTimeoutMs !== undefined;

const buildCreateProfileParams = (args: Record<string, unknown>): CreateProfileParams => ({
  name: readStringArg(args, 'name', { required: true }) || '',
  ...(readOptionalEngineArg(args, 'engine') ? { engine: readOptionalEngineArg(args, 'engine') } : {}),
  ...(readNullableStringArg(args, 'groupId') !== undefined
    ? { groupId: readNullableStringArg(args, 'groupId') }
    : {}),
  ...(readOptionalObjectArg<ProxyConfig>(args, 'proxy') !== undefined
    ? { proxy: readOptionalObjectArg<ProxyConfig>(args, 'proxy') }
    : {}),
  ...(readOptionalObjectArg<Partial<FingerprintConfig>>(args, 'fingerprint') !== undefined
    ? { fingerprint: readOptionalObjectArg<Partial<FingerprintConfig>>(args, 'fingerprint') || undefined }
    : {}),
  ...(readNullableStringArg(args, 'notes') !== undefined ? { notes: readNullableStringArg(args, 'notes') } : {}),
  ...(readOptionalStringArrayArg(args, 'tags') !== undefined
    ? { tags: readOptionalStringArrayArg(args, 'tags') }
    : {}),
  ...(readNullableStringArg(args, 'color') !== undefined ? { color: readNullableStringArg(args, 'color') } : {}),
  ...(readOptionalNumericArg(args, 'idleTimeoutMs', { integer: true, min: 0 }) !== undefined
    ? { idleTimeoutMs: readOptionalNumericArg(args, 'idleTimeoutMs', { integer: true, min: 0 }) }
    : {}),
  ...(readOptionalNumericArg(args, 'lockTimeoutMs', { integer: true, min: 0 }) !== undefined
    ? { lockTimeoutMs: readOptionalNumericArg(args, 'lockTimeoutMs', { integer: true, min: 0 }) }
    : {}),
});

const buildUpdateProfileParams = (args: Record<string, unknown>): UpdateProfileParams => {
  const params: UpdateProfileParams = {};
  const name = readStringArg(args, 'name', { required: false });
  const engine = readOptionalEngineArg(args, 'engine');
  const groupId = readNullableStringArg(args, 'groupId');
  const proxy = readOptionalObjectArg<ProxyConfig>(args, 'proxy');
  const fingerprint = readOptionalObjectArg<Partial<FingerprintConfig>>(args, 'fingerprint');
  const notes = readNullableStringArg(args, 'notes');
  const tags = readOptionalStringArrayArg(args, 'tags');
  const color = readNullableStringArg(args, 'color');
  const idleTimeoutMs = readOptionalNumericArg(args, 'idleTimeoutMs', { integer: true, min: 0 });
  const lockTimeoutMs = readOptionalNumericArg(args, 'lockTimeoutMs', { integer: true, min: 0 });

  if (name !== undefined) params.name = name;
  if (engine !== undefined) params.engine = engine;
  if (groupId !== undefined) params.groupId = groupId;
  if (proxy !== undefined) params.proxy = proxy;
  if (fingerprint !== undefined) params.fingerprint = fingerprint || undefined;
  if (notes !== undefined) params.notes = notes;
  if (tags !== undefined) params.tags = tags;
  if (color !== undefined) params.color = color;
  if (idleTimeoutMs !== undefined) params.idleTimeoutMs = idleTimeoutMs;
  if (lockTimeoutMs !== undefined) params.lockTimeoutMs = lockTimeoutMs;

  return params;
};

const normalizeProfile = (profile: OrchestrationProfileInfo): OrchestrationProfileInfo => ({
  id: asText(profile.id),
  name: asText(profile.name),
  engine: asText(profile.engine),
  status: asText(profile.status),
  partition: asText(profile.partition) || undefined,
  isSystem: profile.isSystem === true,
  totalUses:
    typeof profile.totalUses === 'number' && Number.isFinite(profile.totalUses)
      ? profile.totalUses
      : undefined,
  lastActiveAt: asText(profile.lastActiveAt) || undefined,
  updatedAt: asText(profile.updatedAt) || undefined,
  engineRuntimeDescriptor:
    profile.engineRuntimeDescriptor ?? resolveProfileEngineRuntimeDescriptor(profile.engine),
});

const formatProfileLine = (profile: OrchestrationProfileInfo): string => {
  const fields = [
    asText(profile.id) || '-',
    asText(profile.name) || '-',
    asText(profile.engine) || '-',
    asText(profile.status) || '-',
  ];
  const extras: string[] = [];
  if (asText(profile.partition)) {
    extras.push(`partition=${asText(profile.partition)}`);
  }
  if (profile.isSystem) {
    extras.push('system=true');
  }
  if (typeof profile.totalUses === 'number' && Number.isFinite(profile.totalUses)) {
    extras.push(`uses=${profile.totalUses}`);
  }
  return `- ${fields.join(' | ')}${extras.length ? ` | ${extras.join(' | ')}` : ''}`;
};

const formatProfilePreview = (
  profiles: OrchestrationProfileInfo[],
  limit = 5
): string[] => {
  const preview = profiles.slice(0, limit).map(formatProfileLine);
  const remaining = profiles.length - preview.length;
  if (remaining > 0) {
    preview.push(`- ...and ${remaining} more profile(s)`);
  }
  return preview;
};

const ensureProfileGateway = (deps: OrchestrationDependencies) => {
  if (!deps.profileGateway) {
    throw createStructuredError(ErrorCode.OPERATION_FAILED, 'Profile gateway is not configured', {
      suggestion: 'Please inject profileGateway into orchestration dependencies',
    });
  }
  return deps.profileGateway;
};

const profileListHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureProfileGateway(deps);
  const query = asText(readStringArg(args, 'query', { required: false })).toLowerCase();
  const engine = asText(readStringArg(args, 'engine', { required: false })).toLowerCase();
  const status = asText(readStringArg(args, 'status', { required: false })).toLowerCase();
  const includeSystem = readBooleanArg(args, 'includeSystem', true);
  const limit = readOptionalLimitArg(args, 'limit');

  const all = (await gateway.listProfiles()).map(normalizeProfile);
  const filtered = all.filter((item) => {
    if (!includeSystem && item.isSystem) return false;
    if (engine && String(item.engine || '').toLowerCase() !== engine) return false;
    if (status && String(item.status || '').toLowerCase() !== status) return false;
    if (!query) return true;
    const id = String(item.id || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    return id.includes(query) || name.includes(query);
  });
  const profiles = limit ? filtered.slice(0, limit) : filtered;
  const truncated = typeof limit === 'number' && profiles.length < filtered.length;

  return createStructuredResult(
    {
      summary: [
        `Found ${filtered.length} profile(s) matching the current filter.`,
        truncated ? `Returned the first ${profiles.length} result(s) because limit=${limit}.` : '',
        ...formatProfilePreview(profiles),
      ].join('\n'),
      data: {
        total: filtered.length,
        profiles,
      },
      truncated,
      nextActionHints: [
        'Use profile_resolve with an exact profile id or name before session reuse.',
        'Then call session_prepare to bind the current MCP session and set any sticky session scopes.',
      ],
    }
  );
};

const profileGetHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureProfileGateway(deps);
  const profileId = readStringArg(args, 'profileId');
  const profile = await gateway.getProfile(profileId || '');
  if (!profile) {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Profile not found: ${profileId}`, {
      context: { profileId },
    });
  }

  const normalizedProfile = normalizeProfile(profile);
  return createStructuredResult(
    {
      summary: [`Resolved profile ${asText(profileId)}.`, formatProfileLine(normalizedProfile)].join('\n'),
      data: {
        profileId: asText(profileId),
        profile: normalizedProfile,
      },
      nextActionHints: [
        'Use profile_start_session for explicit external client session planning.',
        'Use session_prepare to bind the current MCP session directly.',
      ],
    }
  );
};

const profileResolveHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureProfileGateway(deps);
  const query = readStringArg(args, 'query');
  const inspection = await inspectProfileResolution(gateway, query || '');
  if (inspection.status !== 'resolved' || !inspection.result) {
    throw createProfileResolutionError(inspection, {
      notFoundMessage: `Profile query not matched: ${query}`,
      recommendedNextTools: ['profile_list', 'profile_resolve'],
    });
  }
  const result = inspection.result;

  const normalizedProfile = normalizeProfile(result.profile);
  return createStructuredResult(
    {
      summary: [
        `Profile query "${asText(result.query)}" resolved by ${result.matchedBy}.`,
        formatProfileLine(normalizedProfile),
      ].join('\n'),
      data: {
        query: asText(result.query),
        matchedBy: result.matchedBy,
        profile: normalizedProfile,
      },
      nextActionHints: [
        'Call session_prepare to bind the current MCP session.',
        'If you are using a separate HTTP client, call profile_start_session for headers and session params.',
      ],
      recommendedNextTools: ['session_prepare', 'profile_start_session'],
      authoritativeFields: ['structuredContent.data.profile.id'],
    }
  );
};

const profileStartSessionHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps
) => {
  const gateway = ensureProfileGateway(deps);
  const query = readStringArg(args, 'query');
  const engine = asText(readStringArg(args, 'engine', { required: false }));
  const visible = readBooleanArg(args, 'visible', false);
  if (engine && engine !== 'electron' && engine !== 'extension' && engine !== 'ruyi') {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'Parameter engine must be "electron", "extension", or "ruyi"'
    );
  }

  const inspection = await inspectProfileResolution(gateway, query || '');
  if (inspection.status !== 'resolved' || !inspection.result) {
    throw createProfileResolutionError(inspection, {
      notFoundMessage: `Profile query not matched: ${query}`,
      recommendedNextTools: ['profile_list', 'profile_resolve'],
    });
  }
  const result = inspection.result;

  const profile = normalizeProfile(result.profile);
  const requestedEngine = normalizeEngine(engine);
  const profileEngine = normalizeEngine(profile.engine);
  if (requestedEngine && profileEngine && requestedEngine !== profileEngine) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Profile ${profile.id} is bound to engine "${profileEngine}" and cannot start a session with engine "${requestedEngine}"`,
      {
        suggestion:
          'Choose a profile whose engine matches the requested session engine, or omit engine to reuse the profile default.',
        context: {
          reasonCode: 'profile_engine_mismatch',
          effectiveProfileSource: 'resolved_query',
          effectiveEngineSource: 'requested',
          query: asText(result.query),
          profileId: profile.id,
          profileName: profile.name,
          profileEngine,
          requestedEngine,
        },
      }
    );
  }
  const mcpHeaders: Record<string, string> = {
    'mcp-partition': profile.id,
  };
  if (engine) {
    mcpHeaders['mcp-engine'] = engine;
  }

  return createStructuredResult(
    {
      summary: [
        `Prepared reusable session parameters for profile ${profile.id}.`,
        formatProfileLine(profile),
        `Headers: ${Object.entries(mcpHeaders)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`,
        `Create session: profileId=${profile.id}${engine ? `, engine=${engine}` : ''}, visible=${visible}`,
      ].join('\n'),
      data: {
        query: asText(result.query),
        matchedBy: result.matchedBy,
        profile,
        sessionPlan: {
          mcpHeaders,
          orchestrationSessionCreate: {
            profileId: profile.id,
            ...(engine ? { engine } : {}),
            visible,
          },
        },
        note: 'This helper prepares external session parameters and does not switch the current MCP session.',
      },
      nextActionHints: [
        'For the current MCP session, prefer session_prepare instead of manually setting headers.',
        'For an external HTTP/MCP client, reuse the returned headers when creating a new session.',
      ],
      recommendedNextTools: ['session_prepare'],
      authoritativeFields: [
        'structuredContent.data.profile.id',
        'structuredContent.data.sessionPlan.orchestrationSessionCreate',
      ],
    }
  );
};

const profileCreateHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureProfileGateway(deps);
  readRequiredConfirmationArg(args, 'confirmRisk', 'profile creation');
  const created = normalizeProfile(await gateway.createProfile(buildCreateProfileParams(args)));

  return createStructuredResult({
    summary: `Created profile ${created.id}.`,
    data: {
      profileId: created.id,
      created: true,
      profile: created,
    },
    nextActionHints: [
      'Use session_prepare when you want to bind the current MCP session to this profile.',
      'Use system_bootstrap when you want a refreshed framework-level resource summary after creating the profile.',
    ],
    recommendedNextTools: ['session_prepare', 'system_bootstrap'],
    authoritativeFields: ['structuredContent.data.profile.id', 'structuredContent.data.created'],
  });
};

const profileUpdateHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureProfileGateway(deps);
  readRequiredConfirmationArg(args, 'confirmRisk', 'profile update');
  const profileId = readStringArg(args, 'profileId', { required: true }) || '';
  const params = buildUpdateProfileParams(args);
  const changedFields = Object.keys(params);
  if (changedFields.length === 0) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'profile_update requires at least one mutable field',
      {
        suggestion:
          'Provide one or more profile fields to update, such as name, engine, proxy, fingerprint, tags, or timeouts.',
      }
    );
  }

  const runtimeResetExpected = hasProfileRuntimeMutation(params);
  if (runtimeResetExpected && args.allowRuntimeReset !== true) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'Runtime-affecting profile changes require allowRuntimeReset=true',
      {
        suggestion:
          'Set allowRuntimeReset=true only after confirming that changing engine/fingerprint/proxy/timeouts may reset active runtime state for this profile.',
        context: {
          profileId,
          changedFields,
        },
      }
    );
  }

  const updated = normalizeProfile(await gateway.updateProfile(profileId, params));
  return createStructuredResult({
    summary: `Updated profile ${updated.id}.`,
    data: {
      profileId: updated.id,
      updated: true,
      runtimeResetExpected,
      profile: updated,
    },
    nextActionHints: [
      'Use session_prepare when you want to bind the current MCP session to the updated profile.',
      'Use system_bootstrap when you want a refreshed framework-level resource summary after the update.',
    ],
    recommendedNextTools: ['session_prepare', 'system_bootstrap'],
    authoritativeFields: [
      'structuredContent.data.profile.id',
      'structuredContent.data.updated',
      'structuredContent.data.runtimeResetExpected',
    ],
  });
};

const profileDeleteHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureProfileGateway(deps);
  const profileId = readStringArg(args, 'profileId', { required: true }) || '';
  readRequiredConfirmationArg(args, 'confirmDelete', 'profile deletion');
  await gateway.deleteProfile(profileId);

  return createStructuredResult({
    summary: `Deleted profile ${profileId}.`,
    data: {
      profileId,
      deleted: true,
    },
    nextActionHints: [
      'Use system_bootstrap when you want a refreshed framework-level resource summary after deleting the profile.',
      'Use profile_list to verify which reusable profiles remain available.',
    ],
    recommendedNextTools: ['system_bootstrap', 'profile_list'],
    authoritativeFields: ['structuredContent.data.profileId', 'structuredContent.data.deleted'],
  });
};

const PROFILE_CAPABILITIES: Array<{
  key: string;
  metadata: CapabilityMetadata;
  definition: Omit<OrchestrationCapabilityDefinition, keyof CapabilityMetadata | 'version' | 'outputSchema'> & {
    outputSchema?: Record<string, unknown>;
  };
  handler: CapabilityHandler<OrchestrationDependencies>;
}> = [
  {
    key: 'profile_list',
    metadata: PROFILE_READ_METADATA,
    definition: {
      name: 'profile_list',
      description:
        'List browser environment profiles for selecting reusable logged-in sessions.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1 },
          engine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
          status: { type: 'string', enum: ['idle', 'active', 'error'] },
          includeSystem: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1 },
        },
      },
    },
    handler: profileListHandler,
  },
  {
    key: 'profile_get',
    metadata: PROFILE_READ_METADATA,
    definition: {
      name: 'profile_get',
      description: 'Get a browser profile by profileId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['profileId'],
        properties: {
          profileId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: PROFILE_OUTPUT_SCHEMAS.profile_get,
    },
    handler: profileGetHandler,
  },
  {
    key: 'profile_resolve',
    metadata: PROFILE_READ_METADATA,
    definition: {
      name: 'profile_resolve',
      description:
        'Resolve a profile query (id or exact name) to a canonical profileId for session reuse.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: PROFILE_OUTPUT_SCHEMAS.profile_resolve,
    },
    handler: profileResolveHandler,
  },
  {
    key: 'profile_start_session',
    metadata: PROFILE_READ_METADATA,
    definition: {
      name: 'profile_start_session',
      description:
        'Resolve a profile query and return explicit MCP/HTTP session parameters for external session reuse clients.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1 },
          engine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
          visible: { type: 'boolean' },
        },
      },
      outputSchema: PROFILE_OUTPUT_SCHEMAS.profile_start_session,
    },
    handler: profileStartSessionHandler,
  },
  {
    key: 'profile_create',
    metadata: PROFILE_WRITE_METADATA,
    definition: {
      name: 'profile_create',
      description:
        'Create one browser profile. This is high-risk and requires explicit confirmation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'confirmRisk'],
        properties: {
          name: { type: 'string', minLength: 1 },
          engine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
          groupId: { type: ['string', 'null'] },
          proxy: { type: ['object', 'null'], additionalProperties: true },
          fingerprint: { type: ['object', 'null'], additionalProperties: true },
          notes: { type: ['string', 'null'] },
          tags: { type: 'array', items: { type: 'string', minLength: 1 } },
          color: { type: ['string', 'null'] },
          idleTimeoutMs: { type: 'integer', minimum: 0 },
          lockTimeoutMs: { type: 'integer', minimum: 0 },
          confirmRisk: { type: 'boolean' },
        },
      },
      outputSchema: PROFILE_OUTPUT_SCHEMAS.profile_create,
      assistantGuidance: {
        workflowStage: 'setup',
        whenToUse:
          'Use only when the model intentionally needs to create a reusable browser profile and has already verified the requested runtime settings.',
        preferredTargetKind: 'profile',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['session_prepare', 'system_bootstrap'],
        examples: [
          {
            title: 'Create one extension profile',
            arguments: {
              name: 'Shop QA',
              engine: 'extension',
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
    handler: profileCreateHandler,
  },
  {
    key: 'profile_update',
    metadata: PROFILE_WRITE_METADATA,
    definition: {
      name: 'profile_update',
      description:
        'Update one browser profile by profileId. Runtime-affecting changes require allowRuntimeReset=true and explicit confirmation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['profileId', 'confirmRisk'],
        properties: {
          profileId: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          engine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
          groupId: { type: ['string', 'null'] },
          proxy: { type: ['object', 'null'], additionalProperties: true },
          fingerprint: { type: ['object', 'null'], additionalProperties: true },
          notes: { type: ['string', 'null'] },
          tags: { type: 'array', items: { type: 'string', minLength: 1 } },
          color: { type: ['string', 'null'] },
          idleTimeoutMs: { type: 'integer', minimum: 0 },
          lockTimeoutMs: { type: 'integer', minimum: 0 },
          allowRuntimeReset: { type: 'boolean' },
          confirmRisk: { type: 'boolean' },
        },
      },
      outputSchema: PROFILE_OUTPUT_SCHEMAS.profile_update,
      assistantGuidance: {
        workflowStage: 'setup',
        whenToUse:
          'Use only when the model intentionally needs to mutate one profile and has already verified whether the change can reset runtime state.',
        preferredTargetKind: 'profile',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['session_prepare', 'system_bootstrap'],
        examples: [
          {
            title: 'Rename one profile',
            arguments: {
              profileId: 'profile_123',
              name: 'Shop QA Updated',
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
    handler: profileUpdateHandler,
  },
  {
    key: 'profile_delete',
    metadata: PROFILE_WRITE_METADATA,
    definition: {
      name: 'profile_delete',
      description: 'Delete one browser profile by profileId. This is destructive and requires explicit confirmation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['profileId', 'confirmDelete'],
        properties: {
          profileId: { type: 'string', minLength: 1 },
          confirmDelete: { type: 'boolean' },
        },
      },
      outputSchema: PROFILE_OUTPUT_SCHEMAS.profile_delete,
      assistantGuidance: {
        workflowStage: 'teardown',
        whenToUse:
          'Use only for explicit profile cleanup when the model intentionally needs to remove one reusable browser profile.',
        preferredTargetKind: 'profile',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['system_bootstrap', 'profile_list'],
        examples: [
          {
            title: 'Delete one profile',
            arguments: {
              profileId: 'profile_123',
              confirmDelete: true,
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: profileDeleteHandler,
  },
];

export function createProfileCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    PROFILE_CAPABILITIES.map((capability) => [
      capability.key,
      {
        definition: {
          ...capability.definition,
          title: toCapabilityTitle(capability.definition.name),
          outputSchema:
            capability.definition.outputSchema ||
            PROFILE_OUTPUT_SCHEMAS[capability.definition.name] ||
            createOpaqueOutputSchema(),
          annotations: buildCapabilityAnnotations(capability.metadata, {
            destructiveHint: capability.key === 'profile_delete',
          }),
          version: PROFILE_CAPABILITY_VERSION,
          ...capability.metadata,
        },
        handler: capability.handler,
      },
    ])
  );
}
