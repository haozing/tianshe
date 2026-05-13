import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import { createLogger } from '../core/logger';
import {
  createOrchestrationExecutor,
  type OrchestrationDependencies,
  type OrchestrationCapabilityDefinition,
  listCanonicalPublicCapabilities,
} from '../core/ai-dev/orchestration';
import type { OrchestrationBrowserSessionContext } from '../core/ai-dev/orchestration/types';
import { createStructuredError, ErrorCode } from '../types/error-codes';
import { asTrimmedText } from './mcp-http-transport-utils';
import { registerMcpCatalogHandlers } from './mcp-http-catalog';
import { buildMcpInitializeInstructions } from './mcp-initialize-instructions';
import { createSdkInitializeShim } from './mcp-sdk-initialize-shim';
import { getRuntimeFingerprint } from './runtime-fingerprint';
import {
  createMcpSessionGateway,
  ensureSessionBrowserHandle,
  formatStructuredErrorForMcp,
  recycleSessionBrowserHandle,
  shouldRecycleSessionBrowser,
} from './mcp-http-session-runtime';
import { registerMcpRouteHandlers } from './mcp-http-route-handlers';
import type {
  McpSessionInfo,
  McpSessionRuntimeOptions,
  RegisterMcpRoutesOptions,
} from './mcp-http-types';
export type { McpServerInfo, McpSessionInfo, RegisterMcpRoutesOptions } from './mcp-http-types';

const logger = createLogger('MCP-HTTP');
export { armPendingMcpSessionTerminationOnResponse } from './mcp-http-session-lifecycle';

