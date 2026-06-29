/**
 * 事件总线 - 基于 tapable 实现
 * 支持广播型事件（subscribe）和拦截型钩子（intercept）
 */

import { AsyncParallelHook, AsyncSeriesWaterfallHook } from 'tapable';
import { createLogger } from './logger';

const logger = createLogger('HookBus');

/**
 * Hook 类型定义
 */
type BroadcastHook = AsyncParallelHook<[unknown]>;
type InterceptHook = AsyncSeriesWaterfallHook<[unknown]>;

/**
 * 处理器信息
 */
interface HandlerInfo {
  handler: Function;
  type: 'subscribe' | 'intercept';
  name: string;
}

// ============================================
// 类型安全支持
// ============================================

/**
 * 事件映射类型约束
 * key 为事件名，value 为事件数据类型
 */
export type HookEventMap = Record<string, any>;

/**
 * 广播事件处理器类型
 */
export type BroadcastHandler<T> = (payload: T) => void | Promise<void>;

/**
 * 拦截事件处理器类型
 */
export type InterceptHandler<T> = (payload: T) => T | Promise<T>;

/**
 * HookBus 类 - 事件总线
 * 使用 tapable 实现高性能的事件分发和拦截
 *
 * @template TEvents - 可选的事件类型映射，提供类型安全支持
 *
 * @example
 * // 无类型约束（向后兼容）
 * const bus = new HookBus();
 * bus.on('my-event', (data) => console.log(data));
 *
 * @example
 * // 有类型约束
 * interface MyEvents {
 *   'user:login': { userId: string };
 *   'user:logout': { userId: string };
 * }
 * const bus = new HookBus<MyEvents>();
 * bus.on('user:login', (data) => {
 *   // data 类型为 { userId: string }
 *   console.log(data.userId);
 * });
 */
export class HookBus<TEvents extends HookEventMap = HookEventMap> {
  /** 广播型 Hook 存储 */
  private broadcastHooks = new Map<string, BroadcastHook>();

  /** 拦截型 Hook 存储 */
  private interceptHooks = new Map<string, InterceptHook>();

  /** 处理器注册表（用于 off 操作） */
  private handlers = new Map<string, HandlerInfo[]>();

  /**
   * 获取或创建广播 Hook
   */
  private getBroadcastHook(event: string): BroadcastHook {
    if (!this.broadcastHooks.has(event)) {
      this.broadcastHooks.set(event, new AsyncParallelHook(['payload']));
    }
    return this.broadcastHooks.get(event)!;
  }

  /**
   * 获取或创建拦截 Hook
   */
  private getInterceptHook(event: string): InterceptHook {
    if (!this.interceptHooks.has(event)) {
      this.interceptHooks.set(event, new AsyncSeriesWaterfallHook(['payload']));
    }
    return this.interceptHooks.get(event)!;
  }

  /**
   * 生成唯一的处理器名称
   */
  private generateHandlerName(handler: Function, index: number): string {
    return handler.name || `anonymous_${index}_${Date.now()}`;
  }

  /**
   * 订阅广播型事件（只读）
   * @param event - 事件名称
   * @param handler - 处理器函数
   *
   * @example
   * bus.on('user:login', (data) => {
   *   console.log('User logged in:', data.userId);
   * });
   */
  on<K extends keyof TEvents & string>(event: K, handler: BroadcastHandler<TEvents[K]>): void {
    const hook = this.getBroadcastHook(event);

    // 记录处理器信息
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    const handlers = this.handlers.get(event)!;
    const name = this.generateHandlerName(handler, handlers.length);

    handlers.push({ handler, type: 'subscribe', name });

    // 注册到 tapable
    hook.tapPromise(name, async (payload: unknown) => {
      try {
        await handler(payload as TEvents[K]);
      } catch (err) {
        logger.error(`Hook ${event} subscriber error`, err);
      }
    });
  }

