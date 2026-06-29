import { dialog } from 'electron';
import type { LogStorageService } from '../log-storage-service';
import type { DuckDBService } from '../duckdb/service';

type ProcessEvent = 'uncaughtException' | 'unhandledRejection';

interface RuntimeProcessLike {
  on(event: ProcessEvent, listener: (...args: any[]) => void | Promise<void>): void;
}

interface MainWindowLike {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
}

interface LoggerLike {
  error(taskId: string, message: string, data?: unknown, stepIndex?: number): void;
}

interface DuckDBServiceLike {
  close(): Promise<void>;
}

export interface RuntimeErrorBootstrapOptions {
  startupLogPath: string;
  logStartup: (message: string) => void;
  getLogger: () => Pick<LogStorageService, 'error'> | LoggerLike | null | undefined;
  getMainWindow: () => MainWindowLike | null | undefined;
  getDuckDBService: () => Pick<DuckDBService, 'close'> | DuckDBServiceLike | null | undefined;
  runtimeProcess?: RuntimeProcessLike;
  showErrorBox?: (title: string, content: string) => void;
  exitProcess?: (code: number) => never | void;
  consoleRef?: Pick<Console, 'error' | 'warn'>;
  now?: () => number;
}

export interface RuntimeErrorHandlers {
  handleUncaughtException: (error: unknown) => Promise<void>;
  handleUnhandledRejection: (reason: unknown, promise: Promise<unknown>) => Promise<void>;
}

let handlersRegistered = false;

export function isIgnorableRuntimeError(error: Error): boolean {
  const record = error as NodeJS.ErrnoException;
  const message = String(error.message || '').toLowerCase();
  return (
    record.code === 'EPIPE' ||
    record.code === 'ERR_STREAM_DESTROYED' ||
    message.includes('broken pipe') ||
    message.includes('stream destroyed')
  );
}

export function isCriticalRuntimeError(error: Error): boolean {
  const criticalPatterns = [
    /ENOSPC/i,
    /SQLITE_CANTOPEN/i,
    /SQLITE_CORRUPT/i,
    /Cannot find module/i,
    /port.*already in use/i,
  ];

  return criticalPatterns.some(
    (pattern) => pattern.test(error.message) || pattern.test(error.stack || '')
  );
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function notifyRenderer(
  options: RuntimeErrorBootstrapOptions,
  type: 'non-critical' | 'non-critical-rejection',
  message: string
): void {
  const mainWindow = options.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    mainWindow.webContents.send('system:error', {
      type,
      message,
      timestamp: options.now?.() ?? Date.now(),
    });
  } catch (notifyError) {
    options.consoleRef?.error?.('[ERROR] Failed to notify renderer about runtime error:', notifyError);
    options.logStartup(
      `RUNTIME ERROR NOTIFY FAILED: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`
    );
  }
}

async function tryCloseDuckDB(options: RuntimeErrorBootstrapOptions): Promise<void> {
  const duckdbService = options.getDuckDBService();
  if (!duckdbService) {
    return;
  }

  try {
    await duckdbService.close();
  } catch (cleanupError) {
    options.consoleRef?.error?.('[ERROR] Cleanup failed during runtime error handling:', cleanupError);
    options.logStartup(
      `RUNTIME ERROR CLEANUP FAILED: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`
    );
  }
}

function logRuntimeError(
  options: RuntimeErrorBootstrapOptions,
  message: string,
  data: Record<string, unknown>
): void {
  options.getLogger()?.error('system', message, data);
}

function showCriticalErrorDialog(
  options: RuntimeErrorBootstrapOptions,
  title: string,
  body: string
): void {
  try {
    (options.showErrorBox ?? dialog.showErrorBox)(title, body);
  } catch (dialogError) {
    options.consoleRef?.error?.('[ERROR] Failed to show runtime error dialog:', dialogError);
    options.logStartup(
      `RUNTIME ERROR DIALOG FAILED: ${dialogError instanceof Error ? dialogError.message : String(dialogError)}`
    );
  }
}

export function createRuntimeErrorHandlers(
  options: RuntimeErrorBootstrapOptions
): RuntimeErrorHandlers {
  const consoleRef = options.consoleRef ?? console;
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));

  return {
    handleUncaughtException: async (errorValue: unknown) => {
      const error = toError(errorValue);
      if (isIgnorableRuntimeError(error)) {
        options.logStartup(`IGNORED RUNTIME IO ERROR: ${error.message}`);
        return;
      }
      const isCritical = isCriticalRuntimeError(error);

      options.logStartup(`UNCAUGHT EXCEPTION: ${error.message}`);
      options.logStartup(`Stack: ${error.stack}`);

      consoleRef.error(
        isCritical ? '[CRITICAL] CRITICAL uncaught exception:' : '[WARN] Uncaught exception:',
        error
      );

      logRuntimeError(options, isCritical ? 'Critical uncaught exception' : 'Uncaught exception', {
        message: error.message,
        stack: error.stack,
        critical: isCritical,
      });

      if (!isCritical) {
        consoleRef.warn('[WARN] Application continues running despite non-critical error');
        notifyRenderer(options, 'non-critical', error.message);
        return;
      }

      showCriticalErrorDialog(
        options,
        'Critical Application Error',
        `A critical error occurred:\n\n${error.message}\n\nThe application will now exit.\n\nCheck log at:\n${options.startupLogPath}`
      );

      await tryCloseDuckDB(options);
      exitProcess(1);
    },

    handleUnhandledRejection: async (reason: unknown, promise: Promise<unknown>) => {
      const error = toError(reason);
      if (isIgnorableRuntimeError(error)) {
        options.logStartup(`IGNORED RUNTIME IO REJECTION: ${error.message}`);
        return;
      }
      const isCritical = isCriticalRuntimeError(error);

      options.logStartup(`UNHANDLED REJECTION: ${String(reason)}`);
      if (error.stack) {
        options.logStartup(`Stack: ${error.stack}`);
      }

      consoleRef.error(
        isCritical ? '[CRITICAL] CRITICAL unhandled rejection:' : '[WARN] Unhandled rejection:',
        promise,
        'reason:',
        reason
      );

      logRuntimeError(
        options,
        isCritical ? 'Critical unhandled rejection' : 'Unhandled rejection',
        {
          reason: String(reason),
          promise: String(promise),
          critical: isCritical,
        }
      );

      if (!isCritical) {
        consoleRef.warn('[WARN] Application continues running despite non-critical rejection');
        notifyRenderer(options, 'non-critical-rejection', String(reason));
        return;
      }

      showCriticalErrorDialog(
        options,
        'Critical Application Error',
        `A critical promise rejection occurred:\n\n${String(reason)}\n\nThe application will now exit.\n\nCheck log at:\n${options.startupLogPath}`
      );

      await tryCloseDuckDB(options);
      exitProcess(1);
    },
  };
}

export function registerRuntimeErrorHandlers(options: RuntimeErrorBootstrapOptions): void {
  if (handlersRegistered) {
    return;
  }

  const runtimeProcess = options.runtimeProcess ?? process;
  const handlers = createRuntimeErrorHandlers(options);

  runtimeProcess.on('uncaughtException', handlers.handleUncaughtException);
  runtimeProcess.on('unhandledRejection', handlers.handleUnhandledRejection);
  handlersRegistered = true;
}

export function __resetRuntimeErrorHandlersForTests(): void {
  handlersRegistered = false;
}
