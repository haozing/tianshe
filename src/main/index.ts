/**
 * Electron 主进程入口
 * 负责：
 * - 初始化所有服务
 * - 创建主窗口
 * - 生命周期管理
 */

import { installStdioBrokenPipeGuards } from './bootstrap/stdio-bootstrap';
import { app, BrowserWindow, Menu, dialog } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AIRPA_RUNTIME_CONFIG, isProductionMode } from '../constants/runtime-config';
import { runAppReadyBootstrap } from './bootstrap/app-ready-bootstrap';
import { registerRuntimeErrorHandlers } from './bootstrap/runtime-error-bootstrap';
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

// ============================================
// 🛡️ 反自动化检测：禁用 Chromium 自动化特征标识
// 必须在 app.ready 之前设置
// ============================================
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// E2E: 允许通过 runtime 配置显式开启 CDP 端口，供真主进程 UI 自动化连接。
const e2eCdpPort = AIRPA_RUNTIME_CONFIG.e2e.cdpPort;
if (typeof e2eCdpPort === 'number' && Number.isInteger(e2eCdpPort) && e2eCdpPort > 0) {
  app.commandLine.appendSwitch('remote-debugging-port', String(e2eCdpPort));
}

// ============================================
// 🔧 启动诊断日志（用于排查打包后无法启动的问题）
// ============================================
const startupLogPath = path.join(app.getPath('userData'), 'startup-diagnostic.log');

function logStartup(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(startupLogPath, line);
  } catch {
    // 忽略写入错误
  }
}

// 记录基础环境信息（尽量早；便于排查“打包后无法启动/黑屏”）
try {
  logStartup(`startupLogPath=${startupLogPath}`);
  logStartup(`isPackaged=${app.isPackaged}`);
  logStartup(`appPath=${app.getAppPath()}`);
  logStartup(`platform=${process.platform} arch=${process.arch} osRelease=${os.release()}`);
  logStartup(
    `node=${process.versions.node} chrome=${process.versions.chrome} electron=${process.versions.electron}`
  );
} catch {
  // ignore
}

import type { BrowserWindow as BrowserWindowType } from 'electron';
import Store from 'electron-store';

// 常量
import { MAX_WEBCONTENTSVIEWS } from '../constants';
import type { JSPluginInfo, JSPluginRuntimeStatus } from '../types/js-plugin';

// 核心模块
import { JSPluginManager } from '../core/js-plugin/manager';
import { getPluginRegistry } from '../core/js-plugin/registry';

// 主进程模块
import { LogStorageService } from './log-storage-service';
import { DownloadManager } from './download';
import { IPCHandler } from './ipc';
import { DuckDBService } from './duckdb/service';
import { WindowManager } from './window-manager';
import { WebContentsViewManager } from './webcontentsview-manager';
import { JSPluginIPCHandler } from './ipc-handlers/js-plugin-handler';
import * as datasetFolderHandlerModule from './ipc-handlers/dataset-folder-handler';
import { registerProfileHandlers } from './ipc-handlers/profile-ipc-handler';
import { registerAccountHandlers } from './ipc-handlers/account-ipc-handler';
import { registerTagHandlers } from './ipc-handlers/tag-ipc-handler';
import { registerExtensionPackagesManagerHandlers } from './ipc-handlers/extension-packages-ipc-handler';
import { UpdateManager } from './updater';
import { registerUpdaterHandlers } from './ipc-handlers/updater-handler';
import { SchedulerService } from './scheduler';
import { SchedulerIPCHandler } from './ipc-handlers/scheduler-handler';
import { registerObservationHandlers } from './ipc-handlers/observation-handler';
import { setSchedulerService } from '../core/js-plugin/namespaces/scheduler';
import { HttpApiIPCHandler } from './ipc-handlers/http-api-handler';
import { OCRPoolIPCHandler } from './ipc-handlers/ocr-pool-handler';
import { createDuckDbOrchestrationIdempotencyPersistence } from './orchestration-idempotency-duckdb-store';
import { probeLocalHttpRuntime } from './http-runtime-diagnostics';

// AI-Dev 浏览器控制 API（HTTP MCP 服务器）
import { createHttpMcpServer, AirpaHttpMcpServer } from './mcp-server-http';

// 浏览器启动工具（代理认证处理）
import { setupProxyAuthHandler, clearProxyCredentials } from './profile/browser-launcher';

// 浏览器池管理
import {
  initializeBrowserPool,
  stopBrowserPool,
  getBrowserPoolManager,
} from '../core/browser-pool';
import { fingerprintManager } from '../core/stealth';
import { createBrowserFactory, createBrowserDestroyer } from './profile/browser-pool-integration';
import { createExtensionBrowserFactory } from './profile/browser-pool-integration-extension';
import { createRuyiBrowserFactory } from './profile/browser-pool-integration-ruyi';
import { ExtensionPackagesManager } from './profile/extension-packages-manager';

// Webhook 回调系统
import { HookBus } from '../core/hookbus';
import { WebhookSender } from './webhook/sender';

// HTTP API 配置和类型
import {
  DEFAULT_HTTP_API_CONFIG,
  HTTP_SERVER_DEFAULTS,
  normalizeHttpApiConfig,
  resolveEffectiveHttpApiConfig,
} from '../constants/http-api';
import {
  DEFAULT_OCR_POOL_CONFIG,
  normalizeOcrPoolConfig,
  type OCRPoolConfig,
} from '../constants/ocr-pool';
import type { RestApiDependencies, RestApiConfig } from '../types/http-api';
import { ErrorCode, createStructuredError } from '../types/error-codes';
import { setOcrPoolConfig } from '../core/system-automation/ocr';
import type { CreateProfileParams, UpdateProfileParams } from '../types/profile';
import { resolveTiansheEdition } from '../edition';