type ExecutorCallResult = {
  content: CallToolResult['content'];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

const toMcpToolResult = (result: ExecutorCallResult): CallToolResult => ({
  content: result.content,
  ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  ...(result.isError ? { isError: true } : {}),
  ...(result._meta ? { _meta: result._meta } : {}),
});

const createMcpSessionContextAdapter = (
  mcpSession: McpSessionInfo
): OrchestrationBrowserSessionContext => {
  const context = {};
  const define = <T>(
    key: keyof OrchestrationBrowserSessionContext,
    getValue: () => T,
    setValue: (value: T) => void
  ) => {
    Object.defineProperty(context, key, {
      enumerable: true,
      configurable: true,
      get: getValue,
      set: setValue,
    });
  };

  define(
    'sessionId',
    () => mcpSession.transport.sessionId,
    (value) => {
      mcpSession.transport.sessionId = value;
    }
  );
  define(
    'visible',
    () => mcpSession.browser.visible,
    (value) => {
      mcpSession.browser.visible = value === true;
    }
  );
  define(
    'hostWindowId',
    () => mcpSession.browser.hostWindowId,
    (value) => {
      mcpSession.browser.hostWindowId = value;
    }
  );
  define(
    'viewportHealth',
    () => mcpSession.viewport.viewportHealth,
    (value) => {
      mcpSession.viewport.viewportHealth = value;
    }
  );
  define(
    'viewportHealthReason',
    () => mcpSession.viewport.viewportHealthReason,
    (value) => {
      mcpSession.viewport.viewportHealthReason = value;
    }
  );
  define(
    'interactionReady',
    () => mcpSession.viewport.interactionReady,
    (value) => {
      mcpSession.viewport.interactionReady = value === true;
    }
  );
  define(
    'offscreenDetected',
    () => mcpSession.viewport.offscreenDetected,
    (value) => {
      mcpSession.viewport.offscreenDetected = value === true;
    }
  );

  return context as OrchestrationBrowserSessionContext;
};

const createSessionRuntimeOptions = (
  options: RegisterMcpRoutesOptions
): McpSessionRuntimeOptions => ({
  transports: options.routeContext.transports,
  dependencies: options.routeContext.dependencies,
  parseRequestedRuntimeId: options.browserBinding.parseRequestedRuntimeId,
  acquireBrowserFromPool: options.browserBinding.acquireBrowserFromPool,
  getBrowserPoolManager: options.browserBinding.getBrowserPoolManager,
  cleanupSession: options.sessionLifecycle.cleanupSession,
});

const createMcpServer = (options: RegisterMcpRoutesOptions, mcpSession: McpSessionInfo): Server => {
  const ensureBrowser = async () => {
    const handle = await ensureSessionBrowserHandle(
      createSessionRuntimeOptions(options),
      mcpSession
    );
    return handle.browser;
  };

  const browserFactory = async (factoryOptions: { partition?: string; visible?: boolean }) => {
    const requestedPartition = asTrimmedText(factoryOptions.partition);
    const currentPartition = asTrimmedText(mcpSession.browser.partition);
    if (requestedPartition && currentPartition && requestedPartition !== currentPartition) {
      logger.warn(
        `Requested partition ${requestedPartition} differs from session partition ${currentPartition}, reusing session browser`
      );
    }
    if (
      requestedPartition &&
      !currentPartition &&
      !mcpSession.browser.browserHandle &&
      !mcpSession.browser.browserAcquirePromise
    ) {
      mcpSession.browser.partition = requestedPartition;
    }
    if (typeof factoryOptions.visible === 'boolean') {
      mcpSession.browser.visible = factoryOptions.visible;
    }
    return ensureBrowser();
  };

  const deps: OrchestrationDependencies = {
    browserFactory,
    ...(options.routeContext.dependencies?.systemGateway
      ? { systemGateway: options.routeContext.dependencies.systemGateway }
      : {}),
    ...(options.routeContext.dependencies?.datasetGateway
      ? { datasetGateway: options.routeContext.dependencies.datasetGateway }
      : {}),
    ...(options.routeContext.dependencies?.crossPluginGateway
      ? { crossPluginGateway: options.routeContext.dependencies.crossPluginGateway }
      : {}),
    ...(options.routeContext.dependencies?.pluginGateway
      ? { pluginGateway: options.routeContext.dependencies.pluginGateway }
      : {}),
    ...(options.routeContext.dependencies?.profileGateway
      ? { profileGateway: options.routeContext.dependencies.profileGateway }
      : {}),
    ...(options.routeContext.dependencies?.observationGateway
      ? { observationGateway: options.routeContext.dependencies.observationGateway }
      : {}),
    mcpSessionGateway: createMcpSessionGateway(createSessionRuntimeOptions(options), mcpSession),
    mcpSessionContext: createMcpSessionContextAdapter(mcpSession),
    enforceScopes: options.routeContext.restApiConfig?.enforceOrchestrationScopes ?? false,
  };
  const executor = createOrchestrationExecutor(deps);
  const listPublicCapabilities = (): OrchestrationCapabilityDefinition[] =>
    listCanonicalPublicCapabilities(executor.listCapabilities());
  const getCapabilityDefinition = (name: string): OrchestrationCapabilityDefinition | undefined =>
    listPublicCapabilities().find((item) => item.name === name);

  const serverCapabilities = {
    tools: {},
    resources: {
      subscribe: false,
      listChanged: false,
    },
    prompts: {
      listChanged: false,
    },
  } as const;

  const server = new Server(
    {
      name: options.routeContext.serverInfo.name,
      version: options.routeContext.serverInfo.version,
    },
    {
      capabilities: serverCapabilities,
    }
  );

  const initializeInstructions = buildMcpInitializeInstructions();
  const initializeShim = createSdkInitializeShim(server, {
    serverInfo: options.routeContext.serverInfo,
    capabilities: serverCapabilities,
    instructions: initializeInstructions,
  });

  const listCapabilities = (): OrchestrationCapabilityDefinition[] => listPublicCapabilities();
  registerMcpCatalogHandlers({
    server,
    serverInfo: options.routeContext.serverInfo,
    listCapabilities,
    dependencies: options.routeContext.dependencies,
    mcpSession,
  });

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const baseResult = await initializeShim.initialize(request);

    return {
      ...baseResult,
      instructions:
        asTrimmedText((baseResult as { instructions?: unknown }).instructions) ||
        initializeInstructions,
      ...getRuntimeFingerprint(),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await options.invokeQueue.enqueueInvokeTask<CallToolResult>(
        mcpSession.transport.sessionId || 'mcp-pending-session',
        mcpSession,
        async (_context): Promise<CallToolResult> => {
          const definition = getCapabilityDefinition(asTrimmedText(name));
          if (!definition) {
            throw createStructuredError(ErrorCode.NOT_FOUND, `Capability not found: ${name}`, {
              suggestion: 'Call tools/list and use one of the canonical MCP tools exposed on /mcp.',
            });
          }
          const requires = definition?.requires ?? [];
          const needsBrowser = requires.includes('browser') || requires.includes('sessionBrowser');
          if (needsBrowser) {
            deps.browser = await ensureBrowser();
          } else {
            delete deps.browser;
          }
          const capabilityResult = await executor.invoke(
            {
              name,
              arguments: args || {},
              auth: {
                scopes: mcpSession.auth.authScopes || [],
                source: 'mcp',
              },
            },
            {
              signal: _context.signal,
            }
          );
          return toMcpToolResult(capabilityResult);
        },
        { timeoutMs: HTTP_SERVER_DEFAULTS.MCP_INVOKE_TIMEOUT_MS }
      );

      return result;
    } catch (error) {
      const structured = options.authContext.normalizeStructuredError(error);
      logger.error(`Tool ${name} error:`, error);
      if (shouldRecycleSessionBrowser(structured)) {
        await recycleSessionBrowserHandle(mcpSession, structured);
      }
      return formatStructuredErrorForMcp(structured);
    }
  });

  return server;
};

export const registerMcpRoutes = (options: RegisterMcpRoutesOptions): void => {
  const cleanupSession = async (sessionId: string, session: McpSessionInfo): Promise<void> => {
    await options.sessionLifecycle.cleanupSession(sessionId, session);
    const windowManager = options.routeContext.dependencies?.windowManager;
    try {
      windowManager?.closeHiddenAutomationHost?.(sessionId);
    } catch (error) {
      logger.warn(`Failed to close hidden automation host for session ${sessionId}:`, error);
    }
  };
  const runtimeOptions: RegisterMcpRoutesOptions = {
    ...options,
    sessionLifecycle: {
      cleanupSession,
    },
  };

  registerMcpRouteHandlers({
    routeContext: options.routeContext,
    sessionLifecycle: {
      cleanupSession,
    },
    createMcpServer: (mcpSession) => createMcpServer(runtimeOptions, mcpSession),
  });
};
