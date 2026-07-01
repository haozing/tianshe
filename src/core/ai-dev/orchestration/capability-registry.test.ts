import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, createStructuredError } from '../../../types/error-codes';
import type { BrowserInterface } from '../../../types/browser-interface';
import { setObservationSink } from '../../observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../../observability/types';
import {
  __setOrchestrationCapabilityCatalogForTests,
  createOrchestrationCapabilityRegistry,
  createOrchestrationExecutor,
  listOrchestrationCapabilities,
} from './capability-registry';
import {
  __resetCapabilityConfirmationGrantsForTests,
  createCapabilityConfirmationGrant,
} from './confirmation';
import { __resetCapabilitySchemaValidatorCacheForTests } from './schema-validation';
import type { RegisteredCapability } from '../capabilities';
import { createBuiltInCapabilityProvider, createUnifiedCapabilityCatalog } from '../capabilities';

class MemoryObservationSink implements ObservationSink {
  events: RuntimeEvent[] = [];
  artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

function createSnapshot() {
  return {
    url: 'https://example.com',
    title: 'Example',
    elements: [],
  };
}

function createMockBrowser(overrides: Partial<BrowserInterface> = {}): BrowserInterface {
  return {
    goto: vi.fn(),
    snapshot: vi.fn().mockResolvedValue(createSnapshot()),
    click: vi.fn(),
    type: vi.fn(),
    evaluate: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
    getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
    ...overrides,
  } as BrowserInterface;
}

function createCompatExecutor(
  deps: Parameters<typeof createOrchestrationExecutor>[0]
): ReturnType<typeof createOrchestrationExecutor> {
  return createOrchestrationExecutor({ enforceScopes: false, ...deps });
}

function createTestGrant(
  capabilityName: string,
  args: Record<string, unknown>,
  options: {
    scopes?: string[];
    sessionId?: string;
    principal?: string;
    grantId?: string;
    invocationId?: string;
    expiresAt?: string;
    idempotencyKey?: string;
    now?: () => number;
  } = {}
) {
  const definition = createUnifiedCapabilityCatalog()[capabilityName]?.definition;
  if (!definition) {
    throw new Error(`Missing definition for ${capabilityName}`);
  }
  return createCapabilityConfirmationGrant({
    definition,
    arguments: args,
    grantId: options.grantId || `grant-${capabilityName}`,
    invocationId: options.invocationId || `invoke-${capabilityName}`,
    principal: options.principal || 'test-principal',
    source: 'agent-ui',
    sessionId: options.sessionId || 'test-session',
    scopes: options.scopes || [],
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    now: options.now || Date.now,
  });
}

const createTestCapability = (
  name: string,
  overrides: Partial<RegisteredCapability['definition']> = {},
  handler = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: {
      ok: true,
      data: { accepted: true },
    },
  })
): RegisteredCapability => ({
  definition: {
    name,
    version: '1.0.0',
    description: `${name} test capability`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      additionalProperties: true,
    },
    assistantSurface: { publicMcp: true },
    requiredScopes: ['test.scope'],
    requires: [],
    idempotent: true,
    retryPolicy: { retryable: false, maxAttempts: 1 },
    sideEffectLevel: 'none',
    ...overrides,
  },
  handler,
});

