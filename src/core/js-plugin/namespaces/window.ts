/**
 * Window Namespace - 窗口管理
 *
 * 提供创建模态窗口、登录窗口等功能
 */

import { BrowserWindow } from 'electron';
import type { WindowManager } from '../../../main/window-manager';
import type { WebContentsViewManager } from '../../../main/webcontentsview-manager';
import type { ProfileService } from '../../../main/duckdb/profile-service';
import { maybeOpenInternalBrowserDevTools } from '../../../main/internal-browser-devtools';
import type { FingerprintConfig } from '../../../types/profile';
import { buildStealthConfigFromFingerprint } from '../../fingerprint/fingerprint-projections';
import { getDefaultFingerprint } from '../../../main/profile/presets';
import { mergeFingerprintConfig } from '../../../constants/fingerprint-defaults';
import type { StealthConfig } from '../../stealth';
import { createBlockedNavigationError } from '../../browser-core/navigation-guard';

/**
 * 模态窗口配置
 */
export interface ModalWindowConfig {
  /** 窗口标题 */
  title: string;

  /** 要加载的 URL */
  url: string;

  /** Session partition（支持 persist:前缀，profileId 存在时会被覆盖为该 Profile 的 partition） */
  partition: string;

  /** 关联的 Profile ID（用于指纹身份绑定） */
  profileId?: string;

  /** 窗口宽度（默认：1000） */
  width?: number;

  /** 窗口高度（默认：700） */
  height?: number;

  /** 超时时间（毫秒，默认：300000 = 5分钟） */
  timeout?: number;

  /** 登录成功的URL判断条件（默认：不包含 /login 和 /passport） */
  successUrlPattern?: RegExp | string;
  /** 是否自动打开该模态窗口的 DevTools；未设置时跟随全局开关 */
  openDevTools?: boolean;
}

/**
 * 模态窗口结果
 */
export interface ModalWindowResult {
  /** 是否成功（用户完成操作） */
  success: boolean;

  /** 最终的 URL */
  finalUrl?: string;

  /** 错误信息 */
  error?: string;
}

/**
 * Window 命名空间
 *
 * 提供窗口管理相关的 API
 */
export class WindowNamespace {
  constructor(
    private pluginId: string,
    private windowManager: WindowManager,
    private viewManager: WebContentsViewManager,
    private profileService: ProfileService
  ) {}

  private async resolveProfileStealth(
    config: ModalWindowConfig
  ): Promise<{ partition: string; stealth?: StealthConfig }> {
    const profileId = config.profileId?.trim();
    if (!profileId) {
      return { partition: config.partition };
    }

    const profile = await this.profileService.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    if (config.partition && config.partition !== profile.partition) {
      console.warn(
        `[WindowNamespace] Partition mismatch for profile ${profileId}, ` +
          `requested=${config.partition}, using=${profile.partition}`
      );
    }

    const mergedFingerprint = mergeFingerprintConfig(
      getDefaultFingerprint('electron'),
      profile.fingerprint
    );

    return {
      partition: profile.partition,
      stealth: buildStealthConfigFromFingerprint(mergedFingerprint),
    };
  }

