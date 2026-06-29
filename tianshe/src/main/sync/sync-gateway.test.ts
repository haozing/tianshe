import { describe, expect, it, vi } from 'vitest';
import { SyncGateway, SyncGatewayRequestError } from './sync-gateway';

function readHeader(headers: RequestInit['headers'], name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const matched = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return matched ? matched[1] : null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

describe('SyncGateway artifact transport', () => {
  it('maps legacy auth envelope (HTTP 200 + code=401) to SyncGatewayRequestError in contract calls', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          code: 401,
          msg: 'token is malformed',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const gateway = new SyncGateway({
      baseUrl: 'https://api.example.com',
      token: 'invalid-token',
      fetchImpl,
    });

    let capturedError: unknown;
    try {
      await gateway.handshake({
        protocolVersion: '1.0',
        traceId: 'trace-legacy-401',
        client: {
          clientId: 'client-1',
          deviceFingerprint: 'device-1',
          appVersion: '1.0.0',
        },
        scope: {
          scopeType: 'company',
          scopeId: 0,
        },
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(SyncGatewayRequestError);
    const requestError = capturedError as SyncGatewayRequestError;
    expect(requestError.status).toBe(401);
    expect(requestError.errorCode).toBe('SYNC_AUTH_REQUIRED');
    expect(requestError.message).toContain('token is malformed');
  });

  it('uploads artifact file via multipart PUT and returns JSON body', async () => {
    const fetchImpl = vi.fn(async (input: any, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe('https://api.example.com/root/signed/upload');
      expect(init?.method).toBe('PUT');
      expect(readHeader(init?.headers, 'Authorization')).toBe('Bearer token-1');
      expect(readHeader(init?.headers, 'X-Airpa-Client-Version')).toBe('1.2.3');

      const formData = init?.body;
      expect(formData instanceof FormData).toBe(true);
      const filePart = (formData as FormData).get('file');
      expect(filePart).toBeInstanceOf(Blob);
      if (filePart instanceof Blob) {
        expect(filePart.size).toBe(3);
        expect(filePart.type).toBe('application/zip');
      }

      return new Response(JSON.stringify({ uploaded: true, artifactRef: 'artifact-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const gateway = new SyncGateway({
      baseUrl: 'https://api.example.com/root',
      token: 'token-1',
      clientVersion: '1.2.3',
      fetchImpl,
    });

    const result = await gateway.uploadArtifactFile('signed/upload', 'extension.zip', new Uint8Array([1, 2, 3]));

    expect(result).toEqual({ uploaded: true, artifactRef: 'artifact-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns empty object when artifact upload response body is empty', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response('', { status: 200 }));
    const gateway = new SyncGateway({
      baseUrl: 'https://api.example.com',
      token: 'token-1',
      fetchImpl,
    });

    const result = await gateway.uploadArtifactFile('/signed/upload', 'extension.zip', new Uint8Array([1]));
    expect(result).toEqual({});
  });

  it('maps legacy auth envelope (HTTP 200 + code=401) to SyncGatewayRequestError in artifact upload', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          code: 401,
          msg: 'token expired',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    const gateway = new SyncGateway({
      baseUrl: 'https://api.example.com',
      token: 'token-1',
      fetchImpl,
    });

    let capturedError: unknown;
    try {
      await gateway.uploadArtifactFile('/signed/upload', 'extension.zip', new Uint8Array([1, 2]));
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(SyncGatewayRequestError);
    const requestError = capturedError as SyncGatewayRequestError;
    expect(requestError.status).toBe(401);
    expect(requestError.errorCode).toBe('SYNC_AUTH_REQUIRED');
    expect(requestError.message).toContain('token expired');
  });

  it('downloads artifact bytes from absolute download URL', async () => {
    const binary = new Uint8Array([9, 8, 7, 6]);
    const fetchImpl = vi.fn(async (input: any, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe('https://cdn.example.com/artifacts/a1.zip');
      expect(init?.method).toBe('GET');
      expect(readHeader(init?.headers, 'Authorization')).toBe('Bearer token-1');
      return new Response(binary, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    });
    const gateway = new SyncGateway({
      baseUrl: 'https://api.example.com/root',
      token: 'token-1',
      fetchImpl,
    });

    const result = await gateway.downloadArtifactFile('https://cdn.example.com/artifacts/a1.zip');
    expect(Array.from(result)).toEqual(Array.from(binary));
  });

  it('maps artifact download error response into SyncGatewayRequestError', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          traceId: 'trace-404',
          error: {
            code: 'SYNC_ARTIFACT_NOT_FOUND',
            message: 'artifact missing',
          },
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    const gateway = new SyncGateway({
      baseUrl: 'https://api.example.com',
      token: 'token-1',
      fetchImpl,
    });

    let capturedError: unknown;
    try {
      await gateway.downloadArtifactFile('/signed/download');
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(SyncGatewayRequestError);
    const requestError = capturedError as SyncGatewayRequestError;
    expect(requestError.status).toBe(404);
    expect(requestError.errorCode).toBe('SYNC_ARTIFACT_NOT_FOUND');
    expect(requestError.traceId).toBe('trace-404');
    expect(requestError.message).toBe('artifact missing');
  });

  it('maps legacy auth envelope (HTTP 200 + code=401) to SyncGatewayRequestError in artifact download', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          code: 401,
          msg: 'invalid token',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    const gateway = new SyncGateway({
      baseUrl: 'https://api.example.com',
      token: 'token-1',
      fetchImpl,
    });

    let capturedError: unknown;
    try {
      await gateway.downloadArtifactFile('/signed/download');
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(SyncGatewayRequestError);
    const requestError = capturedError as SyncGatewayRequestError;
    expect(requestError.status).toBe(401);
    expect(requestError.errorCode).toBe('SYNC_AUTH_REQUIRED');
    expect(requestError.message).toContain('invalid token');
  });
});
