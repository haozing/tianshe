import type { ReleaseOptions } from '../core/browser-pool';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import {
  ErrorCode,
  createStructuredError,
  type StructuredError,
} from '../types/error-codes';
import type { McpSessionInfo } from './mcp-http-types';
import type { OrchestrationSessionInfo } from './orchestration-http-routes';

export interface InvokeQueueState {
  invokeQueue: Promise<void>;
  pendingInvocations: number;
  activeInvocations: number;
  maxQueueSize: number;
  lastActivity: number;
  closeController?: AbortController;
  closeReason?: StructuredError;
  activeInvocationController?: AbortController;
  closing?: boolean;
}

export interface InvokeTaskContext {
  signal: AbortSignal;
}

export interface RuntimeMetricsSnapshot {
  queueOverflowCount: number;
  invokeTimeoutCount: number;
  browserAcquireFailureCount: number;
  browserAcquireTimeoutCount: number;
}

type RuntimeAlertSeverity = 'warning' | 'critical';

export interface RuntimeAlert {
  code: string;
  severity: RuntimeAlertSeverity;
  value: number;
  threshold: number;
  message: string;
}

export interface RuntimeMetricsPayload {
  timestamp: string;
  activeSessions: {
    mcp: number;
    orchestration: number;
    total: number;
  };
  queueDepth: {
    mcpPending: number;
    mcpActive: number;
    orchestrationPending: number;
    orchestrationActive: number;
    totalPending: number;
    totalActive: number;
  };
  counters: RuntimeMetricsSnapshot;
  sessionLeakRisk: {
    timeoutMs: number;
    staleMcpSessions: number;
    staleOrchestrationSessions: number;
    totalStaleSessions: number;
  };
  idempotency: {
    totalCacheEntries: number;
  };
  alerts: RuntimeAlert[];
}

export interface SessionCleanupPolicy {
  defaultIdleTimeoutMs: number;
  idleWithoutBrowserTimeoutMs: number;
  closingSessionGraceTimeoutMs: number;
}

interface LoggerLike {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const CLEANUP_WAIT_TIMEOUT_MS = 1_500;

export const SESSION_CLEANUP_POLICY: SessionCleanupPolicy = Object.freeze({
  defaultIdleTimeoutMs: HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT,
  idleWithoutBrowserTimeoutMs: Math.min(HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT, 5 * 60 * 1000),
  closingSessionGraceTimeoutMs: 15 * 1000,
});

const isStructuredError = (reason: unknown): reason is StructuredError => {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    'message' in reason &&
    typeof (reason as StructuredError).code === 'string' &&
    typeof (reason as StructuredError).message === 'string'
  );
};

const toStructuredAbortReason = (
  reason: unknown,
  fallback: () => StructuredError
): StructuredError => {
  if (isStructuredError(reason)) {
    return reason;
  }

  if (reason instanceof Error && String(reason.message || '').trim()) {
    return createStructuredError(ErrorCode.OPERATION_FAILED, reason.message);
  }

  if (typeof reason === 'string' && reason.trim()) {
    return createStructuredError(ErrorCode.OPERATION_FAILED, reason.trim());
  }

  return fallback();
};

const createSessionClosingError = (
  sessionLabel: string,
  context: Record<string, unknown> = {}
): StructuredError =>
  createStructuredError(ErrorCode.OPERATION_FAILED, `Session is closing: ${sessionLabel}`, {
    details: 'The session is being terminated and cannot accept or continue invocations.',
    suggestion: 'Create a new session before retrying the request.',
    reasonCode: 'session_closing',
    retryable: true,
    recommendedNextTools: ['session_get_current', 'session_prepare', 'session_end_current'],
    context: {
      session: sessionLabel,
      reason: 'session_closing',
      ...context,
    },
  });

const createInvokeTimeoutError = (
  sessionLabel: string,
  timeoutMs: number
): StructuredError =>
  createStructuredError(ErrorCode.TIMEOUT, `Invoke timeout: ${sessionLabel}`, {
    details: `能力调用超过 ${timeoutMs}ms`,
    context: {
      session: sessionLabel,
      timeoutMs,
      reason: 'invoke_timeout',
    },
  });

