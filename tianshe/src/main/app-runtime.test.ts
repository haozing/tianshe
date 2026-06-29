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

  it('stores the browser runtime manager explicitly', () => {
    const runtime = new AppRuntime();
    const browserRuntimeManager = { listRuntimeStatuses: async () => [] };

    runtime.browserRuntimeManager = browserRuntimeManager as never;

    expect(runtime.requireBrowserRuntimeManager()).toBe(browserRuntimeManager);
  });

  it('owns a service container for incremental runtime migration', () => {
    const runtime = new AppRuntime();
    const token = { id: 'logger' };
    const logger = { error: () => undefined };

    runtime.container.register(token, logger);

    expect(runtime.container.get(token)).toBe(logger);
  });

  it('exposes unified runtime readiness with browser pool state included', () => {
    const runtime = new AppRuntime();

    runtime.readiness.mark('mainServices', 'ready', { updatedAt: 5 });
    runtime.browserPoolReadiness.markInitializing(10);

    expect(runtime.getRuntimeReadiness()).toEqual([
      {
        service: 'mainServices',
        status: 'ready',
        updatedAt: 5,
        error: null,
      },
      {
        service: 'browserPool',
        status: 'initializing',
        updatedAt: 10,
        error: null,
        details: {
          status: 'initializing',
          startedAt: 10,
          readyAt: null,
          failedAt: null,
          error: null,
        },
      },
    ]);
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
