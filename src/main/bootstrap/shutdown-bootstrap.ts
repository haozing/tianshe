interface ShutdownBootstrapOptions {
  stopHttpServer: () => Promise<void>;
  disposeScheduler: () => Promise<void>;
  cleanupUpdater: () => void;
  stopBrowserPool: () => Promise<void>;
  cleanupViewManager: () => Promise<void>;
  cleanupWindowManager: () => void;
  closeDuckDB: () => Promise<void>;
  exitApp: (code: number) => void;
  exitProcess: (code: number) => void;
  quitApp: () => void;
  getWindowCount: () => number;
  createWindow: () => void;
  platform?: string;
  consoleRef?: Pick<Console, 'log' | 'error'>;
}

interface BeforeQuitEventLike {
  preventDefault: () => void;
}

export function createShutdownBootstrap(options: ShutdownBootstrapOptions) {
  const consoleRef = options.consoleRef ?? console;
  let cleanupPromise: Promise<number> | null = null;
  let finalized = false;

  const performCleanup = async () => {
    consoleRef.log('\n[CLEANUP] Cleaning up...');

    try {
      await options.stopHttpServer();
      await options.disposeScheduler();
      options.cleanupUpdater();
      await options.stopBrowserPool();
      await options.cleanupViewManager();
      options.cleanupWindowManager();
      await options.closeDuckDB();

      consoleRef.log('[OK] Cleanup completed');
      return 0;
    } catch (error) {
      consoleRef.error('[ERROR] Cleanup failed:', error);
      return 1;
    }
  };

  const finalize = (exitFn: (code: number) => void, code: number) => {
    if (finalized) {
      return;
    }
    finalized = true;
    exitFn(code);
  };

  const shutdown = () => {
    if (!cleanupPromise) {
      cleanupPromise = performCleanup();
    }
    return cleanupPromise;
  };

  return {
    async handleBeforeQuit(event: BeforeQuitEventLike) {
      event.preventDefault();
      const code = await shutdown();
      finalize(options.exitApp, code);
    },

    async handleProcessSignal(signal: string) {
      consoleRef.log(`\n[WARN] Received ${signal}, performing cleanup...`);
      const code = await shutdown();
      finalize(options.exitProcess, code);
    },

    handleWindowAllClosed() {
      if ((options.platform ?? process.platform) !== 'darwin') {
        options.quitApp();
      }
    },

    handleActivate() {
      if (options.getWindowCount() === 0) {
        options.createWindow();
      }
    },

    shutdown,
  };
}

export function registerAppLifecycleHandlers(
  appRef: { on: (...args: any[]) => unknown },
  handlers: {
    handleActivate: () => void;
    handleWindowAllClosed: () => void;
    handleBeforeQuit: (event: BeforeQuitEventLike) => Promise<void>;
  }
): void {
  appRef.on('activate', handlers.handleActivate);
  appRef.on('window-all-closed', handlers.handleWindowAllClosed);
  appRef.on('before-quit', (event: unknown) => {
    void handlers.handleBeforeQuit(event as BeforeQuitEventLike);
  });
}

export function registerProcessSignalHandlers(
  runtimeProcess: { on: (...args: any[]) => unknown },
  handleProcessSignal: (signal: string) => Promise<void>
): void {
  runtimeProcess.on('SIGINT', () => {
    void handleProcessSignal('SIGINT');
  });
  runtimeProcess.on('SIGTERM', () => {
    void handleProcessSignal('SIGTERM');
  });
}
