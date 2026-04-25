import type { Application } from 'express';
import type { Server as HttpServer } from 'http';

interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface StartedHttpServerState {
  httpServer: HttpServer;
  cleanupTimer: NodeJS.Timeout | null;
}

interface StartHttpServerOptions {
  app: Application;
  port: number;
  bindAddress: string;
  mcpEnabled: boolean;
  availableToolsCount: number;
  sessionSupportEnabled: boolean;
  sessionTimeoutMs: number;
  sessionCleanupIntervalMs: number;
  onCleanupInactiveSessions: () => void;
  logger: LoggerLike;
}

export const startHttpServer = async (
  options: StartHttpServerOptions
): Promise<StartedHttpServerState> => {
  return new Promise((resolve, reject) => {
    try {
      const server = options.app.listen(options.port, options.bindAddress, () => {
        options.logger.info(
          `Airpa HTTP REST API Server started on http://${options.bindAddress}:${options.port}`
        );
        options.logger.info(`Health check: http://${options.bindAddress}:${options.port}/health`);
        if (options.mcpEnabled) {
          options.logger.info(`MCP endpoint: http://${options.bindAddress}:${options.port}/mcp`);
          options.logger.info(`Available tools: ${options.availableToolsCount}`);
        }

        let cleanupTimer: NodeJS.Timeout | null = null;
        if (options.sessionSupportEnabled) {
          cleanupTimer = setInterval(
            () => options.onCleanupInactiveSessions(),
            options.sessionCleanupIntervalMs
          );
          options.logger.info(
            `Session cleanup enabled (timeout: ${options.sessionTimeoutMs / 1000}s, ` +
              `interval: ${options.sessionCleanupIntervalMs / 1000}s)`
          );
        }

        resolve({
          httpServer: server,
          cleanupTimer,
        });
      });

      server.on('error', (error: Error) => {
        options.logger.error('Server error:', error);
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
};

interface StopHttpServerOptions<McpSession, OrchestrationSession> {
  httpServer: HttpServer | null;
  cleanupTimer: NodeJS.Timeout | null;
  transports: Map<string, McpSession>;
  orchestrationSessions: Map<string, OrchestrationSession>;
  cleanupMcpSession: (sessionId: string, session: McpSession) => Promise<void>;
  cleanupOrchestrationSession: (
    sessionId: string,
    session: OrchestrationSession
  ) => Promise<void>;
  logger: LoggerLike;
}

const isServerNotRunningError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { code?: unknown; message?: unknown };
  const code = typeof maybe.code === 'string' ? maybe.code : '';
  if (code === 'ERR_SERVER_NOT_RUNNING') return true;
  const message = typeof maybe.message === 'string' ? maybe.message : '';
  return message.includes('Server is not running');
};

export const stopHttpServer = async <McpSession, OrchestrationSession>(
  options: StopHttpServerOptions<McpSession, OrchestrationSession>
): Promise<{ httpServer: null; cleanupTimer: null }> => {
  options.logger.info('Stopping HTTP MCP Server...');

  if (options.cleanupTimer) {
    clearInterval(options.cleanupTimer);
    options.logger.debug('Session cleanup timer stopped');
  }

  const cleanupTasks: Array<Promise<void>> = [];
  for (const [sessionId, session] of options.transports.entries()) {
    options.logger.debug(`Closing session: ${sessionId}`);
    cleanupTasks.push(options.cleanupMcpSession(sessionId, session));
  }
  options.transports.clear();

  for (const [sessionId, session] of options.orchestrationSessions.entries()) {
    options.logger.debug(`Closing orchestration session: ${sessionId}`);
    cleanupTasks.push(options.cleanupOrchestrationSession(sessionId, session));
  }
  options.orchestrationSessions.clear();

  await Promise.all(cleanupTasks);

  if (options.httpServer) {
    await new Promise<void>((resolve, reject) => {
      options.httpServer?.close((err?: Error) => {
        if (err) {
          if (isServerNotRunningError(err)) {
            options.logger.debug('HTTP server already stopped');
            resolve();
            return;
          }
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  options.logger.info('HTTP MCP Server stopped');
  return {
    httpServer: null,
    cleanupTimer: null,
  };
};
