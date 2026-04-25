/**
 * 浏览器核心通用工具模块
 *
 * 提供以下通用工具：
 * - CircularBuffer: FIFO 缓冲管理（用于网络监控、控制台监控等）
 * - waitUntil: 通用轮询等待函数
 * - sleep: 统一的睡眠函数
 * - BrowserLogger: 统一的日志系统（基于核心 pino logger）
 */

import { CoreError } from '../errors/BaseError';
import { createLogger, Logger } from '../logger';

/**
 * 环形缓冲区（FIFO）
 *
 * 用于管理固定大小的数据缓冲，自动移除最旧的数据。
 * 替代了 networkEntries 和 consoleMessages 中的重复缓冲管理逻辑。
 *
 * @example
 * const buffer = new CircularBuffer<NetworkEntry>(1000);
 * buffer.push(entry);
 * const allEntries = buffer.getAll();
 * buffer.clear();
 */
export class CircularBuffer<T> {
  private items: T[] = [];
  private _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
  }

  /**
   * 添加元素（自动移除最旧的元素以保持大小限制）
   */
  push(item: T): void {
    // 使用 FIFO 策略移除旧记录
    while (this.items.length >= this._maxSize) {
      this.items.shift();
    }
    this.items.push(item);
  }

  /**
   * 获取所有元素（返回副本）
   */
  getAll(): T[] {
    return [...this.items];
  }

  /**
   * 查找元素
   */
  find(predicate: (item: T) => boolean): T | undefined {
    return this.items.find(predicate);
  }

  /**
   * 过滤元素
   */
  filter(predicate: (item: T) => boolean): T[] {
    return this.items.filter(predicate);
  }

  /**
   * 遍历元素
   */
  forEach(callback: (item: T) => void): void {
    this.items.forEach(callback);
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.items = [];
  }

  /**
   * 获取当前元素数量
   */
  get length(): number {
    return this.items.length;
  }

  /**
   * 获取最大容量
   */
  get maxSize(): number {
    return this._maxSize;
  }

  /**
   * 设置最大容量
   */
  set maxSize(value: number) {
    this._maxSize = value;
    // 如果当前元素超过新的最大容量，移除多余的旧元素
    while (this.items.length > this._maxSize) {
      this.items.shift();
    }
  }
}

/**
 * 轮询等待选项
 */
export interface WaitUntilOptions {
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number;
  /** 轮询间隔（毫秒），默认 100 */
  interval?: number;
  /** 超时错误消息 */
  timeoutMessage?: string;
}

/**
 * 通用轮询等待函数
 *
 * 替代了 waitForSelector、waitForResponse、waitForLogin 中的重复轮询逻辑。
 *
 * @param check 检查函数，返回 truthy 值表示条件满足
 * @param options 等待选项
 * @returns 检查函数的返回值
 * @throws 超时时抛出错误
 *
 * @example
 * // 等待元素出现
 * const element = await waitUntil(
 *   () => document.querySelector('#target'),
 *   { timeout: 5000, timeoutMessage: 'Element not found' }
 * );
 *
 * @example
 * // 等待条件满足
 * await waitUntil(
 *   async () => {
 *     const cookies = await browser.getCookies();
 *     return cookies.find(c => c.name === 'auth_token');
 *   },
 *   { timeout: 30000 }
 * );
 */
export async function waitUntil<T>(
  check: () => T | Promise<T>,
  options?: WaitUntilOptions
): Promise<NonNullable<T>> {
  const timeout = options?.timeout ?? 30000;
  const interval = options?.interval ?? 100;
  const timeoutMessage = options?.timeoutMessage ?? `Timeout after ${timeout}ms`;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await check();
    if (result) {
      return result as NonNullable<T>;
    }
    await sleep(interval);
  }

  throw new Error(timeoutMessage);
}

/**
 * 睡眠函数
 *
 * 统一的睡眠实现，替代各个类中的私有 sleep 方法。
 *
 * @param ms 睡眠时间（毫秒）
 *
 * @example
 * await sleep(1000); // 睡眠 1 秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 日志级别
 */
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * 浏览器日志管理器
 *
 * 统一的日志系统，基于核心 pino logger 实现。
 * 保持原有 API 的同时，使用结构化日志输出。
 *
 * @example
 * BrowserLogger.debug('navigation', 'Navigating to:', url);
 * BrowserLogger.info('snapshot', 'Page snapshot taken');
 */
export class BrowserLogger {
  /** 分类日志器缓存 */
  private static loggers: Map<string, Logger> = new Map();

  /**
   * 获取或创建分类日志器
   */
  private static getLogger(category: string): Logger {
    let logger = BrowserLogger.loggers.get(category);
    if (!logger) {
      logger = createLogger(`Browser:${category}`);
      BrowserLogger.loggers.set(category, logger);
    }
    return logger;
  }

