/**
 * 类型安全的事件发射器基类
 *
 * 提供统一的类型安全事件处理机制，所有使用 EventEmitter 的模块都应继承此类
 *
 * @example
 * interface MyEvents {
 *   'user:login': { userId: string; timestamp: number };
 *   'user:logout': { userId: string };
 * }
 *
 * class MyEmitter extends TypedEventEmitter<MyEvents> {
 *   login(userId: string) {
 *     this.emit('user:login', { userId, timestamp: Date.now() });
 *   }
 * }
 *
 * const emitter = new MyEmitter();
 * emitter.on('user:login', (data) => {
 *   // data 自动推断为 { userId: string; timestamp: number }
 *   console.log(data.userId);
 * });
 */

import { EventEmitter } from 'events';

/**
 * 事件监听器类型
 */
export type EventListener<T> = (data: T) => void;

/**
 * 事件映射类型约束
 * 允许任何具有字符串键的对象类型
 */
export type EventMap = Record<string, any>;

/**
 * 类型安全的事件发射器
 *
 * @template TEvents - 事件映射类型，key 为事件名，value 为事件数据类型
 */
export class TypedEventEmitter<TEvents extends EventMap> extends EventEmitter {
  /**
   * 发射事件
   *
   * @param event - 事件名称
   * @param data - 事件数据
   * @returns 是否有监听器处理了该事件
   */
  emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): boolean {
    return super.emit(event, data);
  }

  /**
   * 监听事件
   *
   * @param event - 事件名称
   * @param listener - 事件处理函数
   * @returns this（支持链式调用）
   */
  on<K extends keyof TEvents & string>(event: K, listener: EventListener<TEvents[K]>): this {
    return super.on(event, listener);
  }

  /**
   * 监听事件（只触发一次）
   *
   * @param event - 事件名称
   * @param listener - 事件处理函数
   * @returns this（支持链式调用）
   */
  once<K extends keyof TEvents & string>(event: K, listener: EventListener<TEvents[K]>): this {
    return super.once(event, listener);
  }

  /**
   * 移除事件监听器
   *
   * @param event - 事件名称
   * @param listener - 要移除的事件处理函数
   * @returns this（支持链式调用）
   */
  off<K extends keyof TEvents & string>(event: K, listener: EventListener<TEvents[K]>): this {
    return super.off(event, listener);
  }

  /**
   * 添加事件监听器到监听器数组的开头
   *
   * @param event - 事件名称
   * @param listener - 事件处理函数
   * @returns this（支持链式调用）
   */
  prependListener<K extends keyof TEvents & string>(
    event: K,
    listener: EventListener<TEvents[K]>
  ): this {
    return super.prependListener(event, listener);
  }

  /**
   * 添加一次性事件监听器到监听器数组的开头
   *
   * @param event - 事件名称
   * @param listener - 事件处理函数
   * @returns this（支持链式调用）
   */
  prependOnceListener<K extends keyof TEvents & string>(
    event: K,
    listener: EventListener<TEvents[K]>
  ): this {
    return super.prependOnceListener(event, listener);
  }

  /**
   * 移除指定事件的所有监听器
   *
   * @param event - 事件名称（可选，不传则移除所有事件的监听器）
   * @returns this（支持链式调用）
   */
  removeAllListeners<K extends keyof TEvents & string>(event?: K): this {
    return super.removeAllListeners(event);
  }

  /**
   * 获取指定事件的监听器数量
   *
   * @param event - 事件名称
   * @returns 监听器数量
   */
  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return super.listenerCount(event);
  }

  /**
   * 获取指定事件的所有监听器
   *
   * @param event - 事件名称
   * @returns 监听器数组
   */
  listeners<K extends keyof TEvents & string>(event: K): EventListener<TEvents[K]>[] {
    return super.listeners(event) as EventListener<TEvents[K]>[];
  }

  /**
   * 获取指定事件的所有监听器（包括一次性监听器的包装器）
   *
   * @param event - 事件名称
   * @returns 监听器数组
   */
  rawListeners<K extends keyof TEvents & string>(event: K): EventListener<TEvents[K]>[] {
    return super.rawListeners(event) as EventListener<TEvents[K]>[];
  }
}
