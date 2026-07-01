import { randomUUID } from 'node:crypto';
import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import { createLogger } from '../core/logger';
import { showBrowserView, hideBrowserView } from '../core/browser-pool';
import type { BrowserHandle } from '../core/browser-pool';
import {
  createOrchestrationExecutor,
  createCapabilityConfirmationGrant,
  hashOrchestrationInvokePayload,
  isCapabilityConfirmationGrant,
  requiresCapabilityConfirmation,
  defaultOrchestrationCapabilityRegistry,
  type OrchestrationCapabilityRegistry,
  type OrchestrationExecutor,
  type OrchestrationIdempotencyEntry,
} from '../core/ai-dev/orchestration';
import type { BrowserRuntimeId } from '../types/browser-runtime';
import { BROWSER_RUNTIME_IDS } from '../types/browser-runtime';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import { ErrorCode, createStructuredError, type StructuredError } from '../types/error-codes';
import { sendStructuredError, sendSuccess, buildOrchestrationResponseMeta } from './http-response-mapper';

const logger = createLogger('MCP-HTTP');

const orchestrationInvokeRequestSchema = z.object({
  sessionId: z.string().trim().min(1, 'sessionId is required'),
  name: z.string().trim().min(1, 'name is required'),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
  confirmationGrant: z.unknown().optional(),
});

const orchestrationConfirmationGrantRequestSchema = z.object({
  sessionId: z.string().trim().min(1, 'sessionId is required'),
  name: z.string().trim().min(1, 'name is required'),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
  source: z.enum(['plugin-ui', 'workflow-ui', 'agent-ui']).default('agent-ui'),
  grantId: z.string().trim().min(1).optional(),
  invocationId: z.string().trim().min(1).optional(),
  principal: z.string().trim().min(1).optional(),
  expiresAt: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  previewRef: z.string().trim().min(1).optional(),
});

const orchestrationSessionCreateRequestSchema = z.object({
  profileId: z.string().trim().min(1, 'profileId cannot be empty').optional(),
  runtimeId: z.enum(BROWSER_RUNTIME_IDS).optional(),
  visible: z.boolean().optional().default(false),
});

const orchestrationSessionDeleteParamsSchema = z.object({
  sessionId: z.string().trim().min(1, 'sessionId is required'),
});

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');

const asTrimmedText = (value: unknown): string => String(value == null ? '' : value).trim();

const createIdempotencyRunningError = (
  capability: string,
  idempotencyKey: string
): StructuredError =>
  createStructuredError(
    ErrorCode.REQUEST_FAILED,
    'Idempotency-Key is already reserved by an in-flight request',
    {
      context: {
        capability,
        idempotencyKey,
        reason: 'idempotency_request_running',
      },
    }
  );

const createIdempotencyConflictError = (
  capability: string,
  idempotencyKey: string
): StructuredError =>
  createStructuredError(
    ErrorCode.REQUEST_FAILED,
    'Idempotency-Key already used with a different request payload',
    {
      context: {
        capability,
        idempotencyKey,
        reason: 'idempotency_conflict',
      },
    }
  );

const resolveProfileIdHint = async (
  dependencies: RegisterOrchestrationRoutesOptions['dependencies'],
  query: string | undefined
): Promise<string | undefined> => {
  const hint = asTrimmedText(query);
  if (!hint) return undefined;
  const gateway = dependencies?.profileGateway;
  if (!gateway) return hint;

  try {
    const byId = await gateway.getProfile(hint);
    if (byId?.id) return asTrimmedText(byId.id) || hint;

    const resolved = await gateway.resolveProfile(hint);
    if (resolved?.profile?.id) return asTrimmedText(resolved.profile.id) || hint;
  } catch (error) {
    logger.warn(`Failed to resolve profile hint "${hint}", fallback to raw value`, error);
  }

  return hint;
};

export interface OrchestrationSessionInfo {
  browserHandle: BrowserHandle;
  executor: OrchestrationExecutor;
  invokeQueue: Promise<void>;
  pendingInvocations: number;
  activeInvocations: number;
  maxQueueSize: number;
  lastActivity: number;
  closeController?: AbortController;
  closeReason?: StructuredError;
  activeInvocationController?: AbortController;
  closing?: boolean;
  profileId?: string;
  runtimeId?: BrowserRuntimeId;
  authScopes?: string[];
  idempotencyCache: Map<string, OrchestrationIdempotencyEntry>;
}

