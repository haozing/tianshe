import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import type { OrchestrationCapabilityDefinition, OrchestrationDependencies } from '../orchestration/types';
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

const OBSERVATION_CAPABILITY_VERSION = '1.0.0';

const OBSERVATION_READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 200,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['observation.read'],
  requires: ['observationGateway'],
};

const RUNTIME_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['message'],
  properties: {
    name: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    stack: { type: 'string' },
    details: {},
  },
} as const;

const RUNTIME_EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['eventId', 'timestamp', 'traceId', 'level', 'event', 'component'],
  properties: {
    eventId: { type: 'string' },
    timestamp: { type: 'number' },
    traceId: { type: 'string' },
    spanId: { type: 'string' },
    parentSpanId: { type: 'string' },
    level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
    event: { type: 'string' },
    outcome: {
      type: 'string',
      enum: ['started', 'succeeded', 'failed', 'blocked', 'timeout', 'cancelled'],
    },
    component: { type: 'string' },
    message: { type: 'string' },
    durationMs: { type: 'number' },
    source: { type: 'string' },
    capability: { type: 'string' },
    pluginId: { type: 'string' },
    browserEngine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
    sessionId: { type: 'string' },
    profileId: { type: 'string' },
    datasetId: { type: 'string' },
    browserId: { type: 'string' },
    attrs: { type: 'object', additionalProperties: true },
    error: RUNTIME_ERROR_SCHEMA,
    artifactRefs: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

const RUNTIME_ARTIFACT_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['artifactId', 'type', 'timestamp'],
  properties: {
    artifactId: { type: 'string' },
    type: {
      type: 'string',
      enum: ['snapshot', 'console_tail', 'network_summary', 'screenshot', 'error_context'],
    },
    label: { type: 'string' },
    timestamp: { type: 'number' },
  },
} as const;

const TRACE_ENTITIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    capability: { type: 'string' },
    pluginId: { type: 'string' },
    browserEngine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
    sessionId: { type: 'string' },
    profileId: { type: 'string' },
    datasetId: { type: 'string' },
    browserId: { type: 'string' },
    source: { type: 'string' },
  },
} as const;

const TRACE_SUMMARY_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['traceId', 'eventCount', 'artifactCount', 'finalStatus', 'entities', 'recentArtifacts'],
  properties: {
    traceId: { type: 'string' },
    eventCount: { type: 'number' },
    artifactCount: { type: 'number' },
    startedAt: { type: 'number' },
    finishedAt: { type: 'number' },
    finalStatus: {
      type: 'string',
      enum: ['succeeded', 'failed', 'in_progress', 'blocked', 'unknown'],
    },
    rootEvent: RUNTIME_EVENT_SCHEMA,
    lastEvent: RUNTIME_EVENT_SCHEMA,
    firstFailure: RUNTIME_EVENT_SCHEMA,
    entities: TRACE_ENTITIES_SCHEMA,
    recentArtifacts: {
      type: 'array',
      items: RUNTIME_ARTIFACT_REF_SCHEMA,
    },
  },
});

const FAILURE_BUNDLE_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['traceId', 'recentEvents', 'artifactRefs'],
  properties: {
    traceId: { type: 'string' },
    error: RUNTIME_ERROR_SCHEMA,
    failedEvent: RUNTIME_EVENT_SCHEMA,
    recentEvents: createArrayItemsSchema(RUNTIME_EVENT_SCHEMA),
    artifactRefs: createArrayItemsSchema(RUNTIME_ARTIFACT_REF_SCHEMA),
    snapshot: createOpaqueOutputSchema('Snapshot artifact payload'),
    screenshot: createOpaqueOutputSchema('Screenshot artifact payload'),
    consoleTail: createOpaqueOutputSchema('Console tail artifact payload'),
    networkSummary: createOpaqueOutputSchema('Network summary artifact payload'),
    errorContext: createOpaqueOutputSchema('Non-browser error context artifact payload'),
  },
});

const TRACE_TIMELINE_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['traceId', 'finalStatus', 'events', 'artifactRefs'],
  properties: {
    traceId: { type: 'string' },
    finalStatus: {
      type: 'string',
      enum: ['succeeded', 'failed', 'in_progress', 'blocked', 'unknown'],
    },
    events: createArrayItemsSchema(RUNTIME_EVENT_SCHEMA),
    artifactRefs: createArrayItemsSchema(RUNTIME_ARTIFACT_REF_SCHEMA),
  },
});

