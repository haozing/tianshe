import { showBrowserView } from '../core/browser-pool';
import type { BrowserHandle } from '../core/browser-pool';
import { createLogger } from '../core/logger';
import type { RestApiDependencies } from '../types/http-api';
import {
  ErrorCode,
  createStructuredError,
  createStructuredErrorPayload,
  formatStructuredErrorText,
  type StructuredError,
} from '../types/error-codes';
import {
  buildMcpSessionStateSnapshot,
  type OrchestrationDependencies,
} from '../core/ai-dev/orchestration';
import {
  buildOrchestrationMcpSessionInfo,
  isMcpBrowserHandleUsable,
} from './mcp-http-session-snapshot';
import {
  BrowserAcquireTimeoutDiagnosticsError,
  getProfileAcquireReadiness,
  type BrowserAcquireReadiness,
} from './http-browser-pool-adapter';
import { asTrimmedText } from './mcp-http-transport-utils';
import type { McpSessionInfo, McpSessionRuntimeOptions } from './mcp-http-types';
import { getHiddenAutomationHostWindowId } from './window-manager';

const logger = createLogger('MCP-HTTP');

const normalizeScopes = (scopes: readonly string[] | undefined): string[] =>
  Array.from(
    new Set(
      (scopes || [])
        .map((scope) => asTrimmedText(scope))
        .filter(Boolean)
    )
  );

