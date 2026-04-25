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

interface RegisterHttpRoutesOptions {
  app: Application;
  serverName: string;
  serverVersion: string;
  restApiConfig?: RestApiConfig;
  dependencies?: RestApiDependencies;
  transports: Map<string, McpSessionInfo>;
  orchestrationSessions: Map<string, OrchestrationSessionInfo>;
  browserPoolAvailable: boolean;
  parseScopesHeader: (value: unknown) => string[];
  firstString: (value: unknown) => string;
  parseRequestedEngine: (value: string | undefined) => AutomationEngine | undefined;
  acquireBrowserFromPool: (
    profileId?: string,
    engine?: AutomationEngine,
    source?: 'mcp' | 'http'
  ) => Promise<BrowserHandle>;
  getBrowserPoolManager?: () => BrowserPoolManager;
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
  getSessionCounts?: () => SessionCountsSnapshot;
  buildRuntimeMetricsPayload: () => RuntimeMetricsPayload;
  normalizeStructuredError: (error: unknown) => StructuredError;
  mapErrorStatus: (code: string, fallback?: number) => number;
  mapStructuredErrorStatus: (error: StructuredError, fallback?: number) => number;
  asyncHandler: (
    handler: (req: Request, res: Response) => Promise<void>
  ) => (req: Request, res: Response) => Promise<void>;
  logger: LoggerLike;
}

/**
 * 注册 HTTP 主入口下的系统路由、MCP 路由与编排路由。
 */
export const registerHttpRoutes = (options: RegisterHttpRoutesOptions): void => {
  const mcpConfigured = options.restApiConfig?.enableMcp ?? false;
  const mcpEndpointEnabled = mcpConfigured;

  registerHealthRoute({
    app: options.app,
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    restApiConfig: options.restApiConfig,
    mcpConfigured,
    mcpEndpointEnabled,
    getSessionCounts:
      options.getSessionCounts ??
      (() => ({
        activeSessions: options.transports.size + options.orchestrationSessions.size,
        mcpSessions: options.transports.size,
        orchestrationSessions: options.orchestrationSessions.size,
      })),
    getRuntimeMetrics: () => options.buildRuntimeMetricsPayload(),
  });

  if (mcpEndpointEnabled) {
    registerMcpRoutes({
      app: options.app,
      transports: options.transports,
      serverInfo: {
        name: options.serverName,
        version: options.serverVersion,
      },
      restApiConfig: options.restApiConfig,
      dependencies: options.dependencies,
      parseScopesHeader: options.parseScopesHeader,
      parseRequestedEngine: options.parseRequestedEngine,
      acquireBrowserFromPool: options.acquireBrowserFromPool,
      getBrowserPoolManager: options.getBrowserPoolManager,
      enqueueInvokeTask: options.enqueueInvokeTask,
      cleanupSession: options.cleanupSession,
      normalizeStructuredError: options.normalizeStructuredError,
    });
    options.logger.info('MCP endpoint enabled: /mcp');
  } else {
    options.logger.info('MCP endpoint disabled (enableMcp=false)');
  }

  registerOrchestrationRoutes({
    app: options.app,
    restApiConfig: options.restApiConfig,
    dependencies: options.dependencies,
    browserPoolAvailable: options.browserPoolAvailable,
    orchestrationSessions: options.orchestrationSessions,
    parseScopesHeader: options.parseScopesHeader,
    firstString: options.firstString,
    acquireBrowserFromPool: options.acquireBrowserFromPool,
    enqueueOrchestrationInvoke: options.enqueueOrchestrationInvoke,
    cleanupOrchestrationSession: options.cleanupOrchestrationSession,
    buildRuntimeMetricsPayload: options.buildRuntimeMetricsPayload,
    normalizeStructuredError: options.normalizeStructuredError,
    mapErrorStatus: options.mapErrorStatus,
    mapStructuredErrorStatus: options.mapStructuredErrorStatus,
    asyncHandler: options.asyncHandler,
  });
};