// 全局变量
let mainWindow: BrowserWindowType | null = null;
let store: Store;
let duckdbService: DuckDBService;
let logger: LogStorageService;
let downloadManager: DownloadManager;
let _ipcHandler: IPCHandler;
export let windowManager: WindowManager;
let viewManager: WebContentsViewManager;
let jsPluginManager: JSPluginManager;
let updateManager: UpdateManager;
let httpMcpServer: AirpaHttpMcpServer | null = null;
let httpServerStartPromise: Promise<void> | null = null; // 启动锁，防止并发启动
let schedulerService: SchedulerService;
let extensionPackages: ExtensionPackagesManager;
const tiansheEdition = resolveTiansheEdition();

// 🆕 Webhook 回调系统
let hookBus: HookBus;
let webhookSender: WebhookSender;

registerRuntimeErrorHandlers({
  startupLogPath,
  logStartup,
  getLogger: () => logger,
  getMainWindow: () => mainWindow,
  getDuckDBService: () => duckdbService,
});

type DatasetFolderHandlersModule = {
  registerDatasetFolderHandlers?: (duckdbService: DuckDBService) => void;
  default?:
    | { registerDatasetFolderHandlers?: (duckdbService: DuckDBService) => void }
    | ((duckdbService: DuckDBService) => void);
};

function getObjectKeys(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' && typeof value !== 'function') return [];
  return Object.keys(value as Record<string, unknown>);
}

function resolveRegisterDatasetFolderHandlers(
  mod: DatasetFolderHandlersModule | null | undefined
): ((duckdbService: DuckDBService) => void) | null {
  const direct = mod?.registerDatasetFolderHandlers;
  if (typeof direct === 'function') return direct;
  const defaultExport = mod?.default;
  if (defaultExport && typeof defaultExport === 'object') {
    const nested = defaultExport.registerDatasetFolderHandlers;
    if (typeof nested === 'function') return nested;
  }
  if (typeof defaultExport === 'function') return defaultExport;
  return null;
}

/**
 * 创建主窗口（使用 WindowManager）
 */
function createWindow(): void {
  mainWindow = windowManager.createMainWindow();
}

function hideApplicationMenu(): void {
  Menu.setApplicationMenu(null);
}

/**
 * 初始化所有服务
 */
