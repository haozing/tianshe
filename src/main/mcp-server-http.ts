/**
 * Airpa 浏览器 HTTP MCP 服务器
 *
 * 使用 HTTP 传输协议，开发者先手动启动 Electron 应用，
 * 然后 Claude Code 通过 HTTP 连接到本地服务器。
 *
 * v2 重构：统一使用浏览器池
 * - 所有浏览器都通过 BrowserPoolManager 获取
 * - 会话结束时自动释放浏览器回池
 * - 消除了独立的浏览器创建逻辑
 *
 * @module mcp-server-http
 */

import express from 'express';
import type { Server as HttpServer } from 'http';

import { createLogger } from '../core/logger'; // 使用统一的 pino logger
import type { RestApiDependencies, RestApiConfig } from '../types/http-api';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import type { BrowserPoolManager } from '../core/browser-pool';
import {
  createAsyncHandler,
  mapErrorStatus,
  mapStructuredErrorStatus,
  toStructuredError,
} from './http-error-utils';
import { startHttpServer, stopHttpServer } from './http-server-lifecycle';
import { createHttpRuntimeState, getSessionCounts } from './http-runtime-state';
import { createHttpSessionBridge } from './http-session-bridge';
import { createHttpServerComposition } from './http-server-composition';
import {
  listOrchestrationCapabilities,
} from '../core/ai-dev/orchestration';

/**
 * MCP HTTP 服务器日志
 */
const logger = createLogger('MCP-HTTP');
const asyncHandler = createAsyncHandler(logger);

/**
 * HTTP MCP 服务器配置
 */
export interface HttpMcpServerConfig {
  /** 服务器端口，默认使用 HTTP_SERVER_DEFAULTS.PORT */
  port?: number;
  /** 服务器名称 */
  name?: string;
  /** 服务器版本 */
  version?: string;
}

/**
 * HTTP MCP 服务器类
 *
 * v2 重构：使用浏览器池管理浏览器实例
 */
export class AirpaHttpMcpServer {
  private app: express.Application;
  private httpServer: HttpServer | null = null;
  private runtimeState = createHttpRuntimeState();
  private transports = this.runtimeState.transports;
  private orchestrationSessions = this.runtimeState.orchestrationSessions;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private config: Required<HttpMcpServerConfig>;
  private dependencies?: RestApiDependencies;
  private restApiConfig?: RestApiConfig;
  private getBrowserPoolManager?: () => BrowserPoolManager;
  private runtimeMetrics = this.runtimeState.runtimeMetrics;
  private sessionBridge = createHttpSessionBridge({
    transports: this.runtimeState.transports,
    orchestrationSessions: this.runtimeState.orchestrationSessions,
    runtimeMetrics: this.runtimeMetrics,
    sessionTimeoutMs: HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT,
    logger,
  });

  constructor(
    config: HttpMcpServerConfig = {},
    dependencies?: RestApiDependencies,
    restApiConfig?: RestApiConfig,
    getBrowserPoolManager?: () => BrowserPoolManager
  ) {
    this.config = {
      port: config.port ?? HTTP_SERVER_DEFAULTS.PORT,
      name: config.name ?? 'airpa-browser-http',
      version: config.version ?? '1.0.0',
    };
    this.dependencies = dependencies;
    this.restApiConfig = restApiConfig;
    this.getBrowserPoolManager = getBrowserPoolManager;

    this.app = createHttpServerComposition({
      serverName: this.config.name,
      serverVersion: this.config.version,
      restApiConfig: this.restApiConfig,
      dependencies: this.dependencies,
      runtimeState: this.runtimeState,
      runtimeMetrics: this.runtimeMetrics,
      sessionBridge: this.sessionBridge,
      getBrowserPoolManager: this.getBrowserPoolManager,
      normalizeStructuredError: toStructuredError,
      mapErrorStatus: (code, fallback) => mapErrorStatus(code, fallback),
      mapStructuredErrorStatus: (error, fallback) => mapStructuredErrorStatus(error, fallback),
      asyncHandler,
      logger,
    });
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    const started = await startHttpServer({
      app: this.app,
      port: this.config.port,
      bindAddress: HTTP_SERVER_DEFAULTS.BIND_ADDRESS,
      mcpEnabled: this.restApiConfig?.enableMcp ?? false,
      availableToolsCount: listOrchestrationCapabilities().length,
      sessionSupportEnabled: Boolean(this.getBrowserPoolManager),
      sessionTimeoutMs: HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT,
      sessionCleanupIntervalMs: HTTP_SERVER_DEFAULTS.SESSION_CLEANUP_INTERVAL,
      onCleanupInactiveSessions: () => this.sessionBridge.cleanupInactiveSessions(),
      logger,
    });
    this.httpServer = started.httpServer;
    this.cleanupTimer = started.cleanupTimer;
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    const stopped = await stopHttpServer({
      httpServer: this.httpServer,
      cleanupTimer: this.cleanupTimer,
      transports: this.runtimeState.transports,
      orchestrationSessions: this.runtimeState.orchestrationSessions,
      cleanupMcpSession: (sessionId, session) =>
        this.sessionBridge.cleanupMcpSession(sessionId, session),
      cleanupOrchestrationSession: (sessionId, session) =>
        this.sessionBridge.cleanupOrchestrationSession(sessionId, session),
      logger,
    });
    this.httpServer = stopped.httpServer;
    this.cleanupTimer = stopped.cleanupTimer;
  }

  getStatus(): {
    running: boolean;
    port: number;
    activeSessions: number;
    mcpSessions: number;
    orchestrationSessions: number;
  } {
    const counts = getSessionCounts(this.runtimeState);
    return {
      running: !!this.httpServer,
      port: this.config.port,
      activeSessions: counts.activeSessions,
      mcpSessions: counts.mcpSessions,
      orchestrationSessions: counts.orchestrationSessions,
    };
  }
}

/**
 * 创建并启动 HTTP MCP 服务器
 *
 * v2 重构：使用浏览器池管理浏览器实例
 *
 * @param config 服务器配置
 * @param dependencies REST API 依赖项
 * @param restApiConfig REST API 配置
 * @param getBrowserPoolManager 获取浏览器池管理器的函数
 * @returns HTTP MCP 服务器实例
 */
export async function createHttpMcpServer(
  config?: HttpMcpServerConfig,
  dependencies?: RestApiDependencies,
  restApiConfig?: RestApiConfig,
  getBrowserPoolManager?: () => BrowserPoolManager
): Promise<AirpaHttpMcpServer> {
  const server = new AirpaHttpMcpServer(config, dependencies, restApiConfig, getBrowserPoolManager);
  await server.start();
  return server;
}
