import type { App } from 'electron';
import Store from 'electron-store';
import { MAX_WEBCONTENTSVIEWS } from '../../constants';
import { DEFAULT_OCR_POOL_CONFIG, normalizeOcrPoolConfig, type OCRPoolConfig } from '../../constants/ocr-pool';
import { initializeBrowserPool } from '../../core/browser-pool';
import { HookBus } from '../../core/hookbus';
import { JSPluginManager } from '../../core/js-plugin/manager';
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
import { registerProfileHandlers } from '../ipc-handlers/profile-ipc-handler';
import { registerTagHandlers } from '../ipc-handlers/tag-ipc-handler';
import { maybeOpenInternalBrowserDevTools } from '../internal-browser-devtools';
import { LogStorageService } from '../log-storage-service';
import { createBrowserFactory, createBrowserDestroyer } from '../profile/browser-pool-integration';
import { createExtensionBrowserFactory } from '../profile/browser-pool-integration-extension';
import { createRuyiBrowserFactory } from '../profile/browser-pool-integration-ruyi';
import { setupProxyAuthHandler, clearProxyCredentials } from '../profile/browser-launcher';
import { ExtensionPackagesManager } from '../profile/extension-packages-manager';
import { SchedulerService } from '../scheduler';
import { WebhookSender } from '../webhook/sender';
import { WebContentsViewManager } from '../webcontentsview-manager';
import { WindowManager } from '../window-manager';
import type { AppRuntime } from '../app-runtime';

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
  console.log(
    `[OK] OCR pool config loaded (size=${ocrPoolConfig.size}, maxQueue=${ocrPoolConfig.maxQueue}, queueMode=${ocrPoolConfig.queueMode})`
  );

  logStartup('Initializing HookBus...');
  appRuntime.hookBus = new HookBus();
  const hookBus = appRuntime.hookBus;
  console.log('[OK] HookBus initialized');
  logStartup('HookBus initialized');

  appRuntime.webhookSender = new WebhookSender(hookBus);
  const webhookSender = appRuntime.webhookSender;
  console.log('[OK] WebhookSender initialized');

  logStartup('Initializing DuckDB service...');
  appRuntime.duckdbService = new DuckDBService(hookBus);
  const duckdbService = appRuntime.duckdbService;
  await duckdbService.init();
  console.log('[OK] DuckDB service initialized');
  logStartup('DuckDB service initialized');

  logStartup('Initializing LogStorageService...');
  appRuntime.logger = new LogStorageService(duckdbService);
  console.log('[OK] Logger initialized');
  logStartup('LogStorageService initialized');

  logStartup('Initializing SchedulerService...');
  const scheduledTaskService = duckdbService.getScheduledTaskService();
  appRuntime.schedulerService = new SchedulerService(scheduledTaskService);
  const schedulerService = appRuntime.schedulerService;
  setSchedulerService(schedulerService);
  await schedulerService.init();
  console.log('[OK] SchedulerService initialized');
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
  console.log('[OK] WindowManager initialized');
  logStartup('WindowManager initialized');

  logStartup('Initializing WebContentsViewManager...');
  appRuntime.viewManager = new WebContentsViewManager(windowManager, MAX_WEBCONTENTSVIEWS);
  const viewManager = appRuntime.viewManager;
  console.log(`[OK] WebContentsViewManager initialized (max: ${MAX_WEBCONTENTSVIEWS} views)`);
  logStartup('WebContentsViewManager initialized');

  logStartup('Initializing DownloadManager...');
  appRuntime.downloadManager = new DownloadManager();
  const downloadManager = appRuntime.downloadManager;
  console.log('[OK] DownloadManager initialized');
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
  console.log('[OK] Dataset folder handlers registered');
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
  console.log('[OK] Profile handlers registered');
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
  console.log('[OK] Account handlers registered');
  logStartup('Account Handlers registered');

  logStartup('Registering Tag Handlers...');
  registerTagHandlers(duckdbService.getTagService(), duckdbService.getAccountService(), {
    onOwnedBundleChanged: () => {
      tiansheEdition.cloudSnapshot.markAccountBundleDirty(true);
    },
  });
  console.log('[OK] Tag handlers registered');
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
  console.log('[OK] JSPluginManager created');
  logStartup('JSPluginManager created');

  viewManager.setPluginManager(jsPluginManager);
  console.log('[OK] ViewManager pluginManager reference set');

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
  { duckdbService, extensionPackages, viewManager, windowManager }: BrowserPoolRuntimeServices
): void {
  const { appRuntime } = options;
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

  appRuntime.browserPoolReadiness.markInitializing();
  initializeBrowserPool(
    () => duckdbService.getProfileService(),
    browserFactory,
    createBrowserDestroyer(viewManager)
  )
    .then(() => {
      appRuntime.browserPoolReadiness.markReady();
      console.log('[OK] BrowserPoolManager initialized');
    })
    .catch((error) => {
      appRuntime.browserPoolReadiness.markFailed(error);
      console.error('[WARN] BrowserPoolManager initialization failed:', error);
    });
}

export async function initializeMainServices(
  options: MainServiceCompositionOptions
): Promise<void> {
  const { appRuntime, logStartup, tiansheEdition } = options;

  console.log('===> Initializing services...\n');
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

    appRuntime.readiness.mark('mainServices', 'ready');
    console.log('\n[OK] All services initialized successfully\n');
  } catch (error) {
    appRuntime.readiness.mark('mainServices', 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
