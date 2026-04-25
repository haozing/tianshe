import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';

type OpenApiOperation = {
  security?: Array<Record<string, unknown>>;
  parameters?: Array<Record<string, unknown>>;
  responses?: Record<string, { headers?: Record<string, { $ref?: string }> }>;
};

type OpenApiDocument = {
  openapi: string;
  info: {
    version: string;
    description?: string;
  };
  security?: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, Record<string, unknown>>;
  };
};

const OPENAPI_PATH = 'src/main/schemas/orchestration-openapi-v1.json';

const V1_ENDPOINTS: Array<[string, 'get' | 'post' | 'delete']> = [
  ['/api/v1/orchestration/capabilities', 'get'],
  ['/api/v1/orchestration/metrics', 'get'],
  ['/api/v1/orchestration/sessions', 'post'],
  ['/api/v1/orchestration/sessions/{sessionId}', 'get'],
  ['/api/v1/orchestration/sessions/{sessionId}', 'delete'],
  ['/api/v1/orchestration/sessions/{sessionId}/heartbeat', 'post'],
  ['/api/v1/orchestration/invoke', 'post'],
];

function loadDoc(): OpenApiDocument {
  const raw = readFileSync(OPENAPI_PATH, 'utf8');
  return JSON.parse(raw) as OpenApiDocument;
}

describe('orchestration OpenAPI drift contract', () => {
  it('声明稳定 v1 路径并与运行时 API 版本一致', () => {
    const doc = loadDoc();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(HTTP_SERVER_DEFAULTS.API_VERSION);

    for (const [path, method] of V1_ENDPOINTS) {
      expect(doc.paths[path]).toBeDefined();
      expect(doc.paths[path]?.[method]).toBeDefined();
    }
  });

  it('声明条件 Bearer 鉴权与统一响应头约束', () => {
    const doc = loadDoc();

    expect(doc.security).toEqual(expect.arrayContaining([expect.objectContaining({ BearerAuth: [] }), {}]));
    expect(doc.components?.securitySchemes?.BearerAuth).toEqual(
      expect.objectContaining({
        type: 'http',
        scheme: 'bearer',
      })
    );

    for (const [path, method] of V1_ENDPOINTS) {
      const operation = doc.paths[path]?.[method];
      expect(operation).toBeDefined();
      expect(operation?.security).toEqual(
        expect.arrayContaining([expect.objectContaining({ BearerAuth: [] }), {}])
      );

      const responses = operation?.responses || {};
      expect(Object.keys(responses)).toContain('401');
      for (const response of Object.values(responses)) {
        expect(response.headers?.['x-airpa-api-version']?.$ref).toBe(
          '#/components/headers/XAirpaApiVersion'
        );
        expect(response.headers?.['x-airpa-trace-id']?.$ref).toBe(
          '#/components/headers/XAirpaTraceId'
        );
      }
    }
  });

  it('invoke 端点声明幂等与 scope 头部及标准错误映射', () => {
    const doc = loadDoc();
    const invokePost = doc.paths['/api/v1/orchestration/invoke']?.post;

    expect(invokePost).toBeDefined();
    expect(invokePost?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $ref: '#/components/parameters/IdempotencyKeyHeader' }),
        expect.objectContaining({
          $ref: '#/components/parameters/XAirpaIdempotencyNamespaceHeader',
        }),
        expect.objectContaining({ $ref: '#/components/parameters/XAirpaScopesHeader' }),
      ])
    );

    const invokeResponses = invokePost?.responses || {};
    for (const status of ['400', '401', '403', '404', '408', '409', '429']) {
      expect(Object.keys(invokeResponses)).toContain(status);
    }
  });

  it('不再声明 openclaw 兼容端点', () => {
    const doc = loadDoc();
    expect(doc.paths['/api/v1/orchestration/capabilities/openclaw']).toBeUndefined();
  });
});
