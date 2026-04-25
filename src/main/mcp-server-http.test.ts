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
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
  102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427,
  465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
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
  expect(value?.mainDistUpdatedAt === null || typeof value?.mainDistUpdatedAt === 'string').toBe(true);
  expect(value?.rendererDistUpdatedAt === null || typeof value?.rendererDistUpdatedAt === 'string').toBe(
    true
  );
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
  expect(value?.mcpSdk?.initializeShimReason === null || typeof value?.mcpSdk?.initializeShimReason === 'string').toBe(
    true
  );
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

describe('AirpaHttpMcpServer orchestration routes', () => {
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
      const address = (server as unknown as { httpServer: HttpServer | null }).httpServer?.address();
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

  it('杩斿洖 orchestration capabilities 鍒楄〃', async () => {
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

  it('dataset/cross-plugin 鑳藉姏鍙€氳繃 HTTP 缂栨帓鍏ュ彛璋冪敤', async () => {
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
          queryDataset: vi.fn().mockResolvedValue({ columns: ['id'], rows: [{ id: 1 }], rowCount: 1 }),
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

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {}, authHeaders);
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

  it('鏃?OpenClaw capabilities 绔偣宸茬Щ闄ゅ苟杩斿洖 404', async () => {
    await startServer(createMockBrowser());

    const raw = await fetch(`${baseUrl}/api/v1/orchestration/capabilities/openclaw`);
    expect(raw.status).toBe(404);
  });

  it('v1 orchestration 璺敱鍙敤', async () => {
    await startServer(createMockBrowser());

    const response = await getJson(baseUrl, '/api/v1/orchestration/capabilities');
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
  });

  it('鏃?REST 璺敱宸茬Щ闄ゅ苟杩斿洖 404', async () => {
    await startServer(createMockBrowser());

    const endpoints = [
      '/api/datasets',
      '/api/plugins',
      '/api/cross-plugin/plugins',
    ] as const;

    for (const endpoint of endpoints) {
      const response = await fetch(`${baseUrl}${endpoint}`);
      expect(response.status).toBe(404);
    }
  });

  it('鍝嶅簲澶村寘鍚?API 鐗堟湰', async () => {
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
    expect(response.json.data.mcpSdkSupportedProtocolVersions).toContain(MCP_PROTOCOL_UNIFIED_VERSION);
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

  it('OpenAPI 濂戠害鏂囦欢鍙В鏋愬苟鍖呭惈 v1 orchestration 鍏抽敭璺緞', async () => {
    const raw = readFileSync('src/main/schemas/orchestration-openapi-v1.json', 'utf8');
    const doc = JSON.parse(raw) as {
      openapi: string;
      paths: Record<string, unknown>;
      info: { version: string };
    };

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(HTTP_SERVER_DEFAULTS.API_VERSION);
    expect(Object.keys(doc.paths)).toContain('/api/v1/orchestration/invoke');
    expect(Object.keys(doc.paths)).toContain('/api/v1/orchestration/sessions/{sessionId}/heartbeat');
    const invokePost = doc.paths['/api/v1/orchestration/invoke'] as {
      post?: { responses?: Record<string, unknown> };
    };
    expect(Object.keys(invokePost.post?.responses || {})).toContain('409');
  });

  it('MCP ListTools keeps parity with orchestration capabilities', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const result = await mcpClient.listTools();
    const actualNames = result.tools.map((tool) => tool.name).sort();
    const expectedNames = [...MCP_PUBLIC_TOOL_NAMES].sort();

    expect(actualNames).toEqual(expectedNames);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('MCP ListTools 鍚嶇О蹇収绋冲畾锛堝绾﹀洖褰掞級', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-contract',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const result = await mcpClient.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...MCP_PUBLIC_TOOL_NAMES].sort());
  });

  it('MCP ListTools exposes title, annotations, inputSchema and outputSchema for model-friendly clients', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockResolvedValue(null),
          resolveProfile: vi.fn().mockResolvedValue(null),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    mcpClient = new Client({
      name: 'test-mcp-client-metadata',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const result = await mcpClient.listTools();
    const browserObserveTool = result.tools.find((tool) => tool.name === 'browser_observe');
    const browserActTool = result.tools.find((tool) => tool.name === 'browser_act');
    const sessionPrepareTool = result.tools.find((tool) => tool.name === 'session_prepare');
    const sessionEndCurrentTool = result.tools.find((tool) => tool.name === 'session_end_current');
    expect(sessionPrepareTool).toMatchObject({
      name: 'session_prepare',
      title: 'Session Prepare',
      annotations: expect.objectContaining({
        idempotentHint: true,
      }),
    });
    expect(sessionPrepareTool?.outputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        ok: expect.any(Object),
        summary: expect.any(Object),
        error: expect.any(Object),
      }),
      oneOf: expect.any(Array),
    });
    expect((sessionEndCurrentTool as any)?._meta?.['airpa/runtimeAvailability']).toMatchObject({
      status: 'available_with_notice',
      availableNow: true,
      reasonCode: 'current_session_end_current',
    });
    expect((sessionPrepareTool as any)?._meta?.['airpa/assistantGuidance']).toMatchObject({
      workflowStage: 'session',
      whenToUse: expect.stringContaining('Prepare the current MCP session'),
    });
    expect((sessionPrepareTool as any)?._meta?.['airpa/examples']).toEqual([
      expect.objectContaining({
        title: expect.any(String),
        arguments: expect.objectContaining({
          visible: false,
        }),
      }),
    ]);
    expect((browserActTool as any)?._meta?.['airpa/examples']).toEqual([
      expect.objectContaining({
        title: expect.any(String),
        arguments: expect.objectContaining({
          action: 'click',
        }),
      }),
    ]);
    expect((sessionPrepareTool as any)?._meta?.['airpa/runtimeAvailability']).toMatchObject({
      status: 'available',
      availableNow: true,
      preconditionsNow: expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('effectiveEngineSource'),
      ]),
      recommendedActions: expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('profile_engine_mismatch'),
      ]),
    });
    expect((sessionPrepareTool as any)?._meta?.['airpa/modelHints']).toMatchObject({
      readBeforeCall: expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('effectiveEngineSource'),
      ]),
      nextActions: expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('profile_engine_mismatch'),
      ]),
      authoritativeResultFields: [
        'structuredContent.data.effectiveProfile',
        'structuredContent.data.effectiveEngine',
        'structuredContent.data.effectiveEngineSource',
      ],
      failureCodes: expect.arrayContaining([
        expect.objectContaining({
          code: 'profile_engine_mismatch',
          remediation: expect.stringContaining('session_prepare'),
        }),
      ]),
      resultContract: expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('effectiveEngineSource'),
      ]),
      failureContract: expect.arrayContaining([
        expect.stringContaining('profile_engine_mismatch'),
      ]),
      commonMistakes: expect.arrayContaining([
        expect.objectContaining({
          mistake: expect.stringContaining('old transport headers'),
          correction: expect.stringContaining(
            'structuredContent.data.effectiveProfile, effectiveEngine, and effectiveEngineSource'
          ),
        }),
      ]),
      recommendedFlows: expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 30,
          strength: 'primary',
        }),
        expect.objectContaining({
          flow: 'session_reuse',
          order: 30,
          strength: 'primary',
        }),
      ]),
    });
    expect((browserObserveTool as any)?._meta?.['airpa/modelHints']).toMatchObject({
      readBeforeCall: expect.arrayContaining([expect.stringContaining('session_prepare')]),
      nextActions: expect.arrayContaining([
        expect.stringContaining('session_prepare'),
        expect.stringContaining('effectiveProfile'),
      ]),
      authoritativeSignals: expect.arrayContaining([
        'structuredContent.data.snapshot.elements[*].elementRef',
        'structuredContent.data.interactionReady',
        'structuredContent.data.viewportHealth',
        'structuredContent.data.offscreenDetected',
      ]),
      recommendedFlows: expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 40,
          strength: 'primary',
        }),
      ]),
    });
    expect((browserActTool as any)?._meta?.['airpa/modelHints']).toMatchObject({
      authoritativeSignals: expect.arrayContaining([
        'structuredContent.data.verified',
        'structuredContent.data.primaryEffect',
        'structuredContent.data.waitTarget',
        'structuredContent.data.afterUrl',
      ]),
      targetPriority: ['target.ref', 'target.selector', 'target.text'],
      commonMistakes: expect.arrayContaining([
        expect.objectContaining({
          mistake: 'Send waitFor on canonical browser_act requests.',
          correction: 'Use verify instead of waitFor on browser_act.',
        }),
        expect.objectContaining({
          mistake: expect.stringContaining('target.selector'),
          correction: expect.stringContaining('Prefer target.ref first'),
        }),
      ]),
      recommendedFlows: expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 70,
          strength: 'secondary',
        }),
      ]),
    });
    expect((sessionEndCurrentTool as any)?._meta?.['airpa/modelHints']).toMatchObject({
      resultContract: expect.arrayContaining([
        expect.stringContaining('invalidates the active transport'),
      ]),
    });
    expect(sessionPrepareTool?.outputSchema).toMatchObject({
      properties: {
        data: {
          properties: {
            effectiveProfile: expect.any(Object),
            effectiveEngine: expect.any(Object),
            effectiveEngineSource: expect.any(Object),
          },
        },
      },
    });
    expect(String(sessionPrepareTool?.description || '')).toContain('Prepare the current MCP session');
    expect(String(sessionPrepareTool?.description || '')).not.toContain('effectiveProfile');
    expect(String(sessionPrepareTool?.description || '')).not.toContain('profile_engine_mismatch');
    expect(String(sessionPrepareTool?.description || '')).not.toContain('Recommendation:');
    expect(String(browserActTool?.description || '')).not.toContain('Recommendation:');
    expect(String(browserActTool?.description || '')).not.toContain('Typical next tools:');
    expect(String(sessionPrepareTool?.description || '').split('\n').length).toBeLessThanOrEqual(2);
    expect(String(browserActTool?.description || '').split('\n').length).toBeLessThanOrEqual(2);
    expect(String(sessionEndCurrentTool?.description || '')).toContain(
      'The current transport will be invalidated after the response is flushed.'
    );
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...MCP_PUBLIC_TOOL_NAMES].sort());
  });

  it('MCP exposes one canonical public surface for tools, resources, guides, and prompts', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-canonical-surface',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...MCP_PUBLIC_TOOL_NAMES].sort());
    expect(tools.tools.map((tool) => tool.name)).not.toContain('browser_goto');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('browser_click');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('browser_type');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('browser_click_text');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('session_attach_profile');

    const resources = await mcpClient.listResources();
    const resourceUris = resources.resources.map((item) => item.uri);
    expect(resourceUris).toContain('airpa://mcp/guides/getting-started');
    expect(resourceUris).toContain('airpa://mcp/guides/login-pages');
    expect(resourceUris).toContain('airpa://mcp/guides/forms');
    expect(resourceUris).toContain('airpa://mcp/guides/lists');
    expect(resourceUris).toContain('airpa://mcp/guides/search-results');
    expect(resourceUris).toContain('airpa://mcp/guides/hidden-session-debug');
    expect(resourceUris).not.toContain('airpa://mcp/guides/session-reuse');
    expect(resourceUris).not.toContain('airpa://mcp/tools/session_attach_profile');

    const guide = await mcpClient.readResource({ uri: 'airpa://mcp/guides/getting-started' });
    const guideText = guide.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    expect(guideText).toContain('session_prepare');
    expect(guideText).toContain('browser_observe');
    expect(guideText).toContain('browser_act');
    expect(guideText).not.toContain('tool profile');
    expect(guideText).not.toContain('?toolProfile=full');
    expect(guideText).not.toContain('browser_act waitFor');

    const pageDebugPrompt = await mcpClient.getPrompt({
      name: 'airpa.page_debug',
      arguments: { issue: 'network request seems broken' },
    });
    const pageDebugText = pageDebugPrompt.messages
      .filter((item) => item.content.type === 'text')
      .map((item) => (item.content.type === 'text' ? item.content.text : ''))
      .join('\n');
    expect(pageDebugText).toContain('browser_debug_state');
    expect(pageDebugText).toContain('airpa://mcp/guides/hidden-session-debug');
    expect(pageDebugText).not.toContain('tool profile');
    expect(pageDebugText).not.toContain('?toolProfile=full');

    const hiddenSessionGuide = await mcpClient.readResource({
      uri: 'airpa://mcp/guides/hidden-session-debug',
    });
    const hiddenSessionGuideText = hiddenSessionGuide.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    expect(hiddenSessionGuideText).toContain('session_get_current');
    expect(hiddenSessionGuideText).toContain('browser_debug_state');
    expect(hiddenSessionGuideText).toContain('primaryEffect');
  });

  it('MCP rejects unsupported transport-level tool surface and session binding inputs', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'x-airpa-tool-profile': 'full',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'unsupported-transport-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      id?: number | null;
      error?: { code?: number; data?: { reason?: string; input?: string; hint?: string } };
    };
    expect(payload.id).toBe(1);
    expect(payload.error?.code).toBe(-32600);
    expect(payload.error?.data).toMatchObject({
      reason: 'unsupported_transport_input',
      input: 'x-airpa-tool-profile',
    });
    expect(payload.error?.data?.hint).toContain('session_prepare');
  });

  it('MCP rejects unsupported toolProfile query parameters for public /mcp access', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp?toolProfile=full`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'unsupported-query-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error?: { data?: { reason?: string; input?: string; hint?: string } };
    };
    expect(payload.error?.data).toMatchObject({
      reason: 'unsupported_transport_input',
      input: 'toolProfile',
    });
    expect(payload.error?.data?.hint).toContain('session_prepare');
  });

  it('MCP POST protocol-stage errors echo the original JSON-RPC request id for single requests', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-session-id': 'missing-session',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/list',
      }),
    });

    expect(response.status).toBe(404);
    const payload = (await response.json()) as {
      id?: number | null;
      error?: { message?: string };
    };
    expect(payload.id).toBe(42);
    expect(payload.error?.message).toBe('Session not found');
  });

  it('MCP rejects transport-level mcp-partition on initialize', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-partition': '555',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'unsupported-partition-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error?: { data?: { reason?: string; input?: string; hint?: string } };
    };
    expect(payload.error?.data).toMatchObject({
      reason: 'unsupported_transport_input',
      input: 'mcp-partition',
    });
    expect(payload.error?.data?.hint).toContain('session_prepare');
  });

  it('MCP rejects transport-level mcp-engine on initialize', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-engine': 'webkit',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'unsupported-engine-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error?: { data?: { reason?: string; input?: string; hint?: string } };
    };
    expect(payload.error?.data).toMatchObject({
      reason: 'unsupported_transport_input',
      input: 'mcp-engine',
    });
    expect(payload.error?.data?.hint).toContain('session_prepare');
  });

  it('MCP initialize 鍦?application/json Accept 涓嬭繑鍥炲彲瑙ｆ瀽 JSON锛堝吋瀹归潪 SSE 瀹㈡埛绔級', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'json-only-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('mcp-session-id')).toBeTruthy();
    const payload = (await response.json()) as {
      result?: { protocolVersion?: string; instructions?: string };
      jsonrpc?: string;
      id?: number;
    };
    expect(payload.jsonrpc).toBe('2.0');
    expect(payload.id).toBe(1);
    expect(payload.result?.protocolVersion).toBe(MCP_PROTOCOL_UNIFIED_VERSION);
    expectRuntimeFingerprintLike(payload.result);
    expectInitializeInstructionsLike(payload.result);
  });

  it('MCP initialize without request id is rejected for strict SDK-first clients', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'compat-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error?: { code?: number; data?: { reason?: string; hint?: string } };
      id?: null;
    };
    expect(payload.id).toBeNull();
    expect(payload.error?.code).toBe(-32600);
    expect(payload.error?.data?.reason).toBe('missing_initialize_request_id');
    expect(payload.error?.data?.hint).toContain('standard MCP SDK');
  });

  it('MCP initialize, catalog, and health expose the same runtime fingerprint', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expectRuntimeFingerprintLike(init.json.result);
    expectInitializeInstructionsLike(init.json.result);
    const initializeFingerprint = pickRuntimeFingerprint(init.json.result);

    mcpClient = new Client({
      name: 'test-mcp-client-runtime-fingerprint',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const catalog = await mcpClient.readResource({ uri: 'airpa://mcp/tools/catalog' });
    const catalogText = catalog.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    const catalogJson = JSON.parse(catalogText) as Record<string, unknown>;
    expectRuntimeFingerprintLike(catalogJson);
    expect(pickRuntimeFingerprint(catalogJson)).toEqual(initializeFingerprint);

    const health = await getJson(baseUrl, '/health');
    expect(health.status).toBe(200);
    expectRuntimeFingerprintLike(health.json.data);
    expect(pickRuntimeFingerprint(health.json.data)).toEqual(initializeFingerprint);
  });

  it('MCP resources discovery endpoints expose tool resources and templates', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockResolvedValue(null),
          resolveProfile: vi.fn().mockResolvedValue(null),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    mcpClient = new Client({
      name: 'test-mcp-client-resources',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const resources = await mcpClient.listResources();
    expect(resources.resources.length).toBeGreaterThan(0);
    const resourceUris = resources.resources.map((item) => item.uri);
    expect(resourceUris).toContain('airpa://mcp/tools/catalog');
    expect(resourceUris).toContain('airpa://mcp/tools/browser_observe');
    expect(resourceUris).toContain('airpa://mcp/guides/getting-started');
    expect(resourceUris).toContain('airpa://mcp/guides/login-pages');
    expect(resourceUris).toContain('airpa://mcp/guides/forms');
    expect(resourceUris).toContain('airpa://mcp/guides/lists');
    expect(resourceUris).toContain('airpa://mcp/guides/search-results');
    expect(resourceUris).toContain('airpa://mcp/guides/hidden-session-debug');
    expect(resourceUris).not.toContain('airpa://mcp/guides/session-reuse');

    const templates = await mcpClient.listResourceTemplates();
    expect(templates.resourceTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uriTemplate: 'airpa://mcp/tools/{toolName}',
          name: 'airpa.tool.detail',
        }),
      ])
    );

    const catalog = await mcpClient.readResource({ uri: 'airpa://mcp/tools/catalog' });
    const catalogText = catalog.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    expect(catalogText).toContain('browser_observe');
    const catalogJson = JSON.parse(catalogText) as {
      currentSession?: {
        browserAcquired?: boolean;
        effectiveScopes?: string[];
        closing?: boolean;
        terminateAfterResponse?: boolean;
      };
      prompts?: string[];
      guides?: string[];
      nextActionHints?: string[];
      tools?: Array<{
        name: string;
        description?: string;
        assistantGuidance?: { workflowStage?: string; whenToUse?: string };
        runtime?: { status?: string; reasonCode?: string };
        modelHints?: {
          readBeforeCall?: string[];
          nextActions?: string[];
          authoritativeResultFields?: string[];
          recommendedFlows?: Array<{
            flow?: string;
            order?: number;
            strength?: string;
          }>;
          failureCodes?: Array<{ code?: string; remediation?: string }>;
          commonMistakes?: Array<{ mistake?: string; correction?: string }>;
          resultContract?: string[];
          failureContract?: string[];
        };
      }>;
    };
    expect(catalogJson.currentSession?.browserAcquired).toBe(false);
    expect(catalogJson.currentSession?.effectiveScopes).toEqual([]);
    expect(catalogJson.currentSession?.closing).toBe(false);
    expect(catalogJson.currentSession?.terminateAfterResponse).toBe(false);
    expect(catalogJson.prompts).toEqual(
      expect.arrayContaining([
        'airpa.getting_started',
        'airpa.session_reuse',
        'airpa.page_debug',
      ])
    );
    expect(catalogJson.guides).toEqual(
      expect.arrayContaining([
        'airpa://mcp/guides/getting-started',
        'airpa://mcp/guides/login-pages',
        'airpa://mcp/guides/forms',
        'airpa://mcp/guides/lists',
        'airpa://mcp/guides/search-results',
        'airpa://mcp/guides/hidden-session-debug',
      ])
    );
    expect(catalogJson.nextActionHints).toEqual(
      expect.arrayContaining([
        expect.stringContaining('terminate the MCP session'),
        expect.stringContaining('session_end_current'),
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('effectiveEngine'),
        expect.stringContaining('browser_debug_state'),
      ])
    );
    expect(catalogJson.tools?.find((item) => item.name === 'browser_observe')?.runtime?.status).toBe(
      'available_with_notice'
    );
    expect(catalogJson.tools?.find((item) => item.name === 'session_prepare')?.assistantGuidance)
      .toMatchObject({
        workflowStage: 'session',
        whenToUse: expect.stringContaining('Prepare the current MCP session'),
      });
    expect(catalogJson.tools?.find((item) => item.name === 'session_prepare')?.modelHints).toMatchObject({
      readBeforeCall: expect.arrayContaining([expect.stringContaining('effectiveProfile')]),
      nextActions: expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('profile_engine_mismatch'),
      ]),
      authoritativeResultFields: [
        'structuredContent.data.effectiveProfile',
        'structuredContent.data.effectiveEngine',
        'structuredContent.data.effectiveEngineSource',
      ],
      failureCodes: expect.arrayContaining([
        expect.objectContaining({
          code: 'profile_engine_mismatch',
          remediation: expect.stringContaining('browser_* call'),
        }),
      ]),
      resultContract: expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('effectiveEngineSource'),
      ]),
      failureContract: expect.arrayContaining([
        expect.stringContaining('profile_engine_mismatch'),
      ]),
      commonMistakes: expect.arrayContaining([
        expect.objectContaining({
          mistake: expect.stringContaining('old transport headers'),
          correction: expect.stringContaining(
            'structuredContent.data.effectiveProfile, effectiveEngine, and effectiveEngineSource'
          ),
        }),
      ]),
      recommendedFlows: expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 30,
          strength: 'primary',
        }),
      ]),
    });
    expect(catalogJson.tools?.find((item) => item.name === 'browser_act')?.assistantGuidance)
      .toMatchObject({
        workflowStage: 'interaction',
        whenToUse: expect.stringContaining('high-level interaction entrypoint'),
      });
    expect(catalogJson.tools?.find((item) => item.name === 'browser_observe')?.modelHints).toMatchObject({
      readBeforeCall: expect.arrayContaining([expect.stringContaining('session_prepare')]),
      nextActions: expect.arrayContaining([
        expect.stringContaining('session_prepare'),
        expect.stringContaining('effectiveProfile'),
      ]),
      recommendedFlows: expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 40,
          strength: 'primary',
        }),
      ]),
    });
    expect(catalogJson.tools?.find((item) => item.name === 'browser_act')?.modelHints).toMatchObject({
      commonMistakes: expect.arrayContaining([
        expect.objectContaining({
          mistake: 'Send waitFor on canonical browser_act requests.',
          correction: 'Use verify instead of waitFor on browser_act.',
        }),
        expect.objectContaining({
          mistake: expect.stringContaining('target.selector'),
          correction: expect.stringContaining('Prefer target.ref first'),
        }),
      ]),
      recommendedFlows: expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 70,
          strength: 'secondary',
        }),
      ]),
    });
    expect(String(catalogJson.tools?.find((item) => item.name === 'session_prepare')?.description || '')).toContain(
      'Prepare the current MCP session'
    );
    expect(
      String(catalogJson.tools?.find((item) => item.name === 'session_prepare')?.description || '')
    ).not.toContain('Recommendation:');
    expect(
      String(catalogJson.tools?.find((item) => item.name === 'session_prepare')?.description || '')
    ).not.toContain('effectiveProfile');

    const detail = await mcpClient.readResource({ uri: 'airpa://mcp/tools/browser_observe' });
    const detailText = detail.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    expect(detailText).toContain('browser_observe');
    const detailJson = JSON.parse(detailText) as {
      tool?: {
        assistantGuidance?: { workflowStage?: string; whenToUse?: string };
      };
      runtime?: { status?: string; reasonCode?: string };
      guides?: string[];
      modelHints?: {
        readBeforeCall?: string[];
        nextActions?: string[];
        recommendedFlows?: Array<{ flow?: string; order?: number; strength?: string }>;
        resultContract?: string[];
      };
      examples?: Array<{ title?: string; arguments?: Record<string, unknown> }>;
    };
    expect(detailJson.runtime?.status).toBe('available_with_notice');
    expect(detailJson.tool?.assistantGuidance).toMatchObject({
      workflowStage: 'observation',
      whenToUse: expect.stringContaining('collect a fresh snapshot'),
    });
    expect(detailJson.modelHints?.readBeforeCall).toEqual(
      expect.arrayContaining([expect.stringContaining('session_prepare')])
    );
    expect(detailJson.modelHints?.nextActions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('session_prepare'),
        expect.stringContaining('effectiveProfile'),
      ])
    );
    expect(detailJson.modelHints?.recommendedFlows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 40,
          strength: 'primary',
        }),
      ])
    );
    expect(detailJson.modelHints?.resultContract).toEqual(
      expect.arrayContaining([
        expect.stringContaining('elementRef'),
        expect.stringContaining('interactionReady'),
      ])
    );
    expect(detailJson.guides).toEqual(
      expect.arrayContaining([
        'airpa://mcp/guides/getting-started',
        'airpa://mcp/guides/login-pages',
        'airpa://mcp/guides/lists',
      ])
    );
    expect(detailJson.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.any(String),
          arguments: expect.any(Object),
        }),
      ])
    );

    const guide = await mcpClient.readResource({ uri: 'airpa://mcp/guides/getting-started' });
    const guideText = guide.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    expect(guideText).toContain('session_prepare');
    expect(guideText).toContain('effectiveProfile');
    expect(guideText).toContain('effectiveEngineSource');
    expect(guideText).toContain('profile_engine_mismatch');
    expect(guideText).toContain('browser_observe');
    expect(guideText).toContain('StreamableHTTPClientTransport.terminateSession()');
    expect(guideText).toContain('session_end_current');
    expect(guideText).toContain('airpa://mcp/guides/login-pages');
    expect(guideText).toContain('airpa://mcp/guides/forms');
    expect(guideText).toContain('airpa://mcp/guides/lists');
    expect(guideText).toContain('airpa://mcp/guides/search-results');
    expect(guideText).toContain('airpa://mcp/guides/hidden-session-debug');
    expect(guideText).not.toContain('x-airpa-tool-profile');
    expect(guideText).not.toContain('?toolProfile=full');
    expect(guideText).not.toContain('browser_act waitFor');
    expect(guideText).toContain('local SDK transport');
    expect(guideText).toContain('server-side MCP session');
  });

  it('MCP tool detail for session_prepare exposes model-oriented result and failure contracts', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockResolvedValue(null),
          resolveProfile: vi.fn().mockResolvedValue(null),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    mcpClient = new Client({
      name: 'test-mcp-client-tool-detail-session-prepare',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const detail = await mcpClient.readResource({ uri: 'airpa://mcp/tools/session_prepare' });
    const detailText = detail.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    const detailJson = JSON.parse(detailText) as {
      tool?: { description?: string };
      runtime?: { status?: string; preconditionsNow?: string[]; recommendedActions?: string[] };
      guides?: string[];
      modelHints?: {
        readBeforeCall?: string[];
        nextActions?: string[];
        authoritativeResultFields?: string[];
        recommendedFlows?: Array<{ flow?: string; order?: number; strength?: string }>;
        failureCodes?: Array<{ code?: string; when?: string; remediation?: string }>;
        commonMistakes?: Array<{ mistake?: string; correction?: string }>;
        resultContract?: string[];
        failureContract?: string[];
      };
    };

    expect(detailJson.tool?.description).toContain('Prepare the current MCP session');
    expect(detailJson.tool?.description).not.toContain('effectiveProfile');
    expect(detailJson.tool?.description).not.toContain('Recommendation:');
    expect(detailJson.runtime?.status).toBe('available');
    expect(detailJson.modelHints?.readBeforeCall).toEqual(
      expect.arrayContaining([expect.stringContaining('effectiveProfile')])
    );
    expect(detailJson.modelHints?.nextActions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('profile_engine_mismatch'),
      ])
    );
    expect(detailJson.modelHints?.authoritativeResultFields).toEqual([
      'structuredContent.data.effectiveProfile',
      'structuredContent.data.effectiveEngine',
      'structuredContent.data.effectiveEngineSource',
    ]);
    expect(detailJson.modelHints?.recommendedFlows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flow: 'getting_started',
          order: 30,
          strength: 'primary',
        }),
        expect.objectContaining({
          flow: 'session_reuse',
          order: 30,
          strength: 'primary',
        }),
      ])
    );
    expect(detailJson.modelHints?.failureCodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'profile_engine_mismatch',
          when: expect.stringContaining('resolved profile engine'),
          remediation: expect.stringContaining('browser_* call'),
        }),
      ])
    );
    expect(detailJson.modelHints?.resultContract).toEqual(
      expect.arrayContaining([
        expect.stringContaining('effectiveProfile'),
        expect.stringContaining('effectiveEngineSource'),
      ])
    );
    expect(detailJson.modelHints?.failureContract).toEqual(
      expect.arrayContaining([
        expect.stringContaining('profile_engine_mismatch'),
      ])
    );
    expect(detailJson.modelHints?.commonMistakes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mistake: expect.stringContaining('old transport headers'),
          correction: expect.stringContaining(
            'structuredContent.data.effectiveProfile, effectiveEngine, and effectiveEngineSource'
          ),
        }),
      ])
    );
    expect(detailJson.guides).toEqual(
      expect.arrayContaining([
        'airpa://mcp/guides/getting-started',
        'airpa://mcp/guides/login-pages',
      ])
    );
  });

  it('MCP prompts discovery endpoints expose generated prompt guidance', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-prompts',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const prompts = await mcpClient.listPrompts();
    expect(prompts.prompts.map((item) => item.name).sort()).toEqual([
      'airpa.getting_started',
      'airpa.page_debug',
      'airpa.session_reuse',
    ]);

    const gettingStarted = await mcpClient.getPrompt({
      name: 'airpa.getting_started',
      arguments: { task: 'inspect the landing page' },
    });
    const gettingStartedText = gettingStarted.messages
      .filter((item) => item.content.type === 'text')
      .map((item) => (item.content.type === 'text' ? item.content.text : ''))
      .join('\n');
    expect(gettingStartedText).toContain('canonical MCP surface');
    expect(gettingStartedText).toContain('system_bootstrap');
    expect(gettingStartedText).toContain('session_prepare');
    expect(gettingStartedText).toContain('effectiveProfile/effectiveEngine/effectiveEngineSource');
    expect(gettingStartedText).toContain('profile_engine_mismatch');
    expect(gettingStartedText).toContain('browser_observe');
    expect(gettingStartedText).toContain('session_end_current');
    expect(gettingStartedText).toContain('airpa://mcp/guides/login-pages');
    expect(gettingStartedText).toContain('airpa://mcp/guides/forms');
    expect(gettingStartedText).toContain('airpa://mcp/guides/lists');
    expect(gettingStartedText).toContain('airpa://mcp/guides/search-results');
    expect(gettingStartedText).toContain('airpa://mcp/guides/hidden-session-debug');
    expect(gettingStartedText).not.toContain('x-airpa-tool-profile');
    expect(gettingStartedText).toContain('terminateSession()');
    expect(gettingStartedText).not.toContain('browser_act waitFor');

    const sessionReuse = await mcpClient.getPrompt({
      name: 'airpa.session_reuse',
      arguments: { profile: 'marketing', task: 'open the dashboard' },
    });
    const sessionReuseText = sessionReuse.messages
      .filter((item) => item.content.type === 'text')
      .map((item) => (item.content.type === 'text' ? item.content.text : ''))
      .join('\n');
    expect(sessionReuseText).toContain('effectiveProfile/effectiveEngine/effectiveEngineSource');
    expect(sessionReuseText).toContain('profile_engine_mismatch');
    expect(sessionReuseText).toContain('browser_* call');
    expect(sessionReuseText).toContain('airpa://mcp/guides/login-pages');
    expect(sessionReuseText).toContain('airpa://mcp/guides/hidden-session-debug');
    expect(sessionReuseText).not.toContain('browser_act waitFor');

    const pageDebug = await mcpClient.getPrompt({
      name: 'airpa.page_debug',
      arguments: { issue: 'selectors stopped matching after navigation' },
    });
    const pageDebugText = pageDebug.messages
      .filter((item) => item.content.type === 'text')
      .map((item) => (item.content.type === 'text' ? item.content.text : ''))
      .join('\n');
    expect(pageDebugText).toContain('browser_debug_state');
    expect(pageDebugText).toContain('airpa://mcp/guides/hidden-session-debug');
    expect(pageDebugText).not.toContain('x-airpa-tool-profile');
    expect(pageDebugText).not.toContain('browser_act waitFor');
  });

  it('MCP transport terminateSession explicitly releases the server-side session', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-terminate-session',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const before = await getJson(baseUrl, '/health');
    expect(before.status).toBe(200);
    expect(before.json.data.mcpSessions).toBe(1);

    await mcpTransport.terminateSession();

    const deadline = Date.now() + 1500;
    let after: { status: number; json: any } | undefined;
    while (Date.now() < deadline) {
      // Session removal is synchronous in our route, but poll briefly to avoid timing flake.
      after = await getJson(baseUrl, '/health');
      if (after.status === 200 && after.json.data.mcpSessions === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(after?.status).toBe(200);
    expect(after?.json.data.mcpSessions).toBe(0);
  });

  it('MCP reused session rejects transport-level mcp-partition overrides', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-session-id': init.sessionId,
        'mcp-partition': 'profile-2',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'session_get_current',
          arguments: {},
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error?: { code?: number; data?: { reason?: string; input?: string; hint?: string } };
    };

    expect(payload.error?.code).toBe(-32600);
    expect(payload.error?.data).toMatchObject({
      reason: 'unsupported_transport_input',
      input: 'mcp-partition',
    });
    expect(payload.error?.data?.hint).toContain('session_prepare');
  });

  it('MCP reused session rejects transport-level mcp-engine overrides', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-session-id': init.sessionId,
        'mcp-engine': 'electron',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'session_get_current',
          arguments: {},
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error?: { code?: number; data?: { reason?: string; input?: string; hint?: string } };
    };

    expect(payload.error?.code).toBe(-32600);
    expect(payload.error?.data).toMatchObject({
      reason: 'unsupported_transport_input',
      input: 'mcp-engine',
    });
    expect(payload.error?.data?.hint).toContain('session_prepare');
  });

  it('MCP raw session_prepare should surface default profile engine mismatch before browser acquisition', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockImplementation(async (profileId: string) => {
            if (profileId === 'default') {
              return {
                id: 'default',
                name: '默认浏览器',
                engine: 'electron',
                status: 'idle',
                partition: 'persist:default',
                isSystem: true,
              };
            }
            return null;
          }),
          resolveProfile: vi.fn().mockResolvedValue(null),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const response = await callMcpToolRaw(baseUrl, init.sessionId, 'session_prepare', {
      engine: 'extension',
      visible: false,
    });

    expect(response.status).toBe(200);
    expect(response.json.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: ErrorCode.INVALID_PARAMETER,
          context: {
            reasonCode: 'profile_engine_mismatch',
            effectiveProfileSource: 'default_profile',
            effectiveEngineSource: 'requested',
            profileId: 'default',
            profileEngine: 'electron',
            requestedEngine: 'extension',
          },
        },
      },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('MCP raw session_prepare should surface explicit profile mismatch against sticky session engine', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockResolvedValue(null),
          resolveProfile: vi.fn().mockImplementation(async (query: string) => {
            if (query === '555') {
              return {
                query,
                matchedBy: 'name' as const,
                profile: {
                  id: 'profile-1',
                  name: '555',
                  engine: 'electron',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              };
            }
            return null;
          }),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const stickyEngine = await callMcpToolRaw(baseUrl, init.sessionId, 'session_prepare', {
      engine: 'extension',
    });
    expect(stickyEngine.status).toBe(200);
    expect(stickyEngine.json.result?.structuredContent?.data?.effectiveEngine).toBe('extension');

    const response = await callMcpToolRaw(baseUrl, init.sessionId, 'session_prepare', {
      query: '555',
    });

    expect(response.status).toBe(200);
    expect(response.json.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: ErrorCode.INVALID_PARAMETER,
          context: {
            reasonCode: 'profile_engine_mismatch',
            effectiveProfileSource: 'resolved_query',
            effectiveEngineSource: 'sticky_session',
            profileId: 'profile-1',
            profileEngine: 'electron',
            requestedEngine: 'extension',
            currentEngine: 'extension',
          },
        },
      },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('MCP GET /mcp supports streamable HTTP after initialize', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const initResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-sse-client', version: '1.0.0' },
        },
      }),
    });

    expect(initResponse.status).toBe(200);
    const sessionId = String(initResponse.headers.get('mcp-session-id') || '');
    expect(sessionId).toBeTruthy();

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
      },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('DELETE /mcp aborts an in-flight MCP invoke and removes the session', async () => {
    await startServer(
      createMockBrowser({
        snapshot: vi.fn().mockImplementation(() => new Promise<Record<string, unknown>>(() => {})),
      }),
      { enableMcp: true }
    );

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const invokeController = new AbortController();
    const invokePromise = fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-session-id': init.sessionId,
      },
      signal: invokeController.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_observe',
          arguments: {},
        },
      }),
    });

    await waitForAssertion(() => {
      expect(acquire).toHaveBeenCalledTimes(1);
    });
    const deleteResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        'mcp-session-id': init.sessionId,
      },
    });

    expect(deleteResponse.status).toBe(204);

    const health = await getJson(baseUrl, '/health');
    expect(health.status).toBe(200);
    expect(health.json.data.mcpSessions).toBe(0);
    await waitForAssertion(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });

    invokeController.abort();
    await invokePromise.catch(() => undefined);
  });

  it('DELETE /mcp during browser acquire releases the pending handle exactly once', async () => {
    let pendingHandle: BrowserHandle | undefined;
    let resolveAcquire!: (handle: BrowserHandle) => void;
    const delayedAcquire = new Promise<BrowserHandle>((resolve) => {
      resolveAcquire = resolve;
    });

    await startServer(createMockBrowser(), {
      enableMcp: true,
      acquireImplementation: async (handle) => {
        pendingHandle = handle;
        return delayedAcquire;
      },
    });

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const invokeController = new AbortController();
    const invokePromise = fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-session-id': init.sessionId,
      },
      signal: invokeController.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_observe',
          arguments: {},
        },
      }),
    });

    await waitForAssertion(() => {
      expect(pendingHandle).toBeTruthy();
    });

    const deleteResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        'mcp-session-id': init.sessionId,
      },
    });

    expect(deleteResponse.status).toBe(204);

    resolveAcquire(pendingHandle as BrowserHandle);

    await waitForAssertion(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });

    invokeController.abort();
    await invokePromise.catch(() => undefined);
  });

  it('DELETE /mcp returns JSON-RPC error envelopes for missing and stale sessions', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const missingSessionIdResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
      },
    });
    expect(missingSessionIdResponse.status).toBe(400);
    const missingSessionIdPayload = (await missingSessionIdResponse.json()) as {
      error?: { code?: number; message?: string; data?: { reason?: string; sessionId?: string | null; hint?: string } };
    };
    expect(missingSessionIdPayload.error).toMatchObject({
      code: -32600,
      message: 'Missing mcp-session-id header',
      data: {
        reason: 'missing_session_id',
        sessionId: null,
      },
    });
    expect(missingSessionIdPayload.error?.data?.hint).toContain('terminating an MCP session');

    const staleSessionId = 'missing-session-id';
    const staleResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        'mcp-session-id': staleSessionId,
      },
    });
    expect(staleResponse.status).toBe(404);
    const stalePayload = (await staleResponse.json()) as {
      error?: { code?: number; message?: string; data?: { reason?: string; sessionId?: string; hint?: string } };
    };
    expect(stalePayload.error).toMatchObject({
      code: -32000,
      message: 'Session not found',
      data: {
        reason: 'session_not_found_or_closed',
        sessionId: staleSessionId,
      },
    });
    expect(stalePayload.error?.data?.hint).toContain('Create a new MCP session');
  });

  it('DELETE /mcp returns JSON-RPC 500 envelope when cleanup throws', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });
    (server as any).sessionBridge.cleanupMcpSession = vi
      .fn()
      .mockRejectedValue(new Error('cleanup exploded'));

    const init = await initializeMcpSession(baseUrl);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        'mcp-session-id': init.sessionId,
      },
    });

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error?: { code?: number; message?: string; data?: { reason?: string; hint?: string } };
    };
    expect(payload.error).toMatchObject({
      code: -32603,
      data: {
        reason: 'session_termination_failed',
      },
    });
    expect(payload.error?.message).toContain('cleanup exploded');
    expect(payload.error?.data?.hint).toContain('Retry session termination');
  });

  it('MCP rejects invalid Origin headers', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'bad-origin-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      error?: { message?: string; data?: { reason?: string; hint?: string } };
    };
    expect(payload.error?.message).toContain('Invalid Origin');
    expect(payload.error?.data?.reason).toBe('invalid_origin');
    expect(payload.error?.data?.hint).toContain('mcpAllowedOrigins');
  });

  it('MCP origin validation allows loopback by default and trusted external allowlist entries', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      restApiConfig: {
        mcpAllowedOrigins: ['https://trusted.example/console'],
      },
    });

    const trustedResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://trusted.example',
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'trusted-origin-client', version: '1.0.0' },
        },
      }),
    });
    expect(trustedResponse.status).toBe(200);

    const loopbackResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'loopback-origin-client', version: '1.0.0' },
        },
      }),
    });
    expect(loopbackResponse.status).toBe(200);

    const rejectedResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
          capabilities: {},
          clientInfo: { name: 'evil-origin-client', version: '1.0.0' },
        },
      }),
    });
    expect(rejectedResponse.status).toBe(403);
    const rejectedPayload = (await rejectedResponse.json()) as {
      error?: { data?: { reason?: string; allowedOrigins?: string[] } };
    };
    expect(rejectedPayload.error?.data).toMatchObject({
      reason: 'invalid_origin',
      allowedOrigins: ['https://trusted.example'],
    });
  });

  it('MCP initialize/list_tools should not fail when browser acquire times out', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });
    acquire?.mockRejectedValue(new Error('Acquire timeout after 30s'));

    mcpClient = new Client({
      name: 'test-mcp-client-lazy-acquire',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const listToolsResult = await mcpClient.listTools();
    expect(listToolsResult.tools.length).toBeGreaterThan(0);

    const invokeResult = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
    const output = invokeResult.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    expect(output.toLowerCase()).toContain('timed out');
    expect(invokeResult.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.ACQUIRE_TIMEOUT,
        reasonCode: 'browser_acquire_timeout',
        message: expect.stringContaining('timed out'),
      },
    });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('MCP session_prepare should expose acquire readiness and browser_observe should surface busy-profile diagnostics', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockImplementation(async (profileId: string) => {
            if (profileId === 'profile-1') {
              return {
                id: 'profile-1',
                name: '555',
                engine: 'electron',
                status: 'idle',
                partition: 'persist:profile-1',
              };
            }
            return null;
          }),
          resolveProfile: vi.fn().mockImplementation(async (query: string) => {
            if (query === '555') {
              return {
                query,
                matchedBy: 'name' as const,
                profile: {
                  id: 'profile-1',
                  name: '555',
                  engine: 'electron',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              };
            }
            return null;
          }),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
      poolManagerOverrides: {
        listBrowsers: vi.fn().mockReturnValue([
          {
            id: 'browser-held',
            sessionId: 'profile-1',
            engine: 'electron',
            status: 'locked',
            viewId: 'view-1',
            lockedBy: {
              source: 'plugin',
              pluginId: 'doudian-business-center-clue-sync',
              requestId: 'req-1',
            },
          },
        ]),
      },
      acquireImplementation: async () => {
        throw new Error('Acquire timeout after 30s');
      },
    });

    mcpClient = new Client({
      name: 'test-mcp-client-busy-profile',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const prepareResult = await mcpClient.callTool({
      name: 'session_prepare',
      arguments: {
        query: '555',
        engine: 'electron',
      },
    });
    expect(prepareResult.structuredContent).toMatchObject({
      data: {
        sessionId: expect.any(String),
        effectiveProfile: expect.objectContaining({
          id: 'profile-1',
          source: 'resolved_query',
        }),
        acquireReadiness: {
          profileId: 'profile-1',
          browserCount: 1,
          lockedBrowserCount: 1,
          busy: true,
          browsers: [
            expect.objectContaining({
              browserId: 'browser-held',
              source: 'plugin',
              pluginId: 'doudian-business-center-clue-sync',
            }),
          ],
        },
      },
    });

    const currentResult = await mcpClient.callTool({
      name: 'session_get_current',
      arguments: {},
    });
    expect(currentResult.structuredContent).toMatchObject({
      data: {
        currentSessionId: expect.any(String),
        session: expect.objectContaining({
          profileId: 'profile-1',
          acquireReadiness: expect.objectContaining({
            profileId: 'profile-1',
            busy: true,
            lockedBrowserCount: 1,
          }),
        }),
      },
    });

    const observeResult = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
    expect(observeResult.isError).toBe(true);
    expect(observeResult.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.ACQUIRE_TIMEOUT,
        reasonCode: 'profile_resource_busy',
        context: expect.objectContaining({
          profileId: 'profile-1',
          acquireReadiness: expect.objectContaining({
            busy: true,
            lockedBrowserCount: 1,
          }),
        }),
        recommendedNextTools: expect.arrayContaining([
          'plugin_list',
          'plugin_get_runtime_status',
        ]),
      },
    });
  });

  it('MCP browser_observe can take over a plugin-held profile when takeover support is available', async () => {
    const pluginLease = await resourceCoordinator.acquire(buildProfileResourceKey('profile-1'), {
      ownerToken: 'plugin-holder',
    });
    const browser = createMockBrowser({
      snapshot: vi.fn().mockResolvedValue({
        url: 'https://example.com/takeover',
        title: 'Takeover',
        elements: [],
      }),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com/takeover'),
    });
    const takenOverHandle = {
      browser,
      browserId: 'browser-held',
      sessionId: 'profile-1',
      engine: 'electron',
      release: vi.fn().mockResolvedValue({
        browserId: 'browser-held',
        sessionId: 'profile-1',
        remainingBrowserCount: 0,
        state: 'idle',
      }),
      renew: vi.fn().mockResolvedValue(true),
    } as unknown as BrowserHandle;
    const takeoverLockedBrowser = vi.fn().mockResolvedValue(takenOverHandle);

    try {
      await startServer(browser, {
        enableMcp: true,
        dependencies: {
          profileGateway: {
            listProfiles: vi.fn().mockResolvedValue([]),
            getProfile: vi.fn().mockImplementation(async (profileId: string) => {
              if (profileId === 'profile-1') {
                return {
                  id: 'profile-1',
                  name: '555',
                  engine: 'electron',
                  status: 'active',
                  partition: 'persist:profile-1',
                };
              }
              return null;
            }),
            resolveProfile: vi.fn().mockImplementation(async (query: string) => {
              if (query === '555') {
                return {
                  query,
                  matchedBy: 'name' as const,
                  profile: {
                    id: 'profile-1',
                    name: '555',
                    engine: 'electron',
                    status: 'active',
                    partition: 'persist:profile-1',
                  },
                };
              }
              return null;
            }),
            createProfile: vi.fn().mockResolvedValue(null),
            updateProfile: vi.fn().mockResolvedValue(null),
            deleteProfile: vi.fn().mockResolvedValue(undefined),
          },
        },
        poolManagerOverrides: {
          listBrowsers: vi.fn().mockReturnValue([
            {
              id: 'browser-held',
              sessionId: 'profile-1',
              engine: 'electron',
              status: 'locked',
              viewId: 'view-1',
              lockedBy: {
                source: 'plugin',
                pluginId: 'doudian-business-center-clue-sync',
                requestId: 'req-1',
              },
            },
          ]),
          takeoverLockedBrowser,
        },
        acquireImplementation: async () => {
          throw new Error('normal acquire should not run');
        },
      });

      mcpClient = new Client({
        name: 'test-mcp-client-takeover-profile',
        version: '1.0.0',
      });
      mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await mcpClient.connect(mcpTransport);

      await mcpClient.callTool({
        name: 'session_prepare',
        arguments: {
          query: '555',
          engine: 'electron',
        },
      });

      const observeResult = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
      expect(observeResult.isError).not.toBe(true);
      expect(observeResult.structuredContent).toMatchObject({
        data: {
          currentUrl: 'https://example.com/takeover',
          navigationPerformed: false,
          waitApplied: false,
          url: 'https://example.com/takeover',
          title: 'Takeover',
        },
      });
      expect(takeoverLockedBrowser).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({
          strategy: 'any',
          timeout: 30000,
          engine: 'electron',
        }),
        'mcp'
      );
    } finally {
      await pluginLease.release();
    }
  });

  it('MCP session_prepare prepares the current session, supports scope updates after acquisition, and rejects conflicting rebinds', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockImplementation(async (profileId: string) => {
            if (profileId === 'profile-1') {
              return {
                id: 'profile-1',
                name: '555',
                engine: 'electron',
                status: 'idle',
                partition: 'persist:profile-1',
              };
            }
            if (profileId === 'profile-2') {
              return {
                id: 'profile-2',
                name: 'other',
                engine: 'electron',
                status: 'idle',
                partition: 'persist:profile-2',
              };
            }
            return null;
          }),
          resolveProfile: vi.fn().mockImplementation(async (query: string) => {
            if (query === '555') {
              return {
                query,
                matchedBy: 'name' as const,
                profile: {
                  id: 'profile-1',
                  name: '555',
                  engine: 'electron',
                  status: 'idle',
                  partition: 'persist:profile-1',
                },
              };
            }
            if (query === 'other') {
              return {
                query,
                matchedBy: 'name' as const,
                profile: {
                  id: 'profile-2',
                  name: 'other',
                  engine: 'electron',
                  status: 'idle',
                  partition: 'persist:profile-2',
                },
              };
            }
            return null;
          }),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    mcpClient = new Client({
      name: 'test-mcp-client-session-prepare',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const prepareResult = await mcpClient.callTool({
      name: 'session_prepare',
      arguments: {
        query: '555',
        engine: 'electron',
        visible: true,
        scopes: ['browser.read'],
      },
    });
    expect(prepareResult.structuredContent).toMatchObject({
      data: {
        sessionId: expect.any(String),
        query: '555',
        matchedBy: 'name',
        profile: { id: 'profile-1' },
        effectiveProfile: {
          id: 'profile-1',
          name: '555',
          engine: 'electron',
          source: 'resolved_query',
        },
        prepared: true,
        idempotent: false,
        engine: 'electron',
        effectiveEngine: 'electron',
        effectiveEngineSource: 'requested',
        visible: true,
        effectiveScopes: ['browser.read'],
        browserAcquired: false,
        changed: ['profile', 'engine', 'visible', 'scopes'],
      },
    });
    expect(acquire).not.toHaveBeenCalled();

    const invokeResult = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
    expect(invokeResult.structuredContent).toMatchObject({
      data: {
        currentUrl: 'https://example.com',
      },
    });
    expect(acquire).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ strategy: 'any', engine: 'electron' }),
      'mcp'
    );

    const scopeUpdate = await mcpClient.callTool({
      name: 'session_prepare',
      arguments: {
        query: '555',
        engine: 'electron',
        visible: true,
        scopes: ['browser.read', 'browser.write'],
      },
    });
    expect(scopeUpdate.structuredContent).toMatchObject({
      data: {
        effectiveProfile: {
          id: 'profile-1',
          source: 'resolved_query',
        },
        prepared: true,
        idempotent: false,
        effectiveEngine: 'electron',
        effectiveEngineSource: 'requested',
        browserAcquired: true,
        effectiveScopes: ['browser.read', 'browser.write'],
        changed: ['scopes'],
      },
    });

    const replay = await mcpClient.callTool({
      name: 'session_prepare',
      arguments: {
        query: '555',
        engine: 'electron',
        visible: true,
        scopes: ['browser.read', 'browser.write'],
      },
    });
    expect(replay.structuredContent).toMatchObject({
      data: {
        effectiveProfile: {
          id: 'profile-1',
          source: 'resolved_query',
        },
        prepared: true,
        idempotent: true,
        effectiveEngine: 'electron',
        effectiveEngineSource: 'requested',
        changed: [],
      },
    });

    const currentSession = await mcpClient.callTool({
      name: 'session_get_current',
      arguments: {},
    });
    expect(currentSession.structuredContent).toMatchObject({
      data: {
        session: expect.objectContaining({
          effectiveScopes: ['browser.read', 'browser.write'],
          visible: true,
        }),
      },
    });

    const conflict = await mcpClient.callTool({
      name: 'session_prepare',
      arguments: {
        query: 'other',
      },
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({
      error: {
        code: ErrorCode.REQUEST_FAILED,
      },
    });

    const toolsAfterAcquire = await mcpClient.listTools();
    const prepareToolAfterAcquire = toolsAfterAcquire.tools.find(
      (tool) => tool.name === 'session_prepare'
    ) as any;
    expect(prepareToolAfterAcquire?._meta?.['airpa/runtimeAvailability']).toMatchObject({
      status: 'available_with_notice',
      availableNow: true,
      reasonCode: 'binding_locked',
      reason: expect.stringContaining('Sticky scope updates are still allowed.'),
    });
    expect(String(prepareToolAfterAcquire?.description || '')).toBe(
      'Prepare the current MCP session before the first browser_* call by resolving a reusable profile, choosing engine/visibility, and updating sticky scopes.'
    );
  });

  it('MCP session self-inspection excludes the current session_* invocation from queue counters', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-session-self-inspection',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const currentResult = await mcpClient.callTool({ name: 'session_get_current', arguments: {} });
    expect(currentResult.structuredContent).toMatchObject({
      data: {
        currentSessionId: expect.any(String),
        session: expect.objectContaining({
          sessionId: expect.any(String),
          pendingInvocations: 0,
          activeInvocations: 0,
        }),
      },
    });

    expect((currentResult.structuredContent as any)?.nextActionHints || []).toEqual(
      expect.arrayContaining([
        expect.stringContaining('session_end_current'),
        expect.stringContaining('session_end_current'),
      ])
    );
  });

  it('MCP session snapshot stays consistent across session tools, catalog, and runtime metadata', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-session-snapshot-contract',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const currentResult = await mcpClient.callTool({ name: 'session_get_current', arguments: {} });
    const currentSession = pickSessionSnapshot((currentResult.structuredContent as any)?.data?.session);
    expect(currentSession.sessionId).toBeTruthy();

    const tools = await mcpClient.listTools();
    const runtimeSession = pickSessionSnapshot(
      (tools.tools.find((tool) => tool.name === 'browser_act') as any)?._meta?.[
        'airpa/runtimeAvailability'
      ]?.session
    );
    expect(runtimeSession).toMatchObject({
      profileId: currentSession.profileId,
      engine: currentSession.engine,
      visible: currentSession.visible,
      browserAcquired: currentSession.browserAcquired,
      browserAcquireInProgress: currentSession.browserAcquireInProgress,
      effectiveScopes: currentSession.effectiveScopes,
      closing: currentSession.closing,
      terminateAfterResponse: currentSession.terminateAfterResponse,
      hostWindowId: currentSession.hostWindowId,
      viewportHealth: currentSession.viewportHealth,
      interactionReady: currentSession.interactionReady,
      offscreenDetected: currentSession.offscreenDetected,
      engineRuntimeDescriptor: currentSession.engineRuntimeDescriptor,
      browserRuntimeDescriptor: currentSession.browserRuntimeDescriptor,
      resolvedRuntimeDescriptor: currentSession.resolvedRuntimeDescriptor,
    });

    const catalog = await mcpClient.readResource({ uri: 'airpa://mcp/tools/catalog' });
    const catalogText = catalog.contents
      .filter((item) => 'text' in item)
      .map((item) => ('text' in item ? item.text : ''))
      .join('\n');
    const catalogJson = JSON.parse(catalogText) as { currentSession?: Record<string, unknown> };
    expect(pickSessionSnapshot(catalogJson.currentSession)).toMatchObject({
      profileId: currentSession.profileId,
      engine: currentSession.engine,
      visible: currentSession.visible,
      browserAcquired: currentSession.browserAcquired,
      browserAcquireInProgress: currentSession.browserAcquireInProgress,
      effectiveScopes: currentSession.effectiveScopes,
      closing: currentSession.closing,
      terminateAfterResponse: currentSession.terminateAfterResponse,
      hostWindowId: currentSession.hostWindowId,
      viewportHealth: currentSession.viewportHealth,
      interactionReady: currentSession.interactionReady,
      offscreenDetected: currentSession.offscreenDetected,
      engineRuntimeDescriptor: currentSession.engineRuntimeDescriptor,
      browserRuntimeDescriptor: currentSession.browserRuntimeDescriptor,
      resolvedRuntimeDescriptor: currentSession.resolvedRuntimeDescriptor,
    });
  });

  it('MCP system_bootstrap and profile_list expose browser runtime descriptors', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([
            {
              id: 'profile-extension',
              name: 'Extension QA',
              engine: 'extension',
              status: 'idle',
              partition: 'persist:profile-extension',
              isSystem: false,
            },
            {
              id: 'profile-ruyi',
              name: 'Firefox QA',
              engine: 'ruyi',
              status: 'idle',
              partition: 'persist:profile-ruyi',
              isSystem: false,
            },
          ]),
          getProfile: vi.fn().mockResolvedValue(null),
          resolveProfile: vi.fn().mockResolvedValue(null),
          createProfile: vi.fn(),
          updateProfile: vi.fn(),
          deleteProfile: vi.fn(),
        },
      },
    });

    mcpClient = new Client({
      name: 'test-mcp-client-runtime-descriptors',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const bootstrapResult = await mcpClient.callTool({ name: 'system_bootstrap', arguments: {} });
    expect(bootstrapResult.structuredContent).toMatchObject({
      data: {
        browserEngines: {
          total: 3,
          descriptors: {
            extension: {
              engine: 'extension',
              capabilities: {
                'network.responseBody': {
                  supported: true,
                  source: 'static-engine',
                },
              },
            },
            ruyi: {
              engine: 'ruyi',
              capabilities: {
                'pdf.print': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-engine',
                },
                'input.touch': {
                  supported: true,
                  source: 'static-engine',
                },
                'events.runtime': {
                  supported: true,
                  source: 'static-engine',
                },
                'storage.dom': {
                  supported: true,
                  source: 'static-engine',
                },
                'intercept.observe': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-engine',
                },
                'intercept.control': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-engine',
                },
              },
            },
          },
        },
      },
    });

    const profileListResult = await mcpClient.callTool({ name: 'profile_list', arguments: {} });
    const listedProfiles = ((profileListResult.structuredContent as any)?.data?.profiles ?? []) as Array<any>;
    expect(listedProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'profile-extension',
          engineRuntimeDescriptor: expect.objectContaining({
            engine: 'extension',
            capabilities: expect.objectContaining({
              'network.responseBody': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          id: 'profile-ruyi',
          engineRuntimeDescriptor: expect.objectContaining({
            engine: 'ruyi',
            capabilities: expect.objectContaining({
              'pdf.print': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-engine',
              }),
              'input.touch': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
              'events.runtime': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
              'storage.dom': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
              'intercept.observe': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-engine',
              }),
              'intercept.control': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-engine',
              }),
            }),
          }),
        }),
      ])
    );
  });

  it('MCP browser_observe can navigate, wait, and return a snapshot payload', async () => {
    const browser = createMockBrowser({
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({
        url: 'https://example.com/observe',
        title: 'Observe',
        elements: [{ role: 'button', name: 'Continue', preferredSelector: 'button.continue' }],
      }),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com/observe'),
    });
    await startServer(browser, { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-browser-observe',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const result = await mcpClient.callTool({
      name: 'browser_observe',
      arguments: {
        url: 'https://example.com/observe',
        wait: { kind: 'element', selector: 'main' },
        waitUntil: 'load',
        navigationTimeout: 1234,
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        currentUrl: 'https://example.com/observe',
        navigationPerformed: true,
        waitApplied: true,
        waitTarget: expect.objectContaining({
          type: 'selector',
          value: 'main',
        }),
        url: 'https://example.com/observe',
        title: 'Observe',
        originalElementCount: 1,
        returnedElementCount: 1,
      },
    });
    expect((browser.goto as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'https://example.com/observe',
      {
        waitUntil: 'load',
        timeout: 1234,
      }
    );
  });

  it('MCP browser_observe can inspect the current page without navigation and rejects conflicting wait targets', async () => {
    const browser = createMockBrowser({
      snapshot: vi.fn().mockResolvedValue({
        url: 'https://example.com/current',
        title: 'Current Page',
        elements: [],
      }),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com/current'),
    });
    await startServer(browser, { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-browser-observe-current',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const inspectResult = await mcpClient.callTool({
      name: 'browser_observe',
      arguments: {},
    });
    expect(inspectResult.structuredContent).toMatchObject({
      data: {
        currentUrl: 'https://example.com/current',
        navigationPerformed: false,
        waitApplied: false,
        waitTarget: null,
      },
    });
    expect((browser.goto as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    const invalidResult = await mcpClient.callTool({
      name: 'browser_observe',
      arguments: {
        wait: { kind: 'text', text: 'Ready' },
        waitSelector: 'main',
      },
    });
    expect(invalidResult.isError).toBe(true);
    expect((invalidResult.structuredContent as any)?.error?.code).toBe(ErrorCode.INVALID_PARAMETER);
  });

  it('MCP session_end_current closes the active session and invalidates the transport after flush', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-end-current-session',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const currentResult = await mcpClient.callTool({ name: 'session_get_current', arguments: {} });
    const currentSessionId = String((currentResult.structuredContent as any)?.data?.currentSessionId || '');
    expect(currentSessionId).toBeTruthy();

    const endResult = await mcpClient.callTool({
      name: 'session_end_current',
      arguments: {},
    });
    expect(endResult.structuredContent).toMatchObject({
      data: {
        closed: true,
        sessionId: currentSessionId,
        closedCurrentSession: true,
        transportInvalidated: true,
        allowFurtherCallsOnSameTransport: false,
        terminationTiming: 'after_response_flush',
      },
    });

    const deadline = Date.now() + 1500;
    let after: { status: number; json: any } | undefined;
    while (Date.now() < deadline) {
      after = await getJson(baseUrl, '/health');
      if (after.status === 200 && after.json.data.mcpSessions === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(after?.status).toBe(200);
    expect(after?.json.data.mcpSessions).toBe(0);

    const staleSessionResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-session-id': currentSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 88,
        method: 'tools/call',
        params: {
          name: 'session_get_current',
          arguments: {},
        },
      }),
    });
    expect(staleSessionResponse.status).toBe(404);
    const staleSessionPayload = (await staleSessionResponse.json()) as {
      error?: { data?: { reason?: string; sessionId?: string } };
    };
    expect(staleSessionPayload.error?.data).toMatchObject({
      reason: 'session_not_found_or_closed',
      sessionId: currentSessionId,
    });
  });

  it('MCP session_end_current can close the current session', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    mcpClient = new Client({
      name: 'test-mcp-client-close-current-session',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const currentResult = await mcpClient.callTool({ name: 'session_get_current', arguments: {} });
    const currentSessionId = String((currentResult.structuredContent as any)?.data?.currentSessionId || '');
    expect(currentSessionId).toBeTruthy();

    const closeResult = await mcpClient.callTool({
      name: 'session_end_current',
      arguments: {},
    });
    expect(closeResult.structuredContent).toMatchObject({
      data: {
        closed: true,
        sessionId: currentSessionId,
        closedCurrentSession: true,
        transportInvalidated: true,
        allowFurtherCallsOnSameTransport: false,
        terminationTiming: 'after_response_flush',
      },
    });
    expect((closeResult.structuredContent as any)?.nextActionHints || []).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Do not send another request on the same transport'),
      ])
    );

    const deadline = Date.now() + 1500;
    let after: { status: number; json: any } | undefined;
    while (Date.now() < deadline) {
      // Current-session closure is deferred until after the response is flushed.
      after = await getJson(baseUrl, '/health');
      if (after.status === 200 && after.json.data.mcpSessions === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(after?.status).toBe(200);
    expect(after?.json.data.mcpSessions).toBe(0);

    const staleSessionResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_UNIFIED_VERSION,
        'mcp-session-id': currentSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'session_get_current',
          arguments: {},
        },
      }),
    });
    expect(staleSessionResponse.status).toBe(404);
    const staleSessionPayload = (await staleSessionResponse.json()) as {
      error?: { message?: string; data?: { reason?: string; sessionId?: string } };
    };
    expect(staleSessionPayload.error?.message).toBe('Session not found');
    expect(staleSessionPayload.error?.data).toMatchObject({
      reason: 'session_not_found_or_closed',
      sessionId: currentSessionId,
    });
  });

  it('enableAuth=true 涓?mcpRequireAuth=true 鏃讹紝/mcp 鏃?token 杩斿洖 401', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      restApiConfig: {
        enableAuth: true,
        token: 'secret-token',
        mcpRequireAuth: true,
      },
    });

    const response = await postJson(baseUrl, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    expect(response.status).toBe(401);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('enableAuth=true 涓?mcpRequireAuth=false 鏃讹紝/mcp 鍙厤 token 璁块棶', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      restApiConfig: {
        enableAuth: true,
        token: 'secret-token',
        mcpRequireAuth: false,
      },
    });

    mcpClient = new Client({
      name: 'test-mcp-client-auth-optional',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const listToolsResult = await mcpClient.listTools();
    expect(listToolsResult.tools.length).toBeGreaterThan(0);
  });

  it('enableAuth=true 鏃讹紝HTTP 缂栨帓璺敱鏈甫 token 杩斿洖 401', async () => {
    await startServer(createMockBrowser(), {
      restApiConfig: {
        enableAuth: true,
        token: 'secret-token',
      },
    });

    const raw = await fetch(`${baseUrl}/api/v1/orchestration/capabilities`);
    const json = await raw.json();

    expect(raw.status).toBe(401);
    expect(json.success).toBe(false);
    expect(json.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('enableAuth=true allows orchestration route with valid token', async () => {
    await startServer(createMockBrowser(), {
      restApiConfig: {
        enableAuth: true,
        token: 'secret-token',
      },
    });

    const raw = await fetch(`${baseUrl}/api/v1/orchestration/capabilities`, {
      headers: {
        authorization: 'Bearer secret-token',
      },
    });
    const json = await raw.json();

    expect(raw.status).toBe(200);
    expect(json.success).toBe(true);
  });

  it('supports create/invoke/close session and releases browser', async () => {
    const browser = createMockBrowser({
      snapshot: vi.fn().mockResolvedValue(createSnapshotResult('https://airpa.dev', 'Airpa')),
    });
    await startServer(browser);

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {
      profileId: 'profile-openclaw',
      engine: 'extension',
    });
    expect(createResponse.status).toBe(200);
    expect(createResponse.json.success).toBe(true);
    expect(acquire).toHaveBeenCalledWith(
      'profile-openclaw',
      expect.objectContaining({ strategy: 'any', engine: 'extension' }),
      'http'
    );
    const sessionId = createResponse.json.data.sessionId as string;
    expect(sessionId).toBeTruthy();

    const invokeResponse = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(invokeResponse.status).toBe(200);
    expect(invokeResponse.json.success).toBe(true);
    expect(invokeResponse.json.data.ok).toBe(true);
    expect(invokeResponse.json.data.output.text.join('\n')).toContain('Page snapshot captured');
    expect(invokeResponse.json.data.output.structuredContent.data.url).toBe('https://airpa.dev');
    expect(typeof invokeResponse.json.data.invokeMeta?.traceId).toBe('string');
    expect(invokeResponse.json._meta.sessionId).toBe(sessionId);
    expect(invokeResponse.json._meta.capability).toBe('browser_snapshot');
    expect(typeof invokeResponse.json._meta.traceId).toBe('string');
    expect(typeof invokeResponse.json._meta.durationMs).toBe('number');

    const deleteResponse = await deleteJson(baseUrl, `/api/v1/orchestration/sessions/${sessionId}`);
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.json.success).toBe(true);
    await waitForAssertion(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });

    const invokeAfterDelete = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(invokeAfterDelete.status).toBe(404);
    expect(invokeAfterDelete.json.success).toBe(false);
    expect(invokeAfterDelete.json.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('create session 鏀寔閫氳繃 profile 鍚嶇О瑙ｆ瀽 profileId', async () => {
    const browser = createMockBrowser({
      getCurrentUrl: vi.fn().mockResolvedValue('https://airpa.dev'),
    });
    await startServer(browser, {
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockResolvedValue(null),
          resolveProfile: vi.fn().mockResolvedValue({
            query: '555',
            matchedBy: 'name',
            profile: {
              id: 'profile-1',
              name: '555',
              engine: 'electron',
              status: 'idle',
            },
          }),
          createProfile: vi.fn().mockResolvedValue(null),
          updateProfile: vi.fn().mockResolvedValue(null),
          deleteProfile: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {
      profileId: '555',
      engine: 'extension',
    });
    expect(createResponse.status).toBe(200);
    expect(createResponse.json.success).toBe(true);
    expect(acquire).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ strategy: 'any', engine: 'extension' }),
      'http'
    );
  });

  it('鏀寔鏌ヨ浼氳瘽鐘舵€佷笌 heartbeat', async () => {
    await startServer(createMockBrowser());

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const statusBefore = await getJson(baseUrl, `/api/v1/orchestration/sessions/${sessionId}`);
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.json.success).toBe(true);
    expect(statusBefore.json.data.sessionId).toBe(sessionId);
    expect(statusBefore.json.data.idempotencyCacheSize).toBe(0);

    const heartbeat = await postJson(
      baseUrl,
      `/api/v1/orchestration/sessions/${sessionId}/heartbeat`,
      {}
    );
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.json.success).toBe(true);
    expect(heartbeat.json.data.alive).toBe(true);
  });

  it('create session 鍙傛暟鏃犳晥鏃惰繑鍥?INVALID_PARAMETER', async () => {
    await startServer(createMockBrowser());

    const response = await postJson(baseUrl, '/api/v1/orchestration/sessions', {
      engine: 'chromium',
    });

    expect(response.status).toBe(400);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.INVALID_PARAMETER);
    expect(response.json.details).toContain('engine');
  });

  it('create session 鍒濆鍖栧け璐ユ椂浼氶噴鏀炬祻瑙堝櫒鍙ユ焺', async () => {
    await startServer(
      createMockBrowser({
        show: vi.fn().mockRejectedValue(new Error('show failed')),
      })
    );

    const response = await postJson(baseUrl, '/api/v1/orchestration/sessions', {
      visible: true,
    });

    expect(response.status).toBe(500);
    expect(response.json.success).toBe(false);
    await waitForAssertion(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it('鍚屼竴浼氳瘽鍐?invoke 涓茶鎵ц', async () => {
    let callCount = 0;
    let activeCalls = 0;
    let maxConcurrent = 0;
    let releaseFirstCall: (() => void) | undefined;

    const browser = createMockBrowser({
      snapshot: vi.fn().mockImplementation(() => {
        callCount += 1;
        const index = callCount;
        activeCalls += 1;
        maxConcurrent = Math.max(maxConcurrent, activeCalls);

        if (index === 1) {
          return new Promise<ReturnType<typeof createSnapshotResult>>((resolve) => {
            releaseFirstCall = () => {
              activeCalls -= 1;
              resolve(createSnapshotResult('https://example.com/one', 'One'));
            };
          });
        }

        activeCalls -= 1;
        return Promise.resolve(createSnapshotResult('https://example.com/two', 'Two'));
      }),
    });
    await startServer(browser);

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const invoke1 = postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });
    const invoke2 = postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(callCount).toBe(1);
    expect(releaseFirstCall).toBeTypeOf('function');

    releaseFirstCall?.();
    const [result1, result2] = await Promise.all([invoke1, invoke2]);

    expect(result1.status).toBe(200);
    expect(result2.status).toBe(200);
    const outputs = [
      result1.json.data.output.text.join('\n'),
      result2.json.data.output.text.join('\n'),
    ];
    expect(result1.json.data.output.structuredContent.data.url).toBe('https://example.com/one');
    expect(result2.json.data.output.structuredContent.data.url).toBe('https://example.com/two');
    expect(outputs.join('\n')).toContain('Page snapshot captured');
    expect(maxConcurrent).toBe(1);
  });

  it('璋冪敤鎵ц涓叧闂細璇濇椂锛岀瓑寰呴槦鍒楀畬鎴愬悗鍐嶉噴鏀炬祻瑙堝櫒', async () => {
    const browser = createMockBrowser({
      snapshot: vi.fn().mockImplementation(() => new Promise<ReturnType<typeof createSnapshotResult>>(() => {})),
    });
    await startServer(browser);

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const invokePromise = postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    let deleteCompleted = false;
    const deletePromise = deleteJson(baseUrl, `/api/v1/orchestration/sessions/${sessionId}`).then(
      (result) => {
        deleteCompleted = true;
        return result;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deleteCompleted).toBe(true);
    const deleteResponse = await deletePromise;
    const invokeResponse = await invokePromise;

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.json.success).toBe(true);
    expect(invokeResponse.status).toBe(409);
    expect(invokeResponse.json.success).toBe(false);
    expect(invokeResponse.json.code).toBe(ErrorCode.OPERATION_FAILED);
    expect(String(invokeResponse.json.message || invokeResponse.json.error || '')).toContain(
      'Session is closing'
    );

    await waitForAssertion(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it('invoke 鍙傛暟鏃犳晥鏃惰繑鍥?INVALID_PARAMETER', async () => {
    await startServer(createMockBrowser());

    const response = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      name: 'browser_snapshot',
      arguments: 'invalid-args',
    });

    expect(response.status).toBe(400);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.INVALID_PARAMETER);
    expect(response.json.details).toContain('sessionId');
    expect(typeof response.json._meta.traceId).toBe('string');
  });

  it('Idempotency-Key 瀵瑰箓绛夎兘鍔涗細杩斿洖閲嶆斁缁撴灉', async () => {
    const browser = createMockBrowser({
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(createSnapshotResult('https://example.com/first', 'First'))
        .mockResolvedValueOnce(createSnapshotResult('https://example.com/second', 'Second')),
    });
    await startServer(browser);

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    const idemKey = 'idem-001';

    const invoke1 = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      { 'Idempotency-Key': idemKey }
    );
    expect(invoke1.status).toBe(200);
    expect(invoke1.json._meta.idempotencyKey).toBe(idemKey);
    expect(invoke1.json._meta.idempotencyStatus).toBe('stored');

    const invoke2 = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      { 'Idempotency-Key': idemKey }
    );
    expect(invoke2.status).toBe(200);
    expect(invoke2.json._meta.idempotencyKey).toBe(idemKey);
    expect(invoke2.json._meta.idempotencyStatus).toBe('replayed');

    const snapshot = browser.snapshot as ReturnType<typeof vi.fn>;
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('duckdb 鎸佷箙鍖栧箓绛夊紑鍚椂浼氳鍐欐寔涔呭寲瀛樺偍骞舵敮鎸佽嚜瀹氫箟 namespace', async () => {
    const getPersisted = vi.fn().mockResolvedValue(null);
    const setPersisted = vi.fn().mockResolvedValue(undefined);
    const deleteNamespace = vi.fn().mockResolvedValue(undefined);
    const pruneExpired = vi.fn().mockResolvedValue(0);

    await startServer(
      createMockBrowser({
        snapshot: vi.fn().mockResolvedValue(createSnapshotResult('https://example.com/persisted-idem', 'Persisted')),
      }),
      {
        restApiConfig: {
          orchestrationIdempotencyStore: 'duckdb',
        },
        dependencies: {
          idempotencyPersistence: {
            get: getPersisted,
            set: setPersisted,
            deleteNamespace,
            pruneExpired,
          },
        },
      }
    );

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const response = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      {
        'Idempotency-Key': 'persisted-key-001',
        'x-airpa-idempotency-namespace': 'order-1001',
      }
    );

    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
    expect(response.json._meta.idempotencyStatus).toBe('stored');
    expect(getPersisted).toHaveBeenCalledWith('order-1001', 'persisted-key-001');
    expect(setPersisted).toHaveBeenCalledTimes(1);
    expect(setPersisted.mock.calls[0][0]).toBe('order-1001');
    expect(setPersisted.mock.calls[0][1]).toBe('persisted-key-001');
    expect(pruneExpired).toHaveBeenCalled();

    const deleteResponse = await deleteJson(baseUrl, `/api/v1/orchestration/sessions/${sessionId}`);
    expect(deleteResponse.status).toBe(200);
    expect(deleteNamespace).toHaveBeenCalledWith(sessionId);
  });

  it('Idempotency-Key 澶嶇敤涓旇姹備綋涓嶄竴鑷存椂杩斿洖 409', async () => {
    await startServer(
      createMockBrowser({
        snapshot: vi.fn().mockResolvedValue(createSnapshotResult('https://example.com/idem-conflict', 'Conflict')),
      })
    );

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const first = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      { 'Idempotency-Key': 'idem-conflict-001' }
    );
    expect(first.status).toBe(200);

    const conflict = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: { changed: true },
      },
      { 'Idempotency-Key': 'idem-conflict-001' }
    );

    expect(conflict.status).toBe(409);
    expect(conflict.json.success).toBe(false);
    expect(conflict.json.code).toBe(ErrorCode.REQUEST_FAILED);
  });

  it('retryable capability auto-retries after first failure', async () => {
    const snapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(createSnapshotResult('https://example.com/retry-success', 'Retry Success'));
    await startServer(
      createMockBrowser({
        snapshot,
      })
    );

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const invoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });

    expect(invoke.status).toBe(200);
    expect(invoke.json.success).toBe(true);
    expect(invoke.json.data.ok).toBe(true);
    expect(invoke.json.data.output.structuredContent.data.url).toBe('https://example.com/retry-success');
    expect(invoke.json._meta.attempts).toBe(2);
    expect(invoke.json._meta.attemptTimeline.length).toBe(2);
    expect(invoke.json.data.invokeMeta.attempts).toBe(2);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('闈炲箓绛夎兘鍔涗娇鐢?Idempotency-Key 浼氳繑鍥?INVALID_PARAMETER', async () => {
    await startServer(createMockBrowser());

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const response = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_act',
        arguments: { action: 'click', target: { selector: '#btn' } },
      },
      { 'Idempotency-Key': 'idem-non-idempotent' }
    );

    expect(response.status).toBe(400);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.INVALID_PARAMETER);
  });

  it('enforceOrchestrationScopes 寮€鍚椂缂哄皯 scope 杩斿洖 PERMISSION_DENIED', async () => {
    await startServer(createMockBrowser(), {
      restApiConfig: {
        enforceOrchestrationScopes: true,
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const response = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });

    expect(response.status).toBe(403);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(response.json._meta.scopeDecision.enforced).toBe(true);
    expect(response.json._meta.scopeDecision.allowed).toBe(false);
  });

  it('enforceOrchestrationScopes allows invocation with scopes', async () => {
    const browser = createMockBrowser({
      snapshot: vi.fn().mockResolvedValue(createSnapshotResult('https://example.com/scoped', 'Scoped')),
    });
    await startServer(browser, {
      restApiConfig: {
        enforceOrchestrationScopes: true,
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;

    const response = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      { 'x-airpa-scopes': 'browser.read' }
    );

    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
    expect(response.json.data.ok).toBe(true);
    expect(response.json.data.output.structuredContent.data.url).toBe('https://example.com/scoped');

    const stickyResponse = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(stickyResponse.status).toBe(200);
    expect(stickyResponse.json.success).toBe(true);
    expect(stickyResponse.json.data.ok).toBe(true);
    expect(stickyResponse.json.data.output.structuredContent.data.url).toBe('https://example.com/scoped');
  });

  it('returns orchestration runtime metrics', async () => {
    await startServer(createMockBrowser());

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });

    const response = await getJson(baseUrl, '/api/v1/orchestration/metrics');
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
    expect(response.json.data).toHaveProperty('queueDepth');
    expect(response.json.data).toHaveProperty('counters');
    expect(response.json.data.queueDepth.totalPending).toBeGreaterThanOrEqual(0);
    expect(response.json.data.sessionLeakRisk.timeoutMs).toBe(HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT);
    expect(Array.isArray(response.json.data.alerts)).toBe(true);
  });

  it('杩愯鏃舵寚鏍囧湪瓒呰繃闃堝€兼椂杩斿洖鍛婅', async () => {
    await startServer(createMockBrowser());

    const serverInternals = server as unknown as {
      runtimeMetrics: {
        invokeTimeoutCount: number;
      };
    };
    serverInternals.runtimeMetrics.invokeTimeoutCount =
      HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_INVOKE_TIMEOUT_WARN_COUNT;

    const response = await getJson(baseUrl, '/api/v1/orchestration/metrics');
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);

    const alerts = response.json.data.alerts as Array<{ code: string; severity: string }>;
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invoke_timeout_count',
          severity: 'warning',
        }),
      ])
    );
  });

  it('invoke 闃熷垪婧㈠嚭鏃惰繑鍥?REQUEST_FAILED', async () => {
    let releaseFirstCall: (() => void) | undefined;
    await startServer(
      createMockBrowser({
        snapshot: vi.fn().mockImplementation(
          () =>
            new Promise<ReturnType<typeof createSnapshotResult>>((resolve) => {
              releaseFirstCall = () => resolve(createSnapshotResult('https://example.com/queue', 'Queue'));
            })
        ),
      })
    );

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    const sessions = (server as unknown as { orchestrationSessions: Map<string, any> }).orchestrationSessions;
    const session = sessions.get(sessionId);
    session.maxQueueSize = 1;

    const invoke1 = postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const invoke2 = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(invoke2.status).toBe(429);
    expect(invoke2.json.success).toBe(false);
    expect(invoke2.json.code).toBe(ErrorCode.REQUEST_FAILED);

    releaseFirstCall?.();
    const first = await invoke1;
    expect(first.status).toBe(200);
    expect(first.json.success).toBe(true);
  });

  it('invoke 瓒呮椂鏃惰繑鍥?TIMEOUT', async () => {
    const defaults = HTTP_SERVER_DEFAULTS as unknown as { ORCHESTRATION_INVOKE_TIMEOUT_MS: number };
    const originalTimeout = defaults.ORCHESTRATION_INVOKE_TIMEOUT_MS;
    defaults.ORCHESTRATION_INVOKE_TIMEOUT_MS = 50;
    try {
      await startServer(
        createMockBrowser({
          snapshot: vi.fn().mockImplementation(() => new Promise<ReturnType<typeof createSnapshotResult>>(() => {})),
        })
      );

      const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
      const sessionId = createResponse.json.data.sessionId as string;

      const response = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      });

      expect(response.status).toBe(408);
      expect(response.json.success).toBe(false);
      expect(response.json.code).toBe(ErrorCode.TIMEOUT);
    } finally {
      defaults.ORCHESTRATION_INVOKE_TIMEOUT_MS = originalTimeout;
    }
  });

  it('v1 invoke success contract snapshot remains stable', async () => {
    await startServer(
      createMockBrowser({
        snapshot: vi
          .fn()
          .mockResolvedValue(createSnapshotResult('https://contract.example/success', 'Contract Success')),
      })
    );

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    const invoke = await postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });

    const normalizeAttemptTimeline = (
      timeline: Array<{
        attempt: number;
        ok: boolean;
        errorCode?: string;
      }> = []
    ) =>
      timeline.map((item) => ({
        ...item,
        startedAt: '<ts>',
        finishedAt: '<ts>',
        durationMs: '<duration>',
      }));

    const normalized = {
      ...invoke.json,
      data: {
        ...invoke.json.data,
        sessionId: '<session>',
        invokeMeta: {
          ...invoke.json.data.invokeMeta,
          traceId: '<trace>',
          attemptTimeline: normalizeAttemptTimeline(invoke.json.data.invokeMeta?.attemptTimeline),
        },
      },
      _meta: {
        ...invoke.json._meta,
        traceId: '<trace>',
        durationMs: '<duration>',
        sessionId: '<session>',
        attemptTimeline: normalizeAttemptTimeline(invoke.json._meta?.attemptTimeline),
      },
    };

    expect(normalized).toMatchInlineSnapshot(`
      {
        "_meta": {
          "attemptTimeline": [
            {
              "attempt": 1,
              "durationMs": "<duration>",
              "finishedAt": "<ts>",
              "ok": true,
              "startedAt": "<ts>",
            },
          ],
          "attempts": 1,
          "capability": "browser_snapshot",
          "durationMs": "<duration>",
          "idempotencyDecision": {
            "enabled": false,
            "reason": "missing_idempotency_key",
            "status": "skipped",
          },
          "scopeDecision": {
            "allowed": true,
            "enforced": false,
            "missingScopes": [
              "browser.read",
            ],
            "providedScopes": [],
            "requiredScopes": [
              "browser.read",
            ],
          },
          "sessionId": "<session>",
          "traceId": "<trace>",
        },
        "data": {
          "capability": "browser_snapshot",
          "invokeMeta": {
            "attemptTimeline": [
              {
                "attempt": 1,
                "durationMs": "<duration>",
                "finishedAt": "<ts>",
                "ok": true,
                "startedAt": "<ts>",
              },
            ],
            "attempts": 1,
            "idempotencyDecision": {
              "enabled": false,
              "reason": "missing_idempotency_key",
              "status": "skipped",
            },
            "scopeDecision": {
              "allowed": true,
              "enforced": false,
              "missingScopes": [
                "browser.read",
              ],
              "providedScopes": [],
              "requiredScopes": [
                "browser.read",
              ],
            },
            "traceId": "<trace>",
          },
          "ok": true,
          "output": {
            "hasImage": false,
            "imageCount": 0,
            "structuredContent": {
              "authoritativeFields": [
                "structuredContent.data.snapshot.elements[*].elementRef",
                "structuredContent.data.interactionReady",
                "structuredContent.data.viewportHealth",
                "structuredContent.data.offscreenDetected",
              ],
              "data": {
                "diagnostics": {
                  "elementsWithBounds": 0,
                  "negativeBoundsCount": 0,
                  "outOfViewportCount": 0,
                  "overflowBoundsCount": 0,
                  "totalElements": 0,
                  "viewportHeight": 720,
                  "viewportWidth": 1280,
                },
                "elementsFilter": "interactive",
                "hostWindowId": null,
                "interactionReady": true,
                "offscreenDetected": false,
                "originalElementCount": 0,
                "returnedElementCount": 0,
                "sessionVisibility": "unknown",
                "snapshot": {
                  "elements": [],
                  "title": "Contract Success",
                  "url": "https://contract.example/success",
                },
                "title": "Contract Success",
                "url": "https://contract.example/success",
                "viewportHealth": "ready",
                "viewportHealthReason": "page viewport and returned element bounds look healthy",
              },
              "nextActionHints": [
                "Prefer snapshot.elements[*].elementRef for follow-up actions. Use preferredSelector only as a fallback.",
                "Use browser_search when the page still has too many possible targets after snapshotting.",
                "If the target element is missing, increase maxElements or set elementsFilter="all".",
              ],
              "ok": true,
              "reasonCode": null,
              "recommendedNextTools": [
                "browser_search",
                "browser_act",
                "browser_wait_for",
              ],
              "retryable": false,
              "summary": "Page snapshot captured for https://contract.example/success. Title: Contract Success. Returned 0/0 element(s) with filter=interactive.",
              "truncated": false,
            },
            "text": [
              "Page snapshot captured for https://contract.example/success. Title: Contract Success. Returned 0/0 element(s) with filter=interactive.",
            ],
          },
          "sessionId": "<session>",
        },
        "success": true,
      }
    `);
  });

  it('v1 invoke 璇锋眰浣?schema fuzz锛氶潪娉曞弬鏁扮粺涓€杩斿洖 INVALID_PARAMETER', async () => {
    await startServer(createMockBrowser());

    const fuzzCases: unknown[] = [
      {},
      { sessionId: 123, name: 'browser_snapshot' },
      { sessionId: 'sid', name: 123 },
      { sessionId: 'sid', name: 'browser_snapshot', arguments: 'invalid' },
      { sessionId: 'sid', name: 'browser_snapshot', arguments: [] },
    ];

    for (const body of fuzzCases) {
      const response = await postJson(baseUrl, '/api/v1/orchestration/invoke', body);
      expect(response.status).toBe(400);
      expect(response.json.success).toBe(false);
      expect(response.json.code).toBe(ErrorCode.INVALID_PARAMETER);
    }
  });

  it('MCP tools/call executes sequentially within one session', async () => {
    let callCount = 0;
    let activeCalls = 0;
    let maxConcurrent = 0;
    let releaseFirstCall: (() => void) | undefined;

    await startServer(
      createMockBrowser({
        getCurrentUrl: vi.fn().mockImplementation(() => {
          callCount += 1;
          const index = callCount;
          activeCalls += 1;
          maxConcurrent = Math.max(maxConcurrent, activeCalls);

          if (index === 1) {
            return new Promise<string>((resolve) => {
              releaseFirstCall = () => {
                activeCalls -= 1;
                resolve('https://mcp.example/one');
              };
            });
          }

          activeCalls -= 1;
          return Promise.resolve('https://mcp.example/two');
        }),
      }),
      { enableMcp: true }
    );

    mcpClient = new Client({
      name: 'test-mcp-client-queue',
      version: '1.0.0',
    });
    mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await mcpClient.connect(mcpTransport);

    const call1 = mcpClient.callTool({ name: 'browser_observe', arguments: {} });
    const call2 = mcpClient.callTool({ name: 'browser_observe', arguments: {} });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(callCount).toBe(1);
    expect(releaseFirstCall).toBeTypeOf('function');

    releaseFirstCall?.();
    const [result1, result2] = await Promise.all([call1, call2]);
    const outputUrls = [
      (result1.structuredContent as any)?.data?.currentUrl,
      (result2.structuredContent as any)?.data?.currentUrl,
    ];
    expect(outputUrls).toContain('https://mcp.example/one');
    expect(outputUrls).toContain('https://mcp.example/two');
    expect(maxConcurrent).toBe(1);
  });

  it('stop aborts in-flight session work and returns promptly', async () => {
    await startServer(
      createMockBrowser({
        snapshot: vi.fn().mockImplementation(() => new Promise<ReturnType<typeof createSnapshotResult>>(() => {})),
      })
    );

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    const invokePromise = postJson(baseUrl, '/api/v1/orchestration/invoke', {
      sessionId,
      name: 'browser_snapshot',
      arguments: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    let stopped = false;
    const stopPromise = server!.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(true);
    await stopPromise;
    const invokeResponse = await invokePromise;
    expect(invokeResponse.status).toBe(409);
    expect(invokeResponse.json.success).toBe(false);
    expect(invokeResponse.json.code).toBe(ErrorCode.OPERATION_FAILED);
    expect(stopped).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    server = undefined;
  });

  it('delete session 涓嶅瓨鍦ㄦ椂杩斿洖 NOT_FOUND', async () => {
    await startServer(createMockBrowser());

    const response = await deleteJson(baseUrl, '/api/v1/orchestration/sessions/not-exists');

    expect(response.status).toBe(404);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('MCP mcp-protocol-version unsupported should return 400', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await postJson(
      baseUrl,
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-02-23',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
      {
        'mcp-protocol-version': '2026-02-23',
      }
    );

    expect(response.status).toBe(400);
    expect(response.json.error?.code).toBe(-32600);
    expect(response.json.error?.message).toContain('Unsupported mcp-protocol-version');
    expect(response.json.error?.data?.unifiedProtocolVersion).toBe(MCP_PROTOCOL_UNIFIED_VERSION);
    expect(response.json.error?.data?.supportedProtocolVersions).toEqual(
      MCP_PROTOCOL_ALLOWED_VERSIONS
    );
  });

  it('MCP initialize protocolVersion unsupported should return 400', async () => {
    await startServer(createMockBrowser(), { enableMcp: true });

    const response = await postJson(baseUrl, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-02-23',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    expect(response.status).toBe(400);
    expect(response.json.error?.code).toBe(-32600);
    expect(response.json.error?.message).toContain('initialize.params.protocolVersion');
    expect(response.json.error?.data?.unifiedProtocolVersion).toBe(MCP_PROTOCOL_UNIFIED_VERSION);
  });
});
