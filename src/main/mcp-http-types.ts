import type { Application } from 'express';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import type { AutomationEngine } from '../core/browser-pool/types';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { StructuredError } from '../types/error-codes';
import type { InvokeTaskContext } from './http-session-manager';

export type McpSessionViewportHealth = 'unknown' | 'ready' | 'warning' | 'broken';

export interface McpSessionInfo {
  sessionId?: string;
  server?: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  invokeQueue: Promise<void>;
  pendingInvocations: number;
  activeInvocations: number;
  maxQueueSize: number;
  browserHandle?: BrowserHandle;
  browserAcquirePromise?: Promise<BrowserHandle>;
  partition?: string;
  engine?: AutomationEngine;
  visible: boolean;
  authScopes?: string[];
  terminateAfterResponse?: boolean;
  closeController?: AbortController;
  closeReason?: StructuredError;
  activeInvocationController?: AbortController;
  closing?: boolean;
  hostWindowId?: string;
  viewportHealth?: McpSessionViewportHealth;
  viewportHealthReason?: string;
  interactionReady?: boolean;
  offscreenDetected?: boolean;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface RegisterMcpRoutesOptions {
  app: Application;
  transports: Map<string, McpSessionInfo>;
  serverInfo: McpServerInfo;
  restApiConfig?: RestApiConfig;
  dependencies?: RestApiDependencies;
  parseScopesHeader: (value: unknown) => string[];
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
  normalizeStructuredError: (error: unknown) => StructuredError;
}

export interface RegisterMcpRouteHandlersOptions
  extends Omit<RegisterMcpRoutesOptions, 'acquireBrowserFromPool' | 'enqueueInvokeTask'> {
  createMcpServer: (mcpSession: McpSessionInfo) => Server;
}

export type McpSessionRuntimeOptions = Pick<
  RegisterMcpRoutesOptions,
  | 'transports'
  | 'dependencies'
  | 'parseRequestedEngine'
  | 'acquireBrowserFromPool'
  | 'cleanupSession'
  | 'getBrowserPoolManager'
>;
