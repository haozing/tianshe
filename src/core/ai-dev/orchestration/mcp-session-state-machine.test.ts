import { describe, expect, it } from 'vitest';
import {
  buildMcpSessionStateSnapshot,
  resolveMcpSessionPhase,
} from './mcp-session-state-machine';

describe('mcp session state machine', () => {
  it('resolves the canonical session phases from session state', () => {
    expect(resolveMcpSessionPhase({ sessionId: 'session-1' })).toBe('fresh_unbound');
    expect(
      resolveMcpSessionPhase({
        sessionId: 'session-1',
        profileId: 'profile-1',
      })
    ).toBe('prepared_unacquired');
    expect(
      resolveMcpSessionPhase({
        sessionId: 'session-1',
        profileId: 'profile-1',
        browserAcquireInProgress: true,
      })
    ).toBe('acquiring_browser');
    expect(
      resolveMcpSessionPhase({
        sessionId: 'session-1',
        browserAcquired: true,
      })
    ).toBe('bound_browser');
    expect(
      resolveMcpSessionPhase({
        sessionId: 'session-1',
        browserAcquired: true,
        closing: true,
      })
    ).toBe('closing');
    expect(resolveMcpSessionPhase({ sessionId: '' })).toBe('closed');
  });

  it('marks active post-prepare phases as binding-locked', () => {
    expect(
      buildMcpSessionStateSnapshot({
        sessionId: 'session-1',
      })
    ).toEqual({
      phase: 'fresh_unbound',
      bindingLocked: false,
    });

    expect(
      buildMcpSessionStateSnapshot({
        sessionId: 'session-1',
        profileId: 'profile-1',
      })
    ).toEqual({
      phase: 'prepared_unacquired',
      bindingLocked: false,
    });

    expect(
      buildMcpSessionStateSnapshot({
        sessionId: 'session-1',
        browserAcquireInProgress: true,
      })
    ).toEqual({
      phase: 'acquiring_browser',
      bindingLocked: true,
    });

    expect(
      buildMcpSessionStateSnapshot({
        sessionId: 'session-1',
        browserAcquired: true,
      })
    ).toEqual({
      phase: 'bound_browser',
      bindingLocked: true,
    });

    expect(
      buildMcpSessionStateSnapshot({
        sessionId: 'session-1',
        terminateAfterResponse: true,
      })
    ).toEqual({
      phase: 'closing',
      bindingLocked: true,
    });
  });
});
