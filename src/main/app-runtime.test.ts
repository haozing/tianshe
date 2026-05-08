import { describe, expect, it } from 'vitest';
import { AppRuntime } from './app-runtime';

describe('AppRuntime', () => {
  it('fails clearly when required services are accessed before initialization', () => {
    const runtime = new AppRuntime();

    expect(() => runtime.requireDuckDBService()).toThrow('duckdbService has not been initialized');
    expect(() => runtime.requireWindowManager()).toThrow('windowManager has not been initialized');
  });

  it('stores initialized service instances explicitly', () => {
    const runtime = new AppRuntime();
    const logger = { error: () => undefined };

    runtime.logger = logger as never;

    expect(runtime.requireLogger()).toBe(logger);
  });

  it('owns browser pool readiness state for the main runtime', () => {
    const runtime = new AppRuntime();

    runtime.browserPoolReadiness.markInitializing(10);
    runtime.browserPoolReadiness.markReady(20);

    expect(runtime.browserPoolReadiness.getSnapshot()).toMatchObject({
      status: 'ready',
      startedAt: 10,
      readyAt: 20,
    });
  });
});