interface RegisterOrchestrationRoutesOptions {
  app: Application;
  restApiConfig?: RestApiConfig;
  dependencies?: RestApiDependencies;
  capabilityRegistry?: OrchestrationCapabilityRegistry;
  browserPoolAvailable: boolean;
  orchestrationSessions: Map<string, OrchestrationSessionInfo>;
  parseScopesHeader: (value: unknown) => string[];
  firstString: (value: unknown) => string;
  acquireBrowserFromPool: (
    profileId?: string,
    runtimeId?: BrowserRuntimeId,
    source?: 'mcp' | 'http'
  ) => Promise<BrowserHandle>;
  enqueueOrchestrationInvoke: <T>(
    sessionId: string,
    session: OrchestrationSessionInfo,
    task: (context: { signal: AbortSignal }) => Promise<T>
  ) => Promise<T>;
  cleanupOrchestrationSession: (
    sessionId: string,
    session: OrchestrationSessionInfo
  ) => Promise<void>;
  buildRuntimeMetricsPayload: () => unknown;
  normalizeStructuredError: (error: unknown) => StructuredError;
  mapErrorStatus: (code: string, fallback?: number) => number;
  mapStructuredErrorStatus: (error: StructuredError, fallback?: number) => number;
  asyncHandler: (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => Promise<void>;
}

export const registerOrchestrationRoutes = (options: RegisterOrchestrationRoutesOptions): void => {
  const prefix = HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX;
  const idempotencyPersistence = options.dependencies?.idempotencyPersistence;
  const capabilityRegistry = options.capabilityRegistry || defaultOrchestrationCapabilityRegistry;

  const registerGet = (pathSuffix: string, handler: (req: Request, res: Response) => Promise<void>) => {
    options.app.get(
      `${prefix}${pathSuffix}`,
      options.asyncHandler(async (req, res) => {
        await handler(req, res);
      })
    );
  };

  const registerPost = (
    pathSuffix: string,
    handler: (req: Request, res: Response) => Promise<void>
  ) => {
    options.app.post(
      `${prefix}${pathSuffix}`,
      options.asyncHandler(async (req, res) => {
        await handler(req, res);
      })
    );
  };

  const registerDelete = (
    pathSuffix: string,
    handler: (req: Request, res: Response) => Promise<void>
  ) => {
    options.app.delete(
      `${prefix}${pathSuffix}`,
      options.asyncHandler(async (req, res) => {
        await handler(req, res);
      })
    );
  };

  const cleanupIdempotencyCache = async (
    session: OrchestrationSessionInfo,
    now = Date.now()
  ): Promise<void> => {
    const ttl = HTTP_SERVER_DEFAULTS.ORCHESTRATION_IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of session.idempotencyCache.entries()) {
      if (now - entry.createdAt > ttl) {
        session.idempotencyCache.delete(key);
      }
    }
    if (idempotencyPersistence) {
      await idempotencyPersistence.pruneExpired(ttl, now);
    }
  };

  const resolveIdempotencyNamespace = (req: Request, sessionId: string): string => {
    const customNamespace = options.firstString(req.headers['x-airpa-idempotency-namespace']).trim();
    return customNamespace || sessionId;
  };

  registerGet('/capabilities', async (_req, res) => {
    sendSuccess(res, capabilityRegistry.listCapabilities());
  });

  registerGet('/metrics', async (_req, res) => {
    sendSuccess(res, options.buildRuntimeMetricsPayload());
  });

