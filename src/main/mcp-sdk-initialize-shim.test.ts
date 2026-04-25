import { describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  createSdkInitializeShim,
  getMcpSdkInitializeShimStatus,
  getSdkPrivateInitializeHandler,
} from './mcp-sdk-initialize-shim';

const createInitializeRequest = (): InitializeRequest => ({
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: {
      name: 'shim-contract-test',
      version: '1.0.0',
    },
  },
});

describe('mcp sdk initialize shim', () => {
  it('delegates to the SDK private initialize handler', async () => {
    const server = new Server(
      {
        name: 'test-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    const initialize = getSdkPrivateInitializeHandler(server);
    const result = await initialize(createInitializeRequest());

    expect(result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: {
        name: 'test-server',
        version: '1.0.0',
      },
      capabilities: {
        tools: {},
      },
    });
  });

  it('falls back to synthesized initialize results when the private slot contract drifts', async () => {
    const server = new Server(
      {
        name: 'test-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    (server as unknown as { _oninitialize?: unknown })._oninitialize = undefined;

    expect(() => getSdkPrivateInitializeHandler(server)).toThrowError(
      /Unsupported @modelcontextprotocol\/sdk Server contract/
    );

    const shim = createSdkInitializeShim(server, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0',
      },
      capabilities: {
        tools: {},
      },
    });

    expect(shim.status).toMatchObject({
      mode: 'fallback_missing_private_slot',
      degraded: true,
      fingerprintInjected: false,
      sdkVersion: '1.25.1',
      reason: expect.stringContaining('_oninitialize'),
    });

    const result = await shim.initialize(createInitializeRequest());
    expect(result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: {
        name: 'test-server',
        version: '1.0.0',
      },
      capabilities: {
        tools: {},
      },
    });
  });

  it('reports the current shim mode for runtime diagnostics', () => {
    const status = getMcpSdkInitializeShimStatus();
    expect(status).toMatchObject({
      sdkVersion: '1.25.1',
      privateSlot: '_oninitialize',
      mode: 'private_slot',
      degraded: false,
      fingerprintInjected: true,
    });
    expect(status.reason).toBeNull();
  });
});
