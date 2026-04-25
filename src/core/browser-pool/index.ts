/**
 * 浏览器池模块
 *
 * v2 架构：Profile = Session
 *
 * 提供浏览器实例的池化管理，解决：
 * - 浏览器创建/销毁开销
 * - 并发竞态问题
 * - 资源泄漏问题
 * - 公平资源分配
 *
 * 使用方式：
 *
 * @example
 * // 1. 初始化（在应用启动时）
 * import { initializeBrowserPool } from './browser-pool';
 * await initializeBrowserPool(getProfileService, browserFactory, browserDestroyer, config);
 *
 * @example
 * // 2. 在插件中使用
 * const poolManager = getBrowserPoolManager();
 *
 * // 获取浏览器（使用 Profile ID，不传则使用默认浏览器）
 * const handle = await poolManager.acquire('profile-id', {
 *   strategy: 'any',
 *   timeout: 30000,
 * }, 'plugin', pluginId);
 *
 * // 或使用默认浏览器
 * const defaultHandle = await poolManager.acquire(undefined, {}, 'plugin', pluginId);
 *
 * try {
 *   // 使用浏览器
 *   await handle.browser.goto('https://example.com');
 *   const title = await handle.browser.title();
 * } finally {
 *   // 释放浏览器
 *   await handle.release();
 * }
 *
 * @example
 * // 3. 在插件停止时清理
 * await poolManager.releaseByPlugin(pluginId);
 */

// 类型导出
export type {
  // 指纹配置
  FingerprintConfig,

  // 会话配置
  SessionConfig,

  // 池化浏览器（判别联合类型）
  BrowserStatus,
  PooledBrowser,
  CreatingBrowser,
  ReadyBrowser,
  DestroyingBrowser,
  LockInfo,

  // 获取请求/结果
  AcquireStrategy,
  AcquirePriority,
  AcquireSource,
  AcquireOptions,
  AcquireRequest,
  AcquireResult,
  AcquireResultSuccess,
  AcquireResultFailure,

  // 释放选项
  ReleaseOptions,

  // 等待队列
  WaitingRequest,

  // 统计信息
  PoolStats,
  SessionStats,

  // 浏览器句柄
  BrowserHandle,
} from './types';

// 类型守卫函数导出
export { isReadyBrowser, hasBrowserInstance } from './types';

// 工具函数导出
export {
  resetBrowserState,
  attachBrowserView,
  showBrowserView,
  hideBrowserView,
  showBrowserViewInPopup,
  closeBrowserPopup,
} from './utils';
export type { PopupDisplayConfig } from './utils';

// 全局池导出
export { GlobalPool } from './global-pool';
export type { BrowserFactory, BrowserDestroyer } from './global-pool';

// 等待队列导出
export { WaitQueue } from './wait-queue';

// 池管理器导出
export {
  BrowserPoolManager,
  initBrowserPoolManager,
  getBrowserPoolManager,
  resetBrowserPoolManager,
} from './pool-manager';

// 事件系统导出
export { BrowserPoolEventEmitter, createBrowserPoolEventEmitter } from './events';
export type { BrowserPoolEvents, BrowserAcquiredEvent, BrowserReleasedEvent } from './events';

// ============================================
// 便捷初始化函数
// ============================================

import { initBrowserPoolManager, getBrowserPoolManager } from './pool-manager';
import type { BrowserFactory, BrowserDestroyer } from './global-pool';
import type { BrowserPoolConfig } from '../../constants/browser-pool';
import type { ProfileService } from '../../main/duckdb/profile-service';

/**
 * 初始化浏览器池
 *
 * 在应用启动时调用一次
 *
 * @param getProfileService 获取 ProfileService 的函数
 * @param browserFactory 浏览器创建工厂
 * @param browserDestroyer 浏览器销毁函数
 * @param config 可选的池配置
 */
export async function initializeBrowserPool(
  getProfileService: () => ProfileService,
  browserFactory: BrowserFactory,
  browserDestroyer: BrowserDestroyer,
  config?: Partial<BrowserPoolConfig>
): Promise<void> {
  // 启动时同步状态：将所有 active 状态重置为 idle
  // 解决应用崩溃后状态不一致的问题（消除状态双来源）
  const profileService = getProfileService();
  await profileService.resetAllActiveStatus();

  const manager = initBrowserPoolManager(getProfileService);
  await manager.initialize(browserFactory, browserDestroyer, config);
}

/**
 * 停止浏览器池
 *
 * 在应用关闭时调用
 */
export async function stopBrowserPool(): Promise<void> {
  try {
    const manager = getBrowserPoolManager();
    await manager.stop();
  } catch {
    // 如果池未初始化，忽略错误
  }
}
