/**
 * 浏览器池配置常量
 *
 * v2 架构：用户可配置的浏览器性能设置
 */

/**
 * 浏览器池配置接口
 */
export interface BrowserPoolConfig {
  /** 性能模式 */
  mode: 'light' | 'standard' | 'performance' | 'custom';

  /** 全局最大浏览器数量 */
  maxTotalBrowsers: number;

  /** 最大并发创建数量 */
  maxConcurrentCreation: number;

  /** 默认空闲超时（毫秒） */
  defaultIdleTimeoutMs: number;

  /** 默认锁定超时（毫秒） */
  defaultLockTimeoutMs: number;

  /** 健康检查间隔（毫秒） */
  healthCheckIntervalMs: number;
}

/**
 * 性能模式预设
 */
export const BROWSER_POOL_PRESETS: Record<
  'light' | 'standard' | 'performance',
  Omit<BrowserPoolConfig, 'mode'>
> = {
  /** 轻量模式（低配机器） */
  light: {
    maxTotalBrowsers: 5,
    maxConcurrentCreation: 2,
    defaultIdleTimeoutMs: 3 * 60 * 1000, // 3分钟
    defaultLockTimeoutMs: 3 * 60 * 1000,
    healthCheckIntervalMs: 60 * 1000, // 1分钟
  },

  /** 标准模式（默认） */
  standard: {
    maxTotalBrowsers: 10,
    maxConcurrentCreation: 3,
    defaultIdleTimeoutMs: 5 * 60 * 1000, // 5分钟
    defaultLockTimeoutMs: 5 * 60 * 1000,
    healthCheckIntervalMs: 30 * 1000, // 30秒
  },

  /** 高性能模式 */
  performance: {
    maxTotalBrowsers: 20,
    maxConcurrentCreation: 5,
    defaultIdleTimeoutMs: 10 * 60 * 1000, // 10分钟
    defaultLockTimeoutMs: 10 * 60 * 1000,
    healthCheckIntervalMs: 30 * 1000,
  },
};

/**
 * 默认浏览器池配置
 */
export const DEFAULT_BROWSER_POOL_CONFIG: BrowserPoolConfig = {
  mode: 'standard',
  ...BROWSER_POOL_PRESETS.standard,
};

/**
 * 配置限制（用于验证用户输入）
 */
export const BROWSER_POOL_LIMITS = {
  maxTotalBrowsers: { min: 1, max: 50 },
  maxConcurrentCreation: { min: 1, max: 10 },
  defaultIdleTimeoutMs: { min: 60 * 1000, max: 60 * 60 * 1000 }, // 1分钟到1小时
  defaultLockTimeoutMs: { min: 60 * 1000, max: 60 * 60 * 1000 },
  healthCheckIntervalMs: { min: 10 * 1000, max: 5 * 60 * 1000 }, // 10秒到5分钟
};

/**
 * 等待队列配置常量
 */
export const WAIT_QUEUE_CONFIG = {
  /** 饥饿阈值（超过此时间提升优先级） */
  starvationThresholdMs: 30 * 1000, // 30秒
  /** 饥饿优先级提升值 */
  starvationBoost: 20,
  /** 最大等待超时时间（防止 Promise 泄漏） */
  maxWaitTimeoutMs: 10 * 60 * 1000, // 10分钟
  /** 默认获取超时时间 */
  defaultAcquireTimeoutMs: 30 * 1000, // 30秒
} as const;

/**
 * 优先级数值映射
 */
export const PRIORITY_VALUES = {
  high: 100,
  normal: 50,
  low: 10,
} as const;

/**
 * 浏览器工厂超时时间（毫秒）
 *
 * 防止 browserFactory 无限期挂起导致信号量永久占用
 */
export const BROWSER_FACTORY_TIMEOUT_MS = 60 * 1000; // 60秒

/**
 * 默认浏览器 Profile 常量
 */
export const DEFAULT_BROWSER_PROFILE = {
  id: 'default',
  name: '默认浏览器',
  partition: 'persist:default',
  notes: '系统内置的默认浏览器，不可删除',
  tags: ['系统'],
  color: '#6366f1',
  quota: 1,
  idleTimeoutMs: 5 * 60 * 1000,
  lockTimeoutMs: 5 * 60 * 1000,
} as const;
