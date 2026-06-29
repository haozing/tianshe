import type { App } from 'electron';
import Store from 'electron-store';
import { MAX_WEBCONTENTSVIEWS } from '../../constants';
import type { BrowserPoolConfig } from '../../constants/browser-pool';
import { HTTP_SERVER_DEFAULTS } from '../../constants/http-api';
import { MCP_PROTOCOL_UNIFIED_VERSION } from '../../constants/mcp-protocol';
import { DEFAULT_OCR_POOL_CONFIG, normalizeOcrPoolConfig, type OCRPoolConfig } from '../../constants/ocr-pool';
import { initializeBrowserPool } from '../../core/browser-pool';
import { HookBus } from '../../core/hookbus';
import { JSPluginManager } from '../../core/js-plugin/manager';
import { createLogger } from '../../core/logger';
import { setSchedulerService } from '../../core/js-plugin/namespaces/scheduler';
import { setOcrPoolConfig } from '../../core/system-automation/ocr';
import type { TiansheEdition } from '../../edition';
import { DownloadManager } from '../download';
import { DuckDBService } from '../duckdb/service';
import type { IpcSenderGuard } from '../ipc-handlers/utils';
import * as datasetFolderHandlerModule from '../ipc-handlers/dataset-folder-handler';
import { registerDatasetFolderHandlersFromModule } from '../ipc-handlers/dataset-folder-handler-bootstrap';
import { registerAccountHandlers } from '../ipc-handlers/account-ipc-handler';
import { registerExtensionPackagesManagerHandlers } from '../ipc-handlers/extension-packages-ipc-handler';
import { registerBrowserRuntimeHandlers } from '../ipc-handlers/browser-runtime-ipc-handler';
import { registerProfileHandlers } from '../ipc-handlers/profile-ipc-handler';
import { registerTagHandlers } from '../ipc-handlers/tag-ipc-handler';
import { maybeOpenInternalBrowserDevTools } from '../internal-browser-devtools';
import { LogStorageService } from '../log-storage-service';
import { getRuntimeFingerprint } from '../runtime-fingerprint';
import { parseRows } from '../duckdb/utils';
import { createBrowserFactory, createBrowserDestroyer } from '../profile/browser-pool-integration';
import { createExtensionBrowserFactory } from '../profile/browser-pool-integration-extension';
import { createRuyiBrowserFactory } from '../profile/browser-pool-integration-ruyi';
import { createCloakBrowserFactory } from '../profile/browser-pool-integration-cloak';
import {
  createBrowserRuntimeManager,
  createBrowserRuntimeRegistry,
} from '../../core/browser-runtime';
import { createDefaultBrowserRuntimeProviders } from '../profile/browser-runtime-providers';
import { ElectronStoreBrowserRuntimeStore } from '../profile/browser-runtime-store';
import { setupProxyAuthHandler, clearProxyCredentials } from '../profile/browser-launcher';
import { ExtensionPackagesManager } from '../profile/extension-packages-manager';
import { SchedulerService } from '../scheduler';
import { WebhookSender } from '../webhook/sender';
import { WebContentsViewManager } from '../webcontentsview-manager';
import { WindowManager } from '../window-manager';
import type { AppRuntime } from '../app-runtime';

const logger = createLogger('MainServiceComposition');

async function logVersionMatrix(app: App, duckdbService: DuckDBService): Promise<void> {
  const runtimeFingerprint = getRuntimeFingerprint();
  let schemaMigrationHead: Record<string, unknown> | null = null;

  try {
    const rows = parseRows(
      await duckdbService.getConnection().runAndReadAll(`
        SELECT id, applied_at
        FROM schema_migrations
        ORDER BY applied_at DESC
        LIMIT 1
      `)
    );
    schemaMigrationHead = rows[0] || null;
  } catch (error: unknown) {
    logger.warn('Failed to read schema migration head for version matrix', { error });
  }

  logger.info('Runtime version matrix', {
    appVersion: app.getVersion(),
    httpApiVersion: HTTP_SERVER_DEFAULTS.API_VERSION,
    mcpProtocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
    gitCommit: runtimeFingerprint.gitCommit,
    processStartTime: runtimeFingerprint.processStartTime,
    buildFreshness: runtimeFingerprint.buildFreshness,
    mcpSdk: runtimeFingerprint.mcpSdk,
    schemaMigrationHead,
  });
}

