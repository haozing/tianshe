/**
 * Electron 主进程入口
 * 负责：
 * - 初始化所有服务
 * - 创建主窗口
 * - 生命周期管理
 */

import { installStdioBrokenPipeGuards } from './bootstrap/stdio-bootstrap';
import { app, BrowserWindow, Menu, dialog } from 'electron';
import { AIRPA_RUNTIME_CONFIG, isProductionMode } from '../constants/runtime-config';
import { configureChromiumCommandLine } from './bootstrap/chromium-command-line';
import { runAppReadyBootstrap } from './bootstrap/app-ready-bootstrap';
import { initializeMainServices } from './bootstrap/main-service-composition';
import { registerRuntimeErrorHandlers } from './bootstrap/runtime-error-bootstrap';
import { createStartupDiagnosticLog } from './bootstrap/startup-diagnostic-log';
import {
  createShutdownBootstrap,
  registerAppLifecycleHandlers,
  registerProcessSignalHandlers,
} from './bootstrap/shutdown-bootstrap';

const configuredUserDataDir = AIRPA_RUNTIME_CONFIG.paths.userDataDirOverride.trim();
if (configuredUserDataDir.length > 0) {
  app.setPath('userData', configuredUserDataDir);
}

installStdioBrokenPipeGuards();
configureChromiumCommandLine(app, { e2eCdpPort: AIRPA_RUNTIME_CONFIG.e2e.cdpPort });

const { startupLogPath, logStartup } = createStartupDiagnosticLog(app);

import { getPluginRegistry } from '../core/js-plugin/registry';

// 主进程模块
import { IPCHandler } from './ipc';
import { JSPluginIPCHandler } from './ipc-handlers/js-plugin-handler';
import { UpdateManager } from './updater';
import { registerUpdaterHandlers } from './ipc-handlers/updater-handler';
import { SchedulerIPCHandler } from './ipc-handlers/scheduler-handler';
import { registerObservationHandlers } from './ipc-handlers/observation-handler';
import { HttpApiIPCHandler } from './ipc-handlers/http-api-handler';
import type { IpcSenderGuard } from './ipc-handlers/utils';
import { createMainWindowIpcSenderGuard } from './ipc-authorization';
import { OCRPoolIPCHandler } from './ipc-handlers/ocr-pool-handler';
import { probeLocalHttpRuntime } from './http-runtime-diagnostics';
import { AppRuntime } from './app-runtime';

// AI-Dev 浏览器控制 API（HTTP MCP 服务器）
import { createHttpMcpServer } from './mcp-server-http';
import {
  buildRestApiDependencies,
  type BuildRestApiDependenciesRuntime,
} from './http-server-composition';

// 浏览器池管理
import { stopBrowserPool, getBrowserPoolManager } from '../core/browser-pool';
import { createLogger } from '../core/logger';
import { fingerprintManager } from '../core/stealth';

// HTTP API 配置和类型
import {
  DEFAULT_HTTP_API_CONFIG,
  HTTP_SERVER_DEFAULTS,
  normalizeHttpApiConfig,
  resolveEffectiveHttpApiConfig,
} from '../constants/http-api';
import type { RestApiConfig } from '../types/http-api';
import { resolveTiansheEdition } from '../edition';
import { redactSensitiveUrl } from '../utils/redaction';

const tiansheEdition = resolveTiansheEdition();
const appRuntime = new AppRuntime();
const logger = createLogger('MainProcess');

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const assertPrimaryRendererSender: IpcSenderGuard = createMainWindowIpcSenderGuard(
  () => appRuntime.mainWindow
);

registerRuntimeErrorHandlers({
  startupLogPath,
  logStartup,
  getLogger: () => appRuntime.logger,
  getMainWindow: () => appRuntime.mainWindow,
  getDuckDBService: () => appRuntime.duckdbService,
});

/**
 * 创建主窗口（使用 WindowManager）
 */
function createWindow(): void {
  appRuntime.mainWindow = appRuntime.requireWindowManager().createMainWindow();
}

function hideApplicationMenu(): void {
  Menu.setApplicationMenu(null);
}

/**
 * 初始化所有服务
 */
async function initializeServices(): Promise<void> {
  await initializeMainServices({
    app,
    appRuntime,
    tiansheEdition,
    assertPrimaryRendererSender,
    logStartup,
  });
}