async function initializeServices(): Promise<void> {
  console.log('===> Initializing services...\n');
  logStartup('initializeServices() started');
  logStartup(`Tianshe edition: ${tiansheEdition.name}`);

  // 1. 初始化存储
  logStartup('Initializing electron-store...');
  store = new Store();
  logStartup('electron-store initialized');

  // 1.2. 读取 OCR 引擎池配置（全局）
  const ocrPoolConfig = normalizeOcrPoolConfig(
    store.get('ocrPoolConfig', DEFAULT_OCR_POOL_CONFIG) as OCRPoolConfig
  );
  store.set('ocrPoolConfig', ocrPoolConfig);
  await setOcrPoolConfig(ocrPoolConfig);
  console.log(
    `[OK] OCR pool config loaded (size=${ocrPoolConfig.size}, maxQueue=${ocrPoolConfig.maxQueue}, queueMode=${ocrPoolConfig.queueMode})`
  );

  // 🆕 1.5. 初始化 HookBus（事件总线）
  logStartup('Initializing HookBus...');
  hookBus = new HookBus();
  console.log('[OK] HookBus initialized');
  logStartup('HookBus initialized');

  // 🆕 1.6. 初始化 WebhookSender（回调发送器）
  webhookSender = new WebhookSender(hookBus);
  console.log('[OK] WebhookSender initialized');

  // 2. 初始化 DuckDB 服务（🆕 传入 hookBus）
  logStartup('Initializing DuckDB service...');
  duckdbService = new DuckDBService(hookBus);
  await duckdbService.init();
  console.log('[OK] DuckDB service initialized');
  logStartup('DuckDB service initialized');

  // 3. 初始化日志系统（基于 DuckDB）
  logStartup('Initializing LogStorageService...');
  logger = new LogStorageService(duckdbService);
  console.log('[OK] Logger initialized');
  logStartup('LogStorageService initialized');

  // 3.5. 初始化定时任务调度器
  logStartup('Initializing SchedulerService...');
  const scheduledTaskService = duckdbService.getScheduledTaskService();
  schedulerService = new SchedulerService(scheduledTaskService);
  setSchedulerService(schedulerService); // 设置全局引用供插件使用
  await schedulerService.init(); // 从数据库恢复任务
  console.log('[OK] SchedulerService initialized');
  logStartup('SchedulerService initialized');

  // 4. 初始化窗口管理器（限制2个窗口）
  logStartup('Initializing WindowManager...');
  windowManager = new WindowManager();
  console.log('[OK] WindowManager initialized');
  logStartup('WindowManager initialized');

  // 5. 初始化 WebContentsView 管理器（池大小15，手动管理）
  logStartup('Initializing WebContentsViewManager...');
  viewManager = new WebContentsViewManager(windowManager, MAX_WEBCONTENTSVIEWS);
  console.log(`[OK] WebContentsViewManager initialized (max: ${MAX_WEBCONTENTSVIEWS} views)`);
  logStartup('WebContentsViewManager initialized');

  // 8. 初始化下载管理器
  logStartup('Initializing DownloadManager...');
  downloadManager = new DownloadManager();
  console.log('[OK] DownloadManager initialized');
  logStartup('DownloadManager initialized');

  // 9.5. 提前注册 Dataset Folder Handlers（为 JSPluginManager 准备）
  logStartup('Registering Dataset Folder Handlers...');
  {
    const datasetFolderModule: DatasetFolderHandlersModule = datasetFolderHandlerModule;
    const registerDatasetFolderHandlers = resolveRegisterDatasetFolderHandlers(datasetFolderModule);
    if (typeof registerDatasetFolderHandlers !== 'function') {
      console.error(
        '[ERROR] Dataset folder handlers module shape mismatch:',
        getObjectKeys(datasetFolderModule),
        'defaultKeys=',
        getObjectKeys(datasetFolderModule.default)
      );
      throw new TypeError('registerDatasetFolderHandlers is not a function');
    }
    registerDatasetFolderHandlers(duckdbService);
  }
  console.log('[OK] Dataset folder handlers registered');
  logStartup('Dataset Folder Handlers registered');

  // 9.55. 注册 Profile Handlers（v2 浏览器管理，通过浏览器池获取浏览器）
  logStartup('Registering Profile Handlers...');
  registerProfileHandlers(
    duckdbService.getProfileService(),
    duckdbService.getProfileGroupService(),
    duckdbService.getAccountService(),
    viewManager,
    windowManager
  );
  console.log('[OK] Profile handlers registered');
  logStartup('Profile Handlers registered');

  // 9.56. 注册 Account Handlers（v2 账号管理，支持弹窗登录）
  logStartup('Registering Account Handlers...');
  registerAccountHandlers(
    duckdbService.getAccountService(),
    duckdbService.getSavedSiteService(),
    duckdbService.getProfileService(),
    viewManager,
    windowManager,
    {
      onOwnedBundleChanged: () => {
        tiansheEdition.cloudSnapshot.markAccountBundleDirty(true);
      },
    }
  );
  console.log('[OK] Account handlers registered');
  logStartup('Account Handlers registered');

  // 9.57. 注册 Tag Handlers（v2 标签管理）
  logStartup('Registering Tag Handlers...');
  registerTagHandlers(duckdbService.getTagService(), duckdbService.getAccountService(), {
    onOwnedBundleChanged: () => {
      tiansheEdition.cloudSnapshot.markAccountBundleDirty(true);
    },
  });
  console.log('[OK] Tag handlers registered');
  logStartup('Tag Handlers registered');

  // 9.575. Register extension packages manager handlers
  logStartup('Registering Extension Packages Manager Handlers...');
  extensionPackages = new ExtensionPackagesManager(duckdbService.getExtensionPackagesService());
  registerExtensionPackagesManagerHandlers(extensionPackages, duckdbService.getProfileService(), {
    syncOutboxService: duckdbService.getSyncOutboxService(),
    fetchBrowserExtensionInstallPackage:
      tiansheEdition.cloudCatalog.fetchBrowserExtensionInstallPackage,
  });
  console.log('[OK] Extension packages manager handlers registered');
  logStartup('Extension Packages Manager Handlers registered');

  if (tiansheEdition.cloudAuth.enabled) {
    logStartup('Registering Cloud Auth Handlers...');
    await tiansheEdition.cloudAuth.registerMainHandlers();
    console.log('[OK] Cloud auth handlers registered');
    logStartup('Cloud Auth Handlers registered');
  } else {
    logStartup('Cloud Auth Handlers skipped for open edition');
  }

  if (tiansheEdition.cloudSnapshot.enabled) {
    logStartup('Registering Cloud Snapshot Handlers...');
    await tiansheEdition.cloudSnapshot.registerMainHandlers({
      duckdbService,
      profileService: duckdbService.getProfileService(),
      accountService: duckdbService.getAccountService(),
      savedSiteService: duckdbService.getSavedSiteService(),
      tagService: duckdbService.getTagService(),
      syncOutboxService: duckdbService.getSyncOutboxService(),
      extensionPackages,
    });
    console.log('[OK] Cloud snapshot handlers registered');
    logStartup('Cloud Snapshot Handlers registered');
  } else {
    logStartup('Cloud Snapshot Handlers skipped for open edition');
  }

  if (tiansheEdition.cloudCatalog.enabled) {
    logStartup('Registering Cloud Catalog Handlers...');
    await tiansheEdition.cloudCatalog.registerMainHandlers();
    console.log('[OK] Cloud catalog handlers registered');
    logStartup('Cloud Catalog Handlers registered');
  } else {
    logStartup('Cloud Catalog Handlers skipped for open edition');
  }

  // 10. 初始化JS插件管理器（不加载插件）（🆕 传入 hookBus 和 webhookSender）
  logStartup('Creating JSPluginManager...');
  jsPluginManager = new JSPluginManager(
    duckdbService,
    viewManager,
    windowManager,
    hookBus,
    webhookSender
  );
  // 不调用 init()，稍后在 IPC 注册后再加载插件
  console.log('[OK] JSPluginManager created');
  logStartup('JSPluginManager created');

  // 10.5. 设置 viewManager 的 pluginManager 引用（用于布局计算）
  viewManager.setPluginManager(jsPluginManager);
  console.log('[OK] ViewManager pluginManager reference set');

  // 10.6. 设置视图关闭回调（用于 Profile 状态同步和资源清理）
  // v2 架构：统一使用浏览器池管理模式
  viewManager.setViewClosedCallback(async (viewId, metadata) => {
    if (metadata?.profileId) {
      try {
        const profileService = duckdbService.getProfileService();

        // 获取 Profile 信息用于清理代理凭据
        const profile = await profileService.get(metadata.profileId);
        if (
          profile?.proxy &&
          profile.proxy.type !== 'none' &&
          profile.proxy.host &&
          profile.proxy.port
        ) {
          clearProxyCredentials(profile.proxy.host, profile.proxy.port);
          console.log(
            `[Profile] Proxy credentials cleared: ${profile.proxy.host}:${profile.proxy.port}`
          );
        }
      } catch (error) {
        console.error(`[Profile] Failed to cleanup profile: ${metadata?.profileId}`, error);
      }
    }
  });
  console.log('[OK] ViewManager viewClosedCallback set (proxy cleanup)');

  // 11. 设置下载路径（为常用 partitions）
  downloadManager.setupPartition('default');
  downloadManager.setupPartition('persist:default');

  // 12. 设置代理认证处理器（浏览器代理登录需要）
  setupProxyAuthHandler(app);

  // 13. 初始化浏览器池管理器（异步，在后台完成）
  const electronBrowserFactory = createBrowserFactory(viewManager, windowManager);
  const extensionBrowserFactory = createExtensionBrowserFactory({
    resolveManagedExtensions: (profileId: string) =>
      extensionPackages.resolveLaunchExtensions(profileId),
  });
  const ruyiBrowserFactory = createRuyiBrowserFactory();
  const browserFactory = async (session: Parameters<typeof electronBrowserFactory>[0]) => {
    const engine = session.engine ?? 'electron';
    if (engine === 'extension') {
      return extensionBrowserFactory(session);
    }
    if (engine === 'ruyi') {
      return ruyiBrowserFactory(session);
    }
    return electronBrowserFactory(session);
  };

  initializeBrowserPool(
    () => duckdbService.getProfileService(),
    browserFactory,
    createBrowserDestroyer(viewManager)
  )
    .then(() => {
      console.log('[OK] BrowserPoolManager initialized');
    })
    .catch((error) => {
      console.error('[WARN] BrowserPoolManager initialization failed:', error);
      // 不阻塞应用启动，浏览器池是可选功能
    });

  console.log('\n[OK] All services initialized successfully\n');
}

