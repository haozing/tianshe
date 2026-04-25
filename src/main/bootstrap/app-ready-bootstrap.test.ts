import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAppReadyBootstrap } from './app-ready-bootstrap';

describe('app-ready-bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the app ready sequence in the expected order', async () => {
    const steps: string[] = [];
    const log = vi.fn();
    const error = vi.fn();

    await runAppReadyBootstrap({
      logStartup: (message) => steps.push(`startup:${message}`),
      hideApplicationMenu: () => steps.push('hide-menu'),
      initializeServices: async () => {
        steps.push('initialize-services');
      },
      initializePluginIPC: () => steps.push('plugin-ipc'),
      initializeSchedulerIPC: () => steps.push('scheduler-ipc'),
      initializeObservationIPC: () => steps.push('observation-ipc'),
      initializeHttpApiIPC: () => steps.push('http-api-ipc'),
      initializeOcrPoolIPC: () => steps.push('ocr-pool-ipc'),
      initializePlugins: async () => {
        steps.push('initialize-plugins');
      },
      createWindow: () => steps.push('create-window'),
      setupWindowResizeListener: () => {
        steps.push('setup-resize-listener');
        return () => undefined;
      },
      initializeIPC: () => steps.push('initialize-ipc'),
      shouldInitializeUpdater: () => true,
      initializeUpdater: async () => {
        steps.push('initialize-updater');
      },
      startResourceMonitoring: () => steps.push('start-resource-monitoring'),
      initializeBrowserControlApi: async () => {
        steps.push('initialize-browser-control-api');
      },
      handleInitializationFailure: () => steps.push('handle-init-failure'),
      consoleRef: { log, error },
    });

    expect(steps).toEqual([
      'hide-menu',
      'startup:Calling initializeServices()...',
      'initialize-services',
      'startup:initializeServices() completed',
      'startup:Registering JS Plugin IPC handlers...',
      'plugin-ipc',
      'startup:JS Plugin IPC handlers registered',
      'startup:Registering Scheduler IPC handlers...',
      'scheduler-ipc',
      'startup:Scheduler IPC handlers registered',
      'startup:Registering Observation IPC handlers...',
      'observation-ipc',
      'startup:Observation IPC handlers registered',
      'startup:Registering HTTP API IPC handlers...',
      'http-api-ipc',
      'startup:HTTP API IPC handlers registered',
      'startup:Registering OCR Pool IPC handlers...',
      'ocr-pool-ipc',
      'startup:OCR Pool IPC handlers registered',
      'startup:Initializing JSPluginManager (loading plugins)...',
      'initialize-plugins',
      'startup:JSPluginManager initialized and plugins loaded',
      'startup:Creating main window...',
      'create-window',
      'startup:Main window created',
      'setup-resize-listener',
      'initialize-ipc',
      'initialize-updater',
      'start-resource-monitoring',
      'initialize-browser-control-api',
      'startup:Application ready!',
    ]);
    expect(log).toHaveBeenCalledWith('[OK] JSPluginManager initialized and plugins loaded');
    expect(log).toHaveBeenCalledWith(
      '[OK] Window size change listener registered (supports resize + full-screen)'
    );
    expect(log).toHaveBeenCalledWith('[READY] Application ready!\n');
    expect(error).not.toHaveBeenCalled();
  });

  it('delegates initialization failures to the injected handler', async () => {
    const handleInitializationFailure = vi.fn();

    await runAppReadyBootstrap({
      logStartup: vi.fn(),
      hideApplicationMenu: vi.fn(),
      initializeServices: vi.fn().mockRejectedValue(new Error('boom')),
      initializePluginIPC: vi.fn(),
      initializeSchedulerIPC: vi.fn(),
      initializeObservationIPC: vi.fn(),
      initializeHttpApiIPC: vi.fn(),
      initializeOcrPoolIPC: vi.fn(),
      initializePlugins: vi.fn(),
      createWindow: vi.fn(),
      setupWindowResizeListener: vi.fn(),
      initializeIPC: vi.fn(),
      shouldInitializeUpdater: () => false,
      initializeUpdater: vi.fn(),
      startResourceMonitoring: vi.fn(),
      initializeBrowserControlApi: vi.fn(),
      handleInitializationFailure,
      consoleRef: { log: vi.fn(), error: vi.fn() },
    });

    expect(handleInitializationFailure).toHaveBeenCalledWith(expect.any(Error));
  });
});
