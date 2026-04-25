/**
 * 定时任务工具模块
 *
 * 提供安全的定时任务管理功能
 */

import { ValidationError } from '../../errors';

/**
 * 定时任务控制器接口
 */
export interface TaskController {
  /** 停止任务（不可恢复）*/
  stop: () => void;
  /** 暂停任务（可恢复）*/
  pause: () => void;
  /** 恢复任务 */
  resume: () => void;
  /** 检查任务是否正在运行 */
  isRunning: () => boolean;
}

/**
 * 定时任务选项
 */
export interface IntervalOptions {
  /** 是否立即执行一次（默认false）*/
  immediate?: boolean;
  /** 如果上次还在运行，是否跳过本次（默认true，防止重叠）*/
  skipIfRunning?: boolean;
  /** 错误处理函数 */
  errorHandler?: (error: Error) => Promise<void> | void;
  /** 任务开始回调 */
  onStart?: () => void;
  /** 任务完成回调 */
  onComplete?: () => void;
}

/**
 * 定时任务工具类
 */
export class IntervalUtils {
  constructor(
    private pluginId: string,
    private helpers?: any // PluginHelpers类型（避免循环依赖）
  ) {}

  /**
   * 创建安全的定时任务（自动清理）
   *
   * 此方法创建的定时任务会在插件停止时自动清理，无需手动在onStop中清理。
   * 防止内存泄漏，简化开发者使用。
   *
   * @param handler - 任务处理函数
   * @param intervalMs - 执行间隔（毫秒）
   * @param options - 可选配置
   * @returns 任务控制器
   *
   * @example
   * // 基础用法：每分钟轮询订单
   * intervalUtils.createInterval(async () => {
   *   const orders = await helpers.database.query('orders_dataset_id',
   *     `SELECT * FROM data WHERE status = 'pending' LIMIT 100`
   *   );
   *   for (const order of orders) {
   *     await processOrder(order);
   *   }
   * }, 60000);
   *
   * @example
   * // 高级用法：立即执行、防重叠、错误处理
   * intervalUtils.createInterval(
   *   async () => {
   *     await pollOrders();
   *   },
   *   5 * 60 * 1000,  // 5分钟
   *   {
   *     immediate: true,        // 启动时立即执行一次
   *     skipIfRunning: true,    // 如果上次还在运行，跳过本次
   *     errorHandler: async (error) => {
   *       await helpers.ui.error(`轮询失败: ${error.message}`);
   *     },
   *     onStart: () => {
   *       console.log('[Polling] Task started');
   *     },
   *     onComplete: () => {
   *       console.log('[Polling] Task completed');
   *     }
   *   }
   * );
   *
   * @example
   * // 手动控制任务
   * const task = intervalUtils.createInterval(async () => {
   *   await doWork();
   * }, 60000);
   *
   * // 暂停任务
   * task.pause();
   *
   * // 恢复任务
   * task.resume();
   *
   * // 停止任务（不可恢复）
   * task.stop();
   *
   * // 检查是否正在运行
   * if (task.isRunning()) {
   *   console.log('Task is running');
   * }
   */
  createInterval(
    handler: () => Promise<void>,
    intervalMs: number,
    options?: IntervalOptions
  ): TaskController {
    // 参数验证
    if (typeof handler !== 'function') {
      throw new ValidationError('Handler must be a function', {
        parameter: 'handler',
        expectedType: 'function',
        actualValue: handler,
      });
    }

    if (typeof intervalMs !== 'number' || intervalMs <= 0) {
      throw new ValidationError('Interval must be a positive number', {
        parameter: 'intervalMs',
        expectedType: 'number (> 0)',
        actualValue: intervalMs,
      });
    }

    // 默认选项
    const opts: IntervalOptions = {
      immediate: false,
      skipIfRunning: true,
      ...options,
    };

    // 状态管理
    let intervalId: NodeJS.Timeout | null = null;
    let isRunning = false;
    let isStopped = false;
    let isPaused = false;

    // 包装的处理函数
    const wrappedHandler = async () => {
      // 如果已停止，直接返回
      if (isStopped) {
        return;
      }

      // 防止重叠执行
      if (opts.skipIfRunning && isRunning) {
        console.warn(
          `[IntervalUtils] Task still running, skipping this cycle (plugin: ${this.pluginId})`
        );
        return;
      }

      isRunning = true;

      // 调用onStart回调
      if (opts.onStart) {
        try {
          opts.onStart();
        } catch (error) {
          console.error(`[IntervalUtils] onStart callback failed:`, error);
        }
      }

      try {
        // 执行用户的处理函数
        await handler();

        // 调用onComplete回调
        if (opts.onComplete) {
          try {
            opts.onComplete();
          } catch (error) {
            console.error(`[IntervalUtils] onComplete callback failed:`, error);
          }
        }
      } catch (error: any) {
        // 错误处理
        if (opts.errorHandler) {
          try {
            await opts.errorHandler(error);
          } catch (handlerError) {
            console.error(`[IntervalUtils] Error handler failed:`, handlerError);
          }
        } else {
          console.error(`[IntervalUtils] Task failed (plugin: ${this.pluginId}):`, error);
        }
      } finally {
        isRunning = false;
      }
    };

    // 启动定时器
    const startInterval = () => {
      if (!intervalId && !isStopped && !isPaused) {
        intervalId = setInterval(wrappedHandler, intervalMs);
      }
    };

    // 停止定时器
    const stopInterval = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    // 立即执行一次
    if (opts.immediate) {
      wrappedHandler().catch((error) => {
        console.error(`[IntervalUtils] Initial execution failed:`, error);
      });
    }

    // 启动定时器
    startInterval();

    // 注册清理函数（自动清理）
    if (this.helpers && typeof this.helpers.registerDisposer === 'function') {
      this.helpers.registerDisposer(() => {
        stopInterval();
        isStopped = true;
      });
    }

    // 返回控制器
    return {
      stop: () => {
        stopInterval();
        isStopped = true;
      },
      pause: () => {
        stopInterval();
        isPaused = true;
      },
      resume: () => {
        if (!isStopped) {
          isPaused = false;
          startInterval();
        }
      },
      isRunning: () => isRunning,
    };
  }
}
