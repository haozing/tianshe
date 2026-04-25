/**
 * 浏览器 CDP（Chrome DevTools Protocol）API
 *
 * 提供直接访问 Chrome DevTools Protocol 的能力。
 * CDP 是 Chrome/Chromium 浏览器的底层调试协议，功能强大但需要专业知识。
 *
 * 参考文档：https://chromedevtools.github.io/devtools-protocol/
 *
 * @example
 * // 获取性能指标（通过 SimpleBrowser 实例访问）
 * await browser.cdp.sendCommand('Performance.enable');
 * const metrics = await browser.cdp.sendCommand('Performance.getMetrics');
 *
 * @example
 * // 模拟设备
 * await browser.cdp.sendCommand('Emulation.setDeviceMetricsOverride', {
 *   width: 375,
 *   height: 812,
 *   deviceScaleFactor: 3,
 *   mobile: true
 * });
 *
 * @example
 * // 监听网络事件
 * await browser.cdp.sendCommand('Network.enable');
 * browser.cdp.on('Network.requestWillBeSent', (params) => {
 *   console.log('Request:', params.request.url);
 * });
 */

import type { WebContents } from 'electron';
import { createLogger } from '../logger';

/** 模块级 logger */
const logger = createLogger('BrowserCDP');
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 15000;

/**
 * CDP 事件监听器清理函数
 */
export type CDPEventCleanup = () => void;

interface SendCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 浏览器 CDP API
 */
export class BrowserCDPAPI {
  private attached: boolean = false;
  private attachedByUs: boolean = false;
  private eventListeners: Map<string, Set<(params: any) => void>> = new Map();
  private debuggerMessageHandler: ((event: any, method: string, params: any) => void) | null = null;

  constructor(private getWebContents: () => WebContents) {}

  // ========================================
  // 调试器连接
  // ========================================

  /**
   * 附加调试器
   *
   * 必须先附加调试器才能发送 CDP 命令。
   * sendCommand 会自动调用此方法，通常不需要手动调用。
   *
   * @param protocolVersion CDP 协议版本（默认 '1.3'）
   *
   * @example
   * await browser.cdp.attach();
   */
  async attach(protocolVersion: string = '1.3'): Promise<void> {
    if (this.attached) {
      return;
    }


    try {
      const webContents = this.getWebContents();
      webContents.debugger.attach(protocolVersion);
      this.attached = true;
      this.attachedByUs = true;
      this.ensureDebuggerMessageHandler();
      logger.debug('Debugger attached', { protocolVersion });
    } catch (error: any) {
      // 可能已经被其他地方附加
      if (error.message?.includes('already attached')) {
        this.attached = true;
        this.attachedByUs = false;
        this.ensureDebuggerMessageHandler();
        return;
      }
      throw new Error(`Failed to attach debugger: ${error.message}`);
    }
  }

  /**
   * 分离调试器
   *
   * 释放调试器资源。通常在浏览器关闭时自动调用。
   *
   * @example
   * browser.cdp.detach();
   */
  detach(): void {
    if (!this.attached) {
      return;
    }

    try {
      const webContents = this.getWebContents();
      if (this.debuggerMessageHandler) {
        webContents.debugger.removeListener('message', this.debuggerMessageHandler);
      }

      if (this.attachedByUs) {
        webContents.debugger.detach();
      }
      logger.debug('Debugger detached');
    } catch (_error) {
      // Ignore detach cleanup errors.
    } finally {
      this.debuggerMessageHandler = null;
      this.attached = false;
      this.attachedByUs = false;
      this.eventListeners.clear();
    }
  }

  /**
   * 检查调试器是否已附加
   */
  isAttached(): boolean {
    return this.attached;
  }

  // ========================================
  // 命令执行
  // ========================================

