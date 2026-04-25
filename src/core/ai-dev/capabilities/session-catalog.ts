import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import { DEFAULT_BROWSER_PROFILE } from '../../../constants/browser-pool';
import type {
  OrchestrationCapabilityDefinition,
  OrchestrationDependencies,
  OrchestrationMcpSessionInfo,
  OrchestrationProfileInfo,
} from '../orchestration/types';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../../observability/observation-context';
import { attachErrorContextArtifact } from '../../observability/error-context-artifact';
import { observationService, summarizeForObservation } from '../../observability/observation-service';
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
import { SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS } from './assistant-guidance';
import { createStructuredResult } from './result-utils';

const SESSION_CAPABILITY_VERSION = '1.0.0';

const SESSION_READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 300,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['session.read'],
  requires: ['mcpSessionGateway'],
};

const SESSION_WRITE_METADATA: CapabilityMetadata = {
  idempotent: false,
  sideEffectLevel: 'low',
  estimatedLatencyMs: 600,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['session.write'],
  requires: ['mcpSessionGateway'],
};

const SESSION_PREPARE_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'low',
  estimatedLatencyMs: 500,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['session.write'],
  requires: ['mcpSessionGateway'],
};

const asText = (value: unknown): string => String(value == null ? '' : value).trim();
type EffectivePreparationProfileSource =
  | 'resolved_query'
  | 'current_session'
  | 'default_profile'
  | 'none';
type EffectivePreparationEngineSource = 'requested' | 'sticky_session' | 'profile_default' | 'none';

const PROFILE_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'engine', 'status', 'isSystem'],
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
  },
} as const;

const BROWSER_RUNTIME_DESCRIPTOR_SCHEMA = createBrowserRuntimeDescriptorSchema();

const SESSION_ACQUIRE_READINESS_BROWSER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['browserId', 'status', 'engine', 'source', 'pluginId', 'requestId', 'viewId'],
  properties: {
    browserId: { type: 'string' },
    status: { type: 'string' },
    engine: { type: ['string', 'null'] },
    source: { type: ['string', 'null'] },
    pluginId: { type: ['string', 'null'] },
    requestId: { type: ['string', 'null'] },
    viewId: { type: ['string', 'null'] },
  },
} as const;

const SESSION_ACQUIRE_READINESS_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'profileId',
    'browserCount',
    'lockedBrowserCount',
    'creatingBrowserCount',
    'idleBrowserCount',
    'destroyingBrowserCount',
    'busy',
    'browsers',
  ],
  properties: {
    profileId: { type: 'string' },
    browserCount: { type: 'number' },
    lockedBrowserCount: { type: 'number' },
    creatingBrowserCount: { type: 'number' },
    idleBrowserCount: { type: 'number' },
    destroyingBrowserCount: { type: 'number' },
    busy: { type: 'boolean' },
    browsers: {
      type: 'array',
      items: SESSION_ACQUIRE_READINESS_BROWSER_SCHEMA,
    },
  },
} as const;

const SESSION_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sessionId',
    'lastActivityAt',
    'pendingInvocations',
    'activeInvocations',
    'maxQueueSize',
    'browserAcquired',
    'browserAcquireInProgress',
    'hasBrowserHandle',
    'phase',
    'bindingLocked',
  ],
  properties: {
    sessionId: { type: 'string' },
    profileId: { type: 'string' },
    engine: { type: 'string' },
    visible: { type: 'boolean' },
    lastActivityAt: { type: 'string' },
    pendingInvocations: { type: 'number' },
    activeInvocations: { type: 'number' },
    maxQueueSize: { type: 'number' },
    browserAcquired: { type: 'boolean' },
    browserAcquireInProgress: { type: 'boolean' },
    hasBrowserHandle: { type: 'boolean' },
    effectiveScopes: {
      type: 'array',
      items: { type: 'string' },
    },
    closing: { type: 'boolean' },
    terminateAfterResponse: { type: 'boolean' },
    hostWindowId: { type: 'string' },
    viewportHealth: { type: 'string', enum: ['unknown', 'ready', 'warning', 'broken'] },
    viewportHealthReason: { type: 'string' },
    interactionReady: { type: 'boolean' },
    offscreenDetected: { type: 'boolean' },
    engineRuntimeDescriptor: {
      anyOf: [{ type: 'null' }, BROWSER_RUNTIME_DESCRIPTOR_SCHEMA],
    },
    browserRuntimeDescriptor: {
      anyOf: [{ type: 'null' }, BROWSER_RUNTIME_DESCRIPTOR_SCHEMA],
    },
    resolvedRuntimeDescriptor: {
      anyOf: [{ type: 'null' }, BROWSER_RUNTIME_DESCRIPTOR_SCHEMA],
    },
    acquireReadiness: SESSION_ACQUIRE_READINESS_SCHEMA,
    phase: {
      type: 'string',
      enum: [
        'fresh_unbound',
        'prepared_unacquired',
        'acquiring_browser',
        'bound_browser',
        'closing',
        'closed',
      ],
    },
    bindingLocked: { type: 'boolean' },
  },
} as const;

const EFFECTIVE_PROFILE_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['id', 'name', 'engine', 'source'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    engine: { type: 'string' },
    source: {
      type: 'string',
      enum: ['resolved_query', 'current_session', 'default_profile', 'none'],
    },
  },
} as const;

