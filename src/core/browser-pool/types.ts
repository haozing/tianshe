/**
 * 浏览器池类型定义
 *
 * 核心概念：
 * - Session: 会话配置（partition + fingerprint），只是配置不持有浏览器
 * - PooledBrowser: 池化的浏览器实例（使用 IntegratedBrowser）
 * - AcquireRequest: 获取浏览器的请求
 *
 * 设计原则：
 * - 内部和外部统一使用 IntegratedBrowser
 * - IntegratedBrowser 实现 BrowserInterface，提供完整功能
 * - 调用者通过 BrowserInterface 使用浏览器
 */

import type { BrowserInterface } from '../../types/browser-interface';
// 统一使用 profile.ts 中的 FingerprintConfig，避免重复定义
import type {
  FingerprintConfig,
  ProxyConfig as ProfileProxyConfig,
} from '../../types/profile';
import type { AutomationEngine } from '../../types/automation-engine';

// 重导出供模块使用者访问
export type { FingerprintConfig, ProfileProxyConfig, BrowserInterface, AutomationEngine };

/**
 * 池内浏览器的最小生命周期约束
 *
 * - IntegratedBrowser 已提供 closeInternal()
 * - 持久化 Chromium 适配器需要提供 closeInternal() 以便池统一销毁
 */
export interface PooledBrowserController extends BrowserInterface {
  closeInternal(): Promise<void>;
}

// ============================================
// Session 配置
// ============================================

export interface SessionConfig {
  /** 会话标识（如 "account-alice"） */
  id: string;
  /** Electron partition（创建后不可变） */
  partition: string;
  /** 自动化引擎（默认 'electron'） */
  engine?: AutomationEngine;
  /** 指纹配置 */
  fingerprint?: FingerprintConfig;
  /** Profile 代理配置（可选） */
  proxy?: ProfileProxyConfig | null;
  /** 单 Profile 允许的 live 浏览器实例数（固定为 1） */
  quota: number;
  /** 空闲超时销毁时间（默认5分钟） */
  idleTimeoutMs: number;
  /** 锁定超时自动释放时间（默认5分钟） */
  lockTimeoutMs: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
}

// ============================================
// 池化浏览器实例（判别联合类型）
// ============================================

export type BrowserStatus = 'creating' | 'idle' | 'locked' | 'destroying';

/** 池化浏览器基础字段 */
interface PooledBrowserBase {
  /** 实例ID（UUID） */
  id: string;
  /** 所属会话ID */
  sessionId: string;
  /** 引擎类型 */
  engine: AutomationEngine;
  /** 会话空闲超时（ms），用于按 Profile 维度驱逐空闲浏览器 */
  idleTimeoutMs: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 使用次数 */
  useCount: number;
}

/** 正在创建中的浏览器占位（browser 尚未就绪） */
export interface CreatingBrowser extends PooledBrowserBase {
  status: 'creating';
  /** 创建中的浏览器没有 browser 实例 */
  browser?: undefined;
  viewId?: undefined;
  lockedBy?: undefined;
  lockedAt?: undefined;
}

/** 就绪的池化浏览器（idle 或 locked 状态） */
export interface ReadyBrowser extends PooledBrowserBase {
  status: 'idle' | 'locked';
  /** 浏览器对象（池内需要具备 closeInternal()） */
  browser: PooledBrowserController;
  /** WebContentsView ID（仅 electron 引擎存在） */
  viewId?: string;
  /** 锁定信息（locked 状态时存在） */
  lockedBy?: LockInfo;
  /** 锁定时间戳（locked 状态时存在） */
  lockedAt?: number;
}

/** 正在销毁的浏览器 */
export interface DestroyingBrowser extends PooledBrowserBase {
  status: 'destroying';
  /** 浏览器对象 */
  browser: PooledBrowserController;
  /** WebContentsView ID（仅 electron 引擎存在） */
  viewId?: string;
  lockedBy?: undefined;
  lockedAt?: undefined;
}

/**
 * 池化浏览器（判别联合类型）
 *
 * 使用 status 字段判别类型：
 * - 'creating': CreatingBrowser（browser 未就绪）
 * - 'idle' | 'locked': ReadyBrowser（browser 可用）
 * - 'destroying': DestroyingBrowser（正在销毁）
 */
export type PooledBrowser = CreatingBrowser | ReadyBrowser | DestroyingBrowser;

/**
 * 类型守卫：检查浏览器是否就绪（可安全访问 browser 属性）
 */
export function isReadyBrowser(browser: PooledBrowser): browser is ReadyBrowser {
  return browser.status === 'idle' || browser.status === 'locked';
}

/**
 * 类型守卫：检查浏览器是否有 browser 实例（idle/locked/destroying）
 */
export function hasBrowserInstance(
  browser: PooledBrowser
): browser is ReadyBrowser | DestroyingBrowser {
  return browser.status !== 'creating';
}

export interface LockInfo {
  /** 请求ID（用于追踪） */
  requestId: string;
  /** 插件ID */
  pluginId?: string;
  /** 调用来源 */
  source: AcquireSource;
  /** 锁定超时时间（ms） */
  timeoutMs: number;
}

// ============================================
// 获取浏览器请求/结果
// ============================================

export type AcquireStrategy = 'any' | 'fresh' | 'reuse' | 'specific';
export type AcquirePriority = 'high' | 'normal' | 'low';
export type AcquireSource = 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin';