const RECENT_FAILURE_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'traceId',
    'failedAt',
    'eventId',
    'event',
    'component',
    'finalStatus',
    'artifactCount',
  ],
  properties: {
    traceId: { type: 'string' },
    failedAt: { type: 'number' },
    eventId: { type: 'string' },
    event: { type: 'string' },
    component: { type: 'string' },
    message: { type: 'string' },
    capability: { type: 'string' },
    pluginId: { type: 'string' },
    sessionId: { type: 'string' },
    profileId: { type: 'string' },
    datasetId: { type: 'string' },
    browserId: { type: 'string' },
    browserEngine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
    error: RUNTIME_ERROR_SCHEMA,
    finalStatus: {
      type: 'string',
      enum: ['succeeded', 'failed', 'in_progress', 'blocked', 'unknown'],
    },
    artifactCount: { type: 'number' },
  },
} as const;

const RECENT_FAILURES_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['total', 'failures'],
  properties: {
    total: { type: 'number' },
    failures: createArrayItemsSchema(RECENT_FAILURE_SUMMARY_SCHEMA),
  },
});

const readStringArg = (args: Record<string, unknown>, key: string): string => {
  const raw = args[key];
  if (typeof raw !== 'string') {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be string`);
  }
  const value = raw.trim();
  if (!value) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} cannot be empty`);
  }
  return value;
};

const readOptionalLimitArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 200) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be an integer between 1 and 200`
    );
  }
  return raw;
};

const ensureObservationGateway = (deps: OrchestrationDependencies) => {
  if (!deps.observationGateway) {
    throw createStructuredError(ErrorCode.OPERATION_FAILED, 'Observation gateway is not configured', {
      suggestion: 'Please inject observationGateway into orchestration dependencies',
    });
  }
  return deps.observationGateway;
};

const traceSummaryHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureObservationGateway(deps);
  const traceId = readStringArg(args, 'traceId');
  const summary = await gateway.getTraceSummary(traceId);
  const hasTraceData = summary.eventCount > 0 || summary.artifactCount > 0;

  return createStructuredResult({
    summary: hasTraceData
      ? `Trace ${traceId} is ${summary.finalStatus} with ${summary.eventCount} event(s) and ${summary.artifactCount} artifact(s).`
      : `No runtime events or artifacts were recorded for trace ${traceId}.`,
    data: summary as unknown as Record<string, unknown>,
    nextActionHints: hasTraceData
      ? [
          'Use observation_get_failure_bundle when you need the recent failure events and attached evidence for this trace.',
          'Trust finalStatus, firstFailure, and recentArtifacts before scanning raw runtime logs.',
        ]
      : [
          'Verify that traceId came from the same runtime instance and recent orchestration invoke response.',
        ],
    recommendedNextTools:
      summary.finalStatus === 'failed' || summary.finalStatus === 'blocked' || summary.firstFailure
        ? ['observation_get_failure_bundle']
        : [],
    authoritativeFields: [
      'structuredContent.data.traceId',
      'structuredContent.data.finalStatus',
      'structuredContent.data.firstFailure',
    ],
  });
};

const failureBundleHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureObservationGateway(deps);
  const traceId = readStringArg(args, 'traceId');
  const bundle = await gateway.getFailureBundle(traceId);
  const hasFailure = Boolean(bundle.failedEvent || bundle.error);

  return createStructuredResult({
    summary: hasFailure
      ? `Failure bundle collected for trace ${traceId} with ${bundle.recentEvents.length} recent event(s) and ${bundle.artifactRefs.length} artifact reference(s).`
      : `No failed event was recorded for trace ${traceId}; returning recent events and artifacts only.`,
    data: bundle as unknown as Record<string, unknown>,
    nextActionHints: [
      'Inspect failedEvent and recentEvents first to reconstruct the failing edge of the trace.',
      'Use snapshot, screenshot, consoleTail, and networkSummary when the failure depends on page evidence.',
    ],
    recommendedNextTools: ['observation_get_trace_summary'],
    authoritativeFields: [
      'structuredContent.data.traceId',
      'structuredContent.data.failedEvent',
      'structuredContent.data.artifactRefs',
    ],
  });
};

const traceTimelineHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureObservationGateway(deps);
  const traceId = readStringArg(args, 'traceId');
  const limit = readOptionalLimitArg(args, 'limit');
  const timeline = await gateway.getTraceTimeline(traceId, limit);

  return createStructuredResult({
    summary: `Trace ${traceId} timeline loaded with ${timeline.events.length} event(s) and ${timeline.artifactRefs.length} artifact reference(s).`,
    data: timeline as unknown as Record<string, unknown>,
    nextActionHints: [
      'Use this when you need the ordered event chain instead of only the first failure or final status.',
      'Use observation_get_failure_bundle when the trace failed and you need attached evidence next.',
    ],
    recommendedNextTools:
      timeline.finalStatus === 'failed' || timeline.finalStatus === 'blocked'
        ? ['observation_get_failure_bundle']
        : ['observation_get_trace_summary'],
    authoritativeFields: [
      'structuredContent.data.traceId',
      'structuredContent.data.finalStatus',
      'structuredContent.data.events',
    ],
  });
};

const recentFailuresHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureObservationGateway(deps);
  const limit = readOptionalLimitArg(args, 'limit') ?? 20;
  const failures = await gateway.searchRecentFailures(limit);

  return createStructuredResult({
    summary: failures.length
      ? `Loaded ${failures.length} recent failing trace(s).`
      : 'No recent failing traces were recorded in this runtime.',
    data: {
      total: failures.length,
      failures,
    },
    nextActionHints: [
      'Use traceId from one failure entry with observation_get_trace_summary for a compact diagnosis path.',
      'Use observation_get_failure_bundle when one failure needs attached evidence next.',
    ],
    recommendedNextTools: failures.length
      ? ['observation_get_trace_summary', 'observation_get_failure_bundle']
      : [],
    authoritativeFields: [
      'structuredContent.data.failures[*].traceId',
      'structuredContent.data.failures[*].finalStatus',
    ],
  });
};

const OBSERVATION_CAPABILITIES: Array<{
  key: string;
  definition: Omit<OrchestrationCapabilityDefinition, keyof CapabilityMetadata | 'version'>;
  handler: CapabilityHandler<OrchestrationDependencies>;
}> = [
  {
    key: 'observation_get_trace_summary',
    definition: {
      name: 'observation_get_trace_summary',
      description: 'Read a compact runtime summary for one traceId after framework or browser work.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['traceId'],
        properties: {
          traceId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: TRACE_SUMMARY_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'observation',
        whenToUse:
          'Use after a capability call when you need the final trace status, first failure, and related entities without scanning raw runtime logs.',
        avoidWhen:
          'Avoid when you only need the recent failure evidence bundle and already know the trace failed.',
        preferredTargetKind: 'trace_id',
        transportEffect: 'Read-only; does not mutate runtime state.',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['observation_get_failure_bundle'],
        examples: [
          {
            title: 'Summarize one failed trace',
            arguments: {
              traceId: 'trace-123',
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
        pageDebugOrder: 5,
      },
    },
    handler: traceSummaryHandler,
  },
  {
    key: 'observation_get_failure_bundle',
    definition: {
      name: 'observation_get_failure_bundle',
      description: 'Read recent failing events and attached evidence for one traceId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['traceId'],
        properties: {
          traceId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: FAILURE_BUNDLE_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'observation',
        whenToUse:
          'Use after a failed or blocked capability call when you need recent events plus the minimal attached failure evidence.',
        avoidWhen:
          'Avoid when the trace only needs a high-level status check and no failure evidence has been recorded.',
        preferredTargetKind: 'trace_id',
        transportEffect: 'Read-only; does not mutate runtime state.',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['observation_get_trace_summary'],
        examples: [
          {
            title: 'Inspect one failing trace bundle',
            arguments: {
              traceId: 'trace-123',
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
        pageDebugOrder: 10,
      },
    },
    handler: failureBundleHandler,
  },
  {
    key: 'observation_get_trace_timeline',
    definition: {
      name: 'observation_get_trace_timeline',
      description: 'Read the ordered runtime event chain for one traceId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['traceId'],
        properties: {
          traceId: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
      outputSchema: TRACE_TIMELINE_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'observation',
        whenToUse:
          'Use when the model needs the ordered event chain for one trace instead of only the first failure summary.',
        preferredTargetKind: 'trace_id',
        transportEffect: 'Read-only; does not mutate runtime state.',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['observation_get_failure_bundle', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Read one trace timeline',
            arguments: {
              traceId: 'trace-123',
              limit: 50,
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: traceTimelineHandler,
  },
  {
    key: 'observation_search_recent_failures',
    definition: {
      name: 'observation_search_recent_failures',
      description: 'List recent failing traces with compact context and artifact counts.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
      outputSchema: RECENT_FAILURES_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'observation',
        whenToUse:
          'Use when the model needs to discover recent failures before drilling into one trace by traceId.',
        preferredTargetKind: 'runtime',
        transportEffect: 'Read-only; does not mutate runtime state.',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['observation_get_trace_summary', 'observation_get_failure_bundle'],
        examples: [
          {
            title: 'List recent failures',
            arguments: {
              limit: 10,
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: recentFailuresHandler,
  },
];

export function createObservationCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    OBSERVATION_CAPABILITIES.map((capability) => [
      capability.key,
      {
        definition: {
          ...capability.definition,
          title: toCapabilityTitle(capability.definition.name),
          annotations: buildCapabilityAnnotations(OBSERVATION_READ_METADATA),
          version: OBSERVATION_CAPABILITY_VERSION,
          ...OBSERVATION_READ_METADATA,
        },
        handler: capability.handler,
      },
    ])
  );
}