export interface MainServiceCompositionOptions {
  app: App;
  appRuntime: AppRuntime;
  tiansheEdition: TiansheEdition;
  assertPrimaryRendererSender: IpcSenderGuard;
  logStartup: (message: string) => void;
}

async function createCoreServices(options: MainServiceCompositionOptions) {
  const { appRuntime, logStartup } = options;

  logStartup('Initializing electron-store...');
  appRuntime.store = new Store();
  const store = appRuntime.store;
  logStartup('electron-store initialized');

  const ocrPoolConfig = normalizeOcrPoolConfig(
    store.get('ocrPoolConfig', DEFAULT_OCR_POOL_CONFIG) as OCRPoolConfig
  );
  store.set('ocrPoolConfig', ocrPoolConfig);
  await setOcrPoolConfig(ocrPoolConfig);
  logger.info('OCR pool config loaded', {
    size: ocrPoolConfig.size,
    maxQueue: ocrPoolConfig.maxQueue,
    queueMode: ocrPoolConfig.queueMode,
  });

  logStartup('Initializing HookBus...');
  appRuntime.hookBus = new HookBus();
  const hookBus = appRuntime.hookBus;
  logger.info('HookBus initialized');
  logStartup('HookBus initialized');

  appRuntime.webhookSender = new WebhookSender(hookBus);
  const webhookSender = appRuntime.webhookSender;
  logger.info('WebhookSender initialized');

  logStartup('Initializing DuckDB service...');
  appRuntime.duckdbService = new DuckDBService(hookBus);
  const duckdbService = appRuntime.duckdbService;
  await duckdbService.init();
  logger.info('DuckDB service initialized');
  await logVersionMatrix(options.app, duckdbService);
  logStartup('DuckDB service initialized');

  logStartup('Initializing LogStorageService...');
  appRuntime.logger = new LogStorageService(duckdbService);
  logger.info('LogStorageService initialized');
  logStartup('LogStorageService initialized');

  logStartup('Initializing SchedulerService...');
  const scheduledTaskService = duckdbService.getScheduledTaskService();
  appRuntime.schedulerService = new SchedulerService(scheduledTaskService);
  const schedulerService = appRuntime.schedulerService;
  setSchedulerService(schedulerService);
  await schedulerService.init();
  logger.info('SchedulerService initialized');
  logStartup('SchedulerService initialized');

  return {
    store,
    hookBus,
    webhookSender,
    duckdbService,
    schedulerService,
  };
}

function createWindowServices(options: MainServiceCompositionOptions) {
  const { appRuntime, logStartup } = options;

  logStartup('Initializing WindowManager...');
  appRuntime.windowManager = new WindowManager();
  const windowManager = appRuntime.windowManager;
  logger.info('WindowManager initialized');
  logStartup('WindowManager initialized');

  logStartup('Initializing WebContentsViewManager...');
  appRuntime.viewManager = new WebContentsViewManager(windowManager, MAX_WEBCONTENTSVIEWS);
  const viewManager = appRuntime.viewManager;
  logger.info('WebContentsViewManager initialized', { maxViews: MAX_WEBCONTENTSVIEWS });
  logStartup('WebContentsViewManager initialized');

  logStartup('Initializing DownloadManager...');
  appRuntime.downloadManager = new DownloadManager();
  const downloadManager = appRuntime.downloadManager;
  logger.info('DownloadManager initialized');
  logStartup('DownloadManager initialized');

  return {
    windowManager,
    viewManager,
    downloadManager,
  };
}

type CoreServices = Awaited<ReturnType<typeof createCoreServices>>;
type WindowServices = ReturnType<typeof createWindowServices>;
type MainRouteServices = CoreServices & WindowServices;
type BrowserPoolRuntimeServices = MainRouteServices & {
  extensionPackages: ExtensionPackagesManager;
};

