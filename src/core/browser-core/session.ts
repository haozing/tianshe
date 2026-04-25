/**
 * 浏览器 Session API
 *
 * 提供 Cookie、存储、代理等 Session 操作。
 *
 * Electron 的 Session 是隔离的存储空间，包含：
 * - Cookies
 * - LocalStorage / SessionStorage
 * - IndexedDB
 * - Cache
 * - 网络配置（代理等）
 *
 * @example
 * // 获取 Cookie（通过 SimpleBrowser 实例访问）
 * const cookies = await browser.session.getCookies();
 *
 * @example
 * // 设置代理
 * await browser.session.setProxy({
 *   mode: 'fixed_servers',
 *   proxyRules: 'http://proxy.example.com:8080'
 * });
 */

import type { Session, CookiesSetDetails, Cookie as ElectronCookie } from 'electron';
import type { Cookie } from './types';
import { filterBrowserCookies } from './cookie-filter-utils';

/**
 * 代理配置
 */
export interface ProxyConfig {
  /**
   * 代理模式
   * - direct: 直连（不使用代理）
   * - auto_detect: 自动检测
   * - pac_script: 使用 PAC 脚本
   * - fixed_servers: 固定代理服务器
   * - system: 使用系统代理
   */
  mode: 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers' | 'system';
  /** PAC 脚本 URL（mode=pac_script 时必填） */
  pacScript?: string;
  /**
   * 代理规则（mode=fixed_servers 时必填）
   * 格式：[<scheme>://]<host>:<port>
   * 示例：'http://proxy:8080' 或 'socks5://127.0.0.1:1080'
   */
  proxyRules?: string;
  /**
   * 不使用代理的地址
   * 格式：逗号分隔的主机名列表
   * 示例：'localhost,127.0.0.1,.example.com'
   */
  proxyBypassRules?: string;
}

/**
 * 清除存储选项
 */
export interface ClearStorageOptions {
  /** 要清除的源（URL）。如果不指定，则清除所有源 */
  origin?: string;
  /**
   * 要清除的存储类型
   */
  storages?: (
    | 'cookies'
    | 'filesystem'
    | 'indexdb'
    | 'localstorage'
    | 'shadercache'
    | 'websql'
    | 'serviceworkers'
    | 'cachestorage'
  )[];
  /** 要清除的配额类型 */
  quotas?: ('temporary' | 'syncable')[];
}

/**
 * Cookie 过滤器
 */
export interface CookieFilter {
  /** URL 过滤 */
  url?: string;
  /** 名称过滤 */
  name?: string;
  /** 域名过滤 */
  domain?: string;
  /** 路径过滤 */
  path?: string;
  /** 是否安全 */
  secure?: boolean;
  /** 是否 HttpOnly */
  httpOnly?: boolean;
  /** 是否会话 Cookie */
  session?: boolean;
}

/**
 * 浏览器 Session API
 */
export class BrowserSessionAPI {
  constructor(private getSession: () => Session) {}

  // ========================================
  // Cookie 管理
  // ========================================