/**
 * 初始化 JS Plugin IPC 处理器（需要在加载插件之前调用）
 */
function initializePluginIPC(): void {
  const jsPluginIPCHandler = new JSPluginIPCHandler(
    appRuntime.requireJSPluginManager(),
    appRuntime.requireDuckDBService(),
    appRuntime.requireViewManager(),
    appRuntime.requireWindowManager(),
    tiansheEdition.cloudCatalog.runtimePlugin
  );
  jsPluginIPCHandler.register();

  logger.info('JS Plugin IPC handlers registered');
}

/**
 * 初始化 Scheduler IPC 处理器
 */
function initializeSchedulerIPC(): void {
  const schedulerIPCHandler = new SchedulerIPCHandler(appRuntime.requireSchedulerService());
  schedulerIPCHandler.register();

  logger.info('Scheduler IPC handlers registered');
}

/**
 * 初始化 Observation IPC 处理器
 */
function initializeObservationIPC(): void {
  registerObservationHandlers(appRuntime.requireDuckDBService());

  logger.info('Observation IPC handlers registered');
}

/**
 * 初始化 HTTP API IPC 处理器
 */
function initializeHttpApiIPC(): void {
  const httpApiIPCHandler = new HttpApiIPCHandler(
    appRuntime.requireStore(),
    appRuntime.requireWebhookSender(),
    startHttpServer,
    stopHttpServer,
    assertPrimaryRendererSender
  );
  httpApiIPCHandler.register();

  logger.info('HTTP API IPC handlers registered');
}

/**
 * 初始化 OCR Pool IPC 处理器
 */
function initializeOcrPoolIPC(): void {
  const ocrPoolIPCHandler = new OCRPoolIPCHandler(appRuntime.requireStore());
  ocrPoolIPCHandler.register();

  logger.info('OCR Pool IPC handlers registered');
}

/**
 * 初始化主 IPC 处理器
 */
function initializeIPC(): void {
  if (!appRuntime.mainWindow) {
    throw new Error('Main window not created');
  }

  appRuntime.ipcHandler = new IPCHandler(
    appRuntime.requireLogger(),
    appRuntime.requireDownloadManager(),
    appRuntime.requireDuckDBService(),
    appRuntime.mainWindow,
    appRuntime.requireWindowManager(),
    appRuntime.requireViewManager()
  );

  logger.info('IPC handlers initialized');
}

/**
 * 初始化软件更新管理器（仅生产环境）
 */
async function initializeUpdater(): Promise<void> {
  if (!appRuntime.mainWindow) {
    logger.warn('Main window not created, skipping updater initialization');
    return;
  }

  try {
    appRuntime.updateManager = new UpdateManager(appRuntime.requireLogger(), appRuntime.mainWindow);
    const updateManager = appRuntime.updateManager;

    // 注册更新相关的 IPC 处理器
    registerUpdaterHandlers(updateManager);

    if (!updateManager.isUpdateConfigured()) {
      logger.warn('Update config not found, skipping automatic update checks');
      return;
    }

    // 延迟10秒后首次检查更新（避免影响启动速度）
    setTimeout(() => {
      logger.info('Running first update check');
      updateManager.checkForUpdates().catch((error) => {
        logger.error('First update check failed', {
          errorMessage: getErrorMessage(error),
          error,
        });
      });

      // 启动定时检查（每4小时）
      updateManager.startPeriodicCheck(4 * 60 * 60 * 1000);
    }, 10000);

    logger.info('UpdateManager initialized');
  } catch (error: unknown) {
    logger.error('Failed to initialize UpdateManager', {
      errorMessage: getErrorMessage(error),
      error,
    });
  }
}

/**
 * 🆕 启动资源监控（内存泄漏检测）
 * 每分钟检查一次资源使用情况
 */