async function registerMainIpcRoutes(
  options: MainServiceCompositionOptions,
  { duckdbService, viewManager, windowManager }: MainRouteServices
): Promise<{ extensionPackages: ExtensionPackagesManager }> {
  const { appRuntime, assertPrimaryRendererSender, logStartup, tiansheEdition } = options;

  logStartup('Registering Dataset Folder Handlers...');
  registerDatasetFolderHandlersFromModule(datasetFolderHandlerModule, duckdbService);
  logger.info('Dataset folder handlers registered');
  logStartup('Dataset Folder Handlers registered');

  logStartup('Registering Profile Handlers...');
  registerProfileHandlers(
    duckdbService.getProfileService(),
    duckdbService.getProfileGroupService(),
    duckdbService.getAccountService(),
    viewManager,
    windowManager,
    {
      senderGuard: assertPrimaryRendererSender,
    }
  );
  logger.info('Profile handlers registered');
  logStartup('Profile Handlers registered');

  logStartup('Registering Account Handlers...');
  registerAccountHandlers(
    duckdbService.getAccountService(),
    duckdbService.getSavedSiteService(),
    duckdbService.getProfileService(),
    viewManager,
    windowManager,
    {
      senderGuard: assertPrimaryRendererSender,
      onOwnedBundleChanged: () => {
        tiansheEdition.cloudSnapshot.markAccountBundleDirty(true);
      },
    }
  );
  logger.info('Account handlers registered');
  logStartup('Account Handlers registered');

  logStartup('Registering Tag Handlers...');
  registerTagHandlers(duckdbService.getTagService(), duckdbService.getAccountService(), {
    onOwnedBundleChanged: () => {
      tiansheEdition.cloudSnapshot.markAccountBundleDirty(true);
    },
  });
  logger.info('Tag handlers registered');
  logStartup('Tag Handlers registered');

  logStartup('Registering Extension Packages Manager Handlers...');
  appRuntime.extensionPackages = new ExtensionPackagesManager(
    duckdbService.getExtensionPackagesService()
  );
  const extensionPackages = appRuntime.extensionPackages;
  registerExtensionPackagesManagerHandlers(extensionPackages, duckdbService.getProfileService(), {
    syncOutboxService: duckdbService.getSyncOutboxService(),
    fetchBrowserExtensionInstallPackage:
      tiansheEdition.cloudCatalog.fetchBrowserExtensionInstallPackage,
  });
  logger.info('Extension packages manager handlers registered');
  logStartup('Extension Packages Manager Handlers registered');

  if (tiansheEdition.cloudAuth.enabled) {
    logStartup('Registering Cloud Auth Handlers...');
    await tiansheEdition.cloudAuth.registerMainHandlers();
    logger.info('Cloud auth handlers registered');
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
    logger.info('Cloud snapshot handlers registered');
    logStartup('Cloud Snapshot Handlers registered');
  } else {
    logStartup('Cloud Snapshot Handlers skipped for open edition');
  }

  if (tiansheEdition.cloudCatalog.enabled) {
    logStartup('Registering Cloud Catalog Handlers...');
    await tiansheEdition.cloudCatalog.registerMainHandlers();
    logger.info('Cloud catalog handlers registered');
    logStartup('Cloud Catalog Handlers registered');
  } else {
    logStartup('Cloud Catalog Handlers skipped for open edition');
  }

  return {
    extensionPackages,
  };
}

function createPluginRuntime(
  options: MainServiceCompositionOptions,
  { duckdbService, hookBus, webhookSender, viewManager, windowManager }: MainRouteServices
): JSPluginManager {
  const { appRuntime, logStartup } = options;

  logStartup('Creating JSPluginManager...');
  appRuntime.jsPluginManager = new JSPluginManager(
    duckdbService,
    viewManager,
    windowManager,
    hookBus,
    webhookSender,
    (webContents, pluginOptions) => {
      maybeOpenInternalBrowserDevTools(webContents, pluginOptions);
    }
  );
  const jsPluginManager = appRuntime.jsPluginManager;
  logger.info('JSPluginManager created');
  logStartup('JSPluginManager created');

  viewManager.setPluginManager(jsPluginManager);
  logger.info('ViewManager pluginManager reference set');

  return jsPluginManager;
}

function configureViewLifecycle(
  { duckdbService, viewManager }: MainRouteServices
): void {
  viewManager.setViewClosedCallback(async (viewId, metadata) => {
    if (metadata?.profileId) {
      try {
        const profileService = duckdbService.getProfileService();
        const profile = await profileService.get(metadata.profileId);
        if (
          profile?.proxy &&
          profile.proxy.type !== 'none' &&
          profile.proxy.host &&
          profile.proxy.port
        ) {
          clearProxyCredentials(profile.proxy.host, profile.proxy.port);
          logger.info('Profile proxy credentials cleared', {
            profileId: metadata.profileId,
            proxyHost: profile.proxy.host,
            proxyPort: profile.proxy.port,
          });
        }
      } catch (error) {
        logger.error('Failed to cleanup profile proxy credentials', {
          profileId: metadata?.profileId,
          error,
        });
      }
    }
  });
  logger.info('ViewManager viewClosedCallback set for proxy cleanup');
}

