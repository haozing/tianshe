import { describe, expect, it } from 'vitest';
import { BrowserPoolReadiness } from './browser-pool-readiness';

describe('BrowserPoolReadiness', () => {
  it('tracks initialization and ready timestamps', () => {
    const readiness = new BrowserPoolReadiness();

    expect(readiness.getSnapshot()).toEqual({
      status: 'not-started',
      startedAt: null,
      readyAt: null,
      failedAt: null,
      error: null,
    });

    readiness.markInitializing(10);
    readiness.markReady(25);

    expect(readiness.getSnapshot()).toEqual({
      status: 'ready',
      startedAt: 10,
      readyAt: 25,
      failedAt: null,
      error: null,
    });
  });

  it('tracks failed initialization with a stable message', () => {
    const readiness = new BrowserPoolReadiness();

    readiness.markInitializing(10);
    readiness.markFailed(new Error('profile service unavailable'), 30);

    expect(readiness.getSnapshot()).toEqual({
      status: 'failed',
      startedAt: 10,
      readyAt: null,
      failedAt: 30,
      error: 'profile service unavailable',
    });
  });

  it('exposes a runtime readiness compatible snapshot', () => {
    const readiness = new BrowserPoolReadiness();

    readiness.markInitializing(10);
    readiness.markFailed('pool unavailable', 30);

    expect(readiness.getRuntimeReadinessSnapshot()).toEqual({
      service: 'browserPool',
      status: 'failed',
      updatedAt: 30,
      error: 'pool unavailable',
      details: {
        status: 'failed',
        startedAt: 10,
        readyAt: null,
        failedAt: 30,
        error: 'pool unavailable',
      },
    });
  });
});
