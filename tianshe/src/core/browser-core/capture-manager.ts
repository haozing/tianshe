/**
 * 通用捕获管理器
 *
 * 提供网络请求和控制台消息的捕获功能
 * 使用模板方法模式消除重复代码
 */

import type { WebContents } from 'electron';
import { CircularBuffer } from './utils';
import type { NetworkEntry, ConsoleMessage, NetworkCaptureOptions } from './types';
import type { NetworkFilter } from '../../types/browser-interface';
import { classifyNetworkEntry, matchesNetworkFilter, summarizeNetworkEntries } from '../browser-automation/network-utils';
import { getSessionWebRequestHub } from './web-request-hub';

/**
 * 抽象捕获管理器基类
 */
abstract class BaseCaptureManager<T> {
  protected buffer: CircularBuffer<T>;
  protected capturing: boolean = false;

  constructor(maxSize: number = 100) {
    this.buffer = new CircularBuffer<T>(maxSize);
  }

  /**
   * 是否正在捕获
   */
  isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * 获取所有条目
   */
  getAll(): T[] {
    return this.buffer.getAll();
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.buffer.clear();
  }

  /**
   * 设置最大容量
   */
  setMaxSize(size: number): void {
    this.buffer.maxSize = size;
  }

  /**
   * 查找条目
   */
  find(predicate: (item: T) => boolean): T | undefined {
    return this.buffer.find(predicate);
  }

  /**
   * 开始捕获（子类实现）
   */
  abstract start(options?: unknown): void;

  /**
   * 停止捕获（子类实现）
   */
  abstract stop(): void;

  /**
   * 清理资源
   */
  dispose(): void {
    this.stop();
    this.clear();
  }
}

/**
 * 网络捕获管理器
 */
export class NetworkCaptureManager extends BaseCaptureManager<NetworkEntry> {
  private webContents: WebContents;
  private urlFilter: RegExp | null = null;
  private captureBody: boolean = false;
  private handlers?: {
    unsubscribeBeforeRequest: () => void;
    unsubscribeBeforeSendHeaders: () => void;
    unsubscribeCompleted: () => void;
    unsubscribeErrorOccurred: () => void;
  };

  constructor(webContents: WebContents, maxSize: number = 1000) {
    super(maxSize);
    this.webContents = webContents;
  }

  /**
   * 开始捕获网络请求
   */
  start(options?: NetworkCaptureOptions): void {
    if (this.capturing) {
      this.stop();
    }

    const session = this.webContents.session;
    const requestHub = getSessionWebRequestHub(session);

    this.urlFilter = options?.urlFilter ? new RegExp(options.urlFilter) : null;
    this.captureBody = options?.captureBody === true;

    if (options?.maxEntries) {
      this.buffer.maxSize = options.maxEntries;
    }

    if (options?.clearExisting) {
      this.clear();
    }

    const currentWebContentsId = this.webContents.id;

    const normalizeHeaders = (headers: any): Record<string, string> => {
      if (!headers || typeof headers !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        out[String(k)] = Array.isArray(v) ? v.map((x) => String(x)).join('; ') : String(v);
      }
      return out;
    };

    const extractRequestBody = (details: any): string | undefined => {
      if (!this.captureBody || !Array.isArray(details?.uploadData) || details.uploadData.length === 0) {
        return undefined;
      }

      const chunks = details.uploadData
        .map((item: any) => {
          if (item?.bytes && Buffer.isBuffer(item.bytes)) {
            return item.bytes.toString('utf-8');
          }
          if (typeof item?.file === 'string') {
            return `[file:${item.file}]`;
          }
          return '';
        })
        .filter(Boolean);

      return chunks.length > 0 ? chunks.join('\n') : undefined;
    };

    const isCurrentWebContentsRequest = (details: any): boolean => {
      const webContentsId =
        typeof details?.webContentsId === 'number'
          ? details.webContentsId
          : typeof details?.webContents?.id === 'number'
            ? details.webContents.id
            : undefined;

      return webContentsId === undefined || webContentsId === currentWebContentsId;
    };

    // 保存处理器引用以便后续移除
    this.handlers = {
      unsubscribeBeforeRequest: requestHub.subscribeBeforeRequest((details, callback) => {
        if (!isCurrentWebContentsRequest(details) || (this.urlFilter && !this.urlFilter.test(details.url))) {
          callback({});
          return;
        }

        const requestBody = extractRequestBody(details);
        this.buffer.push({
          id: details.id.toString(),
          url: details.url,
          method: details.method,
          resourceType: details.resourceType,
          classification: classifyNetworkEntry({
            resourceType: details.resourceType,
            url: details.url,
          }),
          startTime: Date.now(),
          ...(requestBody ? { requestBody } : {}),
        });

        callback({});
      }),
      unsubscribeBeforeSendHeaders: requestHub.subscribeBeforeSendHeaders((details, callback) => {
        // 对不需要捕获的 URL，不做任何处理但必须放行
        if (!isCurrentWebContentsRequest(details) || (this.urlFilter && !this.urlFilter.test(details.url))) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }

        const id = details.id?.toString?.() ?? String(details.id ?? '');
        if (id) {
          let entry = this.buffer.find((e) => e.id === id);
          if (!entry) {
            // 某些情况下 onBeforeRequest 可能未触发（或顺序不同），此处兜底创建
            entry = {
              id,
              url: details.url,
              method: details.method,
              resourceType: details.resourceType,
              classification: classifyNetworkEntry({
                resourceType: details.resourceType,
                url: details.url,
              }),
              startTime: Date.now(),
            };
            this.buffer.push(entry);
          }

          entry.requestHeaders = normalizeHeaders(details.requestHeaders);
          if (!entry.requestBody) {
            entry.requestBody = extractRequestBody(details);
          }
        }

        callback({ requestHeaders: details.requestHeaders });
      }),
      unsubscribeCompleted: requestHub.subscribeCompleted((details) => {
        if (!isCurrentWebContentsRequest(details) || (this.urlFilter && !this.urlFilter.test(details.url))) {
          return;
        }

        const id = details.id?.toString?.() ?? String(details.id ?? '');
        let entry = id ? this.buffer.find((e) => e.id === id) : undefined;
        if (!entry && id) {
          // 兜底创建，避免丢失完成状态
          entry = {
            id,
            url: details.url,
            method: details.method,
            resourceType: details.resourceType,
            classification: classifyNetworkEntry({
              resourceType: details.resourceType,
              url: details.url,
            }),
            startTime: Date.now(),
          };
          this.buffer.push(entry);
        }

        if (entry) {
          entry.status = details.statusCode;
          if (details.statusLine) entry.statusText = String(details.statusLine);
          if (details.responseHeaders) entry.responseHeaders = normalizeHeaders(details.responseHeaders);
          entry.endTime = Date.now();
          entry.duration = entry.endTime - entry.startTime;
        }
      }),
      unsubscribeErrorOccurred: requestHub.subscribeErrorOccurred((details) => {
        if (!isCurrentWebContentsRequest(details) || (this.urlFilter && !this.urlFilter.test(details.url))) {
          return;
        }

        const id = details.id?.toString?.() ?? String(details.id ?? '');
        let entry = id ? this.buffer.find((e) => e.id === id) : undefined;
        if (!entry && id) {
          entry = {
            id,
            url: details.url,
            method: details.method,
            resourceType: details.resourceType,
            classification: classifyNetworkEntry({
              resourceType: details.resourceType,
              url: details.url,
            }),
            startTime: Date.now(),
          };
          this.buffer.push(entry);
        }
        if (entry) {
          entry.error = details.error;
          entry.endTime = Date.now();
          entry.duration = entry.endTime - entry.startTime;
        }
      }),
    };

