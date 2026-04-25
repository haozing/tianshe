import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import type {
  OrchestrationCapabilityDefinition,
  OrchestrationDependencies,
  OrchestrationProfileInfo,
  OrchestrationSystemHealthSnapshot,
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
import { createStructuredResult } from './result-utils';
import {
  buildCapabilityAnnotations,
  type CapabilityMetadata,
  createArrayItemsSchema,
  createBrowserRuntimeDescriptorSchema,
  createStructuredEnvelopeSchema,
  toCapabilityTitle,
} from './catalog-utils';
import { getStaticEngineRuntimeDescriptor } from '../../browser-pool/engine-capability-registry';

const SYSTEM_CAPABILITY_VERSION = '1.0.0';

const SYSTEM_READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 250,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['system.read'],
  requires: ['systemGateway'],
};

const HEALTH_ALERT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['code', 'severity', 'message', 'source'],
  properties: {
    code: { type: 'string' },
    severity: { type: 'string', enum: ['warning', 'critical'] },
    message: { type: 'string' },
    source: {
      type: 'string',
      enum: ['runtime_metrics', 'build_freshness', 'mcp_sdk', 'session_leak_risk'],
    },
  },
} as const;

const HEALTH_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: [
    'status',
    'name',
    'version',
    'activeSessions',
    'mcpSessions',
    'orchestrationSessions',
    'runtimeAlerts',
  ],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
    name: { type: 'string' },
    version: { type: 'string' },
    activeSessions: { type: 'number' },
    mcpSessions: { type: 'number' },
    orchestrationSessions: { type: 'number' },
    authEnabled: { type: 'boolean' },
    mcpConfigured: { type: 'boolean' },
    mcpEnabled: { type: 'boolean' },
    mcpRequireAuth: { type: 'boolean' },
    mcpProtocolCompatibilityMode: { type: 'string' },
    mcpProtocolVersion: { type: 'string' },
    mcpSupportedProtocolVersions: {
      type: 'array',
      items: { type: 'string' },
    },
    mcpSdkSupportedProtocolVersions: {
      type: 'array',
      items: { type: 'string' },
    },
    enforceOrchestrationScopes: { type: 'boolean' },
    orchestrationIdempotencyStore: { type: 'string', enum: ['memory', 'duckdb'] },
    queueDepth: { type: 'object', additionalProperties: true },
    runtimeCounters: { type: 'object', additionalProperties: true },
    sessionLeakRisk: { type: 'object', additionalProperties: true },
    sessionCleanupPolicy: { type: 'object', additionalProperties: true },
    processStartTime: { type: ['string', 'null'] },
    mainDistUpdatedAt: { type: ['string', 'null'] },
    rendererDistUpdatedAt: { type: ['string', 'null'] },
    mainBuildStamp: { type: ['object', 'null'], additionalProperties: true },
    mcpRuntimeFreshness: { type: 'object', additionalProperties: true },
    buildFreshness: { type: 'object', additionalProperties: true },
    gitCommit: { type: ['string', 'null'] },
    mcpSdk: { type: 'object', additionalProperties: true },
    runtimeAlerts: {
      type: 'array',
      items: HEALTH_ALERT_SCHEMA,
    },
  },
} as const;

const RESOURCE_SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['available', 'total', 'preview'],
  properties: {
    available: { type: 'boolean' },
    total: { type: 'number' },
    preview: createArrayItemsSchema(),
    error: { type: 'string' },
  },
} as const;

const PLUGIN_RESOURCE_SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['available', 'total', 'preview', 'enabledCount', 'busyCount', 'errorCount'],
  properties: {
    available: { type: 'boolean' },
    total: { type: 'number' },
    enabledCount: { type: 'number' },
    busyCount: { type: 'number' },
    errorCount: { type: 'number' },
    preview: createArrayItemsSchema(),
    error: { type: 'string' },
  },
} as const;

const BROWSER_RUNTIME_DESCRIPTOR_SCHEMA = createBrowserRuntimeDescriptorSchema();

const BROWSER_ENGINE_SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'descriptors'],
  properties: {
    total: { type: 'number' },
    descriptors: {
      type: 'object',
      additionalProperties: false,
      required: ['electron', 'extension', 'ruyi'],
      properties: {
        electron: BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
        extension: BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
        ruyi: BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
      },
    },
  },
} as const;

const SYSTEM_GET_HEALTH_OUTPUT_SCHEMA = createStructuredEnvelopeSchema(HEALTH_SNAPSHOT_SCHEMA);

