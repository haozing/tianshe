import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import { buildProfileResourceKey, resourceCoordinator } from '../core/resource-coordinator';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import {
  MCP_PROTOCOL_ALLOWED_VERSIONS,
  MCP_PROTOCOL_COMPATIBILITY_MODE,
  MCP_PROTOCOL_UNIFIED_VERSION,
} from '../constants/mcp-protocol';
import { MCP_PUBLIC_TOOL_NAMES } from './mcp-catalog-metadata';
import { ErrorCode } from '../types/error-codes';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { BrowserInterface } from '../types/browser-interface';
import { AirpaHttpMcpServer } from './mcp-server-http';

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

function isFetchSafePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536 && !FETCH_FORBIDDEN_PORTS.has(port);
}

function createSnapshotResult(url = 'https://example.com', title = 'Example') {
  return {
    url,
    title,
    elements: [],
  };
}

function createMockBrowser(overrides: Partial<BrowserInterface> = {}): BrowserInterface {
  return {
    goto: vi.fn(),
    snapshot: vi.fn().mockResolvedValue(createSnapshotResult()),
    click: vi.fn(),
    type: vi.fn(),
    evaluate: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
    getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
    ...overrides,
  } as BrowserInterface;
}

function createMockHandle(browser: BrowserInterface): {
  handle: BrowserHandle;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn().mockResolvedValue({
    browserId: 'browser-1',
    sessionId: 'pool-session-1',
    remainingBrowserCount: 0,
    state: 'idle',
  });
  const handle = {
    browser,
    browserId: 'browser-1',
    sessionId: 'pool-session-1',
    engine: 'extension',
    release,
    renew: vi.fn().mockResolvedValue(true),
  } as unknown as BrowserHandle;
  return { handle, release };
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start <= timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error('waitForAssertion timeout');
}