  /**
   * 注册拦截型钩子（可改写返回值）
   * @param event - 事件名称
   * @param handler - 处理器函数，接收 payload 并返回修改后的值
   *
   * @example
   * bus.intercept('request:before', (req) => {
   *   req.headers['x-custom'] = 'value';
   *   return req; // 必须返回修改后的值
   * });
   */
  intercept<K extends keyof TEvents & string>(
    event: K,
    handler: InterceptHandler<TEvents[K]>
  ): void {
    const hook = this.getInterceptHook(event);

    // 记录处理器信息
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    const handlers = this.handlers.get(event)!;
    const name = this.generateHandlerName(handler, handlers.length);

    handlers.push({ handler, type: 'intercept', name });

    // 注册到 tapable
    hook.tapPromise(name, async (payload: unknown) => {
      try {
        return await handler(payload as TEvents[K]);
      } catch (err) {
        logger.error(`Hook ${event} interceptor error`, err);
        return payload; // 出错时返回原值
      }
    });
  }

  /**
   * 发送广播型事件
   * @param event - 事件名称
   * @param payload - 事件负载
   *
   * @example
   * await bus.emit('user:login', { userId: '123' });
   */
  async emit<K extends keyof TEvents & string>(event: K, payload?: TEvents[K]): Promise<void> {
    const hook = this.broadcastHooks.get(event);
    if (hook) {
      await hook.promise(payload);
    }
  }

  /**
   * 调用拦截型钩子（可改写返回值）
   * @param event - 事件名称
   * @param payload - 初始负载
   * @returns 经过拦截器链处理后的值
   *
   * @example
   * const result = await bus.call('transform:data', { value: 1 });
   * // result 可能被拦截器修改
   */
  async call<K extends keyof TEvents & string>(event: K, payload: TEvents[K]): Promise<TEvents[K]> {
    const hook = this.interceptHooks.get(event);
    if (hook) {
      return (await hook.promise(payload)) as TEvents[K];
    }
    return payload;
  }

  /**
   * 移除监听器
   * 注意：由于 tapable 的设计，无法真正移除已注册的 tap
   * 此方法主要用于内部记录清理，实际移除需要重建 Hook
   * @param event - 事件名称
   * @param handler - 要移除的处理器
   */
  off<K extends keyof TEvents & string>(
    event: K,
    handler: BroadcastHandler<TEvents[K]> | InterceptHandler<TEvents[K]>
  ): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const index = handlers.findIndex((h) => h.handler === handler);
      if (index > -1) {
        const removed = handlers.splice(index, 1)[0];

        // 重建对应的 Hook
        if (removed.type === 'subscribe') {
          this.rebuildBroadcastHook(event);
        } else {
          this.rebuildInterceptHook(event);
        }
      }
    }
  }

  /**
   * 重建广播 Hook
   */
  private rebuildBroadcastHook(event: string): void {
    const handlers = this.handlers.get(event)?.filter((h) => h.type === 'subscribe') || [];
    const newHook = new AsyncParallelHook<[unknown]>(['payload']);

    for (const info of handlers) {
      newHook.tapPromise(info.name, async (payload: unknown) => {
        try {
          await info.handler(payload);
        } catch (err) {
          logger.error(`Hook ${event} subscriber error`, err);
        }
      });
    }

    this.broadcastHooks.set(event, newHook);
  }

  /**
   * 重建拦截 Hook
   */
  private rebuildInterceptHook(event: string): void {
    const handlers = this.handlers.get(event)?.filter((h) => h.type === 'intercept') || [];
    const newHook = new AsyncSeriesWaterfallHook<[unknown]>(['payload']);

    for (const info of handlers) {
      newHook.tapPromise(info.name, async (payload: unknown) => {
        try {
          return await info.handler(payload);
        } catch (err) {
          logger.error(`Hook ${event} interceptor error`, err);
          return payload;
        }
      });
    }

    this.interceptHooks.set(event, newHook);
  }

  /**
   * 清空所有监听器
   */
  clear(): void {
    this.broadcastHooks.clear();
    this.interceptHooks.clear();
    this.handlers.clear();
  }

  /**
   * 清空特定事件的监听器
   * @param event - 事件名称
   */
  clearEvent(event: string): void {
    this.broadcastHooks.delete(event);
    this.interceptHooks.delete(event);
    this.handlers.delete(event);
  }

  /**
   * 获取事件的处理器数量
   * @param event - 事件名称
   * @returns 处理器数量
   */
  listenerCount(event: string): number {
    return this.handlers.get(event)?.length || 0;
  }

  /**
   * 获取所有已注册的事件名称
   * @returns 事件名称数组
   */
  eventNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * 检查事件是否有监听器
   * @param event - 事件名称
   * @returns 是否有监听器
   */
  hasListeners(event: string): boolean {
    return this.listenerCount(event) > 0;
  }
}
