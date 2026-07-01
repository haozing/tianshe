import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import {
  MCP_PROTOCOL_ALLOWED_VERSIONS,
  MCP_PROTOCOL_COMPATIBILITY_MODE,
  MCP_PROTOCOL_UNIFIED_VERSION,
} from '../constants/mcp-protocol';
import {
  createCapabilityConfirmationGrant,
  listOrchestrationCapabilities,
} from '../core/ai-dev/orchestration';
import type { RegisteredCapability } from '../core/ai-dev/capabilities';
import { ErrorCode } from '../types/error-codes';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { BrowserInterface } from '../types/browser-interface';
import { AirpaHttpMcpServer } from './mcp-server-http';

const ORCHESTRATION_TEST_SCOPES = [
  'browser.read',
  'browser.write',
  'dataset.read',
  'dataset.write',
  'observation.read',
  'plugin.read',
  'plugin.write',
  'profile.read',
  'profile.write',
  'session.read',
  'session.write',
  'system.read',
  'plugin.execute',
].join(',');

type TestCapabilityProvider = NonNullable<RestApiDependencies['capabilityProviders']>[number];

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
    runtimeId: 'chromium-extension-relay',
    release,
    renew: vi.fn().mockResolvedValue(true),
  } as unknown as BrowserHandle;
  return { handle, release };
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

const withOrchestrationScopes = (headers: Record<string, string> = {}): Record<string, string> => ({
  'x-airpa-scopes': ORCHESTRATION_TEST_SCOPES,
  ...headers,
});

