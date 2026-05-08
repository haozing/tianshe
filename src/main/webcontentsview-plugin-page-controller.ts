import { app } from 'electron';
import fs from 'fs';
import * as path from 'path';
import { loadWebContentsURL } from './webcontents-navigation';
import type { JSPluginManager } from '../core/js-plugin/manager';
import type { ActivityBarViewContribution } from '../types/js-plugin';
import type { ViewRegistration, WebContentsViewInfo } from './webcontentsview-manager';

const SHARED_PLUGIN_PAGE_VIEW_ID = 'plugin-page:shared';
const SHARED_PLUGIN_PAGE_PARTITION = 'persist:plugin-page-shared';

export interface WebContentsViewPluginPageControllerDeps {
  registry: Map<string, ViewRegistration>;
  pool: Map<string, WebContentsViewInfo>;
  registerView(registration: ViewRegistration): void;
  activateView(viewId: string): Promise<WebContentsViewInfo>;
  closeView(viewId: string): Promise<void>;
  detachView(viewId: string): void;
  getActivePluginId(): string | null;
  setActivePluginId(pluginId: string | null): void;
}

export class WebContentsViewPluginPageController {
  private pluginPageViewLoads = new Map<string, Promise<void>>();
  private pluginPageViewContributions = new Map<string, ActivityBarViewContribution>();
  private pluginPageViewCurrentPluginByView = new Map<string, string>();
  private sharedPluginPageViewLoadQueue: Promise<void> = Promise.resolve();
  private pluginManager?: JSPluginManager;

  constructor(private deps: WebContentsViewPluginPageControllerDeps) {}

  setPluginManager(pluginManager: JSPluginManager): void {
    this.pluginManager = pluginManager;
  }

  getCurrentPluginForView(viewId: string): string | undefined {
    return this.pluginPageViewCurrentPluginByView.get(viewId);
  }

  forgetView(viewId: string): string | undefined {
    const pluginId = this.pluginPageViewCurrentPluginByView.get(viewId);
    this.pluginPageViewCurrentPluginByView.delete(viewId);
    return pluginId;
  }

  reset(): void {
    this.pluginPageViewLoads.clear();
    this.pluginPageViewContributions.clear();
    this.pluginPageViewCurrentPluginByView.clear();
    this.sharedPluginPageViewLoadQueue = Promise.resolve();
  }
  private parsePluginPageViewId(
    viewId: string
  ): { pluginId: string; activityBarViewId: string } | null {
    if (!viewId.startsWith('plugin-page:')) return null;
    if (viewId === SHARED_PLUGIN_PAGE_VIEW_ID) return null;
    const rest = viewId.slice('plugin-page:'.length);
    const firstSep = rest.indexOf(':');
    if (firstSep <= 0) return null;
    const pluginId = rest.slice(0, firstSep);
    const activityBarViewId = rest.slice(firstSep + 1);
    if (!pluginId || !activityBarViewId) return null;
    return { pluginId, activityBarViewId };
  }

  async ensurePluginPageViewLoaded(
    viewId: string,
    viewInfo: WebContentsViewInfo
  ): Promise<void> {
    const parsed = this.parsePluginPageViewId(viewId);
    if (!parsed) return;

    await this.loadPluginPageIntoView({
      viewId,
      pluginId: parsed.pluginId,
      expectedActivityBarViewId: parsed.activityBarViewId,
      forceReload: false,
      viewInfo,
    });
  }

  async loadPluginPageView(viewId: string, pluginId: string): Promise<void> {
    const normalizedPluginId = pluginId.trim();
    if (!normalizedPluginId) {
      throw new Error('pluginId is required');
    }

    if (viewId === SHARED_PLUGIN_PAGE_VIEW_ID) {
      const task = this.sharedPluginPageViewLoadQueue.then(() =>
        this.loadPluginPageIntoView({
          viewId,
          pluginId: normalizedPluginId,
          forceReload: true,
        })
      );
      this.sharedPluginPageViewLoadQueue = task.catch(() => undefined);
      await task;
      return;
    }

    await this.loadPluginPageIntoView({
      viewId,
      pluginId: normalizedPluginId,
      forceReload: true,
    });
  }

