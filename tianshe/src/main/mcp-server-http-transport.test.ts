import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import {
  MCP_PROTOCOL_ALLOWED_VERSIONS,
  MCP_PROTOCOL_UNIFIED_VERSION,
} from '../constants/mcp-protocol';
import type { BrowserPoolManager } from '../core/browser-pool';
import { AirpaHttpMcpServer } from './mcp-server-http';

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

const isFetchSafePort = (port: number): boolean =>
  Number.isInteger(port) && port > 0 && port < 65536 && !FETCH_FORBIDDEN_PORTS.has(port);

const postMcpInitialize = (
  baseUrl: string,
  options: {
    origin?: string;
    headerProtocolVersion?: string;
    initializeProtocolVersion?: string;
    id?: number;
  } = {}
): Promise<Response> =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      ...(options.origin ? { origin: options.origin } : {}),
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-protocol-version': options.headerProtocolVersion ?? MCP_PROTOCOL_UNIFIED_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method: 'initialize',
      params: {
        protocolVersion: options.initializeProtocolVersion ?? MCP_PROTOCOL_UNIFIED_VERSION,
        capabilities: {},
        clientInfo: { name: 'transport-test-client', version: '1.0.0' },
      },
    }),
  });

describe('AirpaHttpMcpServer MCP transport guardrails', () => {
  const originalBindAddress = HTTP_SERVER_DEFAULTS.BIND_ADDRESS;
  let server: AirpaHttpMcpServer | undefined;
  let baseUrl = '';

  const startMcpTransportServer = async (restApiConfig: Record<string, unknown> = {}) => {
    (HTTP_SERVER_DEFAULTS as { BIND_ADDRESS: string }).BIND_ADDRESS = '127.0.0.1';

    const poolManager = {
      acquire: async () => {
        throw new Error('browser acquire should not be needed for transport tests');
      },
      listBrowsers: () => [],
    } as unknown as BrowserPoolManager;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      server = new AirpaHttpMcpServer(
        { port: 0, name: 'test-http-mcp-transport', version: 'test' },
        undefined,
        {
          enableAuth: false,
          enableMcp: true,
          ...restApiConfig,
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

    throw new Error('Failed to allocate a fetch-safe HTTP port for MCP transport tests');
  };

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    (HTTP_SERVER_DEFAULTS as { BIND_ADDRESS: string }).BIND_ADDRESS = originalBindAddress;
    server = undefined;
    baseUrl = '';
  });

  it('rejects invalid Origin headers', async () => {
    await startMcpTransportServer();

    const response = await postMcpInitialize(baseUrl, {
      origin: 'https://evil.example',
    });

    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      error?: { message?: string; data?: { reason?: string; hint?: string } };
    };
    expect(payload.error?.message).toContain('Invalid Origin');
    expect(payload.error?.data?.reason).toBe('invalid_origin');
    expect(payload.error?.data?.hint).toContain('mcpAllowedOrigins');
  });

  it('allows loopback origins by default and trusted external allowlist entries', async () => {
    await startMcpTransportServer({
      mcpAllowedOrigins: ['https://trusted.example/console'],
    });

    const trustedResponse = await postMcpInitialize(baseUrl, {
      origin: 'https://trusted.example',
      id: 1,
    });
    expect(trustedResponse.status).toBe(200);

    const loopbackResponse = await postMcpInitialize(baseUrl, {
      origin: 'http://127.0.0.1:3000',
      id: 2,
    });
    expect(loopbackResponse.status).toBe(200);

    const rejectedResponse = await postMcpInitialize(baseUrl, {
      origin: 'https://evil.example',
      id: 3,
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

  it('rejects unsupported mcp-protocol-version headers', async () => {
    await startMcpTransportServer();

    const response = await postMcpInitialize(baseUrl, {
      headerProtocolVersion: '2026-02-23',
      initializeProtocolVersion: '2026-02-23',
    });
    const payload = (await response.json()) as {
      error?: { code?: number; message?: string; data?: Record<string, unknown> };
    };

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe(-32600);
    expect(payload.error?.message).toContain('Unsupported mcp-protocol-version');
    expect(payload.error?.data?.unifiedProtocolVersion).toBe(MCP_PROTOCOL_UNIFIED_VERSION);
    expect(payload.error?.data?.supportedProtocolVersions).toEqual(MCP_PROTOCOL_ALLOWED_VERSIONS);
  });

  it('rejects unsupported initialize protocolVersion params', async () => {
    await startMcpTransportServer();

    const response = await postMcpInitialize(baseUrl, {
      initializeProtocolVersion: '2026-02-23',
    });
    const payload = (await response.json()) as {
      error?: { code?: number; message?: string; data?: Record<string, unknown> };
    };

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe(-32600);
    expect(payload.error?.message).toContain('initialize.params.protocolVersion');
    expect(payload.error?.data?.unifiedProtocolVersion).toBe(MCP_PROTOCOL_UNIFIED_VERSION);
  });
});
