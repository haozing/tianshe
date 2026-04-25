import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { armPendingMcpSessionTerminationOnResponse } from './mcp-http-adapter';
import type { McpSessionInfo } from './mcp-http-types';
import {
  extractSingleJsonRpcRequestId,
  normalizeMcpAcceptHeader,
  validateMcpOrigin,
  validateMcpProtocolVersion,
} from './mcp-http-transport-utils';

class MockResponseLifecycle extends EventEmitter {}

function createSession(sessionId = 'session-1'): McpSessionInfo {
  return {
    sessionId,
    transport: null as any,
    lastActivity: Date.now(),
    invokeQueue: Promise.resolve(),
    pendingInvocations: 0,
    activeInvocations: 0,
    maxQueueSize: 64,
    visible: false,
    terminateAfterResponse: true,
  };
}

async function waitForImmediateCleanup(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function createMockResponse(): Response & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function createMockRequest(
  headers: Record<string, unknown>,
  rawHeaders?: string[]
): Request & { rawHeaders?: string[] } {
  return {
    headers,
    rawHeaders: rawHeaders || [],
  } as unknown as Request & { rawHeaders?: string[] };
}

describe('armPendingMcpSessionTerminationOnResponse', () => {
  it.each(['close', 'error'] as const)(
    'cleans up a pending current-session termination on response %s',
    async (eventName) => {
      const session = createSession();
      const transports = new Map([[session.sessionId as string, session]]);
      const cleanupSession = vi.fn().mockResolvedValue(undefined);
      const res = new MockResponseLifecycle();

      armPendingMcpSessionTerminationOnResponse(
        { transports, cleanupSession },
        res as unknown as Parameters<typeof armPendingMcpSessionTerminationOnResponse>[1],
        session
      );
      res.emit(eventName, eventName === 'error' ? new Error('socket failure') : undefined);
      await waitForImmediateCleanup();

      expect(session.terminateAfterResponse).toBe(false);
      expect(transports.has(session.sessionId as string)).toBe(false);
      expect(cleanupSession).toHaveBeenCalledTimes(1);
      expect(cleanupSession).toHaveBeenCalledWith(session.sessionId, session);
    }
  );

  it('runs cleanup only once when multiple response termination events fire', async () => {
    const session = createSession();
    const transports = new Map([[session.sessionId as string, session]]);
    const cleanupSession = vi.fn().mockResolvedValue(undefined);
    const res = new MockResponseLifecycle();

    armPendingMcpSessionTerminationOnResponse(
      { transports, cleanupSession },
      res as unknown as Parameters<typeof armPendingMcpSessionTerminationOnResponse>[1],
      session
    );
    res.emit('close');
    res.emit('finish');
    await waitForImmediateCleanup();

    expect(cleanupSession).toHaveBeenCalledTimes(1);
    expect(transports.has(session.sessionId as string)).toBe(false);
  });
});

describe('mcp http transport utils', () => {
  it('extracts JSON-RPC ids only from single valid requests', () => {
    expect(
      extractSingleJsonRpcRequestId({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/list',
      })
    ).toBe(42);
    expect(
      extractSingleJsonRpcRequestId([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      ])
    ).toBeNull();
    expect(
      extractSingleJsonRpcRequestId({
        jsonrpc: '2.0',
        method: 'tools/list',
      })
    ).toBeNull();
  });

  it('normalizes Accept header for Streamable HTTP compatibility', () => {
    const req = createMockRequest(
      { accept: 'application/json' },
      ['accept', 'application/json', 'x-test', '1']
    );

    normalizeMcpAcceptHeader(req);

    expect(req.headers.accept).toBe('application/json, text/event-stream');
    expect(req.rawHeaders).toEqual(['accept', 'application/json', 'x-test', '1']);
  });

  it('allows normalized allowlist origins and rejects untrusted origins with JSON-RPC payloads', () => {
    const allowedReq = createMockRequest({ origin: 'https://trusted.example/app' });
    const allowedRes = createMockResponse();
    expect(validateMcpOrigin(allowedReq, allowedRes, ['https://trusted.example/console'])).toBe(true);
    expect(allowedRes.status).not.toHaveBeenCalled();

    const rejectedReq = createMockRequest({ origin: 'https://evil.example' });
    const rejectedRes = createMockResponse();
    expect(validateMcpOrigin(rejectedReq, rejectedRes, ['https://trusted.example/console'])).toBe(
      false
    );
    expect(rejectedRes.status).toHaveBeenCalledWith(403);
    expect(rejectedRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        error: expect.objectContaining({
          message: 'Invalid Origin: https://evil.example',
          data: expect.objectContaining({
            reason: 'invalid_origin',
            allowedOrigins: ['https://trusted.example'],
          }),
        }),
      })
    );
  });

  it('rejects mismatched MCP protocol versions with structured compatibility details', () => {
    const req = createMockRequest({ 'mcp-protocol-version': '2025-11-25' });
    const res = createMockResponse();
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    };

    expect(validateMcpProtocolVersion(req, res, body)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        error: expect.objectContaining({
          code: -32600,
          message: expect.stringContaining('MCP protocol version mismatch'),
          data: expect.objectContaining({
            source: 'protocol_mismatch',
            unifiedProtocolVersion: '2025-11-25',
          }),
        }),
      })
    );
  });
});