  /**
   * 错误级别日志
   */
  static error(category: string, message: string, ...args: any[]): void {
    const logger = BrowserLogger.getLogger(category);
    logger.error(message, args.length > 0 ? args : undefined);
  }

  /**
   * 警告级别日志
   */
  static warn(category: string, message: string, ...args: any[]): void {
    const logger = BrowserLogger.getLogger(category);
    logger.warn(message, args.length > 0 ? args : undefined);
  }

  /**
   * 信息级别日志
   */
  static info(category: string, message: string, ...args: any[]): void {
    const logger = BrowserLogger.getLogger(category);
    logger.info(message, args.length > 0 ? args : undefined);
  }

  /**
   * 调试级别日志
   */
  static debug(category: string, message: string, ...args: any[]): void {
    const logger = BrowserLogger.getLogger(category);
    logger.debug(message, args.length > 0 ? args : undefined);
  }

  /**
   * 追踪级别日志（映射到 debug）
   */
  static trace(category: string, message: string, ...args: any[]): void {
    const logger = BrowserLogger.getLogger(category);
    logger.debug(`[TRACE] ${message}`, args.length > 0 ? args : undefined);
  }

  /**
   * 成功消息（使用 info 级别）
   */
  static success(category: string, message: string, ...args: any[]): void {
    const logger = BrowserLogger.getLogger(category);
    logger.info(`✓ ${message}`, args.length > 0 ? args : undefined);
  }

  /**
   * 清除日志器缓存（用于测试）
   */
  static clearLoggers(): void {
    BrowserLogger.loggers.clear();
  }
}

/**
 * 浏览器错误基类
 *
 * 用于类型化错误处理，继承自 CoreError。
 */
export class BrowserError extends CoreError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(code, message, details, { component: 'Browser' });
    this.name = 'BrowserError';
    Object.setPrototypeOf(this, BrowserError.prototype);
  }

  override isRetryable(): boolean {
    const retryableCodes = [
      'NAVIGATION_TIMEOUT',
      'WAIT_FOR_SELECTOR_TIMEOUT',
      'WAIT_FOR_RESPONSE_TIMEOUT',
    ];
    return retryableCodes.includes(this.code);
  }
}

/**
 * 导航超时错误
 */
export class NavigationTimeoutError extends BrowserError {
  constructor(url: string, timeout: number) {
    super(`Navigation timeout after ${timeout}ms: ${url}`, 'NAVIGATION_TIMEOUT', { url, timeout });
    this.name = 'NavigationTimeoutError';
    Object.setPrototypeOf(this, NavigationTimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * 元素未找到错误
 */
export class ElementNotFoundError extends BrowserError {
  constructor(selector: string) {
    super(`Element not found: ${selector}`, 'ELEMENT_NOT_FOUND', { selector });
    this.name = 'ElementNotFoundError';
    Object.setPrototypeOf(this, ElementNotFoundError.prototype);
  }
}

/**
 * 选择器等待超时错误
 */
export class WaitForSelectorTimeoutError extends BrowserError {
  constructor(selector: string, state: string, timeout: number) {
    super(
      `Timeout waiting for selector: ${selector} (state: ${state})`,
      'WAIT_FOR_SELECTOR_TIMEOUT',
      { selector, state, timeout }
    );
    this.name = 'WaitForSelectorTimeoutError';
    Object.setPrototypeOf(this, WaitForSelectorTimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * 网络响应等待超时错误
 */
export class WaitForResponseTimeoutError extends BrowserError {
  constructor(urlPattern: string, timeout: number) {
    super(`Timeout waiting for response: ${urlPattern}`, 'WAIT_FOR_RESPONSE_TIMEOUT', {
      urlPattern,
      timeout,
    });
    this.name = 'WaitForResponseTimeoutError';
    Object.setPrototypeOf(this, WaitForResponseTimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * 登录等待超时错误
 */
export class WaitForLoginTimeoutError extends BrowserError {
  constructor(timeout: number) {
    super(`Login timeout after ${timeout}ms`, 'WAIT_FOR_LOGIN_TIMEOUT', { timeout });
    this.name = 'WaitForLoginTimeoutError';
    Object.setPrototypeOf(this, WaitForLoginTimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * 浏览器已关闭错误
 */
export class BrowserClosedError extends BrowserError {
  constructor() {
    super('Browser has been closed', 'BROWSER_CLOSED', undefined);
    this.name = 'BrowserClosedError';
    Object.setPrototypeOf(this, BrowserClosedError.prototype);
  }
}

/**
 * WebContents 已销毁错误
 */
export class WebContentsDestroyedError extends BrowserError {
  constructor() {
    super('WebContents has been destroyed', 'WEBCONTENTS_DESTROYED', undefined);
    this.name = 'WebContentsDestroyedError';
    Object.setPrototypeOf(this, WebContentsDestroyedError.prototype);
  }
}