const SESSION_OUTPUT_SCHEMAS: Partial<Record<string, Record<string, unknown>>> = {
  session_list: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['total', 'currentSessionId', 'sessions', 'filter'],
    properties: {
      total: { type: 'number' },
      currentSessionId: { type: ['string', 'null'] },
      sessions: {
        type: 'array',
        items: SESSION_INFO_SCHEMA,
      },
      filter: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profileId: { type: ['string', 'null'] },
          includeCurrent: { type: 'boolean' },
        },
        required: ['profileId', 'includeCurrent'],
      },
    },
  }),
  session_get_current: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['currentSessionId', 'session'],
    properties: {
      currentSessionId: { type: 'string' },
      session: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: SESSION_INFO_SCHEMA.required,
        properties: SESSION_INFO_SCHEMA.properties,
      },
    },
  }),
  session_prepare: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: [
      'sessionId',
      'prepared',
      'idempotent',
      'effectiveProfile',
      'visible',
      'effectiveEngine',
      'effectiveEngineSource',
      'effectiveScopes',
      'browserAcquired',
      'changed',
      'phase',
      'bindingLocked',
    ],
    properties: {
      sessionId: { type: 'string' },
      query: { type: ['string', 'null'] },
      matchedBy: { type: ['string', 'null'] },
      profile: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: PROFILE_INFO_SCHEMA.required,
        properties: PROFILE_INFO_SCHEMA.properties,
      },
      effectiveProfile: EFFECTIVE_PROFILE_SCHEMA,
      prepared: { type: 'boolean' },
      idempotent: { type: 'boolean' },
      engine: { type: ['string', 'null'] },
      effectiveEngine: { type: ['string', 'null'] },
      effectiveEngineSource: {
        type: 'string',
        enum: ['requested', 'sticky_session', 'profile_default', 'none'],
      },
      visible: { type: 'boolean' },
      effectiveScopes: {
        type: 'array',
        items: { type: 'string' },
      },
      browserAcquired: { type: 'boolean' },
      acquireReadiness: SESSION_ACQUIRE_READINESS_SCHEMA,
      phase: {
        type: 'string',
        enum: [
          'fresh_unbound',
          'prepared_unacquired',
          'acquiring_browser',
          'bound_browser',
          'closing',
          'closed',
        ],
      },
      bindingLocked: { type: 'boolean' },
      changed: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['profile', 'engine', 'visible', 'scopes'],
        },
      },
    },
  }),
  session_close: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: [
      'closed',
      'sessionId',
      'closedCurrentSession',
      'transportInvalidated',
      'allowFurtherCallsOnSameTransport',
      'terminationTiming',
    ],
    properties: {
      closed: { type: 'boolean' },
      sessionId: { type: 'string' },
      closedCurrentSession: { type: 'boolean' },
      transportInvalidated: { type: 'boolean' },
      allowFurtherCallsOnSameTransport: { type: 'boolean' },
      terminationTiming: {
        type: 'string',
        enum: ['immediate', 'after_response_flush'],
      },
    },
  }),
  session_end_current: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: [
      'closed',
      'sessionId',
      'closedCurrentSession',
      'transportInvalidated',
      'allowFurtherCallsOnSameTransport',
      'terminationTiming',
    ],
    properties: {
      closed: { type: 'boolean' },
      sessionId: { type: 'string' },
      closedCurrentSession: { type: 'boolean' },
      transportInvalidated: { type: 'boolean' },
      allowFurtherCallsOnSameTransport: { type: 'boolean' },
      terminationTiming: {
        type: 'string',
        enum: ['immediate', 'after_response_flush'],
      },
    },
  }),
  session_close_profile: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['profileId', 'profileHint', 'matched', 'closedSessionIds', 'skipped'],
    properties: {
      profileId: { type: 'string' },
      profileHint: { type: 'string' },
      matched: { type: 'number' },
      closedSessionIds: {
        type: 'array',
        items: { type: 'string' },
      },
      skipped: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId', 'reason'],
          properties: {
            sessionId: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  }),
};

const asBool = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  throw createStructuredError(ErrorCode.INVALID_PARAMETER, 'Boolean parameter expected');
};

const readOptionalBooleanArg = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
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

