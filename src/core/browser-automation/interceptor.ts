/**
 * 浏览器 HTTP 拦截模块
 *
 * 提供请求/响应拦截功能。
 * 从 browser-core 分离，作为可选的自动化功能。
 */

import type { Session } from 'electron';
import { getSessionWebRequestHub } from '../browser-core/web-request-hub';

/**
 * 请求拦截配置
 */
export interface InterceptConfig {
  /** 拦截目标：request（请求）、response（响应）、both（两者） */
  target: 'request' | 'response' | 'both';

  /** URL 匹配模式（正则表达式字符串） */
  urlPattern?: string;

  /** 匹配的 HTTP 方法 */
  methods?: Array<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'>;

  /** 请求操作 */
  requestAction?: {
    block?: boolean;
    redirectUrl?: string;
    modifyHeaders?: Record<string, string>;
    removeHeaders?: string[];
  };

  /** 响应操作 */
  responseAction?: {
    modifyHeaders?: Record<string, string>;
    removeHeaders?: string[];
    modifyStatus?: number;
  };

  /** 是否启用日志 */
  enableLogging?: boolean;
}

/**
 * 拦截规则内部结构
 */
interface InterceptRule {
  id: string;
  config: InterceptConfig;
  unsubscribers: {
    beforeRequest?: () => void;
    beforeSendHeaders?: () => void;
    headersReceived?: () => void;
  };
}

/**
 * 拦截依赖接口
 */
export interface InterceptorDependencies {
  getSession: () => Session;
  getWebContentsId: () => number;
  ensureNotDisposed: () => void;
}

/**
 * 浏览器 HTTP 拦截服务
 *
 * @example
 * const interceptor = new BrowserInterceptorService({
 *   getSession: () => browser.getSession(),
 *   ensureNotDisposed: () => browser.ensureNotDisposed(),
 * });
 * await interceptor.install('block-ads', {
 *   target: 'request',
 *   urlPattern: '.*ads.*',
 *   requestAction: { block: true }
 * });
 */
export class BrowserInterceptorService {
  private interceptRules: Map<string, InterceptRule> = new Map();

  constructor(private deps: InterceptorDependencies) {}

  /**
   * 安装 HTTP 拦截规则
   */
  async install(ruleId: string, config: InterceptConfig): Promise<void> {
    this.deps.ensureNotDisposed();

    if (this.interceptRules.has(ruleId)) {
      await this.remove(ruleId);
    }

    const session = this.deps.getSession();
    const requestHub = getSessionWebRequestHub(session);
    const unsubscribers: InterceptRule['unsubscribers'] = {};

    const urlMatcher = config.urlPattern ? new RegExp(config.urlPattern) : null;
    const currentWebContentsId = this.deps.getWebContentsId();

    const isCurrentWebContentsRequest = (details: any): boolean => {
      const webContentsId =
        typeof details?.webContentsId === 'number'
          ? details.webContentsId
          : typeof details?.webContents?.id === 'number'
            ? details.webContents.id
            : undefined;

      return webContentsId === undefined || webContentsId === currentWebContentsId;
    };

    // 请求拦截
    if ((config.target === 'request' || config.target === 'both') && config.requestAction) {
      const { block, redirectUrl } = config.requestAction;

      if (block || redirectUrl) {
        unsubscribers.beforeRequest = requestHub.subscribeBeforeRequest((details, callback) => {
          if (!isCurrentWebContentsRequest(details) || (urlMatcher && !urlMatcher.test(details.url))) {
            callback({});
            return;
          }

          if (config.methods && !config.methods.includes(details.method as any)) {
            callback({});
            return;
          }

          if (block) {
            callback({ cancel: true });
          } else if (redirectUrl) {
            callback({ redirectURL: redirectUrl });
          } else {
            callback({});
          }
        });
      }
    }

    // 请求头修改
    if ((config.target === 'request' || config.target === 'both') && config.requestAction) {
      const { modifyHeaders, removeHeaders } = config.requestAction;

      if (modifyHeaders || removeHeaders) {
        unsubscribers.beforeSendHeaders = requestHub.subscribeBeforeSendHeaders((details, callback) => {
          if (!isCurrentWebContentsRequest(details) || (urlMatcher && !urlMatcher.test(details.url))) {
            callback({});
            return;
          }

          if (config.methods && !config.methods.includes(details.method as any)) {
            callback({});
            return;
          }

          const requestHeaders = { ...details.requestHeaders };

          if (removeHeaders) {
            for (const header of removeHeaders) {
              delete requestHeaders[header];
              delete requestHeaders[header.toLowerCase()];
            }
          }

          if (modifyHeaders) {
            Object.assign(requestHeaders, modifyHeaders);
          }

          callback({ requestHeaders });
        });
      }
    }

    // 响应头修改
    if ((config.target === 'response' || config.target === 'both') && config.responseAction) {
      const { modifyHeaders, removeHeaders, modifyStatus } = config.responseAction;

      if (modifyHeaders || removeHeaders || modifyStatus) {
        unsubscribers.headersReceived = requestHub.subscribeHeadersReceived((details, callback) => {
          if (!isCurrentWebContentsRequest(details) || (urlMatcher && !urlMatcher.test(details.url))) {
            callback({});
            return;
          }

          const responseHeaders = { ...(details.responseHeaders || {}) };

          if (removeHeaders) {
            for (const header of removeHeaders) {
              delete responseHeaders[header];
              delete responseHeaders[header.toLowerCase()];
            }
          }

          if (modifyHeaders) {
            Object.assign(responseHeaders, modifyHeaders);
          }

          const result: any = { responseHeaders };

          if (modifyStatus) {
            result.statusLine = `HTTP/1.1 ${modifyStatus}`;
          }

          callback(result);
        });
      }
    }

    this.interceptRules.set(ruleId, { id: ruleId, config, unsubscribers });
  }

  /**
   * 移除 HTTP 拦截规则
   */
  async remove(ruleId: string): Promise<void> {
    this.deps.ensureNotDisposed();

    const rule = this.interceptRules.get(ruleId);
    if (!rule) {
      return;
    }
    rule.unsubscribers.beforeRequest?.();
    rule.unsubscribers.beforeSendHeaders?.();
    rule.unsubscribers.headersReceived?.();

    this.interceptRules.delete(ruleId);
  }

  /**
   * 移除所有拦截规则
   */
  async removeAll(): Promise<void> {
    const ruleIds = Array.from(this.interceptRules.keys());
    for (const ruleId of ruleIds) {
      try {
        await this.remove(ruleId);
      } catch {
        // 忽略清理错误
      }
    }
  }

  /**
   * 获取所有规则 ID
   */
  getRuleIds(): string[] {
    return Array.from(this.interceptRules.keys());
  }

  /**
   * 检查规则是否存在
   */
  hasRule(ruleId: string): boolean {
    return this.interceptRules.has(ruleId);
  }
}