function configureDownloadAndProxyRuntime(
  options: MainServiceCompositionOptions,
  { downloadManager }: WindowServices
): void {
  downloadManager.setupPartition('default');
  downloadManager.setupPartition('persist:default');

  setupProxyAuthHandler(options.app);
}

function initializeBrowserPoolRuntime(
  options: MainServiceCompositionOptions,
  { duckdbService, extensionPackages, store, viewManager, windowManager }: BrowserPoolRuntimeServices
): void {
  const { appRuntime } = options;
  const electronBrowserFactory = createBrowserFactory(viewManager, windowManager);
  const extensionBrowserFactory = createExtensionBrowserFactory({
    resolveManagedExtensions: (profileId: string) =>
      extensionPackages.resolveLaunchExtensions(profileId),
  });
  const ruyiBrowserFactory = createRuyiBrowserFactory();
  const cloakBrowserFactory = createCloakBrowserFactory();
  const runtimeRegistry = createBrowserRuntimeRegistry();
  for (const provider of createDefaultBrowserRuntimeProviders({
    electronBrowserFactory,
    extensionBrowserFactory,
    ruyiBrowserFactory,
    cloakBrowserFactory,
  })) {
    runtimeRegistry.register(provider);
  }
  appRuntime.browserRuntimeManager = createBrowserRuntimeManager(
    runtimeRegistry,
    new ElectronStoreBrowserRuntimeStore(store)
  );
  const browserFactory = async (session: Parameters<typeof electronBrowserFactory>[0]) => {
    const provider = runtimeRegistry.get(session.runtimeId);
    const sourceOverride =
      session.runtimeSourceOverride ??
      appRuntime.browserRuntimeManager.getSourceOverride(session.runtimeId);
    return provider.create({
      ...session,
      runtimeSourceOverride: sourceOverride,
    });
  };
  const browserPoolConfigStore = new Store<{ browserPoolConfig?: Partial<BrowserPoolConfig> }>({
    name: 'browser-pool-config',
  });
  const savedBrowserPoolConfig = browserPoolConfigStore.get('browserPoolConfig') || {};

  appRuntime.browserPoolReadiness.markInitializing();
  initializeBrowserPool(
    () => duckdbService.getProfileService(),
    browserFactory,
    createBrowserDestroyer(viewManager),
    savedBrowserPoolConfig
  )
    .then(() => {
      appRuntime.browserPoolReadiness.markReady();
      logger.info('BrowserPoolManager initialized');
    })
    .catch((error) => {
      appRuntime.browserPoolReadiness.markFailed(error);
      logger.error('BrowserPoolManager initialization failed', error);
    });
}

function registerBrowserRuntimeIpcRoutes(options: MainServiceCompositionOptions): void {
  const { appRuntime, assertPrimaryRendererSender, logStartup } = options;

  logStartup('Registering Browser Runtime Handlers...');
  registerBrowserRuntimeHandlers(() => appRuntime.requireBrowserRuntimeManager(), {
    senderGuard: assertPrimaryRendererSender,
  });
  logger.info('Browser runtime handlers registered');
  logStartup('Browser Runtime Handlers registered');
}

export async function initializeMainServices(
  options: MainServiceCompositionOptions
): Promise<void> {
  const { appRuntime, logStartup, tiansheEdition } = options;

  logger.info('Initializing main services');
  logStartup('initializeServices() started');
  logStartup(`Tianshe edition: ${tiansheEdition.name}`);
  appRuntime.readiness.mark('mainServices', 'initializing');

  try {
    const coreServices = await createCoreServices(options);
    const windowServices = createWindowServices(options);
    const routeServices = await registerMainIpcRoutes(options, {
      ...coreServices,
      ...windowServices,
    });
    const runtimeServices = {
      ...coreServices,
      ...windowServices,
      ...routeServices,
    };

    createPluginRuntime(options, runtimeServices);
    configureViewLifecycle(runtimeServices);
    configureDownloadAndProxyRuntime(options, windowServices);
    initializeBrowserPoolRuntime(options, runtimeServices);
    registerBrowserRuntimeIpcRoutes(options);

    appRuntime.readiness.mark('mainServices', 'ready');
    logger.info('All main services initialized successfully');
  } catch (error) {
    appRuntime.readiness.mark('mainServices', 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
