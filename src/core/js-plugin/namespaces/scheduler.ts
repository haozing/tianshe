/**
 * Scheduler Namespace
 *
 * 提供定时任务调度的命名空间接口
 * 基于 core/task-manager/Scheduler 的插件层封装
 *
 * @example
 * // 创建 Cron 定时任务
 * const task = await helpers.scheduler.create({
 *   name: '每日订单同步',
 *   cron: '0 9 * * *',  // 每天 9:00
 *   handler: async () => {
 *     await syncOrders();
 *   }
 * });
 *
 * @example
 * // 创建固定间隔任务
 * const task = await helpers.scheduler.create({
 *   name: '库存检查',
 *   interval: '30m',  // 每 30 分钟
 *   handler: async () => {
 *     await checkInventory();
 *   },
 *   immediate: true  // 立即执行第一次
 * });
 *
 * @example
 * // 创建一次性任务
 * const task = await helpers.scheduler.create({
 *   name: '延迟通知',
 *   runAt: new Date(Date.now() + 60000),  // 1 分钟后
 *   handler: async () => {
 *     await sendNotification();
 *   }
 * });
 */

import type { SchedulerService } from '../../../main/scheduler';
import {
  Scheduler,
  setSchedulerService as setCoreSchedulerService,
  getSchedulerService as getCoreSchedulerService,
} from '../../task-manager';
import type { ScheduleOptions, ScheduledTaskInfo, ExecutionInfo } from '../../task-manager';

// Re-export types for plugin developers
export type {
  ScheduleOptions,
  ScheduledTaskInfo,
  ExecutionInfo,
  ScheduleType,
  SchedulerTaskContext,
  MissedPolicy,
} from '../../task-manager';

// 兼容旧的 CreateTaskOptions 类型
export type CreateTaskOptions = ScheduleOptions;

// 兼容旧的 TaskInfo 类型
export type TaskInfo = ScheduledTaskInfo;

/**
 * 设置全局 SchedulerService 引用
 * @internal
 */
export function setSchedulerService(service: SchedulerService): void {
  setCoreSchedulerService(service);
}

/**
 * 获取全局 SchedulerService 引用
 * @internal
 */
export function getSchedulerService(): SchedulerService | null {
  return getCoreSchedulerService();
}

/**
 * Scheduler 命名空间
 *
 * 提供定时任务调度能力：
 * - Cron 表达式定时
 * - 固定间隔执行
 * - 一次性延迟执行
 */
export class SchedulerNamespace {
  private scheduler: Scheduler;

  constructor(private pluginId: string) {
    const schedulerService = getCoreSchedulerService();
    this.scheduler = new Scheduler({
      schedulerService,
      callerId: pluginId,
    });
  }

  /**
   * 创建定时任务
   *
   * @param options - 任务选项
   * @returns 创建的任务信息
   *
   * @example
   * const task = await helpers.scheduler.create({
   *   name: '每日数据同步',
   *   cron: '0 9 * * *',
   *   handler: async () => {
   *     const orders = await fetchOrders();
   *     await saveToDatabase(orders);
   *     return { synced: orders.length };
   *   }
   * });
   */
  async create(options: ScheduleOptions): Promise<ScheduledTaskInfo> {
    return this.scheduler.create(options);
  }

  /**
   * 暂停任务
   *
   * @param taskId - 任务 ID
   *
   * @example
   * await helpers.scheduler.pause(taskId);
   */
  async pause(taskId: string): Promise<void> {
    return this.scheduler.pause(taskId);
  }

  /**
   * 恢复任务
   *
   * @param taskId - 任务 ID
   *
   * @example
   * await helpers.scheduler.resume(taskId);
   */
  async resume(taskId: string): Promise<void> {
    return this.scheduler.resume(taskId);
  }

  /**
   * 取消/删除任务
   *
   * @param taskId - 任务 ID
   *
   * @example
   * await helpers.scheduler.cancel(taskId);
   */
  async cancel(taskId: string): Promise<void> {
    return this.scheduler.cancel(taskId);
  }

  /**
   * 手动触发任务执行
   *
   * @param taskId - 任务 ID
   * @returns 执行信息
   *
   * @example
   * const execution = await helpers.scheduler.trigger(taskId);
   * console.log('执行结果:', execution.result);
   */
  async trigger(taskId: string): Promise<ExecutionInfo> {
    return this.scheduler.trigger(taskId);
  }

  /**
   * 获取当前插件的所有任务
   *
   * @returns 任务列表
   *
   * @example
   * const tasks = await helpers.scheduler.list();
   * for (const task of tasks) {
   *   console.log(`${task.name}: ${task.status}`);
   * }
   */
  async list(): Promise<ScheduledTaskInfo[]> {
    return this.scheduler.list();
  }

  /**
   * 获取单个任务信息
   *
   * @param taskId - 任务 ID
   * @returns 任务信息
   *
   * @example
   * const task = await helpers.scheduler.get(taskId);
   * if (task) {
   *   console.log(`下次执行: ${new Date(task.nextRunAt)}`);
   * }
   */
  async get(taskId: string): Promise<ScheduledTaskInfo | null> {
    return this.scheduler.get(taskId);
  }

  /**
   * 获取任务的执行历史
   *
   * @param taskId - 任务 ID
   * @param limit - 返回数量限制，默认 20
   * @returns 执行历史列表
   *
   * @example
   * const history = await helpers.scheduler.getHistory(taskId);
   * for (const exec of history) {
   *   console.log(`${exec.status}: ${exec.durationMs}ms`);
   * }
   */
  async getHistory(taskId: string, limit: number = 20): Promise<ExecutionInfo[]> {
    return this.scheduler.getHistory(taskId, limit);
  }

  /**
   * 检查服务是否可用
   *
   * @returns 是否可用
   */
  isAvailable(): boolean {
    return this.scheduler.isAvailable();
  }

  /**
   * 清理资源（插件卸载时调用）
   * @internal
   */
  async dispose(): Promise<void> {
    return this.scheduler.dispose();
  }
}
