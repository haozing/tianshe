import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShutdownBootstrap,
  registerAppLifecycleHandlers,
  registerProcessSignalHandlers,
} from './shutdown-bootstrap';

function createOptions(overrides: Record<string, unknown> = {}) {
  const steps: string[] = [];
  const stopHttpServer = vi.fn(async () => {
    steps.push('stop-http-server');
  });
  const disposeScheduler = vi.fn(async () => {
    steps.push('dispose-scheduler');
  });
  const cleanupUpdater = vi.fn(() => {
    steps.push('cleanup-updater');
  });
  const stopBrowserPool = vi.fn(async () => {
    steps.push('stop-browser-pool');
  });
  const cleanupViewManager = vi.fn(async () => {
    steps.push('cleanup-view-manager');
  });
  const cleanupWindowManager = vi.fn(() => {
    steps.push('cleanup-window-manager');
  });
  const closeDuckDB = vi.fn(async () => {
    steps.push('close-duckdb');
  });
  const exitApp = vi.fn((code: number) => {
    steps.push(`exit-app:${code}`);
  });
  const exitProcess = vi.fn((code: number) => {
    steps.push(`exit-process:${code}`);
  });
  const quitApp = vi.fn(() => {
    steps.push('quit-app');
  });
  const createWindow = vi.fn(() => {
    steps.push('create-window');
  });
  const consoleRef = {
    log: vi.fn(),
    error: vi.fn(),
  };

  return {
    steps,
    stopHttpServer,
    disposeScheduler,
    cleanupUpdater,
    stopBrowserPool,
    cleanupViewManager,
    cleanupWindowManager,
    closeDuckDB,
    exitApp,
    exitProcess,
    quitApp,
    createWindow,
    consoleRef,
    options: {
      stopHttpServer,
      disposeScheduler,
      cleanupUpdater,
      stopBrowserPool,
      cleanupViewManager,
      cleanupWindowManager,
      closeDuckDB,
      exitApp,
      exitProcess,
      quitApp,
      getWindowCount: () => 0,
      createWindow,
      consoleRef,
      ...overrides,
    },
  };
}

describe('shutdown-bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs cleanup in order and exits the app on before-quit', async () => {
    const { steps, exitApp, options } = createOptions();
    const handlers = createShutdownBootstrap(options);

    await handlers.handleBeforeQuit({
      preventDefault: vi.fn(),
    });

    expect(steps).toEqual([
      'stop-http-server',
      'dispose-scheduler',
      'cleanup-updater',
      'stop-browser-pool',
      'cleanup-view-manager',
      'cleanup-window-manager',
      'close-duckdb',
      'exit-app:0',
    ]);
    expect(exitApp).toHaveBeenCalledWith(0);
  });

  it('reuses the same cleanup promise and prevents duplicate exits', async () => {
    const {
      stopHttpServer,
      disposeScheduler,
      cleanupUpdater,
      stopBrowserPool,
      cleanupViewManager,
      cleanupWindowManager,
      closeDuckDB,
      exitApp,
      exitProcess,
      options,
    } = createOptions();
    const handlers = createShutdownBootstrap(options);

    await handlers.handleBeforeQuit({
      preventDefault: vi.fn(),
    });
    await handlers.handleProcessSignal('SIGINT');

    expect(stopHttpServer).toHaveBeenCalledTimes(1);
    expect(disposeScheduler).toHaveBeenCalledTimes(1);
    expect(cleanupUpdater).toHaveBeenCalledTimes(1);
    expect(stopBrowserPool).toHaveBeenCalledTimes(1);
    expect(cleanupViewManager).toHaveBeenCalledTimes(1);
    expect(cleanupWindowManager).toHaveBeenCalledTimes(1);
    expect(closeDuckDB).toHaveBeenCalledTimes(1);
    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('registers app lifecycle and process signal handlers', () => {
    const appRef = {
      on: vi.fn(),
    };
    const runtimeProcess = {
      on: vi.fn(),
    };

    registerAppLifecycleHandlers(appRef, {
      handleActivate: vi.fn(),
      handleWindowAllClosed: vi.fn(),
      handleBeforeQuit: vi.fn(),
    });
    registerProcessSignalHandlers(runtimeProcess, vi.fn());

    expect(appRef.on).toHaveBeenNthCalledWith(1, 'activate', expect.any(Function));
    expect(appRef.on).toHaveBeenNthCalledWith(2, 'window-all-closed', expect.any(Function));
    expect(appRef.on).toHaveBeenNthCalledWith(3, 'before-quit', expect.any(Function));
    expect(runtimeProcess.on).toHaveBeenNthCalledWith(1, 'SIGINT', expect.any(Function));
    expect(runtimeProcess.on).toHaveBeenNthCalledWith(2, 'SIGTERM', expect.any(Function));
  });
});
