/**
 * 窗口管理器
 *
 * 管理应用中的所有 BrowserWindow 实例：
 * - 主窗口：显示 React UI，可以挂载 WebContentsView
 * - 弹窗：用于登录等需要用户交互的场景
 *
 * ## 架构特点
 * - **统一存储**: 单一 Map 存储所有窗口，key 为窗口 ID ("main", "popup-xxx")
 * - **统一 API**: getWindowById(), hasWindowById(), closeWindowById()
 * - **字符串 ID**: 灵活的命名约定，易于扩展
 * - **自动清理**: 窗口关闭时自动从存储中移除
 *
 * ## 使用示例
 * ```ts
 * // 获取主窗口
 * const mainWin = windowManager.getMainWindowV3();
 *
 * // 创建弹窗
 * const popup = windowManager.createPopupWindow('login', {
 *   title: '登录',
 *   width: 800,
 *   height: 600
 * });
 *
 * // 关闭弹窗
 * windowManager.closeWindowById('popup-login');
 *
 * // 列出所有窗口
 * const all = windowManager.listAllWindows();
 * ```
 */

import fs from 'node:fs';
import { app, BrowserWindow, Rectangle, screen } from 'electron';
import path from 'path';
import { AIRPA_RUNTIME_CONFIG, isDevelopmentMode } from '../constants/runtime-config';
import { WINDOWS_TITLEBAR_OVERLAY_HEIGHT } from '../constants/layout';
import { attachNavigationGuards } from '../core/browser-core/navigation-guard';
import { getSessionWebRequestHub } from '../core/browser-core/web-request-hub';
import {
  formatRendererBuildWarning,
  getRendererBuildFreshness,
} from './renderer-build-freshness';
import { maybeOpenInternalBrowserDevTools } from './internal-browser-devtools';

// ==================== 类型定义 ====================

/**
 * BrowserWindow 扩展类型，支持替换标记
 * 用于防止并发创建同 ID 窗口时的竞态条件
 */
interface BrowserWindowWithReplaced extends BrowserWindow {
  __replaced?: boolean;
}

// ==================== 常量定义 ====================

/** 主窗口默认宽度 */
const DEFAULT_MAIN_WINDOW_WIDTH = 1400;
/** 主窗口默认高度 */
const DEFAULT_MAIN_WINDOW_HEIGHT = 900;
/** 主窗口最小宽度 */
const MIN_MAIN_WINDOW_WIDTH = 1200;
/** 主窗口最小高度 */
const MIN_MAIN_WINDOW_HEIGHT = 700;

/** 弹窗默认宽度 */
const DEFAULT_POPUP_WIDTH = 1200;
/** 弹窗默认高度 */
const DEFAULT_POPUP_HEIGHT = 800;
/** 弹窗最小宽度 */
const MIN_POPUP_WIDTH = 800;
/** 弹窗最小高度 */
const MIN_POPUP_HEIGHT = 600;

/** Hidden automation host 默认宽度 */
const DEFAULT_HIDDEN_AUTOMATION_HOST_WIDTH = 1440;
/** Hidden automation host 默认高度 */
const DEFAULT_HIDDEN_AUTOMATION_HOST_HEIGHT = 960;

/** 窗口 resize 事件防抖延迟（毫秒） */
const WINDOW_RESIZE_DEBOUNCE_MS = 100;
const MAIN_WINDOW_DEV_SERVER_URL = `http://127.0.0.1:${AIRPA_RUNTIME_CONFIG.app.devServerPort}`;

function appendStartupDiagnostic(message: string): void {
  const line = `[${new Date().toISOString()}] [WindowManager] ${message}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup-diagnostic.log'), line);
  } catch {
    // ignore diagnostic write failures
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error || 'unknown error');
}

function buildMainWindowErrorHtml(title: string, summary: string, details: string[]): string {
  const detailItems = details
    .filter((item) => item.trim().length > 0)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", "PingFang SC", sans-serif;
        background: linear-gradient(135deg, #f5f7fb 0%, #eef2ff 100%);
        color: #1f2937;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      main {
        width: min(760px, calc(100vw - 48px));
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 20px;
        padding: 28px 32px;
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.14);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      p {
        margin: 0 0 16px;
        line-height: 1.6;
      }
      ul {
        margin: 0;
        padding-left: 20px;
        line-height: 1.7;
      }
      code {
        font-family: "Cascadia Code", "SFMono-Regular", monospace;
        background: #eef2ff;
        border-radius: 6px;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(summary)}</p>
      <ul>${detailItems}</ul>
    </main>
  </body>
</html>`;
}