const readOptionalStringArrayArg = (
  args: Record<string, unknown>,
  key: string
): string[] | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be an array of strings`);
  }

  const values = raw.map((item) => {
    if (typeof item !== 'string') {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        `Parameter ${key} must contain only strings`
      );
    }

    const value = item.trim();
    if (!value) {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        `Parameter ${key} must not contain empty strings`
      );
    }

    return value;
  });

  return Array.from(new Set(values));
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
  return `- ${fields.join(' | ')}${extras.length ? ` | ${extras.join(' | ')}` : ''}`;
};

const formatSessionLine = (
  session: OrchestrationMcpSessionInfo,
  currentSessionId: string
): string => {
  const label = asText(session.sessionId) === currentSessionId ? ' [current]' : '';
  const browserAcquired = session.browserAcquired ?? session.hasBrowserHandle;
  return [
    `- ${asText(session.sessionId)}${label}`,
    `profile=${asText(session.profileId) || 'none'}`,
    `engine=${asText(session.engine) || 'auto'}`,
    `visible=${session.visible === true}`,
    `browser=${browserAcquired ? 'attached' : 'none'}`,
    `host=${asText(session.hostWindowId) || 'none'}`,
    `viewport=${asText(session.viewportHealth) || 'unknown'}`,
    `phase=${asText(session.phase) || 'fresh_unbound'}`,
    `bindingLocked=${session.bindingLocked === true}`,
    session.interactionReady === true ? 'interactionReady=true' : '',
    session.offscreenDetected === true ? 'offscreenDetected=true' : '',
    session.browserAcquireInProgress === true ? 'browserAcquireInProgress=true' : '',
    `queue=${session.pendingInvocations} pending/${session.activeInvocations} active`,
    asText(session.viewportHealthReason)
      ? `viewportReason=${asText(session.viewportHealthReason)}`
      : '',
    session.closing === true ? 'closing=true' : '',
    session.terminateAfterResponse === true ? 'terminateAfterResponse=true' : '',
    session.effectiveScopes?.length ? `scopes=${session.effectiveScopes.join(',')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
};

const formatSessionPreview = (
  sessions: OrchestrationMcpSessionInfo[],
  currentSessionId: string,
  limit = 5
): string[] => {
  const preview = sessions.slice(0, limit).map((session) => formatSessionLine(session, currentSessionId));
  const remaining = sessions.length - preview.length;
  if (remaining > 0) {
    preview.push(`- ...and ${remaining} more session(s)`);
  }
  return preview;
};

const normalizeEngine = (value: unknown): 'electron' | 'extension' | 'ruyi' | undefined => {
  const normalized = asText(value).toLowerCase();
  if (normalized === 'electron' || normalized === 'extension' || normalized === 'ruyi') {
    return normalized;
  }
  return undefined;
};

const getCurrentSessionInfo = async (
  gateway: NonNullable<OrchestrationDependencies['mcpSessionGateway']>
): Promise<OrchestrationMcpSessionInfo | null> => {
  const currentSessionId = asText(gateway.getCurrentSessionId());
  if (!currentSessionId) {
    return null;
  }

  const sessions = await gateway.listSessions();
  return sessions.find((item) => asText(item.sessionId) === currentSessionId) || null;
};

const resolveEffectivePreparationProfile = async (
  deps: OrchestrationDependencies,
  options: {
    resolvedProfile?: OrchestrationProfileInfo | null;
    currentSession?: OrchestrationMcpSessionInfo | null;
  }
): Promise<{ profile: OrchestrationProfileInfo | null; source: EffectivePreparationProfileSource }> => {
  if (options.resolvedProfile) {
    return { profile: options.resolvedProfile, source: 'resolved_query' };
  }

  const gateway = deps.profileGateway;
  if (!gateway) {
    return { profile: null, source: 'none' };
  }

  const currentProfileId = asText(options.currentSession?.profileId);
  const source: EffectivePreparationProfileSource = currentProfileId
    ? 'current_session'
    : 'default_profile';
  const targetProfileId = currentProfileId || DEFAULT_BROWSER_PROFILE.id;
  if (!targetProfileId) {
    return { profile: null, source: 'none' };
  }

  const profile = await gateway.getProfile(targetProfileId);
  return profile
    ? { profile: normalizeProfile(profile), source }
    : { profile: null, source: 'none' };
};

const resolveEffectiveEngineState = (options: {
  requestedEngine?: string;
  stickySessionEngine?: string;
  effectiveProfile?: OrchestrationProfileInfo | null;
}): {
  engine: 'electron' | 'extension' | 'ruyi' | null;
  source: EffectivePreparationEngineSource;
} => {
  const requestedEngine = normalizeEngine(options.requestedEngine);
  if (requestedEngine) {
    return { engine: requestedEngine, source: 'requested' };
  }

  const stickySessionEngine = normalizeEngine(options.stickySessionEngine);
  if (stickySessionEngine) {
    return { engine: stickySessionEngine, source: 'sticky_session' };
  }

  const profileEngine = normalizeEngine(options.effectiveProfile?.engine);
  if (profileEngine) {
    return { engine: profileEngine, source: 'profile_default' };
  }

  return { engine: null, source: 'none' };
};

const assertEngineCompatibleWithProfile = (options: {
  profile: OrchestrationProfileInfo | null;
  effectiveEngine?: string;
  effectiveEngineSource?: EffectivePreparationEngineSource;
  effectiveProfileSource?: EffectivePreparationProfileSource;
  sessionId?: string;
  currentProfileId?: string;
  currentEngine?: string;
  query?: string;
}): void => {
  const profile = options.profile;
  const effectiveEngine = normalizeEngine(options.effectiveEngine);
  const profileEngine = normalizeEngine(profile?.engine);
  if (!profile || !effectiveEngine || !profileEngine || effectiveEngine === profileEngine) {
    return;
  }

  throw createStructuredError(
    ErrorCode.INVALID_PARAMETER,
    `Profile ${asText(profile.id) || 'unknown'} is bound to engine "${profileEngine}" and cannot be prepared with engine "${effectiveEngine}"`,
    {
      suggestion:
        'Choose a profile whose engine matches the requested session engine, or replay session_prepare with a compatible engine.',
      reasonCode: 'profile_engine_mismatch',
      retryable: true,
      recommendedNextTools: ['profile_resolve', 'session_prepare'],
      authoritativeFields: [...SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS],
      nextActionHints: [
        'Switch to a compatible profile or engine pairing before retrying session_prepare.',
      ],
      context: {
        reasonCode: 'profile_engine_mismatch',
        sessionId: asText(options.sessionId) || undefined,
        query: asText(options.query) || undefined,
        profileId: asText(profile.id) || undefined,
        profileName: asText(profile.name) || undefined,
        effectiveProfileSource: options.effectiveProfileSource || 'none',
        profileEngine,
        requestedEngine: effectiveEngine,
        effectiveEngineSource: options.effectiveEngineSource || 'none',
        currentProfileId: asText(options.currentProfileId) || undefined,
        currentEngine: normalizeEngine(options.currentEngine),
      },
    }
  );
};

