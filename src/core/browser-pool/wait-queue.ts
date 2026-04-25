/**
 * 等待队列
 *
 * 当没有可用浏览器时，请求进入等待队列
 * 支持优先级排序和防饥饿机制
 *
 * 设计原则：
 * - 优先级队列：高优先级请求优先处理
 * - 防饥饿：低优先级请求等待过久会提升优先级
 * - 超时机制：请求超时自动移除
 * - 公平性：同优先级按 FIFO 处理
 */

import { Mutex } from 'async-mutex';
import type {
  AcquireRequest,
  AcquireResult,
  WaitingRequest,
  AcquirePriority,
  AutomationEngine,
} from './types';
import { WAIT_QUEUE_CONFIG, PRIORITY_VALUES } from '../../constants/browser-pool';
import { createLogger } from '../logger';

const logger = createLogger('WaitQueue');

/** 优先级数值映射（引用配置常量） */
const PRIORITY_MAP: Record<AcquirePriority, number> = PRIORITY_VALUES;

const DEFAULT_ENGINE: AutomationEngine = 'electron';

function getQueueKey(sessionId: string, engine?: AutomationEngine): string {
  return `${sessionId}::${engine ?? DEFAULT_ENGINE}`;
}

function getEngineFromRequest(request: AcquireRequest): AutomationEngine {
  return request.options.engine ?? DEFAULT_ENGINE;
}

/**
 * 等待队列
 */
export class WaitQueue {
  /** 等待队列（按会话分组） */
  private queues: Map<string, WaitingRequest[]> = new Map();

  /** 请求映射（用于快速查找） */
  private requestMap: Map<string, WaitingRequest> = new Map();

  /** 标记队列是否需要重新排序（脏标记，避免重复排序） */
  private dirtyQueues: Set<string> = new Set();

  /** Per-session 互斥锁（防止并发操作同一队列） */
  private sessionLocks: Map<string, Mutex> = new Map();

  /**
   * 获取或创建 session 的互斥锁
   */
  private getSessionLock(sessionId: string): Mutex {
    let lock = this.sessionLocks.get(sessionId);
    if (!lock) {
      lock = new Mutex();
      this.sessionLocks.set(sessionId, lock);
    }
    return lock;
  }

