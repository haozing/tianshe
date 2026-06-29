import { describe, expect, it, vi } from 'vitest';
import { registerTokenAuthMiddleware } from './http-auth-middleware';

function createMiddleware(restApiConfig: { mcpRequireAuth?: boolean; agentHandMode?: boolean }) {
  const handlers: Function[] = [];
  registerTokenAuthMiddleware({
    app: {
      use: (handler: Function) => {
        handlers.push(handler);
      },
    } as any,
    expectedToken: 'secret-token',
    restApiConfig: {
      enableAuth: true,
      token: 'secret-token',
      ...restApiConfig,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  });
  return handlers[0];
}

function createResponse() {
  const response = {
    locals: {},
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((status: number) => {
      response.statusCode = status;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
  };
  return response;
}

describe('HTTP token auth middleware', () => {
  it('keeps /mcp token-optional when normal compatibility mode allows it', () => {
    const middleware = createMiddleware({ mcpRequireAuth: false });
    const next = vi.fn();
    const response = createResponse();

    middleware({ path: '/mcp', headers: {}, ip: '127.0.0.1' }, response, next);

    expect(next).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('requires /mcp token when agent-hand mode is enabled', () => {
    const middleware = createMiddleware({ mcpRequireAuth: false, agentHandMode: true });
    const next = vi.fn();
    const response = createResponse();

    middleware({ path: '/mcp', headers: {}, ip: '127.0.0.1' }, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      code: 'PERMISSION_DENIED',
    });
  });
});
