import type { BrowserHandle } from '../core/browser-pool';
import {
  buildMcpSessionStateSnapshot,
  type OrchestrationMcpSessionInfo,
} from '../core/ai-dev/orchestration';
import type { BrowserRuntimeDescriptor } from '../types/browser-interface';
import { asTrimmedText } from './mcp-http-transport-utils';
import type { McpSessionInfo, McpSessionViewportHealth } from './mcp-http-types';
import { getStaticEngineRuntimeDescriptor } from '../core/browser-pool/engine-capability-registry';
import { isAutomationEngine } from '../types/profile';

export interface McpSessionSnapshot {
  sessionId: string | null;
  profileId: string | null;
  engine: string | null;
  visible: boolean;
  browserAcquired: boolean;
  browserAcquireInProgress: boolean;
  effectiveScopes: string[];
  closing: boolean;
  terminateAfterResponse: boolean;
  hostWindowId: string | null;
  viewportHealth: McpSessionViewportHealth;
  viewportHealthReason: string | null;
  interactionReady: boolean;
  offscreenDetected: boolean;
  engineRuntimeDescriptor: BrowserRuntimeDescriptor | null;
  browserRuntimeDescriptor: BrowserRuntimeDescriptor | null;
  resolvedRuntimeDescriptor: BrowserRuntimeDescriptor | null;
  phase: OrchestrationMcpSessionInfo['phase'];
  bindingLocked: boolean;
}

interface McpSessionSnapshotOverrides {
  sessionId?: string;
  hostWindowId?: string;
  viewportHealth?: McpSessionViewportHealth;
  viewportHealthReason?: string;
  interactionReady?: boolean;
  offscreenDetected?: boolean;
}

export const isMcpBrowserHandleUsable = (
  handle: BrowserHandle | undefined
): handle is BrowserHandle => {
  if (!handle) {
    return false;
  }

  const browser = (handle.browser ?? null) as { isClosed?: () => boolean } | null;
  if (!browser) {
    return false;
  }

  if (typeof browser.isClosed === 'function') {
    try {
      return !browser.isClosed();
    } catch {
      return false;
    }
  }

  return true;
};

export const buildMcpSessionSnapshot = (
  mcpSession: McpSessionInfo,
  overrides: McpSessionSnapshotOverrides = {}
): McpSessionSnapshot => {
  const engine = asTrimmedText(mcpSession.engine) || null;
  const browserAcquired = isMcpBrowserHandleUsable(mcpSession.browserHandle);
  const engineRuntimeDescriptor =
    isAutomationEngine(engine)
      ? getStaticEngineRuntimeDescriptor(engine)
      : null;
  const browserRuntimeDescriptor =
    browserAcquired &&
    mcpSession.browserHandle?.browser &&
    typeof mcpSession.browserHandle.browser.describeRuntime === 'function'
      ? mcpSession.browserHandle.browser.describeRuntime()
      : null;
  const resolvedRuntimeDescriptor = browserRuntimeDescriptor || engineRuntimeDescriptor;

  return {
    ...buildMcpSessionStateSnapshot({
      sessionId: overrides.sessionId ?? mcpSession.sessionId,
      profileId: mcpSession.partition,
      engine: mcpSession.engine,
      visible: mcpSession.visible,
      effectiveScopes: mcpSession.authScopes || [],
      browserAcquired,
      browserAcquireInProgress: Boolean(mcpSession.browserAcquirePromise),
      closing: mcpSession.closing === true,
      terminateAfterResponse: mcpSession.terminateAfterResponse === true,
    }),
    sessionId: asTrimmedText(overrides.sessionId ?? mcpSession.sessionId) || null,
    profileId: asTrimmedText(mcpSession.partition) || null,
    engine,
    visible: mcpSession.visible,
    browserAcquired,
    browserAcquireInProgress: Boolean(mcpSession.browserAcquirePromise),
    effectiveScopes: [...(mcpSession.authScopes || [])],
    closing: mcpSession.closing === true,
    terminateAfterResponse: mcpSession.terminateAfterResponse === true,
    hostWindowId: asTrimmedText(overrides.hostWindowId ?? mcpSession.hostWindowId) || null,
    viewportHealth: overrides.viewportHealth ?? mcpSession.viewportHealth ?? 'unknown',
    viewportHealthReason:
      asTrimmedText(overrides.viewportHealthReason ?? mcpSession.viewportHealthReason) || null,
    interactionReady: overrides.interactionReady ?? (mcpSession.interactionReady === true),
    offscreenDetected: overrides.offscreenDetected ?? (mcpSession.offscreenDetected === true),
    engineRuntimeDescriptor,
    browserRuntimeDescriptor,
    resolvedRuntimeDescriptor,
  };
};

export const buildOrchestrationMcpSessionInfo = (
  mcpSession: McpSessionInfo,
  options: {
    sessionId: string;
    lastActivityAt: string;
    pendingInvocations: number;
    activeInvocations: number;
    maxQueueSize: number;
  }
): OrchestrationMcpSessionInfo => {
  const snapshot = buildMcpSessionSnapshot(mcpSession, {
    sessionId: options.sessionId,
  });

  return {
    sessionId: snapshot.sessionId || options.sessionId,
    profileId: snapshot.profileId || undefined,
    engine: snapshot.engine || undefined,
    visible: snapshot.visible,
    lastActivityAt: options.lastActivityAt,
    pendingInvocations: options.pendingInvocations,
    activeInvocations: options.activeInvocations,
    maxQueueSize: options.maxQueueSize,
    browserAcquired: snapshot.browserAcquired,
    browserAcquireInProgress: snapshot.browserAcquireInProgress,
    hasBrowserHandle: snapshot.browserAcquired,
    effectiveScopes: [...snapshot.effectiveScopes],
    closing: snapshot.closing,
    terminateAfterResponse: snapshot.terminateAfterResponse,
    hostWindowId: snapshot.hostWindowId || undefined,
    viewportHealth: snapshot.viewportHealth,
    viewportHealthReason: snapshot.viewportHealthReason || undefined,
    interactionReady: snapshot.interactionReady,
    offscreenDetected: snapshot.offscreenDetected,
    engineRuntimeDescriptor: snapshot.engineRuntimeDescriptor,
    browserRuntimeDescriptor: snapshot.browserRuntimeDescriptor,
    resolvedRuntimeDescriptor: snapshot.resolvedRuntimeDescriptor,
    phase: snapshot.phase,
    bindingLocked: snapshot.bindingLocked,
  };
};
