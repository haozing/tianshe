import { app } from 'electron';
import fs from 'fs';
import * as path from 'path';
import { loadWebContentsURL } from './webcontents-navigation';
import { createLogger } from '../core/logger';
import type { JSPluginManager } from '../core/js-plugin/manager';
import type { ActivityBarViewContribution } from '../types/js-plugin';
import type { ViewRegistration, WebContentsViewInfo } from './webcontentsview-manager';

const logger = createLogger('WebContentsViewPluginPageController');

function buildPluginPageViewId(pluginId: string, activityBarViewId: string): string {
  return `plugin-page:${pluginId}:${activityBarViewId}`;
}

function buildPluginPagePartition(pluginId: string): string {
  return `persist:plugin-page:${pluginId}`;
}

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
  }
  private parsePluginPageViewId(
    viewId: string
  ): { pluginId: string; activityBarViewId: string } | null {
    if (!viewId.startsWith('plugin-page:')) return null;
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

    await this.loadPluginPageIntoView({
      viewId,
      pluginId: normalizedPluginId,
      forceReload: true,
    });
  }

  private buildPluginPageInjectionScript(pluginId: string, apiList: string[]): string {
    const encodedPluginId = JSON.stringify(pluginId);
    const encodedApiList = JSON.stringify(apiList);
    return `
      (function() {
        const pluginId = ${encodedPluginId};
        const apiList = ${encodedApiList};

        // 确保 pluginAPI 对象存在
        if (!window.pluginAPI) {
          window.pluginAPI = { datasetId: null };
        }

        // 为插件创建命名空间
        window.pluginAPI[pluginId] = {};

        // 动态创建 API 方法包装器
        for (const apiName of apiList) {
          window.pluginAPI[pluginId][apiName] = async function(...args) {
            // 通过 electronAPI 调用插件 API
            const response = await window.electronAPI.jsPlugin.callPluginAPI(apiName, ...args);
            // ✅ 解包 IPC 响应：{ success: true, result: {...} } -> {...}
            if (response.success) {
              return response.result;
            } else {
              throw new Error(response.error || 'API call failed');
            }
          };
        }

        // 触发自定义事件，通知页面 API 已就绪
        window.dispatchEvent(new CustomEvent('pluginAPIReady', {
          detail: { pluginId, apiList }
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
        logger.warn('Plugin page view id mismatch', {
          pluginId,
          expectedActivityBarViewId: viewConfig.id,
          actualActivityBarViewId: expectedActivityBarViewId,
        });
      }

      if (!viewInfo.metadata) {
        viewInfo.metadata = {};
      }
      if (viewInfo.metadata.pluginId && viewInfo.metadata.pluginId !== pluginId) {
        throw new Error(
          `Plugin page view ${viewId} is bound to ${viewInfo.metadata.pluginId}, not ${pluginId}`
        );
      }
      viewInfo.metadata.pluginId = pluginId;
      viewInfo.metadata.source = 'plugin';
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

      logger.info('Loading plugin page view', { viewId, pluginId });

      let apiList: string[] = [];
      try {
        apiList = this.pluginManager?.getExposedAPIs(pluginId) || [];
      } catch (error) {
        logger.warn('Failed to read exposed APIs for plugin', { pluginId, error });
      }

      const injectionScript = this.buildPluginPageInjectionScript(pluginId, apiList);

      const onFinishLoad = async () => {
        try {
          logger.info('Injecting plugin API into plugin page', { pluginId, apiList });
          await viewInfo.view.webContents.executeJavaScript(injectionScript);
          logger.info('Plugin API injected into plugin page', { pluginId });
        } catch (error) {
          logger.error('Failed to inject plugin API into plugin page', { pluginId, error });
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
              logger.info('Ignoring recoverable plugin page load abort', {
                viewId,
                pluginId,
                targetUrl,
              });
            },
          });
        }
      } catch (error) {
        viewInfo.view.webContents.removeListener('did-finish-load', onFinishLoad);
        throw error;
      }

      this.pluginPageViewCurrentPluginByView.set(viewId, pluginId);
      logger.info('Plugin page view loaded', { viewId, pluginId });
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

    logger.info('Creating plugin page view', { viewId, pluginId });

    // 激活视图（创建实际的 WebContentsView）
    await this.deps.activateView(viewId);

    // 确保页面已加载（createPluginPageView 保持旧语义：创建即加载）
    await this.loadPluginPageView(viewId, pluginId);

    logger.info('Plugin page view created', { viewId, pluginId });
    return viewId;
  }

  /**
   * ✨ 注册插件页面视图（仅注册，不创建实际 WebContents）
   *
   * 用途：降低启动/常驻资源占用。真正的 WebContents 会在首次 show/activate 时创建并加载。
   */
  registerPluginPageView(pluginId: string, viewConfig: ActivityBarViewContribution): string {
    this.pluginPageViewContributions.set(pluginId, viewConfig);
    const viewId = buildPluginPageViewId(pluginId, viewConfig.id);
    const registration: ViewRegistration = {
      id: viewId,
      partition: buildPluginPagePartition(pluginId),
      metadata: {
        label: viewConfig.title,
        icon: viewConfig.icon,
        order: viewConfig.order,
        pluginId,
        temporary: false,
        source: 'plugin',
        stealth: { enabled: false },
      },
    };

    if (this.deps.registry.has(viewId)) {
      this.deps.registry.set(viewId, registration);
    } else {
      this.deps.registerView(registration);
    }

    return viewId;
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

    const pagePrefix = `plugin-page:${pluginId}:`;
    const tempPrefix = `plugin-temp:${pluginId}:`;

    const pageViewId =
      activeViewIds.find((id) => id.startsWith(pagePrefix)) ??
      registeredViewIds.find((id) => id.startsWith(pagePrefix)) ??
      null;

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
    logger.info('Cleaning up plugin page views', { pluginId });

    this.pluginPageViewContributions.delete(pluginId);

    const viewsToCleanup = Array.from(this.deps.pool.keys()).filter((id) => {
      return id.includes(`:${pluginId}:`);
    });

    for (const viewId of viewsToCleanup) {
      await this.deps.closeView(viewId);
    }

    // 同时清理注册表
    const registeredViewsToDelete = Array.from(this.deps.registry.keys()).filter((id) => {
      return id.includes(`:${pluginId}:`);
    });

    for (const viewId of registeredViewsToDelete) {
      this.deps.registry.delete(viewId);
    }

    if (this.deps.getActivePluginId() === pluginId) {
      this.deps.setActivePluginId(null);
    }

    logger.info('Cleaned up plugin page views', {
      pluginId,
      closedViewCount: viewsToCleanup.length,
      deletedRegistrationCount: registeredViewsToDelete.length,
    });
  }


  private getPluginPath(pluginId: string): string {
    return path.join(app.getPath('userData'), 'js-plugins', pluginId);
  }
}
