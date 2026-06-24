import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import {
  createAsyncHandler,
  mapErrorStatus,
  mapStructuredErrorStatus,
  toStructuredError,
} from './http-error-utils';
import { createHttpRuntimeState } from './http-runtime-state';
import { createHttpSessionBridge } from './http-session-bridge';
import { buildRestApiDependencies, createHttpServerComposition } from './http-server-composition';

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

const createLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('http-server-composition', () => {
  const servers: Array<{ close: (cb?: () => void) => void }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) continue;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const startServer = async (
    restApiConfig: {
      enableAuth?: boolean;
      token?: string;
      mcpRequireAuth?: boolean;
      enableMcp?: boolean;
      agentHandMode?: boolean;
    },
    compositionOptions?: Partial<Parameters<typeof createHttpServerComposition>[0]>
  ) => {
    const logger = createLogger();
    const runtimeState = createHttpRuntimeState();
    const sessionBridge = createHttpSessionBridge({
      transports: runtimeState.transports,
      orchestrationSessions: runtimeState.orchestrationSessions,
      runtimeMetrics: runtimeState.runtimeMetrics,
      sessionTimeoutMs: HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT,
      logger,
    });

    const app = createHttpServerComposition({
      serverName: 'test-http',
      serverVersion: '1.0.0',
      restApiConfig,
      runtimeState,
      runtimeMetrics: runtimeState.runtimeMetrics,
      sessionBridge,
      ...compositionOptions,
      normalizeStructuredError: toStructuredError,
      mapErrorStatus,
      mapStructuredErrorStatus,
      asyncHandler: createAsyncHandler(logger),
      logger,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));

      const address = server.address() as AddressInfo | null;
      if (!address) {
        throw new Error('Failed to start composition test server');
      }

      if (isFetchSafePort(address.port)) {
        servers.push(server);
        const baseUrl = `http://127.0.0.1:${address.port}`;
        return { baseUrl };
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    throw new Error('Failed to allocate a fetch-safe HTTP port for composition tests');
  };

  it('enableAuth=true 时 orchestration 路由未带 token 返回 401', async () => {
    const { baseUrl } = await startServer({
      enableAuth: true,
      token: 'secret-token',
      mcpRequireAuth: true,
      enableMcp: true,
    });

    const response = await fetch(`${baseUrl}/api/v1/orchestration/capabilities`);
    expect(response.status).toBe(401);
  });

  it('enableAuth=false 时 orchestration 路由不要求 token（显式 no-auth 合约）', async () => {
    const { baseUrl } = await startServer({
      enableAuth: false,
      mcpRequireAuth: true,
      enableMcp: true,
    });

    const response = await fetch(`${baseUrl}/api/v1/orchestration/capabilities`);
    const payload = (await response.json()) as { success?: boolean; data?: unknown };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(Array.isArray(payload.data)).toBe(true);
  });

  it('agentHandMode=true forces auth at the server composition boundary', async () => {
    const { baseUrl } = await startServer({
      enableAuth: false,
      token: 'secret-token',
      mcpRequireAuth: false,
      enableMcp: true,
      agentHandMode: true,
    });

    const orchestrationResponse = await fetch(`${baseUrl}/api/v1/orchestration/capabilities`);
    expect(orchestrationResponse.status).toBe(401);

    const mcpResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(mcpResponse.status).toBe(401);
  });

  it('rejects enableAuth=true when token is blank', () => {
    const logger = createLogger();
    const runtimeState = createHttpRuntimeState();
    const sessionBridge = createHttpSessionBridge({
      transports: runtimeState.transports,
      orchestrationSessions: runtimeState.orchestrationSessions,
      runtimeMetrics: runtimeState.runtimeMetrics,
      sessionTimeoutMs: HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT,
      logger,
    });

    expect(() =>
      createHttpServerComposition({
        serverName: 'test-http',
        serverVersion: '1.0.0',
        restApiConfig: {
          enableAuth: true,
          token: '   ',
          mcpRequireAuth: true,
          enableMcp: true,
        },
        runtimeState,
        runtimeMetrics: runtimeState.runtimeMetrics,
        sessionBridge,
        normalizeStructuredError: toStructuredError,
        mapErrorStatus,
        mapStructuredErrorStatus,
        asyncHandler: createAsyncHandler(logger),
        logger,
      })
    ).toThrow(/token is required/i);
  });

  it('mcpRequireAuth=false 时 /mcp 不要求 token（应不返回 401）', async () => {
    const { baseUrl } = await startServer({
      enableAuth: true,
      token: 'secret-token',
      mcpRequireAuth: false,
      enableMcp: true,
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(response.status).not.toBe(401);
    expect(response.status).toBe(400);
  });

  it('enableMcp=false 时 /mcp 不注册（返回 404）', async () => {
    const { baseUrl } = await startServer({
      enableAuth: false,
      enableMcp: false,
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });

  it('enableMcp=true 时 /mcp 已注册（坏请求返回 400）', async () => {
    const { baseUrl } = await startServer({
      enableAuth: false,
      enableMcp: true,
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('/mcp rejects invalid Origin headers with 403', async () => {
    const { baseUrl } = await startServer({
      enableAuth: false,
      enableMcp: true,
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });

  it('returns 503 for browser requests while browser pool is still initializing', async () => {
    const getBrowserPoolManager = vi.fn(() => {
      throw new Error('pool should not be acquired before ready');
    });
    const { baseUrl } = await startServer(
      {
        enableAuth: false,
        enableMcp: false,
      },
      {
        getBrowserPoolManager: getBrowserPoolManager as never,
        getBrowserPoolReadiness: () => ({
          status: 'initializing',
          startedAt: Date.now(),
          readyAt: null,
          failedAt: null,
          error: null,
        }),
      }
    );

    const response = await fetch(`${baseUrl}/api/v1/orchestration/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visible: false }),
    });
    const payload = (await response.json()) as { code?: string; context?: unknown };

    expect(response.status).toBe(503);
    expect(payload.code).toBe('BROWSER_POOL_NOT_INITIALIZED');
    expect(getBrowserPoolManager).not.toHaveBeenCalled();
  });

  it('wires staged dataset write and provenance methods into orchestration dependencies', async () => {
    const stagedPlan = {
      planId: 'plan-1',
      datasetId: 'dataset-1',
      createdAt: '2026-06-23T00:00:00.000Z',
      operations: [{ type: 'insert' as const, record: { name: 'Alice' } }],
      rowCount: 1,
      requiresConfirmation: true as const,
    };
    const commitResult = {
      planId: 'plan-1',
      runId: 'plan-1',
      datasetId: 'dataset-1',
      insertedRowIds: [1],
      updatedRowIds: [],
      deletedRowIds: [],
      affectedRowCount: 1,
      provenanceRecorded: true,
    };
    const provenance = [
      {
        id: 'prov-1',
        datasetId: 'dataset-1',
        rowId: 1,
        runId: 'plan-1',
        operation: 'insert',
        occurredAt: 1,
      },
    ];
    const duckdbService = {
      listDatasets: vi.fn().mockResolvedValue([]),
      getDatasetInfo: vi.fn().mockResolvedValue(null),
      queryDataset: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0 }),
      createEmptyDataset: vi.fn().mockResolvedValue('dataset-new'),
      importDatasetFile: vi.fn().mockResolvedValue('dataset-import'),
      stageWritePlan: vi.fn().mockResolvedValue(stagedPlan),
      commitWritePlan: vi.fn().mockResolvedValue(commitResult),
      listRecordProvenance: vi.fn().mockResolvedValue(provenance),
      renameDataset: vi.fn().mockResolvedValue(undefined),
      deleteDataset: vi.fn().mockResolvedValue(undefined),
      getProfileService: vi.fn().mockReturnValue({
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
        resolve: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn(),
        deleteWithCascade: vi.fn(),
      }),
      getProfileLoginStateService: vi.fn().mockReturnValue({
        getLoginState: vi.fn().mockResolvedValue(null),
        upsertLoginState: vi.fn(),
      }),
    };
    const dependencies = buildRestApiDependencies({
      runtime: {
        duckdbService: duckdbService as never,
        jsPluginManager: {
          listPlugins: vi.fn().mockResolvedValue([]),
          getPluginInfo: vi.fn().mockResolvedValue(null),
          listRuntimeStatuses: vi.fn().mockResolvedValue([]),
          getRuntimeStatus: vi.fn().mockResolvedValue(null),
          import: vi.fn(),
          installOrUpdateCloudPlugin: vi.fn(),
          reload: vi.fn(),
          uninstall: vi.fn(),
        } as never,
        viewManager: {} as never,
        windowManager: {} as never,
        fingerprintManager: {} as never,
        getBrowserPoolManager: vi.fn() as never,
        getPluginRegistry: () =>
          ({
            listMCPCallableAPIs: vi.fn().mockReturnValue([]),
            callPluginAPIFromMCP: vi.fn(),
          }) as never,
      },
      httpApiConfig: {},
    });

    await expect(
      dependencies.datasetGateway?.stageWritePlan?.(
        'dataset-1',
        [{ type: 'insert', record: { name: 'Alice' } }],
        { traceId: 'trace-1' }
      )
    ).resolves.toBe(stagedPlan);
    await expect(
      dependencies.datasetGateway?.commitWritePlan?.(stagedPlan, {
        traceId: 'trace-1',
        confirmRisk: true,
      })
    ).resolves.toBe(commitResult);
    await expect(
      dependencies.datasetGateway?.listRecordProvenance?.('dataset-1', 1, 20)
    ).resolves.toBe(provenance);

    expect(duckdbService.stageWritePlan).toHaveBeenCalledWith(
      'dataset-1',
      [{ type: 'insert', record: { name: 'Alice' } }],
      { traceId: 'trace-1' }
    );
    expect(duckdbService.commitWritePlan).toHaveBeenCalledWith(stagedPlan, {
      traceId: 'trace-1',
      confirmRisk: true,
    });
    expect(duckdbService.listRecordProvenance).toHaveBeenCalledWith('dataset-1', 1, 20);
  });
});