/**
 * 初始化 JS Plugin IPC 处理器（需要在加载插件之前调用）
 */
function initializePluginIPC(): void {
  const jsPluginIPCHandler = new JSPluginIPCHandler(
    jsPluginManager,
    duckdbService,
    viewManager,
    tiansheEdition.cloudCatalog.runtimePlugin
  );
  jsPluginIPCHandler.register();

  console.log('[OK] JS Plugin IPC handlers registered');
}

/**
 * 初始化 Scheduler IPC 处理器
 */
function initializeSchedulerIPC(): void {
  const schedulerIPCHandler = new SchedulerIPCHandler(schedulerService);
  schedulerIPCHandler.register();

  console.log('[OK] Scheduler IPC handlers registered');
}

/**
 * 初始化 Observation IPC 处理器
 */
function initializeObservationIPC(): void {
  registerObservationHandlers(duckdbService);

  console.log('[OK] Observation IPC handlers registered');
}

/**
 * 初始化 HTTP API IPC 处理器
 */
function initializeHttpApiIPC(): void {
  const httpApiIPCHandler = new HttpApiIPCHandler(
    store,
    webhookSender,
    startHttpServer,
    stopHttpServer
  );
  httpApiIPCHandler.register();

  console.log('[OK] HTTP API IPC handlers registered');
}

/**
 * 初始化 OCR Pool IPC 处理器
 */
function initializeOcrPoolIPC(): void {
  const ocrPoolIPCHandler = new OCRPoolIPCHandler(store);
  ocrPoolIPCHandler.register();

  console.log('[OK] OCR Pool IPC handlers registered');
}

/**
 * 初始化主 IPC 处理器
 */
function initializeIPC(): void {
  if (!mainWindow) {
    throw new Error('Main window not created');
  }

  _ipcHandler = new IPCHandler(
    logger,
    downloadManager,
    duckdbService,
    mainWindow,
    windowManager,
    viewManager
  );

  console.log('[OK] IPC handlers initialized');
}

/**
 * 初始化软件更新管理器（仅生产环境）
 */
async function initializeUpdater(): Promise<void> {
  if (!mainWindow) {
    console.warn('⚠️  Main window not created, skipping updater initialization');
    return;
  }

  try {
    updateManager = new UpdateManager(logger, mainWindow);

    // 注册更新相关的 IPC 处理器
    registerUpdaterHandlers(updateManager);

    // 延迟10秒后首次检查更新（避免影响启动速度）
    setTimeout(() => {
      console.log('[CHECK] Running first update check...');
      updateManager.checkForUpdates().catch((error) => {
        console.error('[ERROR] First update check failed:', error.message);
      });

      // 启动定时检查（每4小时）
      updateManager.startPeriodicCheck(4 * 60 * 60 * 1000);
    }, 10000);

    console.log('[OK] UpdateManager initialized');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ERROR] Failed to initialize UpdateManager:', message, error);
  }
}

/**
 * 🆕 启动资源监控（内存泄漏检测）
 * 每分钟检查一次资源使用情况
 */
