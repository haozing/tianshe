import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, createStructuredError } from '../../../types/error-codes';
import type { BrowserInterface } from '../../../types/browser-interface';
import { setObservationSink } from '../../observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../../observability/types';
import {
  createOrchestrationExecutor,
  listOrchestrationCapabilities,
} from './capability-registry';

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

describe('orchestration capability registry', () => {
  afterEach(() => {
    setObservationSink(null);
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
        'dataset_create_empty',
        'dataset_delete',
        'dataset_import_file',
        'dataset_rename',
        'observation_get_failure_bundle',
        'observation_get_trace_timeline',
        'observation_get_trace_summary',
        'observation_search_recent_failures',
        'plugin_install',
        'plugin_reload',
        'plugin_get_runtime_status',
        'plugin_list',
        'plugin_uninstall',
        'profile_create',
        'profile_delete',
        'profile_list',
        'profile_resolve',
        'profile_update',
        'system_bootstrap',
        'system_get_health',
        'session_end_current',
        'session_get_current',
        'session_prepare',
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
    const executor = createOrchestrationExecutor({});
    for (const capability of listOrchestrationCapabilities()) {
      expect(executor.hasCapability(capability.name)).toBe(true);
    }

    expect(executor.hasCapability('browser_get_url')).toBe(false);
    expect(executor.hasCapability('dataset_list')).toBe(false);
    expect(executor.hasCapability('session_close')).toBe(false);
  });

  it('reads trace summaries through the observation gateway', async () => {
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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

    const result = await executor.invokeApi({
      name: 'plugin_install',
      arguments: {
        sourceType: 'cloud_code',
        cloudPluginCode: 'plugin_a',
        confirmRisk: true,
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
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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

    const result = await executor.invokeApi({
      name: 'dataset_import_file',
      arguments: {
        filePath: existingFilePath,
        datasetName: 'Orders',
        confirmRisk: true,
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

  it('returns NOT_FOUND for unknown capabilities', async () => {
    const executor = createOrchestrationExecutor({});
    const result = await executor.invokeApi({
      name: 'unknown_capability',
      arguments: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.NOT_FOUND);
    expect(typeof result._meta?.traceId).toBe('string');
  });

  it('invokes browser_snapshot successfully on the canonical surface', async () => {
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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

    const executor = createOrchestrationExecutor({
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
    const snapshot = vi.fn().mockImplementation(() => new Promise<ReturnType<typeof createSnapshot>>(() => {}));
    const controller = new AbortController();
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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
    const executor = createOrchestrationExecutor({
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

  it('passes through protocol trace ids on canonical capabilities', async () => {
    const executor = createOrchestrationExecutor({
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

    const executor = createOrchestrationExecutor({
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
      sink.events.filter((event) => event.event.startsWith('capability.invoke')).map((event) => event.event)
    ).toEqual(['capability.invoke.started', 'capability.invoke.succeeded']);
    expect(sink.events.every((event) => event.traceId === 'trace-observation-capability')).toBe(
      true
    );
  });

  it('records system and session domain events on the shared trace', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const executor = createOrchestrationExecutor({
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
      sink.events.filter((event) => event.event.startsWith('system.bootstrap')).map((event) => event.event)
    ).toEqual(['system.bootstrap.started', 'system.bootstrap.succeeded']);
    expect(
      sink.events
        .filter((event) => event.event.startsWith('session.lifecycle.prepare'))
        .map((event) => event.event)
    ).toEqual(['session.lifecycle.prepare.started', 'session.lifecycle.prepare.succeeded']);
  });

  it('lists and resolves canonical profile capabilities', async () => {
    const executor = createOrchestrationExecutor({
      profileGateway: {
        listProfiles: async () => [
          {
            id: 'profile-1',
            name: '555',
            engine: 'electron',
            status: 'idle',
            partition: 'persist:profile-1',
          },
          {
            id: 'profile-2',
            name: 'marketing',
            engine: 'extension',
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
                  engine: 'electron',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              }
            : null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          engine: 'electron',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile: async () => ({
          id: 'profile-1',
          name: '555',
          engine: 'electron',
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

  it('supports canonical current-session inspection, preparation, and teardown', async () => {
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-current',
      prepared: true,
      idempotent: false,
      profileId: 'profile-1',
      engine: 'electron',
      visible: false,
      effectiveScopes: ['browser.read', 'browser.write'],
      browserAcquired: false,
      phase: 'prepared_unacquired',
      bindingLocked: false,
      changed: ['profile', 'engine', 'visible', 'scopes'],
    });
    const closeSession = vi.fn().mockResolvedValue({
      closed: true,
      closedCurrentSession: true,
      transportInvalidated: true,
      allowFurtherCallsOnSameTransport: false,
      terminationTiming: 'after_response_flush' as const,
    });

    const executor = createOrchestrationExecutor({
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-current',
        listSessions: async () => [
          {
            sessionId: 'session-current',
            profileId: 'profile-1',
            engine: 'electron',
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
                  engine: 'electron',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              }
            : null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          engine: 'electron',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile: async () => ({
          id: 'profile-1',
          name: '555',
          engine: 'electron',
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
        engine: 'electron',
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
          engine: 'electron',
          source: 'resolved_query',
        },
        effectiveEngine: 'electron',
        effectiveEngineSource: 'requested',
        phase: 'prepared_unacquired',
        bindingLocked: false,
      },
    });
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-1',
      engine: 'electron',
      visible: false,
      scopes: ['browser.read', 'browser.write'],
    });

    const endCurrentResult = await executor.invokeApi({
      name: 'session_end_current',
      arguments: {},
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
      engine: 'extension',
      status: 'idle',
      partition: 'persist:profile-new',
      isSystem: false,
    });
    const updateProfile = vi.fn().mockResolvedValue({
      id: 'profile-new',
      name: 'Shop QA Updated',
      engine: 'electron',
      status: 'idle',
      partition: 'persist:profile-new',
      isSystem: false,
    });
    const deleteProfile = vi.fn().mockResolvedValue(undefined);

    const executor = createOrchestrationExecutor({
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => null,
        resolveProfile: async () => null,
        createProfile,
        updateProfile,
        deleteProfile,
      },
    });

    const createResult = await executor.invokeApi({
      name: 'profile_create',
      arguments: {
        name: 'Shop QA',
        engine: 'extension',
        confirmRisk: true,
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

    const updateResult = await executor.invokeApi({
      name: 'profile_update',
      arguments: {
        profileId: 'profile-new',
        engine: 'electron',
        allowRuntimeReset: true,
        confirmRisk: true,
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

    const deleteResult = await executor.invokeApi({
      name: 'profile_delete',
      arguments: {
        profileId: 'profile-new',
        confirmDelete: true,
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
      engine: 'extension',
    });
    expect(updateProfile).toHaveBeenCalledWith('profile-new', {
      engine: 'electron',
    });
    expect(deleteProfile).toHaveBeenCalledWith('profile-new');
  });

  it('rejects runtime-affecting profile updates without explicit runtime reset confirmation', async () => {
    const updateProfile = vi.fn().mockResolvedValue({
      id: 'profile-new',
      name: 'Shop QA Updated',
      engine: 'electron',
      status: 'idle',
      partition: 'persist:profile-new',
      isSystem: false,
    });
    const executor = createOrchestrationExecutor({
      profileGateway: {
        listProfiles: async () => [],
        getProfile: async () => null,
        resolveProfile: async () => null,
        createProfile: async () => ({
          id: 'profile-new',
          name: 'Shop QA',
          engine: 'extension',
          status: 'idle',
          partition: 'persist:profile-new',
          isSystem: false,
        }),
        updateProfile,
        deleteProfile: async () => undefined,
      },
    });

    const result = await executor.invokeApi({
      name: 'profile_update',
      arguments: {
        profileId: 'profile-new',
        engine: 'electron',
        confirmRisk: true,
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

    const executor = createOrchestrationExecutor({
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