function startResourceMonitoring(): () => void {
  const viewManager = appRuntime.requireViewManager();

  // 定期检查资源统计
  const intervalId = setInterval(() => {
    const stats = viewManager.getResourceStats();
    const memUsage = process.memoryUsage();

    // 记录内存使用情况
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);

    logger.info('Resource monitor snapshot', {
      viewsCreated: stats.created,
      viewsDestroyed: stats.destroyed,
      viewsActive: stats.active,
      viewsFailed: stats.failed,
      heapUsedMB,
      heapTotalMB,
      rssMB,
    });

    // 检测潜在的内存泄漏
    if (stats.leakRisk > 5) {
      logger.warn('Memory leak risk detected in view resources', {
        leakRisk: stats.leakRisk,
        suggestion: 'Investigate view lifecycle or call force GC',
      });
    }

    // 如果堆内存使用超过 80%，建议 GC
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    if (heapUsagePercent > 80) {
      logger.warn('High heap usage detected', {
        heapUsagePercent: Math.round(heapUsagePercent),
      });
      if (global.gc) {
        logger.info('Triggering garbage collection after high heap usage');
        global.gc();
      }
    }
  }, 60000); // 每60秒检查一次

  logger.info('Resource monitoring started', { intervalMs: 60000 });

  return () => {
    clearInterval(intervalId);
    logger.info('Resource monitoring stopped');
  };
}

/**
 * 启动 HTTP 服务器（MCP + REST API）
 */