function startResourceMonitoring(): void {
  // 定期检查资源统计
  setInterval(() => {
    const stats = viewManager.getResourceStats();
    const memUsage = process.memoryUsage();

    // 记录内存使用情况
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);

    console.log(`[MONITOR] Resource Monitor:
  Views: Created=${stats.created}, Destroyed=${stats.destroyed}, Active=${stats.active}, Failed=${stats.failed}
  Memory: Heap=${heapUsedMB}MB/${heapTotalMB}MB, RSS=${rssMB}MB`);

    // 检测潜在的内存泄漏
    if (stats.leakRisk > 5) {
      console.warn(
        `[WARN] Memory leak risk detected: ${stats.leakRisk} views not properly cleaned up`
      );
      console.warn(`   Consider investigating view lifecycle or calling force GC`);
    }

    // 如果堆内存使用超过 80%，建议 GC
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    if (heapUsagePercent > 80) {
      console.warn(`[WARN] High heap usage: ${Math.round(heapUsagePercent)}%`);
      if (global.gc) {
        console.log(`   Triggering garbage collection...`);
        global.gc();
      }
    }
  }, 60000); // 每60秒检查一次

  console.log('[OK] Resource monitoring started (interval: 60s)');
}

/**
 * 启动 HTTP 服务器（MCP + REST API）
 */