const ensureSessionCloseController = (session: InvokeQueueState): AbortController => {
  if (!session.closeController) {
    session.closeController = new AbortController();
  }
  return session.closeController;
};

const getSessionCloseError = (
  sessionLabel: string,
  session: InvokeQueueState
): StructuredError | undefined => {
  const controller = session.closeController;
  if (!session.closing && !controller?.signal.aborted) {
    return undefined;
  }

  return toStructuredAbortReason(session.closeReason ?? controller?.signal.reason, () =>
    createSessionClosingError(sessionLabel)
  );
};

const abortSession = (
  sessionLabel: string,
  session: InvokeQueueState,
  reason?: StructuredError
): StructuredError => {
  const structuredReason =
    reason || session.closeReason || createSessionClosingError(sessionLabel);

  session.closing = true;
  session.closeReason = structuredReason;

  const closeController = ensureSessionCloseController(session);
  if (!closeController.signal.aborted) {
    closeController.abort(structuredReason);
  }

  if (session.activeInvocationController && !session.activeInvocationController.signal.aborted) {
    session.activeInvocationController.abort(structuredReason);
  }

  return structuredReason;
};

const waitForAbortableTask = async <T>(
  task: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  onTimeout: () => StructuredError
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(
        toStructuredAbortReason(signal.reason, () =>
          createStructuredError(ErrorCode.OPERATION_FAILED, 'Invocation aborted')
        )
      );
      return;
    }

    abortListener = () => {
      reject(
        toStructuredAbortReason(signal.reason, () =>
          createStructuredError(ErrorCode.OPERATION_FAILED, 'Invocation aborted')
        )
      );
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([task, timeoutPromise, abortPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};

const waitForCleanupBudget = async (
  promise: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      promise.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          onTimeout();
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const releaseBrowserHandle = async (
  release: ((options?: ReleaseOptions) => Promise<unknown>) | undefined,
  logger: LoggerLike,
  sessionId: string,
  options?: ReleaseOptions
): Promise<void> => {
  if (!release) {
    return;
  }

  try {
    await release(options);
    logger.debug(`Browser released for session: ${sessionId}`);
  } catch (error) {
    logger.error(`Error releasing browser for session ${sessionId}:`, error);
  }
};

export const enqueueInvokeTask = <T>(params: {
  sessionLabel: string;
  session: InvokeQueueState;
  task: (context: InvokeTaskContext) => Promise<T>;
  options: { timeoutMs: number };
  runtimeMetrics: RuntimeMetricsSnapshot;
  logger: LoggerLike;
}): Promise<T> => {
  const { sessionLabel, session, task, options, runtimeMetrics, logger } = params;

  if (session.pendingInvocations >= session.maxQueueSize) {
    runtimeMetrics.queueOverflowCount += 1;
    throw createStructuredError(ErrorCode.REQUEST_FAILED, `Queue overflow: ${sessionLabel}`, {
      details: `当前队列长度 ${session.pendingInvocations} 已达到上限 ${session.maxQueueSize}`,
      suggestion: '请稍后重试，或提高队列上限配置',
      context: {
        session: sessionLabel,
        pendingInvocations: session.pendingInvocations,
        maxQueueSize: session.maxQueueSize,
      },
    });
  }

  session.pendingInvocations += 1;
  session.lastActivity = Date.now();

  const execute = async (): Promise<T> => {
    let activeStarted = false;
    let invokeController: AbortController | undefined;
    let forwardSessionAbort: (() => void) | undefined;

    try {
      const closeError = getSessionCloseError(sessionLabel, session);
      if (closeError) {
        throw closeError;
      }

      session.activeInvocations += 1;
      activeStarted = true;
      session.lastActivity = Date.now();

      const closeController = ensureSessionCloseController(session);
      invokeController = new AbortController();
      const invokeSignal = invokeController.signal;
      session.activeInvocationController = invokeController;

      forwardSessionAbort = () => {
        if (!invokeController || invokeController.signal.aborted) {
          return;
        }
        invokeController.abort(
          toStructuredAbortReason(closeController.signal.reason ?? session.closeReason, () =>
            createSessionClosingError(sessionLabel)
          )
        );
      };

      if (closeController.signal.aborted) {
        forwardSessionAbort();
      } else {
        closeController.signal.addEventListener('abort', forwardSessionAbort, { once: true });
      }

      return await waitForAbortableTask(
        Promise.resolve().then(() => task({ signal: invokeSignal })),
        options.timeoutMs,
        invokeSignal,
        () => {
          runtimeMetrics.invokeTimeoutCount += 1;
          const timeoutError = createInvokeTimeoutError(sessionLabel, options.timeoutMs);
          if (!invokeController?.signal.aborted) {
            invokeController?.abort(timeoutError);
          }
          return timeoutError;
        }
      );
    } finally {
      if (forwardSessionAbort && session.closeController) {
        session.closeController.signal.removeEventListener('abort', forwardSessionAbort);
      }
      if (session.activeInvocationController === invokeController) {
        session.activeInvocationController = undefined;
      }
      if (activeStarted) {
        session.activeInvocations = Math.max(0, session.activeInvocations - 1);
      }
      session.pendingInvocations = Math.max(0, session.pendingInvocations - 1);
      session.lastActivity = Date.now();
    }
  };

  const run = session.invokeQueue.then(execute, execute);
  session.invokeQueue = run
    .then(() => undefined)
    .catch((error) => {
      logger.debug(`Invoke queue item failed (${sessionLabel}): ${String(error)}`);
    });
  return run;
};

export const enqueueOrchestrationInvoke = <T>(params: {
  sessionId: string;
  session: OrchestrationSessionInfo;
  task: (context: InvokeTaskContext) => Promise<T>;
  runtimeMetrics: RuntimeMetricsSnapshot;
  logger: LoggerLike;
}): Promise<T> => {
  return enqueueInvokeTask({
    sessionLabel: params.sessionId,
    session: params.session,
    task: params.task,
    options: { timeoutMs: HTTP_SERVER_DEFAULTS.ORCHESTRATION_INVOKE_TIMEOUT_MS },
    runtimeMetrics: params.runtimeMetrics,
    logger: params.logger,
  });
};

export const cleanupMcpSession = async (
  sessionId: string,
  session: McpSessionInfo,
  logger: LoggerLike
): Promise<void> => {
  abortSession(sessionId, session, createSessionClosingError(sessionId));

  const server = session.server;
  session.server = undefined;
  if (server && typeof server.close === 'function') {
    try {
      await server.close();
    } catch (error) {
      logger.error(`Error closing MCP server for session ${sessionId}:`, error);
    }
  }

  try {
    session.transport.close();
  } catch (error) {
    logger.error(`Error closing session ${sessionId}:`, error);
  }

  await waitForCleanupBudget(session.invokeQueue, CLEANUP_WAIT_TIMEOUT_MS, () => {
    logger.debug(
      `Cleanup wait budget exhausted for MCP session ${sessionId}; continuing with forced teardown`
    );
  });

  const pendingAcquire = session.browserAcquirePromise;
  session.browserAcquirePromise = undefined;

  if (session.browserHandle) {
    const handle = session.browserHandle;
    session.browserHandle = undefined;
    await releaseBrowserHandle(handle.release.bind(handle), logger, sessionId, {
      destroy: true,
    });
    return;
  }

  if (pendingAcquire) {
    void pendingAcquire.catch(() => undefined);
  }
};

export const cleanupOrchestrationSession = async (
  sessionId: string,
  session: OrchestrationSessionInfo,
  logger: LoggerLike
): Promise<void> => {
  abortSession(sessionId, session, createSessionClosingError(sessionId));

  await waitForCleanupBudget(session.invokeQueue, CLEANUP_WAIT_TIMEOUT_MS, () => {
    logger.debug(
      `Cleanup wait budget exhausted for orchestration session ${sessionId}; continuing with forced teardown`
    );
  });

  await releaseBrowserHandle(session.browserHandle.release.bind(session.browserHandle), logger, sessionId, {
    destroy: true,
  });
};

export const cleanupInactiveSessions = (params: {
  transports: Map<string, McpSessionInfo>;
  orchestrationSessions: Map<string, OrchestrationSessionInfo>;
  timeoutMs: number;
  logger: LoggerLike;
  cleanupMcpSession: (sessionId: string, session: McpSessionInfo) => Promise<void>;
  cleanupOrchestrationSession: (
    sessionId: string,
    session: OrchestrationSessionInfo
  ) => Promise<void>;
}): void => {
  const {
    transports,
    orchestrationSessions,
    timeoutMs,
    logger,
    cleanupMcpSession: cleanupMcp,
    cleanupOrchestrationSession: cleanupOrch,
  } = params;

  const now = Date.now();

  for (const [sessionId, session] of transports.entries()) {
    const idleMs = now - session.lastActivity;
    const hasBrowserLease = Boolean(session.browserHandle || session.browserAcquirePromise);
    const idleTimeoutMs = hasBrowserLease
      ? timeoutMs
      : Math.min(timeoutMs, SESSION_CLEANUP_POLICY.idleWithoutBrowserTimeoutMs);
    const closingPastGrace =
      session.closing === true &&
      idleMs > SESSION_CLEANUP_POLICY.closingSessionGraceTimeoutMs;

    if (idleMs > idleTimeoutMs || closingPastGrace) {
      if ((session.pendingInvocations > 0 || session.activeInvocations > 0) && !closingPastGrace) {
        logger.debug(
          `Skip cleaning MCP session ${sessionId}: pending=${session.pendingInvocations}, active=${session.activeInvocations}`
        );
        continue;
      }
      const reason = closingPastGrace
        ? `closing grace exceeded (${idleMs}ms > ${SESSION_CLEANUP_POLICY.closingSessionGraceTimeoutMs}ms)`
        : hasBrowserLease
          ? `idle timeout exceeded (${idleMs}ms > ${idleTimeoutMs}ms)`
          : `idle without browser timeout exceeded (${idleMs}ms > ${idleTimeoutMs}ms)`;
      logger.info(`Cleaning up inactive MCP session: ${sessionId} (${reason})`);
      transports.delete(sessionId);
      void cleanupMcp(sessionId, session);
    }
  }

  for (const [sessionId, session] of orchestrationSessions.entries()) {
    if (now - session.lastActivity > timeoutMs) {
      if (session.pendingInvocations > 0 || session.activeInvocations > 0) {
        logger.debug(
          `Skip cleaning orchestration session ${sessionId}: pending=${session.pendingInvocations}, active=${session.activeInvocations}`
        );
        continue;
      }
      logger.info(`Cleaning up inactive orchestration session: ${sessionId}`);
      orchestrationSessions.delete(sessionId);
      void cleanupOrch(sessionId, session);
    }
  }

  logger.debug(
    `Session cleanup: ${transports.size} MCP sessions, ${orchestrationSessions.size} orchestration sessions`
  );
};

export const buildRuntimeMetricsPayload = (params: {
  transports: Map<string, McpSessionInfo>;
  orchestrationSessions: Map<string, OrchestrationSessionInfo>;
  runtimeMetrics: RuntimeMetricsSnapshot;
}): RuntimeMetricsPayload => {
  const { transports, orchestrationSessions, runtimeMetrics } = params;

  let mcpPending = 0;
  let mcpActive = 0;
  for (const session of transports.values()) {
    mcpPending += session.pendingInvocations;
    mcpActive += session.activeInvocations;
  }

  let orchestrationPending = 0;
  let orchestrationActive = 0;
  for (const session of orchestrationSessions.values()) {
    orchestrationPending += session.pendingInvocations;
    orchestrationActive += session.activeInvocations;
  }

  const now = Date.now();
  const timeoutMs = HTTP_SERVER_DEFAULTS.SESSION_TIMEOUT;
  let staleMcpSessions = 0;
  let staleOrchestrationSessions = 0;
  let totalIdempotencyCacheEntries = 0;

  for (const session of transports.values()) {
    if (now - session.lastActivity > timeoutMs) {
      staleMcpSessions += 1;
    }
  }
  for (const session of orchestrationSessions.values()) {
    if (now - session.lastActivity > timeoutMs) {
      staleOrchestrationSessions += 1;
    }
    totalIdempotencyCacheEntries += session.idempotencyCache.size;
  }

  const alerts: RuntimeAlert[] = [];
  const addThresholdAlert = (
    code: string,
    value: number,
    warnThreshold: number,
    criticalThreshold: number,
    message: string
  ): void => {
    if (value >= criticalThreshold) {
      alerts.push({
        code,
        severity: 'critical',
        value,
        threshold: criticalThreshold,
        message,
      });
      return;
    }
    if (value >= warnThreshold) {
      alerts.push({
        code,
        severity: 'warning',
        value,
        threshold: warnThreshold,
        message,
      });
    }
  };

  addThresholdAlert(
    'invoke_timeout_count',
    runtimeMetrics.invokeTimeoutCount,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_INVOKE_TIMEOUT_WARN_COUNT,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_INVOKE_TIMEOUT_CRITICAL_COUNT,
    'orchestration invoke timeout count is high'
  );
  addThresholdAlert(
    'queue_overflow_count',
    runtimeMetrics.queueOverflowCount,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_QUEUE_OVERFLOW_WARN_COUNT,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_QUEUE_OVERFLOW_CRITICAL_COUNT,
    'orchestration queue overflow count is high'
  );
  addThresholdAlert(
    'browser_acquire_failure_count',
    runtimeMetrics.browserAcquireFailureCount,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_BROWSER_ACQUIRE_FAILURE_WARN_COUNT,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_BROWSER_ACQUIRE_FAILURE_CRITICAL_COUNT,
    'browser acquire failure count is high'
  );
  addThresholdAlert(
    'browser_acquire_timeout_count',
    runtimeMetrics.browserAcquireTimeoutCount,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_BROWSER_ACQUIRE_TIMEOUT_WARN_COUNT,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_BROWSER_ACQUIRE_TIMEOUT_CRITICAL_COUNT,
    'browser acquire timeout count is high'
  );
  addThresholdAlert(
    'queue_total_pending',
    mcpPending + orchestrationPending,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_TOTAL_PENDING_WARN,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_TOTAL_PENDING_CRITICAL,
    'total pending queue depth is high'
  );
  addThresholdAlert(
    'stale_sessions_total',
    staleMcpSessions + staleOrchestrationSessions,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_STALE_SESSIONS_WARN,
    HTTP_SERVER_DEFAULTS.ORCHESTRATION_ALERT_STALE_SESSIONS_CRITICAL,
    'stale orchestration sessions detected'
  );

  return {
    timestamp: new Date(now).toISOString(),
    activeSessions: {
      mcp: transports.size,
      orchestration: orchestrationSessions.size,
      total: transports.size + orchestrationSessions.size,
    },
    queueDepth: {
      mcpPending,
      mcpActive,
      orchestrationPending,
      orchestrationActive,
      totalPending: mcpPending + orchestrationPending,
      totalActive: mcpActive + orchestrationActive,
    },
    counters: { ...runtimeMetrics },
    sessionLeakRisk: {
      timeoutMs,
      staleMcpSessions,
      staleOrchestrationSessions,
      totalStaleSessions: staleMcpSessions + staleOrchestrationSessions,
    },
    idempotency: {
      totalCacheEntries: totalIdempotencyCacheEntries,
    },
    alerts,
  };
};
