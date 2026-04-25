import { describe, expect, it } from 'vitest';
import type { OrchestrationCapabilityDefinition } from '../core/ai-dev/orchestration';
import {
  buildMcpRuntimeSessionContext,
  evaluateCapabilityRuntimeAvailability,
} from './mcp-http-runtime-availability';
import type { McpSessionInfo } from './mcp-http-types';

const createSession = (overrides: Partial<McpSessionInfo> = {}): McpSessionInfo => ({
  sessionId: ' session-1 ',
  transport: null as any,
  lastActivity: Date.now(),
  invokeQueue: Promise.resolve(),
  pendingInvocations: 0,
  activeInvocations: 0,
  maxQueueSize: 64,
  partition: undefined,
  engine: undefined,
  visible: false,
  authScopes: [],
  closing: false,
  terminateAfterResponse: false,
  ...overrides,
});

const createCapability = (
  overrides: Partial<OrchestrationCapabilityDefinition> = {}
): OrchestrationCapabilityDefinition => ({
  name: 'browser_snapshot',
  title: 'Snapshot',
  description: 'Capture page state.',
  version: '1.0.0',
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  idempotent: true,
  sideEffectLevel: 'none',
  retryPolicy: { retryable: true, maxAttempts: 1 },
  requiredScopes: ['browser.read'],
  requires: [],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  ...overrides,
});