const ensureSessionGateway = (deps: OrchestrationDependencies) => {
  if (!deps.mcpSessionGateway) {
    throw createStructuredError(ErrorCode.OPERATION_FAILED, 'MCP session gateway is not configured', {
      suggestion: 'Please call this capability from an active MCP session',
      reasonCode: 'mcp_session_gateway_missing',
      retryable: false,
    });
  }
  return deps.mcpSessionGateway;
};

const ensureProfileGateway = (deps: OrchestrationDependencies) => {
  if (!deps.profileGateway) {
    throw createStructuredError(ErrorCode.OPERATION_FAILED, 'Profile gateway is not configured', {
      suggestion: 'Please inject profileGateway into orchestration dependencies',
      reasonCode: 'profile_gateway_missing',
      retryable: false,
    });
  }
  return deps.profileGateway;
};

const sortSessions = (sessions: OrchestrationMcpSessionInfo[]): OrchestrationMcpSessionInfo[] =>
  [...sessions].sort((a, b) => {
    const ta = Date.parse(a.lastActivityAt || '') || 0;
    const tb = Date.parse(b.lastActivityAt || '') || 0;
    if (tb !== ta) return tb - ta;
    return String(a.sessionId).localeCompare(String(b.sessionId));
  });

const resolveProfileId = async (
  deps: OrchestrationDependencies,
  profileHint: string
): Promise<string> => {
  const hint = asText(profileHint);
  if (!hint) return '';
  const gateway = deps.profileGateway;
  if (!gateway) return hint;

  const byId = await gateway.getProfile(hint);
  if (byId?.id) return asText(byId.id) || hint;

  const resolved = await gateway.resolveProfile(hint);
  if (resolved?.profile?.id) return asText(resolved.profile.id) || hint;

  return hint;
};

const sessionListHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureSessionGateway(deps);
  const includeCurrent = asBool(args.includeCurrent, true);
  const profileHint = readStringArg(args, 'profileId', { required: false }) || '';
  const limit = readOptionalLimitArg(args, 'limit');
  const resolvedProfileId = profileHint ? await resolveProfileId(deps, profileHint) : '';

  const currentSessionId = asText(gateway.getCurrentSessionId());
  const sessions = sortSessions(await gateway.listSessions());
  const filtered = sessions.filter((item) => {
    if (!includeCurrent && currentSessionId && item.sessionId === currentSessionId) return false;
    if (resolvedProfileId && asText(item.profileId) !== resolvedProfileId) return false;
    return true;
  });
  const visibleSessions = limit ? filtered.slice(0, limit) : filtered;
  const truncated = typeof limit === 'number' && visibleSessions.length < filtered.length;

  return createStructuredResult(
    {
      summary: [
        `Found ${filtered.length} active MCP session(s).`,
        currentSessionId ? `Current session: ${currentSessionId}.` : '',
        resolvedProfileId ? `Filter: profileId=${resolvedProfileId}.` : '',
        visibleSessions.some((session) => session.acquireReadiness?.busy)
          ? 'One or more sessions are bound to profiles with live pooled browser holders.'
          : '',
        truncated ? `Returned the first ${visibleSessions.length} result(s) because limit=${limit}.` : '',
        ...formatSessionPreview(visibleSessions, currentSessionId),
      ]
        .filter(Boolean)
        .join('\n'),
      data: {
        total: filtered.length,
        currentSessionId: currentSessionId || null,
        sessions: visibleSessions,
        filter: {
          profileId: resolvedProfileId || null,
          includeCurrent,
        },
      },
      truncated,
      nextActionHints: [
        'Use session_get_current to inspect the active session in detail.',
        'Inspect session.acquireReadiness before assuming a browser_* call can bind immediately.',
        'Use session_prepare before the first browser_* call when reusing a logged-in profile or setting sticky session scopes.',
        'When work is complete, ask the host to terminate the MCP session with StreamableHTTPClientTransport.terminateSession() or DELETE /mcp plus the current mcp-session-id.',
        'If you can only act through MCP tools, prefer session_end_current as the final step.',
        'If you need to close a non-current session, call session_close with the target sessionId.',
      ],
    }
  );
};

