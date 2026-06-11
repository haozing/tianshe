import { getUnknownErrorMessage } from '../../utils/error-message';

export type AppReadyBootstrapStage =
  | 'hideApplicationMenu'
  | 'initializeServices'
  | 'initializePluginIPC'
  | 'initializeSchedulerIPC'
  | 'initializeObservationIPC'
  | 'initializeHttpApiIPC'
  | 'initializeOcrPoolIPC'
  | 'initializePlugins'
  | 'createWindow'
  | 'setupWindowResizeListener'
  | 'initializeIPC'
  | 'shouldInitializeUpdater'
  | 'initializeUpdater'
  | 'startResourceMonitoring'
  | 'initializeBrowserControlApi';

export type AppReadyBootstrapStageTimeouts = Partial<Record<AppReadyBootstrapStage, number>> & {
  default?: number;
};

export const DEFAULT_APP_READY_STAGE_TIMEOUT_MS = 120_000;

export class AppReadyBootstrapStageError extends Error {
  readonly stage: AppReadyBootstrapStage;
  readonly cause: unknown;

  constructor(stage: AppReadyBootstrapStage, cause: unknown) {
    super(`Bootstrap stage "${stage}" failed: ${getUnknownErrorMessage(cause)}`);
    this.name = 'AppReadyBootstrapStageError';
    this.stage = stage;
    this.cause = cause;
  }
}

export class AppReadyBootstrapStageTimeoutError extends Error {
  readonly stage: AppReadyBootstrapStage;
  readonly timeoutMs: number;

  constructor(stage: AppReadyBootstrapStage, timeoutMs: number) {
    super(`Bootstrap stage "${stage}" timed out after ${timeoutMs}ms`);
    this.name = 'AppReadyBootstrapStageTimeoutError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export interface AppReadyBootstrapStageContext {
  signal: AbortSignal;
}

export interface AppReadyBootstrapOptions {
  logStartup: (message: string) => void;
  hideApplicationMenu: () => void;
  initializeServices: (context?: AppReadyBootstrapStageContext) => Promise<void>;
  initializePluginIPC: (context?: AppReadyBootstrapStageContext) => void;
  initializeSchedulerIPC: (context?: AppReadyBootstrapStageContext) => void;
  initializeObservationIPC: (context?: AppReadyBootstrapStageContext) => void;
  initializeHttpApiIPC: (context?: AppReadyBootstrapStageContext) => void;
  initializeOcrPoolIPC: (context?: AppReadyBootstrapStageContext) => void;
  initializePlugins: (context?: AppReadyBootstrapStageContext) => Promise<void>;
  createWindow: (context?: AppReadyBootstrapStageContext) => void;
  setupWindowResizeListener: (
    context?: AppReadyBootstrapStageContext
  ) => (() => void) | void | null;
  initializeIPC: (context?: AppReadyBootstrapStageContext) => void;
  shouldInitializeUpdater: (context?: AppReadyBootstrapStageContext) => boolean;
  initializeUpdater: (context?: AppReadyBootstrapStageContext) => Promise<void>;
  startResourceMonitoring: (context?: AppReadyBootstrapStageContext) => void;
  initializeBrowserControlApi: (context?: AppReadyBootstrapStageContext) => Promise<void>;
  handleInitializationFailure: (error: unknown) => Promise<void> | void;
  consoleRef?: Pick<Console, 'log' | 'error'>;
  stageTimeoutMs?: number | AppReadyBootstrapStageTimeouts;
  lateStageDrainTimeoutMs?: number;
}

const DEFAULT_LATE_STAGE_DRAIN_TIMEOUT_MS = 1_500;

function resolveStageTimeoutMs(
  stage: AppReadyBootstrapStage,
  configured?: number | AppReadyBootstrapStageTimeouts
): number {
  if (typeof configured === 'number') {
    return configured;
  }

  return configured?.[stage] ?? configured?.default ?? DEFAULT_APP_READY_STAGE_TIMEOUT_MS;
}

async function runBootstrapStage<T>(
  stage: AppReadyBootstrapStage,
  action: (context: AppReadyBootstrapStageContext) => T | Promise<T>,
  timeoutMs: number,
  lateStageDrainTimeoutMs: number,
  logStartup: (message: string) => void
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const actionPromise = Promise.resolve().then(() => action({ signal: controller.signal }));
  const shouldUseTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  try {
    if (!shouldUseTimeout) {
      return await actionPromise;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort(new AppReadyBootstrapStageTimeoutError(stage, timeoutMs));
        reject(new AppReadyBootstrapStageTimeoutError(stage, timeoutMs));
      }, timeoutMs);
    });

    return await Promise.race([actionPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof AppReadyBootstrapStageTimeoutError) {
      let drained = false;
      await Promise.race([
        actionPromise
          .then(() => {
            drained = true;
          })
          .catch(() => {
            drained = true;
          }),
        new Promise<void>((resolve) => {
          drainTimeoutId = setTimeout(resolve, lateStageDrainTimeoutMs);
        }),
      ]);
      if (!drained) {
        logStartup(
          `Bootstrap stage ${stage} still running after timeout drain budget (${lateStageDrainTimeoutMs}ms); continuing failure handling with startup marked failed`
        );
      }
    }

    if (
      error instanceof AppReadyBootstrapStageError ||
      error instanceof AppReadyBootstrapStageTimeoutError
    ) {
      throw error;
    }

    throw new AppReadyBootstrapStageError(stage, error);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (drainTimeoutId) {
      clearTimeout(drainTimeoutId);
    }
  }
}