describe('mcp http runtime availability', () => {
  it('builds normalized session context for catalog payloads', () => {
    const session = createSession({
      partition: ' profile-1 ',
      engine: 'extension',
      authScopes: ['browser.read'],
      closing: true,
      terminateAfterResponse: true,
    });

    expect(buildMcpRuntimeSessionContext(session)).toMatchObject({
      sessionId: 'session-1',
      profileId: 'profile-1',
      engine: 'extension',
      visible: false,
      browserAcquired: false,
      browserAcquireInProgress: false,
      effectiveScopes: ['browser.read'],
      closing: true,
      terminateAfterResponse: true,
      hostWindowId: null,
      viewportHealth: 'unknown',
      viewportHealthReason: null,
      interactionReady: false,
      offscreenDetected: false,
      resolvedRuntimeDescriptor: {
        engine: 'extension',
        capabilities: {
          'text.ocr': {
            supported: true,
          },
          'network.capture': {
            supported: true,
          },
        },
      },
    });
  });

  it('reports missing runtime dependencies as unavailable', () => {
    const capability = createCapability({
      name: 'dataset_query',
      requires: ['datasetGateway'],
    });

    const runtime = evaluateCapabilityRuntimeAvailability(
      capability,
      undefined,
      createSession({ authScopes: ['browser.read'] })
    );

    expect(runtime).toMatchObject({
      status: 'unavailable',
      availableNow: false,
      reasonCode: 'missing_runtime_dependency',
      missingRequirements: ['datasetGateway'],
      session: {
        profileId: null,
        effectiveScopes: ['browser.read'],
      },
    });
    expect(runtime.reason).toContain('dataset gateway');
  });

  it('reports missing observation gateway as unavailable', () => {
    const capability = createCapability({
      name: 'observation_get_trace_summary',
      requires: ['observationGateway'],
    });

    const runtime = evaluateCapabilityRuntimeAvailability(capability, {}, createSession());

    expect(runtime).toMatchObject({
      status: 'unavailable',
      availableNow: false,
      reasonCode: 'missing_runtime_dependency',
      missingRequirements: ['observationGateway'],
    });
    expect(runtime.reason).toContain('observation gateway');
  });

  it('reports missing system gateway as unavailable', () => {
    const runtime = evaluateCapabilityRuntimeAvailability(
      createCapability({
        name: 'system_get_health',
        requires: ['systemGateway'],
      }),
      {},
      createSession()
    );

    expect(runtime).toMatchObject({
      status: 'unavailable',
      availableNow: false,
      reasonCode: 'missing_runtime_dependency',
      missingRequirements: ['systemGateway'],
    });
    expect(runtime.reason).toContain('system gateway');
  });

  it('reports missing plugin gateway as unavailable', () => {
    const runtime = evaluateCapabilityRuntimeAvailability(
      createCapability({
        name: 'plugin_list',
        requires: ['pluginGateway'],
      }),
      {},
      createSession()
    );

    expect(runtime).toMatchObject({
      status: 'unavailable',
      availableNow: false,
      reasonCode: 'missing_runtime_dependency',
      missingRequirements: ['pluginGateway'],
    });
    expect(runtime.reason).toContain('plugin gateway');
  });

  it('reports unsupported browser features from the active session', () => {
    const capability = createCapability({
      name: 'browser_console_get',
      requires: ['browser', 'browserCapability:network.responseBody'],
    });
    const session = createSession({
      engine: 'electron',
      browserHandle: {
        browser: {
          describeRuntime: () => ({
            engine: 'electron',
            profileMode: 'ephemeral',
            visibilityMode: 'embedded-view',
            capabilities: {
              ...Object.fromEntries(
                [
                  'cookies.read',
                  'cookies.write',
                  'cookies.clear',
                  'cookies.filter',
                  'userAgent.read',
                  'snapshot.page',
                  'screenshot.detailed',
                  'window.showHide',
                  'window.openPolicy',
                  'input.native',
                  'text.dom',
                  'text.ocr',
                  'network.capture',
                  'console.capture',
                  'intercept.observe',
                  'intercept.control',
                ].map((name) => [
                  name,
                  { supported: true, stability: 'stable', source: 'runtime' as const },
                ])
              ),
              'network.responseBody': {
                supported: false,
                stability: 'planned',
                source: 'runtime' as const,
              },
              'download.manage': {
                supported: false,
                stability: 'planned',
                source: 'runtime' as const,
              },
              'storage.dom': {
                supported: false,
                stability: 'planned',
                source: 'runtime' as const,
              },
              'dialog.basic': {
                supported: false,
                stability: 'planned',
                source: 'runtime' as const,
              },
              'dialog.promptText': {
                supported: false,
                stability: 'planned',
                source: 'runtime' as const,
              },
              'tabs.manage': {
                supported: false,
                stability: 'planned',
                source: 'runtime' as const,
              },
            },
          }),
        },
      } as any,
    });

    const runtime = evaluateCapabilityRuntimeAvailability(capability, {}, session);

    expect(runtime).toMatchObject({
      status: 'unavailable',
      reasonCode: 'unsupported_browser_features',
      unsupportedRequirements: ['browserCapability:network.responseBody'],
      session: {
        resolvedRuntimeDescriptor: {
          capabilities: {
            'network.capture': {
              supported: true,
            },
            'network.responseBody': {
              supported: false,
            },
          },
        },
      },
    });
  });

  it('keeps browser tools available with a notice before first acquire', () => {
    const runtime = evaluateCapabilityRuntimeAvailability(
      createCapability({ name: 'browser_observe', requires: ['browser'] }),
      {},
      createSession()
    );

    expect(runtime).toMatchObject({
      status: 'available_with_notice',
      reasonCode: 'fresh_browser_without_bound_profile',
      availableNow: true,
      session: {
        profileId: null,
      },
    });
  });

  it('keeps session_prepare available without profileGateway when query-less preparation is still valid', () => {
    const runtime = evaluateCapabilityRuntimeAvailability(
      createCapability({
        name: 'session_prepare',
        requires: ['mcpSessionGateway'],
      }),
      {},
      createSession()
    );

    expect(runtime).toMatchObject({
      status: 'available_with_notice',
      availableNow: true,
      reasonCode: 'profile_query_requires_profile_gateway',
    });
    expect(runtime.preconditionsNow).toEqual(
      expect.arrayContaining([expect.stringContaining('profile gateway')])
    );
    expect(runtime.recommendedActions).toEqual(
      expect.arrayContaining([expect.stringContaining('without query')])
    );
  });

  it('marks closing sessions as unavailable for browser tools', () => {
    const runtime = evaluateCapabilityRuntimeAvailability(
      createCapability({ name: 'browser_observe', requires: ['browser'] }),
      {},
      createSession({
        closing: true,
        terminateAfterResponse: true,
      })
    );

    expect(runtime).toMatchObject({
      status: 'unavailable',
      availableNow: false,
      reasonCode: 'session_closing',
    });
  });
});