  /**
   * 添加等待请求
   *
   * @param request 获取请求
   * @returns Promise，在获取到浏览器或超时时 resolve（通过 result.success 判断成功与否）
   */
  enqueue(request: AcquireRequest): Promise<AcquireResult> {
    return new Promise((resolve) => {
      const sessionId = request.sessionId;
      const engine = getEngineFromRequest(request);
      const queueKey = getQueueKey(sessionId, engine);

      // 创建等待请求
      const waitingRequest: WaitingRequest = {
        request,
        priority: PRIORITY_MAP[request.options.priority] || PRIORITY_MAP.normal,
        enqueuedAt: Date.now(),
        resolve,
      };

      // 设置超时（必须设置，防止 Promise 永久挂起导致内存泄漏）
      // 使用请求指定的超时时间，但不超过最大等待超时
      const requestTimeout = request.options.timeout;
      const effectiveTimeout =
        requestTimeout && requestTimeout > 0
          ? Math.min(requestTimeout, WAIT_QUEUE_CONFIG.maxWaitTimeoutMs)
          : WAIT_QUEUE_CONFIG.maxWaitTimeoutMs;

      waitingRequest.timeoutId = setTimeout(() => {
        // 防止竞态：检查是否已被其他路径处理
        if (waitingRequest.resolved) {
          return;
        }
        waitingRequest.resolved = true;

        // 安全移除请求，防止异常导致内存泄漏
        try {
          this.removeRequest(request.requestId);
        } catch (err) {
          logger.error('Failed to remove timed-out request: ' + request.requestId, err);
          // 回退：手动清理
          const queue = this.queues.get(queueKey);
          if (queue) {
            const idx = queue.indexOf(waitingRequest);
            if (idx >= 0) queue.splice(idx, 1);
            if (queue.length === 0) {
              this.queues.delete(queueKey);
              this.sessionLocks.delete(queueKey);
            }
          }
          this.requestMap.delete(request.requestId);
        }

        resolve({
          success: false,
          error: `Acquire timeout after ${effectiveTimeout}ms`,
          waitedMs: Date.now() - waitingRequest.enqueuedAt,
        });
      }, effectiveTimeout);

      // 添加到队列
      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, []);
      }
      this.queues.get(queueKey)!.push(waitingRequest);
      this.requestMap.set(request.requestId, waitingRequest);

      // 标记队列为脏，延迟排序到实际需要时
      this.dirtyQueues.add(queueKey);

      logger.debug(
        'Request enqueued: ' +
          request.requestId +
          ' (session: ' +
          sessionId +
          ', engine: ' +
          engine +
          ', priority: ' +
          request.options.priority +
          ')'
      );
    });
  }

  /**
   * 确保队列已排序（延迟排序）
   *
   * 只在脏标记存在时执行排序，避免 peek/dequeue 重复排序
   */
  private ensureSorted(queueKey: string): void {
    if (this.dirtyQueues.has(queueKey)) {
      this.applyAntiStarvation(queueKey);
      this.sortQueue(queueKey);
      this.dirtyQueues.delete(queueKey);
    }
  }

  /**
   * 取出下一个等待请求
   *
   * @param sessionId 会话ID
   * @returns 下一个请求或 undefined
   */
  async dequeue(sessionId: string, engine: AutomationEngine): Promise<WaitingRequest | undefined> {
    const queueKey = getQueueKey(sessionId, engine);
    const lock = this.getSessionLock(queueKey);

    return lock.runExclusive(() => {
      const queue = this.queues.get(queueKey);
      if (!queue || queue.length === 0) {
        return undefined;
      }

      // 延迟排序：只在需要时执行一次
      this.ensureSorted(queueKey);

      // 取出第一个（最高优先级）
      const waitingRequest = queue.shift();
      if (waitingRequest) {
        // 标记为已处理，防止竞态
        waitingRequest.resolved = true;

        // 清除超时定时器
        if (waitingRequest.timeoutId) {
          clearTimeout(waitingRequest.timeoutId);
        }

        // 从映射中移除
        this.requestMap.delete(waitingRequest.request.requestId);

        logger.debug(
          'Request dequeued: ' +
            waitingRequest.request.requestId +
            ' (waited: ' +
            (Date.now() - waitingRequest.enqueuedAt) +
            'ms)'
        );
      }

      // 清理空队列
      if (queue.length === 0) {
        this.queues.delete(queueKey);
        // 清理不再需要的锁
        this.sessionLocks.delete(queueKey);
      }

      return waitingRequest;
    });
  }

  /**
   * 查看下一个等待请求（不移除）
   *
   * @param sessionId 会话ID
   * @returns 下一个请求或 undefined
   */
  async peek(sessionId: string, engine: AutomationEngine): Promise<WaitingRequest | undefined> {
    const queueKey = getQueueKey(sessionId, engine);
    const lock = this.getSessionLock(queueKey);

    return lock.runExclusive(() => {
      const queue = this.queues.get(queueKey);
      if (!queue || queue.length === 0) {
        return undefined;
      }

      // 延迟排序：只在需要时执行一次
      this.ensureSorted(queueKey);

      return queue[0];
    });
  }

  /**
   * 移除指定请求
   *
   * @param requestId 请求ID
   * @returns 是否成功移除
   */
  removeRequest(requestId: string): boolean {
    const waitingRequest = this.requestMap.get(requestId);
    if (!waitingRequest) {
      return false;
    }

    const sessionId = waitingRequest.request.sessionId;
    const engine = getEngineFromRequest(waitingRequest.request);
    const queueKey = getQueueKey(sessionId, engine);
    const queue = this.queues.get(queueKey);

    if (queue) {
      const index = queue.findIndex((r) => r.request.requestId === requestId);
      if (index > -1) {
        queue.splice(index, 1);

        // 清除超时定时器
        if (waitingRequest.timeoutId) {
          clearTimeout(waitingRequest.timeoutId);
        }

        // 清理空队列
        if (queue.length === 0) {
          this.queues.delete(queueKey);
          this.sessionLocks.delete(queueKey);
          this.dirtyQueues.delete(queueKey);
        }
      }
    }

    this.requestMap.delete(requestId);

    logger.debug('Request removed: ' + requestId);

    return true;
  }

  /**
   * 取消指定请求
   *
   * @param requestId 请求ID
   * @param reason 取消原因
   * @returns 是否成功取消
   */
  cancelRequest(requestId: string, reason: string = 'Cancelled'): boolean {
    const waitingRequest = this.requestMap.get(requestId);
    if (!waitingRequest) {
      return false;
    }

    // 防止竞态：检查是否已被其他路径处理
    if (waitingRequest.resolved) {
      return false;
    }
    waitingRequest.resolved = true;

    // 先移除
    this.removeRequest(requestId);

    // 然后 resolve 失败结果
    waitingRequest.resolve({
      success: false,
      error: reason,
      waitedMs: Date.now() - waitingRequest.enqueuedAt,
    });

    logger.debug('Request cancelled: ' + requestId + ' (reason: ' + reason + ')');

    return true;
  }

  /**
   * 取消会话的所有等待请求
   *
   * @param sessionId 会话ID
   * @param reason 取消原因
   * @returns 取消的数量
   */
  cancelBySession(sessionId: string, reason: string = 'Session cancelled'): number {
    const keys = Array.from(this.queues.keys()).filter((k) => k.startsWith(`${sessionId}::`));
    if (keys.length === 0) return 0;

    let count = 0;
    for (const key of keys) {
      const queue = this.queues.get(key);
      if (!queue || queue.length === 0) continue;
      count += queue.length;
      const requestIds = queue.map((r) => r.request.requestId);
      for (const requestId of requestIds) {
        this.cancelRequest(requestId, reason);
      }
    }

    return count;
  }

  /**
   * 取消插件的所有等待请求
   *
   * @param pluginId 插件ID
   * @param reason 取消原因
   * @returns 取消的数量
   */
  cancelByPlugin(pluginId: string, reason: string = 'Plugin stopped'): number {
    let count = 0;

    for (const queue of this.queues.values()) {
      const toCancel = queue
        .filter((r) => r.request.pluginId === pluginId)
        .map((r) => r.request.requestId);

      for (const requestId of toCancel) {
        if (this.cancelRequest(requestId, reason)) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * 获取会话的等待数量
   *
   * @param sessionId 会话ID
   */
  getWaitingCount(sessionId: string): number {
    let total = 0;
    for (const [key, queue] of this.queues.entries()) {
      if (!key.startsWith(`${sessionId}::`)) continue;
      total += queue.length;
    }
    return total;
  }

  /**
   * 获取总等待数量
   */
  getTotalWaitingCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * 获取所有有等待请求的会话ID
   */
  getWaitingSessionIds(): string[] {
    const sessionIds = new Set<string>();
    for (const key of this.queues.keys()) {
      const [sessionId] = key.split('::');
      if (sessionId) sessionIds.add(sessionId);
    }
    return Array.from(sessionIds);
  }

  /**
   * 检查请求是否在等待
   *
   * @param requestId 请求ID
   */
  isWaiting(requestId: string): boolean {
    return this.requestMap.has(requestId);
  }

  /**
   * 获取请求的等待信息
   *
   * @param requestId 请求ID
   */
  getRequestInfo(requestId: string): {
    sessionId: string;
    priority: number;
    waitedMs: number;
    position: number;
  } | null {
    const waitingRequest = this.requestMap.get(requestId);
    if (!waitingRequest) {
      return null;
    }

    const sessionId = waitingRequest.request.sessionId;
    const engine = getEngineFromRequest(waitingRequest.request);
    const queueKey = getQueueKey(sessionId, engine);

    // 确保队列已排序，以便正确计算位置
    this.ensureSorted(queueKey);

    const queue = this.queues.get(queueKey);
    const position = queue?.findIndex((r) => r.request.requestId === requestId) ?? -1;

    return {
      sessionId,
      priority: waitingRequest.priority,
      waitedMs: Date.now() - waitingRequest.enqueuedAt,
      position: position + 1, // 1-based
    };
  }

  /**
   * 清空所有队列
   *
   * @param reason 取消原因
   */
  clear(reason: string = 'Queue cleared'): void {
    for (const sessionId of this.getWaitingSessionIds()) {
      this.cancelBySession(sessionId, reason);
    }
  }

  /**
   * 应用防饥饿机制
   *
   * 为等待过久的请求提升优先级
   *
   * @param sessionId 会话ID
   */
  private applyAntiStarvation(queueKey: string): void {
    const queue = this.queues.get(queueKey);
    if (!queue) return;

    const now = Date.now();
    const { starvationThresholdMs, starvationBoost } = WAIT_QUEUE_CONFIG;

    for (const request of queue) {
      const waitedMs = now - request.enqueuedAt;

      if (waitedMs > starvationThresholdMs) {
        // 每超过阈值一次，提升一次优先级
        const boostCount = Math.floor(waitedMs / starvationThresholdMs);
        const originalPriority =
          PRIORITY_MAP[request.request.options.priority] || PRIORITY_MAP.normal;
        request.priority = originalPriority + boostCount * starvationBoost;
      }
    }
  }

  /**
   * 排序队列
   *
   * 按优先级降序，同优先级按入队时间升序（FIFO）
   *
   * @param sessionId 会话ID
   */
  private sortQueue(queueKey: string): void {
    const queue = this.queues.get(queueKey);
    if (!queue) return;

    queue.sort((a, b) => {
      // 优先级高的在前
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      // 同优先级，先到的在前（FIFO）
      return a.enqueuedAt - b.enqueuedAt;
    });
  }

  /**
   * 获取队列统计信息
   */
  getStats(): {
    totalWaiting: number;
    bySession: Record<string, number>;
    oldestWaitMs: number;
  } {
    let totalWaiting = 0;
    let oldestWaitMs = 0;
    const bySession: Record<string, number> = {};
    const now = Date.now();

    for (const [queueKey, queue] of this.queues.entries()) {
      const [sessionId] = queueKey.split('::');
      if (!sessionId) continue;
      bySession[sessionId] = (bySession[sessionId] || 0) + queue.length;
      totalWaiting += queue.length;

      for (const request of queue) {
        const waitedMs = now - request.enqueuedAt;
        if (waitedMs > oldestWaitMs) {
          oldestWaitMs = waitedMs;
        }
      }
    }

    return { totalWaiting, bySession, oldestWaitMs };
  }
}