const SYSTEM_BOOTSTRAP_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['health', 'publicCapabilities', 'capabilityFamilies', 'browserEngines', 'resources'],
  properties: {
    health: HEALTH_SNAPSHOT_SCHEMA,
    publicCapabilities: {
      type: 'array',
      items: { type: 'string' },
    },
    capabilityFamilies: {
      type: 'array',
      items: { type: 'string' },
    },
    browserEngines: BROWSER_ENGINE_SECTION_SCHEMA,
    resources: {
      type: 'object',
      additionalProperties: false,
      required: ['profiles', 'datasets', 'plugins'],
      properties: {
        profiles: RESOURCE_SECTION_SCHEMA,
        datasets: RESOURCE_SECTION_SCHEMA,
        plugins: PLUGIN_RESOURCE_SECTION_SCHEMA,
      },
    },
  },
});

const asText = (value: unknown): string => String(value == null ? '' : value).trim();

const readOptionalLimitArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 10) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be an integer between 1 and 10`
    );
  }
  return raw;
};

const ensureSystemGateway = (deps: OrchestrationDependencies) => {
  if (!deps.systemGateway) {
    throw createStructuredError(ErrorCode.OPERATION_FAILED, 'System gateway is not configured', {
      suggestion: 'Please inject systemGateway into orchestration dependencies',
    });
  }
  return deps.systemGateway;
};

const normalizeHealth = (
  snapshot: OrchestrationSystemHealthSnapshot
): OrchestrationSystemHealthSnapshot => ({
  ...snapshot,
  name: asText(snapshot.name),
  version: asText(snapshot.version),
  status: snapshot.status,
  activeSessions: Number(snapshot.activeSessions || 0),
  mcpSessions: Number(snapshot.mcpSessions || 0),
  orchestrationSessions: Number(snapshot.orchestrationSessions || 0),
  authEnabled: snapshot.authEnabled === true,
  mcpConfigured: snapshot.mcpConfigured === true,
  mcpEnabled: snapshot.mcpEnabled === true,
  mcpRequireAuth: snapshot.mcpRequireAuth === true,
  mcpProtocolCompatibilityMode: asText(snapshot.mcpProtocolCompatibilityMode),
  mcpProtocolVersion: asText(snapshot.mcpProtocolVersion),
  mcpSupportedProtocolVersions: Array.isArray(snapshot.mcpSupportedProtocolVersions)
    ? snapshot.mcpSupportedProtocolVersions.map((item) => asText(item)).filter(Boolean)
    : [],
  mcpSdkSupportedProtocolVersions: Array.isArray(snapshot.mcpSdkSupportedProtocolVersions)
    ? snapshot.mcpSdkSupportedProtocolVersions.map((item) => asText(item)).filter(Boolean)
    : [],
  enforceOrchestrationScopes: snapshot.enforceOrchestrationScopes === true,
  orchestrationIdempotencyStore:
    snapshot.orchestrationIdempotencyStore === 'duckdb' ? 'duckdb' : 'memory',
  queueDepth: snapshot.queueDepth || {},
  runtimeCounters: snapshot.runtimeCounters || {},
  sessionLeakRisk: snapshot.sessionLeakRisk || {},
  sessionCleanupPolicy: snapshot.sessionCleanupPolicy || {},
  processStartTime: snapshot.processStartTime || null,
  mainDistUpdatedAt: snapshot.mainDistUpdatedAt || null,
  rendererDistUpdatedAt: snapshot.rendererDistUpdatedAt || null,
  mainBuildStamp: snapshot.mainBuildStamp || null,
  mcpRuntimeFreshness: snapshot.mcpRuntimeFreshness || {},
  buildFreshness: snapshot.buildFreshness || {},
  gitCommit: snapshot.gitCommit || null,
  mcpSdk: snapshot.mcpSdk || {},
  runtimeAlerts: Array.isArray(snapshot.runtimeAlerts) ? snapshot.runtimeAlerts : [],
});

const takePreview = <T>(items: T[], limit: number): T[] => items.slice(0, limit);

const buildStaticBrowserEngines = () => ({
  total: 3,
  descriptors: {
    electron: getStaticEngineRuntimeDescriptor('electron'),
    extension: getStaticEngineRuntimeDescriptor('extension'),
    ruyi: getStaticEngineRuntimeDescriptor('ruyi'),
  },
});

const summarizeProfile = (profile: OrchestrationProfileInfo): Record<string, unknown> => ({
  id: profile.id,
  name: profile.name,
  engine: profile.engine,
  status: profile.status,
  ...(profile.partition ? { partition: profile.partition } : {}),
});

const summarizeDataset = (dataset: unknown): Record<string, unknown> => {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    return {
      value: dataset,
    };
  }

  const record = dataset as Record<string, unknown>;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.rowCount === 'number' ? { rowCount: record.rowCount } : {}),
    ...(typeof record.columnCount === 'number' ? { columnCount: record.columnCount } : {}),
    ...(typeof record.folderId === 'string' ? { folderId: record.folderId } : {}),
    ...(Object.keys(record).length === 0 ? { value: record } : {}),
  };
};

const resolveCapabilityFamily = (capabilityName: string): string => {
  if (capabilityName.startsWith('cross_plugin_')) return 'cross_plugin';
  if (capabilityName.startsWith('observation_')) return 'observation';
  if (capabilityName.startsWith('session_')) return 'session';
  if (capabilityName.startsWith('profile_')) return 'profile';
  if (capabilityName.startsWith('dataset_')) return 'dataset';
  if (capabilityName.startsWith('plugin_')) return 'plugin';
  if (capabilityName.startsWith('system_')) return 'system';
  if (capabilityName.startsWith('browser_')) return 'browser';
  return capabilityName.split('_')[0] || capabilityName;
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

const withSystemObservation = (
  event: string,
  handler: CapabilityHandler<OrchestrationDependencies>
): CapabilityHandler<OrchestrationDependencies> => {
  return async (args, deps, executionContext) => {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      source: currentTraceContext?.source ?? 'system-catalog',
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'system',
        event,
        attrs: {
          capability: executionContext?.capability || currentTraceContext?.capability || null,
          args: summarizeForObservation(args, 2),
        },
      });

      try {
        const result = await handler(args, deps, executionContext);
        await span.succeed({
          attrs: {
            capability: executionContext?.capability || currentTraceContext?.capability || null,
            data: summarizeForObservation(getStructuredData(result) || {}, 2),
          },
        });
        return result;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'system',
          label: `${event} failure context`,
          data: {
            capability: executionContext?.capability || currentTraceContext?.capability || null,
            args: summarizeForObservation(args, 2),
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            capability: executionContext?.capability || currentTraceContext?.capability || null,
          },
        });
        throw error;
      }
    });
  };
};

const systemGetHealthHandler: CapabilityHandler<OrchestrationDependencies> = async (_args, deps) => {
  const gateway = ensureSystemGateway(deps);
  const health = normalizeHealth(await gateway.getHealth());

  return createStructuredResult({
    summary: `Runtime health is ${health.status}. Active sessions=${health.activeSessions}, runtime alerts=${health.runtimeAlerts.length}.`,
    data: health as unknown as Record<string, unknown>,
    nextActionHints: [
      'Read runtimeAlerts first when status is degraded or error.',
      'Use system_bootstrap when you need the current public capability surface and resource summaries in one call.',
    ],
    recommendedNextTools: ['system_bootstrap'],
    authoritativeFields: [
      'structuredContent.data.status',
      'structuredContent.data.runtimeAlerts',
      'structuredContent.data.queueDepth',
    ],
  });
};

const systemBootstrapHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureSystemGateway(deps);
  const previewLimit = readOptionalLimitArg(args, 'previewLimit') ?? 5;
  const health = normalizeHealth(await gateway.getHealth());
  const publicCapabilities = Array.from(
    new Set(
      (await gateway.listPublicCapabilities())
        .map((item) => asText(item))
        .filter(Boolean)
    )
  ).sort();
  const capabilityFamilies = Array.from(
    new Set(publicCapabilities.map((item) => resolveCapabilityFamily(item)))
  ).sort();
  const browserEngines = buildStaticBrowserEngines();

  const profiles = deps.profileGateway
    ? await deps.profileGateway
        .listProfiles()
        .then((items) => ({
          available: true,
          total: items.length,
          preview: takePreview(items.map((item) => summarizeProfile(item)), previewLimit),
        }))
        .catch((error: unknown) => ({
          available: false,
          total: 0,
          preview: [],
          error: error instanceof Error ? error.message : String(error),
        }))
    : {
        available: false,
        total: 0,
        preview: [],
        error: 'profileGateway is not configured',
      };

  const datasets = deps.datasetGateway
    ? await deps.datasetGateway
        .listDatasets()
        .then((items) => ({
          available: true,
          total: items.length,
          preview: takePreview(items.map((item) => summarizeDataset(item)), previewLimit),
        }))
        .catch((error: unknown) => ({
          available: false,
          total: 0,
          preview: [],
          error: error instanceof Error ? error.message : String(error),
        }))
    : {
        available: false,
        total: 0,
        preview: [],
        error: 'datasetGateway is not configured',
      };

  const plugins = deps.pluginGateway
    ? await Promise.all([
        deps.pluginGateway.listPlugins(),
        deps.pluginGateway.listRuntimeStatuses(),
      ])
        .then(([pluginItems, runtimeItems]) => {
          const runtimeMap = new Map(runtimeItems.map((item) => [item.pluginId, item]));
          const preview = takePreview(
            pluginItems.map((plugin) => {
              const runtime = runtimeMap.get(plugin.id);
              return {
                id: plugin.id,
                name: plugin.name,
                version: plugin.version,
                enabled: plugin.enabled,
                sourceType: plugin.sourceType || null,
                lifecyclePhase: runtime?.lifecyclePhase || (plugin.enabled ? 'inactive' : 'disabled'),
                workState: runtime?.workState || 'idle',
                currentSummary: runtime?.currentSummary || null,
              };
            }),
            previewLimit
          );
          return {
            available: true,
            total: pluginItems.length,
            enabledCount: pluginItems.filter((item) => item.enabled !== false).length,
            busyCount: runtimeItems.filter((item) => item.workState === 'busy').length,
            errorCount: runtimeItems.filter((item) => item.workState === 'error').length,
            preview,
          };
        })
        .catch((error: unknown) => ({
          available: false,
          total: 0,
          enabledCount: 0,
          busyCount: 0,
          errorCount: 0,
          preview: [],
          error: error instanceof Error ? error.message : String(error),
        }))
    : {
        available: false,
        total: 0,
        enabledCount: 0,
        busyCount: 0,
        errorCount: 0,
        preview: [],
        error: 'pluginGateway is not configured',
      };

  const recommendedNextTools = Array.from(
    new Set(
      [
        health.status !== 'ok' ? 'system_get_health' : null,
        profiles.available ? 'profile_list' : null,
        plugins.available ? 'plugin_list' : null,
        publicCapabilities.includes('session_prepare') ? 'session_prepare' : null,
      ].filter((item): item is string => Boolean(item))
    )
  );

  return createStructuredResult({
    summary: [
      `Bootstrap captured with runtime health=${health.status}.`,
      `${publicCapabilities.length} public capability(s) across ${capabilityFamilies.length} family(ies).`,
      `${browserEngines.total} browser engine descriptor(s) available for pre-acquire planning.`,
      `Profiles=${profiles.total}, datasets=${datasets.total}, plugins=${plugins.total}.`,
    ].join(' '),
    data: {
      health,
      publicCapabilities,
      capabilityFamilies,
      browserEngines,
      resources: {
        profiles,
        datasets,
        plugins,
      },
    },
    nextActionHints: [
      'Read health.status and runtimeAlerts before deciding whether the runtime is safe to drive.',
      'Use publicCapabilities and capabilityFamilies to decide whether the next step is system, plugin, dataset, or browser work.',
      'Use browserEngines.descriptors before browser acquisition when you need to compare engine capability differences.',
      'Trust the resource preview counts before assuming profiles, datasets, or plugins exist in this runtime.',
    ],
    recommendedNextTools,
    authoritativeFields: [
      'structuredContent.data.health.status',
      'structuredContent.data.publicCapabilities',
      'structuredContent.data.browserEngines.descriptors',
      'structuredContent.data.resources',
    ],
  });
};

const SYSTEM_CAPABILITIES: Array<{
  key: string;
  definition: Omit<OrchestrationCapabilityDefinition, keyof CapabilityMetadata | 'version'>;
  handler: CapabilityHandler<OrchestrationDependencies>;
}> = [
  {
    key: 'system_get_health',
    definition: {
      name: 'system_get_health',
      description: 'Read the current runtime health snapshot that backs the HTTP /health endpoint.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      outputSchema: SYSTEM_GET_HEALTH_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'observation',
        whenToUse:
          'Use before deeper framework work when you need to confirm the runtime is healthy enough to continue.',
        preferredTargetKind: 'runtime',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['system_bootstrap'],
        examples: [{ title: 'Read runtime health', arguments: {} }],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: withSystemObservation('system.health', systemGetHealthHandler),
  },
  {
    key: 'system_bootstrap',
    definition: {
      name: 'system_bootstrap',
      description:
        'Read one compact framework bootstrap summary with runtime health, public capabilities, and resource previews.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          previewLimit: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
      outputSchema: SYSTEM_BOOTSTRAP_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'observation',
        whenToUse:
          'Use as the first framework-level call when the model needs one screen of runtime state before choosing browser, plugin, dataset, or profile work.',
        preferredTargetKind: 'runtime',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['system_get_health', 'profile_list', 'plugin_list', 'session_prepare'],
        examples: [{ title: 'Bootstrap the current runtime', arguments: {} }],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
        gettingStartedOrder: 5,
      },
    },
    handler: withSystemObservation('system.bootstrap', systemBootstrapHandler),
  },
];

export function createSystemCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    SYSTEM_CAPABILITIES.map((capability) => [
      capability.key,
      {
        definition: {
          ...capability.definition,
          title: toCapabilityTitle(capability.definition.name),
          annotations: buildCapabilityAnnotations(SYSTEM_READ_METADATA),
          version: SYSTEM_CAPABILITY_VERSION,
          ...SYSTEM_READ_METADATA,
        },
        handler: capability.handler,
      },
    ])
  );
}