async function startHttpServer(): Promise<void> {
  // 如果启动正在进行中，直接等待而不是重新启动
  if (httpServerStartPromise) {
    console.log('[HTTP] Server start already in progress, waiting...');
    return httpServerStartPromise;
  }

  // 如果服务器已经在运行，先停止
  if (httpMcpServer) {
    await stopHttpServer();
  }

  // 创建启动 Promise 并保存引用
  httpServerStartPromise = (async () => {
    try {
      console.log('\n[HTTP] Starting HTTP Server (MCP + REST API)...');

      // 读取 HTTP API 配置
      const storedHttpApiConfig = normalizeHttpApiConfig(
        store.get('httpApiConfig', DEFAULT_HTTP_API_CONFIG) as Partial<
          typeof DEFAULT_HTTP_API_CONFIG
        >
      );
      store.set('httpApiConfig', storedHttpApiConfig);
      const httpApiConfig = resolveEffectiveHttpApiConfig(storedHttpApiConfig);

      if (!httpApiConfig.enabled) {
        console.log('   [SKIP] HTTP Server start skipped because effective config is disabled');
        httpMcpServer = null;
        return;
      }

      // 配置 WebhookSender 回调 URL
      if (httpApiConfig.callbackUrl) {
        webhookSender.setCallbackUrl(httpApiConfig.callbackUrl);
        console.log(`   [CONFIG] Webhook callback URL: ${httpApiConfig.callbackUrl}`);
      }

      // 准备依赖项和配置
      const toOrchestrationProfile = (profile: {
        id?: unknown;
        name?: unknown;
        engine?: unknown;
        status?: unknown;
        partition?: unknown;
        isSystem?: unknown;
        totalUses?: unknown;
        lastActiveAt?: Date | null;
        updatedAt?: Date | null;
      }) => ({
        id: String(profile.id || ''),
        name: String(profile.name || ''),
        engine: String(profile.engine || ''),
        status: String(profile.status || ''),
        partition: String(profile.partition || ''),
        isSystem: profile.isSystem === true,
        totalUses: Number.isFinite(profile.totalUses) ? Number(profile.totalUses) : 0,
        lastActiveAt: profile.lastActiveAt ? profile.lastActiveAt.toISOString() : '',
        updatedAt: profile.updatedAt ? profile.updatedAt.toISOString() : '',
      });

      const toOrchestrationPluginInfo = (plugin: JSPluginInfo) => ({
        id: String(plugin.id || ''),
        name: String(plugin.name || ''),
        version: String(plugin.version || ''),
        author: String(plugin.author || ''),
        ...(typeof plugin.description === 'string' && plugin.description.trim()
          ? { description: plugin.description.trim() }
          : {}),
        ...(typeof plugin.icon === 'string' && plugin.icon.trim()
          ? { icon: plugin.icon.trim() }
          : {}),
        ...(typeof plugin.category === 'string' && plugin.category.trim()
          ? { category: plugin.category.trim() }
          : {}),
        installedAt:
          typeof plugin.installedAt === 'number' && Number.isFinite(plugin.installedAt)
            ? plugin.installedAt
            : 0,
        path: String(plugin.path || ''),
        enabled: plugin.enabled !== false,
        ...(typeof plugin.hasActivityBarView === 'boolean'
          ? { hasActivityBarView: plugin.hasActivityBarView }
          : {}),
        ...(typeof plugin.activityBarViewOrder === 'number' &&
        Number.isFinite(plugin.activityBarViewOrder)
          ? { activityBarViewOrder: plugin.activityBarViewOrder }
          : {}),
        ...(typeof plugin.activityBarViewIcon === 'string' && plugin.activityBarViewIcon.trim()
          ? { activityBarViewIcon: plugin.activityBarViewIcon.trim() }
          : {}),
        ...(typeof plugin.devMode === 'boolean' ? { devMode: plugin.devMode } : {}),
        ...(typeof plugin.sourcePath === 'string' && plugin.sourcePath.trim()
          ? { sourcePath: plugin.sourcePath.trim() }
          : {}),
        ...(typeof plugin.isSymlink === 'boolean' ? { isSymlink: plugin.isSymlink } : {}),
        ...(typeof plugin.hotReloadEnabled === 'boolean'
          ? { hotReloadEnabled: plugin.hotReloadEnabled }
          : {}),
        ...(plugin.sourceType ? { sourceType: plugin.sourceType } : {}),
        ...(plugin.installChannel ? { installChannel: plugin.installChannel } : {}),
        ...(typeof plugin.cloudPluginCode === 'string' && plugin.cloudPluginCode.trim()
          ? { cloudPluginCode: plugin.cloudPluginCode.trim() }
          : {}),
        ...(typeof plugin.cloudReleaseVersion === 'string' && plugin.cloudReleaseVersion.trim()
          ? { cloudReleaseVersion: plugin.cloudReleaseVersion.trim() }
          : {}),
        ...(typeof plugin.managedByPolicy === 'boolean'
          ? { managedByPolicy: plugin.managedByPolicy }
          : {}),
        ...(typeof plugin.policyVersion === 'string' && plugin.policyVersion.trim()
          ? { policyVersion: plugin.policyVersion.trim() }
          : {}),
        ...(typeof plugin.lastPolicySyncAt === 'number' && Number.isFinite(plugin.lastPolicySyncAt)
          ? { lastPolicySyncAt: plugin.lastPolicySyncAt }
          : {}),
      });

      const toOrchestrationPluginRuntimeStatus = (status: JSPluginRuntimeStatus) => ({
        pluginId: String(status.pluginId || ''),
        ...(typeof status.pluginName === 'string' && status.pluginName.trim()
          ? { pluginName: status.pluginName.trim() }
          : {}),
        lifecyclePhase: status.lifecyclePhase,
        workState: status.workState,
        activeQueues:
          typeof status.activeQueues === 'number' && Number.isFinite(status.activeQueues)
            ? status.activeQueues
            : 0,
        runningTasks:
          typeof status.runningTasks === 'number' && Number.isFinite(status.runningTasks)
            ? status.runningTasks
            : 0,
        pendingTasks:
          typeof status.pendingTasks === 'number' && Number.isFinite(status.pendingTasks)
            ? status.pendingTasks
            : 0,
        failedTasks:
          typeof status.failedTasks === 'number' && Number.isFinite(status.failedTasks)
            ? status.failedTasks
            : 0,
        cancelledTasks:
          typeof status.cancelledTasks === 'number' && Number.isFinite(status.cancelledTasks)
            ? status.cancelledTasks
            : 0,
        ...(typeof status.currentSummary === 'string' && status.currentSummary.trim()
          ? { currentSummary: status.currentSummary.trim() }
          : {}),
        ...(typeof status.currentOperation === 'string' && status.currentOperation.trim()
          ? { currentOperation: status.currentOperation.trim() }
          : {}),
        ...(typeof status.progressPercent === 'number' && Number.isFinite(status.progressPercent)
          ? { progressPercent: status.progressPercent }
          : {}),
        ...(status.lastError &&
        typeof status.lastError.message === 'string' &&
        Number.isFinite(status.lastError.at)
          ? {
              lastError: {
                message: status.lastError.message,
                at: status.lastError.at,
              },
            }
          : {}),
        ...(typeof status.lastActivityAt === 'number' && Number.isFinite(status.lastActivityAt)
          ? { lastActivityAt: status.lastActivityAt }
          : {}),
        updatedAt:
          typeof status.updatedAt === 'number' && Number.isFinite(status.updatedAt)
            ? status.updatedAt
            : Date.now(),
      });

      const profileService = duckdbService.getProfileService();
      const hasProfileRuntimeMutation = (params: UpdateProfileParams) =>
        params.fingerprint !== undefined ||
        params.engine !== undefined ||
        params.proxy !== undefined ||
        params.quota !== undefined ||
        params.idleTimeoutMs !== undefined ||
        params.lockTimeoutMs !== undefined;

      const dependencies: RestApiDependencies = {
        viewManager,
        windowManager,
        datasetGateway: {
          listDatasets: () => duckdbService.listDatasets(),
          getDatasetInfo: (datasetId) => duckdbService.getDatasetInfo(datasetId),
          queryDataset: (datasetId, sql, offset, limit) =>
            duckdbService.queryDataset(datasetId, sql, offset, limit),
          createEmptyDataset: (datasetName, options) =>
            duckdbService.createEmptyDataset(datasetName, options),
          importDatasetFile: (filePath, datasetName, options) =>
            duckdbService.importDatasetFile(filePath, datasetName, options),
          renameDataset: (datasetId, newName) => duckdbService.renameDataset(datasetId, newName),
          deleteDataset: (datasetId) => duckdbService.deleteDataset(datasetId),
        },
        crossPluginGateway: {
          listCallableApis: () => getPluginRegistry().listMCPCallableAPIs(),
          callApi: (pluginId, apiName, params = []) =>
            getPluginRegistry().callPluginAPIFromMCP(pluginId, apiName, params),
        },
        pluginGateway: {
          listPlugins: async () => {
            const plugins = await jsPluginManager.listPlugins();
            return plugins.map((plugin) => toOrchestrationPluginInfo(plugin));
          },
          getPlugin: async (pluginId: string) => {
            const plugin = await jsPluginManager.getPluginInfo(String(pluginId || '').trim());
            return plugin ? toOrchestrationPluginInfo(plugin) : null;
          },
          listRuntimeStatuses: async () => {
            const statuses = await jsPluginManager.listRuntimeStatuses();
            return statuses.map((status) => toOrchestrationPluginRuntimeStatus(status));
          },
          getRuntimeStatus: async (pluginId: string) => {
            const status = await jsPluginManager.getRuntimeStatus(String(pluginId || '').trim());
            return status ? toOrchestrationPluginRuntimeStatus(status) : null;
          },
          installPlugin: async (request) => {
            if (request.sourceType === 'cloud_code') {
              const runtimePluginProvider = tiansheEdition.cloudCatalog.runtimePlugin;
              if (!runtimePluginProvider) {
                throw createStructuredError(
                  ErrorCode.INVALID_PARAMETER,
                  'cloud plugin install is not available in this edition'
                );
              }

              const cloudPluginCode = String(request.cloudPluginCode || '').trim();
              if (!cloudPluginCode) {
                throw createStructuredError(
                  ErrorCode.INVALID_PARAMETER,
                  'cloudPluginCode is required for cloud plugin install'
                );
              }

              const pkg = await runtimePluginProvider.fetchInstallPackage({
                pluginCode: cloudPluginCode,
              });
              try {
                const result = await jsPluginManager.installOrUpdateCloudPlugin(pkg.tempZipPath, {
                  devMode: false,
                  sourceType: 'cloud_managed',
                  installChannel: 'cloud_download',
                  trustedFirstParty: true,
                  cloudPluginCode: pkg.pluginCode,
                  cloudReleaseVersion: pkg.releaseVersion,
                  managedByPolicy: true,
                  policyVersion: pkg.policyVersion,
                  lastPolicySyncAt: Date.now(),
                });
                if (!result.success || !result.pluginId) {
                  throw new Error(result.error || 'Failed to install cloud plugin');
                }
                return {
                  pluginId: result.pluginId,
                  operation: result.operation || 'installed',
                  sourceType: 'cloud_code' as const,
                  ...(result.warnings?.length ? { warnings: result.warnings } : {}),
                };
              } finally {
                if (pkg.tempZipPath) {
                  await fs.promises.rm(pkg.tempZipPath, { force: true }).catch(() => undefined);
                }
              }
            }

            const sourcePath = String(request.sourcePath || '').trim();
            if (!sourcePath) {
              throw createStructuredError(
                ErrorCode.INVALID_PARAMETER,
                'sourcePath is required for local plugin install'
              );
            }
            const result = await jsPluginManager.import(sourcePath, {
              devMode: request.devMode === true,
              trustedFirstParty: true,
            });
            if (!result.success || !result.pluginId) {
              throw new Error(result.error || 'Failed to install local plugin');
            }
            return {
              pluginId: result.pluginId,
              operation: result.operation || 'installed',
              sourceType: 'local_path' as const,
              ...(result.warnings?.length ? { warnings: result.warnings } : {}),
            };
          },
          reloadPlugin: async (pluginId: string) => {
            await jsPluginManager.reload(String(pluginId || '').trim());
          },
          uninstallPlugin: async (pluginId: string, options?: { deleteTables?: boolean }) => {
            await jsPluginManager.uninstall(
              String(pluginId || '').trim(),
              options?.deleteTables === true
            );
          },
        },
        profileGateway: {
          listProfiles: async () => {
            const profiles = await profileService.list();
            return profiles.map((p) => toOrchestrationProfile(p));
          },
          getProfile: async (profileId: string) => {
            const profile = await profileService.get(String(profileId || '').trim());
            if (!profile) return null;
            return toOrchestrationProfile(profile);
          },
          resolveProfile: async (query: string) => {
            const q = String(query || '').trim();
            if (!q) return null;

            const byId = await profileService.get(q);
            if (byId) {
              return {
                query: q,
                matchedBy: 'id' as const,
                profile: toOrchestrationProfile(byId),
              };
            }

            const profiles = await profileService.list();
            const byName = profiles.filter((p) => String(p.name || '').trim() === q);
            if (!byName.length) return null;
            if (byName.length > 1) {
              throw createStructuredError(
                ErrorCode.INVALID_PARAMETER,
                `Profile query "${q}" matches multiple profiles`,
                {
                  suggestion:
                    'Use profile_resolve with an exact profile id, or disambiguate by listing profiles first',
                  context: {
                    query: q,
                    candidateCount: byName.length,
                    candidates: byName.map((item) => toOrchestrationProfile(item)),
                  },
                }
              );
            }
            return {
              query: q,
              matchedBy: 'name' as const,
              profile: toOrchestrationProfile(byName[0]),
            };
          },
          createProfile: async (params: CreateProfileParams) => {
            const profile = await profileService.create(params);
            return toOrchestrationProfile(profile);
          },
          updateProfile: async (id: string, params: UpdateProfileParams) => {
            const updated = await profileService.update(id, params);

            if (hasProfileRuntimeMutation(params)) {
              try {
                fingerprintManager.clearCache(updated.id);
              } catch {
                // ignore
              }

              try {
                fingerprintManager.clearCache(updated.partition);
              } catch {
                // ignore
              }

              try {
                const poolManager = getBrowserPoolManager();
                await poolManager.destroyProfileBrowsers(id);
              } catch {
                // ignore
              }
            }

            return toOrchestrationProfile(updated);
          },
          deleteProfile: async (id: string) => {
            try {
              const poolManager = getBrowserPoolManager();
              await poolManager.destroyProfileBrowsers(id);
            } catch {
              // ignore
            }

            await profileService.deleteWithCascade(id);
          },
        },
        observationGateway: {
          getTraceSummary: (traceId: string) => duckdbService.getTraceSummary(traceId),
          getFailureBundle: (traceId: string) => duckdbService.getFailureBundle(traceId),
          getTraceTimeline: (traceId: string, limit?: number) =>
            duckdbService.getTraceTimeline(traceId, limit),
          searchRecentFailures: (limit?: number) => duckdbService.searchRecentFailures(limit),
        },
        ...(httpApiConfig.orchestrationIdempotencyStore === 'duckdb'
          ? {
              idempotencyPersistence:
                createDuckDbOrchestrationIdempotencyPersistence(duckdbService),
            }
          : {}),
      };

      const restApiConfig: RestApiConfig = {
        enableAuth: httpApiConfig.enableAuth,
        token: httpApiConfig.token,
        enableMcp: httpApiConfig.enableMcp, // 传递 MCP 开关配置
        mcpRequireAuth: httpApiConfig.mcpRequireAuth,
        mcpAllowedOrigins: httpApiConfig.mcpAllowedOrigins,
        enforceOrchestrationScopes: httpApiConfig.enforceOrchestrationScopes,
        orchestrationIdempotencyStore: httpApiConfig.orchestrationIdempotencyStore,
      };

      const mcpPort = HTTP_SERVER_DEFAULTS.PORT;
      const mcpHost = HTTP_SERVER_DEFAULTS.BIND_ADDRESS;

      // 启动 HTTP 服务器（固定端口策略）
      httpMcpServer = await createHttpMcpServer(
        {
          port: mcpPort,
          name: 'airpa-browser-http',
          version: '1.0.0',
        },
        dependencies,
        restApiConfig,
        getBrowserPoolManager
      );

      console.log(`   [OK] HTTP Server started on port ${mcpPort}`);
      // MCP 端点（仅在启用时显示）
      if (httpApiConfig.enableMcp) {
        const mcpBaseUrl = `http://${mcpHost}:${mcpPort}/mcp`;
        console.log(`   [MCP] Claude Code Configuration:`);
        console.log(`      Transport: http`);
        console.log(`      URL: ${mcpBaseUrl}`);
        console.log(
          `      Note: use session_prepare to bind profile, engine, visibility, and scopes`
        );
      } else {
        console.log(`   [MCP] MCP endpoint disabled`);
      }
      console.log(`   [REST] Orchestration API:`);
      console.log(
        `      Capabilities: http://${mcpHost}:${mcpPort}${HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX}/capabilities`
      );
      console.log(
        `      Session Create: http://${mcpHost}:${mcpPort}${HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX}/sessions`
      );
      console.log(
        `      Invoke: http://${mcpHost}:${mcpPort}${HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX}/invoke`
      );
      if (httpApiConfig.enableAuth) {
        console.log(`   [AUTH] Token authentication enabled`);
      }
      console.log(`   [CHECK] Health Check: http://${mcpHost}:${mcpPort}/health`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('   [ERROR] HTTP Server failed to start:', errorMessage);
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === 'EADDRINUSE'
      ) {
        try {
          const runtime = await probeLocalHttpRuntime({
            port: HTTP_SERVER_DEFAULTS.PORT,
          });
          console.error(`   [DIAG] ${runtime.diagnosis.summary}`);
          if (runtime.diagnosis.detail) {
            console.error(`   [DETAIL] ${runtime.diagnosis.detail}`);
          }
          if (runtime.diagnosis.suggestedAction) {
            console.error(`   [HINT] ${runtime.diagnosis.suggestedAction}`);
          }
        } catch (diagnosticError) {
          const diagnosticMessage =
            diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
          console.error(
            `   [DIAG] Failed to inspect occupied port ${HTTP_SERVER_DEFAULTS.PORT}: ${diagnosticMessage}`
          );
        }
      }
      if (error && typeof error === 'object' && (error as { code?: string }).code === 'EACCES') {
        console.error(
          `   [HINT] Port permission denied on ${HTTP_SERVER_DEFAULTS.PORT}. Please check local port policy/occupation.`
        );
      }
      console.error('   Please check if the port is already in use or view the full error log');
      throw error;
    } finally {
      // 无论成功失败都清除启动锁
      httpServerStartPromise = null;
    }
  })();

  return httpServerStartPromise;
}