    this.capturing = true;
  }

  /**
   * 停止捕获网络请求
   */
  stop(): void {
    if (!this.capturing) return;

    // 移除处理器
    if (this.handlers) {
      try {
        this.handlers.unsubscribeBeforeRequest();
        this.handlers.unsubscribeBeforeSendHeaders();
        this.handlers.unsubscribeCompleted();
        this.handlers.unsubscribeErrorOccurred();
      } catch {
        // 忽略清理错误
      }

      this.handlers = undefined;
    }

    this.urlFilter = null;
    this.capturing = false;
  }

  /**
   * 获取过滤后的网络条目
   */
  getEntries(filter?: NetworkFilter): NetworkEntry[] {
    return this.buffer.getAll().filter((entry) => matchesNetworkFilter(entry, filter));
  }

  /**
   * 获取网络摘要
   */
  getSummary(): {
    total: number;
    byType: Record<string, number>;
    byMethod: Record<string, number>;
    failed: Array<{ url: string; status: number; method: string }>;
    slow: Array<{ url: string; duration: number; method: string }>;
    apiCalls: NetworkEntry[];
  } {
    return summarizeNetworkEntries(this.buffer.getAll());
  }
}

/**
 * 控制台捕获管理器
 */
export class ConsoleCaptureManager extends BaseCaptureManager<ConsoleMessage> {
  private webContents: WebContents;
  private minLevel: ConsoleMessage['level'] | 'all' = 'all';
  private listener?: (
    event: Electron.Event,
    level: number,
    message: string,
    line: number,
    sourceId: string
  ) => void;

  constructor(webContents: WebContents, maxSize: number = 500) {
    super(maxSize);
    this.webContents = webContents;
  }

  /**
   * 开始捕获控制台消息
   */
  start(options?: { maxMessages?: number; level?: ConsoleMessage['level'] | 'all' }): void {
    if (this.capturing) return;

    if (options?.maxMessages) {
      this.buffer.maxSize = options.maxMessages;
    }

    this.minLevel = options?.level ?? 'all';

    const levelOrder: Array<ConsoleMessage['level']> = ['verbose', 'info', 'warning', 'error'];
    const shouldCaptureLevel = (level: ConsoleMessage['level']) => {
      if (this.minLevel === 'all') return true;
      return levelOrder.indexOf(level) >= levelOrder.indexOf(this.minLevel);
    };

    // 保存监听器引用以便后续移除
    this.listener = (_event, level, message, line, sourceId) => {
      const levelMap: Record<number, ConsoleMessage['level']> = {
        0: 'verbose',
        1: 'info',
        2: 'warning',
        3: 'error',
      };

      const normalizedLevel = levelMap[level] || 'info';
      if (!shouldCaptureLevel(normalizedLevel)) {
        return;
      }

      this.buffer.push({
        level: normalizedLevel,
        message,
        source: sourceId,
        line,
        timestamp: Date.now(),
      });
    };

    this.webContents.on('console-message', this.listener);
    this.capturing = true;
  }

  /**
   * 停止捕获控制台消息
   */
  stop(): void {
    if (this.listener) {
      this.webContents.removeListener('console-message', this.listener);
      this.listener = undefined;
    }
    this.capturing = false;
  }

  /**
   * 获取指定级别的消息
   */
  getByLevel(level: ConsoleMessage['level']): ConsoleMessage[] {
    return this.buffer.getAll().filter((m) => m.level === level);
  }

  /**
   * 获取错误消息
   */
  getErrors(): ConsoleMessage[] {
    return this.getByLevel('error');
  }

  /**
   * 获取警告消息
   */
  getWarnings(): ConsoleMessage[] {
    return this.getByLevel('warning');
  }
}