const postOrchestrationInvoke = (
  baseUrl: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> =>
  postJson(baseUrl, '/api/v1/orchestration/invoke', body, withOrchestrationScopes(headers));

const postConfirmationGrant = (
  baseUrl: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> =>
  postJson(
    baseUrl,
    '/api/v1/orchestration/confirmation-grants',
    body,
    withOrchestrationScopes(headers)
  );

const createHttpConfirmationGrant = (
  capabilityName: string,
  args: Record<string, unknown>,
  sessionId: string,
  options: { grantId?: string; scopes?: string[] } = {}
) => {
  const definition = listOrchestrationCapabilities().find(
    (capability) => capability.name === capabilityName
  );
  if (!definition) {
    throw new Error(`Missing capability definition: ${capabilityName}`);
  }
  const scopes = options.scopes || ORCHESTRATION_TEST_SCOPES.split(',');
  return createCapabilityConfirmationGrant({
    definition,
    arguments: args,
    grantId: options.grantId || `grant-${capabilityName}`,
    invocationId: `invoke-${capabilityName}`,
    principal: 'http',
    source: 'agent-ui',
    sessionId,
    scopes,
  });
};

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

describe('AirpaHttpMcpServer orchestration REST routes', () => {
  const originalBindAddress = HTTP_SERVER_DEFAULTS.BIND_ADDRESS;
  let server: AirpaHttpMcpServer | undefined;
  let baseUrl = '';
  let acquire: ReturnType<typeof vi.fn> | undefined;

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
    if (server) {
      await server.stop();
    }
    (HTTP_SERVER_DEFAULTS as { BIND_ADDRESS: string }).BIND_ADDRESS = originalBindAddress;
    server = undefined;
    baseUrl = '';
    acquire = undefined;
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

  it('includes dependency-provided capabilities in the server-owned registry', async () => {
    const provider: TestCapabilityProvider = {
      id: 'test-provider',
      listCapabilities: () => ({
        provider_echo: {
          definition: {
            name: 'provider_echo',
            version: '1.0.0',
            description: 'Provider echo test capability',
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
          },
          handler: async () => ({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { ok: true },
          }),
        },
      }),
    };

    await startServer(createMockBrowser(), {
      dependencies: {
        capabilityProviders: [provider],
      },
    });

    const response = await getJson(baseUrl, '/api/v1/orchestration/capabilities');
    expect(response.status).toBe(200);

    const names = response.json.data.map((item: { name: string }) => item.name);
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('provider_echo');
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

    const datasetInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'dataset_list',
      arguments: {},
    });
    expect(datasetInvoke.status).toBe(404);
    expect(datasetInvoke.json.success).toBe(false);
    expect(datasetInvoke.json.code).toBe(ErrorCode.NOT_FOUND);
    expect(listDatasets).not.toHaveBeenCalled();

    const crossPluginInvoke = await postOrchestrationInvoke(baseUrl, {
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

    const invoke = await postOrchestrationInvoke(baseUrl, {
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

    const invoke = await postOrchestrationInvoke(
      baseUrl,
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

    const listInvoke = await postOrchestrationInvoke(baseUrl, {
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

    const runtimeInvoke = await postOrchestrationInvoke(baseUrl, {
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

    const reloadInvoke = await postOrchestrationInvoke(baseUrl, {
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

    const uninstallArgs = {
      pluginId: 'plugin-a',
      deleteTables: false,
    };
    const uninstallInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'plugin_uninstall',
      arguments: uninstallArgs,
      confirmationGrant: createHttpConfirmationGrant(
        'plugin_uninstall',
        uninstallArgs,
        sessionId,
        { grantId: 'grant-plugin-uninstall' }
      ),
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

    const installArgs = {
      sourceType: 'cloud_code',
      cloudPluginCode: 'plugin_a',
    };
    const installInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'plugin_install',
      arguments: installArgs,
      confirmationGrant: createHttpConfirmationGrant('plugin_install', installArgs, sessionId),
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

  it('issues host-signed confirmation grants and rejects tampering or replay', async () => {
    const installPlugin = vi.fn().mockResolvedValue({
      pluginId: 'plugin-a',
      operation: 'installed',
      sourceType: 'cloud_code',
    });

    await startServer(createMockBrowser(), {
      dependencies: {
        pluginGateway: {
          listPlugins: vi.fn().mockResolvedValue([]),
          getPlugin: vi.fn().mockResolvedValue(null),
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
    const installArgs = {
      sourceType: 'cloud_code',
      cloudPluginCode: 'plugin_a',
    };

    const grantResponse = await postConfirmationGrant(baseUrl, {
      sessionId,
      name: 'plugin_install',
      arguments: installArgs,
      source: 'agent-ui',
      previewRef: 'preview-1',
    });
    expect(grantResponse.status).toBe(200);
    expect(grantResponse.json.data.confirmationGrant).toMatchObject({
      issuer: 'host-local',
      capability: 'plugin_install',
      principal: 'http',
      sessionId,
      source: 'agent-ui',
      previewRef: 'preview-1',
      signatureVersion: 1,
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const tamperedGrant = {
      ...grantResponse.json.data.confirmationGrant,
      capability: 'profile_delete',
    };
    const tamperedInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'plugin_install',
      arguments: installArgs,
      confirmationGrant: tamperedGrant,
    });
    expect(tamperedInvoke.status).toBe(403);
    expect(tamperedInvoke.json.context.reason).toBe('invalid_grant_signature');

    const firstInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'plugin_install',
      arguments: installArgs,
      confirmationGrant: grantResponse.json.data.confirmationGrant,
    });
    expect(firstInvoke.status).toBe(200);
    expect(firstInvoke.json.success).toBe(true);

    const replayInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'plugin_install',
      arguments: installArgs,
      confirmationGrant: grantResponse.json.data.confirmationGrant,
    });
    expect(replayInvoke.status).toBe(403);
    expect(replayInvoke.json.context.reason).toBe('grant_already_consumed');
    expect(installPlugin).toHaveBeenCalledTimes(1);
  });

  it('does not issue confirmation grants for capabilities that do not require them', async () => {
    await startServer(createMockBrowser());

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    const grantResponse = await postConfirmationGrant(baseUrl, {
      sessionId,
      name: 'plugin_reload',
      arguments: {
        pluginId: 'plugin-a',
      },
    });

    expect(grantResponse.status).toBe(400);
    expect(grantResponse.json.error).toContain('does not require confirmation');
  });

  it('refreshes long-lived HTTP session executors before confirmed high-risk invokes', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    });
    let dynamicCatalog: Record<string, RegisteredCapability> = {
      http_dynamic_high_risk: {
        definition: {
          name: 'http_dynamic_high_risk',
          version: '1.0.0',
          description: 'Dynamic high-risk HTTP capability',
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
          requiredScopes: ['plugin.write'],
          requires: [],
          idempotent: false,
          retryPolicy: { retryable: false, maxAttempts: 1 },
          sideEffectLevel: 'high',
        },
        handler,
      },
    };
    const listeners = new Set<() => void>();
    const provider: TestCapabilityProvider = {
      id: 'dynamic-http-provider',
      listCapabilities: () => dynamicCatalog,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    await startServer(createMockBrowser(), {
      dependencies: {
        capabilityProviders: [provider],
      },
    });

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    expect(createResponse.status).toBe(200);
    const sessionId = createResponse.json.data.sessionId as string;

    dynamicCatalog = {
      http_dynamic_high_risk: {
        ...dynamicCatalog.http_dynamic_high_risk,
        definition: {
          ...dynamicCatalog.http_dynamic_high_risk.definition,
          description: 'Dynamic high-risk HTTP capability after provider refresh',
        },
      },
    };
    for (const listener of listeners) listener();

    const grantResponse = await postConfirmationGrant(baseUrl, {
      sessionId,
      name: 'http_dynamic_high_risk',
      arguments: {},
    });
    expect(grantResponse.status).toBe(200);
    expect(grantResponse.json.success).toBe(true);

    const invoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'http_dynamic_high_risk',
      arguments: {},
      confirmationGrant: grantResponse.json.data.confirmationGrant,
    });
    expect(invoke.status).toBe(200);
    expect(invoke.json.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
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

    const createInvoke = await postOrchestrationInvoke(baseUrl, {
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

    const renameInvoke = await postOrchestrationInvoke(baseUrl, {
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

    const deleteDatasetArgs = {
      datasetId: 'dataset-new',
    };
    const deleteInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'dataset_delete',
      arguments: deleteDatasetArgs,
      confirmationGrant: createHttpConfirmationGrant(
        'dataset_delete',
        deleteDatasetArgs,
        sessionId,
        { grantId: 'grant-dataset-delete' }
      ),
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

    const importArgs = {
      filePath,
      datasetName: 'Orders',
    };
    const importInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'dataset_import_file',
      arguments: importArgs,
      confirmationGrant: createHttpConfirmationGrant(
        'dataset_import_file',
        importArgs,
        sessionId
      ),
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

    const profileCreateArgs = {
      name: 'Shop QA',
      runtimeId: 'chromium-extension-relay',
    };
    const createInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'profile_create',
      arguments: profileCreateArgs,
      confirmationGrant: createHttpConfirmationGrant(
        'profile_create',
        profileCreateArgs,
        sessionId,
        { grantId: 'grant-profile-create' }
      ),
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

    const profileUpdateArgs = {
      profileId: 'profile-new',
      runtimeId: 'electron-webcontents',
      allowRuntimeReset: true,
    };
    const updateInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'profile_update',
      arguments: profileUpdateArgs,
      confirmationGrant: createHttpConfirmationGrant(
        'profile_update',
        profileUpdateArgs,
        sessionId,
        { grantId: 'grant-profile-update' }
      ),
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

    const profileDeleteArgs = {
      profileId: 'profile-new',
    };
    const deleteInvoke = await postOrchestrationInvoke(baseUrl, {
      sessionId,
      name: 'profile_delete',
      arguments: profileDeleteArgs,
      confirmationGrant: createHttpConfirmationGrant(
        'profile_delete',
        profileDeleteArgs,
        sessionId,
        { grantId: 'grant-profile-delete' }
      ),
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
      runtimeId: 'chromium-extension-relay',
    });
    expect(updateProfile).toHaveBeenCalledWith('profile-new', {
      runtimeId: 'electron-webcontents',
    });
    expect(deleteProfile).toHaveBeenCalledWith('profile-new');
  });

  it('闁?OpenClaw capabilities 缂佹棏鍨抽崑锝咁啅閼碱儷鈺呮⒔閵堝懓瀚欓弶鈺傛煥濞?404', async () => {
    await startServer(createMockBrowser());

    const raw = await fetch(`${baseUrl}/api/v1/orchestration/capabilities/openclaw`);
    expect(raw.status).toBe(404);
  });

  it('v1 orchestration capabilities returns successfully', async () => {
    await startServer(createMockBrowser());

    const response = await getJson(baseUrl, '/api/v1/orchestration/capabilities');
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
  });

  it('闁?REST 閻犱警鍨抽弫鍗烆啅閼碱儷鈺呮⒔閵堝懓瀚欓弶鈺傛煥濞?404', async () => {
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
      abandonedInvocationCount: 0,
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

  it('OpenAPI documents the v1 orchestration capability routes', async () => {
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