async function startHttpServer(): Promise<void> {
  // 如果启动正在进行中，直接等待而不是重新启动
  if (appRuntime.httpServerStartPromise) {
    logger.info('HTTP server start already in progress, waiting');
    return appRuntime.httpServerStartPromise;
  }

  // 如果服务器已经在运行，先停止
  if (appRuntime.httpMcpServer) {
    await stopHttpServer();
  }

  const store = appRuntime.requireStore();
  const webhookSender = appRuntime.requireWebhookSender();
  const duckdbService = appRuntime.requireDuckDBService();
  const jsPluginManager = appRuntime.requireJSPluginManager();
  const viewManager = appRuntime.requireViewManager();
  const windowManager = appRuntime.requireWindowManager();

  // 创建启动 Promise 并保存引用（带超时保护）
  const HTTP_SERVER_START_TIMEOUT_MS = 30000;
  let startTimedOut = false;

  const startTask = (async () => {
    try {
      logger.info('Starting HTTP server (MCP + REST API)');

      // 读取 HTTP API 配置
      const storedHttpApiConfig = normalizeHttpApiConfig(
        store.get('httpApiConfig', DEFAULT_HTTP_API_CONFIG) as Partial<
          typeof DEFAULT_HTTP_API_CONFIG
        >
      );
      store.set('httpApiConfig', storedHttpApiConfig);
      const httpApiConfig = resolveEffectiveHttpApiConfig(storedHttpApiConfig);

      if (!httpApiConfig.enabled) {
        logger.info('HTTP server start skipped because effective config is disabled');
        appRuntime.httpMcpServer = null;
        return;
      }

      // 配置 WebhookSender 回调 URL
      if (httpApiConfig.callbackUrl) {
        try {
          webhookSender.setCallbackUrl(httpApiConfig.callbackUrl);
          logger.info('Webhook callback URL configured', {
            callbackUrl: redactSensitiveUrl(httpApiConfig.callbackUrl),
          });
        } catch (error) {
          const message = getErrorMessage(error);
          webhookSender.setCallbackUrl(undefined);
          logger.warn('Ignoring invalid webhook callback URL', { errorMessage: message });
        }
      }

      // 准备依赖项和配置
      const runtime: BuildRestApiDependenciesRuntime = {
        duckdbService,
        jsPluginManager,
        viewManager,
        windowManager,
        fingerprintManager,
        browserRuntimeManager: appRuntime.requireBrowserRuntimeManager(),
        getBrowserPoolManager,
        getPluginRegistry,
        cloudRuntimePluginProvider: tiansheEdition.cloudCatalog.runtimePlugin,
      };

      const dependencies = buildRestApiDependencies({ runtime, httpApiConfig });

      const restApiConfig: RestApiConfig = {
        enableAuth: httpApiConfig.enableAuth,
        token: httpApiConfig.token,
        enableMcp: httpApiConfig.enableMcp, // 传递 MCP 开关配置
        mcpRequireAuth: httpApiConfig.mcpRequireAuth,
        mcpAllowedOrigins: httpApiConfig.mcpAllowedOrigins,
        enforceOrchestrationScopes: httpApiConfig.enforceOrchestrationScopes,
        agentHandMode: httpApiConfig.agentHandMode,
        orchestrationIdempotencyStore: httpApiConfig.orchestrationIdempotencyStore,
      };

      const mcpPort = HTTP_SERVER_DEFAULTS.PORT;
      const mcpHost = HTTP_SERVER_DEFAULTS.BIND_ADDRESS;

      // 启动 HTTP 服务器（固定端口策略）
      const startedServer = await createHttpMcpServer(
        {
          port: mcpPort,
          name: 'airpa-browser-http',
          version: '1.0.0',
        },
        dependencies,
        restApiConfig,
        getBrowserPoolManager,
        () => appRuntime.browserPoolReadiness.getSnapshot()
      );

      if (startTimedOut) {
        logger.warn('HTTP server started after timeout; stopping late server', {
          port: mcpPort,
        });
        await startedServer.stop().catch((stopError) => {
          logger.error('Failed to stop late HTTP server', { error: stopError });
        });
        return;
      }

      appRuntime.httpMcpServer = startedServer;

      logger.info('HTTP server started', { port: mcpPort, host: mcpHost });
      // MCP 端点（仅在启用时显示）
      if (httpApiConfig.enableMcp) {
        const mcpBaseUrl = `http://${mcpHost}:${mcpPort}/mcp`;
        logger.info('MCP endpoint enabled', {
          transport: 'http',
          url: mcpBaseUrl,
          note: 'use session_prepare to bind profile, runtimeId, visibility, and scopes',
        });
      } else {
        logger.info('MCP endpoint disabled');
      }
      logger.info('REST orchestration API endpoints ready', {
        capabilitiesUrl: `http://${mcpHost}:${mcpPort}${HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX}/capabilities`,
        sessionCreateUrl: `http://${mcpHost}:${mcpPort}${HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX}/sessions`,
        invokeUrl: `http://${mcpHost}:${mcpPort}${HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX}/invoke`,
        healthUrl: `http://${mcpHost}:${mcpPort}/health`,
      });
      if (httpApiConfig.enableAuth) {
        logger.info('HTTP API token authentication enabled');
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error('HTTP server failed to start', { errorMessage, error });
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === 'EADDRINUSE'
      ) {
        try {
          const runtime = await probeLocalHttpRuntime({
            port: HTTP_SERVER_DEFAULTS.PORT,
          });
          logger.error('HTTP runtime diagnosis', {
            summary: runtime.diagnosis.summary,
            port: HTTP_SERVER_DEFAULTS.PORT,
          });
          if (runtime.diagnosis.detail) {
            logger.error('HTTP runtime diagnosis detail', {
              detail: runtime.diagnosis.detail,
              port: HTTP_SERVER_DEFAULTS.PORT,
            });
          }
          if (runtime.diagnosis.suggestedAction) {
            logger.error('HTTP runtime diagnosis suggested action', {
              suggestedAction: runtime.diagnosis.suggestedAction,
              port: HTTP_SERVER_DEFAULTS.PORT,
            });
          }
        } catch (diagnosticError) {
          logger.error('Failed to inspect occupied HTTP port', {
            port: HTTP_SERVER_DEFAULTS.PORT,
            errorMessage: getErrorMessage(diagnosticError),
            error: diagnosticError,
          });
        }
      }
      if (error && typeof error === 'object' && (error as { code?: string }).code === 'EACCES') {
        logger.error('HTTP server port permission denied', {
          port: HTTP_SERVER_DEFAULTS.PORT,
          suggestion: 'Check local port policy or occupation',
        });
      }
      logger.error('HTTP server startup failed; check port usage or full error log');
      throw error;
    }
  })();

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutTask = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      startTimedOut = true;
      reject(new Error(`HTTP server start timed out after ${HTTP_SERVER_START_TIMEOUT_MS}ms`));
    }, HTTP_SERVER_START_TIMEOUT_MS);
  });

  const guardedStartPromise = Promise.race([startTask, timeoutTask]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (appRuntime.httpServerStartPromise === guardedStartPromise) {
      appRuntime.httpServerStartPromise = null;
    }
  });

  appRuntime.httpServerStartPromise = guardedStartPromise;

  return appRuntime.httpServerStartPromise;
}

/**
 * 停止 HTTP 服务器
 */
