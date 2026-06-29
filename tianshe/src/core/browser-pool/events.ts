/**
 * 浏览器池事件系统
 *
 * 提供事件驱动的状态变更通知，让各组件可以订阅浏览器池的状态变化
 *
 * @example
 * const emitter = getBrowserPoolEvents();
 * emitter.on('browser:acquired', ({ browserId, sessionId }) => {
 *   console.log('Browser acquired:', browserId);
 * });
 */

import { EventEmitter } from 'events';

// ============================================
// 事件类型定义
// ============================================

/**
 * 浏览器获取事件
 */
export interface BrowserAcquiredEvent {
  browserId: string;
  /** 会话ID（对应 Profile ID） */
  sessionId: string;
  pluginId?: string;
  source: 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin';
  waitedMs: number;
}

/**
 * 浏览器释放事件
 */
export interface BrowserReleasedEvent {
  browserId: string;
  /** 会话ID（对应 Profile ID） */
  sessionId: string;
  pluginId?: string;
  destroy: boolean;
}

/**
 * 浏览器锁续期事件
 */
export interface BrowserLockRenewedEvent {
  browserId: string;
  /** 会话ID（对应 Profile ID） */
  sessionId?: string;
  extensionMs?: number;
}

export interface BrowserHandoffRequestedEvent {
  browserId?: string | null;
  /** 会话ID（对应 Profile ID） */
  sessionId: string;
  runtimeId?: string | null;
  viewId?: string | null;
  requestedBy: {
    source: 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin';
  };
  currentHolder: {
    source: 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin';
    pluginId?: string | null;
    requestId?: string | null;
  };
  policy: 'human_priority';
  manualRequired: true;
  requestedAt: number;
}

export interface BrowserLockHandoffEvent {
  browserId: string;
  /** 会话ID（对应 Profile ID） */
  sessionId: string;
  previousHolder: {
    source: 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin';
    pluginId?: string;
    requestId?: string;
  };
  newHolder: {
    source: 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin';
    pluginId?: string;
    requestId: string;
  };
  reason: 'agent_takeover';
  pausePreviousHolder: true;
  handedOffAt: number;
}

// ============================================
// 事件映射
// ============================================

export interface BrowserPoolEvents {
  'browser:acquired': BrowserAcquiredEvent;
  'browser:released': BrowserReleasedEvent;
  'browser:lock-renewed': BrowserLockRenewedEvent;
  'browser:handoff-requested': BrowserHandoffRequestedEvent;
  'browser:lock-handoff': BrowserLockHandoffEvent;
}

// ============================================
// 类型安全的 EventEmitter
// ============================================

/**
 * 类型安全的浏览器池事件发射器
 */
export class BrowserPoolEventEmitter extends EventEmitter {
  emit<K extends keyof BrowserPoolEvents>(event: K, data: BrowserPoolEvents[K]): boolean {
    return super.emit(event, data);
  }

  on<K extends keyof BrowserPoolEvents>(
    event: K,
    listener: (data: BrowserPoolEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof BrowserPoolEvents>(
    event: K,
    listener: (data: BrowserPoolEvents[K]) => void
  ): this {
    return super.once(event, listener);
  }

  off<K extends keyof BrowserPoolEvents>(
    event: K,
    listener: (data: BrowserPoolEvents[K]) => void
  ): this {
    return super.off(event, listener);
  }
}

// ============================================
// 工厂函数
// ============================================

/**
 * 创建浏览器池事件发射器
 *
 * 每个 BrowserPoolManager 实例应该拥有自己的事件发射器，
 * 生命周期随 Manager 一起管理
 *
 * @returns 新的事件发射器实例
 */
export function createBrowserPoolEventEmitter(): BrowserPoolEventEmitter {
  const emitter = new BrowserPoolEventEmitter();
  // 设置最大监听器数量，避免警告
  emitter.setMaxListeners(50);
  return emitter;
}