// ==================== 类型定义 ====================

/**
 * 弹窗配置
 */
export interface PopupWindowConfig {
  /** 弹窗标题 */
  title?: string;
  /** 宽度，默认 1200 */
  width?: number;
  /** 高度，默认 800 */
  height?: number;
  /** 是否居中显示，默认 true */
  center?: boolean;
  /** 父窗口（用于模态效果），默认主窗口 */
  parent?: BrowserWindow;
  /** 是否模态，默认 false */
  modal?: boolean;
  /** 是否自动打开该弹窗壳窗口的 DevTools；未设置时跟随全局开关 */
  openDevTools?: boolean;
  /** 关闭时的回调 */
  onClose?: () => void;
}

export interface HiddenAutomationHostConfig {
  width?: number;
  height?: number;
  /** 是否自动打开该隐藏宿主窗口的 DevTools；未设置时跟随全局开关 */
  openDevTools?: boolean;
  onClose?: () => void;
}

export const getHiddenAutomationHostWindowId = (sessionId: string): string =>
  `hidden-host-${String(sessionId || '').trim()}`;

/**
 * 窗口信息（统一结构）
 */
export interface WindowInfoV3 {
  /** 窗口 ID - "main" 或 "popup-{id}" */
  windowId: string;
  /** Electron BrowserWindow 实例 */
  window: BrowserWindow;
  /** 是否可见 */
  visible: boolean;
  /** 创建时间戳 */
  createdAt: number;
  /** 关联的 WebContentsView ID（可选，仅弹窗使用） */
  viewId?: string;
  /** 关闭回调（可选，仅弹窗使用） */
  onClose?: () => void;
}

/**
 * 窗口管理器
 *
 * ## 存储架构
 * - 统一存储: `windows` Map，key 为窗口 ID
 * - 主窗口 ID: "main"
 * - 弹窗 ID: "popup-{id}"
 *
 * ## 资源管理
 * - 主窗口: 单例，应用启动时创建
 * - 弹窗: 多实例，动态创建/销毁
 * - 回调: 仅主窗口支持 resize 回调
 *
 * ## 生命周期
 * 1. 创建: createMainWindow() / createPopupWindow()
 * 2. 使用: getWindowById() / getMainWindowV3() / getPopupWindowV3()
 * 3. 关闭: closeWindowById() / window.close()
 * 4. 清理: 自动从 windows Map 移除 (closed 事件)
 */
export class WindowManager {
  /**
   * 统一窗口存储
   * - 主窗口: "main"
   * - 弹窗: "popup-{id}"
   */
  private windows: Map<string, WindowInfoV3> = new Map();

  /**
   * 主窗口 resize 回调
   * 只有主窗口需要 resize callbacks
   */
  private mainWindowResizeCallbacks: ((bounds: Rectangle) => void)[] = [];