async function stopHttpServer(): Promise<void> {
  const httpMcpServer = appRuntime.httpMcpServer;

  if (!httpMcpServer) {
    logger.info('HTTP server is not running');
    return;
  }

  try {
    logger.info('Stopping HTTP server');
    await httpMcpServer.stop();
    appRuntime.httpMcpServer = null;
    logger.info('HTTP server stopped');
  } catch (error) {
    logger.error('Failed to stop HTTP server', {
      errorMessage: getErrorMessage(error),
      error,
    });
    throw error;
  }
}

/**
 * 🆕 初始化浏览器控制 API（HTTP MCP 服务器）
 *
 * 从设置中读取配置，决定是否启动服务器
 */
async function initializeBrowserControlApi(): Promise<void> {
  // 从配置读取是否启用
  const httpApiConfig = resolveEffectiveHttpApiConfig(
    appRuntime.requireStore().get('httpApiConfig', DEFAULT_HTTP_API_CONFIG) as Partial<
      typeof DEFAULT_HTTP_API_CONFIG
    >
  );

  if (!httpApiConfig.enabled) {
    logger.info('HTTP server disabled in settings', {
      suggestion: 'Enable it in Settings > HTTP API',
    });
    return;
  }

  await startHttpServer();
}

async function handleInitializationFailure(error: unknown): Promise<void> {
  const err = error as Error;
  logger.error('Failed to initialize application', { error });
  logStartup(`INITIALIZATION ERROR: ${err.message}`);
  logStartup(`Stack: ${err.stack}`);
  dialog.showErrorBox(
    'Initialization Failed',
    `Failed to start application:\n\n${err.message}\n\nCheck log at:\n${startupLogPath}`
  );
  app.quit();
}

const shutdownBootstrap = createShutdownBootstrap({
  stopHttpServer,
  disposeResourceMonitoring: () => {
    appRuntime.disposeResourceMonitoring?.();
  },
  disposeScheduler: async () => {
    if (appRuntime.schedulerService) {
      await appRuntime.schedulerService.dispose();
    }
  },
  cleanupUpdater: () => {
    if (appRuntime.updateManager) {
      appRuntime.updateManager.cleanup();
    }
  },
  stopBrowserPool,
  cleanupViewManager: async () => {
    if (appRuntime.viewManager) {
      await appRuntime.viewManager.cleanup();
    }
  },
  cleanupWindowManager: () => {
    if (appRuntime.windowManager) {
      appRuntime.windowManager.cleanup();
    }
  },
  closeDuckDB: async () => {
    if (appRuntime.duckdbService) {
      await appRuntime.duckdbService.close();
    }
  },
  exitApp: (code) => app.exit(code),
  exitProcess: (code) => process.exit(code),
  quitApp: () => app.quit(),
  getWindowCount: () => BrowserWindow.getAllWindows().length,
  createWindow,
});

registerAppLifecycleHandlers(app, shutdownBootstrap);
registerProcessSignalHandlers(process, shutdownBootstrap.handleProcessSignal);

/**
 * 应用准备就绪
 */
app.whenReady().then(async () => {
  logStartup('app.whenReady() triggered');
  await runAppReadyBootstrap({
    logStartup,
    hideApplicationMenu,
    initializeServices,
    initializePluginIPC,
    initializeSchedulerIPC,
    initializeObservationIPC,
    initializeHttpApiIPC,
    initializeOcrPoolIPC,
    initializePlugins: async () => {
      await appRuntime.requireJSPluginManager().init();
      await appRuntime.requireSchedulerService().restoreActiveTasks();
    },
    createWindow,
    setupWindowResizeListener: () => appRuntime.requireViewManager().setupWindowResizeListener(),
    initializeIPC,
    shouldInitializeUpdater: () => isProductionMode(),
    initializeUpdater,
    startResourceMonitoring: () => {
      appRuntime.disposeResourceMonitoring = startResourceMonitoring();
    },
    initializeBrowserControlApi,
    handleInitializationFailure,
  });
});

/**
 * 导出全局访问器（用于调试）
 */
export function getBrowserPoolReadiness() {
  return appRuntime.browserPoolReadiness.getSnapshot();
}

export function getRuntimeReadiness() {
  return appRuntime.getRuntimeReadiness();
}
