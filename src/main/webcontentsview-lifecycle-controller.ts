import { WebContentsView, type WebContents } from 'electron';
import { AIRPA_RUNTIME_CONFIG, isDevelopmentMode } from '../constants/runtime-config';
import { maybeOpenInternalBrowserDevTools } from './internal-browser-devtools';
import { loadWebContentsURL } from './webcontents-navigation';
import type { WebContentsViewSecurityController } from './webcontentsview-security-controller';
import type { WebContentsViewStealthController } from './webcontentsview-stealth-controller';
import type { WebContentsViewLayoutController } from './webcontentsview-layout-controller';
import type { WebContentsViewPluginPageController } from './webcontentsview-plugin-page-controller';
import type { WebContentsViewStateController } from './webcontentsview-state-controller';
import type { ViewMetadata, ViewRegistration, WebContentsViewInfo } from './webcontentsview-manager';

interface WebContentsWithDestroy extends WebContents {
  destroy(): void;
}

interface WebContentsWithBackgroundThrottling extends WebContents {
  setBackgroundThrottling(enabled: boolean): void;
}

type MutableWebContentsViewInfo = Omit<WebContentsViewInfo, 'view' | 'partition' | 'metadata'> & {
  view: WebContentsView | null;
  partition: string | null;
  metadata?: ViewMetadata | null;
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function hasDestroyMethod(wc: WebContents): wc is WebContentsWithDestroy {
  return typeof (wc as WebContentsWithDestroy).destroy === 'function';
}

function hasBackgroundThrottling(wc: WebContents): wc is WebContentsWithBackgroundThrottling {
  return typeof (wc as WebContentsWithBackgroundThrottling).setBackgroundThrottling === 'function';
}

function boundsAlmostEqual(
  actual: { x: number; y: number; width: number; height: number },
  desired: { x: number; y: number; width: number; height: number },
  tolerance: number = 1
): boolean {
  return (
    Math.abs(actual.x - desired.x) <= tolerance &&
    Math.abs(actual.y - desired.y) <= tolerance &&
    Math.abs(actual.width - desired.width) <= tolerance &&
    Math.abs(actual.height - desired.height) <= tolerance
  );
}

export interface WebContentsViewLifecycleControllerDeps {
  pool: Map<string, WebContentsViewInfo>;
  getMaxSize(): number;
  resolveViewPreloadPath(metadata?: ViewMetadata): string | undefined;
  securityController: WebContentsViewSecurityController;
  stealthController: WebContentsViewStealthController;
  stateController: WebContentsViewStateController;
  pluginPageController: WebContentsViewPluginPageController;
  layoutController: WebContentsViewLayoutController;
  removePluginDockLayoutsByView(viewId: string): string[];
  detachView(viewId: string): void;
  notifyViewCreated(viewId: string, registration: ViewRegistration): void;
  notifyViewClosed(viewId: string): void;
  getViewClosedCallback(): ((viewId: string, metadata?: ViewMetadata) => void) | undefined;
  clearViewportDebug(viewId: string): void;
  getActivePluginId(): string | null;
  setActivePluginId(pluginId: string | null): void;
}

export class WebContentsViewLifecycleController {
  constructor(private deps: WebContentsViewLifecycleControllerDeps) {}
  async createViewFromRegistration(
    registration: ViewRegistration
  ): Promise<WebContentsViewInfo> {
    const viewId = registration.id;

    const cachedView = this.deps.pool.get(viewId);
    if (cachedView) {
      return cachedView;
    }

    if (this.deps.pool.size >= this.deps.getMaxSize()) {
      const activeViews = Array.from(this.deps.pool.keys()).join(', ');
      throw new Error(
        `WebContentsView pool is full (${this.deps.getMaxSize()}/${this.deps.getMaxSize()}). Cannot activate "${viewId}".\n` +
          `Active views: [${activeViews}]\n` +
          `Please close an existing view first.`
      );
    }

    const viewCreateStart = Date.now();
    const preloadPath = this.deps.resolveViewPreloadPath(registration.metadata);
    const securityPolicy = this.deps.securityController.resolvePolicy(registration.metadata);
    console.log(`View preload script path: ${preloadPath || '(none)'}`);

    const view = new WebContentsView({
      webPreferences: {
        partition: registration.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: securityPolicy.webSecurity,
        allowRunningInsecureContent: securityPolicy.allowRunningInsecureContent,
        ...(preloadPath ? { preload: preloadPath } : {}),
      },
    });
    console.log(`WebContentsView object created in ${Date.now() - viewCreateStart}ms`);

    view.on('bounds-changed', () => {
      const info = this.deps.pool.get(viewId);
      if (!info?.attachedTo || !info.bounds) return;

      try {
        const actual = view.getBounds();
        const desired = info.bounds;
        if (boundsAlmostEqual(actual, desired)) return;

        if (isDevelopmentMode()) {
          console.warn(`[bounds-changed] View bounds overwritten, reapplying: ${viewId}`, {
            desired,
            actual,
            attachedTo: info.attachedTo,
          });
        }

        setImmediate(() => {
          const latest = this.deps.pool.get(viewId);
          if (!latest?.attachedTo || !latest.bounds) return;
          if (latest.view.webContents.isDestroyed()) return;
          try {
            latest.view.setBounds(latest.bounds);
          } catch {
            // ignore
          }
        });
      } catch (error) {
        if (isDevelopmentMode()) {
          console.warn(`[bounds-changed] Failed to verify/reapply bounds for ${viewId}:`, error);
        }
      }
    });

    try {
      const source = registration.metadata?.source;
      const shouldDisableThrottling = source === 'pool' || source === 'mcp' || source === 'account';
      if (shouldDisableThrottling && hasBackgroundThrottling(view.webContents)) {
        view.webContents.setBackgroundThrottling(false);
        console.log(`[Performance] Disabled background throttling for view: ${viewId} (source=${source})`);
      }
    } catch (error) {
      console.warn(
        `[Performance] Failed to set background throttling for view ${viewId}: ${getErrorMessage(error)}`
      );
    }

    await this.deps.stealthController.applyToWebContents(
      viewId,
      view.webContents,
      registration.partition,
      registration.metadata
    );

    view.webContents.on('console-message', (_event, _level, message) => {
      if (message.includes('Preload script loaded')) {
        console.log(`Preload script loaded successfully for view: ${viewId}`);
      }
    });

    view.webContents.on('did-finish-load', () => {
      if (preloadPath) {
        view.webContents
          .executeJavaScript('typeof window.electronAPI')
          .then((result) => {
            console.log(`window.electronAPI type: ${result} (view: ${viewId})`);
            if (result === 'undefined') {
              console.error('window.electronAPI is undefined! Preload may have failed.');
            }
          })
          .catch((err) => {
            console.error('Failed to check window.electronAPI:', err);
          });
      }

      if (AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders) {
        view.webContents
          .executeJavaScript(
            `(()=>({` +
              `language:navigator.language,` +
              `languages:navigator.languages,` +
              `userAgent:navigator.userAgent,` +
              `uaDataBrands:(navigator.userAgentData&&navigator.userAgentData.brands)||null,` +
              `airpaStealthExpected:(globalThis).__airpaStealthExpected||null,` +
              `devicePixelRatio:window.devicePixelRatio,` +
              `screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth},` +
              `webgl:(()=>{try{const c=document.createElement('canvas');const gl=c.getContext('webgl');if(!gl)return null;const ext=gl.getExtension('WEBGL_debug_renderer_info');const uVendor=ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null;const uRenderer=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null;return {vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmaskedVendor:uVendor,unmaskedRenderer:uRenderer,version:gl.getParameter(gl.VERSION),shading:gl.getParameter(gl.SHADING_LANGUAGE_VERSION)};}catch(_e){return {error:true};}})(),` +
              `languagesDescOwn:(()=>{const d=Object.getOwnPropertyDescriptor(navigator,'languages');return d?{configurable:!!d.configurable,enumerable:!!d.enumerable,hasGet:!!d.get,hasValue:('value'in d)}:null})(),` +
              `languagesDescProto:(()=>{const p=Object.getPrototypeOf(navigator);const d=p&&Object.getOwnPropertyDescriptor(p,'languages');return d?{configurable:!!d.configurable,enumerable:!!d.enumerable,hasGet:!!d.get,hasValue:('value'in d)}:null})()` +
              `}))()`
          )
          .then((info) => {
            this.deps.stealthController.debug(`[Stealth][JS] view=${viewId} ${JSON.stringify(info)}`);
          })
          .catch(() => {});
      }
    });

    this.deps.securityController.applyToPartition(
      view.webContents.session,
      registration.partition,
      securityPolicy
    );

    const allowedPermissions = this.deps.securityController.resolveAllowedPermissions(
      registration.metadata
    );
    const isPermissionAllowed = (permission: string) => allowedPermissions.has(permission);
    const logBlockedPermission = (permission: string) => {
      console.log(`Blocked permission request for view: ${viewId} (${permission})`);
    };
    view.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      const allowed = isPermissionAllowed(permission);
      if (!allowed) {
        logBlockedPermission(permission);
      }
      callback(allowed);
    });
    view.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
      const allowed = isPermissionAllowed(permission);
      if (!allowed) {
        logBlockedPermission(permission);
      }
      return allowed;
    });

    // 3.6 根据全局/视图级配置自动打开 DevTools（便于调试脚本执行）
    if (
      maybeOpenInternalBrowserDevTools(view.webContents, {
        override: registration.metadata?.openDevTools,
        mode: 'detach',
      })
    ) {
      console.log(`🛠️  DevTools opened for view: ${viewId}`);
    }

    // 4. 跳过初始 URL 加载（性能优化）
    // 原因：避免重复加载。实际导航由 workflow 的 goto 操作完成
    // 如果需要预加载，应由 workflow 显式控制
    // if (registration.url) {
    //   await view.webContents.loadURL(registration.url);
    // }
    console.log(
      `🚀 WebContentsView created without initial URL load (will be loaded by workflow): ${viewId}`
    );

    // 5. 记录信息
    const viewInfo: WebContentsViewInfo = {
      id: viewId,
      view,
      partition: registration.partition,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      metadata: registration.metadata,
    };

    this.deps.pool.set(viewId, viewInfo);

    // 🆕 更新统计
    const totalCreated = this.deps.stateController.markCreated();

    console.log(
      `✅ WebContentsView created: ${viewId} (${this.deps.pool.size}/${this.deps.getMaxSize()}, total created: ${totalCreated})`
    );

    // 🆕 通知前端标签栏更新
    this.deps.notifyViewCreated(viewId, registration);

    return viewInfo;
  }


  /**
   * 导航到指定 URL
   */
  async navigateView(viewId: string, url: string): Promise<void> {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found in pool: ${viewId}`);
    }

    await loadWebContentsURL(viewInfo.view.webContents, url, {
      waitUntil: 'domcontentloaded',
      onRecoverableAbort: (targetUrl) => {
        console.log(`ℹ [navigateView] Ignoring recoverable ERR_ABORTED for ${targetUrl}`);
      },
    });
    viewInfo.lastAccessedAt = Date.now();

    console.log(`✅ View navigated: ${viewId} -> ${url}`);
  }

  /**
   * 关闭 View（从池中移除，但保留注册信息）
   * 🔧 改进版本：完整的资源清理流程，避免内存泄漏
   */
  async closeView(viewId: string): Promise<void> {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`closeView: View not found in pool: ${viewId}`);
      return;
    }

    const removedDockPlugins = this.deps.removePluginDockLayoutsByView(viewId);
    const currentPluginForView = this.deps.pluginPageController.getCurrentPluginForView(viewId);
    const wasRightDocked = this.deps.layoutController.getRightDockedViewId() === viewId;
    if (wasRightDocked) {
      this.deps.layoutController.clearRightDockedViewIfMatches(viewId);
    }

    if (removedDockPlugins.length > 0) {
      console.log(
        `[closeView] Removed dock layout mapping for plugin(s): ${removedDockPlugins.join(', ')}`
      );
    }

    // 🆕 保存 metadata 用于回调（因为后面会被清空）
    const metadata = viewInfo.metadata ? { ...viewInfo.metadata } : undefined;

    console.log(`🧹 Starting cleanup for view: ${viewId}`);

    try {
      // ============================================
      // 第 1 步: 分离 View（如果已附加）
      // ============================================
      if (viewInfo.attachedTo) {
        this.deps.detachView(viewId);
        console.log(`  ✓ View detached from window`);
      }

      // ============================================
      // 第 2 步: 关闭 debugger（如果已附加）
      // ============================================
      await this.safelyDetachDebugger(viewInfo);

      // ============================================
      // 第 3 步: 停止所有导航和加载
      // ============================================
      if (!viewInfo.view.webContents.isDestroyed()) {
        try {
          viewInfo.view.webContents.stop();
          console.log(`  ✓ Navigation stopped`);
        } catch (error) {
          console.warn(`  ⚠ Failed to stop navigation:`, error);
        }
      }

      // ============================================
      // 第 4 步: 销毁 WebContents（使用 setImmediate 延迟执行，避免崩溃）
      // ============================================
      await this.safelyDestroyWebContents(viewInfo);

      // ============================================
      // 第 5 步: 从池中移除并清理状态
      // ============================================
      this.deps.pool.delete(viewId);
      this.deps.stateController.deleteViewState(viewId);
      this.deps.pluginPageController.forgetView(viewId);
      if (currentPluginForView && this.deps.getActivePluginId() === currentPluginForView) {
        this.deps.setActivePluginId(null);
      }
      this.deps.clearViewportDebug(viewId);

      // ============================================
      // 第 6 步: 显式清空引用（帮助 GC）
      // ============================================
      // 注意：Electron 的 WebContentsView 没有 destroy() 方法
      // 我们只能清空引用，依赖 GC 回收
      const cleanupTarget = viewInfo as unknown as MutableWebContentsViewInfo;
      cleanupTarget.view = null;
      cleanupTarget.partition = null;
      cleanupTarget.metadata = null;

      const totalDestroyed = this.deps.stateController.markDestroyed();
      console.log(
        `✅ View cleaned up: ${viewId} (destroyed: ${totalDestroyed}, pool: ${this.deps.pool.size}/${this.deps.getMaxSize()})`
      );

      // 🆕 通知前端标签栏更新
      this.deps.notifyViewClosed(viewId);

      // 🆕 触发视图关闭回调（用于 Profile 状态同步）
      const viewClosedCallback = this.deps.getViewClosedCallback();
      if (viewClosedCallback && metadata) {
        try {
          viewClosedCallback(viewId, metadata);
        } catch (callbackError) {
          console.error(`  ⚠ viewClosedCallback error:`, callbackError);
        }
      }

      if (wasRightDocked) {
        this.deps.layoutController.handleWindowResize();
      }
    } catch (error) {
      this.deps.stateController.markFailed();
      console.error(`❌ Failed to cleanup view ${viewId}:`, error);
      throw error;
    }
  }

  /**
   * 🆕 安全地分离 debugger
   */
  private async safelyDetachDebugger(viewInfo: WebContentsViewInfo): Promise<void> {
    try {
      const { webContents } = viewInfo.view;

      this.deps.stealthController.cleanupBeforeDebuggerDetach(viewInfo.id, webContents);

      if (webContents.isDestroyed()) {
        console.log(`  ⚠ WebContents already destroyed, skipping debugger detach`);
        return;
      }

      if (webContents.debugger?.isAttached()) {
        webContents.debugger.detach();
        console.log(`  ✓ Debugger detached`);
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      // debugger.detach() 可能抛出异常，但不应阻止清理流程
      console.warn(`  ⚠ Failed to detach debugger (non-critical):`, message, error);
    }
  }

  /**
   * 🆕 安全地销毁 WebContents
   * 关键改进：使用 setImmediate 延迟执行，避免崩溃
   * 参考：Electron Issue #29626
   */
  private async safelyDestroyWebContents(viewInfo: WebContentsViewInfo): Promise<void> {
    return new Promise((resolve) => {
      try {
        const { webContents } = viewInfo.view;

        if (webContents.isDestroyed()) {
          console.log(`  ℹ WebContents already destroyed`);
          resolve();
          return;
        }

        // 关键修复：使用 setImmediate 延迟执行 destroy，避免崩溃
        // 参考：Electron Issue #29626
        // 原因：在同步上下文中立即 destroy WebContents 可能导致 Chromium 内部访问违规
        setImmediate(() => {
          try {
            if (!webContents.isDestroyed() && hasDestroyMethod(webContents)) {
              webContents.destroy();
              console.log(`  ✓ WebContents destroyed (delayed)`);
            } else if (!webContents.isDestroyed()) {
              console.warn(
                `  ⚠ WebContents.destroy() method not available in this Electron version`
              );
            }
            resolve();
          } catch (error: unknown) {
            console.warn(`  ⚠ Failed to destroy webContents:`, getErrorMessage(error), error);
            resolve(); // 继续执行，不抛出错误
          }
        });
      } catch (error: unknown) {
        console.warn(`  ⚠ Error in safelyDestroyWebContents:`, getErrorMessage(error), error);
        resolve();
      }
    });
  }

}
