import type { Application, Request, Response } from 'express';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import type { AutomationEngine } from '../core/browser-pool/types';
import { registerMcpRoutes } from './mcp-http-adapter';
import type { McpSessionInfo } from './mcp-http-types';
import {
  registerOrchestrationRoutes,
  type OrchestrationSessionInfo,
} from './orchestration-http-routes';
import { registerHealthRoute } from './http-system-routes';
import type { StructuredError } from '../types/error-codes';
import type { SessionCountsSnapshot } from './http-runtime-state';
import type { InvokeTaskContext, RuntimeMetricsPayload } from './http-session-manager';

interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
}

interface HttpServerRouteContext {
  app: Application;
  serverName: string;
  serverVersion: string;
  restApiConfig?: RestApiConfig;
  dependencies?: RestApiDependencies;
  logger: LoggerLike;
}

interface HttpSessionRouteContext {
  transports: Map<string, McpSessionInfo>;
  orchestrationSessions: Map<string, OrchestrationSessionInfo>;
  getSessionCounts?: () => SessionCountsSnapshot;
  buildRuntimeMetricsPayload: () => RuntimeMetricsPayload;
}

interface HttpAuthRouteContext {
  parseScopesHeader: (value: unknown) => string[];
  firstString: (value: unknown) => string;
}

interface HttpBrowserRouteContext {
  browserPoolAvailable: boolean;
  parseRequestedEngine: (value: string | undefined) => AutomationEngine | undefined;
  acquireBrowserFromPool: (
    profileId?: string,
    engine?: AutomationEngine,
    source?: 'mcp' | 'http'
  ) => Promise<BrowserHandle>;
  getBrowserPoolManager?: () => BrowserPoolManager;
}

interface HttpInvokeRouteContext {
  enqueueInvokeTask: <T>(
    sessionLabel: string,
    session: McpSessionInfo,
    task: (context: InvokeTaskContext) => Promise<T>,
    options: { timeoutMs: number }
  ) => Promise<T>;
  cleanupSession: (sessionId: string, session: McpSessionInfo) => Promise<void>;
  enqueueOrchestrationInvoke: <T>(
    sessionId: string,
    session: OrchestrationSessionInfo,
    task: (context: InvokeTaskContext) => Promise<T>
  ) => Promise<T>;
  cleanupOrchestrationSession: (
    sessionId: string,
    session: OrchestrationSessionInfo
  ) => Promise<void>;
}

interface HttpErrorRouteContext {
  normalizeStructuredError: (error: unknown) => StructuredError;
  mapErrorStatus: (code: string, fallback?: number) => number;
  mapStructuredErrorStatus: (error: StructuredError, fallback?: number) => number;
  asyncHandler: (
    handler: (req: Request, res: Response) => Promise<void>
  ) => (req: Request, res: Response) => Promise<void>;
}

interface RegisterHttpRoutesOptions {
  server: HttpServerRouteContext;
  sessions: HttpSessionRouteContext;
  auth: HttpAuthRouteContext;
  browser: HttpBrowserRouteContext;
  invoke: HttpInvokeRouteContext;
  errors: HttpErrorRouteContext;
}

/**
 * 注册 HTTP 主入口下的系统路由、MCP 路由与编排路由。
 */
export const registerHttpRoutes = (options: RegisterHttpRoutesOptions): void => {
  const mcpConfigured = options.server.restApiConfig?.enableMcp ?? false;
  const mcpEndpointEnabled = mcpConfigured;

  registerHealthRoute({
    app: options.server.app,
    serverName: options.server.serverName,
    serverVersion: options.server.serverVersion,
    restApiConfig: options.server.restApiConfig,
    mcpConfigured,
    mcpEndpointEnabled,
    getSessionCounts:
      options.sessions.getSessionCounts ??
      (() => ({
        activeSessions:
          options.sessions.transports.size + options.sessions.orchestrationSessions.size,
        mcpSessions: options.sessions.transports.size,
        orchestrationSessions: options.sessions.orchestrationSessions.size,
      })),
    getRuntimeMetrics: () => options.sessions.buildRuntimeMetricsPayload(),
  });

  if (mcpEndpointEnabled) {
    registerMcpRoutes({
      routeContext: {
        app: options.server.app,
        transports: options.sessions.transports,
        serverInfo: {
          name: options.server.serverName,
          version: options.server.serverVersion,
        },
        restApiConfig: options.server.restApiConfig,
        dependencies: options.server.dependencies,
      },
      authContext: {
        parseScopesHeader: options.auth.parseScopesHeader,
        normalizeStructuredError: options.errors.normalizeStructuredError,
      },
      browserBinding: {
        parseRequestedEngine: options.browser.parseRequestedEngine,
        acquireBrowserFromPool: options.browser.acquireBrowserFromPool,
        getBrowserPoolManager: options.browser.getBrowserPoolManager,
      },
      invokeQueue: {
        enqueueInvokeTask: options.invoke.enqueueInvokeTask,
      },
      sessionLifecycle: {
        cleanupSession: options.invoke.cleanupSession,
      },
    });
    options.server.logger.info('MCP endpoint enabled: /mcp');
  } else {
    options.server.logger.info('MCP endpoint disabled (enableMcp=false)');
  }

  registerOrchestrationRoutes({
    app: options.server.app,
    restApiConfig: options.server.restApiConfig,
    dependencies: options.server.dependencies,
    browserPoolAvailable: options.browser.browserPoolAvailable,
    orchestrationSessions: options.sessions.orchestrationSessions,
    parseScopesHeader: options.auth.parseScopesHeader,
    firstString: options.auth.firstString,
    acquireBrowserFromPool: options.browser.acquireBrowserFromPool,
    enqueueOrchestrationInvoke: options.invoke.enqueueOrchestrationInvoke,
    cleanupOrchestrationSession: options.invoke.cleanupOrchestrationSession,
    buildRuntimeMetricsPayload: options.sessions.buildRuntimeMetricsPayload,
    normalizeStructuredError: options.errors.normalizeStructuredError,
    mapErrorStatus: options.errors.mapErrorStatus,
    mapStructuredErrorStatus: options.errors.mapStructuredErrorStatus,
    asyncHandler: options.errors.asyncHandler,
  });
};
