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
} from '../constants/mcp-protocol';
import { MCP_PUBLIC_TOOL_NAMES } from './mcp-catalog-metadata';
import { ErrorCode } from '../types/error-codes';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { BrowserInterface } from '../types/browser-interface';
import { AirpaHttpMcpServer } from './mcp-server-http';
import { TRACE_HEADER } from './http-response-mapper';
import { setObservationSink } from '../core/observability/observation-service';
import {
  MemoryObservationSink,
  callMcpToolRaw,
  createMockBrowser,
  createMockHandle,
  createSnapshotResult,
  deleteJson,
  expectInitializeInstructionsLike,
  expectRuntimeFingerprintLike,
  getJson,
  initializeMcpSession,
  isFetchSafePort,
  pickRuntimeFingerprint,
  pickSessionSnapshot,
  postJson,
  waitForAssertion,
} from './__tests__/mcp-server-http-test-utils';

describe('AirpaHttpMcpServer auth and orchestration invoke', () => {
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
    setObservationSink(null);
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

  it('enableAuth=true 濞?mcpRequireAuth=true 闁哄啳顔愮槐?mcp 闁?token 閺夆晜鏌ㄥú?401', async () => {
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

  it('allows MCP without token when mcpRequireAuth is false', async () => {
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

  it('enableAuth=true 闁哄啳顔愮槐婊篢TP 缂傚倹鐗楃敮鎾舵崉椤栨粍鏆犻柡鍫簻閻?token 閺夆晜鏌ㄥú?401', async () => {
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
      runtimeId: 'chromium-extension-relay',
    });
    expect(createResponse.status).toBe(200);
    expect(createResponse.json.success).toBe(true);
    expect(acquire).toHaveBeenCalledWith(
      'profile-openclaw',
      expect.objectContaining({ strategy: 'any', runtimeId: 'chromium-extension-relay' }),
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

  it('propagates HTTP trace ids through invoke response meta and observation events', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const browser = createMockBrowser({
      snapshot: vi.fn().mockResolvedValue(createSnapshotResult('https://trace.example', 'Trace')),
    });
    await startServer(browser);

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    const traceId = 'trace-http-contract-success';

    const invokeResponse = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      {
        [TRACE_HEADER]: traceId,
      }
    );

    expect(invokeResponse.status).toBe(200);
    expect(invokeResponse.headers.get(TRACE_HEADER)).toBe(traceId);
    expect(invokeResponse.json._meta.traceId).toBe(traceId);
    expect(invokeResponse.json.data.invokeMeta.traceId).toBe(traceId);
    expect(
      sink.events.filter((event) => event.event.startsWith('capability.invoke')).map((event) => event.event)
    ).toEqual(['capability.invoke.started', 'capability.invoke.succeeded']);
    expect(
      sink.events
        .filter((event) => event.event.startsWith('capability.invoke'))
        .every((event) => event.traceId === traceId && event.capability === 'browser_snapshot')
    ).toBe(true);
  });

  it('keeps HTTP trace ids on failed invoke responses and failed observation events', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const browser = createMockBrowser({
      snapshot: vi.fn().mockRejectedValue(new Error('trace snapshot failed')),
    });
    await startServer(browser);

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    const traceId = 'trace-http-contract-failure';

    const response = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      {
        [TRACE_HEADER]: traceId,
      }
    );

    expect(response.status).toBe(500);
    expect(response.headers.get(TRACE_HEADER)).toBe(traceId);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.OPERATION_FAILED);
    expect(response.json._meta.traceId).toBe(traceId);
    expect(
      sink.events.filter((event) => event.event.startsWith('capability.invoke')).map((event) => event.event)
    ).toEqual(['capability.invoke.started', 'capability.invoke.failed']);
    const failedEvent = sink.events.find((event) => event.event === 'capability.invoke.failed');
    expect(failedEvent).toMatchObject({
      traceId,
      capability: 'browser_snapshot',
      outcome: 'failed',
    });
  });

  it('create session returns an error when visible browser show fails', async () => {
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
              runtimeId: 'electron-webcontents',
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
      runtimeId: 'chromium-extension-relay',
    });
    expect(createResponse.status).toBe(200);
    expect(createResponse.json.success).toBe(true);
    expect(acquire).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ strategy: 'any', runtimeId: 'chromium-extension-relay' }),
      'http'
    );
  });

  it('闁衡偓椤栨稑鐦柡灞诲劥椤曟瀵煎宕囨▓闁绘鍩栭埀顑挎缁?heartbeat', async () => {
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

  it('create session returns an error when visible browser show fails', async () => {
    await startServer(createMockBrowser());

    const response = await postJson(baseUrl, '/api/v1/orchestration/sessions', {
      runtimeId: 'chromium',
    });

    expect(response.status).toBe(400);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.INVALID_PARAMETER);
    expect(response.json.details).toContain('runtimeId');
  });

  it('create session returns an error when visible browser show fails', async () => {
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
      expect(release).toHaveBeenCalledWith({ destroy: true });
    });
  });

  it('serializes invokes within the same session', async () => {
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

  it('waits for queued work before releasing browser when session closes during invoke', async () => {
    const browser = createMockBrowser({
      snapshot: vi
        .fn()
        .mockImplementation(() => new Promise<ReturnType<typeof createSnapshotResult>>(() => {})),
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

  it('invoke 闁告瑥鍊归弳鐔煎籍閻樿櫕娅忛柡鍐╁劶缁绘垿宕?INVALID_PARAMETER', async () => {
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

  it('Idempotency-Key replays the original response for matching requests', async () => {
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

  it('duckdb 闁归晲妞掔粻娆撳礌閺嵮呯暤缂佹稑顦槐鎴﹀触椤栨稒顦уù鍏间亢椤曚即宕樺▎鎰槷濞戞柨鎳庣€佃尙鈧稒锚閸嬪秹鐛懜鍨殰闁归晲娴囬崵婊呪偓瑙勭煯缁?namespace', async () => {
    const getPersisted = vi.fn().mockResolvedValue(null);
    const setPersisted = vi.fn().mockResolvedValue(undefined);
    const deleteNamespace = vi.fn().mockResolvedValue(undefined);
    const pruneExpired = vi.fn().mockResolvedValue(0);

    await startServer(
      createMockBrowser({
        snapshot: vi
          .fn()
          .mockResolvedValue(
            createSnapshotResult('https://example.com/persisted-idem', 'Persisted')
          ),
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
    expect(deleteNamespace).not.toHaveBeenCalledWith('order-1001');
  });

  it('returns 409 for persisted running idempotency reservations before executing side effects', async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValue(createSnapshotResult('https://example.com/running', 'Running'));
    const runningEntry = {
      state: 'running' as const,
      requestHash: 'reserved-request-hash',
      capability: 'browser_snapshot',
      createdAt: Date.now(),
      meta: {
        idempotencyKey: 'persisted-running-key',
      },
    };
    const reserve = vi.fn().mockResolvedValue({
      status: 'exists',
      entry: runningEntry,
    });
    const getPersisted = vi.fn().mockResolvedValue(runningEntry);
    const setPersisted = vi.fn().mockResolvedValue(undefined);
    const deleteNamespace = vi.fn().mockResolvedValue(undefined);
    const pruneExpired = vi.fn().mockResolvedValue(0);

    await startServer(createMockBrowser({ snapshot }), {
      restApiConfig: {
        orchestrationIdempotencyStore: 'duckdb',
      },
      dependencies: {
        idempotencyPersistence: {
          get: getPersisted,
          reserve,
          set: setPersisted,
          deleteNamespace,
          pruneExpired,
        },
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
      {
        'Idempotency-Key': 'persisted-running-key',
        'x-airpa-idempotency-namespace': 'order-running',
      }
    );

    expect(response.status).toBe(409);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.REQUEST_FAILED);
    expect(response.json.context.reason).toBe('idempotency_request_running');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
    expect(setPersisted).not.toHaveBeenCalled();
  });

  it('keeps persisted custom idempotency namespaces across session deletion', async () => {
    const persistedEntries = new Map<string, unknown>();
    const getPersisted = vi.fn().mockImplementation(async (namespace: string, key: string) => {
      return persistedEntries.get(`${namespace}:${key}`) || null;
    });
    const setPersisted = vi
      .fn()
      .mockImplementation(async (namespace: string, key: string, entry: unknown) => {
        persistedEntries.set(`${namespace}:${key}`, entry);
      });
    const deleteNamespace = vi.fn().mockResolvedValue(undefined);
    const pruneExpired = vi.fn().mockResolvedValue(0);
    const snapshot = vi
      .fn()
      .mockResolvedValue(createSnapshotResult('https://example.com/custom-idem', 'Custom Idem'));

    await startServer(createMockBrowser({ snapshot }), {
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
    });

    const firstCreate = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const firstSessionId = firstCreate.json.data.sessionId as string;
    const headers = {
      'Idempotency-Key': 'persisted-key-cross-session',
      'x-airpa-idempotency-namespace': 'order-cross-session',
    };

    const firstInvoke = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId: firstSessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      headers
    );
    expect(firstInvoke.status).toBe(200);
    expect(firstInvoke.json._meta.idempotencyStatus).toBe('stored');

    const deleteResponse = await deleteJson(
      baseUrl,
      `/api/v1/orchestration/sessions/${firstSessionId}`
    );
    expect(deleteResponse.status).toBe(200);
    expect(deleteNamespace).toHaveBeenCalledWith(firstSessionId);
    expect(deleteNamespace).not.toHaveBeenCalledWith('order-cross-session');

    const secondCreate = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const secondSessionId = secondCreate.json.data.sessionId as string;
    const replay = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId: secondSessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      headers
    );

    expect(replay.status).toBe(200);
    expect(replay.json._meta.idempotencyStatus).toBe('replayed');
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(getPersisted).toHaveBeenCalledWith(
      'order-cross-session',
      'persisted-key-cross-session'
    );
  });

  it('Idempotency-Key replays the original response for matching requests', async () => {
    await startServer(
      createMockBrowser({
        snapshot: vi
          .fn()
          .mockResolvedValue(createSnapshotResult('https://example.com/idem-conflict', 'Conflict')),
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
      .mockResolvedValueOnce(
        createSnapshotResult('https://example.com/retry-success', 'Retry Success')
      );
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
    expect(invoke.json.data.output.structuredContent.data.url).toBe(
      'https://example.com/retry-success'
    );
    expect(invoke.json._meta.attempts).toBe(2);
    expect(invoke.json._meta.attemptTimeline.length).toBe(2);
    expect(invoke.json.data.invokeMeta.attempts).toBe(2);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('闂傚牏鍋涚粻鎾剁驳婢跺骸鍘撮柛鏃€绋愭繛鍥偨?Idempotency-Key 濞村吋淇虹换鎴﹀炊?INVALID_PARAMETER', async () => {
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

  it('enforceOrchestrationScopes 鐎殿喒鍋撻柛姘煎灡濡炲倻绱撻崫鍕瘜 scope 閺夆晜鏌ㄥú?PERMISSION_DENIED', async () => {
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

  it('agentHandMode=true enforces orchestration scopes even when compatibility scope enforcement is disabled', async () => {
    await startServer(createMockBrowser(), {
      restApiConfig: {
        agentHandMode: true,
        enforceOrchestrationScopes: false,
        token: 'secret-token',
      },
    });
    const authHeaders = { authorization: 'Bearer secret-token' };

    const createResponse = await postJson(
      baseUrl,
      '/api/v1/orchestration/sessions',
      {},
      authHeaders
    );
    const sessionId = createResponse.json.data.sessionId as string;

    const response = await postJson(
      baseUrl,
      '/api/v1/orchestration/invoke',
      {
        sessionId,
        name: 'browser_snapshot',
        arguments: {},
      },
      authHeaders
    );

    expect(response.status).toBe(403);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(response.json._meta.scopeDecision).toMatchObject({
      enforced: true,
      allowed: false,
      missingScopes: ['browser.read'],
    });
  });

  it('enforceOrchestrationScopes allows invocation with scopes', async () => {
    const browser = createMockBrowser({
      snapshot: vi
        .fn()
        .mockResolvedValue(createSnapshotResult('https://example.com/scoped', 'Scoped')),
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
    expect(stickyResponse.json.data.output.structuredContent.data.url).toBe(
      'https://example.com/scoped'
    );
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

  it('returns warning when runtime metrics exceed thresholds', async () => {
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

  it('invoke 闂傚啰鍠庨崹顏勨攦閵忕姴姣夐柡鍐╁劶缁绘垿宕?REQUEST_FAILED', async () => {
    let releaseFirstCall: (() => void) | undefined;
    await startServer(
      createMockBrowser({
        snapshot: vi.fn().mockImplementation(
          () =>
            new Promise<ReturnType<typeof createSnapshotResult>>((resolve) => {
              releaseFirstCall = () =>
                resolve(createSnapshotResult('https://example.com/queue', 'Queue'));
            })
        ),
      })
    );

    const createResponse = await postJson(baseUrl, '/api/v1/orchestration/sessions', {});
    const sessionId = createResponse.json.data.sessionId as string;
    const sessions = (server as unknown as { orchestrationSessions: Map<string, any> })
      .orchestrationSessions;
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

  it('invoke 閻℃帒鎳忓鍌炲籍閹壆绠查柛?TIMEOUT', async () => {
    const defaults = HTTP_SERVER_DEFAULTS as unknown as { ORCHESTRATION_INVOKE_TIMEOUT_MS: number };
    const originalTimeout = defaults.ORCHESTRATION_INVOKE_TIMEOUT_MS;
    defaults.ORCHESTRATION_INVOKE_TIMEOUT_MS = 50;
    try {
      await startServer(
        createMockBrowser({
          snapshot: vi
            .fn()
            .mockImplementation(
              () => new Promise<ReturnType<typeof createSnapshotResult>>(() => {})
            ),
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
          .mockResolvedValue(
            createSnapshotResult('https://contract.example/success', 'Contract Success')
          ),
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
                "windowControl": null,
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

  it('v1 invoke 閻犲洭鏀遍惇鐗堟媴?schema fuzz闁挎稒宀稿顏勨枖閺囩偛妫橀柡浣瑰缁儤绋夐埀顒佹交閺傛寧绀€ INVALID_PARAMETER', async () => {
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
        snapshot: vi
          .fn()
          .mockImplementation(() => new Promise<ReturnType<typeof createSnapshotResult>>(() => {})),
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

  it('delete session 濞戞挸绉撮悺銊╁捶閵婏附顦ч弶鈺傛煥濞?NOT_FOUND', async () => {
    await startServer(createMockBrowser());

    const response = await deleteJson(baseUrl, '/api/v1/orchestration/sessions/not-exists');

    expect(response.status).toBe(404);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.NOT_FOUND);
  });
});