const scopesEqual = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean => {
  const normalizedLeft = normalizeScopes(left);
  const normalizedRight = normalizeScopes(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((scope, index) => scope === normalizedRight[index]);
};

const summarizeAcquireReadiness = (
  readiness: BrowserAcquireReadiness | null | undefined
): string => {
  if (!readiness) {
    return 'profile acquire readiness is unavailable';
  }
  if (readiness.browserCount <= 0) {
    return 'no pooled browsers are currently visible for this profile';
  }
  return `${readiness.browserCount} pooled browser(s), ${readiness.lockedBrowserCount} locked, ${readiness.creatingBrowserCount} creating, ${readiness.idleBrowserCount} idle, ${readiness.destroyingBrowserCount} destroying`;
};

const inspectSessionProfileAcquireReadiness = (
  options: McpSessionRuntimeOptions,
  profileId: string | undefined
): BrowserAcquireReadiness | null => {
  const normalizedProfileId = asTrimmedText(profileId);
  if (!normalizedProfileId || !options.getBrowserPoolManager) {
    return null;
  }
  try {
    return getProfileAcquireReadiness(options.getBrowserPoolManager(), normalizedProfileId);
  } catch {
    return null;
  }
};

const formatBusyBrowserPreview = (
  readiness: BrowserAcquireReadiness | null | undefined,
  limit = 3
): string[] => {
  if (!readiness) return [];
  return readiness.browsers
    .slice(0, limit)
    .map((browser) => {
      const owner = browser.source
        ? `${browser.source}${browser.pluginId ? `:${browser.pluginId}` : ''}`
        : 'unknown-owner';
      return `${browser.browserId || 'unknown-browser'} (${browser.status}, ${owner})`;
    });
};

const createBrowserAcquireStructuredError = (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo,
  error: unknown
): StructuredError | null => {
  if (error instanceof BrowserAcquireTimeoutDiagnosticsError) {
    const readiness = error.diagnostics;
    const busyPreview = formatBusyBrowserPreview(readiness);
    const details = [
      `The MCP session could not acquire profile ${readiness.profileId} during ${error.stage}.`,
      `Observed readiness: ${summarizeAcquireReadiness(readiness)}.`,
      busyPreview.length
        ? `Visible holders: ${busyPreview.join('; ')}.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    const busy = readiness.busy;
    return createStructuredError(
      ErrorCode.ACQUIRE_TIMEOUT,
      `Browser acquire timed out for profile ${readiness.profileId}`,
      {
        details,
        suggestion: busy
          ? 'This profile already has live browser resources. Release the current holder first, or choose another reusable profile before retrying.'
          : 'Retry after the browser runtime stabilizes, or inspect profile/plugin runtime state before retrying.',
        reasonCode: busy ? 'profile_resource_busy' : 'browser_acquire_timeout',
        retryable: true,
        recommendedNextTools: [
          'session_get_current',
          'profile_list',
          'plugin_list',
          'plugin_get_runtime_status',
          'session_end_current',
        ],
        nextActionHints: busy
          ? [
              'Use the acquireReadiness context to see which pooled browser is blocking the profile.',
              'Check plugin runtime status when a plugin-owned browser is holding the profile.',
              'Open a new MCP session on a different reusable profile if you cannot release the current holder.',
            ]
          : [
              'Retry after the profile runtime stabilizes.',
              'Inspect plugin and profile runtime state before retrying.',
            ],
        context: {
          sessionId: asTrimmedText(mcpSession.sessionId) || undefined,
          profileId: readiness.profileId,
          engine: asTrimmedText(mcpSession.engine) || undefined,
          visible: mcpSession.visible,
          stage: error.stage,
          acquireReadiness: readiness,
        },
      }
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (!message || !/timeout/i.test(message)) {
    return null;
  }

  const profileId = asTrimmedText(mcpSession.partition) || undefined;
  const readiness = inspectSessionProfileAcquireReadiness(options, profileId);
  const busy = readiness?.busy === true;
  const busyPreview = formatBusyBrowserPreview(readiness);
  return createStructuredError(
    ErrorCode.ACQUIRE_TIMEOUT,
    profileId
      ? `Browser acquire timed out for profile ${profileId}`
      : 'Browser acquire timed out for the current MCP session',
    {
      details: [
        message,
        readiness ? `Observed readiness: ${summarizeAcquireReadiness(readiness)}.` : '',
        busyPreview.length ? `Visible holders: ${busyPreview.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      suggestion: busy
        ? 'This profile already has live browser resources. Release the current holder first, or choose another reusable profile before retrying.'
        : 'Retry after the browser runtime stabilizes, or inspect profile/plugin runtime state before retrying.',
      reasonCode: busy ? 'profile_resource_busy' : 'browser_acquire_timeout',
      retryable: true,
      recommendedNextTools: [
        'session_get_current',
        'profile_list',
        'plugin_list',
        'plugin_get_runtime_status',
        'session_end_current',
      ],
      nextActionHints: busy
        ? [
            'Use the acquireReadiness context to see which pooled browser is blocking the profile.',
            'Check plugin runtime status when a plugin-owned browser is holding the profile.',
            'Open a new MCP session on a different reusable profile if you cannot release the current holder.',
          ]
        : [
            'Retry after the profile runtime stabilizes.',
            'Inspect plugin and profile runtime state before retrying.',
          ],
      context: {
        sessionId: asTrimmedText(mcpSession.sessionId) || undefined,
        profileId,
        engine: asTrimmedText(mcpSession.engine) || undefined,
        visible: mcpSession.visible,
        ...(readiness ? { acquireReadiness: readiness } : {}),
      },
    }
  );
};

export const resolveProfileIdHint = async (
  dependencies: RestApiDependencies | undefined,
  query: string | undefined
): Promise<string | undefined> => {
  const hint = asTrimmedText(query);
  if (!hint) return undefined;
  const gateway = dependencies?.profileGateway;
  if (!gateway) return hint;

  const byId = await gateway.getProfile(hint);
  if (byId?.id) return asTrimmedText(byId.id) || hint;

  const resolved = await gateway.resolveProfile(hint);
  if (resolved?.profile?.id) {
    const resolvedId = asTrimmedText(resolved.profile.id);
    if (resolvedId && resolvedId !== hint) {
      logger.info(
        `Resolved MCP partition hint "${hint}" -> profileId "${resolvedId}" (matchedBy=${resolved.matchedBy})`
      );
    }
    return resolvedId || hint;
  }

  return hint;
};

export const formatStructuredErrorForMcp = (error: StructuredError) => {
  return {
    content: [
      {
        type: 'text' as const,
        text: formatStructuredErrorText(error),
      },
    ],
    structuredContent: createStructuredErrorPayload(error),
    isError: true as const,
    _meta: { error },
  };
};

export const shouldRecycleSessionBrowser = (error: StructuredError): boolean => {
  const code = asTrimmedText(error.code);
  const searchable = [
    asTrimmedText(error.message),
    asTrimmedText(error.details),
    error.context ? JSON.stringify(error.context) : '',
  ]
    .join(' ')
    .toLowerCase();

  if (code === ErrorCode.BROWSER_CLOSED || code === ErrorCode.WEBCONTENTS_DESTROYED) {
    return true;
  }

  if (code === ErrorCode.TIMEOUT || code === ErrorCode.WAIT_TIMEOUT) {
    return (
      searchable.includes('cdp') ||
      searchable.includes('debugger') ||
      searchable.includes('capture') ||
      searchable.includes('webcontents')
    );
  }

  return (
    searchable.includes('browser has been closed') ||
    searchable.includes('target page, context or browser has been closed') ||
    searchable.includes('cdp command') ||
    searchable.includes('page.capturescreenshot') ||
    searchable.includes('debugger.sendcommand') ||
    searchable.includes('webcontents')
  );
};

const createStaleBrowserHandleReason = (sessionId: string | undefined): StructuredError =>
  createStructuredError(ErrorCode.BROWSER_CLOSED, 'Existing MCP session browser handle is closed', {
    details: 'The cached browser handle is no longer usable and will be reacquired.',
    context: {
      sessionId: asTrimmedText(sessionId) || undefined,
      reason: 'stale_browser_handle',
    },
  });

const clearSessionViewportState = (mcpSession: McpSessionInfo): void => {
  mcpSession.hostWindowId = undefined;
  mcpSession.viewportHealth = 'unknown';
  mcpSession.viewportHealthReason = undefined;
  mcpSession.interactionReady = false;
  mcpSession.offscreenDetected = false;
};

const updateSessionViewportState = (
  mcpSession: McpSessionInfo,
  state: {
    hostWindowId?: string;
    viewportHealth: 'unknown' | 'ready' | 'warning' | 'broken';
    viewportHealthReason?: string;
    interactionReady: boolean;
    offscreenDetected: boolean;
  }
): void => {
  mcpSession.hostWindowId = asTrimmedText(state.hostWindowId) || undefined;
  mcpSession.viewportHealth = state.viewportHealth;
  mcpSession.viewportHealthReason = asTrimmedText(state.viewportHealthReason) || undefined;
  mcpSession.interactionReady = state.interactionReady;
  mcpSession.offscreenDetected = state.offscreenDetected;
};

const markSessionClosingAfterResponse = (
  session: McpSessionInfo,
  sessionId: string
): void => {
  session.lastActivity = Date.now();
  session.closing = true;
  session.closeReason = createStructuredError(
    ErrorCode.OPERATION_FAILED,
    `Session is closing: ${sessionId}`,
    {
      details:
        'The MCP session has been scheduled for termination after the current response flushes.',
      reasonCode: 'session_closing',
      retryable: true,
      context: {
        sessionId,
        reason: 'session_closing',
      },
    }
  );
  session.terminateAfterResponse = true;
};

const resolveSessionHostWindowId = (mcpSession: McpSessionInfo): string => {
  if (mcpSession.visible) {
    return 'main';
  }
  return getHiddenAutomationHostWindowId(asTrimmedText(mcpSession.sessionId) || 'pending');
};

const ensureHiddenAutomationHost = (
  dependencies: RestApiDependencies | undefined,
  mcpSession: McpSessionInfo
): string | undefined => {
  const sessionId = asTrimmedText(mcpSession.sessionId);
  const windowManager = dependencies?.windowManager;
  if (!sessionId || !windowManager) {
    return undefined;
  }

  const hostWindowId = getHiddenAutomationHostWindowId(sessionId);
  try {
    if (!windowManager.getHiddenAutomationHost?.(sessionId)) {
      windowManager.createHiddenAutomationHost?.(sessionId);
    }
    return hostWindowId;
  } catch (error) {
    logger.warn(`Failed to ensure hidden automation host for session ${sessionId}:`, error);
    return undefined;
  }
};

const collectSessionViewportState = (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo,
  browserHandle?: BrowserHandle
): {
  hostWindowId?: string;
  viewportHealth: 'unknown' | 'ready' | 'warning' | 'broken';
  viewportHealthReason?: string;
  interactionReady: boolean;
  offscreenDetected: boolean;
} => {
  const handle = browserHandle || mcpSession.browserHandle;
  if (!handle) {
    return {
      hostWindowId: mcpSession.hostWindowId,
      viewportHealth: 'unknown',
      viewportHealthReason: 'browser is not acquired',
      interactionReady: false,
      offscreenDetected: false,
    };
  }

  if (!handle.viewId) {
    return {
      hostWindowId: mcpSession.hostWindowId,
      viewportHealth: mcpSession.viewportHealth ?? 'unknown',
      viewportHealthReason:
        asTrimmedText(mcpSession.viewportHealthReason) ||
        'browser implementation manages visibility directly',
      interactionReady:
        mcpSession.interactionReady === true || isMcpBrowserHandleUsable(handle),
      offscreenDetected: false,
    };
  }

  const viewManager = options.dependencies?.viewManager;
  const windowManager = options.dependencies?.windowManager;
  const viewInfo = viewManager?.getView?.(handle.viewId);
  const hostWindowId = asTrimmedText(viewInfo?.attachedTo) || asTrimmedText(mcpSession.hostWindowId);
  const hostWindow = hostWindowId ? windowManager?.getWindowById?.(hostWindowId) : undefined;

  if (!viewInfo) {
    return {
      hostWindowId,
      viewportHealth: 'broken',
      viewportHealthReason: 'browser view is missing from the view manager registry',
      interactionReady: false,
      offscreenDetected: false,
    };
  }

  if (!hostWindow || hostWindow.isDestroyed?.()) {
    return {
      hostWindowId,
      viewportHealth: 'broken',
      viewportHealthReason: 'attached host window is unavailable',
      interactionReady: false,
      offscreenDetected: false,
    };
  }

  const desiredHostWindowId = resolveSessionHostWindowId(mcpSession);
  const contentBounds = hostWindow.getContentBounds?.();
  const bounds = viewInfo.bounds;
  const hasPositiveBounds =
    bounds !== undefined &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x >= 0 &&
    bounds.y >= 0;
  const withinWindowBounds =
    hasPositiveBounds &&
    Boolean(contentBounds) &&
    bounds !== undefined &&
    bounds.x + bounds.width <= (contentBounds?.width || 0) + 1 &&
    bounds.y + bounds.height <= (contentBounds?.height || 0) + 1;
  const displayMode = asTrimmedText(viewInfo.metadata?.displayMode);
  const attachedToExpectedWindow = hostWindowId === desiredHostWindowId;
  const offscreenDetected = displayMode === 'offscreen' || !withinWindowBounds;
  const interactionReady =
    isMcpBrowserHandleUsable(handle) &&
    attachedToExpectedWindow &&
    Boolean(withinWindowBounds) &&
    !offscreenDetected;

  if (interactionReady) {
    return {
      hostWindowId,
      viewportHealth: 'ready',
      viewportHealthReason: mcpSession.visible
        ? 'browser view is attached to the main window with stable bounds'
        : 'browser view is attached to the hidden automation host with stable bounds',
      interactionReady: true,
      offscreenDetected: false,
    };
  }

  if (!attachedToExpectedWindow) {
    return {
      hostWindowId,
      viewportHealth: 'warning',
      viewportHealthReason: `browser view is attached to ${hostWindowId || 'no host'} but expected ${desiredHostWindowId}`,
      interactionReady: false,
      offscreenDetected,
    };
  }

  return {
    hostWindowId,
    viewportHealth: 'broken',
    viewportHealthReason: offscreenDetected
      ? 'browser view bounds are outside the host viewport'
      : 'browser view bounds are not ready for interaction',
    interactionReady: false,
    offscreenDetected,
  };
};

export const recycleSessionBrowserHandle = async (
  mcpSession: McpSessionInfo,
  reason: StructuredError
): Promise<void> => {
  const handle = mcpSession.browserHandle;
  if (!handle) {
    return;
  }

  mcpSession.browserHandle = undefined;
  clearSessionViewportState(mcpSession);
  try {
    await handle.release({ destroy: true });
    logger.warn(
      `Recycled session browser ${handle.browserId} after tool failure (${reason.code}: ${reason.message})`
    );
  } catch (releaseError) {
    logger.error('Failed to recycle session browser handle after tool failure:', releaseError);
  }
};

export const createMcpSessionGateway = (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo
): NonNullable<OrchestrationDependencies['mcpSessionGateway']> => ({
  getCurrentSessionId: () => asTrimmedText(mcpSession.sessionId) || undefined,
  listSessions: async () => {
    const currentSessionId = asTrimmedText(mcpSession.sessionId);
    return Array.from(options.transports.entries()).map(([sessionId, session]) => {
      const isCurrentSession = currentSessionId === sessionId;
      const viewportState = collectSessionViewportState(options, session);
      updateSessionViewportState(session, viewportState);
      return {
        ...buildOrchestrationMcpSessionInfo(session, {
          sessionId,
          lastActivityAt: new Date(session.lastActivity).toISOString(),
          pendingInvocations: isCurrentSession
            ? Math.max(0, session.pendingInvocations - 1)
            : session.pendingInvocations,
          activeInvocations: isCurrentSession
            ? Math.max(0, session.activeInvocations - 1)
            : session.activeInvocations,
          maxQueueSize: session.maxQueueSize,
        }),
        acquireReadiness: inspectSessionProfileAcquireReadiness(
          options,
          asTrimmedText(session.partition) || undefined
        ),
      };
    });
  },
  ensureCurrentSessionInteractionReady: async () =>
    ensureCurrentSessionInteractionReady(options, mcpSession),
  prepareCurrentSession: async (prepareOptions) => {
    const sessionId = asTrimmedText(mcpSession.sessionId);
    if (!sessionId) {
      return {
        sessionId: '',
        prepared: false,
        idempotent: false,
        engine: asTrimmedText(mcpSession.engine) || undefined,
        visible: mcpSession.visible,
        effectiveScopes: normalizeScopes(mcpSession.authScopes),
        browserAcquired: Boolean(mcpSession.browserHandle || mcpSession.browserAcquirePromise),
        changed: [],
        acquireReadiness: null,
        reason: 'current_session_unavailable' as const,
        ...buildMcpSessionStateSnapshot(null),
      };
    }

    if (mcpSession.browserHandle && !isMcpBrowserHandleUsable(mcpSession.browserHandle)) {
      await recycleSessionBrowserHandle(
        mcpSession,
        createStaleBrowserHandleReason(mcpSession.sessionId)
      );
    }

    const currentProfileId = asTrimmedText(mcpSession.partition) || undefined;
    const currentEngine = asTrimmedText(mcpSession.engine) || undefined;
    const currentVisible = mcpSession.visible;
    const browserAcquired = Boolean(mcpSession.browserHandle || mcpSession.browserAcquirePromise);
    const changed: Array<'profile' | 'engine' | 'visible' | 'scopes'> = [];
    const requestedProfileId = asTrimmedText(prepareOptions.profileId) || undefined;
    const requestedEngine = prepareOptions.engine
      ? options.parseRequestedEngine(prepareOptions.engine)
      : undefined;
    const requestedVisible = prepareOptions.visible;
    const requestedScopes =
      prepareOptions.scopes !== undefined ? normalizeScopes(prepareOptions.scopes) : undefined;
    const currentState = buildMcpSessionStateSnapshot({
      sessionId,
      profileId: currentProfileId,
      engine: currentEngine,
      visible: currentVisible,
      effectiveScopes: normalizeScopes(mcpSession.authScopes),
      browserAcquired: Boolean(mcpSession.browserHandle),
      browserAcquireInProgress: Boolean(mcpSession.browserAcquirePromise),
      closing: mcpSession.closing === true,
      terminateAfterResponse: mcpSession.terminateAfterResponse === true,
    });
    const currentAcquireReadiness = () =>
      inspectSessionProfileAcquireReadiness(
        options,
        asTrimmedText(mcpSession.partition) || undefined
      );

    if (currentState.bindingLocked) {
      if (requestedProfileId && requestedProfileId !== currentProfileId) {
        return {
          sessionId,
          prepared: false,
          idempotent: false,
          profileId: currentProfileId,
          engine: currentEngine,
          visible: currentVisible,
          effectiveScopes: normalizeScopes(mcpSession.authScopes),
          browserAcquired: true,
          changed,
          acquireReadiness: currentAcquireReadiness(),
          reason: 'binding_locked' as const,
          currentProfileId,
          currentEngine,
          currentVisible,
          ...currentState,
        };
      }

      if (requestedEngine && requestedEngine !== currentEngine) {
        return {
          sessionId,
          prepared: false,
          idempotent: false,
          profileId: currentProfileId,
          engine: currentEngine,
          visible: currentVisible,
          effectiveScopes: normalizeScopes(mcpSession.authScopes),
          browserAcquired: true,
          changed,
          acquireReadiness: currentAcquireReadiness(),
          reason: 'binding_locked' as const,
          currentProfileId,
          currentEngine,
          currentVisible,
          ...currentState,
        };
      }

      if (typeof requestedVisible === 'boolean' && requestedVisible !== currentVisible) {
        return {
          sessionId,
          prepared: false,
          idempotent: false,
          profileId: currentProfileId,
          engine: currentEngine,
          visible: currentVisible,
          effectiveScopes: normalizeScopes(mcpSession.authScopes),
          browserAcquired: true,
          changed,
          acquireReadiness: currentAcquireReadiness(),
          reason: 'binding_locked' as const,
          currentProfileId,
          currentEngine,
          currentVisible,
          ...currentState,
        };
      }
    }

    if (!currentState.bindingLocked && requestedProfileId && requestedProfileId !== currentProfileId) {
      mcpSession.partition = requestedProfileId;
      changed.push('profile');
    }

    if (!currentState.bindingLocked && requestedEngine && requestedEngine !== currentEngine) {
      mcpSession.engine = requestedEngine;
      changed.push('engine');
    }

    if (
      !currentState.bindingLocked &&
      typeof requestedVisible === 'boolean' &&
      requestedVisible !== currentVisible
    ) {
      mcpSession.visible = requestedVisible;
      changed.push('visible');
    }

    if (requestedScopes && !scopesEqual(mcpSession.authScopes, requestedScopes)) {
      mcpSession.authScopes = requestedScopes;
      changed.push('scopes');
    }

    return {
      sessionId,
      prepared: true,
      idempotent: changed.length === 0,
      profileId: asTrimmedText(mcpSession.partition) || undefined,
      engine: asTrimmedText(mcpSession.engine) || undefined,
      visible: mcpSession.visible,
      effectiveScopes: normalizeScopes(mcpSession.authScopes),
      browserAcquired,
      changed,
      acquireReadiness: currentAcquireReadiness(),
      currentProfileId: asTrimmedText(mcpSession.partition) || undefined,
      currentEngine: asTrimmedText(mcpSession.engine) || undefined,
      currentVisible: mcpSession.visible,
      ...buildMcpSessionStateSnapshot({
        sessionId,
        profileId: asTrimmedText(mcpSession.partition) || undefined,
        engine: asTrimmedText(mcpSession.engine) || undefined,
        visible: mcpSession.visible,
        effectiveScopes: normalizeScopes(mcpSession.authScopes),
        browserAcquired: Boolean(mcpSession.browserHandle),
        browserAcquireInProgress: Boolean(mcpSession.browserAcquirePromise),
        closing: mcpSession.closing === true,
        terminateAfterResponse: mcpSession.terminateAfterResponse === true,
      }),
    };
  },
  closeSession: async (sessionId, closeOptions) => {
    const targetSessionId = asTrimmedText(sessionId);
    if (!targetSessionId) return { closed: false, reason: 'not_found' as const };

    const currentSessionId = asTrimmedText(mcpSession.sessionId);
    const allowCurrent = closeOptions?.allowCurrent === true;
    const target = options.transports.get(targetSessionId);
    if (!target) {
      return { closed: false, reason: 'not_found' as const };
    }

    if (currentSessionId && currentSessionId === targetSessionId) {
      if (!allowCurrent) {
        return { closed: false, reason: 'current_session_blocked' as const };
      }

      markSessionClosingAfterResponse(target, targetSessionId);
      return {
        closed: true,
        closedCurrentSession: true,
        transportInvalidated: true,
        allowFurtherCallsOnSameTransport: false,
        terminationTiming: 'after_response_flush' as const,
      };
    }

    options.transports.delete(targetSessionId);
    await options.cleanupSession(targetSessionId, target);
    return {
      closed: true,
      closedCurrentSession: false,
      transportInvalidated: false,
      allowFurtherCallsOnSameTransport: true,
      terminationTiming: 'immediate' as const,
    };
  },
});

const applySessionBrowserVisibility = async (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo,
  browserHandle: BrowserHandle,
  visible: boolean
): Promise<void> => {
  const viewManager = options.dependencies?.viewManager;
  const windowManager = options.dependencies?.windowManager;

  if (browserHandle.viewId && viewManager && windowManager) {
    const targetWindowId = visible
      ? 'main'
      : ensureHiddenAutomationHost(options.dependencies, mcpSession);
    if (targetWindowId) {
      const shown = showBrowserView(
        browserHandle.viewId,
        viewManager,
        windowManager,
        targetWindowId,
        'mcp'
      );
      if (shown) {
        const viewportState = collectSessionViewportState(options, mcpSession, browserHandle);
        updateSessionViewportState(mcpSession, viewportState);
        logger.info(
          `Browser view attached to ${targetWindowId} for session ${asTrimmedText(mcpSession.sessionId) || 'pending'}: ${browserHandle.viewId}`
        );
      } else {
        updateSessionViewportState(mcpSession, {
          hostWindowId: targetWindowId,
          viewportHealth: 'broken',
          viewportHealthReason: `failed to attach browser view to ${targetWindowId}`,
          interactionReady: false,
          offscreenDetected: false,
        });
        logger.warn(`Failed to attach browser view to ${targetWindowId}: ${browserHandle.viewId}`);
      }
      return;
    }
  }

  clearSessionViewportState(mcpSession);
  try {
    if (visible && browserHandle.browser.show) {
      await browserHandle.browser.show();
      updateSessionViewportState(mcpSession, {
        viewportHealth: 'unknown',
        viewportHealthReason: 'browser implementation manages visibility directly',
        interactionReady: true,
        offscreenDetected: false,
      });
    } else if (!visible && browserHandle.browser.hide) {
      await browserHandle.browser.hide();
      updateSessionViewportState(mcpSession, {
        viewportHealth: 'unknown',
        viewportHealthReason: 'browser implementation manages visibility directly',
        interactionReady: true,
        offscreenDetected: false,
      });
    }
  } catch {
    // ignore
  }
};

const getMcpSessionAbortError = (mcpSession: McpSessionInfo): StructuredError | undefined => {
  if (mcpSession.closeReason) {
    return mcpSession.closeReason;
  }

  const abortReason =
    mcpSession.activeInvocationController?.signal.reason ??
    mcpSession.closeController?.signal.reason;
  if (
    typeof abortReason === 'object' &&
    abortReason !== null &&
    'code' in abortReason &&
    'message' in abortReason
  ) {
    return abortReason as StructuredError;
  }

  if (mcpSession.closing) {
    return {
      code: ErrorCode.OPERATION_FAILED,
      message: `Session is closing: ${asTrimmedText(mcpSession.sessionId) || 'mcp-session'}`,
      details: 'The MCP session is terminating while acquiring a browser handle.',
      context: {
        sessionId: asTrimmedText(mcpSession.sessionId) || undefined,
        reason: 'session_closing',
      },
    };
  }

  return undefined;
};

const getMcpSessionAbortSignal = (mcpSession: McpSessionInfo): AbortSignal | undefined => {
  return mcpSession.activeInvocationController?.signal || mcpSession.closeController?.signal;
};

const awaitAbortableMcpPromise = async <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => StructuredError
): Promise<T> => {
  if (!signal) {
    return promise;
  }

  const resolveAbortError = (): StructuredError => {
    const reason = signal.reason;
    if (
      typeof reason === 'object' &&
      reason !== null &&
      'code' in reason &&
      'message' in reason
    ) {
      return reason as StructuredError;
    }
    return onAbort();
  };

  if (signal.aborted) {
    throw resolveAbortError();
  }

  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(resolveAbortError());
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};

const ensureSessionBrowserRuntimeReady = async (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo,
  browserHandle: BrowserHandle
): Promise<void> => {
  const viewportState = collectSessionViewportState(options, mcpSession, browserHandle);
  updateSessionViewportState(mcpSession, viewportState);

  if (viewportState.interactionReady) {
    return;
  }

  if (
    browserHandle.viewId &&
    options.dependencies?.viewManager &&
    options.dependencies?.windowManager
  ) {
    await applySessionBrowserVisibility(options, mcpSession, browserHandle, mcpSession.visible);
    const repairedState = collectSessionViewportState(options, mcpSession, browserHandle);
    updateSessionViewportState(mcpSession, repairedState);
    if (repairedState.interactionReady) {
      return;
    }
  }

  if (!browserHandle.viewId) {
    updateSessionViewportState(mcpSession, {
      ...viewportState,
      viewportHealth: 'unknown',
      viewportHealthReason:
        viewportState.viewportHealthReason ||
        'browser does not expose a managed view; interaction health is implementation-defined',
      interactionReady: true,
      offscreenDetected: false,
    });
    return;
  }

  throw createStructuredError(
    ErrorCode.INTERACTION_NOT_READY,
    `MCP session browser host is not ready: ${viewportState.viewportHealthReason || 'unknown host state'}`,
    {
      details:
        'The browser view could not be attached to a stable host window and viewport before continuing.',
      suggestion:
        'Retry the action after the session reacquires a browser, or inspect session_get_current for host and viewport health.',
      context: {
        sessionId: asTrimmedText(mcpSession.sessionId) || undefined,
        viewId: browserHandle.viewId,
        hostWindowId: viewportState.hostWindowId || null,
        visible: mcpSession.visible,
        viewportHealth: viewportState.viewportHealth,
        offscreenDetected: viewportState.offscreenDetected,
      },
    }
  );
};

const buildCurrentSessionInteractionContext = (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo,
  repaired: boolean
) => {
  const viewportState = collectSessionViewportState(options, mcpSession, mcpSession.browserHandle);
  updateSessionViewportState(mcpSession, viewportState);
  return {
    sessionId: asTrimmedText(mcpSession.sessionId) || undefined,
    visible: mcpSession.visible,
    hostWindowId: viewportState.hostWindowId,
    viewportHealth: viewportState.viewportHealth,
    viewportHealthReason: viewportState.viewportHealthReason,
    interactionReady: viewportState.interactionReady,
    offscreenDetected: viewportState.offscreenDetected,
    repaired,
    browserAcquired: Boolean(mcpSession.browserHandle),
  };
};

const ensureCurrentSessionInteractionReady = async (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo
) => {
  let repaired = false;

  const attemptEnsure = async () => {
    await ensureSessionBrowserHandle(options, mcpSession);
    return buildCurrentSessionInteractionContext(options, mcpSession, repaired);
  };

  try {
    return await attemptEnsure();
  } catch (error) {
    const structured =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      'message' in error
        ? (error as StructuredError)
        : createStructuredError(
            ErrorCode.INTERACTION_NOT_READY,
            'Current MCP session is not ready for interaction',
            {
              context: {
                sessionId: asTrimmedText(mcpSession.sessionId) || undefined,
              },
            }
          );

    repaired = true;
    if (mcpSession.browserHandle) {
      await recycleSessionBrowserHandle(mcpSession, structured);
    }
    return attemptEnsure();
  }
};

export const ensureSessionBrowserHandle = async (
  options: McpSessionRuntimeOptions,
  mcpSession: McpSessionInfo
): Promise<BrowserHandle> => {
  const abortSignal = getMcpSessionAbortSignal(mcpSession);
  const abortError =
    getMcpSessionAbortError(mcpSession) ||
    ({
      code: ErrorCode.OPERATION_FAILED,
      message: `Session is closing: ${asTrimmedText(mcpSession.sessionId) || 'mcp-session'}`,
      details: 'The MCP session was aborted while acquiring a browser handle.',
      context: {
        sessionId: asTrimmedText(mcpSession.sessionId) || undefined,
        reason: 'session_closing',
      },
    } as StructuredError);

  if (abortSignal?.aborted) {
    throw abortError;
  }

  if (mcpSession.browserHandle && !isMcpBrowserHandleUsable(mcpSession.browserHandle)) {
    await recycleSessionBrowserHandle(
      mcpSession,
      createStaleBrowserHandleReason(mcpSession.sessionId)
    );
  }

  if (mcpSession.browserHandle) {
    await ensureSessionBrowserRuntimeReady(options, mcpSession, mcpSession.browserHandle);
    return mcpSession.browserHandle;
  }

  if (mcpSession.browserAcquirePromise) {
    return awaitAbortableMcpPromise(mcpSession.browserAcquirePromise, abortSignal, () => abortError);
  }

  const rawAcquirePromise = (async () => {
    let browserHandle: BrowserHandle;
    try {
      browserHandle = await options.acquireBrowserFromPool(
        mcpSession.partition,
        mcpSession.engine,
        'mcp'
      );
    } catch (error) {
      const structured = createBrowserAcquireStructuredError(options, mcpSession, error);
      if (structured) {
        throw structured;
      }
      throw error;
    }

    try {
      if (getMcpSessionAbortSignal(mcpSession)?.aborted || mcpSession.closing) {
        throw abortError;
      }

      await applySessionBrowserVisibility(options, mcpSession, browserHandle, mcpSession.visible);
      await ensureSessionBrowserRuntimeReady(options, mcpSession, browserHandle);
      if (getMcpSessionAbortSignal(mcpSession)?.aborted || mcpSession.closing) {
        throw abortError;
      }

      mcpSession.browserHandle = browserHandle;
      return browserHandle;
    } catch (error) {
      try {
        await browserHandle.release({ destroy: true });
      } catch (releaseError) {
        logger.error('Failed to release browser handle after show error:', releaseError);
      }
      throw error;
    }
  })();

  const acquirePromise = awaitAbortableMcpPromise(rawAcquirePromise, abortSignal, () => abortError);
  mcpSession.browserAcquirePromise = acquirePromise;
  try {
    return await acquirePromise;
  } finally {
    if (mcpSession.browserAcquirePromise === acquirePromise) {
      mcpSession.browserAcquirePromise = undefined;
    }
  }
};