  private buildPluginPageInjectionScript(pluginId: string, apiList: string[]): string {
    return `
      (function() {
        console.log('🚀 [Plugin Page] Injecting plugin API for: ${pluginId}');
        console.log('📋 [Plugin Page] API list:', ${JSON.stringify(apiList)});

        // 确保 pluginAPI 对象存在
        if (!window.pluginAPI) {
          console.warn('⚠️ window.pluginAPI not found, creating it');
          window.pluginAPI = { datasetId: null };
        }

        // 为插件创建命名空间
        window.pluginAPI['${pluginId}'] = {};

        // 动态创建 API 方法包装器
        const apiList = ${JSON.stringify(apiList)};
        for (const apiName of apiList) {
          window.pluginAPI['${pluginId}'][apiName] = async function(...args) {
            // 通过 electronAPI 调用插件 API
            // ✅ 展开 args 数组，因为 callPluginAPI 期望可变参数
            const response = await window.electronAPI.jsPlugin.callPluginAPI('${pluginId}', apiName, ...args);
            // ✅ 解包 IPC 响应：{ success: true, result: {...} } -> {...}
            if (response.success) {
              return response.result;
            } else {
              throw new Error(response.error || 'API call failed');
            }
          };
        }

        console.log('✅ [Plugin Page] Plugin API injected successfully');
        console.log('📦 [Plugin Page] API namespace:', Object.keys(window.pluginAPI['${pluginId}']));

        // 触发自定义事件，通知页面 API 已就绪
        window.dispatchEvent(new CustomEvent('pluginAPIReady', {
          detail: { pluginId: '${pluginId}', apiList }
        }));
      })();
    `;
  }

