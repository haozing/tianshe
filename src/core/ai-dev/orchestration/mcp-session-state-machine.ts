import type { OrchestrationMcpSessionPhase } from './types';

export interface McpSessionStateInput {
  sessionId?: string | null;
  profileId?: string | null;
  engine?: string | null;
  visible?: boolean;
  effectiveScopes?: readonly string[] | null;
  browserAcquired?: boolean;
  browserAcquireInProgress?: boolean;
  closing?: boolean;
  terminateAfterResponse?: boolean;
}

export interface McpSessionStateSnapshot {
  phase: OrchestrationMcpSessionPhase;
  bindingLocked: boolean;
}

const hasPreparationState = (state: McpSessionStateInput): boolean => {
  if (String(state.profileId || '').trim()) {
    return true;
  }
  if (String(state.engine || '').trim()) {
    return true;
  }
  if (state.visible === true) {
    return true;
  }
  return Array.isArray(state.effectiveScopes) && state.effectiveScopes.length > 0;
};

export const resolveMcpSessionPhase = (
  state: McpSessionStateInput | null | undefined
): OrchestrationMcpSessionPhase => {
  if (!state || !String(state.sessionId || '').trim()) {
    return 'closed';
  }
  if (state.closing === true || state.terminateAfterResponse === true) {
    return 'closing';
  }
  if (state.browserAcquired === true) {
    return 'bound_browser';
  }
  if (state.browserAcquireInProgress === true) {
    return 'acquiring_browser';
  }
  if (hasPreparationState(state)) {
    return 'prepared_unacquired';
  }
  return 'fresh_unbound';
};

export const isMcpSessionBindingLocked = (
  state: McpSessionStateInput | null | undefined
): boolean => {
  const phase = resolveMcpSessionPhase(state);
  return (
    phase === 'acquiring_browser' ||
    phase === 'bound_browser' ||
    phase === 'closing' ||
    phase === 'closed'
  );
};

export const buildMcpSessionStateSnapshot = (
  state: McpSessionStateInput | null | undefined
): McpSessionStateSnapshot => ({
  phase: resolveMcpSessionPhase(state),
  bindingLocked: isMcpSessionBindingLocked(state),
});