export interface AcquireOptions {
  /** 自动化引擎（默认 'electron'） */
  engine?: AutomationEngine;
  /**
   * 浏览器选择策略
   * - 'any': 任意空闲浏览器（默认）
   * - 'fresh': 优先选择使用次数较少的浏览器
   * - 'reuse': 优先选择使用次数较多的浏览器（更可能命中缓存态）
   * - 'specific': 指定特定的浏览器ID
   */
  strategy: AcquireStrategy;
  /** 指定浏览器ID（strategy='specific' 时使用） */
  browserId?: string;
  /** 等待超时（ms），默认30秒 */
  timeout: number;
  signal?: AbortSignal;
  /** 优先级 */
  priority: AcquirePriority;
  /** 锁定超时（ms），超时后自动释放，默认使用 Session 配置 */
  lockTimeout?: number;
}

export interface AcquireRequest {
  /** 目标会话ID */
  sessionId: string;
  /** 请求ID（用于追踪） */
  requestId: string;
  /** 插件ID */
  pluginId?: string;
  /** 调用来源 */
  source: AcquireSource;
  /** 获取选项 */
  options: AcquireOptions;
}

/**
 * 获取浏览器成功结果
 */
export interface AcquireResultSuccess {
  /** 是否成功 */
  success: true;
  /** 浏览器实例（实现 BrowserInterface 接口） */
  browser: BrowserInterface;
  /** 浏览器ID */
  browserId: string;
  /** 会话ID */
  sessionId: string;
  /** 等待时间（ms） */
  waitedMs: number;
}

/**
 * 获取浏览器失败结果
 */
export interface AcquireResultFailure {
  /** 是否成功 */
  success: false;
  /** 错误信息 */
  error: string;
  /** 等待时间（ms） */
  waitedMs: number;
}

/**
 * 获取浏览器结果（判别联合类型）
 *
 * 使用 result.success 判断成功与否：
 * - success=true 时，browser/browserId/sessionId 必存在
 * - success=false 时，error 必存在
 */
export type AcquireResult = AcquireResultSuccess | AcquireResultFailure;

// ============================================
// 释放浏览器选项
// ============================================

export interface ReleaseOptions {
  /** 导航到指定URL（用于清理页面状态） */
  navigateTo?: string;
  /** 是否清理 localStorage/sessionStorage */
  clearStorage?: boolean;
  /** 是否完全销毁（不放回池，直接关闭） */
  destroy?: boolean;
}

/**
 * 释放浏览器的结果
 * 包含释放后的状态信息，避免调用者需要额外查询导致竞态
 */
export interface ReleaseResult {
  /** 会话ID（Profile ID） */
  sessionId: string | null;
  /** 释放后该 Session 剩余的浏览器数量 */
  remainingBrowserCount: number;
  /** 是否已销毁 */
  destroyed: boolean;
}

// ============================================
// 等待队列
// ============================================

export interface WaitingRequest {
  /** 原始请求 */
  request: AcquireRequest;
  /** 数值优先级（high=100, normal=50, low=10） */
  priority: number;
  /** 入队时间 */
  enqueuedAt: number;
  /**
   * 结果回调
   * 无论成功或失败都通过此回调返回 AcquireResult
   * 使用 result.success 判断是否成功
   */
  resolve: (result: AcquireResult) => void;
  /** 超时定时器ID */
  timeoutId?: ReturnType<typeof setTimeout>;
  /** 是否已处理（防止竞态导致的重复处理） */
  resolved?: boolean;
}

// ============================================
// 统计信息
// ============================================

export interface PoolStats {
  /** 总浏览器数 */
  totalBrowsers: number;
  /** 空闲浏览器数 */
  idleBrowsers: number;
  /** 锁定浏览器数 */
  lockedBrowsers: number;
  /** 会话数 */
  sessionsCount: number;
  /** 等待请求数 */
  waitingRequests: number;
  /** 按会话分组的统计 */
  browsersBySession: Record<
    string,
    {
      total: number;
      idle: number;
      locked: number;
    }
  >;
}

export interface SessionStats {
  /** 会话ID */
  sessionId: string;
  /** 配额 */
  quota: number;
  /** 当前浏览器数 */
  browserCount: number;
  /** 空闲数 */
  idleCount: number;
  /** 锁定数 */
  lockedCount: number;
  /** 等待队列长度 */
  waitingCount: number;
}

// ============================================
// 浏览器句柄（返回给调用者）
// ============================================

export interface BrowserHandle {
  /** 浏览器实例（实现 BrowserInterface 接口） */
  browser: BrowserInterface;
  /** 浏览器ID */
  browserId: string;
  /** 会话ID */
  sessionId: string;
  /** 引擎类型 */
  engine: AutomationEngine;
  /** 视图ID（用于显示/隐藏浏览器视图；仅 electron 引擎存在） */
  viewId?: string;
  /**
   * 释放浏览器（推荐方式）
   *
   * 调用后浏览器放回池中，可被其他请求使用。
   * 这是释放浏览器的唯一推荐方式。
   *
   * @param options 释放选项
   * @returns 释放结果，包含剩余浏览器数量等信息
   *
   * @example
   * ```typescript
   * const handle = await poolManager.acquire(profileId);
   * try {
   *   await handle.browser.goto('https://example.com');
   * } finally {
   *   const result = await handle.release();
   *   console.log(`剩余浏览器: ${result.remainingBrowserCount}`);
   * }
   *
   * // 销毁浏览器（不回池）
   * await handle.release({ destroy: true });
   * ```
   */
  release: (options?: ReleaseOptions) => Promise<ReleaseResult>;
  /**
   * 续期锁定
   * 延长锁定时间，防止长时间操作被超时释放
   *
   * @param extensionMs 延长时间（ms），默认使用原始 lockTimeoutMs
   * @returns 是否续期成功
   */
  renew: (extensionMs?: number) => Promise<boolean>;
}
