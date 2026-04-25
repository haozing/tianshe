import type { Response } from 'express';
import type { McpSessionInfo } from './mcp-http-types';
import { createLogger } from '../core/logger';
import { asTrimmedText } from './mcp-http-transport-utils';

const logger = createLogger('MCP-HTTP');

interface PendingMcpSessionTerminationOptions {
  transports: Map<string, McpSessionInfo>;
  cleanupSession: (sessionId: string, session: McpSessionInfo) => Promise<void>;
}

type PendingMcpSessionTerminationEvent = 'finish' | 'close' | 'error';
type PendingMcpSessionTerminationResponse = Pick<Response, 'once' | 'removeListener'>;

const finalizePendingMcpSessionTermination = (
  options: PendingMcpSessionTerminationOptions,
  session: McpSessionInfo | undefined,
  trigger: PendingMcpSessionTerminationEvent = 'finish'
): void => {
  const sessionId = asTrimmedText(session?.sessionId);
  if (!session || !session.terminateAfterResponse || !sessionId) {
    return;
  }

  session.terminateAfterResponse = false;

  let cleanupStarted = false;
  const runCleanup = () => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;

    void (async () => {
      const active = options.transports.get(sessionId);
      if (active !== session) {
        return;
      }

      logger.info(`Terminating MCP session after response ${trigger}: ${sessionId}`);
      options.transports.delete(sessionId);
      try {
        await options.cleanupSession(sessionId, session);
      } catch (error) {
        logger.error(`Error terminating MCP session after response ${sessionId}:`, error);
      }
    })();
  };

  setImmediate(runCleanup);
};

export const armPendingMcpSessionTerminationOnResponse = (
  options: PendingMcpSessionTerminationOptions,
  res: PendingMcpSessionTerminationResponse,
  session: McpSessionInfo | undefined
): void => {
  if (!session) {
    return;
  }

  let finalized = false;
  const finalize = (trigger: PendingMcpSessionTerminationEvent) => {
    if (finalized) {
      return;
    }
    finalized = true;
    res.removeListener('finish', onFinish);
    res.removeListener('close', onClose);
    res.removeListener('error', onError);
    finalizePendingMcpSessionTermination(options, session, trigger);
  };

  const onFinish = () => finalize('finish');
  const onClose = () => finalize('close');
  const onError = () => finalize('error');

  res.once('finish', onFinish);
  res.once('close', onClose);
  res.once('error', onError);
};