  registerPost('/confirmation-grants', async (req, res) => {
    const parsed = orchestrationConfirmationGrantRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendStructuredError(
        res,
        createStructuredError(
          ErrorCode.INVALID_PARAMETER,
          'Invalid confirmation grant request',
          {
            details: formatZodIssues(parsed.error),
            suggestion: 'Provide sessionId, capability name, and the exact arguments to confirm.',
          }
        ),
        400
      );
    }

    const {
      sessionId,
      name,
      arguments: args,
      source,
      grantId,
      invocationId,
      principal,
      expiresAt,
      idempotencyKey,
      previewRef,
    } = parsed.data;
    const session = options.orchestrationSessions.get(sessionId);
    if (!session) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.NOT_FOUND, 'Session not found', {
          context: { sessionId },
        }),
        404
      );
    }

    session.executor.refreshGeneration();
    const definition = capabilityRegistry.getSnapshot().definitionsByName[name];
    if (!definition) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.NOT_FOUND, `Capability not found: ${name}`, {
          context: { capability: name },
        }),
        404
      );
    }

    if (!requiresCapabilityConfirmation(definition, args)) {
      return sendStructuredError(
        res,
        createStructuredError(
          ErrorCode.INVALID_PARAMETER,
          `Capability ${name} does not require confirmation for the provided arguments`,
          {
            context: { capability: name },
            suggestion: 'Invoke the capability without a confirmation grant.',
          }
        ),
        400
      );
    }

    const scopesHeaderPresent = req.headers['x-airpa-scopes'] !== undefined;
    if (scopesHeaderPresent) {
      session.authScopes = options.parseScopesHeader(req.headers['x-airpa-scopes']);
    }
    const scopes = [...(session.authScopes || [])];
    const grant = createCapabilityConfirmationGrant({
      definition,
      arguments: args,
      grantId: grantId || randomUUID(),
      invocationId: invocationId || randomUUID(),
      principal: principal || 'http',
      source,
      sessionId,
      scopes,
      ...(expiresAt ? { expiresAt } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(previewRef ? { previewRef } : {}),
    });

    sendSuccess(
      res,
      {
        sessionId,
        capability: name,
        confirmationGrant: grant,
      },
      undefined,
      {
        sessionId,
        capability: name,
      }
    );
  });

  registerPost('/sessions', async (req, res) => {
    const parsed = orchestrationSessionCreateRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.INVALID_PARAMETER, 'Invalid orchestration session request', {
          details: formatZodIssues(parsed.error),
          suggestion: '请提供有效的 profileId、runtimeId 和 visible 参数',
        }),
        400
      );
    }
    const { profileId, runtimeId, visible } = parsed.data;
    const resolvedProfileId = await resolveProfileIdHint(options.dependencies, profileId);

    if (!options.browserPoolAvailable) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.OPERATION_FAILED, 'BrowserPoolManager not available', {
          suggestion: '请确认浏览器池已初始化',
        }),
        503
      );
    }

    const browserHandle = await options.acquireBrowserFromPool(resolvedProfileId, runtimeId, 'http');
    let sessionRegistered = false;
    let destroyOnInitFailure = false;
    const sessionId = randomUUID();
    try {
      if (visible) {
        if (
          browserHandle.viewId &&
          options.dependencies?.viewManager &&
          options.dependencies?.windowManager
        ) {
          const shown = showBrowserView(
            browserHandle.viewId,
            options.dependencies.viewManager,
            options.dependencies.windowManager,
            'main',
            'pool'
          );
          destroyOnInitFailure = true;
          if (!shown) {
            logger.warn(`Failed to show browser view for orchestration session: ${browserHandle.viewId}`);
          }
        } else if (browserHandle.browser.show) {
          destroyOnInitFailure = true;
          await browserHandle.browser.show();
        }
      } else if (browserHandle.viewId && options.dependencies?.viewManager) {
        destroyOnInitFailure = true;
        hideBrowserView(browserHandle.viewId, options.dependencies.viewManager);
      } else if (browserHandle.browser.hide) {
        destroyOnInitFailure = true;
        await browserHandle.browser.hide();
      }

      const executor = createOrchestrationExecutor({
        browser: browserHandle.browser,
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
        ...(options.dependencies?.profileLoginStateGateway
          ? { profileLoginStateGateway: options.dependencies.profileLoginStateGateway }
          : {}),
        ...(options.dependencies?.observationGateway
          ? { observationGateway: options.dependencies.observationGateway }
          : {}),
        enforceScopes:
          options.restApiConfig?.agentHandMode === true
            ? true
            : options.restApiConfig?.enforceOrchestrationScopes ?? true,
      }, { registry: capabilityRegistry });
      options.orchestrationSessions.set(sessionId, {
        browserHandle,
        executor,
        invokeQueue: Promise.resolve(),
        pendingInvocations: 0,
        activeInvocations: 0,
        maxQueueSize: HTTP_SERVER_DEFAULTS.ORCHESTRATION_MAX_QUEUE_SIZE,
        lastActivity: Date.now(),
        profileId: resolvedProfileId,
        runtimeId,
        authScopes: [],
        idempotencyCache: new Map(),
      });
      sessionRegistered = true;

      sendSuccess(
        res,
        {
          sessionId,
          browserId: browserHandle.browserId,
          poolSessionId: browserHandle.sessionId,
          runtimeId: browserHandle.runtimeId,
          viewId: browserHandle.viewId,
        },
        undefined,
        { sessionId }
      );
    } catch (error) {
      if (!sessionRegistered) {
        try {
          await browserHandle.release(destroyOnInitFailure ? { destroy: true } : undefined);
        } catch (releaseError) {
          logger.error(
            `Failed to release browser handle after orchestration session init error (${sessionId}):`,
            releaseError
          );
        }
      }
      throw error;
    }
  });

  registerGet('/sessions/:sessionId', async (req, res) => {
    const parsed = orchestrationSessionDeleteParamsSchema.safeParse(req.params ?? {});
    if (!parsed.success) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.INVALID_PARAMETER, 'Invalid orchestration session id', {
          details: formatZodIssues(parsed.error),
          suggestion: '请提供有效的 sessionId',
        }),
        400
      );
    }
    const { sessionId } = parsed.data;
    const session = options.orchestrationSessions.get(sessionId);
    if (!session) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.NOT_FOUND, 'Session not found', {
          context: { sessionId },
        }),
        404
      );
    }

    await cleanupIdempotencyCache(session);

    sendSuccess(
      res,
      {
        sessionId,
        profileId: session.profileId,
        runtimeId: session.runtimeId,
        browserId: session.browserHandle.browserId,
        viewId: session.browserHandle.viewId,
        pendingInvocations: session.pendingInvocations,
        activeInvocations: session.activeInvocations,
        maxQueueSize: session.maxQueueSize,
        idempotencyCacheSize: session.idempotencyCache.size,
        lastActivity: new Date(session.lastActivity).toISOString(),
      },
      undefined,
      { sessionId }
    );
  });

  registerPost('/sessions/:sessionId/heartbeat', async (req, res) => {
    const parsed = orchestrationSessionDeleteParamsSchema.safeParse(req.params ?? {});
    if (!parsed.success) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.INVALID_PARAMETER, 'Invalid orchestration session id', {
          details: formatZodIssues(parsed.error),
        }),
        400
      );
    }
    const { sessionId } = parsed.data;
    const session = options.orchestrationSessions.get(sessionId);
    if (!session) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.NOT_FOUND, 'Session not found', {
          context: { sessionId },
        }),
        404
      );
    }
    session.lastActivity = Date.now();
    sendSuccess(res, { sessionId, alive: true }, 'heartbeat accepted', { sessionId });
  });

  registerDelete('/sessions/:sessionId', async (req, res) => {
    const parsed = orchestrationSessionDeleteParamsSchema.safeParse(req.params ?? {});
    if (!parsed.success) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.INVALID_PARAMETER, 'Invalid orchestration session id', {
          details: formatZodIssues(parsed.error),
          suggestion: '请提供有效的 sessionId',
        }),
        400
      );
    }
    const { sessionId } = parsed.data;

    const session = options.orchestrationSessions.get(sessionId);
    if (!session) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.NOT_FOUND, 'Session not found', {
          context: { sessionId },
        }),
        404
      );
    }

    options.orchestrationSessions.delete(sessionId);
    await options.cleanupOrchestrationSession(sessionId, session);
    if (idempotencyPersistence) {
      await idempotencyPersistence.deleteNamespace(sessionId);
    }
    sendSuccess(res, undefined, 'Session closed', { sessionId });
  });

  registerPost('/invoke', async (req, res) => {
    const parsed = orchestrationInvokeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.INVALID_PARAMETER, 'Invalid orchestration invoke request', {
          details: formatZodIssues(parsed.error),
          suggestion: '请提供有效的 sessionId、name，并确保 arguments 为对象',
        }),
        400
      );
    }
    const { sessionId, name, arguments: args } = parsed.data;
    const confirmationGrant = isCapabilityConfirmationGrant(parsed.data.confirmationGrant)
      ? parsed.data.confirmationGrant
      : undefined;

    const session = options.orchestrationSessions.get(sessionId);
    if (!session) {
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.NOT_FOUND, 'Session not found', {
          context: { sessionId },
        }),
        404
      );
    }

    await cleanupIdempotencyCache(session);

    const idempotencyKey = options.firstString(req.headers['idempotency-key']).trim();
    const idempotencyNamespace = idempotencyKey
      ? resolveIdempotencyNamespace(req, sessionId)
      : undefined;
    const requestHash = idempotencyKey ? hashOrchestrationInvokePayload(name, args) : '';
    if (idempotencyKey && idempotencyNamespace && idempotencyPersistence) {
      const reservationEntry: OrchestrationIdempotencyEntry = {
        state: 'running',
        requestHash,
        capability: name,
        createdAt: Date.now(),
        meta: {
          idempotencyKey,
          traceId:
            typeof res.locals.traceId === 'string' && res.locals.traceId.trim().length > 0
              ? (res.locals.traceId as string)
              : undefined,
        },
      };
      const reservation = idempotencyPersistence.reserve
        ? await idempotencyPersistence.reserve(idempotencyNamespace, idempotencyKey, reservationEntry)
        : {
            status: 'exists' as const,
            entry: await idempotencyPersistence.get(idempotencyNamespace, idempotencyKey),
      };
      const persisted = reservation.entry;
      if (persisted) {
        if (reservation.status === 'exists' && persisted.state === 'running') {
          const structured = createIdempotencyRunningError(name, idempotencyKey);
          return sendStructuredError(res, structured, options.mapStructuredErrorStatus(structured), {
            sessionId,
            capability: name,
            idempotencyKey,
          });
        }
        if (reservation.status === 'exists') {
          if (persisted.capability !== name || persisted.requestHash !== requestHash) {
            const structured = createIdempotencyConflictError(name, idempotencyKey);
            return sendStructuredError(res, structured, options.mapStructuredErrorStatus(structured), {
              sessionId,
              capability: name,
              idempotencyKey,
            });
          }
          session.idempotencyCache.set(idempotencyKey, persisted);
        }
      }
    }
    const requestTraceId =
      typeof res.locals.traceId === 'string' && res.locals.traceId.trim().length > 0
        ? (res.locals.traceId as string)
        : randomUUID();
    const scopesHeaderPresent = req.headers['x-airpa-scopes'] !== undefined;
    if (scopesHeaderPresent) {
      session.authScopes = options.parseScopesHeader(req.headers['x-airpa-scopes']);
    } else {
      session.authScopes = session.authScopes || [];
    }
    const scopes = [...(session.authScopes || [])];

    let apiResult: Awaited<ReturnType<OrchestrationExecutor['invokeApi']>>;
    try {
      apiResult = await options.enqueueOrchestrationInvoke(sessionId, session, (_context) =>
        {
          session.executor.refreshGeneration();
          return session.executor.invokeApi(
            {
              name,
              arguments: args,
              auth: {
                scopes,
                source: 'http',
                principal: 'http',
                sessionId,
                ...(confirmationGrant ? { confirmationGrant } : {}),
              },
            },
            {
              traceId: requestTraceId,
              signal: _context.signal,
              ...(idempotencyKey
                ? {
                    idempotency: {
                      key: idempotencyKey,
                      store: session.idempotencyCache,
                    },
                  }
                : {}),
            }
          );
        }
      );
    } catch (error) {
      const structured = options.normalizeStructuredError(error);
      return sendStructuredError(res, structured, options.mapStructuredErrorStatus(structured), {
        sessionId,
        capability: name,
      });
    }

    if (
      idempotencyKey &&
      idempotencyNamespace &&
      idempotencyPersistence &&
      apiResult._meta?.idempotencyStatus === 'stored'
    ) {
      const storedEntry = session.idempotencyCache.get(idempotencyKey);
      if (storedEntry) {
        await idempotencyPersistence.set(idempotencyNamespace, idempotencyKey, storedEntry);
      }
    }

    const idempotencyMeta = apiResult._meta?.idempotencyKey
      ? {
          idempotencyKey: apiResult._meta.idempotencyKey,
          ...(apiResult._meta.idempotencyStatus
            ? { idempotencyStatus: apiResult._meta.idempotencyStatus }
            : {}),
        }
      : {};
    const invokeMeta = buildOrchestrationResponseMeta(apiResult._meta);

    if (!apiResult.ok) {
      const structured =
        apiResult.error ||
        createStructuredError(ErrorCode.OPERATION_FAILED, `Capability invocation failed: ${name}`, {
          context: { capability: name, sessionId },
        });
      return sendStructuredError(res, structured, options.mapStructuredErrorStatus(structured), {
        sessionId,
        capability: name,
        ...idempotencyMeta,
        ...invokeMeta,
      });
    }

    sendSuccess(
      res,
      {
        sessionId,
        capability: name,
        ok: apiResult.ok,
        output: apiResult.output,
        error: apiResult.error,
        invokeMeta: apiResult._meta,
      },
      undefined,
      {
        sessionId,
        capability: name,
        ...idempotencyMeta,
        ...invokeMeta,
      }
    );
  });

  logger.info(`Orchestration REST API routes registered (prefix: ${prefix})`);
};