  private async loadPluginPageIntoView(options: {
    viewId: string;
    pluginId: string;
    expectedActivityBarViewId?: string;
    forceReload: boolean;
    viewInfo?: WebContentsViewInfo;
  }): Promise<void> {
    const { viewId, pluginId, expectedActivityBarViewId, forceReload } = options;
    const viewInfo = options.viewInfo ?? this.deps.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found in pool: ${viewId}`);
    }

    const currentUrl = viewInfo.view.webContents.getURL();
    const currentPlugin = this.pluginPageViewCurrentPluginByView.get(viewId);
    if (!forceReload && currentPlugin === pluginId && currentUrl && currentUrl !== 'about:blank') {
      return;
    }

    const loadKey = `${viewId}:${pluginId}:${forceReload ? 'force' : 'normal'}`;
    const existing = this.pluginPageViewLoads.get(loadKey);
    if (existing) {
      await existing;
      return;
    }

    const task = (async () => {
      const plugin = this.pluginManager?.getLoadedPlugin(pluginId);
      const viewConfig =
        this.pluginPageViewContributions.get(pluginId) ??
        plugin?.manifest?.contributes?.activityBarView;
      if (!viewConfig) {
        throw new Error(`Plugin ${pluginId} does not have an activityBarView contribution`);
      }
      if (expectedActivityBarViewId && viewConfig.id !== expectedActivityBarViewId) {
        console.warn(
          `⚠️  Plugin page view id mismatch for ${pluginId}: expected=${viewConfig.id}, got=${expectedActivityBarViewId}`
        );
      }

      if (!viewInfo.metadata) {
        viewInfo.metadata = {};
      }
      viewInfo.metadata.pluginId = pluginId;
      viewInfo.metadata.label = viewConfig.title;
      viewInfo.metadata.icon = viewConfig.icon;
      viewInfo.metadata.order = viewConfig.order;
      this.deps.setActivePluginId(pluginId);

      const registration = this.deps.registry.get(viewId);
      if (registration?.metadata) {
        registration.metadata.pluginId = pluginId;
        registration.metadata.label = viewConfig.title;
        registration.metadata.icon = viewConfig.icon;
        registration.metadata.order = viewConfig.order;
      }

      console.log(`🌐 Loading plugin page view: ${viewId} (plugin=${pluginId})`);

      let apiList: string[] = [];
      try {
        apiList = this.pluginManager?.getExposedAPIs(pluginId) || [];
      } catch (error) {
        console.warn(`⚠️ Failed to read exposed APIs for plugin ${pluginId}:`, error);
      }

      const injectionScript = this.buildPluginPageInjectionScript(pluginId, apiList);

      const onFinishLoad = async () => {
        try {
          console.log(`📡 Injecting plugin API for ${pluginId}:`, apiList);
          await viewInfo.view.webContents.executeJavaScript(injectionScript);
          console.log(`✅ Plugin API injected for ${pluginId}`);
        } catch (error) {
          console.error(`❌ Failed to inject plugin API for ${pluginId}:`, error);
        }
      };

      viewInfo.view.webContents.once('did-finish-load', onFinishLoad);

      try {
        if (viewConfig.source.type === 'local') {
          const pluginPath = plugin?.path || this.getPluginPath(pluginId);
          const filePath = path.resolve(pluginPath, viewConfig.source.path);
          if (!fs.existsSync(filePath)) {
            throw new Error(`Plugin page not found: ${filePath}`);
          }
          await viewInfo.view.webContents.loadFile(filePath);
        } else {
          await loadWebContentsURL(viewInfo.view.webContents, viewConfig.source.path, {
            waitUntil: 'domcontentloaded',
            onRecoverableAbort: (targetUrl) => {
              console.log(
                `ℹ [loadPluginPageView] Ignoring recoverable ERR_ABORTED for ${targetUrl}`
              );
            },
          });
        }
      } catch (error) {
        viewInfo.view.webContents.removeListener('did-finish-load', onFinishLoad);
        throw error;
      }

      this.pluginPageViewCurrentPluginByView.set(viewId, pluginId);
      console.log(`✅ Plugin page view loaded: ${viewId} (plugin=${pluginId})`);
    })();

    this.pluginPageViewLoads.set(loadKey, task);
    try {
      await task;
    } finally {
      this.pluginPageViewLoads.delete(loadKey);
    }
  }


  // ========== ✨ 插件 Activity Bar 视图管理方法 ==========

  /**
   * ✨ 为插件创建页面视图
   */
  async createPluginPageView(
    pluginId: string,
    viewConfig: ActivityBarViewContribution
  ): Promise<string> {
    const viewId = this.registerPluginPageView(pluginId, viewConfig);

    console.log(`🆕 Creating plugin page view: ${viewId}`);

    // 激活视图（创建实际的 WebContentsView）
    await this.deps.activateView(viewId);

    // 确保页面已加载（createPluginPageView 保持旧语义：创建即加载）
    await this.loadPluginPageView(viewId, pluginId);

    console.log(`✅ Plugin page view created: ${viewId}`);
    return viewId;
  }

  private ensureSharedPluginPageViewRegistered(): string {
    if (this.deps.registry.has(SHARED_PLUGIN_PAGE_VIEW_ID)) {
      return SHARED_PLUGIN_PAGE_VIEW_ID;
    }

    this.deps.registerView({
      id: SHARED_PLUGIN_PAGE_VIEW_ID,
      partition: SHARED_PLUGIN_PAGE_PARTITION,
      metadata: {
        label: 'Plugin Shared View',
        temporary: false,
        source: 'plugin',
        stealth: { enabled: false },
      },
    });

    return SHARED_PLUGIN_PAGE_VIEW_ID;
  }

  /**
   * ✨ 注册插件页面视图（仅注册，不创建实际 WebContents）
   *
   * 用途：降低启动/常驻资源占用。真正的 WebContents 会在首次 show/activate 时创建并加载。
   */
  registerPluginPageView(pluginId: string, viewConfig: ActivityBarViewContribution): string {
    this.pluginPageViewContributions.set(pluginId, viewConfig);
    return this.ensureSharedPluginPageViewRegistered();
  }

  /**
   * ✨ 获取插件的所有视图ID
   */
  getPluginViews(pluginId: string): {
    pageViewId: string | null;
    tempViewIds: string[];
  } {
    const activeViewIds = Array.from(this.deps.pool.keys());
    const registeredViewIds = Array.from(this.deps.registry.keys());

    const hasSharedPage =
      this.pluginPageViewContributions.has(pluginId) &&
      (activeViewIds.includes(SHARED_PLUGIN_PAGE_VIEW_ID) ||
        registeredViewIds.includes(SHARED_PLUGIN_PAGE_VIEW_ID));
    const legacyPagePrefix = `plugin-page:${pluginId}:`;
    const tempPrefix = `plugin-temp:${pluginId}:`;

    const pageViewId = hasSharedPage
      ? SHARED_PLUGIN_PAGE_VIEW_ID
      : (activeViewIds.find((id) => id.startsWith(legacyPagePrefix)) ??
        registeredViewIds.find((id) => id.startsWith(legacyPagePrefix)) ??
        null);

    const tempViewIds = Array.from(
      new Set([
        ...activeViewIds.filter((id) => id.startsWith(tempPrefix)),
        ...registeredViewIds.filter((id) => id.startsWith(tempPrefix)),
      ])
    );

    return { pageViewId, tempViewIds };
  }


  /**
   * ✨ 清理插件的所有视图
   */
  async cleanupPluginViews(pluginId: string): Promise<void> {
    console.log(`🧹 Cleaning up views for plugin: ${pluginId}`);

    this.pluginPageViewContributions.delete(pluginId);

    const viewsToCleanup = Array.from(this.deps.pool.keys()).filter((id) => {
      if (id === SHARED_PLUGIN_PAGE_VIEW_ID) return false;
      return id.includes(`:${pluginId}:`);
    });

    for (const viewId of viewsToCleanup) {
      await this.deps.closeView(viewId);
    }

    // 同时清理注册表
    const registeredViewsToDelete = Array.from(this.deps.registry.keys()).filter((id) => {
      if (id === SHARED_PLUGIN_PAGE_VIEW_ID) return false;
      return id.includes(`:${pluginId}:`);
    });

    for (const viewId of registeredViewsToDelete) {
      this.deps.registry.delete(viewId);
    }

    if (this.pluginPageViewContributions.size === 0) {
      this.pluginPageViewCurrentPluginByView.delete(SHARED_PLUGIN_PAGE_VIEW_ID);
      if (this.deps.pool.has(SHARED_PLUGIN_PAGE_VIEW_ID)) {
        await this.deps.closeView(SHARED_PLUGIN_PAGE_VIEW_ID);
      }
      this.deps.registry.delete(SHARED_PLUGIN_PAGE_VIEW_ID);
    } else if (
      this.pluginPageViewCurrentPluginByView.get(SHARED_PLUGIN_PAGE_VIEW_ID) === pluginId
    ) {
      const sharedViewInfo = this.deps.pool.get(SHARED_PLUGIN_PAGE_VIEW_ID);
      if (sharedViewInfo?.attachedTo === 'main') {
        this.deps.detachView(SHARED_PLUGIN_PAGE_VIEW_ID);
      }
      this.pluginPageViewCurrentPluginByView.delete(SHARED_PLUGIN_PAGE_VIEW_ID);
      if (this.deps.getActivePluginId() === pluginId) {
        this.deps.setActivePluginId(null);
      }
    }

    console.log(`✅ Cleaned up ${viewsToCleanup.length} view(s) for plugin: ${pluginId}`);
  }


  private getPluginPath(pluginId: string): string {
    return path.join(app.getPath('userData'), 'js-plugins', pluginId);
  }
}