  /**
   * 获取 Cookie
   *
   * @param filter 过滤条件（可选）
   * @returns Cookie 数组
   *
   * @example
   * // 获取所有 Cookie
   * const allCookies = await browser.session.getCookies();
   *
   * @example
   * // 获取特定域名的 Cookie
   * const cookies = await browser.session.getCookies({ domain: '.example.com' });
   *
   * @example
   * // 获取特定名称的 Cookie
   * const authCookie = await browser.session.getCookies({ name: 'auth_token' });
   */
  async getCookies(filter?: CookieFilter): Promise<Cookie[]> {
    const electronFilter: Record<string, unknown> = {};
    if (filter?.url) electronFilter.url = filter.url;
    if (filter?.name) electronFilter.name = filter.name;
    if (filter?.domain) electronFilter.domain = filter.domain;
    if (filter?.path) electronFilter.path = filter.path;
    if (typeof filter?.secure === 'boolean') electronFilter.secure = filter.secure;
    if (typeof filter?.session === 'boolean') electronFilter.session = filter.session;

    const cookies = (await this.getSession().cookies.get(electronFilter)) as ElectronCookie[];
    const normalized = cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
      sameSite: cookie.sameSite,
    }));
    return filterBrowserCookies(normalized, filter);
  }

  /**
   * 设置 Cookie
   *
   * @param details Cookie 详情
   *
   * @example
   * await browser.session.setCookie({
   *   url: 'https://example.com',
   *   name: 'session_id',
   *   value: 'abc123',
   *   secure: true,
   *   httpOnly: true
   * });
   */
  async setCookie(details: CookiesSetDetails): Promise<void> {
    await this.getSession().cookies.set(details);
  }

  /**
   * 批量设置 Cookie
   *
   * @param cookies Cookie 数组
   *
   * @example
   * await browser.session.setCookies([
   *   { url: 'https://example.com', name: 'a', value: '1' },
   *   { url: 'https://example.com', name: 'b', value: '2' }
   * ]);
   */
  async setCookies(cookies: CookiesSetDetails[]): Promise<void> {
    for (const cookie of cookies) {
      await this.getSession().cookies.set(cookie);
    }
  }

  /**
   * 删除 Cookie
   *
   * @param url Cookie 所属的 URL
   * @param name Cookie 名称
   *
   * @example
   * await browser.session.removeCookie('https://example.com', 'session_id');
   */
  async removeCookie(url: string, name: string): Promise<void> {
    await this.getSession().cookies.remove(url, name);
  }

  /**
   * 清除所有 Cookie
   *
   * @example
   * await browser.session.clearAllCookies();
   */
  async clearAllCookies(): Promise<void> {
    const cookies = await this.getCookies();
    for (const cookie of cookies) {
      const url = `https://${cookie.domain}${cookie.path}`;
      await this.removeCookie(url, cookie.name);
    }
  }

  /**
   * 刷新 Cookie 存储（强制写入磁盘）
   */
  async flushCookies(): Promise<void> {
    await this.getSession().cookies.flushStore();
  }

  // ========================================
  // 存储管理
  // ========================================

  /**
   * 清除存储数据
   *
   * @param options 清除选项
   *
   * @example
   * // 清除所有存储
   * await browser.session.clearStorageData();
   *
   * @example
   * // 只清除 localStorage 和 IndexedDB
   * await browser.session.clearStorageData({
   *   storages: ['localstorage', 'indexdb']
   * });
   *
   * @example
   * // 清除特定源的存储
   * await browser.session.clearStorageData({
   *   origin: 'https://example.com'
   * });
   */
  async clearStorageData(options?: ClearStorageOptions): Promise<void> {
    await this.getSession().clearStorageData(options);
  }

  /**
   * 清除缓存
   *
   * @example
   * await browser.session.clearCache();
   */
  async clearCache(): Promise<void> {
    await this.getSession().clearCache();
  }

  /**
   * 清除主机解析缓存
   *
   * @example
   * await browser.session.clearHostResolverCache();
   */
  async clearHostResolverCache(): Promise<void> {
    await this.getSession().clearHostResolverCache();
  }

  /**
   * 清除认证缓存
   *
   * @example
   * await browser.session.clearAuthCache();
   */
  async clearAuthCache(): Promise<void> {
    await this.getSession().clearAuthCache();
  }

  // ========================================
  // 代理配置
  // ========================================

  /**
   * 设置代理
   *
   * @param config 代理配置
   *
   * @example
   * // 使用 HTTP 代理
   * await browser.session.setProxy({
   *   mode: 'fixed_servers',
   *   proxyRules: 'http://proxy.example.com:8080'
   * });
   *
   * @example
   * // 使用 SOCKS5 代理
   * await browser.session.setProxy({
   *   mode: 'fixed_servers',
   *   proxyRules: 'socks5://127.0.0.1:1080'
   * });
   *
   * @example
   * // 禁用代理
   * await browser.session.setProxy({ mode: 'direct' });
   *
   * @example
   * // 使用系统代理
   * await browser.session.setProxy({ mode: 'system' });
   */
  async setProxy(config: ProxyConfig): Promise<void> {
    await this.getSession().setProxy(config);
  }

  /**
   * 解析 URL 的代理
   *
   * @param url 要解析的 URL
   * @returns 代理信息字符串
   *
   * @example
   * const proxy = await browser.session.resolveProxy('https://example.com');
   * console.log(proxy); // 'PROXY proxy.example.com:8080' 或 'DIRECT'
   */
  async resolveProxy(url: string): Promise<string> {
    return this.getSession().resolveProxy(url);
  }

  // ========================================
  // User-Agent
  // ========================================

  /**
   * 设置 User-Agent
   *
   * @param userAgent User-Agent 字符串
   * @param acceptLanguages Accept-Language 头（可选）
   *
   * @example
   * browser.session.setUserAgent(
   *   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
   * );
   */
  setUserAgent(userAgent: string, acceptLanguages?: string): void {
    this.getSession().setUserAgent(userAgent, acceptLanguages);
  }

  /**
   * 获取 User-Agent
   *
   * @returns 当前 User-Agent 字符串
   */
  getUserAgent(): string {
    return this.getSession().getUserAgent();
  }

  // ========================================
  // 权限管理
  // ========================================

  /**
   * 设置权限请求处理器
   *
   * @param handler 处理函数，返回 true 允许，false 拒绝
   *
   * @example
   * // 自动允许所有地理位置请求
   * browser.session.setPermissionRequestHandler((permission, callback) => {
   *   if (permission === 'geolocation') {
   *     callback(true);
   *   } else {
   *     callback(false);
   *   }
   * });
   */
  setPermissionRequestHandler(
    handler:
      | ((
          permission: string,
          callback: (granted: boolean) => void,
          details: { requestingUrl: string }
        ) => void)
      | null
  ): void {
    if (handler) {
      this.getSession().setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
          handler(permission, callback, { requestingUrl: details.requestingUrl });
        }
      );
    } else {
      this.getSession().setPermissionRequestHandler(null);
    }
  }

  // ========================================
  // 高级访问
  // ========================================

  /**
   * 获取原始 Session 对象
   *
   * 用于访问未封装的 Electron Session API。
   *
   * @returns Electron Session 对象
   *
   * @example
   * const session = browser.session.getRawSession();
   * session.on('will-download', (event, item) => {
   *   // 处理下载
   * });
   */
  getRawSession(): Session {
    return this.getSession();
  }

  /**
   * 获取 Session 存储路径
   *
   * @returns 存储路径或 undefined（非持久化 Session）
   */
  getStoragePath(): string | undefined {
    return this.getSession().storagePath || undefined;
  }
}
