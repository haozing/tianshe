import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import { createLogger } from '../core/logger';
import {
  asTrimmedText,
  createMcpTransportRequest,
  extractSingleJsonRpcRequestId,
  findInitializeRequest,
  isValidJsonRpcRequestId,
  validateMcpOrigin,
  validateMcpProtocolVersion,
  writeJsonRpcError,
  type JsonRpcRequestId,
} from './mcp-http-transport-utils';
import { armPendingMcpSessionTerminationOnResponse } from './mcp-http-session-lifecycle';
import type { McpSessionInfo, RegisterMcpRouteHandlersOptions } from './mcp-http-types';

const logger = createLogger('MCP-HTTP');

const UNSUPPORTED_MCP_TRANSPORT_INPUTS = [
  'x-airpa-tool-profile',
  'mcp-partition',
  'mcp-partition-id',
  'mcp-engine',
  'mcp-browser-engine',
  'x-airpa-scopes',
] as const;

const UNSUPPORTED_MCP_QUERY_INPUTS = [
  'toolProfile',
  'airpaToolProfile',
  'x-airpa-tool-profile',
] as const;

const rejectUnsupportedTransportInput = (
  res: Response,
  inputName: string,
  inputValue: unknown,
  requestId?: JsonRpcRequestId | null
): false => {
  writeJsonRpcError(
    res,
    400,
    -32600,
    `Unsupported MCP transport input: ${inputName}`,
    {
      reason: 'unsupported_transport_input',
      input: inputName,
      value: asTrimmedText(Array.isArray(inputValue) ? inputValue[0] : inputValue),
      hint:
        'Remove transport-level profile, engine, tool-surface, and scope controls. Use session_prepare to configure the current MCP session.',
    },
    requestId
  );
  return false;
};

const validateCanonicalTransportInputs = (
  req: Request,
  res: Response,
  requestId?: JsonRpcRequestId | null
): boolean => {
  for (const headerName of UNSUPPORTED_MCP_TRANSPORT_INPUTS) {
    if (req.headers[headerName] !== undefined) {
      return rejectUnsupportedTransportInput(res, headerName, req.headers[headerName], requestId);
    }
  }

  for (const queryName of UNSUPPORTED_MCP_QUERY_INPUTS) {
    const queryValue = req.query?.[queryName];
    if (queryValue !== undefined) {
      return rejectUnsupportedTransportInput(res, queryName, queryValue, requestId);
    }
  }

  return true;
};

const validateInitializeRequestId = (
  body: unknown,
  res: Response,
  requestId?: JsonRpcRequestId | null
): boolean => {
  const initializeRequest = findInitializeRequest(body);
  if (!initializeRequest) {
    return true;
  }

  const initializeRequestId = (initializeRequest.message as { id?: unknown }).id;
  if (isValidJsonRpcRequestId(initializeRequestId)) {
    return true;
  }

  writeJsonRpcError(
    res,
    400,
    -32600,
    'Initialize requests must include a valid JSON-RPC id',
    {
      reason: 'missing_initialize_request_id',
      hint:
        'Use a standard MCP SDK or send a JSON-RPC initialize request with a string or integer id.',
    },
    requestId
  );
  return false;
};

const handleExistingSessionRequest = async (
  options: RegisterMcpRouteHandlersOptions,
  req: Request,
  res: Response,
  requestBody: unknown,
  requestId: JsonRpcRequestId | null,
  sessionId: string
): Promise<void> => {
  const session = options.transports.get(sessionId);
  if (!session) {
    writeJsonRpcError(res, 404, -32000, 'Session not found', {
      reason: 'session_not_found_or_closed',
      sessionId,
      hint: 'Create a new MCP session before sending more requests.',
    }, requestId);
    return;
  }

  session.lastActivity = Date.now();
  logger.debug(`Reusing transport for session: ${sessionId}`);

  armPendingMcpSessionTerminationOnResponse(options, res, session);
  await session.transport.handleRequest(req, res, requestBody);
};

const handleInitializeRequest = async (
  options: RegisterMcpRouteHandlersOptions,
  req: Request,
  res: Response,
  requestBody: unknown,
  requestId: JsonRpcRequestId | null,
  _initializeRequest: Record<string, unknown>
): Promise<void> => {
  logger.info('Creating new MCP session');

  let transport!: StreamableHTTPServerTransport;
  let mcpServer: Server | undefined;
  let sessionRegistered = false;
  let initializedSessionId = '';
  const sessionInfo: McpSessionInfo = {
    server: undefined,
    transport: null as unknown as StreamableHTTPServerTransport,
    lastActivity: Date.now(),
    invokeQueue: Promise.resolve(),
    pendingInvocations: 0,
    activeInvocations: 0,
    maxQueueSize: HTTP_SERVER_DEFAULTS.MCP_MAX_QUEUE_SIZE,
    visible: false,
    authScopes: [],
  };

  try {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId: string) => {
        logger.info(`Session initialized: ${newSessionId}`);
        sessionInfo.sessionId = newSessionId;
        sessionInfo.transport = transport;
        options.transports.set(newSessionId, sessionInfo);
        initializedSessionId = newSessionId;
        sessionRegistered = true;
      },
    });

    mcpServer = options.createMcpServer(sessionInfo);
    sessionInfo.server = mcpServer;
    await mcpServer.connect(transport);

    armPendingMcpSessionTerminationOnResponse(options, res, sessionInfo);
    await transport.handleRequest(req, res, requestBody);
  } catch (initError) {
    if (sessionRegistered && initializedSessionId) {
      const session = options.transports.get(initializedSessionId);
      if (session) {
        options.transports.delete(initializedSessionId);
        try {
          await options.cleanupSession(initializedSessionId, session);
        } catch (cleanupError) {
          logger.error('Failed to cleanup partially initialized session:', cleanupError);
        }
      }
    } else if (mcpServer) {
      try {
        await mcpServer.close();
      } catch (serverCloseError) {
        logger.error('Failed to close partially initialized MCP server:', serverCloseError);
      }
    }
    throw initError;
  }
};

