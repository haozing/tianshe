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

  it('enableAuth=true 娑?mcpRequireAuth=true 閺冭绱?mcp 閺?token 鏉╂柨娲?401', async () => {
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

  it('enableAuth=true 閺冭绱滺TTP 缂傛牗甯撶捄顖滄暠閺堫亜鐢?token 鏉╂柨娲?401', async () => {
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

  it('create session 閺€顖涘瘮闁俺绻?profile 閸氬秶袨鐟欙絾鐎?profileId', async () => {
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

  it('閺€顖涘瘮閺屻儴顕楁导姘崇樈閻樿埖鈧椒绗?heartbeat', async () => {
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

  it('create session 閸欏倹鏆熼弮鐘虫櫏閺冩儼绻戦崶?INVALID_PARAMETER', async () => {
    await startServer(createMockBrowser());

    const response = await postJson(baseUrl, '/api/v1/orchestration/sessions', {
      engine: 'chromium',
    });

    expect(response.status).toBe(400);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.INVALID_PARAMETER);
    expect(response.json.details).toContain('engine');
  });

  it('create session 閸掓繂顫愰崠鏍с亼鐠愩儲妞傛导姘跺櫞閺€鐐セ鐟欏牆娅掗崣銉︾労', async () => {
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

  it('invoke 閸欏倹鏆熼弮鐘虫櫏閺冩儼绻戦崶?INVALID_PARAMETER', async () => {
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

  it('Idempotency-Key 鐎电懓绠撶粵澶庡厴閸旀稐绱版潻鏂挎礀闁插秵鏂佺紒鎾寸亯', async () => {
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

  it('duckdb 閹镐椒绠欓崠鏍х畵缁涘绱戦崥顖涙娴兼俺顕伴崘娆愬瘮娑斿懎瀵茬€涙ê鍋嶉獮鑸垫暜閹镐浇鍤滅€规矮绠?namespace', async () => {
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
  });

  it('Idempotency-Key 婢跺秶鏁ゆ稉鏃囶嚞濮瑰倷缍嬫稉宥勭閼峰瓨妞傛潻鏂挎礀 409', async () => {
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

  it('闂堢偛绠撶粵澶庡厴閸旀稐濞囬悽?Idempotency-Key 娴兼俺绻戦崶?INVALID_PARAMETER', async () => {
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

  it('enforceOrchestrationScopes 瀵偓閸氼垱妞傜紓鍝勭毌 scope 鏉╂柨娲?PERMISSION_DENIED', async () => {
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

  it('invoke 闂冪喎鍨┃銏犲毉閺冩儼绻戦崶?REQUEST_FAILED', async () => {
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

  it('invoke 鐡掑懏妞傞弮鎯扮箲閸?TIMEOUT', async () => {
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

  it('v1 invoke 鐠囬攱鐪版担?schema fuzz閿涙岸娼▔鏇炲棘閺佹壆绮烘稉鈧潻鏂挎礀 INVALID_PARAMETER', async () => {
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

  it('delete session 娑撳秴鐡ㄩ崷銊︽鏉╂柨娲?NOT_FOUND', async () => {
    await startServer(createMockBrowser());

    const response = await deleteJson(baseUrl, '/api/v1/orchestration/sessions/not-exists');

    expect(response.status).toBe(404);
    expect(response.json.success).toBe(false);
    expect(response.json.code).toBe(ErrorCode.NOT_FOUND);
  });
});
