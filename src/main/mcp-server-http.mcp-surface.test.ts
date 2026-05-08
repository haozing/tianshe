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

describe('AirpaHttpMcpServer MCP public surface', () => {
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

  it('MCP ListTools 閸氬秶袨韫囶偆鍙庣粙鍐茬暰閿涘牆顨栫痪锕€娲栬ぐ鎺炵礆', async () => {
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
      failureContract: expect.arrayContaining([expect.stringContaining('profile_engine_mismatch')]),
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
    expect(String(sessionPrepareTool?.description || '')).toContain(
      'Prepare the current MCP session'
    );
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

  it('MCP initialize 閸?application/json Accept 娑撳绻戦崶鐐插讲鐟欙絾鐎?JSON閿涘牆鍚嬬€瑰綊娼?SSE 鐎广垺鍩涚粩顖ょ礆', async () => {
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
      expect.arrayContaining(['airpa.getting_started', 'airpa.session_reuse', 'airpa.page_debug'])
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
    expect(
      catalogJson.tools?.find((item) => item.name === 'browser_observe')?.runtime?.status
    ).toBe('available_with_notice');
    expect(
      catalogJson.tools?.find((item) => item.name === 'session_prepare')?.assistantGuidance
    ).toMatchObject({
      workflowStage: 'session',
      whenToUse: expect.stringContaining('Prepare the current MCP session'),
    });
    expect(
      catalogJson.tools?.find((item) => item.name === 'session_prepare')?.modelHints
    ).toMatchObject({
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
      failureContract: expect.arrayContaining([expect.stringContaining('profile_engine_mismatch')]),
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
    expect(
      catalogJson.tools?.find((item) => item.name === 'browser_act')?.assistantGuidance
    ).toMatchObject({
      workflowStage: 'interaction',
      whenToUse: expect.stringContaining('high-level interaction entrypoint'),
    });
    expect(
      catalogJson.tools?.find((item) => item.name === 'browser_observe')?.modelHints
    ).toMatchObject({
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
    expect(
      catalogJson.tools?.find((item) => item.name === 'browser_act')?.modelHints
    ).toMatchObject({
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
    expect(
      String(catalogJson.tools?.find((item) => item.name === 'session_prepare')?.description || '')
    ).toContain('Prepare the current MCP session');
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
      expect.arrayContaining([expect.stringContaining('profile_engine_mismatch')])
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
});
