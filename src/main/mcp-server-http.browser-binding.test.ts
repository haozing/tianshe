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

describe('AirpaHttpMcpServer MCP browser binding', () => {
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
      : vi.fn().mockImplementation(async (_profileId, acquireOptions?: { runtimeId?: string }) => ({
          ...handleResult.handle,
          runtimeId: acquireOptions?.runtimeId ?? handleResult.handle.runtimeId,
        }));

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
                runtimeId: 'electron-webcontents',
                status: 'idle',
                partition: 'persist:profile-1',
              };
            }
            if (profileId === 'profile-2') {
              return {
                id: 'profile-2',
                name: 'other',
                runtimeId: 'electron-webcontents',
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
                  runtimeId: 'electron-webcontents',
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
                  runtimeId: 'electron-webcontents',
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
        runtimeId: 'electron-webcontents',
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
          runtimeId: 'electron-webcontents',
          source: 'resolved_query',
        },
        prepared: true,
        idempotent: false,
        runtimeId: 'electron-webcontents',
        effectiveRuntime: 'electron-webcontents',
        effectiveRuntimeSource: 'requested',
        visible: true,
        effectiveScopes: ['browser.read'],
        browserAcquired: false,
        changed: ['profile', 'runtimeId', 'visible', 'scopes'],
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
      expect.objectContaining({ strategy: 'any', runtimeId: 'electron-webcontents' }),
      'mcp'
    );

    const scopeUpdate = await mcpClient.callTool({
      name: 'session_prepare',
      arguments: {
        scopes: ['browser.read', 'browser.write'],
      },
    });
    expect(scopeUpdate.structuredContent).toMatchObject({
      data: {
        effectiveProfile: {
          id: 'profile-1',
          source: 'current_session',
        },
        prepared: true,
        idempotent: false,
        effectiveRuntime: 'electron-webcontents',
        effectiveRuntimeSource: 'sticky_session',
        browserAcquired: true,
        effectiveScopes: ['browser.read', 'browser.write'],
        changed: ['scopes'],
      },
    });

    const replay = await mcpClient.callTool({
      name: 'session_prepare',
      arguments: {
        scopes: ['browser.read', 'browser.write'],
      },
    });
    expect(replay.structuredContent).toMatchObject({
      data: {
        effectiveProfile: {
          id: 'profile-1',
          source: 'current_session',
        },
        prepared: true,
        idempotent: true,
        effectiveRuntime: 'electron-webcontents',
        effectiveRuntimeSource: 'sticky_session',
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
      'Prepare the current MCP session before the first browser_* call by resolving a reusable profile, choosing runtimeId/visibility, and updating sticky scopes.'
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
    const currentSession = pickSessionSnapshot(
      (currentResult.structuredContent as any)?.data?.session
    );
    expect(currentSession.sessionId).toBeTruthy();

    const tools = await mcpClient.listTools();
    const runtimeSession = pickSessionSnapshot(
      (tools.tools.find((tool) => tool.name === 'browser_act') as any)?._meta?.[
        'airpa/runtimeAvailability'
      ]?.session
    );
    expect(runtimeSession).toMatchObject({
      profileId: currentSession.profileId,
      runtimeId: currentSession.runtimeId,
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
      runtimeDescriptor: currentSession.runtimeDescriptor,
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
      runtimeId: currentSession.runtimeId,
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
      runtimeDescriptor: currentSession.runtimeDescriptor,
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
              runtimeId: 'chromium-extension-relay',
              status: 'idle',
              partition: 'persist:profile-extension',
              isSystem: false,
            },
            {
              id: 'profile-ruyi',
              name: 'Firefox QA',
              runtimeId: 'firefox-bidi',
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
        browserRuntimes: {
          total: 4,
          descriptors: {
            'chromium-extension-relay': {
              runtimeId: 'chromium-extension-relay',
              capabilities: {
                'network.responseBody': {
                  supported: true,
                  source: 'static-runtime',
                },
              },
            },
            'firefox-bidi': {
              runtimeId: 'firefox-bidi',
              capabilities: {
                'pdf.print': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-runtime',
                },
                'input.touch': {
                  supported: true,
                  source: 'static-runtime',
                },
                'events.runtime': {
                  supported: true,
                  source: 'static-runtime',
                },
                'storage.dom': {
                  supported: true,
                  source: 'static-runtime',
                },
                'intercept.observe': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-runtime',
                },
                'intercept.control': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-runtime',
                },
              },
            },
          },
        },
      },
    });

    const profileListResult = await mcpClient.callTool({ name: 'profile_list', arguments: {} });
    const listedProfiles = ((profileListResult.structuredContent as any)?.data?.profiles ??
      []) as Array<any>;
    expect(listedProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'profile-extension',
          runtimeDescriptor: expect.objectContaining({
            runtimeId: 'chromium-extension-relay',
            capabilities: expect.objectContaining({
              'network.responseBody': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          id: 'profile-ruyi',
          runtimeDescriptor: expect.objectContaining({
            runtimeId: 'firefox-bidi',
            capabilities: expect.objectContaining({
              'pdf.print': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-runtime',
              }),
              'input.touch': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
              'events.runtime': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
              'storage.dom': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
              'intercept.observe': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-runtime',
              }),
              'intercept.control': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-runtime',
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
    expect(browser.goto as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
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
    expect(browser.goto as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

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
    const currentSessionId = String(
      (currentResult.structuredContent as any)?.data?.currentSessionId || ''
    );
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
    const currentSessionId = String(
      (currentResult.structuredContent as any)?.data?.currentSessionId || ''
    );
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
});
