import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRuntimeErrorHandlersForTests,
  createRuntimeErrorHandlers,
  isIgnorableRuntimeError,
  registerRuntimeErrorHandlers,
} from './runtime-error-bootstrap';

function createOptions(overrides: Record<string, unknown> = {}) {
  const logger = {
    error: vi.fn(),
  };
  const duckdbService = {
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
  const runtimeProcess = {
    on: vi.fn(),
  };
  const showErrorBox = vi.fn();
  const exitProcess = vi.fn();
  const logStartup = vi.fn();
  const consoleRef = {
    error: vi.fn(),
    warn: vi.fn(),
  };

  return {
    logger,
    duckdbService,
    mainWindow,
    runtimeProcess,
    showErrorBox,
    exitProcess,
    logStartup,
    consoleRef,
    options: {
      startupLogPath: 'D:/tmp/startup-diagnostic.log',
      logStartup,
      getLogger: () => logger,
      getMainWindow: () => mainWindow,
      getDuckDBService: () => duckdbService,
      runtimeProcess,
      showErrorBox,
      exitProcess,
      consoleRef,
      now: () => 1234567890,
      ...overrides,
    },
  };
}

describe('runtime-error-bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRuntimeErrorHandlersForTests();
  });

  it('registerRuntimeErrorHandlers is idempotent', () => {
    const { runtimeProcess, options } = createOptions();

    registerRuntimeErrorHandlers(options);
    registerRuntimeErrorHandlers(options);

    expect(runtimeProcess.on).toHaveBeenCalledTimes(2);
    expect(runtimeProcess.on).toHaveBeenNthCalledWith(
      1,
      'uncaughtException',
      expect.any(Function)
    );
    expect(runtimeProcess.on).toHaveBeenNthCalledWith(
      2,
      'unhandledRejection',
      expect.any(Function)
    );
  });

  it('critical uncaught exceptions close DuckDB, show dialog, and exit', async () => {
    const { duckdbService, mainWindow, showErrorBox, exitProcess, logStartup, logger, consoleRef, options } =
      createOptions();
    const handlers = createRuntimeErrorHandlers(options);

    await handlers.handleUncaughtException(new Error('SQLITE_CORRUPT: main db is broken'));

    expect(logStartup).toHaveBeenCalledWith('UNCAUGHT EXCEPTION: SQLITE_CORRUPT: main db is broken');
    expect(showErrorBox).toHaveBeenCalledWith(
      'Critical Application Error',
      expect.stringContaining('SQLITE_CORRUPT: main db is broken')
    );
    expect(duckdbService.close).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'system',
      'Critical uncaught exception',
      expect.objectContaining({
        message: 'SQLITE_CORRUPT: main db is broken',
        critical: true,
      })
    );
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    expect(consoleRef.error).toHaveBeenCalled();
  });

  it('non-critical unhandled rejections notify renderer without exiting', async () => {
    const { duckdbService, mainWindow, showErrorBox, exitProcess, logger, consoleRef, options } =
      createOptions();
    const handlers = createRuntimeErrorHandlers(options);

    await handlers.handleUnhandledRejection('temporary network hiccup', Promise.resolve());

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('system:error', {
      type: 'non-critical-rejection',
      message: 'temporary network hiccup',
      timestamp: 1234567890,
    });
    expect(exitProcess).not.toHaveBeenCalled();
    expect(showErrorBox).not.toHaveBeenCalled();
    expect(duckdbService.close).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'system',
      'Unhandled rejection',
      expect.objectContaining({
        reason: 'temporary network hiccup',
        critical: false,
      })
    );
    expect(consoleRef.warn).toHaveBeenCalledWith(
      '[WARN] Application continues running despite non-critical rejection'
    );
  });

  it('ignores broken pipe runtime errors without dialog or renderer noise', async () => {
    const { duckdbService, mainWindow, showErrorBox, exitProcess, logStartup, consoleRef, options } =
      createOptions();
    const handlers = createRuntimeErrorHandlers(options);
    const brokenPipe = new Error('EPIPE: broken pipe, write') as NodeJS.ErrnoException;
    brokenPipe.code = 'EPIPE';

    expect(isIgnorableRuntimeError(brokenPipe)).toBe(true);

    await handlers.handleUncaughtException(brokenPipe);

    expect(logStartup).toHaveBeenCalledWith('IGNORED RUNTIME IO ERROR: EPIPE: broken pipe, write');
    expect(showErrorBox).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(duckdbService.close).not.toHaveBeenCalled();
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    expect(consoleRef.error).not.toHaveBeenCalled();
    expect(consoleRef.warn).not.toHaveBeenCalled();
  });
});