  /**
   * 创建主窗口（可见，显示 React UI）
   */
  createMainWindow(): BrowserWindow {
    if (this.windows.has('main')) {
      throw new Error('Main window already exists');
    }

    const window = new BrowserWindow({
      width: DEFAULT_MAIN_WINDOW_WIDTH,
      height: DEFAULT_MAIN_WINDOW_HEIGHT,
      minWidth: MIN_MAIN_WINDOW_WIDTH,
      minHeight: MIN_MAIN_WINDOW_HEIGHT,
      backgroundColor: '#f1f3f7',
      autoHideMenuBar: true,
      show: false, // 等待加载完成后再显示
      ...(process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: '#f1f3f7',
              symbolColor: '#4f596d',
              height: WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
            },
          }
        : {}),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      title: 'TiansheAI',
    });

    const requestHub = getSessionWebRequestHub(window.webContents.session);
    const detachNavigationGuards = attachNavigationGuards(window.webContents, {
      onBlocked: ({ eventName, protocol, url }) => {
        appendStartupDiagnostic(
          `main window blocked ${eventName} for unsupported protocol ${protocol}: ${url}`
        );
      },
    });

    // 设置 CSP (Content Security Policy)
    // 开发模式保留 HMR 所需来源，但避免使用 unsafe-eval 以消除 Electron 安全告警
    // 生产构建继续使用更严格策略
    const unsubscribeCspHeaders = requestHub.subscribeHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            isDevelopmentMode()
              ? `default-src 'self'; script-src 'self' 'unsafe-inline' http://127.0.0.1:${AIRPA_RUNTIME_CONFIG.app.devServerPort}; style-src 'self' 'unsafe-inline' http://127.0.0.1:${AIRPA_RUNTIME_CONFIG.app.devServerPort}; connect-src 'self' http://127.0.0.1:${AIRPA_RUNTIME_CONFIG.app.devServerPort} ws://127.0.0.1:${AIRPA_RUNTIME_CONFIG.app.devServerPort}; img-src 'self' data: https: http://127.0.0.1:${AIRPA_RUNTIME_CONFIG.app.devServerPort};`
              : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;",
          ],
        },
      });
    });

    // 移除图片请求的Referer头，绕过防盗链检查
    // 这样可以加载阿里云CDN等有防盗链限制的图片
    const unsubscribeImageHeaders = requestHub.subscribeBeforeSendHeaders((details, callback) => {
      const isImageRequest =
        details.resourceType === 'image' ||
        /\.(jpg|jpeg|png|gif|bmp|webp|svg|ico)$/i.test(details.url);

      if (isImageRequest) {
        // 移除Referer和Origin头
        const {
          _referer,
          origin: _origin,
          Referer: _Referer,
          Origin: _Origin,
          ...newHeaders
        } = details.requestHeaders;

        callback({
          requestHeaders: newHeaders,
        });
      } else {
        callback({ requestHeaders: details.requestHeaders });
      }
    });

    this.attachMainWindowDiagnostics(window);
    void this.loadMainWindowContent(window);

    // 窗口加载完成后显示
    window.once('ready-to-show', () => {
      window.show();
    });

    // 窗口关闭事件
    window.on('closed', () => {
      detachNavigationGuards();
      unsubscribeCspHeaders();
      unsubscribeImageHeaders();
      this.windows.delete('main');
      console.log('✅ Main window closed');
    });

    // 设置尺寸变化事件监听器（resize + 全屏）
    this.setupMainWindowSizeChangeListeners(window);

    // 记录窗口信息
    const windowInfo: WindowInfoV3 = {
      windowId: 'main',
      window,
      visible: true,
      createdAt: Date.now(),
    };
    this.windows.set('main', windowInfo);

    console.log('✅ Main window created');

    return window;
  }

  private attachMainWindowDiagnostics(window: BrowserWindow): void {
    window.webContents.on('console-message', (details) => {
      if (details.level !== 'warning' && details.level !== 'error') {
        return;
      }

      appendStartupDiagnostic(
        `main window console-${details.level} source=${details.sourceId || 'unknown'} line=${details.lineNumber} message=${details.message}`
      );
    });

    window.webContents.on('dom-ready', () => {
      appendStartupDiagnostic(`main window dom-ready url=${window.webContents.getURL()}`);
    });

    window.webContents.on('did-finish-load', () => {
      appendStartupDiagnostic(`main window did-finish-load url=${window.webContents.getURL()}`);
    });

    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame === false) {
          return;
        }
        appendStartupDiagnostic(
          `main window did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL}`
        );
      }
    );

    window.webContents.on('render-process-gone', (_event, details) => {
      appendStartupDiagnostic(
        `main window render-process-gone reason=${details.reason} exitCode=${details.exitCode}`
      );
    });

    window.on('unresponsive', () => {
      appendStartupDiagnostic('main window became unresponsive');
    });
  }

  private async loadMainWindowContent(window: BrowserWindow): Promise<void> {
    const rendererIndexPath = path.join(__dirname, '../renderer/index.html');
    const rendererFreshness = getRendererBuildFreshness();
    const rendererWarning = formatRendererBuildWarning(rendererFreshness);

    if (isDevelopmentMode()) {
      appendStartupDiagnostic(`attempting renderer dev server load from ${MAIN_WINDOW_DEV_SERVER_URL}`);
      try {
        await window.loadURL(MAIN_WINDOW_DEV_SERVER_URL);
        appendStartupDiagnostic(`renderer dev server loaded from ${MAIN_WINDOW_DEV_SERVER_URL}`);
        maybeOpenInternalBrowserDevTools(window.webContents);
        return;
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        appendStartupDiagnostic(`renderer dev server load failed: ${errorMessage}`);

        if (fs.existsSync(rendererIndexPath) && rendererFreshness.ok) {
          appendStartupDiagnostic(`falling back to renderer dist: ${rendererIndexPath}`);
          try {
            await window.loadFile(rendererIndexPath);
            appendStartupDiagnostic(`renderer dist fallback loaded: ${rendererIndexPath}`);
            maybeOpenInternalBrowserDevTools(window.webContents);
            return;
          } catch (fallbackError) {
            appendStartupDiagnostic(
              `renderer dist fallback failed: ${toErrorMessage(fallbackError)}`
            );
          }
        }

        await this.loadMainWindowErrorPage(window, {
          title: 'Renderer failed to load',
          summary:
            'The app started, but the renderer UI could not be loaded from the Vite dev server or a usable local dist build.',
          details: [
            `Dev server URL: ${MAIN_WINDOW_DEV_SERVER_URL}`,
            `Dev server error: ${errorMessage}`,
            rendererWarning ||
              'Renderer dist fallback is unavailable. Run `npm run build:renderer` or start the Vite dev server with `npm run dev`.',
            `Expected dist entry: ${rendererIndexPath}`,
          ],
        });
        return;
      }
    }

    try {
      await window.loadFile(rendererIndexPath);
      appendStartupDiagnostic(`renderer dist loaded: ${rendererIndexPath}`);
      maybeOpenInternalBrowserDevTools(window.webContents);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      appendStartupDiagnostic(`renderer dist load failed: ${errorMessage}`);
      await this.loadMainWindowErrorPage(window, {
        title: 'Renderer dist is unavailable',
        summary: 'The main process started, but the packaged renderer entry could not be opened.',
        details: [
          `Expected dist entry: ${rendererIndexPath}`,
          `Load error: ${errorMessage}`,
          rendererWarning || 'Run `npm run build:renderer` before launching Electron directly.',
        ],
      });
    }
  }

  private async loadMainWindowErrorPage(
    window: BrowserWindow,
    payload: { title: string; summary: string; details: string[] }
  ): Promise<void> {
    const html = buildMainWindowErrorHtml(payload.title, payload.summary, payload.details);
    try {
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      maybeOpenInternalBrowserDevTools(window.webContents);
    } catch (error) {
      appendStartupDiagnostic(`failed to load renderer error page: ${toErrorMessage(error)}`);
    }
  }

  /**
   * 清理所有窗口
   */
  cleanup(): void {
    // 清理 resize 回调数组，防止内存泄漏
    this.mainWindowResizeCallbacks = [];

    // 关闭所有 hidden automation host
    this.closeAllHiddenAutomationHosts();

    // 关闭所有弹窗
    this.closeAllPopups();

    // 关闭主窗口
    this.closeWindowById('main');

    console.log('✅ All windows cleaned up');
  }

  // =====================================================
  // 弹窗管理方法
  // =====================================================

  /**
   * 创建弹窗窗口（用于登录等需要用户交互的场景）
   *
   * @param popupId 弹窗唯一标识
   * @param config 弹窗配置
   * @returns 弹窗窗口
   *
   * @example
   * const popup = windowManager.createPopupWindow('login-123', {
   *   title: '登录 - example.com',
   *   width: 1200,
   *   height: 800,
   *   onClose: () => { console.log('弹窗已关闭'); }
   * });
   */
  createPopupWindow(popupId: string, config?: PopupWindowConfig): BrowserWindow {
    const windowId = `popup-${popupId}`;

    // 如果已存在同 ID 的弹窗，立即从 Map 删除并标记为"已被替换"
    const existingInfo = this.windows.get(windowId);
    if (existingInfo) {
      console.log(`ℹ️  Popup ${popupId} already exists, replacing it`);

      // 立即从 Map 删除，防止竞态条件
      this.windows.delete(windowId);

      // 标记旧窗口：防止其 'closed' 事件错误删除新窗口
      (existingInfo.window as BrowserWindowWithReplaced).__replaced = true;

      // 关闭旧窗口（异步）
      if (!existingInfo.window.isDestroyed()) {
        existingInfo.window.close();
      }
    }

    const mainWindow = this.getMainWindowV3();
    const parent = config?.parent || mainWindow;

    // 计算窗口位置（居中于父窗口或屏幕）
    const width = config?.width || DEFAULT_POPUP_WIDTH;
    const height = config?.height || DEFAULT_POPUP_HEIGHT;
    let x: number | undefined;
    let y: number | undefined;

    if (config?.center !== false) {
      if (parent && !parent.isDestroyed()) {
        // 居中于父窗口
        const parentBounds = parent.getBounds();
        x = Math.max(0, Math.round(parentBounds.x + (parentBounds.width - width) / 2));
        y = Math.max(0, Math.round(parentBounds.y + (parentBounds.height - height) / 2));
      } else {
        // 居中于屏幕
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        x = Math.round((screenWidth - width) / 2);
        y = Math.round((screenHeight - height) / 2);
      }
    }

    const popupWindow = new BrowserWindow({
      width,
      height,
      x,
      y,
      minWidth: MIN_POPUP_WIDTH,
      minHeight: MIN_POPUP_HEIGHT,
      show: true, // 立即显示
      parent: config?.modal ? parent : undefined,
      modal: config?.modal || false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      title: config?.title || 'Browser',
      // 窗口样式
      frame: true, // 显示标题栏
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
    });
    const detachPopupNavigationGuards = attachNavigationGuards(popupWindow.webContents);

    // 加载空白页（WebContentsView 会覆盖这个）
    void popupWindow.loadURL('about:blank');
    maybeOpenInternalBrowserDevTools(popupWindow.webContents, {
      override: config?.openDevTools,
    });

    // 窗口关闭事件
    popupWindow.on('closed', () => {
      detachPopupNavigationGuards();
      // 检查窗口是否已被替换（防止竞态条件）
      if ((popupWindow as BrowserWindowWithReplaced).__replaced) {
        console.log(`ℹ️  Popup ${popupId} was replaced, skipping cleanup`);
        return;
      }

      // 获取信息并执行回调
      const popupInfo = this.windows.get(windowId);
      if (popupInfo?.onClose) {
        try {
          popupInfo.onClose();
        } catch (error) {
          console.error(`❌ Error in popup onClose callback:`, error);
        }
      }
      // 从存储删除
      this.windows.delete(windowId);
      console.log(`✅ Popup window closed: ${popupId}`);
    });

    // 记录弹窗信息
    const popupInfo: WindowInfoV3 = {
      windowId: `popup-${popupId}`,
      window: popupWindow,
      visible: true,
      createdAt: Date.now(),
      onClose: config?.onClose,
    };
    this.windows.set(`popup-${popupId}`, popupInfo);

    console.log(`✅ Popup window created: ${popupId} (${width}x${height})`);

    return popupWindow;
  }

  createHiddenAutomationHost(
    sessionId: string,
    config?: HiddenAutomationHostConfig
  ): BrowserWindow {
    const windowId = getHiddenAutomationHostWindowId(sessionId);
    const existing = this.windows.get(windowId);
    if (existing && !existing.window.isDestroyed()) {
      return existing.window;
    }

    const width = Math.max(320, Math.round(config?.width || DEFAULT_HIDDEN_AUTOMATION_HOST_WIDTH));
    const height = Math.max(240, Math.round(config?.height || DEFAULT_HIDDEN_AUTOMATION_HOST_HEIGHT));

    const hostWindow = new BrowserWindow({
      width,
      height,
      minWidth: width,
      minHeight: height,
      show: false,
      paintWhenInitiallyHidden: true,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      closable: true,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: '#0b1020',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
      title: `Automation Host - ${sessionId}`,
    });
    const detachHostNavigationGuards = attachNavigationGuards(hostWindow.webContents);

    void hostWindow.loadURL('about:blank');
    maybeOpenInternalBrowserDevTools(hostWindow.webContents, {
      override: config?.openDevTools,
    });

    hostWindow.on('closed', () => {
      detachHostNavigationGuards();
      const hostInfo = this.windows.get(windowId);
      if (hostInfo?.onClose) {
        try {
          hostInfo.onClose();
        } catch (error) {
          console.error(`❌ Error in hidden automation host onClose callback:`, error);
        }
      }
      this.windows.delete(windowId);
      console.log(`✅ Hidden automation host closed: ${windowId}`);
    });

    this.windows.set(windowId, {
      windowId,
      window: hostWindow,
      visible: false,
      createdAt: Date.now(),
      onClose: config?.onClose,
    });

    console.log(`✅ Hidden automation host created: ${windowId} (${width}x${height})`);
    return hostWindow;
  }

  getHiddenAutomationHost(sessionId: string): BrowserWindow | undefined {
    return this.getWindowById(getHiddenAutomationHostWindowId(sessionId));
  }

  closeHiddenAutomationHost(sessionId: string): void {
    this.closeWindowById(getHiddenAutomationHostWindowId(sessionId));
  }

  closeAllHiddenAutomationHosts(): void {
    const hiddenHostIds = Array.from(this.windows.keys()).filter((id) =>
      id.startsWith('hidden-host-')
    );
    for (const windowId of hiddenHostIds) {
      this.closeWindowById(windowId);
    }
  }

  /**
   * 设置弹窗关联的 viewId
   */
  setPopupViewId(popupId: string, viewId: string): void {
    const info = this.windows.get(`popup-${popupId}`);
    if (info) {
      info.viewId = viewId;
    }
  }

  /**
   * 根据 viewId 查找弹窗窗口 ID
   * @returns 弹窗的完整 windowId (e.g., "popup-xxx") 或 undefined
   */
  findPopupIdByViewId(viewId: string): string | undefined {
    for (const info of this.windows.values()) {
      if (info.windowId.startsWith('popup-') && info.viewId === viewId) {
        return info.windowId;
      }
    }
    return undefined;
  }

  /**
   * 通过 popup ID 关闭弹窗（快捷方法）
   * @param popupId 弹窗 ID（不带 "popup-" 前缀）
   */
  closePopupById(popupId: string): void {
    this.closeWindowById(`popup-${popupId}`);
  }

  /**
   * 关闭所有弹窗
   */
  closeAllPopups(): void {
    const popupIds = Array.from(this.windows.keys()).filter((id) => id.startsWith('popup-'));

    for (const windowId of popupIds) {
      this.closeWindowById(windowId);
    }
  }

  /**
   * 设置主窗口尺寸变化事件监听器（包括 resize、全屏切换等，带防抖）
   * @param window 主窗口 BrowserWindow 实例
   */
  private setupMainWindowSizeChangeListeners(window: BrowserWindow): void {
    let resizeTimeout: NodeJS.Timeout | null = null;
    let settleTimeout: NodeJS.Timeout | null = null;

    // 统一的尺寸变化处理函数（带防抖）
    const handleSizeChange = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        // 防御性检查：窗口可能已销毁
        if (window.isDestroyed()) {
          console.log(`⚠️  Window already destroyed, skipping resize callback`);
          return;
        }

        // WebContentsView 的布局计算应基于 contentBounds（相对 contentView）
        const bounds = window.getContentBounds();

        // 触发所有注册的回调
        this.mainWindowResizeCallbacks.forEach((callback) => {
          try {
            callback(bounds);
          } catch (error) {
            console.error(`❌ Error in main window resize callback:`, error);
          }
        });

        console.log(`🔄 Main window size changed, new bounds:`, bounds);
      }, WINDOW_RESIZE_DEBOUNCE_MS);
    };

    /**
     * 某些平台/窗口管理器下，maximize/全屏切换可能在事件触发后还有动画/延迟，
     * 第一次取到的 bounds 仍然是旧值。这里做一次“落地后再同步”的补偿触发。
     */
    const handleSizeChangeWithSettle = () => {
      handleSizeChange();
      if (settleTimeout) clearTimeout(settleTimeout);
      settleTimeout = setTimeout(() => {
        handleSizeChange();
      }, WINDOW_RESIZE_DEBOUNCE_MS + 350);
    };

    // 清理函数：清除定时器
    const cleanup = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
        resizeTimeout = null;
        console.log(`🧹 Resize timer cleaned up`);
      }
      if (settleTimeout) {
        clearTimeout(settleTimeout);
        settleTimeout = null;
      }
    };

    // 监听 resize 事件（窗口尺寸变化）
    // 使用 settle 版本以覆盖 “maximize/unmaximize 只触发一次 resize 但 bounds 还没落地” 的情况
    window.on('resize', handleSizeChangeWithSettle);

    // 监听 resized 事件（窗口完成尺寸变化）
    // 在某些平台/WM 下，maximize/unmaximize 结束后更可靠地拿到最终 bounds
    window.on('resized', handleSizeChangeWithSettle);

    // 监听进入全屏事件
    window.on('enter-full-screen', handleSizeChangeWithSettle);

    // 监听退出全屏事件
    window.on('leave-full-screen', handleSizeChangeWithSettle);

    // 监听最大化事件（Windows 上点击最大化按钮）
    window.on('maximize', handleSizeChangeWithSettle);

    // 监听取消最大化事件
    window.on('unmaximize', handleSizeChangeWithSettle);

    // 窗口关闭时清理定时器
    window.once('closed', cleanup);

    console.log(
      `✅ Main window size change listeners setup (resize + resized + full-screen + maximize)`
    );
  }

  // =====================================================
  // 统一 API
  // =====================================================

  /**
   * 通过窗口 ID 获取窗口
   * @param windowId 窗口 ID (e.g., "main", "popup-login")
   * @returns BrowserWindow 实例或 undefined
   */
  getWindowById(windowId: string): BrowserWindow | undefined {
    const info = this.windows.get(windowId);
    return info?.window;
  }

  /**
   * 检查窗口是否存在
   * @param windowId 窗口 ID
   * @returns 是否存在
   */
  hasWindowById(windowId: string): boolean {
    return this.windows.has(windowId);
  }

  /**
   * 通过窗口 ID 关闭窗口
   * @param windowId 窗口 ID
   */
  closeWindowById(windowId: string): void {
    const info = this.windows.get(windowId);
    if (info && !info.window.isDestroyed()) {
      info.window.close();
    }
  }

  /**
   * 列出所有窗口
   * @returns 所有窗口信息数组
   */
  listAllWindows(): WindowInfoV3[] {
    return Array.from(this.windows.values());
  }

  /**
   * 注册主窗口 resize 回调
   * @param callback 回调函数，接收新的窗口边界
   * @returns 清理函数，用于取消注册回调
   */
  registerMainWindowResizeCallback(callback: (bounds: Rectangle) => void): () => void {
    this.mainWindowResizeCallbacks.push(callback);
    console.log('✅ Registered resize callback for main window');

    // 返回清理函数
    return () => {
      const index = this.mainWindowResizeCallbacks.indexOf(callback);
      if (index > -1) {
        this.mainWindowResizeCallbacks.splice(index, 1);
        console.log('✅ Unregistered resize callback for main window');
      }
    };
  }

  /**
   * 获取主窗口（快捷方法）
   * @returns 主窗口实例或 undefined
   */
  getMainWindowV3(): BrowserWindow | undefined {
    return this.getWindowById('main');
  }

  /**
   * 通过 popup ID 获取弹窗（快捷方法）
   * @param popupId 弹窗 ID (不带 "popup-" 前缀)
   * @returns 弹窗实例或 undefined
   */
  getPopupWindowV3(popupId: string): BrowserWindow | undefined {
    return this.getWindowById(`popup-${popupId}`);
  }

  /**
   * 列出所有弹窗
   * @returns 所有弹窗信息数组
   */
  listAllPopupsV3(): WindowInfoV3[] {
    return Array.from(this.windows.values()).filter((info) => info.windowId.startsWith('popup-'));
  }

  listAllHiddenAutomationHosts(): WindowInfoV3[] {
    return Array.from(this.windows.values()).filter((info) =>
      info.windowId.startsWith('hidden-host-')
    );
  }
}