describe('orchestration capability registry', () => {
  afterEach(() => {
    setObservationSink(null);
    __resetCapabilitySchemaValidatorCacheForTests();
    __resetCapabilityConfirmationGrantsForTests();
  });

  it('exposes the public assistant-facing capability surface plus observation reads', () => {
    const names = listOrchestrationCapabilities()
      .map((capability) => capability.name)
      .sort();

    expect(names).toEqual(
      [
        'browser_act',
        'browser_debug_state',
        'browser_observe',
        'browser_search',
        'browser_snapshot',
        'browser_wait_for',
        'books_to_scrape.extract_product',
        'books_to_scrape.prepare_search_draft',
        'dataset_create_empty',
        'dataset_commit_write_plan',
        'dataset_delete',
        'dataset_get_record_provenance',
        'dataset_import_file',
        'dataset_rename',
        'dataset_stage_write_plan',
        'github.create_issue',
        'github.extract_profile_summary',
        'github.prepare_issue_draft',
        'hacker_news.extract_story_list',
        'npm.extract_package_summary',
        'observation_get_failure_bundle',
        'observation_get_trace_timeline',
        'observation_get_trace_summary',
        'observation_search_recent_failures',
        'open_library.extract_search_results',
        'open_library.prepare_search_draft',
        'plugin_install',
        'plugin_reload',
        'plugin_get_runtime_status',
        'plugin_list',
        'plugin_uninstall',
        'profile_create',
        'profile_delete',
        'profile_ensure_logged_in',
        'profile_list',
        'profile_resolve',
        'profile_update',
        'quotes_to_scrape.extract_quote_list',
        'runtime_plan',
        'system_bootstrap',
        'system_get_health',
        'session_end_current',
        'session_get_current',
        'session_prepare',
        'site_capability_list',
        'wikipedia.extract_article_summary',
      ].sort()
    );
  });

  it('keeps public capability metadata complete and stable', () => {
    const capabilities = listOrchestrationCapabilities();
    const semverPattern = /^\d+\.\d+\.\d+$/;

    for (const capability of capabilities) {
      expect(capability.name).toBeTruthy();
      expect(semverPattern.test(capability.version)).toBe(true);
      expect(capability.description).toBeTruthy();
      expect(capability.inputSchema).toBeDefined();
      expect(capability.outputSchema).toBeDefined();
      expect(capability.retryPolicy).toBeDefined();
      expect(Number.isFinite(capability.retryPolicy?.maxAttempts)).toBe(true);
      expect((capability.retryPolicy?.maxAttempts ?? 0) >= 1).toBe(true);
      expect(Array.isArray(capability.requiredScopes)).toBe(true);
      expect((capability.requiredScopes || []).length).toBeGreaterThan(0);
      expect(Array.isArray(capability.requires ?? [])).toBe(true);
      expect(capability.sideEffectLevel).toBeDefined();
      expect(capability.idempotent === true || capability.idempotent === false).toBe(true);
      expect(capability.assistantSurface?.publicMcp).toBe(true);
      expect(['canonical', 'advanced']).toContain(capability.assistantSurface?.surfaceTier);
    }
  });

  it('executor only reports canonical capabilities as available', () => {
    const executor = createCompatExecutor({});
    for (const capability of listOrchestrationCapabilities()) {
      expect(executor.hasCapability(capability.name)).toBe(true);
    }

    expect(executor.hasCapability('browser_get_url')).toBe(false);
    expect(executor.hasCapability('dataset_list')).toBe(false);
    expect(executor.hasCapability('session_close')).toBe(false);
  });

  it('creates provider-backed registry instances without relying on module static snapshots', async () => {
    let dynamicCatalog: Record<string, RegisteredCapability> = {};
    const listenerSet = new Set<() => void>();
    const dynamicProvider = {
      id: 'dynamic-test',
      listCapabilities: () => dynamicCatalog,
      subscribe: (listener: () => void) => {
        listenerSet.add(listener);
        return () => listenerSet.delete(listener);
      },
    };
    const registry = createOrchestrationCapabilityRegistry({
      additionalProviders: [dynamicProvider],
    });

    expect(registry.hasCapability('dynamic_test_capability')).toBe(false);

    dynamicCatalog = {
      dynamic_test_capability: createTestCapability('dynamic_test_capability'),
    };
    for (const listener of listenerSet) listener();

    expect(registry.hasCapability('dynamic_test_capability')).toBe(true);
    expect(registry.listCapabilities().map((capability) => capability.name)).toContain(
      'dynamic_test_capability'
    );

    const executor = createOrchestrationExecutor({ enforceScopes: false }, { registry });
    const result = await executor.invokeApi({
      name: 'dynamic_test_capability',
      arguments: {},
    });
    expect(result.ok).toBe(true);
  });

  it('can expose a full registry view for governance snapshots while public executor view stays filtered', () => {
    const fullRegistry = createOrchestrationCapabilityRegistry({
      providers: [createBuiltInCapabilityProvider()],
      view: 'all',
    });
    const fullNames = fullRegistry.listCapabilities().map((capability) => capability.name);
    const publicNames = listOrchestrationCapabilities().map((capability) => capability.name);

    expect(fullNames).toContain('cross_plugin_call_api');
    expect(publicNames).not.toContain('cross_plugin_call_api');
    expect(fullNames.length).toBeGreaterThan(publicNames.length);
  });

  it('rejects new high-risk invocations when executor registry generation is stale', async () => {
    let dynamicCatalog: Record<string, RegisteredCapability> = {
      stale_high_risk: createTestCapability('stale_high_risk', {
        sideEffectLevel: 'high',
        requiredScopes: ['danger.write'],
      }),
    };
    const listenerSet = new Set<() => void>();
    const dynamicProvider = {
      id: 'stale-test',
      listCapabilities: () => dynamicCatalog,
      subscribe: (listener: () => void) => {
        listenerSet.add(listener);
        return () => listenerSet.delete(listener);
      },
    };
    const registry = createOrchestrationCapabilityRegistry({
      providers: [dynamicProvider],
    });
    const executor = createOrchestrationExecutor({ enforceScopes: false }, { registry });

    dynamicCatalog = {
      stale_high_risk: createTestCapability('stale_high_risk', {
        sideEffectLevel: 'high',
        requiredScopes: ['danger.write'],
        description: 'Updated stale high risk capability',
      }),
    };
    for (const listener of listenerSet) listener();

    const grant = createCapabilityConfirmationGrant({
      definition: registry.getSnapshot().definitionsByName.stale_high_risk,
      arguments: {},
      grantId: 'grant-stale-high-risk',
      invocationId: 'invoke-stale-high-risk',
      principal: 'test-principal',
      source: 'agent-ui',
      sessionId: 'test-session',
      scopes: ['danger.write'],
    });
    const result = await executor.invokeApi({
      name: 'stale_high_risk',
      arguments: {},
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['danger.write'],
        confirmationGrant: grant,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: ErrorCode.REQUEST_FAILED,
      reasonCode: 'capability_registry_generation_stale',
    });
  });

  it('allows long-lived executors to recover high-risk calls after catalog refresh', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    });
    let dynamicCatalog: Record<string, RegisteredCapability> = {
      refreshed_high_risk: createTestCapability(
        'refreshed_high_risk',
        {
          sideEffectLevel: 'high',
          requiredScopes: ['danger.write'],
        },
        handler
      ),
    };
    const listenerSet = new Set<() => void>();
    const registry = createOrchestrationCapabilityRegistry({
      providers: [
        {
          id: 'refresh-test',
          listCapabilities: () => dynamicCatalog,
          subscribe: (listener: () => void) => {
            listenerSet.add(listener);
            return () => listenerSet.delete(listener);
          },
        },
      ],
    });
    const executor = createOrchestrationExecutor({ enforceScopes: false }, { registry });

    dynamicCatalog = {
      refreshed_high_risk: createTestCapability(
        'refreshed_high_risk',
        {
          sideEffectLevel: 'high',
          requiredScopes: ['danger.write'],
          description: 'Refreshed high-risk capability',
        },
        handler
      ),
    };
    for (const listener of listenerSet) listener();

    expect(executor.listCapabilities().map((capability) => capability.name)).toContain(
      'refreshed_high_risk'
    );
    const grant = createCapabilityConfirmationGrant({
      definition: registry.getSnapshot().definitionsByName.refreshed_high_risk,
      arguments: {},
      grantId: 'grant-refreshed-high-risk',
      invocationId: 'invoke-refreshed-high-risk',
      principal: 'test-principal',
      source: 'agent-ui',
      sessionId: 'test-session',
      scopes: ['danger.write'],
    });
    const result = await executor.invokeApi({
      name: 'refreshed_high_risk',
      arguments: {},
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['danger.write'],
        confirmationGrant: grant,
      },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it('validates input schema before invoking a capability handler without echoing argument values', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        ok: true,
        summary: 'ok',
        data: { accepted: true },
        truncated: false,
        nextActionHints: [],
        recommendedNextTools: [],
        authoritativeFields: [],
        reasonCode: null,
        retryable: false,
      },
    });
    const restore = __setOrchestrationCapabilityCatalogForTests({
      schema_guarded: {
        definition: {
          name: 'schema_guarded',
          version: '1.2.3',
          description: 'Schema guarded test capability',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: { type: 'string' },
            },
          },
          outputSchema: {
            type: 'object',
            additionalProperties: true,
          },
          assistantSurface: { publicMcp: true },
          requiredScopes: [],
          requires: [],
          idempotent: true,
          retryPolicy: { retryable: false, maxAttempts: 1 },
          sideEffectLevel: 'none',
        },
        handler,
      } satisfies RegisteredCapability,
    });

    try {
      const executor = createCompatExecutor({});
      const result = await executor.invokeApi({
        name: 'schema_guarded',
        arguments: {
          id: 123,
          token: 'super-secret-token',
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        reasonCode: 'capability_input_schema_validation_failed',
        context: {
          capability: 'schema_guarded',
          phase: 'input',
          errors: expect.arrayContaining([
            expect.objectContaining({
              path: '/id',
              keyword: 'type',
            }),
            expect.objectContaining({
              keyword: 'additionalProperties',
            }),
          ]),
        },
      });
      expect(JSON.stringify(result)).not.toContain('super-secret-token');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('validates structured output schema and keeps text-only capability results compatible', async () => {
    const invalidStructuredHandler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'invalid' }],
      structuredContent: {
        ok: true,
        summary: 'invalid',
        data: { count: 'not-a-number' },
        truncated: false,
        nextActionHints: [],
        recommendedNextTools: [],
        authoritativeFields: [],
        reasonCode: null,
        retryable: false,
      },
    });
    const textOnlyHandler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'legacy text only' }],
    });
    const restore = __setOrchestrationCapabilityCatalogForTests({
      invalid_structured_output: {
        definition: {
          name: 'invalid_structured_output',
          version: '1.0.0',
          description: 'Invalid structured output test capability',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
          outputSchema: {
            type: 'object',
            additionalProperties: true,
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['count'],
                properties: {
                  count: { type: 'number' },
                },
              },
            },
          },
          assistantSurface: { publicMcp: true },
          requiredScopes: [],
          requires: [],
          idempotent: true,
          retryPolicy: { retryable: false, maxAttempts: 1 },
          sideEffectLevel: 'none',
        },
        handler: invalidStructuredHandler,
      } satisfies RegisteredCapability,
      text_only_output: {
        definition: {
          name: 'text_only_output',
          version: '1.0.0',
          description: 'Text-only output compatibility test capability',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: { type: 'object' },
            },
          },
          assistantSurface: { publicMcp: true },
          requiredScopes: [],
          requires: [],
          idempotent: true,
          retryPolicy: { retryable: false, maxAttempts: 1 },
          sideEffectLevel: 'none',
        },
        handler: textOnlyHandler,
      } satisfies RegisteredCapability,
    });

    try {
      const executor = createCompatExecutor({});
      const invalidResult = await executor.invokeApi({
        name: 'invalid_structured_output',
        arguments: {},
      });
      expect(invalidResult.ok).toBe(false);
      expect(invalidResult.error).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        reasonCode: 'capability_output_schema_validation_failed',
        context: {
          capability: 'invalid_structured_output',
          phase: 'output',
          errors: expect.arrayContaining([
            expect.objectContaining({
              path: '/data/count',
              keyword: 'type',
            }),
          ]),
        },
      });
      expect(invalidStructuredHandler).toHaveBeenCalledTimes(1);

      const textOnlyResult = await executor.invokeApi({
        name: 'text_only_output',
        arguments: {},
      });
      expect(textOnlyResult.ok).toBe(true);
      expect(textOnlyResult.output.text).toEqual(['legacy text only']);
      expect(textOnlyHandler).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('requires a valid confirmation grant for high-risk capabilities before invoking handlers', async () => {
    const installPlugin = vi.fn().mockResolvedValue({
      pluginId: 'plugin-a',
      operation: 'installed',
      sourceType: 'cloud_code',
    });
    const executor = createCompatExecutor({
      pluginGateway: {
        listPlugins: async () => [],
        getPlugin: async () => null,
        listRuntimeStatuses: async () => [],
        getRuntimeStatus: async () => null,
        installPlugin,
        reloadPlugin: async () => undefined,
        uninstallPlugin: async () => undefined,
      },
    });
    const args = {
      sourceType: 'cloud_code',
      cloudPluginCode: 'plugin_a',
    };

    const denied = await executor.invokeApi({
      name: 'plugin_install',
      arguments: args,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['plugin.write'],
      },
    });

    expect(denied.ok).toBe(false);
    expect(denied.error).toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      reasonCode: 'capability_confirmation_required',
      context: {
        reason: 'missing_or_invalid_grant',
      },
    });
    expect(denied._meta?.confirmationDecision).toMatchObject({
      required: true,
      status: 'rejected',
      reason: 'missing_or_invalid_grant',
    });
    expect(installPlugin).not.toHaveBeenCalled();

    const granted = await executor.invokeApi({
      name: 'plugin_install',
      arguments: args,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['plugin.write'],
        confirmationGrant: createTestGrant('plugin_install', args, {
          scopes: ['plugin.write'],
        }),
      },
    });

    expect(granted.ok).toBe(true);
    expect(granted._meta?.confirmationDecision).toMatchObject({
      required: true,
      status: 'accepted',
      grantId: 'grant-plugin_install',
    });
    expect(installPlugin).toHaveBeenCalledTimes(1);
  });

  it('rejects bare confirmation booleans after high-risk schemas are migrated to grants', async () => {
    const installPlugin = vi.fn();
    const executor = createCompatExecutor({
      pluginGateway: {
        listPlugins: async () => [],
        getPlugin: async () => null,
        listRuntimeStatuses: async () => [],
        getRuntimeStatus: async () => null,
        installPlugin,
        reloadPlugin: async () => undefined,
        uninstallPlugin: async () => undefined,
      },
    });

    const result = await executor.invokeApi({
      name: 'plugin_install',
      arguments: {
        sourceType: 'cloud_code',
        cloudPluginCode: 'plugin_a',
        confirmRisk: true,
      },
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['plugin.write'],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      reasonCode: 'capability_input_schema_validation_failed',
    });
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('binds confirmation grants to exact arguments, principal, session, scopes, policy, and expiry', async () => {
    const installPlugin = vi.fn();
    const executor = createCompatExecutor({
      pluginGateway: {
        listPlugins: async () => [],
        getPlugin: async () => null,
        listRuntimeStatuses: async () => [],
        getRuntimeStatus: async () => null,
        installPlugin,
        reloadPlugin: async () => undefined,
        uninstallPlugin: async () => undefined,
      },
    });
    const args = {
      sourceType: 'cloud_code',
      cloudPluginCode: 'plugin_a',
    };
    const grant = createTestGrant('plugin_install', args, {
      scopes: ['plugin.write'],
      sessionId: 'session-a',
      principal: 'principal-a',
      grantId: 'grant-bound',
      expiresAt: new Date(61_000).toISOString(),
    });

    const tamperedGrant = {
      ...createTestGrant('plugin_install', args, {
        scopes: ['plugin.write'],
        sessionId: 'session-a',
        principal: 'principal-a',
        grantId: 'grant-tampered',
        expiresAt: new Date(61_000).toISOString(),
      }),
      source: 'agent-ui' as const,
      scopes: ['plugin.write', 'plugin.admin'],
    };
    const tampered = await executor.invokeApi(
      {
        name: 'plugin_install',
        arguments: args,
        auth: {
          principal: 'principal-a',
          sessionId: 'session-a',
          scopes: ['plugin.write', 'plugin.admin'],
          confirmationGrant: tamperedGrant,
        },
      },
      { confirmation: { now: () => 1_000 } }
    );
    expect(tampered.error?.context?.reason).toBe('invalid_grant_signature');

    const changedArgs = await executor.invokeApi(
      {
        name: 'plugin_install',
        arguments: { ...args, cloudPluginCode: 'plugin_b' },
        auth: {
          principal: 'principal-a',
          sessionId: 'session-a',
          scopes: ['plugin.write'],
          confirmationGrant: grant,
        },
      },
      { confirmation: { now: () => 1_000 } }
    );
    expect(changedArgs.error?.context?.reason).toBe('arguments_hash_mismatch');

    const crossSession = await executor.invokeApi(
      {
        name: 'plugin_install',
        arguments: args,
        auth: {
          principal: 'principal-a',
          sessionId: 'session-b',
          scopes: ['plugin.write'],
          confirmationGrant: grant,
        },
      },
      { confirmation: { now: () => 1_000 } }
    );
    expect(crossSession.error?.context?.reason).toBe('session_mismatch');

    const missingScopeGrant = createTestGrant('plugin_install', args, {
      scopes: ['plugin.write', 'plugin.admin'],
      sessionId: 'session-a',
      principal: 'principal-a',
      grantId: 'grant-missing-provided-scope',
      expiresAt: new Date(61_000).toISOString(),
    });
    const missingScope = await executor.invokeApi(
      {
        name: 'plugin_install',
        arguments: args,
        auth: {
          principal: 'principal-a',
          sessionId: 'session-a',
          scopes: ['plugin.write'],
          confirmationGrant: missingScopeGrant,
        },
      },
      { confirmation: { now: () => 1_000 } }
    );
    expect(missingScope.error?.context?.reason).toBe('grant_scope_not_provided');

    const expired = await executor.invokeApi(
      {
        name: 'plugin_install',
        arguments: args,
        auth: {
          principal: 'principal-a',
          sessionId: 'session-a',
          scopes: ['plugin.write'],
          confirmationGrant: createTestGrant('plugin_install', args, {
            scopes: ['plugin.write'],
            sessionId: 'session-a',
            principal: 'principal-a',
            grantId: 'grant-expired',
            expiresAt: new Date(1_000).toISOString(),
          }),
        },
      },
      { confirmation: { now: () => 2_000 } }
    );
    expect(expired.error?.context?.reason).toBe('grant_expired');
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('consumes confirmation grants once while allowing idempotent replays', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        ok: true,
        summary: 'ok',
        data: { accepted: true },
        truncated: false,
        nextActionHints: [],
        recommendedNextTools: [],
        authoritativeFields: [],
        reasonCode: null,
        retryable: false,
      },
    });
    const restore = __setOrchestrationCapabilityCatalogForTests({
      high_risk_idempotent: {
        definition: {
          name: 'high_risk_idempotent',
          version: '1.0.0',
          description: 'High risk idempotent test capability',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          outputSchema: { type: 'object', additionalProperties: true },
          assistantSurface: { publicMcp: true },
          requiredScopes: ['test.write'],
          requires: [],
          idempotent: true,
          retryPolicy: { retryable: true, maxAttempts: 2 },
          sideEffectLevel: 'high',
        },
        handler,
      } satisfies RegisteredCapability,
    });

    try {
      const executor = createOrchestrationExecutor({});
      const args = { id: 'a' };
      const definition = listOrchestrationCapabilities().find(
        (capability) => capability.name === 'high_risk_idempotent'
      );
      expect(definition).toBeDefined();
      const grant = createCapabilityConfirmationGrant({
        definition: definition!,
        arguments: args,
        grantId: 'grant-once',
        invocationId: 'invoke-once',
        principal: 'principal-a',
        source: 'agent-ui',
        sessionId: 'session-a',
        scopes: ['test.write'],
        idempotencyKey: 'idem-confirmed',
        now: () => 1_000,
      });
      const store = new Map();

      const first = await executor.invokeApi(
        {
          name: 'high_risk_idempotent',
          arguments: args,
          auth: {
            principal: 'principal-a',
            sessionId: 'session-a',
            scopes: ['test.write'],
            confirmationGrant: grant,
          },
        },
        { idempotency: { key: 'idem-confirmed', store, now: () => 1_000 } }
      );
      expect(first.ok).toBe(true);
      expect(first._meta?.confirmationDecision?.status).toBe('accepted');

      const replayed = await executor.invokeApi(
        {
          name: 'high_risk_idempotent',
          arguments: args,
          auth: {
            principal: 'principal-a',
            sessionId: 'session-a',
            scopes: ['test.write'],
          },
        },
        { idempotency: { key: 'idem-confirmed', store, now: () => 2_000 } }
      );
      expect(replayed.ok).toBe(true);
      expect(replayed._meta?.idempotencyStatus).toBe('replayed');
      expect(handler).toHaveBeenCalledTimes(1);

      const secondExecution = await executor.invokeApi(
        {
          name: 'high_risk_idempotent',
          arguments: args,
          auth: {
            principal: 'principal-a',
            sessionId: 'session-a',
            scopes: ['test.write'],
            confirmationGrant: grant,
          },
        },
        { idempotency: { key: 'idem-confirmed-2', store: new Map(), now: () => 3_000 } }
      );
      expect(secondExecution.ok).toBe(false);
      expect(secondExecution.error?.context?.reason).toBe('grant_already_consumed');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('prunes expired consumed confirmation grants', async () => {
    const restore = __setOrchestrationCapabilityCatalogForTests({
      high_risk_prune: {
        definition: {
          name: 'high_risk_prune',
          version: '1.0.0',
          description: 'High risk prune test capability',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', additionalProperties: true },
          assistantSurface: { publicMcp: true },
          requiredScopes: ['test.write'],
          requires: [],
          idempotent: false,
          retryPolicy: { retryable: false, maxAttempts: 1 },
          sideEffectLevel: 'high',
        },
        handler: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { ok: true },
        }),
      } satisfies RegisteredCapability,
    });

    try {
      const executor = createOrchestrationExecutor({});
      const definition = listOrchestrationCapabilities().find(
        (capability) => capability.name === 'high_risk_prune'
      )!;
      const firstGrant = createCapabilityConfirmationGrant({
        definition,
        arguments: {},
        grantId: 'grant-prune',
        invocationId: 'invoke-prune-1',
        principal: 'principal-a',
        source: 'agent-ui',
        sessionId: 'session-a',
        scopes: ['test.write'],
        expiresAt: new Date(5_000).toISOString(),
        now: () => 1_000,
      });

      const first = await executor.invokeApi(
        {
          name: 'high_risk_prune',
          arguments: {},
          auth: {
            principal: 'principal-a',
            sessionId: 'session-a',
            scopes: ['test.write'],
            confirmationGrant: firstGrant,
          },
        },
        { confirmation: { now: () => 1_000 } }
      );
      expect(first.ok).toBe(true);

      const secondGrant = createCapabilityConfirmationGrant({
        definition,
        arguments: {},
        grantId: 'grant-prune',
        invocationId: 'invoke-prune-2',
        principal: 'principal-a',
        source: 'agent-ui',
        sessionId: 'session-a',
        scopes: ['test.write'],
        expiresAt: new Date(310_000).toISOString(),
        now: () => 10_000,
      });
      const second = await executor.invokeApi(
        {
          name: 'high_risk_prune',
          arguments: {},
          auth: {
            principal: 'principal-a',
            sessionId: 'session-a',
            scopes: ['test.write'],
            confirmationGrant: secondGrant,
          },
        },
        { confirmation: { now: () => 10_000 } }
      );
      expect(second.ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('reads trace summaries through the observation gateway', async () => {
    const executor = createCompatExecutor({
      observationGateway: {
        getTraceSummary: async (traceId: string) => ({
          traceId,
          eventCount: 3,
          artifactCount: 1,
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_000_500,
          finalStatus: 'failed',
          firstFailure: {
            eventId: 'event-failed',
            timestamp: 1_700_000_000_200,
            traceId,
            level: 'error',
            event: 'browser.action.failed',
            outcome: 'failed',
            component: 'browser',
          },
          entities: {
            capability: 'browser_snapshot',
            source: 'http',
          },
          recentArtifacts: [
            {
              artifactId: 'artifact-1',
              type: 'snapshot',
              timestamp: 1_700_000_000_300,
            },
          ],
        }),
        getFailureBundle: async () => ({
          traceId: 'unused',
          recentEvents: [],
          artifactRefs: [],
        }),
        getTraceTimeline: async (traceId: string) => ({
          traceId,
          finalStatus: 'failed',
          events: [],
          artifactRefs: [],
        }),
        searchRecentFailures: async () => [],
      },
    });

    const result = await executor.invokeApi({
      name: 'observation_get_trace_summary',
      arguments: { traceId: 'trace-observation-1' },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        traceId: 'trace-observation-1',
        finalStatus: 'failed',
        firstFailure: {
          event: 'browser.action.failed',
        },
      },
      recommendedNextTools: ['observation_get_failure_bundle'],
    });
  });

  it('reads trace timelines and recent failures through the observation gateway', async () => {
    const executor = createCompatExecutor({
      observationGateway: {
        getTraceSummary: async (traceId: string) => ({
          traceId,
          eventCount: 0,
          artifactCount: 0,
          finalStatus: 'failed',
          entities: {},
          recentArtifacts: [],
        }),
        getFailureBundle: async (traceId: string) => ({
          traceId,
          recentEvents: [],
          artifactRefs: [],
        }),
        getTraceTimeline: async (traceId: string) => ({
          traceId,
          finalStatus: 'failed',
          events: [],
          artifactRefs: [],
        }),
        searchRecentFailures: async () => [
          {
            traceId: 'trace-observation-2',
            failedAt: 1_700_000_000_200,
            eventId: 'event-failed',
            event: 'db.query.failed',
            component: 'duckdb',
            finalStatus: 'failed',
            artifactCount: 1,
          },
        ],
      },
    });

    const timeline = await executor.invokeApi({
      name: 'observation_get_trace_timeline',
      arguments: { traceId: 'trace-observation-2', limit: 20 },
    });
    expect(timeline.ok).toBe(true);
    expect(timeline.output.structuredContent).toMatchObject({
      data: {
        traceId: 'trace-observation-2',
        finalStatus: 'failed',
      },
    });

    const recent = await executor.invokeApi({
      name: 'observation_search_recent_failures',
      arguments: { limit: 5 },
    });
    expect(recent.ok).toBe(true);
    expect(recent.output.structuredContent).toMatchObject({
      data: {
        total: 1,
        failures: [
          {
            traceId: 'trace-observation-2',
            event: 'db.query.failed',
          },
        ],
      },
    });
  });

  it('reads system health through the system gateway', async () => {
    const executor = createCompatExecutor({
      systemGateway: {
        getHealth: async () => ({
          status: 'ok',
          name: 'airpa-test',
          version: '1.0.0',
          activeSessions: 0,
          mcpSessions: 0,
          orchestrationSessions: 0,
          authEnabled: false,
          mcpConfigured: true,
          mcpEnabled: true,
          mcpRequireAuth: true,
          mcpProtocolCompatibilityMode: 'unified',
          mcpProtocolVersion: '2025-03-26',
          mcpSupportedProtocolVersions: ['2025-03-26'],
          mcpSdkSupportedProtocolVersions: ['2025-03-26'],
          enforceOrchestrationScopes: false,
          orchestrationIdempotencyStore: 'memory',
          queueDepth: {},
          runtimeCounters: {},
          sessionLeakRisk: {},
          sessionCleanupPolicy: {},
          processStartTime: new Date(1_700_000_000_000).toISOString(),
          mainDistUpdatedAt: null,
          rendererDistUpdatedAt: null,
          mainBuildStamp: null,
          mcpRuntimeFreshness: {
            overall: 'fresh',
            main: { ok: true, reason: 'fresh', lagMs: 0 },
            renderer: { ok: true, reason: 'fresh', lagMs: 0 },
          },
          buildFreshness: {
            overall: 'fresh',
            main: { ok: true, reason: 'fresh', lagMs: 0 },
            renderer: { ok: true, reason: 'fresh', lagMs: 0 },
          },
          gitCommit: null,
          mcpSdk: {
            version: '1.0.0',
            initializeShimMode: 'private_slot',
            degraded: false,
            fingerprintInjected: true,
            initializeShimReason: null,
          },
          runtimeAlerts: [],
        }),
        listPublicCapabilities: async () => ['system_get_health', 'system_bootstrap'],
      },
    });

    const result = await executor.invokeApi({
      name: 'system_get_health',
      arguments: {},
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        status: 'ok',
        name: 'airpa-test',
      },
      recommendedNextTools: ['system_bootstrap'],
    });
  });

  it('reads plugin inventory through the plugin gateway', async () => {
    const executor = createCompatExecutor({
      pluginGateway: {
        listPlugins: async () => [
          {
            id: 'plugin-a',
            name: 'Plugin A',
            version: '1.0.0',
            author: 'Airpa',
            installedAt: 1_700_000_000_000,
            path: 'D:/plugins/plugin-a',
            enabled: true,
          },
        ],
        getPlugin: async () => null,
        listRuntimeStatuses: async () => [
          {
            pluginId: 'plugin-a',
            lifecyclePhase: 'active',
            workState: 'idle',
            activeQueues: 0,
            runningTasks: 0,
            pendingTasks: 0,
            failedTasks: 0,
            cancelledTasks: 0,
            updatedAt: 1_700_000_000_100,
          },
        ],
        getRuntimeStatus: async () => null,
        installPlugin: async () => ({
          pluginId: 'plugin-a',
          operation: 'installed',
          sourceType: 'local_path',
        }),
        reloadPlugin: async () => undefined,
        uninstallPlugin: async () => undefined,
      },
    });

    const result = await executor.invokeApi({
      name: 'plugin_list',
      arguments: {},
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        total: 1,
        plugins: [
          {
            plugin: {
              id: 'plugin-a',
              enabled: true,
            },
            runtime: {
              lifecyclePhase: 'active',
              workState: 'idle',
            },
          },
        ],
      },
      recommendedNextTools: ['plugin_get_runtime_status', 'cross_plugin_list_apis'],
    });
  });

  it('reloads one plugin through the plugin gateway', async () => {
    const reloadPlugin = vi.fn().mockResolvedValue(undefined);
    const executor = createCompatExecutor({
      pluginGateway: {
        listPlugins: async () => [],
        getPlugin: async (pluginId: string) => ({
          id: pluginId,
          name: 'Plugin A',
          version: '1.0.0',
          author: 'Airpa',
          installedAt: 1_700_000_000_000,
          path: 'D:/plugins/plugin-a',
          enabled: true,
        }),
        listRuntimeStatuses: async () => [],
        getRuntimeStatus: async () => null,
        installPlugin: async () => ({
          pluginId: 'plugin-a',
          operation: 'installed',
          sourceType: 'local_path',
        }),
        reloadPlugin,
        uninstallPlugin: async () => undefined,
      },
    });

    const result = await executor.invokeApi({
      name: 'plugin_reload',
      arguments: { pluginId: 'plugin-a' },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        pluginId: 'plugin-a',
        reloaded: true,
      },
      recommendedNextTools: ['plugin_get_runtime_status', 'observation_get_trace_summary'],
    });
    expect(reloadPlugin).toHaveBeenCalledWith('plugin-a');
  });

  it('installs one plugin through the plugin gateway after explicit confirmation', async () => {
    const installPlugin = vi.fn().mockResolvedValue({
      pluginId: 'plugin-a',
      operation: 'installed',
      sourceType: 'cloud_code',
    });
    const executor = createCompatExecutor({
      pluginGateway: {
        listPlugins: async () => [],
        getPlugin: async (pluginId: string) => ({
          id: pluginId,
          name: 'Plugin A',
          version: '1.0.0',
          author: 'Airpa',
          installedAt: 1_700_000_000_000,
          path: 'D:/plugins/plugin-a',
          enabled: true,
        }),
        listRuntimeStatuses: async () => [],
        getRuntimeStatus: async () => null,
        installPlugin,
        reloadPlugin: async () => undefined,
        uninstallPlugin: async () => undefined,
      },
    });

    const installArgs = {
      sourceType: 'cloud_code',
      cloudPluginCode: 'plugin_a',
    };
    const result = await executor.invokeApi({
      name: 'plugin_install',
      arguments: installArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['plugin.write'],
        confirmationGrant: createTestGrant('plugin_install', installArgs, {
          scopes: ['plugin.write'],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        pluginId: 'plugin-a',
        operation: 'installed',
        sourceType: 'cloud_code',
      },
      recommendedNextTools: ['plugin_get_runtime_status', 'system_bootstrap'],
    });
    expect(installPlugin).toHaveBeenCalledWith({
      sourceType: 'cloud_code',
      cloudPluginCode: 'plugin_a',
    });
  });

  it('creates an empty dataset through the dataset gateway', async () => {
    const createEmptyDataset = vi.fn().mockResolvedValue('dataset-new');
    const executor = createCompatExecutor({
      datasetGateway: {
        listDatasets: async () => [],
        getDatasetInfo: async (datasetId: string) => ({
          id: datasetId,
          name: 'Leads Queue',
        }),
        queryDataset: async () => ({
          columns: [],
          rows: [],
          rowCount: 0,
        }),
        createEmptyDataset,
        importDatasetFile: async () => 'dataset-imported',
        renameDataset: async () => undefined,
        deleteDataset: async () => undefined,
      },
    });

    const result = await executor.invokeApi({
      name: 'dataset_create_empty',
      arguments: {
        datasetName: 'Leads Queue',
        folderId: null,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        datasetId: 'dataset-new',
        datasetName: 'Leads Queue',
        created: true,
      },
      recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    });
    expect(createEmptyDataset).toHaveBeenCalledWith('Leads Queue', { folderId: null });
  });

  it('imports one dataset file through the dataset gateway after explicit confirmation', async () => {
    const importDatasetFile = vi.fn().mockResolvedValue('dataset-imported');
    const tempDir = mkdtempSync(join(tmpdir(), 'airpa-dataset-'));
    const existingFilePath = join(tempDir, 'orders.csv');
    writeFileSync(existingFilePath, 'id\n1\n');
    const executor = createCompatExecutor({
      datasetGateway: {
        listDatasets: async () => [],
        getDatasetInfo: async (datasetId: string) => ({
          id: datasetId,
          name: 'Orders',
        }),
        queryDataset: async () => ({
          columns: [],
          rows: [],
          rowCount: 0,
        }),
        createEmptyDataset: async () => 'dataset-new',
        importDatasetFile,
        renameDataset: async () => undefined,
        deleteDataset: async () => undefined,
      },
    });

    const importArgs = {
      filePath: existingFilePath,
      datasetName: 'Orders',
    };
    const result = await executor.invokeApi({
      name: 'dataset_import_file',
      arguments: importArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['dataset.write'],
        confirmationGrant: createTestGrant('dataset_import_file', importArgs, {
          scopes: ['dataset.write'],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        datasetId: 'dataset-imported',
        datasetName: 'Orders',
        filePath: existingFilePath,
        imported: true,
      },
      recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    });
    expect(importDatasetFile).toHaveBeenCalledWith(existingFilePath, 'Orders', {
      folderId: undefined,
    });
  });

  it('stages and commits dataset write plans through the dataset gateway', async () => {
    const stagedPlan = {
      planId: 'plan-1',
      datasetId: 'dataset-1',
      createdAt: '2026-06-22T00:00:00.000Z',
      operations: [{ type: 'insert' as const, record: { name: 'Alice' } }],
      rowCount: 1,
      requiresConfirmation: true as const,
      provenance: {
        traceId: 'trace-1',
        adapterVersion: '1.0.0',
        runtimeId: 'electron-webcontents',
        sourceUrl: 'https://example.test/source',
      },
    };
    const stageWritePlan = vi.fn().mockResolvedValue(stagedPlan);
    const commitWritePlan = vi.fn().mockResolvedValue({
      planId: 'plan-1',
      runId: 'plan-1',
      datasetId: 'dataset-1',
      insertedRowIds: [1],
      updatedRowIds: [],
      deletedRowIds: [],
      affectedRowCount: 1,
      provenanceRecorded: true,
    });
    const listRecordProvenance = vi.fn().mockResolvedValue([
      {
        id: 'prov-1',
        datasetId: 'dataset-1',
        rowId: 1,
        runId: 'plan-1',
        operation: 'insert',
        occurredAt: 1_700_000_000_000,
        traceId: 'trace-1',
        adapterVersion: '1.0.0',
        runtimeId: 'electron-webcontents',
        sourceUrl: 'https://example.test/source',
      },
    ]);
    const executor = createCompatExecutor({
      datasetGateway: {
        listDatasets: async () => [],
        getDatasetInfo: async () => null,
        queryDataset: async () => ({
          columns: [],
          rows: [],
          rowCount: 0,
        }),
        createEmptyDataset: async () => 'dataset-new',
        importDatasetFile: async () => 'dataset-imported',
        renameDataset: async () => undefined,
        deleteDataset: async () => undefined,
        stageWritePlan,
        commitWritePlan,
        listRecordProvenance,
      },
    });

    const stage = await executor.invokeApi({
      name: 'dataset_stage_write_plan',
      arguments: {
        datasetId: 'dataset-1',
        operations: [{ type: 'insert', record: { name: 'Alice' } }],
        provenance: stagedPlan.provenance,
      },
    });
    expect(stage.ok).toBe(true);
    expect(stage.output.structuredContent).toMatchObject({
      data: {
        planId: 'plan-1',
        datasetId: 'dataset-1',
        rowCount: 1,
        requiresConfirmation: true,
      },
      recommendedNextTools: ['dataset_commit_write_plan', 'dataset_get_record_provenance'],
    });
    expect(stageWritePlan).toHaveBeenCalledWith(
      'dataset-1',
      [{ type: 'insert', record: { name: 'Alice' } }],
      {
        ...stagedPlan.provenance,
        adapterId: null,
        metadata: null,
      }
    );

    const rejectedCommit = await executor.invokeApi({
      name: 'dataset_commit_write_plan',
      arguments: { plan: stagedPlan },
    });
    expect(rejectedCommit.ok).toBe(false);
    expect(commitWritePlan).not.toHaveBeenCalled();

    const commitArgs = { plan: stagedPlan };
    const commit = await executor.invokeApi({
      name: 'dataset_commit_write_plan',
      arguments: commitArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['dataset.write'],
        confirmationGrant: createTestGrant('dataset_commit_write_plan', commitArgs, {
          scopes: ['dataset.write'],
        }),
      },
    });
    expect(commit.ok).toBe(true);
    expect(commit.output.structuredContent).toMatchObject({
      data: {
        planId: 'plan-1',
        runId: 'plan-1',
        committed: true,
        provenanceRecorded: true,
      },
    });
    expect(commitWritePlan).toHaveBeenCalledWith(stagedPlan, { confirmRisk: true });

    const provenance = await executor.invokeApi({
      name: 'dataset_get_record_provenance',
      arguments: { datasetId: 'dataset-1', rowId: 1 },
    });
    expect(provenance.ok).toBe(true);
    expect(provenance.output.structuredContent).toMatchObject({
      data: {
        datasetId: 'dataset-1',
        rowId: 1,
        total: 1,
        provenance: [
          expect.objectContaining({
            runId: 'plan-1',
            traceId: 'trace-1',
            sourceUrl: 'https://example.test/source',
          }),
        ],
      },
    });
  });

  it('returns NOT_FOUND for unknown capabilities', async () => {
    const executor = createCompatExecutor({});
    const result = await executor.invokeApi({
      name: 'unknown_capability',
      arguments: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.NOT_FOUND);
    expect(typeof result._meta?.traceId).toBe('string');
  });

  it('invokes browser_snapshot successfully on the canonical surface', async () => {
    const executor = createCompatExecutor({
      browser: createMockBrowser(),
    });

    const result = await executor.invokeApi({
      name: 'browser_snapshot',
      arguments: { elementsFilter: 'all', maxElements: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result.output.text.join('\n')).toContain('Page snapshot captured');
    expect(result.output.structuredContent).toMatchObject({
      data: {
        url: 'https://example.com',
        title: 'Example',
      },
    });
    expect(result._meta?.attempts).toBe(1);
  });

  it('retries retryable canonical capabilities after transient failures', async () => {
    const snapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary upstream error'))
      .mockResolvedValueOnce(createSnapshot());
    const executor = createCompatExecutor({
      browser: createMockBrowser({ snapshot }),
    });

    const result = await executor.invokeApi({
      name: 'browser_snapshot',
      arguments: { elementsFilter: 'all', maxElements: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result._meta?.attempts).toBe(2);
    expect(result._meta?.attemptTimeline?.length).toBe(2);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('aborts canonical browser work before execution when the signal is already aborted', async () => {
    const snapshot = vi.fn().mockResolvedValue(createSnapshot());
    const controller = new AbortController();
    controller.abort(
      createStructuredError(ErrorCode.OPERATION_FAILED, 'Session is closing: session-aborted', {
        context: {
          session: 'session-aborted',
          reason: 'session_closing',
        },
      })
    );

    const executor = createCompatExecutor({
      browser: createMockBrowser({ snapshot }),
    });

    const result = await executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: { elementsFilter: 'all', maxElements: 10 },
      },
      {
        signal: controller.signal,
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error?.context?.reason).toBe('session_closing');
    expect(result._meta?.attempts).toBe(1);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('does not retry canonical browser work after an abort signal', async () => {
    const snapshot = vi
      .fn()
      .mockImplementation(() => new Promise<ReturnType<typeof createSnapshot>>(() => {}));
    const controller = new AbortController();
    const executor = createCompatExecutor({
      browser: createMockBrowser({ snapshot }),
    });

    const invokePromise = executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: { elementsFilter: 'all', maxElements: 10 },
      },
      {
        signal: controller.signal,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(
      createStructuredError(ErrorCode.OPERATION_FAILED, 'Session is closing: session-mid-abort', {
        context: {
          session: 'session-mid-abort',
          reason: 'session_closing',
        },
      })
    );

    const result = await invokePromise;
    expect(result.ok).toBe(false);
    expect(result.error?.context?.reason).toBe('session_closing');
    expect(result._meta?.attempts).toBe(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('supports idempotency metadata on canonical read tools', async () => {
    const snapshot = vi.fn().mockResolvedValue(createSnapshot());
    const executor = createCompatExecutor({
      browser: createMockBrowser({ snapshot }),
    });
    const store = new Map();

    const first = await executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: { elementsFilter: 'all' },
      },
      {
        idempotency: {
          key: 'idem-001',
          store,
          now: () => 1_700_000_000_000,
        },
      }
    );

    const replayed = await executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: { elementsFilter: 'all' },
      },
      {
        idempotency: {
          key: 'idem-001',
          store,
          now: () => 1_700_000_001_000,
        },
      }
    );

    const conflicted = await executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: { elementsFilter: 'interactive' },
      },
      {
        idempotency: {
          key: 'idem-001',
          store,
        },
      }
    );

    expect(first.ok).toBe(true);
    expect(first._meta?.idempotencyStatus).toBe('stored');
    expect(replayed.ok).toBe(true);
    expect(replayed._meta?.idempotencyStatus).toBe('replayed');
    expect(conflicted.ok).toBe(false);
    expect(conflicted.error?.code).toBe(ErrorCode.REQUEST_FAILED);
    expect(conflicted.error?.context?.reason).toBe('idempotency_conflict');
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('enforces scopes on canonical browser capabilities', async () => {
    const executor = createCompatExecutor({
      browser: createMockBrowser(),
      enforceScopes: true,
    });

    const denied = await executor.invokeApi({
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(denied._meta?.scopeDecision?.missingScopes).toContain('browser.read');

    const allowed = await executor.invokeApi({
      name: 'browser_snapshot',
      arguments: {},
      auth: {
        scopes: ['browser.read'],
      },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed._meta?.scopeDecision?.allowed).toBe(true);
  });

  it('enforces scopes by default when deps omit enforceScopes', async () => {
    const executor = createOrchestrationExecutor({
      browser: createMockBrowser(),
    });

    const denied = await executor.invokeApi({
      name: 'browser_snapshot',
      arguments: {},
    });

    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(denied._meta?.scopeDecision).toMatchObject({
      enforced: true,
      allowed: false,
      missingScopes: ['browser.read'],
    });
  });

  it('passes through protocol trace ids on canonical capabilities', async () => {
    const executor = createCompatExecutor({
      browser: createMockBrowser(),
    });

    const result = await executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: {},
      },
      {
        traceId: 'trace-from-protocol-layer',
      }
    );

    expect(result.ok).toBe(true);
    expect(result._meta?.traceId).toBe('trace-from-protocol-layer');
  });

  it('records capability.invoke events on the shared trace', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const executor = createCompatExecutor({
      browser: createMockBrowser(),
    });

    const result = await executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: {},
      },
      {
        traceId: 'trace-observation-capability',
      }
    );

    expect(result.ok).toBe(true);
    expect(
      sink.events
        .filter((event) => event.event.startsWith('capability.invoke'))
        .map((event) => event.event)
    ).toEqual(['capability.invoke.started', 'capability.invoke.succeeded']);
    expect(sink.events.every((event) => event.traceId === 'trace-observation-capability')).toBe(
      true
    );
  });

  it('records system and session domain events on the shared trace', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const executor = createCompatExecutor({
      systemGateway: {
        getHealth: async () => ({
          status: 'ok',
          name: 'airpa-test',
          version: '1.0.0',
          activeSessions: 1,
          mcpSessions: 1,
          orchestrationSessions: 0,
          authEnabled: false,
          mcpConfigured: true,
          mcpEnabled: true,
          mcpRequireAuth: false,
          mcpProtocolCompatibilityMode: 'unified',
          mcpProtocolVersion: '2025-03-26',
          mcpSupportedProtocolVersions: ['2025-03-26'],
          mcpSdkSupportedProtocolVersions: ['2025-03-26'],
          enforceOrchestrationScopes: false,
          orchestrationIdempotencyStore: 'memory',
          queueDepth: {},
          runtimeCounters: {},
          sessionLeakRisk: {},
          sessionCleanupPolicy: {},
          processStartTime: new Date(1_700_000_000_000).toISOString(),
          mainDistUpdatedAt: null,
          rendererDistUpdatedAt: null,
          mainBuildStamp: null,
          mcpRuntimeFreshness: {},
          buildFreshness: {},
          gitCommit: null,
          mcpSdk: {},
          runtimeAlerts: [],
        }),
        listPublicCapabilities: async () => ['system_bootstrap', 'session_prepare'],
      },
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-domain-test',
        listSessions: async () => [
          {
            sessionId: 'session-domain-test',
            lastActivityAt: '2026-04-13T00:00:00.000Z',
            pendingInvocations: 0,
            activeInvocations: 0,
            maxQueueSize: 10,
            browserAcquired: false,
            browserAcquireInProgress: false,
            hasBrowserHandle: false,
            phase: 'fresh_unbound',
            bindingLocked: false,
          },
        ],
        prepareCurrentSession: async () => ({
          sessionId: 'session-domain-test',
          prepared: true,
          idempotent: true,
          visible: false,
          effectiveScopes: [],
          browserAcquired: false,
          changed: [],
          phase: 'prepared_unacquired',
          bindingLocked: false,
        }),
        closeSession: async () => ({
          closed: true,
          closedCurrentSession: true,
          transportInvalidated: true,
          allowFurtherCallsOnSameTransport: false,
          terminationTiming: 'after_response_flush',
        }),
      },
    });

    await executor.invokeApi(
      { name: 'system_bootstrap', arguments: {} },
      { traceId: 'trace-domain-events' }
    );
    await executor.invokeApi(
      { name: 'session_prepare', arguments: {} },
      { traceId: 'trace-domain-events' }
    );

    expect(
      sink.events
        .filter((event) => event.event.startsWith('system.bootstrap'))
        .map((event) => event.event)
    ).toEqual(['system.bootstrap.started', 'system.bootstrap.succeeded']);
    expect(
      sink.events
        .filter((event) => event.event.startsWith('session.lifecycle.prepare'))
        .map((event) => event.event)
    ).toEqual(['session.lifecycle.prepare.started', 'session.lifecycle.prepare.succeeded']);
  });

  it('lists and resolves canonical profile capabilities', async () => {
    const executor = createCompatExecutor({
      profileGateway: {
        listProfiles: async () => [
          {
            id: 'profile-1',
            name: '555',
            runtimeId: 'electron-webcontents',
            status: 'idle',
            partition: 'persist:profile-1',
          },
          {
            id: 'profile-2',
            name: 'marketing',
            runtimeId: 'chromium-extension-relay',
            status: 'active',
            partition: 'persist:profile-2',
          },
        ],
        getProfile: async () => null,
        resolveProfile: async (query: string) =>
          query === '555'
            ? {
                query,
                matchedBy: 'name',
                profile: {
                  id: 'profile-1',
                  name: '555',
                  runtimeId: 'electron-webcontents',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              }
            : null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile: async () => ({
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-1',
          isSystem: false,
        }),
        deleteProfile: async () => undefined,
      },
    });

    const listResult = await executor.invokeApi({
      name: 'profile_list',
      arguments: {},
    });
    expect(listResult.ok).toBe(true);
    expect(listResult.output.structuredContent).toMatchObject({
      data: {
        total: 2,
        profiles: expect.arrayContaining([expect.objectContaining({ id: 'profile-1' })]),
      },
    });

    const resolveResult = await executor.invokeApi({
      name: 'profile_resolve',
      arguments: { query: '555' },
    });
    expect(resolveResult.ok).toBe(true);
    expect(resolveResult.output.structuredContent).toMatchObject({
      data: {
        query: '555',
        matchedBy: 'name',
        profile: { id: 'profile-1' },
      },
    });
  });

  it('prepares profile login handoff without exposing secret values', async () => {
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-login',
      prepared: true,
      idempotent: false,
      profileId: 'profile-1',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: [],
      browserAcquired: false,
      phase: 'prepared_unacquired',
      bindingLocked: false,
      changed: ['profile', 'runtimeId', 'visible'],
    });
    const upsertLoginState = vi.fn().mockImplementation(async (params) => ({
      id: 'login-state-1',
      profileId: params.profileId,
      accountId: params.accountId ?? null,
      site: params.site,
      loginUrl: params.loginUrl ?? null,
      runtimeIdSnapshot: params.runtimeId ?? null,
      runtimeId: params.runtimeId ?? null,
      profileRevision: params.profileRevision ?? 0,
      status: params.status,
      verified: params.verified ?? false,
      verifiedBy: params.verifiedBy ?? null,
      lastCheckedAt: '2026-06-22T00:00:00.000Z',
      verifiedAt: null,
      evidenceArtifactId: null,
      evidence: params.evidence ?? null,
      reason: params.reason ?? null,
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
    }));
    const executor = createCompatExecutor({
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-login',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => null,
        resolveProfile: async (query: string) =>
          query === '555'
            ? {
                query,
                matchedBy: 'name',
                profile: {
                  id: 'profile-1',
                  name: '555',
                  runtimeId: 'electron-webcontents',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              }
            : null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile: async () => ({
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-1',
          isSystem: false,
        }),
        deleteProfile: async () => undefined,
      },
      profileLoginStateGateway: {
        getLoginState: async () => null,
        upsertLoginState,
      },
    });

    const result = await executor.invokeApi({
      name: 'profile_ensure_logged_in',
      arguments: {
        query: '555',
        site: 'example',
        loginUrl: 'https://example.com/login',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-1',
        status: 'needs_manual_login',
        verified: false,
        manualHandoffRequired: true,
        loginState: {
          id: 'login-state-1',
          status: 'needs_manual_login',
        },
        evidence: {
          credentialValuesReturned: false,
          cookieValuesReturned: false,
        },
      },
      recommendedNextTools: ['browser_observe', 'browser_snapshot', 'session_get_current'],
    });
    expect(JSON.stringify(result.output.structuredContent)).not.toMatch(
      /password_value|cookie_value|authorization\s*[:=]|bearer\s+[a-z0-9._-]+/i
    );
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-1',
      runtimeId: 'electron-webcontents',
      visible: true,
    });
    expect(upsertLoginState).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        site: 'example',
        loginUrl: 'https://example.com/login',
        runtimeId: 'electron-webcontents',
        status: 'needs_manual_login',
        verified: false,
        verifiedBy: 'capability',
      })
    );
  });

  it('returns stored verified login state without requiring manual handoff', async () => {
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-login',
      prepared: true,
      idempotent: true,
      profileId: 'profile-1',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: [],
      browserAcquired: false,
      phase: 'prepared_unacquired',
      bindingLocked: false,
      changed: [],
    });
    const upsertLoginState = vi.fn().mockImplementation(async (params) => ({
      id: 'login-state-ready',
      profileId: params.profileId,
      accountId: null,
      site: params.site,
      loginUrl: null,
      runtimeIdSnapshot: params.runtimeId ?? null,
      runtimeId: params.runtimeId ?? null,
      profileRevision: params.profileRevision ?? 0,
      status: params.status,
      verified: params.verified ?? false,
      verifiedBy: params.verifiedBy ?? null,
      lastCheckedAt: '2026-06-22T00:00:00.000Z',
      verifiedAt: '2026-06-22T00:00:00.000Z',
      evidenceArtifactId: null,
      evidence: params.evidence ?? null,
      reason: params.reason ?? null,
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
    }));
    const executor = createCompatExecutor({
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-login',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => ({
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-1',
        }),
        resolveProfile: async () => null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile: async () => ({
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-1',
          isSystem: false,
        }),
        deleteProfile: async () => undefined,
      },
      profileLoginStateGateway: {
        getLoginState: async () => ({
          id: 'login-state-ready',
          profileId: 'profile-1',
          site: 'example',
          runtimeIdSnapshot: 'electron-webcontents',
          runtimeId: 'electron-webcontents',
          profileRevision: 0,
          status: 'logged_in',
          verified: true,
          verifiedBy: 'capability',
          lastCheckedAt: '2026-06-22T00:00:00.000Z',
          verifiedAt: '2026-06-22T00:00:00.000Z',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
        }),
        upsertLoginState,
      },
    });

    const result = await executor.invokeApi({
      name: 'profile_ensure_logged_in',
      arguments: {
        profileId: 'profile-1',
        site: 'example',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-1',
        status: 'logged_in',
        verified: true,
        manualHandoffRequired: false,
        loginState: {
          id: 'login-state-ready',
          status: 'logged_in',
          verified: true,
        },
      },
      recommendedNextTools: ['browser_observe', 'browser_snapshot', 'session_get_current'],
    });
    expect(upsertLoginState).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        site: 'example',
        status: 'logged_in',
        verified: true,
        verifiedBy: 'capability',
      })
    );
  });

  it('treats expired stored login state as a manual handoff condition', async () => {
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-login',
      prepared: true,
      idempotent: false,
      profileId: 'profile-1',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: [],
      browserAcquired: false,
      phase: 'prepared_unacquired',
      bindingLocked: false,
      changed: ['visible'],
    });
    const upsertLoginState = vi.fn().mockImplementation(async (params) => ({
      id: 'login-state-expired',
      profileId: params.profileId,
      accountId: null,
      site: params.site,
      loginUrl: null,
      runtimeIdSnapshot: params.runtimeId ?? null,
      runtimeId: params.runtimeId ?? null,
      profileRevision: params.profileRevision ?? 0,
      status: params.status,
      verified: params.verified ?? false,
      verifiedBy: params.verifiedBy ?? null,
      lastCheckedAt: '2026-06-22T00:00:00.000Z',
      verifiedAt: null,
      evidenceArtifactId: null,
      evidence: params.evidence ?? null,
      reason: params.reason ?? null,
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
    }));
    const executor = createCompatExecutor({
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-login',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => ({
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-1',
        }),
        resolveProfile: async () => null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile: async () => ({
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-1',
          isSystem: false,
        }),
        deleteProfile: async () => undefined,
      },
      profileLoginStateGateway: {
        getLoginState: async () => ({
          id: 'login-state-expired',
          profileId: 'profile-1',
          site: 'example',
          runtimeIdSnapshot: 'electron-webcontents',
          runtimeId: 'electron-webcontents',
          profileRevision: 0,
          status: 'expired',
          verified: false,
          verifiedBy: 'capability',
          reason: 'session cookie expired',
          lastCheckedAt: '2026-06-22T00:00:00.000Z',
          verifiedAt: null,
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
        }),
        upsertLoginState,
      },
    });

    const result = await executor.invokeApi({
      name: 'profile_ensure_logged_in',
      arguments: {
        profileId: 'profile-1',
        site: 'example',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-1',
        status: 'expired',
        verified: false,
        manualHandoffRequired: true,
        loginState: {
          id: 'login-state-expired',
          status: 'expired',
          verified: false,
        },
      },
      recommendedNextTools: ['browser_observe', 'browser_snapshot', 'session_get_current'],
    });
    expect(upsertLoginState).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        site: 'example',
        status: 'expired',
        verified: false,
        verifiedBy: 'capability',
      })
    );
  });

  it('supports canonical current-session inspection, preparation, and teardown', async () => {
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-current',
      prepared: true,
      idempotent: false,
      profileId: 'profile-1',
      runtimeId: 'electron-webcontents',
      visible: false,
      effectiveScopes: ['browser.read', 'browser.write'],
      browserAcquired: false,
      phase: 'prepared_unacquired',
      bindingLocked: false,
      changed: ['profile', 'runtimeId', 'visible', 'scopes'],
    });
    const closeSession = vi.fn().mockResolvedValue({
      closed: true,
      closedCurrentSession: true,
      transportInvalidated: true,
      allowFurtherCallsOnSameTransport: false,
      terminationTiming: 'after_response_flush' as const,
    });

    const executor = createCompatExecutor({
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-current',
        listSessions: async () => [
          {
            sessionId: 'session-current',
            profileId: 'profile-1',
            runtimeId: 'electron-webcontents',
            visible: false,
            lastActivityAt: '2026-03-20T00:00:00.000Z',
            pendingInvocations: 0,
            activeInvocations: 0,
            maxQueueSize: 10,
            browserAcquired: false,
            browserAcquireInProgress: false,
            hasBrowserHandle: false,
            effectiveScopes: ['browser.read'],
            phase: 'fresh_unbound',
            bindingLocked: false,
          },
        ],
        prepareCurrentSession,
        closeSession,
      },
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => null,
        resolveProfile: async (query: string) =>
          query === '555'
            ? {
                query,
                matchedBy: 'name',
                profile: {
                  id: 'profile-1',
                  name: '555',
                  runtimeId: 'electron-webcontents',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              }
            : null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile: async () => ({
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          status: 'idle',
          partition: 'persist:profile-1',
          isSystem: false,
        }),
        deleteProfile: async () => undefined,
      },
    });

    const currentResult = await executor.invokeApi({
      name: 'session_get_current',
      arguments: {},
    });
    expect(currentResult.ok).toBe(true);
    expect(currentResult.output.structuredContent).toMatchObject({
      data: {
        currentSessionId: 'session-current',
        session: expect.objectContaining({
          sessionId: 'session-current',
          effectiveScopes: ['browser.read'],
        }),
      },
    });

    const prepareResult = await executor.invokeApi({
      name: 'session_prepare',
      arguments: {
        query: '555',
        runtimeId: 'electron-webcontents',
        visible: false,
        scopes: ['browser.read', 'browser.write'],
      },
    });
    expect(prepareResult.ok).toBe(true);
    expect(prepareResult.output.structuredContent).toMatchObject({
      data: {
        sessionId: 'session-current',
        effectiveProfile: {
          id: 'profile-1',
          name: '555',
          runtimeId: 'electron-webcontents',
          source: 'resolved_query',
        },
        effectiveRuntime: 'electron-webcontents',
        effectiveRuntimeSource: 'requested',
        phase: 'prepared_unacquired',
        bindingLocked: false,
      },
    });
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-1',
      runtimeId: 'electron-webcontents',
      visible: false,
      scopes: ['browser.read', 'browser.write'],
    });

    const endCurrentArgs = {};
    const endCurrentResult = await executor.invokeApi({
      name: 'session_end_current',
      arguments: endCurrentArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['session.write'],
        confirmationGrant: createTestGrant('session_end_current', endCurrentArgs, {
          scopes: ['session.write'],
        }),
      },
    });
    expect(endCurrentResult.ok).toBe(true);
    expect(endCurrentResult.output.structuredContent).toMatchObject({
      data: {
        closed: true,
        sessionId: 'session-current',
        transportInvalidated: true,
        allowFurtherCallsOnSameTransport: false,
      },
    });
    expect(closeSession).toHaveBeenCalledWith('session-current', { allowCurrent: true });
  });

  it('creates, updates, and deletes profiles through the profile gateway', async () => {
    const createProfile = vi.fn().mockResolvedValue({
      id: 'profile-new',
      name: 'Shop QA',
      runtimeId: 'chromium-extension-relay',
      status: 'idle',
      partition: 'persist:profile-new',
      isSystem: false,
    });
    const updateProfile = vi.fn().mockResolvedValue({
      id: 'profile-new',
      name: 'Shop QA Updated',
      runtimeId: 'electron-webcontents',
      status: 'idle',
      partition: 'persist:profile-new',
      isSystem: false,
    });
    const deleteProfile = vi.fn().mockResolvedValue(undefined);

    const executor = createCompatExecutor({
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => null,
        resolveProfile: async () => null,
        createProfile,
        updateProfile,
        deleteProfile,
      },
    });

    const createArgs = {
      name: 'Shop QA',
      runtimeId: 'chromium-extension-relay',
    };
    const createResult = await executor.invokeApi({
      name: 'profile_create',
      arguments: createArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['profile.write'],
        confirmationGrant: createTestGrant('profile_create', createArgs, {
          scopes: ['profile.write'],
        }),
      },
    });
    expect(createResult.ok).toBe(true);
    expect(createResult.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-new',
        created: true,
        profile: {
          id: 'profile-new',
        },
      },
      recommendedNextTools: ['session_prepare', 'system_bootstrap'],
    });

    const updateArgs = {
      profileId: 'profile-new',
      runtimeId: 'electron-webcontents',
      allowRuntimeReset: true,
    };
    const updateResult = await executor.invokeApi({
      name: 'profile_update',
      arguments: updateArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['profile.write'],
        confirmationGrant: createTestGrant('profile_update', updateArgs, {
          scopes: ['profile.write'],
          grantId: 'grant-profile-update',
        }),
      },
    });
    expect(updateResult.ok).toBe(true);
    expect(updateResult.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-new',
        updated: true,
        runtimeResetExpected: true,
      },
    });

    const deleteArgs = {
      profileId: 'profile-new',
    };
    const deleteResult = await executor.invokeApi({
      name: 'profile_delete',
      arguments: deleteArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['profile.write'],
        confirmationGrant: createTestGrant('profile_delete', deleteArgs, {
          scopes: ['profile.write'],
          grantId: 'grant-profile-delete',
        }),
      },
    });
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-new',
        deleted: true,
      },
      recommendedNextTools: ['system_bootstrap', 'profile_list'],
    });

    expect(createProfile).toHaveBeenCalledWith({
      name: 'Shop QA',
      runtimeId: 'chromium-extension-relay',
    });
    expect(updateProfile).toHaveBeenCalledWith('profile-new', {
      runtimeId: 'electron-webcontents',
    });
    expect(deleteProfile).toHaveBeenCalledWith('profile-new');
  });

  it('rejects runtime-affecting profile updates without explicit runtime reset confirmation', async () => {
    const updateProfile = vi.fn().mockResolvedValue({
      id: 'profile-new',
      name: 'Shop QA Updated',
      runtimeId: 'electron-webcontents',
      status: 'idle',
      partition: 'persist:profile-new',
      isSystem: false,
    });
    const executor = createCompatExecutor({
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => null,
        resolveProfile: async () => null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          runtimeId: 'chromium-extension-relay',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile,
        deleteProfile: async () => undefined,
      },
    });

    const updateArgs = {
      profileId: 'profile-new',
      runtimeId: 'electron-webcontents',
    };
    const result = await executor.invokeApi({
      name: 'profile_update',
      arguments: updateArgs,
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['profile.write'],
        confirmationGrant: createTestGrant('profile_update', updateArgs, {
          scopes: ['profile.write'],
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.INVALID_PARAMETER);
    expect(String(result.error?.message || '')).toContain('allowRuntimeReset=true');
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('prefers browser native withAbortSignal facades for canonical browser capabilities', async () => {
    const nativeSnapshot = vi.fn().mockResolvedValue(createSnapshot());
    const fallbackSnapshot = vi.fn().mockResolvedValue(createSnapshot());
    const controller = new AbortController();
    const withAbortSignal = vi.fn().mockReturnValue(
      createMockBrowser({
        snapshot: nativeSnapshot,
      })
    );

    const executor = createCompatExecutor({
      browser: createMockBrowser({
        withAbortSignal,
        snapshot: fallbackSnapshot,
      }),
    });

    const result = await executor.invokeApi(
      {
        name: 'browser_snapshot',
        arguments: {},
      },
      {
        signal: controller.signal,
      }
    );

    expect(result.ok).toBe(true);
    expect(withAbortSignal).toHaveBeenCalledWith(controller.signal);
    expect(nativeSnapshot).toHaveBeenCalledTimes(1);
    expect(fallbackSnapshot).not.toHaveBeenCalled();
  });
});
