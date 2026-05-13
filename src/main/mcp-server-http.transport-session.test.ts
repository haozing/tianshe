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
    runtimeId: 'chromium-extension-relay',
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
    runtimeId: value?.runtimeId ?? null,
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
    runtimeDescriptor: value?.runtimeDescriptor ?? null,
    browserRuntimeDescriptor: value?.browserRuntimeDescriptor ?? null,
    resolvedRuntimeDescriptor: value?.resolvedRuntimeDescriptor ?? null,
  };
}

describe('AirpaHttpMcpServer MCP transport session lifecycle', () => {
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

  it('MCP reused session rejects transport-level mcp-runtime-id overrides', async () => {
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
        'mcp-runtime-id': 'electron-webcontents',
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
      input: 'mcp-runtime-id',
    });
    expect(payload.error?.data?.hint).toContain('session_prepare');
  });

  it('MCP raw session_prepare should surface default profile runtime mismatch before browser acquisition', async () => {
    await startServer(createMockBrowser(), {
      enableMcp: true,
      dependencies: {
        profileGateway: {
          listProfiles: vi.fn().mockResolvedValue([]),
          getProfile: vi.fn().mockImplementation(async (profileId: string) => {
            if (profileId === 'default') {
              return {
                id: 'default',
                name: 'Default Browser',
                runtimeId: 'electron-webcontents',
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
      runtimeId: 'chromium-extension-relay',
      visible: false,
    });

    expect(response.status).toBe(200);
    expect(response.json.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: ErrorCode.INVALID_PARAMETER,
          context: {
            reasonCode: 'profile_runtime_mismatch',
            effectiveProfileSource: 'default_profile',
            effectiveRuntimeSource: 'requested',
            profileId: 'default',
            profileRuntimeId: 'electron-webcontents',
            requestedRuntimeId: 'chromium-extension-relay',
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
                  runtimeId: 'electron-webcontents',
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

    const stickyRuntime = await callMcpToolRaw(baseUrl, init.sessionId, 'session_prepare', {
      runtimeId: 'chromium-extension-relay',
    });
    expect(stickyRuntime.status).toBe(200);
    expect(stickyRuntime.json.result?.structuredContent?.data?.effectiveRuntime).toBe('chromium-extension-relay');

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
            reasonCode: 'profile_runtime_mismatch',
            effectiveProfileSource: 'resolved_query',
            effectiveRuntimeSource: 'sticky_session',
            profileId: 'profile-1',
            profileRuntimeId: 'electron-webcontents',
            requestedRuntimeId: 'chromium-extension-relay',
            currentRuntimeId: 'chromium-extension-relay',
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
      error?: {
        code?: number;
        message?: string;
        data?: { reason?: string; sessionId?: string | null; hint?: string };
      };
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
      error?: {
        code?: number;
        message?: string;
        data?: { reason?: string; sessionId?: string; hint?: string };
      };
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
                runtimeId: 'electron-webcontents',
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
                  runtimeId: 'electron-webcontents',
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
            runtimeId: 'electron-webcontents',
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
        runtimeId: 'electron-webcontents',
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
        recommendedNextTools: expect.arrayContaining(['plugin_list', 'plugin_get_runtime_status']),
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
      runtimeId: 'electron-webcontents',
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
                  runtimeId: 'electron-webcontents',
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
                    runtimeId: 'electron-webcontents',
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
              runtimeId: 'electron-webcontents',
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
          runtimeId: 'electron-webcontents',
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
          runtimeId: 'electron-webcontents',
        }),
        'mcp'
      );
    } finally {
      await pluginLease.release();
    }
  });
});
