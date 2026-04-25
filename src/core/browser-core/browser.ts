/**
 * SimpleBrowser - 浏览器核心实现
 *
 * 基于 Electron WebContents 的浏览器核心类。
 * 只提供最基础的浏览器能力，高级功能通过独立模块提供：
 *
 * - 元素操作: browser-automation/actions.ts
 * - 页面快照: browser-automation/snapshot.ts
 * - HTTP 拦截: browser-automation/interceptor.ts
 * - 页面分析: browser-analysis/page-analyzer.ts
 * - 登录检测: browser-analysis/login-detector.ts
 *
 * @example
 * const browser = new SimpleBrowser(viewId, webContents, viewManager);
 * await browser.goto('https://example.com');
 * const html = await browser.evaluate('document.body.innerHTML');
 */

import type { WebContents, Session } from 'electron';

// 子命名空间 API
import { BrowserNativeAPI } from './native';
import { BrowserSessionAPI } from './session';
import { BrowserCaptureAPI } from './capture';
import { BrowserCDPAPI } from './cdp';
import { bindAbortSignalToFacade } from './abort-facade';
import { createBlockedNavigationError, installWindowOpenBlocker } from './navigation-guard';
import { getSessionWebRequestHub } from './web-request-hub';
import { createChildTraceContext, getCurrentTraceContext } from '../observability/observation-context';
import { observationService } from '../observability/observation-service';

// 类型
import type { WindowOpenPolicy, WindowOpenRule, WindowOpenAction } from './types';

// 通用工具
import { BrowserLogger } from './utils';

/** 默认浏览器超时（毫秒） */
const DEFAULT_BROWSER_TIMEOUT = 30000;

/**
 * WebContentsView 管理器接口
 */
export interface ViewManager {
  closeView(viewId: string): Promise<void>;
}

/**
 * SimpleBrowser - 精简浏览器核心
 *
 * 只提供最基础的能力：
 * - 导航：goto, back, forward, reload
 * - JS 执行：evaluate, evaluateWithArgs
 * - 页面信息：url, title
 * - 底层访问：getWebContents, getSession
 * - 生命周期：reset, isClosed, closeInternal
 * - 窗口控制：show, hide
 *
 * 子命名空间：
 * - browser.native: 原生输入事件（isTrusted=true）
 * - browser.session: Cookie、存储、代理管理
 * - browser.capture: 截图、PDF 导出
 * - browser.cdp: Chrome DevTools Protocol
 */
export class SimpleBrowser {
  private disposed: boolean = false;

  // 新窗口策略
  private windowOpenPolicy: WindowOpenPolicy | null = null;

  // ========================================
  // 子命名空间
  // ========================================

  /**
   * 原生输入 API
   */
  public readonly native: BrowserNativeAPI;

  /**
   * Session API
   */
  public readonly session: BrowserSessionAPI;

  /**
   * 截图/导出 API
   */
  public readonly capture: BrowserCaptureAPI;

  /**
   * CDP (Chrome DevTools Protocol) API
   */
  public readonly cdp: BrowserCDPAPI;

  constructor(
    private viewId: string,
    private webContents: WebContents,
    private viewManager: ViewManager
  ) {
    // 初始化子命名空间
    this.native = new BrowserNativeAPI(() => this.getWebContents());
    this.session = new BrowserSessionAPI(() => this.getSession());
    this.capture = new BrowserCaptureAPI(() => this.getWebContents());
    this.cdp = new BrowserCDPAPI(() => this.getWebContents());

    this.installDefaultWindowOpenHandler();
  }

  // ========================================
  // 基础信息
  // ========================================

  /**
   * 获取视图 ID
   */
  getViewId(): string {
    return this.viewId;
  }

  /**
   * 获取当前 URL（同步）
   */
  url(): string {
    this.ensureNotDisposed();
    return this.webContents.getURL();
  }

  /**
   * 获取当前 URL（异步，兼容接口）
   */
  async getCurrentUrl(): Promise<string> {
    return this.url();
  }

  /**
   * 获取页面标题
   */
  async title(): Promise<string> {
    this.ensureNotDisposed();
    return this.webContents.getTitle();
  }

  // ========================================
  // 导航
  // ========================================

