import type { BrowserWindow as BrowserWindowType } from 'electron';
import type Store from 'electron-store';
import type { JSPluginManager } from '../core/js-plugin/manager';
import type { HookBus } from '../core/hookbus';
import type { WebhookSender } from './webhook/sender';
import type { LogStorageService } from './log-storage-service';
import type { DownloadManager } from './download';
import type { IPCHandler } from './ipc';
import type { DuckDBService } from './duckdb/service';
import type { WindowManager } from './window-manager';
import type { WebContentsViewManager } from './webcontentsview-manager';
import type { UpdateManager } from './updater';
import type { SchedulerService } from './scheduler';
import type { ExtensionPackagesManager } from './profile/extension-packages-manager';
import type { AirpaHttpMcpServer } from './mcp-server-http';
import { BrowserPoolReadiness } from './browser-pool-readiness';

function requireInitialized<T>(value: T | null | undefined, name: string): T {
  if (!value) {
    throw new Error(`${name} has not been initialized`);
  }
  return value;
}

export class AppRuntime {
  mainWindow: BrowserWindowType | null = null;
  store!: Store;
  duckdbService!: DuckDBService;
  logger!: LogStorageService;
  downloadManager!: DownloadManager;
  ipcHandler!: IPCHandler;
  windowManager!: WindowManager;
  viewManager!: WebContentsViewManager;
  jsPluginManager!: JSPluginManager;
  updateManager!: UpdateManager;
  httpMcpServer: AirpaHttpMcpServer | null = null;
  httpServerStartPromise: Promise<void> | null = null;
  schedulerService!: SchedulerService;
  extensionPackages!: ExtensionPackagesManager;
  disposeResourceMonitoring?: () => void;
  hookBus!: HookBus;
  webhookSender!: WebhookSender;
  readonly browserPoolReadiness = new BrowserPoolReadiness();

  requireStore(): Store {
    return requireInitialized(this.store, 'store');
  }

  requireDuckDBService(): DuckDBService {
    return requireInitialized(this.duckdbService, 'duckdbService');
  }

  requireLogger(): LogStorageService {
    return requireInitialized(this.logger, 'logger');
  }

  requireDownloadManager(): DownloadManager {
    return requireInitialized(this.downloadManager, 'downloadManager');
  }

  requireWindowManager(): WindowManager {
    return requireInitialized(this.windowManager, 'windowManager');
  }

  requireViewManager(): WebContentsViewManager {
    return requireInitialized(this.viewManager, 'viewManager');
  }

  requireJSPluginManager(): JSPluginManager {
    return requireInitialized(this.jsPluginManager, 'jsPluginManager');
  }

  requireSchedulerService(): SchedulerService {
    return requireInitialized(this.schedulerService, 'schedulerService');
  }

  requireExtensionPackages(): ExtensionPackagesManager {
    return requireInitialized(this.extensionPackages, 'extensionPackages');
  }

  requireHookBus(): HookBus {
    return requireInitialized(this.hookBus, 'hookBus');
  }

  requireWebhookSender(): WebhookSender {
    return requireInitialized(this.webhookSender, 'webhookSender');
  }
}
