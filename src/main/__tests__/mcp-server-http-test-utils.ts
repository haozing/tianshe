import { expect, vi } from 'vitest';
import type { BrowserHandle } from '../../core/browser-pool';
import { MCP_PROTOCOL_UNIFIED_VERSION } from '../../constants/mcp-protocol';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../../core/observability/types';
import type { BrowserInterface } from '../../types/browser-interface';

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

export function isFetchSafePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536 && !FETCH_FORBIDDEN_PORTS.has(port);
}

export function createSnapshotResult(url = 'https://example.com', title = 'Example') {
  return {
    url,
    title,
    elements: [],
  };
}

export function createMockBrowser(overrides: Partial<BrowserInterface> = {}): BrowserInterface {
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

export class MemoryObservationSink implements ObservationSink {
  readonly events: RuntimeEvent[] = [];
  readonly artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

export function createMockHandle(browser: BrowserInterface): {
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

export async function waitForAssertion(
  assertion: () => void,
  timeoutMs = 1500
): Promise<void> {
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

export async function postJson(
  baseUrl: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; json: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(headers || {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  return { status: response.status, json, headers: response.headers };
}

export async function getJson(
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

export async function deleteJson(
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

export async function initializeMcpSession(
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

export async function callMcpToolRaw(
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

export function pickRuntimeFingerprint(value: any) {
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

export function expectRuntimeFingerprintLike(value: any): void {
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

export function expectInitializeInstructionsLike(value: any): void {
  expect(typeof value?.instructions).toBe('string');
  expect(String(value.instructions)).toContain('system_bootstrap');
  expect(String(value.instructions)).toContain('session_prepare');
  expect(String(value.instructions)).toContain('browser_observe');
  expect(String(value.instructions)).toContain('browser_act');
  expect(String(value.instructions)).toContain('session_end_current');
  expect(String(value.instructions)).not.toContain('toolProfile=full');
  expect(String(value.instructions)).not.toContain('browser_act waitFor');
}

export function pickSessionSnapshot(value: any) {
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