async function postJson(
  baseUrl: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(headers || {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function getJson(
  baseUrl: string,
  path: string,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: headers || {},
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function deleteJson(
  baseUrl: string,
  path: string,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: headers || {},
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function initializeMcpSession(
  baseUrl: string,
  headers?: Record<string, string>
): Promise<{ status: number; json: any; sessionId: string }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      ...(headers || {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-mcp-init', version: '1.0.0' },
      },
    }),
  });

  const json = await response.json();
  return {
    status: response.status,
    json,
    sessionId: String(response.headers.get('mcp-session-id') || ''),
  };
}

async function callMcpToolRaw(
  baseUrl: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> {
  return postJson(
    baseUrl,
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    },
    {
      accept: 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      'mcp-session-id': sessionId,
      ...(headers || {}),
    }
  );
}

function pickRuntimeFingerprint(value: any) {
  return {
    processStartTime: value?.processStartTime ?? null,
    mainDistUpdatedAt: value?.mainDistUpdatedAt ?? null,
    rendererDistUpdatedAt: value?.rendererDistUpdatedAt ?? null,
    mainBuildStamp: value?.mainBuildStamp ?? null,
    mcpRuntimeFreshness: value?.mcpRuntimeFreshness ?? null,
    buildFreshness: value?.buildFreshness ?? null,
    gitCommit: value?.gitCommit ?? null,
    mcpSdk: value?.mcpSdk ?? null,
  };
}

function expectRuntimeFingerprintLike(value: any): void {
  expect(typeof value?.processStartTime).toBe('string');
  expect(value?.mcpRuntimeFreshness).toMatchObject({
    overall: expect.any(String),
    main: expect.objectContaining({
      ok: expect.any(Boolean),
      reason: expect.any(String),
    }),
  });
  expect(value?.buildFreshness).toMatchObject({
    overall: expect.any(String),
    main: expect.objectContaining({
      ok: expect.any(Boolean),
      reason: expect.any(String),
    }),
    renderer: expect.objectContaining({
      ok: expect.any(Boolean),
      reason: expect.any(String),
    }),
  });
  expect(value?.mainDistUpdatedAt === null || typeof value?.mainDistUpdatedAt === 'string').toBe(
    true
  );
  expect(
    value?.rendererDistUpdatedAt === null || typeof value?.rendererDistUpdatedAt === 'string'
  ).toBe(true);
  expect(
    value?.mainBuildStamp === null ||
      (value?.mainBuildStamp?.schema === 'airpa.main.build-stamp.v1' &&
        value?.mainBuildStamp?.success === true &&
        typeof value?.mainBuildStamp?.builtAt === 'string' &&
        typeof value?.mainBuildStamp?.entryPoint === 'string' &&
        typeof value?.mainBuildStamp?.entryPointUpdatedAt === 'string')
  ).toBe(true);
  expect(value?.gitCommit === null || typeof value?.gitCommit === 'string').toBe(true);
  expect(value?.mcpSdk).toMatchObject({
    version: expect.any(String),
    initializeShimMode: expect.any(String),
    degraded: expect.any(Boolean),
    fingerprintInjected: expect.any(Boolean),
  });
  expect(
    value?.mcpSdk?.initializeShimReason === null ||
      typeof value?.mcpSdk?.initializeShimReason === 'string'
  ).toBe(true);
}

function expectInitializeInstructionsLike(value: any): void {
  expect(typeof value?.instructions).toBe('string');
  expect(String(value.instructions)).toContain('system_bootstrap');
  expect(String(value.instructions)).toContain('session_prepare');
  expect(String(value.instructions)).toContain('browser_observe');
  expect(String(value.instructions)).toContain('browser_act');
  expect(String(value.instructions)).toContain('session_end_current');
  expect(String(value.instructions)).not.toContain('toolProfile=full');
  expect(String(value.instructions)).not.toContain('browser_act waitFor');
}

function pickSessionSnapshot(value: any) {
  return {
    sessionId: value?.sessionId ?? null,
    profileId: value?.profileId ?? null,
    engine: value?.engine ?? null,
    visible: value?.visible ?? false,
    browserAcquired: value?.browserAcquired ?? false,
    browserAcquireInProgress: value?.browserAcquireInProgress ?? false,
    effectiveScopes: Array.isArray(value?.effectiveScopes) ? value.effectiveScopes : [],
    closing: value?.closing ?? false,
    terminateAfterResponse: value?.terminateAfterResponse ?? false,
    hostWindowId: value?.hostWindowId ?? null,
    viewportHealth: value?.viewportHealth ?? 'unknown',
    viewportHealthReason: value?.viewportHealthReason ?? null,
    interactionReady: value?.interactionReady ?? false,
    offscreenDetected: value?.offscreenDetected ?? false,
    engineRuntimeDescriptor: value?.engineRuntimeDescriptor ?? null,
    browserRuntimeDescriptor: value?.browserRuntimeDescriptor ?? null,
    resolvedRuntimeDescriptor: value?.resolvedRuntimeDescriptor ?? null,
  };
}

describe('AirpaHttpMcpServer orchestration REST routes', () => {
  const originalBindAddress = HTTP_SERVER_DEFAULTS.BIND_ADDRESS;
  let server: AirpaHttpMcpServer | undefined;
  let mcpClient: Client | undefined;
  let mcpTransport: StreamableHTTPClientTransport | undefined;
  let baseUrl = '';
  let acquire: ReturnType<typeof vi.fn> | undefined;
  let release: ReturnType<typeof vi.fn> | undefined;

  async function startServer(
    browser: BrowserInterface,
    options: {
      enableMcp?: boolean;
      restApiConfig?: Partial<RestApiConfig>;
      dependencies?: RestApiDependencies;
      acquireImplementation?: (handle: BrowserHandle) => Promise<BrowserHandle>;
      poolManagerOverrides?: Partial<BrowserPoolManager>;
    } = {}
  ): Promise<void> {
    // Pin IPv4 localhost for Windows CI/local environments where ::1 resolution can be flaky.
    (HTTP_SERVER_DEFAULTS as { BIND_ADDRESS: string }).BIND_ADDRESS = '127.0.0.1';

    const handleResult = createMockHandle(browser);
    release = handleResult.release;
    acquire = options.acquireImplementation
      ? vi.fn().mockImplementation(() => options.acquireImplementation!(handleResult.handle))
      : vi.fn().mockResolvedValue(handleResult.handle);

    const poolManager = {
      acquire,
      listBrowsers: vi.fn().mockReturnValue([]),
      ...(options.poolManagerOverrides || {}),
    } as unknown as BrowserPoolManager;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      server = new AirpaHttpMcpServer(
        { port: 0, name: 'test-http-mcp', version: 'test' },
        options.dependencies,
        {
          enableAuth: false,
          enableMcp: options.enableMcp ?? false,
          ...(options.restApiConfig || {}),
        },
        () => poolManager
      );

      await server.start();
      const address = (
        server as unknown as { httpServer: HttpServer | null }
      ).httpServer?.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve HTTP address');
      }

      if (isFetchSafePort(address.port)) {
        baseUrl = `http://127.0.0.1:${address.port}`;
        return;
      }

      await server.stop();
      server = undefined;
    }

    throw new Error('Failed to allocate a fetch-safe HTTP port for MCP tests');
  }

  afterEach(async () => {
    if (mcpClient) {
      await mcpClient.close();
    }
    if (mcpTransport) {
      await mcpTransport.close();
    }
    if (server) {
      await server.stop();
    }
    (HTTP_SERVER_DEFAULTS as { BIND_ADDRESS: string }).BIND_ADDRESS = originalBindAddress;
    mcpClient = undefined;
    mcpTransport = undefined;
    server = undefined;
    baseUrl = '';
    acquire = undefined;
    release = undefined;
    vi.clearAllMocks();
  });

  it('returns orchestration capabilities list', async () => {
    await startServer(createMockBrowser());

    const response = await getJson(baseUrl, '/api/v1/orchestration/capabilities');
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
    expect(Array.isArray(response.json.data)).toBe(true);

    const names = response.json.data.map((item: { name: string }) => item.name);
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('system_get_health');
    expect(names).toContain('plugin_list');
    expect(names).toContain('plugin_reload');
    expect(names).toContain('dataset_create_empty');
    expect(names).not.toContain('browser_get_url');
  });

  it('invokes dataset and cross-plugin capabilities through HTTP orchestration', async () => {
    const listDatasets = vi.fn().mockResolvedValue([{ id: 'dataset_1', name: 'Orders' }]);
    const callApi = vi.fn().mockResolvedValue({
      success: true,
      data: { message: 'pong' },
    });

    await startServer(createMockBrowser(), {
      dependencies: {
        datasetGateway: {
          listDatasets,
          getDatasetInfo: vi.fn().mockResolvedValue({ id: 'dataset_1', name: 'Orders' }),
          queryDataset: vi
            .fn()
            .mockResolvedValue({ columns: ['id'], rows: [{ id: 1 }], rowCount: 1 }),
          createEmptyDataset: vi.fn().mockResolvedValue('dataset_new'),
          importDatasetFile: vi.fn().mockResolvedValue('dataset_imported'),
          renameDataset: vi.fn().mockResolvedValue(undefined),
          deleteDataset: vi.fn().mockResolvedValue(undefined),
        },
        crossPluginGateway: {
          listCallableApis: vi.fn().mockReturnValue([]),
          callApi,
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const datasetInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'dataset_list',
      arguments: {},
    });
    expect(datasetInvoke.status).toBe(404);
    expect(datasetInvoke.json.success).toBe(false);
    expect(datasetInvoke.json.code).toBe(ErrorCode.NOT_FOUND);
    expect(listDatasets).not.toHaveBeenCalled();

    const crossPluginInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'cross_plugin_call_api',
      arguments: {
        pluginId: 'plugin-a',
        apiName: 'ping',
        params: [{ foo: 'bar' }],
      },
    });
    expect(crossPluginInvoke.status).toBe(404);
    expect(crossPluginInvoke.json.success).toBe(false);
    expect(crossPluginInvoke.json.code).toBe(ErrorCode.NOT_FOUND);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('observation capabilities can be invoked through the orchestration control plane', async () => {
    const getTraceSummary = vi.fn().mockResolvedValue({
      traceId: 'trace-http-observation',
      eventCount: 2,
      artifactCount: 1,
      finalStatus: 'failed',
      entities: {
        capability: 'browser_snapshot',
        source: 'http',
      },
      recentArtifacts: [
        {
          artifactId: 'artifact-http-1',
          type: 'snapshot',
          timestamp: 1_700_000_000_000,
        },
      ],
    });

    await startServer(createMockBrowser(), {
      dependencies: {
        observationGateway: {
          getTraceSummary,
          getFailureBundle: vi.fn().mockResolvedValue({
            traceId: 'trace-http-observation',
            recentEvents: [],
            artifactRefs: [],
          }),
          getTraceTimeline: vi.fn().mockResolvedValue({
            traceId: 'trace-http-observation',
            finalStatus: 'failed',
            events: [],
            artifactRefs: [],
          }),
          searchRecentFailures: vi.fn().mockResolvedValue([]),
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const invoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'observation_get_trace_summary',
      arguments: {
        traceId: 'trace-http-observation',
      },
    });

    expect(invoke.status).toBe(200);
    expect(invoke.json.success).toBe(true);
    expect(invoke.json.data.output.structuredContent).toMatchObject({
      data: {
        traceId: 'trace-http-observation',
        finalStatus: 'failed',
      },
      recommendedNextTools: ['observation_get_failure_bundle'],
    });
    expect(getTraceSummary).toHaveBeenCalledWith('trace-http-observation');
  });

  it('system capabilities can be invoked through the orchestration control plane', async () => {
    const authHeaders = {
      authorization: 'Bearer system-token',
    };
    await startServer(createMockBrowser(), {
      enableMcp: true,
      restApiConfig: {
        enableAuth: true,
        token: 'system-token',
        mcpRequireAuth: false,
        enforceOrchestrationScopes: true,
        orchestrationIdempotencyStore: 'duckdb',
      },
    });

    const createResponse = await postJson(
      baseUrl,
      '/api/v1/orchestration/sessions',
      {},
      authHeaders
    );
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const invoke = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'system_get_health',
        arguments: {},
      },
      {
        ...authHeaders,
        'x-airpa-scopes': 'system.read',
      }
    );

    expect(invoke.status).toBe(200);
    expect(invoke.json.success).toBe(true);
    expect(invoke.json.data.output.structuredContent).toMatchObject({
      data: {
        status: expect.any(String),
        mcpEnabled: true,
        authEnabled: true,
        enforceOrchestrationScopes: true,
        orchestrationIdempotencyStore: 'duckdb',
      },
      recommendedNextTools: ['system_bootstrap'],
    });
  });

  it('plugin capabilities can be invoked through the orchestration control plane', async () => {
    const listPlugins = vi.fn().mockResolvedValue([
      {
        id: 'plugin-a',
        name: 'Plugin A',
        version: '1.0.0',
        author: 'Airpa',
        installedAt: 1_700_000_000_000,
        path: 'D:/plugins/plugin-a',
        enabled: true,
      },
      {
        id: 'plugin-b',
        name: 'Plugin B',
        version: '1.2.0',
        author: 'Airpa',
        installedAt: 1_700_000_000_100,
        path: 'D:/plugins/plugin-b',
        enabled: false,
      },
    ]);
    const getPlugin = vi.fn().mockImplementation(async (pluginId: string) =>
      pluginId === 'plugin-a'
        ? {
            id: 'plugin-a',
            name: 'Plugin A',
            version: '1.0.0',
            author: 'Airpa',
            installedAt: 1_700_000_000_000,
            path: 'D:/plugins/plugin-a',
            enabled: true,
          }
        : null
    );
    const listRuntimeStatuses = vi.fn().mockResolvedValue([
      {
        pluginId: 'plugin-a',
        pluginName: 'Plugin A',
        lifecyclePhase: 'active',
        workState: 'idle',
        activeQueues: 0,
        runningTasks: 0,
        pendingTasks: 0,
        failedTasks: 0,
        cancelledTasks: 0,
        updatedAt: 1_700_000_000_200,
      },
      {
        pluginId: 'plugin-b',
        pluginName: 'Plugin B',
        lifecyclePhase: 'disabled',
        workState: 'idle',
        activeQueues: 0,
        runningTasks: 0,
        pendingTasks: 0,
        failedTasks: 0,
        cancelledTasks: 0,
        updatedAt: 1_700_000_000_300,
      },
    ]);
    const getRuntimeStatus = vi.fn().mockImplementation(async (pluginId: string) =>
      pluginId === 'plugin-a'
        ? {
            pluginId: 'plugin-a',
            pluginName: 'Plugin A',
            lifecyclePhase: 'active',
            workState: 'idle',
            activeQueues: 0,
            runningTasks: 0,
            pendingTasks: 0,
            failedTasks: 0,
            cancelledTasks: 0,
            updatedAt: 1_700_000_000_200,
          }
        : null
    );

    await startServer(createMockBrowser(), {
      dependencies: {
        pluginGateway: {
          listPlugins,
          getPlugin,
          listRuntimeStatuses,
          getRuntimeStatus,
          installPlugin: vi.fn().mockResolvedValue({
            pluginId: 'plugin-a',
            operation: 'installed',
            sourceType: 'local_path',
          }),
          reloadPlugin: vi.fn().mockResolvedValue(undefined),
          uninstallPlugin: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const listInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'plugin_list',
      arguments: {
        enabled: true,
      },
    });

    expect(listInvoke.status).toBe(200);
    expect(listInvoke.json.success).toBe(true);
    expect(listInvoke.json.data.output.structuredContent).toMatchObject({
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

    const runtimeInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'plugin_get_runtime_status',
      arguments: {
        pluginId: 'plugin-a',
      },
    });

    expect(runtimeInvoke.status).toBe(200);
    expect(runtimeInvoke.json.success).toBe(true);
    expect(runtimeInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        pluginId: 'plugin-a',
        status: {
          lifecyclePhase: 'active',
          workState: 'idle',
        },
      },
      recommendedNextTools: ['plugin_list', 'observation_get_trace_summary'],
    });
    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(listRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(getPlugin).toHaveBeenCalledWith('plugin-a');
    expect(getRuntimeStatus).toHaveBeenCalledWith('plugin-a');
  });

  it('plugin low-risk write capabilities can be invoked through the orchestration control plane', async () => {
    const reloadPlugin = vi.fn().mockResolvedValue(undefined);
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);

    await startServer(createMockBrowser(), {
      dependencies: {
        pluginGateway: {
          listPlugins: vi.fn().mockResolvedValue([]),
          getPlugin: vi.fn().mockResolvedValue({
            id: 'plugin-a',
            name: 'Plugin A',
            version: '1.0.0',
            author: 'Airpa',
            installedAt: 1_700_000_000_000,
            path: 'D:/plugins/plugin-a',
            enabled: true,
          }),
          listRuntimeStatuses: vi.fn().mockResolvedValue([]),
          getRuntimeStatus: vi.fn().mockResolvedValue(null),
          installPlugin: vi.fn().mockResolvedValue({
            pluginId: 'plugin-a',
            operation: 'installed',
            sourceType: 'local_path',
          }),
          reloadPlugin,
          uninstallPlugin,
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const reloadInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'plugin_reload',
      arguments: {
        pluginId: 'plugin-a',
      },
    });

    expect(reloadInvoke.status).toBe(200);
    expect(reloadInvoke.json.success).toBe(true);
    expect(reloadInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        pluginId: 'plugin-a',
        reloaded: true,
      },
      recommendedNextTools: ['plugin_get_runtime_status', 'observation_get_trace_summary'],
    });

    const uninstallInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'plugin_uninstall',
      arguments: {
        pluginId: 'plugin-a',
        deleteTables: false,
      },
    });

    expect(uninstallInvoke.status).toBe(200);
    expect(uninstallInvoke.json.success).toBe(true);
    expect(uninstallInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        pluginId: 'plugin-a',
        deleteTables: false,
        uninstalled: true,
      },
      recommendedNextTools: ['plugin_list', 'system_bootstrap'],
    });
    expect(reloadPlugin).toHaveBeenCalledWith('plugin-a');
    expect(uninstallPlugin).toHaveBeenCalledWith('plugin-a', { deleteTables: false });
  });

  it('plugin high-risk install capability can be invoked through the orchestration control plane', async () => {
    const installPlugin = vi.fn().mockResolvedValue({
      pluginId: 'plugin-a',
      operation: 'installed',
      sourceType: 'cloud_code',
    });

    await startServer(createMockBrowser(), {
      dependencies: {
        pluginGateway: {
          listPlugins: vi.fn().mockResolvedValue([]),
          getPlugin: vi.fn().mockResolvedValue({
            id: 'plugin-a',
            name: 'Plugin A',
            version: '1.0.0',
            author: 'Airpa',
            installedAt: 1_700_000_000_000,
            path: 'D:/plugins/plugin-a',
            enabled: true,
          }),
          listRuntimeStatuses: vi.fn().mockResolvedValue([]),
          getRuntimeStatus: vi.fn().mockResolvedValue(null),
          installPlugin,
          reloadPlugin: vi.fn().mockResolvedValue(undefined),
          uninstallPlugin: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const installInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'plugin_install',
      arguments: {
        sourceType: 'cloud_code',
        cloudPluginCode: 'plugin_a',
        confirmRisk: true,
      },
    });

    expect(installInvoke.status).toBe(200);
    expect(installInvoke.json.success).toBe(true);
    expect(installInvoke.json.data.output.structuredContent).toMatchObject({
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

  it('dataset low-risk write capabilities can be invoked through the orchestration control plane', async () => {
    const createEmptyDataset = vi.fn().mockResolvedValue('dataset-new');
    const renameDataset = vi.fn().mockResolvedValue(undefined);
    const deleteDataset = vi.fn().mockResolvedValue(undefined);

    await startServer(createMockBrowser(), {
      dependencies: {
        datasetGateway: {
          listDatasets: vi.fn().mockResolvedValue([]),
          getDatasetInfo: vi
            .fn()
            .mockResolvedValueOnce({ id: 'dataset-new', name: 'Leads Queue' })
            .mockResolvedValueOnce({ id: 'dataset-new', name: 'Leads Queue' })
            .mockResolvedValueOnce({ id: 'dataset-new', name: 'Qualified Leads' })
            .mockResolvedValueOnce({ id: 'dataset-new', name: 'Qualified Leads' }),
          queryDataset: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0 }),
          createEmptyDataset,
          importDatasetFile: vi.fn().mockResolvedValue('dataset-imported'),
          renameDataset,
          deleteDataset,
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const createInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'dataset_create_empty',
      arguments: {
        datasetName: 'Leads Queue',
        folderId: null,
      },
    });

    expect(createInvoke.status).toBe(200);
    expect(createInvoke.json.success).toBe(true);
    expect(createInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        datasetId: 'dataset-new',
        datasetName: 'Leads Queue',
        created: true,
      },
      recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    });

    const renameInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'dataset_rename',
      arguments: {
        datasetId: 'dataset-new',
        newName: 'Qualified Leads',
      },
    });

    expect(renameInvoke.status).toBe(200);
    expect(renameInvoke.json.success).toBe(true);
    expect(renameInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        datasetId: 'dataset-new',
        newName: 'Qualified Leads',
        renamed: true,
      },
    });

    const deleteInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'dataset_delete',
      arguments: {
        datasetId: 'dataset-new',
      },
    });

    expect(deleteInvoke.status).toBe(200);
    expect(deleteInvoke.json.success).toBe(true);
    expect(deleteInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        datasetId: 'dataset-new',
        deleted: true,
      },
    });
    expect(createEmptyDataset).toHaveBeenCalledWith('Leads Queue', { folderId: null });
    expect(renameDataset).toHaveBeenCalledWith('dataset-new', 'Qualified Leads');
    expect(deleteDataset).toHaveBeenCalledWith('dataset-new');
  });

  it('dataset high-risk import capability can be invoked through the orchestration control plane', async () => {
    const importDatasetFile = vi.fn().mockResolvedValue('dataset-imported');
    const tempDir = mkdtempSync(join(tmpdir(), 'airpa-http-dataset-'));
    const filePath = join(tempDir, 'orders.csv');
    writeFileSync(filePath, 'id\n1\n');

    await startServer(createMockBrowser(), {
      dependencies: {
        datasetGateway: {
          listDatasets: vi.fn().mockResolvedValue([]),
          getDatasetInfo: vi.fn().mockResolvedValue({ id: 'dataset-imported', name: 'Orders' }),
          queryDataset: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0 }),
          createEmptyDataset: vi.fn().mockResolvedValue('dataset-new'),
          importDatasetFile,
          renameDataset: vi.fn().mockResolvedValue(undefined),
          deleteDataset: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const importInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'dataset_import_file',
      arguments: {
        filePath,
        datasetName: 'Orders',
        confirmRisk: true,
      },
    });

    expect(importInvoke.status).toBe(200);
    expect(importInvoke.json.success).toBe(true);
    expect(importInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        datasetId: 'dataset-imported',
        datasetName: 'Orders',
        filePath,
        imported: true,
      },
      recommendedNextTools: ['system_bootstrap', 'observation_get_trace_summary'],
    });
    expect(importDatasetFile).toHaveBeenCalledWith(filePath, 'Orders', { folderId: undefined });
  });

  it('profile high-risk write capabilities can be invoked through the orchestration control plane', async () => {
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

    await startServer(createMockBrowser(), {
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockResolvedValue(null),
          resolveProfile: vi.fn().mockResolvedValue(null),
          createProfile,
          updateProfile,
          deleteProfile,
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const createInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'profile_create',
      arguments: {
        name: 'Shop QA',
        engine: 'extension',
        confirmRisk: true,
      },
    });
    expect(createInvoke.status).toBe(200);
    expect(createInvoke.json.success).toBe(true);
    expect(createInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-new',
        created: true,
      },
      recommendedNextTools: ['session_prepare', 'system_bootstrap'],
    });

    const updateInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'profile_update',
      arguments: {
        profileId: 'profile-new',
        engine: 'electron',
        allowRuntimeReset: true,
        confirmRisk: true,
      },
    });
    expect(updateInvoke.status).toBe(200);
    expect(updateInvoke.json.success).toBe(true);
    expect(updateInvoke.json.data.output.structuredContent).toMatchObject({
      data: {
        profileId: 'profile-new',
        updated: true,
        runtimeResetExpected: true,
      },
    });

    const deleteInvoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'profile_delete',
      arguments: {
        profileId: 'profile-new',
        confirmDelete: true,
      },
    });
    expect(deleteInvoke.status).toBe(200);
    expect(deleteInvoke.json.success).toBe(true);
    expect(deleteInvoke.json.data.output.structuredContent).toMatchObject({
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

  it('閺?OpenClaw capabilities 缁旑垳鍋ｅ鑼╅梽銈呰嫙鏉╂柨娲?404', async () => {
    await startServer(createMockBrowser());

    const raw = await fetch(`${baseUrl}/api/v1/orchestration/capabilities/openclaw`);
    expect(raw.status).toBe(404);
  });

  it('v1 orchestration 鐠侯垳鏁遍崣顖滄暏', async () => {
    await startServer(createMockBrowser());

    const response = await getJson(baseUrl, '/api/v1/orchestration/capabilities');
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
  });

  it('閺?REST 鐠侯垳鏁卞鑼╅梽銈呰嫙鏉╂柨娲?404', async () => {
    await startServer(createMockBrowser());

    const endpoints = ['/api/datasets', '/api/plugins', '/api/cross-plugin/plugins'] as const;

    for (const endpoint of endpoints) {
      const response = await fetch(`${baseUrl}${endpoint}`);
      expect(response.status).toBe(404);
    }
  });

  it('includes API version headers', async () => {
    await startServer(createMockBrowser());

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-airpa-api-version')).toBe(HTTP_SERVER_DEFAULTS.API_VERSION);
    expect(response.headers.get('x-airpa-mcp-protocol-version')).toBe(MCP_PROTOCOL_UNIFIED_VERSION);
  });

  it('/health returns runtime flags', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      restApiConfig: {
        enableAuth: true,
        token: 'health-token',
        mcpRequireAuth: false,
        enforceOrchestrationScopes: true,
        orchestrationIdempotencyStore: 'duckdb',
      },
    });

    const response = await getJson(baseUrl, '/health');
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
    expect(response.json.data.authEnabled).toBe(true);
    expect(response.json.data.mcpConfigured).toBe(true);
    expect(response.json.data.mcpEnabled).toBe(true);
    expect(response.json.data.mcpRequireAuth).toBe(false);
    expect(response.json.data.mcpProtocolCompatibilityMode).toBe(MCP_PROTOCOL_COMPATIBILITY_MODE);
    expect(response.json.data.mcpProtocolVersion).toBe(MCP_PROTOCOL_UNIFIED_VERSION);
    expect(response.json.data.mcpSupportedProtocolVersions).toEqual(MCP_PROTOCOL_ALLOWED_VERSIONS);
    expect(response.json.data.mcpSdkSupportedProtocolVersions).toContain(
      MCP_PROTOCOL_UNIFIED_VERSION
    );
    expect(response.json.data).not.toHaveProperty('mcpDefaultToolProfile');
    expect(response.json.data).not.toHaveProperty('mcpRecommendedFullToolProfileUrl');
    expect(response.json.data.enforceOrchestrationScopes).toBe(true);
    expect(response.json.data.orchestrationIdempotencyStore).toBe('duckdb');
    expect(response.json.data.queueDepth).toMatchObject({
      mcpPending: 0,
      mcpActive: 0,
      orchestrationPending: 0,
      orchestrationActive: 0,
    });
    expect(response.json.data.runtimeCounters).toMatchObject({
      queueOverflowCount: 0,
      invokeTimeoutCount: 0,
      browserAcquireFailureCount: 0,
      browserAcquireTimeoutCount: 0,
    });
    expect(response.json.data.sessionLeakRisk).toMatchObject({
      staleMcpSessions: 0,
      staleOrchestrationSessions: 0,
      totalStaleSessions: 0,
    });
    expect(response.json.data.sessionCleanupPolicy).toMatchObject({
      defaultIdleTimeoutMs: 30 * 60 * 1000,
      idleWithoutBrowserTimeoutMs: 5 * 60 * 1000,
      closingSessionGraceTimeoutMs: 15 * 1000,
    });
    expect(Array.isArray(response.json.data.runtimeAlerts)).toBe(true);
    expectRuntimeFingerprintLike(response.json.data);
    expect(response.json.data.mcpSdk.initializeShimMode).toBe('private_slot');
    expect(response.json.data.mcpSdk.degraded).toBe(false);
    expect(response.json.data.mcpSdk.fingerprintInjected).toBe(true);
  });

  it('OpenAPI 婵傛垹瀹抽弬鍥︽閸欘垵袙閺嬫劕鑻熼崠鍛儓 v1 orchestration 閸忔娊鏁捄顖氱窞', async () => {
    const raw = readFileSync('src/main/schemas/orchestration-openapi-v1.json', 'utf8');
    const doc = JSON.parse(raw) as {
      openapi: string;
      paths: Record<string, unknown>;
      info: { version: string };
    };

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(HTTP_SERVER_DEFAULTS.API_VERSION);
    expect(Object.keys(doc.paths)).toContain('/api/v1/orchestration/invoke');
    expect(Object.keys(doc.paths)).toContain(
      '/api/v1/orchestration/sessions/{sessionId}/heartbeat'
    );
    const invokePost = doc.paths['/api/v1/orchestration/invoke'] as {
      post?: { responses?: Record<string, unknown> };
    };
    expect(Object.keys(invokePost.post?.responses || {})).toContain('409');
  });
});
