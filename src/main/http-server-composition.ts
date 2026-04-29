import type { Application, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { BrowserPoolManager } from '../core/browser-pool';
import {
  listCanonicalPublicCapabilityNames,
  listOrchestrationCapabilities,
} from '../core/ai-dev/orchestration';
import { acquireBrowserFromPool } from './http-browser-pool-adapter';
import { registerTokenAuthMiddleware } from './http-auth-middleware';
import { registerTraceContextMiddleware } from './http-trace-middleware';
import { registerHttpRoutes } from './http-route-registry';
import type { RuntimeMetricsSnapshot } from './http-session-manager';
import type { HttpRuntimeState } from './http-runtime-state';
import type { HttpSessionBridge } from './http-session-bridge';
import type { StructuredError } from '../types/error-codes';
import { firstString, parseRequestedEngine, parseScopesHeader } from './http-request-utils';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import { buildHealthPayload } from './http-system-routes';
import { getHttpApiAuthToken } from './http-api-config-guard';

interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface CreateHttpServerCompositionOptions {
  serverName: string;
  serverVersion: string;
  dependencies?: RestApiDependencies;
  restApiConfig?: RestApiConfig;
  runtimeState: HttpRuntimeState;
  runtimeMetrics: RuntimeMetricsSnapshot;
  sessionBridge: HttpSessionBridge;
  getBrowserPoolManager?: () => BrowserPoolManager;
  normalizeStructuredError: (error: unknown) => StructuredError;
  mapErrorStatus: (code: string, fallback?: number) => number;
  mapStructuredErrorStatus: (error: StructuredError, fallback?: number) => number;
  asyncHandler: (
    handler: (req: Request, res: Response) => Promise<void>
  ) => (req: Request, res: Response) => Promise<void>;
  logger: LoggerLike;
}

/**
 * 组装 HTTP 服务器应用（express + middleware + routes）。
 */
export const createHttpServerComposition = (
  options: CreateHttpServerCompositionOptions
): Application => {
  const app = createMcpExpressApp({
    host: HTTP_SERVER_DEFAULTS.BIND_ADDRESS,
  });
  const mcpConfigured = options.restApiConfig?.enableMcp ?? false;
  const mcpEndpointEnabled = mcpConfigured;
  const effectiveDependencies: RestApiDependencies = {
    ...(options.dependencies || {}),
    ...(options.dependencies?.systemGateway
      ? {}
      : {
          systemGateway: {
            getHealth: async () =>
              buildHealthPayload({
                serverName: options.serverName,
                serverVersion: options.serverVersion,
                restApiConfig: options.restApiConfig,
                mcpConfigured,
                mcpEndpointEnabled,
                getSessionCounts: () => ({
                  activeSessions:
                    options.runtimeState.transports.size +
                    options.runtimeState.orchestrationSessions.size,
                  mcpSessions: options.runtimeState.transports.size,
                  orchestrationSessions: options.runtimeState.orchestrationSessions.size,
                }),
                getRuntimeMetrics: () => options.sessionBridge.buildRuntimeMetricsPayload(),
              }),
            listPublicCapabilities: async () =>
              listCanonicalPublicCapabilityNames(listOrchestrationCapabilities()),
          },
        }),
  };
  registerTraceContextMiddleware(app);

  const authToken = options.restApiConfig ? getHttpApiAuthToken(options.restApiConfig) : undefined;
  if (authToken) {
    registerTokenAuthMiddleware({
      app,
      expectedToken: authToken,
      restApiConfig: options.restApiConfig,
      logger: options.logger,
    });
  }

  registerHttpRoutes({
    app,
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    restApiConfig: options.restApiConfig,
    dependencies: effectiveDependencies,
    transports: options.runtimeState.transports,
    orchestrationSessions: options.runtimeState.orchestrationSessions,
    browserPoolAvailable: Boolean(options.getBrowserPoolManager),
    parseScopesHeader,
    firstString,
    parseRequestedEngine,
    acquireBrowserFromPool: (profileId, engine, source = 'mcp') =>
      acquireBrowserFromPool({
        getBrowserPoolManager: options.getBrowserPoolManager,
        runtimeMetrics: options.runtimeMetrics,
        logger: options.logger,
        profileId,
        engine,
        source,
      }),
    getBrowserPoolManager: options.getBrowserPoolManager,
    enqueueInvokeTask: (sessionLabel, session, task, invokeOptions) =>
      options.sessionBridge.enqueueInvokeTask(sessionLabel, session, task, invokeOptions),
    cleanupSession: (sessionId, session) =>
      options.sessionBridge.cleanupMcpSession(sessionId, session),
    enqueueOrchestrationInvoke: (sessionId, session, task) =>
      options.sessionBridge.enqueueOrchestrationInvoke(sessionId, session, task),
    cleanupOrchestrationSession: (sessionId, session) =>
      options.sessionBridge.cleanupOrchestrationSession(sessionId, session),
    buildRuntimeMetricsPayload: () => options.sessionBridge.buildRuntimeMetricsPayload(),
    getSessionCounts: () => ({
      activeSessions:
        options.runtimeState.transports.size + options.runtimeState.orchestrationSessions.size,
      mcpSessions: options.runtimeState.transports.size,
      orchestrationSessions: options.runtimeState.orchestrationSessions.size,
    }),
    normalizeStructuredError: options.normalizeStructuredError,
    mapErrorStatus: options.mapErrorStatus,
    mapStructuredErrorStatus: options.mapStructuredErrorStatus,
    asyncHandler: options.asyncHandler,
    logger: options.logger,
  });

  return app;
};