const sessionGetCurrentHandler: CapabilityHandler<OrchestrationDependencies> = async (_args, deps) => {
  const gateway = ensureSessionGateway(deps);
  const currentSessionId = asText(gateway.getCurrentSessionId());
  if (!currentSessionId) {
    throw createStructuredError(ErrorCode.NOT_FOUND, 'Current MCP session is not available', {
      reasonCode: 'current_session_unavailable',
      retryable: true,
      recommendedNextTools: ['session_prepare'],
      nextActionHints: ['Create a new MCP session before issuing more browser work.'],
    });
  }

  const sessions = await gateway.listSessions();
  const current = sessions.find((item) => asText(item.sessionId) === currentSessionId);

  return createStructuredResult(
    {
      summary: current
        ? [
            `Current MCP session is ${currentSessionId}.`,
            formatSessionLine(current, currentSessionId),
            current.acquireReadiness?.busy
              ? `Acquire readiness is busy for profile ${current.acquireReadiness.profileId} (${current.acquireReadiness.lockedBrowserCount} locked, ${current.acquireReadiness.creatingBrowserCount} creating).`
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : `Current MCP session is ${currentSessionId}.`,
      data: {
        currentSessionId,
        session: current || null,
      },
      nextActionHints: [
        'If the session still needs a reusable profile, engine, visibility, or sticky scopes, call session_prepare before browser_* tools.',
        'Inspect session.acquireReadiness before assuming the next browser_* call can bind immediately.',
        'When work is complete, ask the host to terminate the MCP session with StreamableHTTPClientTransport.terminateSession() or DELETE /mcp plus the current mcp-session-id.',
        'If you can only act through MCP tools, prefer session_end_current as the final step.',
        'If you need to close another session instead, use session_close with an explicit sessionId.',
      ],
      recommendedNextTools: ['session_prepare', 'browser_snapshot', 'session_end_current'],
      authoritativeFields: [
        'structuredContent.data.session.phase',
        'structuredContent.data.session.bindingLocked',
      ],
    }
  );
};

const buildSessionCloseStructuredResult = (
  sessionId: string,
  result: {
    closedCurrentSession?: boolean;
    transportInvalidated?: boolean;
    allowFurtherCallsOnSameTransport?: boolean;
    terminationTiming?: 'immediate' | 'after_response_flush';
  }
) => {
  const closedCurrentSession = result.closedCurrentSession === true;
  const transportInvalidated = result.transportInvalidated === true;
  const allowFurtherCallsOnSameTransport = result.allowFurtherCallsOnSameTransport !== false;
  const terminationTiming = result.terminationTiming || 'immediate';

  return createStructuredResult({
    summary: closedCurrentSession
      ? [
          `Closed current MCP session ${asText(sessionId)}.`,
          'The current transport will be invalidated after this response is flushed.',
        ].join('\n')
      : `Closed MCP session ${asText(sessionId)}.`,
    data: {
      closed: true,
      sessionId: asText(sessionId),
      closedCurrentSession,
      transportInvalidated,
      allowFurtherCallsOnSameTransport,
      terminationTiming,
    },
    nextActionHints: closedCurrentSession
      ? [
          'Do not send another request on the same transport after this response.',
          'Create a new MCP session before more browser work is required.',
        ]
      : [
          'The current transport remains usable.',
          'Create or reuse another session if more browser work is required.',
        ],
  });
};

const sessionCloseHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureSessionGateway(deps);
  const sessionId = readStringArg(args, 'sessionId');
  const allowCurrent = asBool(args.allowCurrent, false);
  const result = await gateway.closeSession(asText(sessionId), { allowCurrent });

  if (!result.closed) {
    if (result.reason === 'current_session_blocked') {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        'Closing current MCP session is blocked by default',
        {
          suggestion: 'Pass allowCurrent=true to force close current session',
          context: { sessionId },
        }
      );
    }

    throw createStructuredError(ErrorCode.NOT_FOUND, 'Session not found', {
      context: { sessionId },
    });
  }

  return buildSessionCloseStructuredResult(asText(sessionId), result);
};

const sessionEndCurrentHandler: CapabilityHandler<OrchestrationDependencies> = async (_args, deps) => {
  const gateway = ensureSessionGateway(deps);
  const currentSessionId = asText(gateway.getCurrentSessionId());
  if (!currentSessionId) {
    throw createStructuredError(ErrorCode.NOT_FOUND, 'Current MCP session is not available');
  }

  const result = await gateway.closeSession(currentSessionId, { allowCurrent: true });
  if (!result.closed) {
    throw createStructuredError(ErrorCode.NOT_FOUND, 'Session not found', {
      context: { sessionId: currentSessionId },
    });
  }

  return buildSessionCloseStructuredResult(currentSessionId, result);
};

const sessionCloseProfileHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureSessionGateway(deps);
  const profileHint = readStringArg(args, 'profileId');
  const allowCurrent = asBool(args.allowCurrent, false);
  const profileId = await resolveProfileId(deps, asText(profileHint));
  const sessions = await gateway.listSessions();
  const matched = sessions.filter((item) => asText(item.profileId) === profileId);

  if (!matched.length) {
    throw createStructuredError(ErrorCode.NOT_FOUND, 'No MCP sessions found for profile', {
      context: { profileId, profileHint },
    });
  }

  const closedSessionIds: string[] = [];
  const skipped: Array<{ sessionId: string; reason: string }> = [];

  for (const session of matched) {
    const result = await gateway.closeSession(session.sessionId, { allowCurrent });
    if (result.closed) {
      closedSessionIds.push(session.sessionId);
      continue;
    }
    skipped.push({
      sessionId: session.sessionId,
      reason: asText(result.reason) || 'unknown',
    });
  }

  return createStructuredResult(
    {
      summary: [
        `Processed ${matched.length} session(s) for profile ${profileId}.`,
        closedSessionIds.length ? `Closed: ${closedSessionIds.join(', ')}` : 'Closed: none',
        skipped.length
          ? `Skipped: ${skipped.map((item) => `${item.sessionId}(${item.reason})`).join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      data: {
        profileId,
        profileHint: asText(profileHint),
        matched: matched.length,
        closedSessionIds,
        skipped,
      },
      nextActionHints: ['Review skipped sessions before retrying force-close operations.'],
    }
  );
};

const sessionPrepareHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const sessionGateway = ensureSessionGateway(deps);
  const prepareCurrentSession = sessionGateway.prepareCurrentSession;
  if (typeof prepareCurrentSession !== 'function') {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Current transport does not support preparing the active MCP session',
      {
        suggestion: 'Use this tool from an active MCP session served by /mcp',
      }
    );
  }

  const query = readStringArg(args, 'query', { required: false });
  const engine = readStringArg(args, 'engine', { required: false });
  const visible = readOptionalBooleanArg(args, 'visible');
  const scopes = readOptionalStringArrayArg(args, 'scopes');
  if (engine && engine !== 'electron' && engine !== 'extension' && engine !== 'ruyi') {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'Parameter engine must be "electron", "extension", or "ruyi"'
    );
  }
  const currentSession = await getCurrentSessionInfo(sessionGateway);

  let resolved:
    | {
        query: string;
        matchedBy: 'id' | 'name';
        profile: OrchestrationProfileInfo;
      }
    | null = null;
  if (query) {
    const profileGateway = ensureProfileGateway(deps);
    const inspection = await inspectProfileResolution(profileGateway, asText(query));
    if (inspection.status !== 'resolved' || !inspection.result) {
      throw createProfileResolutionError(inspection, {
        notFoundMessage: `Profile query not matched: ${query}`,
        recommendedNextTools: ['profile_list', 'profile_resolve', 'session_prepare'],
        authoritativeFields: [...SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS],
      });
    }
    const match = inspection.result;
    resolved = {
      query: asText(match.query),
      matchedBy: match.matchedBy,
      profile: normalizeProfile(match.profile),
    };
  }

  const effectiveProfileState = await resolveEffectivePreparationProfile(deps, {
    resolvedProfile: resolved?.profile || null,
    currentSession,
  });
  const effectiveEngineState = resolveEffectiveEngineState({
    requestedEngine: engine,
    stickySessionEngine: currentSession?.engine,
    effectiveProfile: effectiveProfileState.profile,
  });
  assertEngineCompatibleWithProfile({
    profile: effectiveProfileState.profile,
    effectiveEngine: effectiveEngineState.engine || undefined,
    effectiveEngineSource: effectiveEngineState.source,
    effectiveProfileSource: effectiveProfileState.source,
    sessionId: asText(currentSession?.sessionId) || asText(sessionGateway.getCurrentSessionId()),
    currentProfileId: asText(currentSession?.profileId) || undefined,
    currentEngine: normalizeEngine(currentSession?.engine),
    query: resolved?.query,
  });

  const prepared = await prepareCurrentSession({
    ...(resolved ? { profileId: resolved.profile.id } : {}),
    ...(engine ? { engine } : {}),
    ...(visible !== undefined ? { visible } : {}),
    ...(scopes ? { scopes } : {}),
  });

  if (!prepared.prepared) {
    if (prepared.reason === 'current_session_unavailable') {
      throw createStructuredError(ErrorCode.NOT_FOUND, 'Current MCP session is not available', {
        reasonCode: 'current_session_unavailable',
        retryable: true,
        recommendedNextTools: ['session_prepare'],
      });
    }

    if (prepared.reason === 'binding_locked') {
      throw createStructuredError(
        ErrorCode.REQUEST_FAILED,
        'Current MCP session already locked its browser binding and cannot change profile, engine, or visibility',
        {
          suggestion:
            'Replay the same profile, engine, or visibility values for an idempotent check, or create a new MCP session before switching browser binding. Use a separate session_prepare call if you only need to update scopes.',
          reasonCode: 'binding_locked',
          retryable: true,
          recommendedNextTools: ['session_get_current', 'session_end_current', 'session_prepare'],
          authoritativeFields: [...SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS],
          nextActionHints: [
            'Create a new MCP session before changing profile, engine, or visibility.',
            'You may still replay the same binding values or update scopes only.',
          ],
          context: {
            sessionId: prepared.sessionId,
            reason: prepared.reason,
            currentProfileId: prepared.currentProfileId,
            currentEngine: prepared.currentEngine,
            currentVisible: prepared.currentVisible,
            requestedProfileId: resolved?.profile.id,
            requestedEngine: engine,
            requestedVisible: visible,
          },
        }
      );
    }
  }

  const profileLine = resolved ? formatProfileLine(resolved.profile) : '';
  const scopeSummary = prepared.effectiveScopes.length
    ? prepared.effectiveScopes.join(', ')
    : 'none';
  const changedSummary = prepared.changed.length ? prepared.changed.join(', ') : 'none';
  const effectiveProfile =
    effectiveProfileState.profile && effectiveProfileState.source !== 'none'
      ? {
          id: asText(effectiveProfileState.profile.id),
          name: asText(effectiveProfileState.profile.name),
          engine: asText(effectiveProfileState.profile.engine),
          source: effectiveProfileState.source,
        }
      : null;
  const effectiveEngine = resolveEffectiveEngineState({
    requestedEngine: engine,
    stickySessionEngine: prepared.engine,
    effectiveProfile: effectiveProfileState.profile,
  });
  const acquireReadinessSummary = prepared.acquireReadiness
    ? prepared.acquireReadiness.busy
      ? `Acquire readiness: busy for profile ${prepared.acquireReadiness.profileId} (${prepared.acquireReadiness.lockedBrowserCount} locked, ${prepared.acquireReadiness.creatingBrowserCount} creating).`
      : `Acquire readiness: profile ${prepared.acquireReadiness.profileId} currently shows ${prepared.acquireReadiness.browserCount} pooled browser(s) with no active holders.`
    : '';

  return createStructuredResult(
    {
      summary: [
        prepared.idempotent
          ? `Current MCP session ${prepared.sessionId} already matches the requested preparation state.`
          : `Prepared current MCP session ${prepared.sessionId}.`,
        profileLine,
        effectiveProfile
          ? `Effective profile: ${effectiveProfile.id} (${effectiveProfile.name}) via ${effectiveProfile.source}.`
          : 'Effective profile: none.',
        `Session settings: stickyEngine=${prepared.engine || 'none'}, effectiveEngine=${effectiveEngine.engine || 'none'} (${effectiveEngine.source}), visible=${prepared.visible}, scopes=${scopeSummary}, browserAcquired=${prepared.browserAcquired}`,
        acquireReadinessSummary,
        `Changed fields: ${changedSummary}`,
      ]
        .filter(Boolean)
        .join('\n'),
      data: {
        sessionId: prepared.sessionId,
        query: resolved?.query || null,
        matchedBy: resolved?.matchedBy || null,
        profile: resolved?.profile || null,
        effectiveProfile,
        prepared: prepared.prepared,
        idempotent: prepared.idempotent,
        engine: prepared.engine || null,
        effectiveEngine: effectiveEngine.engine,
        effectiveEngineSource: effectiveEngine.source,
        visible: prepared.visible,
        effectiveScopes: prepared.effectiveScopes,
        browserAcquired: prepared.browserAcquired,
        acquireReadiness: prepared.acquireReadiness || null,
        phase: prepared.phase,
        bindingLocked: prepared.bindingLocked,
        changed: prepared.changed,
      },
      nextActionHints: [
        ...(prepared.acquireReadiness?.busy
          ? [
              'This profile already has live pooled browser holders. Inspect acquireReadiness before assuming the next browser_* call can bind immediately.',
            ]
          : []),
        'Use this Airpa session path instead of a generic Playwright/browser MCP server when the task must stay inside an Airpa-managed logged-in profile.',
        'Call browser_observe for the default next step so the model gets a fresh snapshot plus interaction health.',
        'Use session_get_current if you want to confirm the final session snapshot before browser work.',
        'Prefer browser_act with verify once the target page state is known.',
      ],
      recommendedNextTools: ['browser_observe', 'session_get_current', 'browser_snapshot'],
      authoritativeFields: [...SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS],
    },
    {
      resourceLinks: [
        {
          uri: 'airpa://mcp/guides/getting-started',
          name: 'airpa.guide.getting-started',
          title: 'Airpa MCP Getting Started',
          description: 'Recommended canonical flow for preparing reusable logged-in browser sessions.',
          mimeType: 'text/markdown',
        },
      ],
    }
  );
};

const getStructuredData = (
  result: Awaited<ReturnType<CapabilityHandler<OrchestrationDependencies>>>
): Record<string, unknown> | undefined => {
  const structured = result?.structuredContent;
  if (
    structured &&
    typeof structured === 'object' &&
    !Array.isArray(structured) &&
    'data' in structured &&
    structured.data &&
    typeof structured.data === 'object' &&
    !Array.isArray(structured.data)
  ) {
    return structured.data as Record<string, unknown>;
  }
  return undefined;
};

const SESSION_OBSERVATION_EVENTS: Record<string, string> = {
  session_list: 'session.lifecycle.list',
  session_get_current: 'session.lifecycle.get_current',
  session_close: 'session.lifecycle.close',
  session_end_current: 'session.lifecycle.end_current',
  session_close_profile: 'session.lifecycle.close_profile',
  session_prepare: 'session.lifecycle.prepare',
};

const withSessionObservation = (
  key: keyof typeof SESSION_OBSERVATION_EVENTS,
  handler: CapabilityHandler<OrchestrationDependencies>
): CapabilityHandler<OrchestrationDependencies> => {
  const event = SESSION_OBSERVATION_EVENTS[key];
  return async (args, deps, executionContext) => {
    const currentTraceContext = getCurrentTraceContext();
    const currentSessionId =
      deps.mcpSessionGateway?.getCurrentSessionId?.() || currentTraceContext?.sessionId;
    const traceContext = createChildTraceContext({
      source: currentTraceContext?.source ?? 'session-catalog',
      ...(currentSessionId ? { sessionId: String(currentSessionId).trim() } : {}),
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'session',
        event,
        attrs: {
          capability: executionContext?.capability || currentTraceContext?.capability || null,
          args: summarizeForObservation(args, 2),
          currentSessionId: currentSessionId ? String(currentSessionId).trim() : null,
        },
      });

      try {
        const result = await handler(args, deps, executionContext);
        const data = getStructuredData(result) || {};
        const sessionId =
          typeof data.sessionId === 'string' && data.sessionId.trim().length > 0
            ? data.sessionId.trim()
            : currentSessionId
              ? String(currentSessionId).trim()
              : undefined;
        await span.succeed({
          attrs: {
            capability: executionContext?.capability || currentTraceContext?.capability || null,
            ...(sessionId ? { sessionId } : {}),
            data: summarizeForObservation(data, 2),
          },
        });
        return result;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'session',
          label: `${event} failure context`,
          data: {
            capability: executionContext?.capability || currentTraceContext?.capability || null,
            currentSessionId: currentSessionId ? String(currentSessionId).trim() : null,
            args: summarizeForObservation(args, 2),
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            capability: executionContext?.capability || currentTraceContext?.capability || null,
            currentSessionId: currentSessionId ? String(currentSessionId).trim() : null,
          },
        });
        throw error;
      }
    });
  };
};

const SESSION_CAPABILITIES: Array<{
  key: string;
  definition: Omit<OrchestrationCapabilityDefinition, keyof CapabilityMetadata | 'version' | 'outputSchema'> & {
    outputSchema?: Record<string, unknown>;
  };
  metadata: CapabilityMetadata;
  handler: CapabilityHandler<OrchestrationDependencies>;
}> = [
  {
    key: 'session_list',
    definition: {
      name: 'session_list',
      description: 'List active MCP sessions with queue/profile metadata for debugging and recovery.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profileId: { type: 'string', minLength: 1 },
          includeCurrent: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1 },
        },
      },
    },
    metadata: SESSION_READ_METADATA,
    handler: withSessionObservation('session_list', sessionListHandler),
  },
  {
    key: 'session_get_current',
    definition: {
      name: 'session_get_current',
      description: 'Get current MCP session metadata.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    metadata: SESSION_READ_METADATA,
    handler: withSessionObservation('session_get_current', sessionGetCurrentHandler),
  },
  {
    key: 'session_close',
    definition: {
      name: 'session_close',
      description:
        'Close an MCP session by sessionId. Closing the current session invalidates the current transport after the response is flushed.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          allowCurrent: { type: 'boolean' },
        },
      },
      outputSchema: SESSION_OUTPUT_SCHEMAS.session_close,
    },
    metadata: SESSION_WRITE_METADATA,
    handler: withSessionObservation('session_close', sessionCloseHandler),
  },
  {
    key: 'session_end_current',
    definition: {
      name: 'session_end_current',
      description:
        'Close the current MCP session as the final step. The current transport will be invalidated after the response is flushed.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      outputSchema: SESSION_OUTPUT_SCHEMAS.session_end_current,
    },
    metadata: SESSION_WRITE_METADATA,
    handler: withSessionObservation('session_end_current', sessionEndCurrentHandler),
  },
  {
    key: 'session_close_profile',
    definition: {
      name: 'session_close_profile',
      description: 'Close MCP sessions bound to a profile id/name.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['profileId'],
        properties: {
          profileId: { type: 'string', minLength: 1 },
          allowCurrent: { type: 'boolean' },
        },
      },
      outputSchema: SESSION_OUTPUT_SCHEMAS.session_close_profile,
    },
    metadata: SESSION_WRITE_METADATA,
    handler: withSessionObservation('session_close_profile', sessionCloseProfileHandler),
  },
  {
    key: 'session_prepare',
    definition: {
      name: 'session_prepare',
      description:
        'Prepare the current MCP session before the first browser_* call by resolving a reusable profile, choosing engine/visibility, and updating sticky scopes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1 },
          engine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
          visible: { type: 'boolean' },
          scopes: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
        },
      },
      outputSchema: SESSION_OUTPUT_SCHEMAS.session_prepare,
    },
    metadata: SESSION_PREPARE_METADATA,
    handler: withSessionObservation('session_prepare', sessionPrepareHandler),
  },
];

export function createSessionCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    SESSION_CAPABILITIES.map((capability) => [
      capability.key,
      {
        definition: {
          ...capability.definition,
          title: toCapabilityTitle(capability.definition.name),
          outputSchema:
            capability.definition.outputSchema ||
            SESSION_OUTPUT_SCHEMAS[capability.definition.name] ||
            createOpaqueOutputSchema(),
          annotations: buildCapabilityAnnotations(capability.metadata, {
            destructiveHint:
              capability.key === 'session_close' ||
              capability.key === 'session_end_current' ||
              capability.key === 'session_close_profile',
          }),
          version: SESSION_CAPABILITY_VERSION,
          ...capability.metadata,
        },
        handler: capability.handler,
      },
    ])
  );
}
