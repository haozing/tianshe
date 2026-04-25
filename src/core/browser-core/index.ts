/**
 * browser-core - 浏览器核心模块
 *
 * 提供浏览器最基础的能力，被 js-plugin 和 ai-dev 共同使用。
 *
 * 模块结构：
 * - browser.ts: SimpleBrowser 核心类（导航、JS执行、页面信息、生命周期）
 * - native.ts: 原生输入 API（isTrusted=true 事件）
 * - session.ts: Session 管理 API（Cookie、代理）
 * - capture.ts: 截图/PDF 导出 API
 * - cdp.ts: Chrome DevTools Protocol API
 * - capture-manager.ts: 网络/控制台捕获管理器
 * - types.ts: 类型定义
 * - utils.ts: 工具函数
 *
 * 扩展功能请使用：
 * - browser-automation: 快照、元素操作、HTTP拦截
 * - browser-analysis: 页面分析、登录检测
 */

// ========================================
// 核心类
// ========================================

export { SimpleBrowser } from './browser';
export type { ViewManager } from './browser';

// ========================================
// 子命名空间 API
// ========================================

export { BrowserNativeAPI } from './native';
export type { NativeClickOptions, NativeTypeOptions, NativeDragOptions } from './native';

export { BrowserSessionAPI } from './session';

export { BrowserCaptureAPI } from './capture';
export type { ScreenshotOptions as CaptureScreenshotOptions, PDFOptions } from './capture';

export { BrowserCDPAPI } from './cdp';
export type { CDPEventCleanup } from './cdp';

// ========================================
// 捕获管理器
// ========================================

export { NetworkCaptureManager, ConsoleCaptureManager } from './capture-manager';
export { getSessionWebRequestHub, SessionWebRequestHub } from './web-request-hub';
export type { WebRequestFilter } from './web-request-hub';

// ========================================
// 类型定义
// ========================================

export type {
  PageSnapshot,
  SnapshotElement,
  NetworkEntry,
  ConsoleMessage,
  SnapshotOptions,
  ClickOptions,
  TypeOptions,
  WaitForSelectorOptions,
  NetworkCaptureOptions,
  Cookie,
  // 新窗口拦截
  WindowOpenPolicy,
  WindowOpenRule,
  WindowOpenAction,
  WindowOpenDetails,
} from './types';

// ========================================
// 工具函数和错误类
// ========================================

export {
  CircularBuffer,
  waitUntil,
  sleep,
  BrowserLogger,
  BrowserError,
  NavigationTimeoutError,
  ElementNotFoundError,
  WaitForSelectorTimeoutError,
  WaitForResponseTimeoutError,
  WaitForLoginTimeoutError,
  BrowserClosedError,
  WebContentsDestroyedError,
} from './utils';

export type { LogLevel, WaitUntilOptions } from './utils';