const createMcpGetHandler =
  (options: RegisterMcpRouteHandlersOptions) => async (req: Request, res: Response) => {
    const allowedOrigins = options.restApiConfig?.mcpAllowedOrigins;

    try {
      if (!validateMcpOrigin(req, res, allowedOrigins)) {
        return;
      }
      if (!validateCanonicalTransportInputs(req, res)) {
        return;
      }

      const sessionId = asTrimmedText(req.headers['mcp-session-id']);
      if (!sessionId) {
        writeJsonRpcError(res, 400, -32000, 'Missing mcp-session-id header', {
          reason: 'missing_session_id',
          sessionId: null,
          hint: 'Include mcp-session-id when reading an MCP event stream.',
        });
        return;
      }

      const session = options.transports.get(sessionId);
      if (!session) {
        writeJsonRpcError(res, 404, -32000, 'Session not found', {
          reason: 'session_not_found_or_closed',
          sessionId,
          hint: 'Create a new MCP session before reconnecting to the event stream.',
        });
        return;
      }

      session.lastActivity = Date.now();
      await session.transport.handleRequest(createMcpTransportRequest(req), res);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error handling MCP GET request:', error);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, `Internal error: ${errorMessage}`, {
          reason: 'mcp_get_failed',
        });
      }
    }
  };

const createMcpDeleteHandler =
  (options: RegisterMcpRouteHandlersOptions) => async (req: Request, res: Response) => {
    const allowedOrigins = options.restApiConfig?.mcpAllowedOrigins;

    try {
      const requestId = extractSingleJsonRpcRequestId(req.body);
      if (!validateMcpOrigin(req, res, allowedOrigins)) {
        return;
      }
      if (!validateCanonicalTransportInputs(req, res, requestId)) {
        return;
      }

      const sessionId = asTrimmedText(req.headers['mcp-session-id']);
      if (!sessionId) {
        writeJsonRpcError(res, 400, -32600, 'Missing mcp-session-id header', {
          reason: 'missing_session_id',
          sessionId: null,
          hint: 'Include mcp-session-id when terminating an MCP session.',
        });
        return;
      }

      const session = options.transports.get(sessionId);
      if (!session) {
        writeJsonRpcError(res, 404, -32000, 'Session not found', {
          reason: 'session_not_found_or_closed',
          sessionId,
          hint: 'Create a new MCP session before sending more requests.',
        });
        return;
      }

      logger.info(`Terminating MCP session via DELETE: ${sessionId}`);
      options.transports.delete(sessionId);
      await options.cleanupSession(sessionId, session);
      res.status(204).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Error terminating MCP session:', error);
      writeJsonRpcError(res, 500, -32603, `Internal error: ${message}`, {
        reason: 'session_termination_failed',
        hint: 'Retry session termination or inspect server logs for cleanup failures.',
      });
    }
  };

const createMcpPostHandler =
  (options: RegisterMcpRouteHandlersOptions) => async (req: Request, res: Response) => {
    const allowedOrigins = options.restApiConfig?.mcpAllowedOrigins;
    logger.debug('Received MCP request');

    try {
      const requestId = extractSingleJsonRpcRequestId(req.body);
      if (!validateMcpOrigin(req, res, allowedOrigins, requestId)) {
        return;
      }

      if (!validateCanonicalTransportInputs(req, res, requestId)) {
        return;
      }

      const mcpBody = req.body;
      const transportRequest = createMcpTransportRequest(req);

      if (!validateMcpProtocolVersion(transportRequest, res, mcpBody, requestId)) {
        return;
      }
      if (!validateInitializeRequestId(mcpBody, res, requestId)) {
        return;
      }

      const sessionId = asTrimmedText(req.headers['mcp-session-id']);
      const initializeRequest = findInitializeRequest(mcpBody);

      if (sessionId && options.transports.has(sessionId)) {
        await handleExistingSessionRequest(
          options,
          transportRequest,
          res,
          mcpBody,
          requestId,
          sessionId
        );
        return;
      }

      if (!sessionId && initializeRequest) {
        await handleInitializeRequest(
          options,
          transportRequest,
          res,
          mcpBody,
          requestId,
          initializeRequest.message
        );
        return;
      }

      if (sessionId) {
        logger.warn(`Invalid MCP request for missing or closed session: ${sessionId}`);
        writeJsonRpcError(res, 404, -32000, 'Session not found', {
          sessionId,
          reason: 'session_not_found_or_closed',
          hint: 'Create a new MCP session before sending more requests.',
        }, requestId);
        return;
      }

      logger.warn('Invalid request: no session ID or not initialization');
      writeJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided', undefined, requestId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, `Internal error: ${errorMessage}`, {
          reason: 'mcp_post_failed',
        }, extractSingleJsonRpcRequestId(req.body));
      }
    }
  };

export const registerMcpRouteHandlers = (options: RegisterMcpRouteHandlersOptions): void => {
  options.app.get('/mcp', createMcpGetHandler(options));
  options.app.delete('/mcp', createMcpDeleteHandler(options));
  options.app.post('/mcp', createMcpPostHandler(options));
};