export async function runAppReadyBootstrap(options: AppReadyBootstrapOptions): Promise<void> {
  const consoleRef = options.consoleRef ?? console;
  const lateStageDrainTimeoutMs =
    options.lateStageDrainTimeoutMs ?? DEFAULT_LATE_STAGE_DRAIN_TIMEOUT_MS;
  const runStage = <T>(
    stage: AppReadyBootstrapStage,
    action: (context: AppReadyBootstrapStageContext) => T | Promise<T>
  ) =>
    runBootstrapStage(
      stage,
      action,
      resolveStageTimeoutMs(stage, options.stageTimeoutMs),
      lateStageDrainTimeoutMs,
      options.logStartup
    );

  try {
    await runStage('hideApplicationMenu', options.hideApplicationMenu);

    options.logStartup('Calling initializeServices()...');
    await runStage('initializeServices', options.initializeServices);
    options.logStartup('initializeServices() completed');

    options.logStartup('Registering JS Plugin IPC handlers...');
    await runStage('initializePluginIPC', options.initializePluginIPC);
    options.logStartup('JS Plugin IPC handlers registered');

    options.logStartup('Registering Scheduler IPC handlers...');
    await runStage('initializeSchedulerIPC', options.initializeSchedulerIPC);
    options.logStartup('Scheduler IPC handlers registered');

    options.logStartup('Registering Observation IPC handlers...');
    await runStage('initializeObservationIPC', options.initializeObservationIPC);
    options.logStartup('Observation IPC handlers registered');

    options.logStartup('Registering HTTP API IPC handlers...');
    await runStage('initializeHttpApiIPC', options.initializeHttpApiIPC);
    options.logStartup('HTTP API IPC handlers registered');

    options.logStartup('Registering OCR Pool IPC handlers...');
    await runStage('initializeOcrPoolIPC', options.initializeOcrPoolIPC);
    options.logStartup('OCR Pool IPC handlers registered');

    options.logStartup('Initializing JSPluginManager (loading plugins)...');
    await runStage('initializePlugins', options.initializePlugins);
    consoleRef.log('[OK] JSPluginManager initialized and plugins loaded');
    options.logStartup('JSPluginManager initialized and plugins loaded');

    options.logStartup('Creating main window...');
    await runStage('createWindow', options.createWindow);
    options.logStartup('Main window created');

    const unregisterResizeListener = await runStage(
      'setupWindowResizeListener',
      options.setupWindowResizeListener
    );
    if (!unregisterResizeListener) {
      consoleRef.error('[ERROR] Failed to setup window size change listener');
    } else {
      consoleRef.log('[OK] Window size change listener registered (supports resize + full-screen)');
    }

    await runStage('initializeIPC', options.initializeIPC);

    if (await runStage('shouldInitializeUpdater', options.shouldInitializeUpdater)) {
      await runStage('initializeUpdater', options.initializeUpdater);
    } else {
      consoleRef.log('[WARN] Updater disabled in development mode');
    }

    await runStage('startResourceMonitoring', options.startResourceMonitoring);
    await runStage('initializeBrowserControlApi', options.initializeBrowserControlApi);

    consoleRef.log('[READY] Application ready!\n');
    options.logStartup('Application ready!');
  } catch (error) {
    await options.handleInitializationFailure(error);
  }
}