/**
 * 停止 HTTP 服务器
 */
async function stopHttpServer(): Promise<void> {
  if (!httpMcpServer) {
    console.log('[HTTP] Server is not running');
    return;
  }

  try {
    console.log('[HTTP] Stopping HTTP Server...');
    await httpMcpServer.stop();
    httpMcpServer = null;
    console.log('   [OK] HTTP Server stopped');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('   [ERROR] Failed to stop HTTP Server:', errorMessage);
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
    store.get('httpApiConfig', DEFAULT_HTTP_API_CONFIG) as Partial<typeof DEFAULT_HTTP_API_CONFIG>
  );

  if (!httpApiConfig.enabled) {
    console.log('\n[HTTP] HTTP Server disabled in settings');
    console.log('   To enable, go to Settings > HTTP API and toggle the switch');
    return;
  }

  await startHttpServer();
}

async function handleInitializationFailure(error: unknown): Promise<void> {
  const err = error as Error;
  console.error('[ERROR] Failed to initialize application:', error);
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
  disposeScheduler: async () => {
    if (schedulerService) {
      await schedulerService.dispose();
    }
  },
  cleanupUpdater: () => {
    if (updateManager) {
      updateManager.cleanup();
    }
  },
  stopBrowserPool,
  cleanupViewManager: async () => {
    if (viewManager) {
      await viewManager.cleanup();
    }
  },
  cleanupWindowManager: () => {
    if (windowManager) {
      windowManager.cleanup();
    }
  },
  closeDuckDB: async () => {
    if (duckdbService) {
      await duckdbService.close();
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
    initializePlugins: () => jsPluginManager.init(),
    createWindow,
    setupWindowResizeListener: () => viewManager.setupWindowResizeListener(),
    initializeIPC,
    shouldInitializeUpdater: () => isProductionMode(),
    initializeUpdater,
    startResourceMonitoring,
    initializeBrowserControlApi,
    handleInitializationFailure,
  });
});

/**
 * 导出全局访问器（用于调试）
 */
export function getLogger(): LogStorageService {
  return logger;
}

export function getDuckDBService(): DuckDBService {
  return duckdbService;
}
