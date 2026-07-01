import type { Application } from 'express';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import type { BrowserRuntimeId } from '../core/browser-pool/types';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { StructuredError } from '../types/error-codes';
import type { InvokeTaskContext } from './http-session-manager';
import type { OrchestrationCapabilityRegistry } from '../core/ai-dev/orchestration';

export type McpSessionViewportHealth = 'unknown' | 'ready' | 'warning' | 'broken';

export interface McpSessionTransportState {
  sessionId?: string;
  server?: Server;
  httpTransport: StreamableHTTPServerTransport;
}

export interface McpSessionQueueState {
  invokeQueue: Promise<void>;
  pendingInvocations: number;
  activeInvocations: number;
  maxQueueSize: number;
  activeInvocationController?: AbortController;
}

export interface McpSessionBrowserState {
  browserHandle?: BrowserHandle;
  browserAcquirePromise?: Promise<BrowserHandle>;
  partition?: string;
  runtimeId?: BrowserRuntimeId;
  visible: boolean;
  hostWindowId?: string;
}

export interface McpSessionAuthState {
  authScopes?: string[];
}

export interface McpSessionLifecycleState {
  lastActivity: number;
  terminateAfterResponse?: boolean;
  closeController?: AbortController;
  closeReason?: StructuredError;
  closing?: boolean;
}

export interface McpSessionViewportState {
  viewportHealth?: McpSessionViewportHealth;
  viewportHealthReason?: string;
  interactionReady?: boolean;
  offscreenDetected?: boolean;
}

export interface McpSessionInfo {
  transport: McpSessionTransportState;
  queue: McpSessionQueueState;
  browser: McpSessionBrowserState;
  auth: McpSessionAuthState;
  lifecycle: McpSessionLifecycleState;
  viewport: McpSessionViewportState;
}

export interface CreateMcpSessionInfoOptions {
  sessionId?: string;
  server?: Server;
  transport: StreamableHTTPServerTransport;
  transportState?: Partial<McpSessionTransportState>;
  lastActivity?: number;
  invokeQueue?: Promise<void>;
  pendingInvocations?: number;
  activeInvocations?: number;
  maxQueueSize: number;
  queue?: Partial<McpSessionQueueState>;
  browserHandle?: BrowserHandle;
  browserAcquirePromise?: Promise<BrowserHandle>;
  partition?: string;
  runtimeId?: BrowserRuntimeId;
  visible?: boolean;
  browser?: Partial<McpSessionBrowserState>;
  authScopes?: string[];
  auth?: Partial<McpSessionAuthState>;
  terminateAfterResponse?: boolean;
  closeController?: AbortController;
  closeReason?: StructuredError;
  activeInvocationController?: AbortController;
  closing?: boolean;
  lifecycle?: Partial<McpSessionLifecycleState>;
  hostWindowId?: string;
  viewportHealth?: McpSessionViewportHealth;
  viewportHealthReason?: string;
  interactionReady?: boolean;
  offscreenDetected?: boolean;
  viewport?: Partial<McpSessionViewportState>;
}

export const createMcpSessionInfo = (options: CreateMcpSessionInfoOptions): McpSessionInfo => {
  const transport: McpSessionTransportState = {
    sessionId: options.sessionId,
    server: options.server,
    httpTransport: options.transport,
    ...options.transportState,
  };

  const queue: McpSessionQueueState = {
    invokeQueue: options.invokeQueue ?? Promise.resolve(),
    pendingInvocations: options.pendingInvocations ?? 0,
    activeInvocations: options.activeInvocations ?? 0,
    maxQueueSize: options.maxQueueSize,
    activeInvocationController: options.activeInvocationController,
    ...options.queue,
  };
  queue.maxQueueSize = options.queue?.maxQueueSize ?? options.maxQueueSize;

  const browser: McpSessionBrowserState = {
    browserHandle: options.browserHandle,
    browserAcquirePromise: options.browserAcquirePromise,
    partition: options.partition,
    runtimeId: options.runtimeId,
    visible: options.visible ?? false,
    hostWindowId: options.hostWindowId,
    ...options.browser,
  };
  browser.visible = options.browser?.visible ?? options.visible ?? false;

  const auth: McpSessionAuthState = {
    authScopes: options.authScopes,
    ...options.auth,
  };

  const lifecycle: McpSessionLifecycleState = {
    lastActivity: options.lastActivity ?? Date.now(),
    terminateAfterResponse: options.terminateAfterResponse,
    closeController: options.closeController,
    closeReason: options.closeReason,
    closing: options.closing,
    ...options.lifecycle,
  };
  lifecycle.lastActivity = options.lifecycle?.lastActivity ?? options.lastActivity ?? Date.now();

  const viewport: McpSessionViewportState = {
    viewportHealth: options.viewportHealth,
    viewportHealthReason: options.viewportHealthReason,
    interactionReady: options.interactionReady,
    offscreenDetected: options.offscreenDetected,
    ...options.viewport,
  };

  return {
    transport,
    queue,
    browser,
    auth,
    lifecycle,
    viewport,
  };
};

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpHttpRouteContext {
  app: Application;
  transports: Map<string, McpSessionInfo>;
  serverInfo: McpServerInfo;
  restApiConfig?: RestApiConfig;
  dependencies?: RestApiDependencies;
  capabilityRegistry?: OrchestrationCapabilityRegistry;
}

export interface McpAuthContext {
  parseScopesHeader: (value: unknown) => string[];
  normalizeStructuredError: (error: unknown) => StructuredError;
}

export interface McpBrowserBindingPort {
  parseRequestedRuntimeId: (value: string | undefined) => BrowserRuntimeId | undefined;
  acquireBrowserFromPool: (
    profileId?: string,
    runtimeId?: BrowserRuntimeId,
    source?: 'mcp' | 'http',
    signal?: AbortSignal
  ) => Promise<BrowserHandle>;
  getBrowserPoolManager?: () => BrowserPoolManager;
}

export interface McpInvokeQueuePort {
  enqueueInvokeTask: <T>(
    sessionLabel: string,
    session: McpSessionInfo,
    task: (context: InvokeTaskContext) => Promise<T>,
    options: { timeoutMs: number }
  ) => Promise<T>;
}

export interface McpSessionLifecyclePort {
  cleanupSession: (sessionId: string, session: McpSessionInfo) => Promise<void>;
}

export interface RegisterMcpRoutesOptions {
  routeContext: McpHttpRouteContext;
  authContext: McpAuthContext;
  browserBinding: McpBrowserBindingPort;
  invokeQueue: McpInvokeQueuePort;
  sessionLifecycle: McpSessionLifecyclePort;
}

export interface RegisterMcpRouteHandlersOptions {
  routeContext: McpHttpRouteContext;
  sessionLifecycle: McpSessionLifecyclePort;
  createMcpServer: (mcpSession: McpSessionInfo) => Server;
}

export interface McpSessionRuntimeOptions extends McpBrowserBindingPort, McpSessionLifecyclePort {
  transports: Map<string, McpSessionInfo>;
  dependencies?: RestApiDependencies;
}
