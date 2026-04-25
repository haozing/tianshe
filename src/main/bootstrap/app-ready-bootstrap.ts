interface AppReadyBootstrapOptions {
  logStartup: (message: string) => void;
  hideApplicationMenu: () => void;
  initializeServices: () => Promise<void>;
  initializePluginIPC: () => void;
  initializeSchedulerIPC: () => void;
  initializeObservationIPC: () => void;
  initializeHttpApiIPC: () => void;
  initializeOcrPoolIPC: () => void;
  initializePlugins: () => Promise<void>;
  createWindow: () => void;
  setupWindowResizeListener: () => (() => void) | void | null;
  initializeIPC: () => void;
  shouldInitializeUpdater: () => boolean;
  initializeUpdater: () => Promise<void>;
  startResourceMonitoring: () => void;
  initializeBrowserControlApi: () => Promise<void>;
  handleInitializationFailure: (error: unknown) => Promise<void> | void;
  consoleRef?: Pick<Console, 'log' | 'error'>;
}

export async function runAppReadyBootstrap(options: AppReadyBootstrapOptions): Promise<void> {
  const consoleRef = options.consoleRef ?? console;

  try {
    options.hideApplicationMenu();

    options.logStartup('Calling initializeServices()...');
    await options.initializeServices();
    options.logStartup('initializeServices() completed');

    options.logStartup('Registering JS Plugin IPC handlers...');
    options.initializePluginIPC();
    options.logStartup('JS Plugin IPC handlers registered');

    options.logStartup('Registering Scheduler IPC handlers...');
    options.initializeSchedulerIPC();
    options.logStartup('Scheduler IPC handlers registered');

    options.logStartup('Registering Observation IPC handlers...');
    options.initializeObservationIPC();
    options.logStartup('Observation IPC handlers registered');

    options.logStartup('Registering HTTP API IPC handlers...');
    options.initializeHttpApiIPC();
    options.logStartup('HTTP API IPC handlers registered');

    options.logStartup('Registering OCR Pool IPC handlers...');
    options.initializeOcrPoolIPC();
    options.logStartup('OCR Pool IPC handlers registered');

    options.logStartup('Initializing JSPluginManager (loading plugins)...');
    await options.initializePlugins();
    consoleRef.log('[OK] JSPluginManager initialized and plugins loaded');
    options.logStartup('JSPluginManager initialized and plugins loaded');

    options.logStartup('Creating main window...');
    options.createWindow();
    options.logStartup('Main window created');

    const unregisterResizeListener = options.setupWindowResizeListener();
    if (!unregisterResizeListener) {
      consoleRef.error('[ERROR] Failed to setup window size change listener');
    } else {
      consoleRef.log('[OK] Window size change listener registered (supports resize + full-screen)');
    }

    options.initializeIPC();

    if (options.shouldInitializeUpdater()) {
      await options.initializeUpdater();
    } else {
      consoleRef.log('[WARN] Updater disabled in development mode');
    }

    options.startResourceMonitoring();
    await options.initializeBrowserControlApi();

    consoleRef.log('[READY] Application ready!\n');
    options.logStartup('Application ready!');
  } catch (error) {
    await options.handleInitializationFailure(error);
  }
}