  /**
   * 发送 CDP 命令
   *
   * @param method CDP 方法名（如 'DOM.getDocument', 'Network.enable'）
   * @param params 参数对象（可选）
   * @returns 命令结果
   *
   * @example
   * // 启用性能监控
   * await browser.cdp.sendCommand('Performance.enable');
   *
   * @example
   * // 获取性能指标
   * const { metrics } = await browser.cdp.sendCommand('Performance.getMetrics');
   * console.log(metrics);
   *
   * @example
   * // 获取 DOM 文档
   * const { root } = await browser.cdp.sendCommand('DOM.getDocument', { depth: -1 });
   *
   * @example
   * // 截取全页面截图（比 capturePage 更强大）
   * const { data } = await browser.cdp.sendCommand('Page.captureScreenshot', {
   *   format: 'png',
   *   captureBeyondViewport: true
   * });
   * // data 是 Base64 编码的图片
   *
   * @example
   * // 模拟地理位置
   * await browser.cdp.sendCommand('Emulation.setGeolocationOverride', {
   *   latitude: 37.7749,
   *   longitude: -122.4194,
   *   accuracy: 100
   * });
   */
  async sendCommand<T = any>(
    method: string,
    params?: object,
    options: SendCommandOptions = {}
  ): Promise<T> {
    const webContents = this.getWebContents();

    // 自动附加调试器
    if (!this.attached) {
      await this.attach();
    }

    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    let timeoutId: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    let timedOut = false;
    let aborted = false;

    if (options.signal?.aborted) {
      this.detach();
      throw new Error(`CDP command '${method}' aborted before execution`);
    }

    try {
      const racers: Array<Promise<unknown>> = [webContents.debugger.sendCommand(method, params)];
      racers.push(
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            this.detach();
            reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeoutId.unref?.();
        })
      );
      if (options.signal) {
        racers.push(
          new Promise<never>((_, reject) => {
            abortListener = () => {
              aborted = true;
              this.detach();
              reject(new Error(`CDP command '${method}' aborted`));
            };
            options.signal!.addEventListener('abort', abortListener, { once: true });
          })
        );
      }
      const result = await Promise.race(racers);
      return result as T;
    } catch (error: any) {
      if (timedOut || String(error?.message || '').includes('timed out')) {
        logger.warn('CDP command timed out; debugger detached for recovery', {
          method,
          timeoutMs,
        });
      }
      if (aborted || String(error?.message || '').includes('aborted')) {
        logger.warn('CDP command aborted; debugger detached for recovery', {
          method,
        });
      }
      throw new Error(`CDP command '${method}' failed: ${error.message}`);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (abortListener && options.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  // ========================================
  // 事件监听
  // ========================================

  /**
   * 监听 CDP 事件
   *
   * 注意：必须先启用相应的域（如 Network.enable）才能收到事件。
   *
   * @param event 事件名称（如 'Network.requestWillBeSent'）
   * @param listener 监听函数
   * @returns 清理函数（调用以移除监听器）
   *
   * @example
   * // 监听网络请求
   * await browser.cdp.sendCommand('Network.enable');
   * const cleanup = browser.cdp.on('Network.requestWillBeSent', (params) => {
   *   console.log('Request:', params.request.url);
   * });
   *
   * // 稍后移除监听器
   * cleanup();
   *
   * @example
   * // 监听控制台消息
   * await browser.cdp.sendCommand('Runtime.enable');
   * browser.cdp.on('Runtime.consoleAPICalled', (params) => {
   *   console.log('Console:', params.type, params.args);
   * });
   */
  on(event: string, listener: (params: any) => void): CDPEventCleanup {
    // 确保已附加
    if (!this.attached) {
      logger.warn('Debugger not attached. Call attach() or sendCommand() first.');
    }

    // 注册监听器
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);

    // 确保 debugger 消息处理器已安装
    this.ensureDebuggerMessageHandler();

    // 返回清理函数
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.eventListeners.delete(event);
        }
      }
    };
  }

  /**
   * 移除事件监听器
   *
   * @param event 事件名称
   * @param listener 监听函数（可选，不传则移除该事件的所有监听器）
   */
  off(event: string, listener?: (params: any) => void): void {
    if (!listener) {
      this.eventListeners.delete(event);
    } else {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.eventListeners.delete(event);
        }
      }
    }
  }

  /**
   * 等待特定事件（一次性）
   *
   * @param event 事件名称
   * @param timeout 超时时间（毫秒）
   * @returns 事件参数
   *
   * @example
   * // 等待页面加载完成
   * await browser.cdp.sendCommand('Page.enable');
   * const params = await browser.cdp.waitForEvent('Page.loadEventFired', 30000);
   */
  async waitForEvent<T = any>(event: string, timeout: number = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for CDP event: ${event}`));
      }, timeout);

      const cleanup = this.on(event, (params) => {
        clearTimeout(timeoutId);
        cleanup();
        resolve(params);
      });
    });
  }

  /**
   * 确保 debugger 消息处理器已安装
   */
  private ensureDebuggerMessageHandler(): void {
    if (this.debuggerMessageHandler) {
      return;
    }

    const webContents = this.getWebContents();

    this.debuggerMessageHandler = (_event: any, method: string, params: any) => {
      const listeners = this.eventListeners.get(method);
      if (listeners) {
        listeners.forEach((listener) => {
          try {
            listener(params);
          } catch (error) {
            logger.error('Error in CDP event listener', { method, error });
          }
        });
      }
    };

    webContents.debugger.on('message', this.debuggerMessageHandler);
  }

  // ========================================
  // 常用功能快捷方法
  // ========================================

  /**
   * 启用网络监控
   *
   * 启用后可以监听 Network.* 事件。
   *
   * @example
   * await browser.cdp.enableNetwork();
   * browser.cdp.on('Network.requestWillBeSent', (params) => {
   *   console.log(params.request.url);
   * });
   */
  async enableNetwork(): Promise<void> {
    await this.sendCommand('Network.enable');
  }

  /**
   * 启用 DOM 监控
   *
   * @example
   * await browser.cdp.enableDOM();
   */
  async enableDOM(): Promise<void> {
    await this.sendCommand('DOM.enable');
  }

  /**
   * 启用页面监控
   *
   * @example
   * await browser.cdp.enablePage();
   */
  async enablePage(): Promise<void> {
    await this.sendCommand('Page.enable');
  }

  /**
   * 启用运行时监控
   *
   * @example
   * await browser.cdp.enableRuntime();
   */
  async enableRuntime(): Promise<void> {
    await this.sendCommand('Runtime.enable');
  }

  /**
   * 模拟设备
   *
   * @param width 视口宽度
   * @param height 视口高度
   * @param deviceScaleFactor 设备像素比
   * @param mobile 是否移动端
   *
   * @example
   * // 模拟 iPhone 14
   * await browser.cdp.emulateDevice(390, 844, 3, true);
   */
  async emulateDevice(
    width: number,
    height: number,
    deviceScaleFactor: number = 1,
    mobile: boolean = false
  ): Promise<void> {
    await this.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  /**
   * 清除设备模拟
   */
  async clearDeviceEmulation(): Promise<void> {
    await this.sendCommand('Emulation.clearDeviceMetricsOverride');
  }

  /**
   * 模拟地理位置
   *
   * @param latitude 纬度
   * @param longitude 经度
   * @param accuracy 精度（米）
   *
   * @example
   * // 模拟旧金山
   * await browser.cdp.emulateGeolocation(37.7749, -122.4194, 100);
   */
  async emulateGeolocation(
    latitude: number,
    longitude: number,
    accuracy: number = 100
  ): Promise<void> {
    await this.sendCommand('Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy,
    });
  }

  /**
   * 清除地理位置模拟
   */
  async clearGeolocationEmulation(): Promise<void> {
    await this.sendCommand('Emulation.clearGeolocationOverride');
  }

  /**
   * 模拟时区
   *
   * @param timezoneId 时区 ID（如 'America/New_York'）
   *
   * @example
   * await browser.cdp.emulateTimezone('Asia/Tokyo');
   */
  async emulateTimezone(timezoneId: string): Promise<void> {
    await this.sendCommand('Emulation.setTimezoneOverride', { timezoneId });
  }

  /**
   * 模拟网络条件
   *
   * @param offline 是否离线
   * @param latency 延迟（毫秒）
   * @param downloadThroughput 下载速度（字节/秒，-1 为不限制）
   * @param uploadThroughput 上传速度（字节/秒，-1 为不限制）
   *
   * @example
   * // 模拟 3G 网络
   * await browser.cdp.emulateNetworkConditions(false, 100, 750000, 250000);
   *
   * @example
   * // 模拟离线
   * await browser.cdp.emulateNetworkConditions(true, 0, -1, -1);
   */
  async emulateNetworkConditions(
    offline: boolean,
    latency: number,
    downloadThroughput: number,
    uploadThroughput: number
  ): Promise<void> {
    await this.sendCommand('Network.emulateNetworkConditions', {
      offline,
      latency,
      downloadThroughput,
      uploadThroughput,
    });
  }

  /**
   * 全页面截图（包括滚动区域）
   *
   * 比 browser.screenshot() 更强大，可以截取整个页面。
   *
   * @param format 图片格式
   * @returns Base64 编码的图片数据
   *
   * @example
   * const base64 = await browser.cdp.fullPageScreenshot('png');
   */
  async fullPageScreenshot(
    format: 'png' | 'jpeg' = 'png',
    quality?: number,
    options: SendCommandOptions = {}
  ): Promise<string> {
    const { data } = await this.sendCommand<{ data: string }>(
      'Page.captureScreenshot',
      {
        format,
        captureBeyondViewport: true,
        fromSurface: true,
        ...(format === 'jpeg' && typeof quality === 'number' ? { quality } : {}),
      },
      {
        timeoutMs: options.timeoutMs ?? 20000,
        signal: options.signal,
      }
    );
    return data;
  }

  /**
   * 视口截图（仅当前可见区域）
   *
   * 适用于 OCR 等需要精确视口坐标的场景。
   * 支持 offscreen 模式（fromSurface: true）。
   *
   * @param format 图片格式
   * @returns Base64 编码的图片数据
   */
  async viewportScreenshot(
    format: 'png' | 'jpeg' = 'png',
    quality?: number,
    options: SendCommandOptions = {}
  ): Promise<string> {
    const { data } = await this.sendCommand<{ data: string }>(
      'Page.captureScreenshot',
      {
        format,
        captureBeyondViewport: false,
        fromSurface: true,
        ...(format === 'jpeg' && typeof quality === 'number' ? { quality } : {}),
      },
      {
        timeoutMs: options.timeoutMs ?? 20000,
        signal: options.signal,
      }
    );
    return data;
  }
}
