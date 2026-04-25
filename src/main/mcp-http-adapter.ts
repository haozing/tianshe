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
import { createStructuredError, ErrorCode } from '../types/error-codes';
import {
  asTrimmedText,
} from './mcp-http-transport-utils';
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
import type { McpSessionInfo, RegisterMcpRoutesOptions } from './mcp-http-types';
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

const createMcpServer = (
  options: RegisterMcpRoutesOptions,
  mcpSession: McpSessionInfo
): Server => {
  const ensureBrowser = async () => {
    const handle = await ensureSessionBrowserHandle(options, mcpSession);
    return handle.browser;
  };

  const browserFactory = async (factoryOptions: { partition?: string; visible?: boolean }) => {
    const requestedPartition = asTrimmedText(factoryOptions.partition);
    const currentPartition = asTrimmedText(mcpSession.partition);
    if (
      requestedPartition &&
      currentPartition &&
      requestedPartition !== currentPartition
    ) {
      logger.warn(
        `Requested partition ${requestedPartition} differs from session partition ${currentPartition}, reusing session browser`
      );
    }
    if (
      requestedPartition &&
      !currentPartition &&
      !mcpSession.browserHandle &&
      !mcpSession.browserAcquirePromise
    ) {
      mcpSession.partition = requestedPartition;
    }
    if (typeof factoryOptions.visible === 'boolean') {
      mcpSession.visible = factoryOptions.visible;
    }
    return ensureBrowser();
  };

  const deps: OrchestrationDependencies = {
    browserFactory,
    ...(options.dependencies?.systemGateway
      ? { systemGateway: options.dependencies.systemGateway }
      : {}),
    ...(options.dependencies?.datasetGateway
      ? { datasetGateway: options.dependencies.datasetGateway }
      : {}),
    ...(options.dependencies?.crossPluginGateway
      ? { crossPluginGateway: options.dependencies.crossPluginGateway }
      : {}),
    ...(options.dependencies?.pluginGateway
      ? { pluginGateway: options.dependencies.pluginGateway }
      : {}),
    ...(options.dependencies?.profileGateway
      ? { profileGateway: options.dependencies.profileGateway }
      : {}),
    ...(options.dependencies?.observationGateway
      ? { observationGateway: options.dependencies.observationGateway }
      : {}),
    mcpSessionGateway: createMcpSessionGateway(options, mcpSession),
    mcpSessionContext: mcpSession,
    enforceScopes: options.restApiConfig?.enforceOrchestrationScopes ?? false,
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
      name: options.serverInfo.name,
      version: options.serverInfo.version,
    },
    {
      capabilities: serverCapabilities,
    }
  );

  const initializeInstructions = buildMcpInitializeInstructions();
  const initializeShim = createSdkInitializeShim(server, {
    serverInfo: options.serverInfo,
    capabilities: serverCapabilities,
    instructions: initializeInstructions,
  });

  const listCapabilities = (): OrchestrationCapabilityDefinition[] => listPublicCapabilities();
  registerMcpCatalogHandlers({
    server,
    serverInfo: options.serverInfo,
    listCapabilities,
    dependencies: options.dependencies,
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
      const result = await options.enqueueInvokeTask<CallToolResult>(
        mcpSession.sessionId || 'mcp-pending-session',
        mcpSession,
        async (_context): Promise<CallToolResult> => {
          const definition = getCapabilityDefinition(asTrimmedText(name));
          if (!definition) {
            throw createStructuredError(ErrorCode.NOT_FOUND, `Capability not found: ${name}`, {
              suggestion:
                'Call tools/list and use one of the canonical MCP tools exposed on /mcp.',
            });
          }
          const requires = definition?.requires ?? [];
          const needsBrowser =
            requires.includes('browser') || requires.includes('sessionBrowser');
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
                scopes: mcpSession.authScopes || [],
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
      const structured = options.normalizeStructuredError(error);
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
    await options.cleanupSession(sessionId, session);
    const windowManager = options.dependencies?.windowManager;
    try {
      windowManager?.closeHiddenAutomationHost?.(sessionId);
    } catch (error) {
      logger.warn(`Failed to close hidden automation host for session ${sessionId}:`, error);
    }
  };
  const runtimeOptions: RegisterMcpRoutesOptions = {
    ...options,
    cleanupSession,
  };

  registerMcpRouteHandlers({
    app: options.app,
    transports: options.transports,
    serverInfo: options.serverInfo,
    restApiConfig: options.restApiConfig,
    dependencies: options.dependencies,
    parseScopesHeader: options.parseScopesHeader,
    parseRequestedEngine: options.parseRequestedEngine,
    cleanupSession,
    normalizeStructuredError: options.normalizeStructuredError,
    createMcpServer: (mcpSession) => createMcpServer(runtimeOptions, mcpSession),
  });
};
