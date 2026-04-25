import { randomUUID } from 'node:crypto';
import type { Application } from 'express';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import { MCP_PROTOCOL_UNIFIED_VERSION } from '../constants/mcp-protocol';
import { TRACE_HEADER } from './http-response-mapper';
import { firstString } from './http-request-utils';
import { createRootTraceContext, withTraceContext } from '../core/observability/observation-context';

/**
 * 注册 trace 与统一响应头中间件。
 */
export const registerTraceContextMiddleware = (app: Application): void => {
  app.use((req, res, next) => {
    const incomingTrace = firstString(req.headers[TRACE_HEADER]);
    const traceId = incomingTrace || randomUUID();
    res.locals.traceId = traceId;
    res.locals.requestStartedAt = Date.now();
    res.setHeader('x-airpa-api-version', HTTP_SERVER_DEFAULTS.API_VERSION);
    res.setHeader('x-airpa-mcp-protocol-version', MCP_PROTOCOL_UNIFIED_VERSION);
    res.setHeader(TRACE_HEADER, traceId);
    withTraceContext(
      createRootTraceContext({
        traceId,
        source: 'http',
        attributes: {
          method: req.method,
          path: req.path,
        },
      }),
      () => next()
    );
  });
};