  /**
   * 打开模态窗口
   *
   * 创建一个独立的模态窗口，通常用于登录、OAuth 授权等场景。
   * 窗口会自动检测 URL 变化，当满足成功条件时自动关闭并返回。
   *
   * @param config 窗口配置
   * @returns Promise<ModalWindowResult> 窗口结果
   *
   * @example
   * // 打开登录窗口
   * const result = await helpers.window.openModal({
   *   title: '抖店登录',
   *   url: 'https://fxg.jinritemai.com/login',
   *   partition: 'persist:doudian-account-main',
   *   width: 1000,
   *   height: 700,
   *   timeout: 300000
   * });
   *
   * if (result.success) {
   *   console.log('登录成功！');
   * }
   *
   * @example
   * // 自定义成功判断条件
   * const result = await helpers.window.openModal({
   *   title: 'OAuth 授权',
   *   url: 'https://oauth.example.com/authorize',
   *   partition: 'persist:oauth-session',
   *   successUrlPattern: /callback.*code=/  // URL 包含 callback?code= 时认为成功
   * });
   */
  async openModal(config: ModalWindowConfig): Promise<ModalWindowResult> {
    console.log(`🪟 [WindowNamespace] Opening modal window for plugin: ${this.pluginId}`, config);

    const width = config.width || 1000;
    const height = config.height || 700;
    const timeout = config.timeout || 300000; // 默认5分钟
    let window: BrowserWindow | null = null;

    try {
      const resolved = await this.resolveProfileStealth(config);

      // 1. 创建模态窗口
      const activeWindow = new BrowserWindow({
        width,
        height,
        title: config.title,
        show: false, // 先隐藏，ready-to-show 时显示
        backgroundColor: '#ffffff', // 白色背景，避免闪烁
        modal: false, // 非模态，允许用户切换
        parent: this.windowManager.getMainWindowV3(),
        webPreferences: {
          partition: resolved.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
        autoHideMenuBar: true,
        minimizable: true,
        maximizable: true,
        closable: true,
      });
      window = activeWindow;

      // 2. 设置窗口显示时机：ready-to-show 事件（首次渲染完成）
      activeWindow.once('ready-to-show', () => {
        activeWindow.show();
        maybeOpenInternalBrowserDevTools(activeWindow.webContents, {
          override: config.openDevTools,
          mode: 'detach',
        });
        console.log(`  ✅ Modal window shown (ready-to-show)`);
      });

      const stealthViewId = `plugin-modal:${this.pluginId}:${Date.now()}`;
      const modalWebContents = activeWindow.webContents;
      activeWindow.once('closed', () => {
        try {
          this.viewManager.detachStealthFromWebContents(stealthViewId, modalWebContents);
        } catch (error) {
          console.warn(
            `⚠️ [WindowNamespace] Failed to detach stealth for modal window (non-critical):`,
            error
          );
        }
      });

      try {
        await this.viewManager.applyStealthToWebContents(
          stealthViewId,
          activeWindow.webContents,
          resolved.partition,
          { profileId: config.profileId, source: 'plugin', stealth: resolved.stealth }
        );
      } catch (error) {
        console.warn(`⚠️ [WindowNamespace] Failed to apply stealth for modal window:`, error);
      }

      // 3. 加载 URL（异步，不等待）
      console.log(`  🌐 Loading URL: ${config.url}`);
      const blockedNavigationError = createBlockedNavigationError(config.url);
      if (blockedNavigationError) {
        throw blockedNavigationError;
      }
      activeWindow.loadURL(config.url);

      // 4. 监听加载失败
      activeWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
        console.error(`  ❌ Failed to load URL: ${errorDescription} (code: ${errorCode})`);
      });

      // 5. 等待登录完成
      const result = await this.waitForSuccess(activeWindow, config.successUrlPattern, timeout);

      // 6. 关闭窗口
      if (!activeWindow.isDestroyed()) {
        activeWindow.close();
      }

      return result;
    } catch (error: any) {
      console.error(`❌ [WindowNamespace] Modal window error:`, error);

      // 确保关闭窗口
      if (window && !window.isDestroyed()) {
        window.close();
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 等待成功条件
   * @private
   */
  private async waitForSuccess(
    window: BrowserWindow,
    successPattern: RegExp | string | undefined,
    timeout: number
  ): Promise<ModalWindowResult> {
    return new Promise((resolve, _reject) => {
      const startTime = Date.now();
      let checkInterval: NodeJS.Timeout | null = null;
      let closedHandler: (() => void) | null = null;
      let navigateHandler: ((event: any, url: string) => void) | null = null;
      let navigateInPageHandler: ((event: any, url: string) => void) | null = null;

      // 清理函数
      const cleanup = () => {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        if (closedHandler && !window.isDestroyed()) {
          window.removeListener('closed', closedHandler);
        }
        if (navigateHandler && !window.isDestroyed()) {
          window.webContents.removeListener('did-navigate', navigateHandler);
        }
        if (navigateInPageHandler && !window.isDestroyed()) {
          window.webContents.removeListener('did-navigate-in-page', navigateInPageHandler);
        }
      };

      // 监听窗口关闭
      closedHandler = () => {
        cleanup();
        resolve({
          success: false,
          error: 'User closed the window',
        });
      };
      window.once('closed', closedHandler);

      // 监听 URL 导航（立即响应，无需等待轮询）
      navigateHandler = (event: any, url: string) => {
        if (this.checkSuccessUrl(url, successPattern)) {
          console.log(`  ✅ Success detected (did-navigate)! URL: ${url}`);
          cleanup();
          resolve({
            success: true,
            finalUrl: url,
          });
        }
      };
      window.webContents.on('did-navigate', navigateHandler);

      // 监听页面内导航（SPA 应用常用）
      navigateInPageHandler = (event: any, url: string) => {
        if (this.checkSuccessUrl(url, successPattern)) {
          console.log(`  ✅ Success detected (did-navigate-in-page)! URL: ${url}`);
          cleanup();
          resolve({
            success: true,
            finalUrl: url,
          });
        }
      };
      window.webContents.on('did-navigate-in-page', navigateInPageHandler);

      // 轮询检查 URL（后备机制，处理事件监听器未捕获的情况）
      checkInterval = setInterval(() => {
        if (window.isDestroyed()) {
          cleanup();
          resolve({
            success: false,
            error: 'Window was destroyed',
          });
          return;
        }

        // 检查超时
        if (Date.now() - startTime > timeout) {
          cleanup();
          resolve({
            success: false,
            error: 'Timeout',
          });
          return;
        }

        // 获取当前 URL
        const currentUrl = window.webContents.getURL();

        // 使用辅助方法判断是否成功
        if (this.checkSuccessUrl(currentUrl, successPattern)) {
          console.log(`  ✅ Success detected (polling)! URL: ${currentUrl}`);
          cleanup();
          resolve({
            success: true,
            finalUrl: currentUrl,
          });
        }
      }, 1000); // 每1秒检查一次（从3秒优化到1秒）

      console.log(`  ⏳ Waiting for success condition (timeout: ${timeout}ms)...`);
    });
  }

  /**
   * 检查 URL 是否匹配成功条件
   * @private
   */
  private checkSuccessUrl(url: string, successPattern: RegExp | string | undefined): boolean {
    if (successPattern) {
      // 使用自定义模式
      if (typeof successPattern === 'string') {
        return url.includes(successPattern);
      } else {
        return successPattern.test(url);
      }
    } else {
      // 默认模式：URL 不包含 /login 和 /passport
      return !url.includes('/login') && !url.includes('/passport');
    }
  }
}