  /**
   * 导航到指定 URL
   */
  async goto(
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
    }
  ): Promise<void> {
    this.ensureNotDisposed();

    const blockedNavigationError = createBlockedNavigationError(url);
    if (blockedNavigationError) {
      BrowserLogger.warn('navigation', blockedNavigationError.message);
      const context = createChildTraceContext({
        browserEngine: 'electron',
        browserId: this.viewId,
        source: getCurrentTraceContext()?.source ?? 'browser-core',
      });
      void observationService.event({
        context,
        component: 'browser',
        event: 'browser.action.custom_protocol.blocked',
        level: 'warn',
        outcome: 'blocked',
        message: blockedNavigationError.message,
        attrs: {
          url,
          browserId: this.viewId,
          trigger: 'goto',
        },
        error: blockedNavigationError,
      });
      throw blockedNavigationError;
    }

    const timeout = options?.timeout || DEFAULT_BROWSER_TIMEOUT;
    const waitUntilOption = options?.waitUntil || 'domcontentloaded';

    BrowserLogger.debug('navigation', `Navigating to: ${url}`);

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Navigation timeout: ${url}`));
      }, timeout);

      let loadHandler: (() => void) | null = null;
      let domReadyHandler: (() => void) | null = null;
      let failHandler:
        | ((event: any, errorCode: number, errorDescription: string, validatedURL: string) => void)
        | null = null;

      const cleanup = () => {
        clearTimeout(timeoutId);
        if (loadHandler) {
          this.webContents.removeListener('did-finish-load', loadHandler);
        }
        if (domReadyHandler) {
          this.webContents.removeListener('dom-ready', domReadyHandler);
        }
        if (failHandler) {
          this.webContents.removeListener('did-fail-load', failHandler);
        }
      };

      // 监听导航失败事件
      failHandler = (
        _event: any,
        errorCode: number,
        errorDescription: string,
        validatedURL: string
      ) => {
        // ERR_ABORTED 是重定向的正常行为
        if (errorCode === -3) {
          BrowserLogger.debug(
            'navigation',
            `Navigation aborted (likely redirect): ${validatedURL}`
          );
          return;
        }

        cleanup();
        BrowserLogger.error(
          'navigation',
          `Navigation failed: ${errorDescription} (code: ${errorCode})`
        );
        reject(new Error(`Navigation failed: ${errorDescription} (code: ${errorCode})`));
      };
      this.webContents.once('did-fail-load', failHandler);

      // 设置事件监听器
      if (waitUntilOption === 'load') {
        loadHandler = () => {
          cleanup();
          BrowserLogger.success(
            'navigation',
            `Navigation completed in ${Date.now() - startTime}ms`
          );
          resolve();
        };
        this.webContents.once('did-finish-load', loadHandler);
      } else if (waitUntilOption === 'domcontentloaded') {
        domReadyHandler = () => {
          cleanup();
          BrowserLogger.success(
            'navigation',
            `Navigation completed in ${Date.now() - startTime}ms`
          );
          resolve();
        };
        this.webContents.once('dom-ready', domReadyHandler);
      }

      // 开始导航
      this.webContents
        .loadURL(url)
        .then(() => {
          if (waitUntilOption === 'networkidle0') {
            this.waitForNetworkIdle(500, 0)
              .then(() => {
                cleanup();
                resolve();
              })
              .catch((err) => {
                cleanup();
                reject(err);
              });
          } else if (waitUntilOption === 'networkidle2') {
            this.waitForNetworkIdle(500, 2)
              .then(() => {
                cleanup();
                resolve();
              })
              .catch((err) => {
                cleanup();
                reject(err);
              });
          } else if (waitUntilOption !== 'load' && waitUntilOption !== 'domcontentloaded') {
            cleanup();
            resolve();
          }
        })
        .catch((err) => {
          if (err.code === 'ERR_ABORTED' && err.errno === -3) {
            BrowserLogger.debug('navigation', `loadURL rejected with ERR_ABORTED`);
            return;
          }

          cleanup();
          reject(new Error(`Failed to start navigation: ${err.message}`));
        });
    });
  }

  /**
   * 后退
   */
  async back(): Promise<void> {
    this.ensureNotDisposed();
    if (this.webContents.canGoBack()) {
      this.webContents.goBack();
    }
  }

  /**
   * 前进
   */
  async forward(): Promise<void> {
    this.ensureNotDisposed();
    if (this.webContents.canGoForward()) {
      this.webContents.goForward();
    }
  }

  /**
   * 刷新页面
   */
  async reload(): Promise<void> {
    this.ensureNotDisposed();
    this.webContents.reload();
  }

  // ========================================
  // JavaScript 执行
  // ========================================

  /**
   * 执行 JavaScript 代码
   */
  async evaluate<T = any>(code: string): Promise<T> {
    this.ensureNotDisposed();
    return this.webContents.executeJavaScript(code);
  }

  /**
   * 执行 JavaScript 函数并传递参数
   */
  async evaluateWithArgs<T = any>(
    pageFunction: (...args: any[]) => T | Promise<T>,
    ...args: any[]
  ): Promise<T> {
    this.ensureNotDisposed();

    const funcString = pageFunction.toString();
    const serializedArgs = args.map((arg) => {
      try {
        return JSON.stringify(arg);
      } catch {
        return 'undefined';
      }
    });

    const script = `(${funcString})(${serializedArgs.join(', ')})`;
    return this.webContents.executeJavaScript(script);
  }

  // ========================================
  // 底层访问
  // ========================================

  /**
   * 获取 Session 对象
   */
  getSession(): Session {
    this.ensureNotDisposed();
    return this.webContents.session;
  }

  /**
   * 获取 WebContents 对象
   */
  getWebContents(): WebContents {
    this.ensureNotDisposed();
    return this.webContents;
  }

  /**
   * 获取当前浏览器的 partition 名称
   */
  getPartition(): string {
    const partition = this.webContents.session.storagePath;
    if (partition) {
      const match = partition.match(/Partitions[/\\](.+)$/);
      if (match) {
        return `persist:${match[1]}`;
      }
    }
    return 'default';
  }

  withAbortSignal(signal: AbortSignal): SimpleBrowser {
    return bindAbortSignalToFacade(this, {
      signal,
      label: 'simple-browser',
      onAbort: () => {
        if (this.disposed || this.webContents.isDestroyed()) {
          return;
        }
        this.webContents.stop();
      },
    });
  }

  // ========================================
  // 生命周期
  // ========================================

  /**
   * 重置浏览器状态
   */
  async reset(options?: { navigateTo?: string; clearStorage?: boolean }): Promise<void> {
    this.ensureNotDisposed();

    const targetUrl = options?.navigateTo || 'about:blank';

    if (options?.clearStorage) {
      try {
        await this.evaluate(`
            (function() {
              try { localStorage.clear(); } catch(e) {}
              try { sessionStorage.clear(); } catch(e) {}
            })()
          `);
      } catch {
        // 忽略清理失败
      }
    }

    if (targetUrl !== this.url()) {
      await this.goto(targetUrl, { timeout: 10000 });
    }
  }

  /**
   * 检查浏览器是否已关闭
   */
  isClosed(): boolean {
    return this.disposed || this.webContents.isDestroyed();
  }

  /**
   * 内部关闭方法
   */
  async closeInternal(): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      if (!this.webContents.isDestroyed()) {
        this.webContents.stop();
      }

      await this.viewManager.closeView(this.viewId);

      this.disposed = true;
    } catch (error: any) {
      this.disposed = true;
      throw error;
    }
  }

  // ========================================
  // 窗口可见性控制
  // ========================================

  /**
   * 显示浏览器窗口
   */
  async show(): Promise<void> {
    this.ensureNotDisposed();
    this.webContents.focus();
  }

  /**
   * 隐藏浏览器窗口
   */
  async hide(): Promise<void> {
    this.ensureNotDisposed();
    // 实际隐藏需要通过 viewManager
  }

  // ========================================
  // 私有方法
  // ========================================

  /**
   * 等待网络空闲
   */
  private async waitForNetworkIdle(
    idleMs: number = 500,
    maxConnections: number = 0
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const session = this.webContents.session;
      const requestHub = getSessionWebRequestHub(session);
      const currentWebContentsId = this.webContents.id;
      let inflightRequests = 0;
      let idleTimeoutId: NodeJS.Timeout | null = null;
      let isCleanedUp = false;
      let unsubscribeBeforeRequest: (() => void) | undefined;
      let unsubscribeCompleted: (() => void) | undefined;
      let unsubscribeErrorOccurred: (() => void) | undefined;

      const isCurrentWebContentsRequest = (details: any): boolean => {
        const webContentsId =
          typeof details?.webContentsId === 'number'
            ? details.webContentsId
            : typeof details?.webContents?.id === 'number'
              ? details.webContents.id
              : undefined;

        return webContentsId === undefined || webContentsId === currentWebContentsId;
      };

      const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        if (idleTimeoutId) {
          clearTimeout(idleTimeoutId);
          idleTimeoutId = null;
        }

        try {
          unsubscribeBeforeRequest?.();
          unsubscribeCompleted?.();
          unsubscribeErrorOccurred?.();
        } catch {
          // 忽略清理错误
        }
      };

      const checkIdle = () => {
        if (isCleanedUp) return;

        if (inflightRequests <= maxConnections) {
          if (idleTimeoutId) {
            clearTimeout(idleTimeoutId);
          }

          idleTimeoutId = setTimeout(() => {
            cleanup();
            resolve();
          }, idleMs);
        } else {
          if (idleTimeoutId) {
            clearTimeout(idleTimeoutId);
            idleTimeoutId = null;
          }
        }
      };

      const onBeforeRequest = (details: any, callback: any) => {
        if (isCleanedUp) {
          callback({});
          return;
        }

        if (!isCurrentWebContentsRequest(details)) {
          callback({});
          return;
        }

        inflightRequests++;

        if (idleTimeoutId) {
          clearTimeout(idleTimeoutId);
          idleTimeoutId = null;
        }

        callback({});
      };

      const onCompleted = () => {
        if (isCleanedUp) return;
        inflightRequests = Math.max(0, inflightRequests - 1);
        checkIdle();
      };

      const onErrorOccurred = () => {
        if (isCleanedUp) return;
        inflightRequests = Math.max(0, inflightRequests - 1);
        checkIdle();
      };

      try {
        unsubscribeBeforeRequest = requestHub.subscribeBeforeRequest(onBeforeRequest);
        unsubscribeCompleted = requestHub.subscribeCompleted((details) => {
          if (!isCurrentWebContentsRequest(details)) {
            return;
          }
          onCompleted();
        });
        unsubscribeErrorOccurred = requestHub.subscribeErrorOccurred((details) => {
          if (!isCurrentWebContentsRequest(details)) {
            return;
          }
          onErrorOccurred();
        });

        checkIdle();
      } catch (error: any) {
        cleanup();
        reject(new Error(`Failed to setup network idle monitoring: ${error.message}`));
      }
    });
  }

  /**
   * 确保浏览器未被销毁
   */
  ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Browser has been closed');
    }
    if (this.webContents.isDestroyed()) {
      throw new Error('WebContents has been destroyed');
    }
  }

  // ========================================
  // 新窗口拦截
  // ========================================

  /**
   * 设置新窗口打开策略
   *
   * 控制页面中 window.open() 或 target="_blank" 链接的行为。
   * 使用 Electron 原生 setWindowOpenHandler API，比 JS 注入更可靠。
   *
   * @param policy - 新窗口策略配置
   *
   * @example
   * // 所有新窗口都在当前页面打开
   * browser.setWindowOpenPolicy({ default: 'same-window' });
   *
   * @example
   * // 特定域名在当前页面打开
   * browser.setWindowOpenPolicy({
   *   default: 'deny',
   *   rules: [
   *     { match: '*jinritemai.com*', action: 'same-window' },
   *     { match: /compass\./, action: 'same-window' },
   *   ]
   * });
   *
   * @example
   * // 允许所有，但拒绝 about:blank
   * browser.setWindowOpenPolicy({
   *   default: 'allow',
   *   rules: [
   *     { match: 'about:blank', action: 'deny' },
   *   ]
   * });
   */
  setWindowOpenPolicy(policy: WindowOpenPolicy): void {
    this.ensureNotDisposed();
    this.windowOpenPolicy = policy;

    BrowserLogger.debug('window-open', `Setting window open policy: ${JSON.stringify(policy)}`);

    // 使用 Electron 原生 setWindowOpenHandler
    this.webContents.setWindowOpenHandler((details) => {
      const { url, frameName: _frameName, disposition, referrer: _referrer } = details;

      BrowserLogger.debug(
        'window-open',
        `Intercepted window.open: url=${url}, disposition=${disposition}`
      );

      const blockedNavigationError = createBlockedNavigationError(url);
      if (blockedNavigationError) {
        BrowserLogger.warn('window-open', blockedNavigationError.message);
        const context = createChildTraceContext({
          browserEngine: 'electron',
          browserId: this.viewId,
          source: getCurrentTraceContext()?.source ?? 'browser-core',
        });
        void observationService.event({
          context,
          component: 'browser',
          event: 'browser.action.custom_protocol.blocked',
          level: 'warn',
          outcome: 'blocked',
          message: blockedNavigationError.message,
          attrs: {
            url,
            browserId: this.viewId,
            trigger: 'window-open',
          },
          error: blockedNavigationError,
        });
        return { action: 'deny' };
      }

      // 匹配规则
      const action = this.matchWindowOpenRules(url, policy);

      BrowserLogger.debug('window-open', `Resolved action: ${action}`);

      switch (action) {
        case 'allow':
          // 允许打开新窗口
          return { action: 'allow' };

        case 'same-window':
          // 在当前窗口打开（异步导航）
          setImmediate(() => {
            if (!this.webContents.isDestroyed()) {
              BrowserLogger.debug('window-open', `Navigating to: ${url}`);
              this.webContents.loadURL(url).catch((err) => {
                BrowserLogger.error('window-open', `Failed to navigate: ${err.message}`);
              });
            }
          });
          return { action: 'deny' };

        case 'deny':
        default:
          // 拒绝打开
          return { action: 'deny' };
      }
    });
  }

  /**
   * 获取当前的新窗口策略
   */
  getWindowOpenPolicy(): WindowOpenPolicy | null {
    return this.windowOpenPolicy;
  }

  /**
   * 清除新窗口策略（恢复默认行为）
   */
  clearWindowOpenPolicy(): void {
    this.ensureNotDisposed();
    this.windowOpenPolicy = null;

    BrowserLogger.debug('window-open', 'Clearing window open policy');

    this.installDefaultWindowOpenHandler();
  }

  /**
   * 匹配 URL 与规则列表
   */
  private matchWindowOpenRules(url: string, policy: WindowOpenPolicy): WindowOpenAction {
    // 先检查规则列表
    if (policy.rules && policy.rules.length > 0) {
      for (const rule of policy.rules) {
        if (this.matchRule(url, rule)) {
          return rule.action;
        }
      }
    }

    // 返回默认行为
    return policy.default;
  }

  /**
   * 匹配单个规则
   */
  private matchRule(url: string, rule: WindowOpenRule): boolean {
    const { match } = rule;

    if (match instanceof RegExp) {
      // 正则匹配
      return match.test(url);
    }

    if (typeof match === 'string') {
      // 通配符匹配
      if (match.includes('*')) {
        // 转换通配符为正则表达式
        const regexPattern = match
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // 转义特殊字符
          .replace(/\*/g, '.*'); // * -> .*
        const regex = new RegExp(regexPattern, 'i');
        return regex.test(url);
      }

      // 普通字符串包含匹配（不区分大小写）
      return url.toLowerCase().includes(match.toLowerCase());
    }

    return false;
  }

  private installDefaultWindowOpenHandler(): void {
    installWindowOpenBlocker(this.webContents, {
      onBlocked: ({ protocol, url }) => {
        const blockedNavigationError = createBlockedNavigationError(url);
        if (!blockedNavigationError) {
          return;
        }

        BrowserLogger.warn('window-open', blockedNavigationError.message);
        const context = createChildTraceContext({
          browserEngine: 'electron',
          browserId: this.viewId,
          source: getCurrentTraceContext()?.source ?? 'browser-core',
        });
        void observationService.event({
          context,
          component: 'browser',
          event: 'browser.action.custom_protocol.blocked',
          level: 'warn',
          outcome: 'blocked',
          message: blockedNavigationError.message,
          attrs: {
            url,
            protocol,
            browserId: this.viewId,
            trigger: 'window-open',
            policy: 'default',
          },
          error: blockedNavigationError,
        });
      },
    });
  }
}
