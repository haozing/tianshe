/**
 * Scheduler Implementation
 *
 * 定时任务调度器
 * 从 js-plugin/namespaces/scheduler.ts 提取
 */

import { v4 as uuidv4 } from 'uuid';
import type { SchedulerService } from '../../main/scheduler';
import type {
  ScheduledTask,
  TaskExecution,
  ScheduleType,
  LastRunStatus,
} from '../../types/scheduler';
import { SchedulerError } from './errors';
import { createLogger } from '../logger';

const logger = createLogger('Scheduler');

// Re-export types for external use
export type { ScheduleType, LastRunStatus, MissedPolicy } from '../../types/scheduler';

/**
 * 调度任务执行上下文
 * handler 可通过此上下文感知取消/超时信号
 */
export interface SchedulerTaskContext {
  /** 取消/超时信号，handler 应定期检查并响应 */
  signal: AbortSignal;
  /** 任务载荷 */
  payload?: Record<string, unknown>;
  triggerType?: 'scheduled' | 'manual' | 'recovery';
}

/**
 * 调度器配置
 */
export interface SchedulerConfig {
  /** 调度服务实例 */
  schedulerService: SchedulerService | null;
  /** 调用者标识 */
  callerId: string;
}

/**
 * 调度选项
 */
export interface ScheduleOptions {
  /** 任务名称 */
  name: string;
  /** 任务描述 */
  description?: string;

  // 调度方式（三选一）
  /** Cron 表达式 */
  cron?: string;
  /** 固定间隔 */
  interval?: string | number;
  /** 指定执行时间（一次性） */
  runAt?: Date | number;

  /**
   * 执行函数
   * @param ctx - 任务上下文，包含 signal 和 payload
   *
   * @example
   * handler: async (ctx) => {
   *   // 定期检查取消信号
   *   if (ctx.signal.aborted) throw new Error('Task cancelled');
   *
   *   // 或监听 abort 事件
   *   ctx.signal.addEventListener('abort', () => cleanup());
   *
   *   return await doWork(ctx.payload);
   * }
   */
  handler: (ctx: SchedulerTaskContext) => Promise<unknown>;
  /** 传递给 handler 的参数 */
  payload?: Record<string, unknown>;

  // 可选配置
  /** 超时时间（毫秒），默认 120000 */
  timeout?: number;
  /** 重试次数，默认 0 */
  retry?: number;
  /** 重试延迟（毫秒），默认 5000 */
  retryDelay?: number;
  /** 错过执行时的策略，默认 'skip' */
  missedPolicy?: 'skip' | 'run_once';
  /** 是否立即执行第一次（仅对 interval 有效） */
  immediate?: boolean;
  resourceKeys?: string[];
  resourceWaitTimeoutMs?: number;
}

/**
 * 已调度任务信息
 */
export interface ScheduledTaskInfo {
  id: string;
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  scheduleDescription: string;
  status: 'active' | 'paused' | 'disabled';
  lastRunAt?: number;
  lastRunStatus?: LastRunStatus;
  nextRunAt?: number;
  runCount: number;
  failCount: number;
  createdAt: number;
}

/**
 * 执行历史信息
 */
export interface ExecutionInfo {
  id: string;
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
  triggerType: 'scheduled' | 'manual' | 'recovery';
}

// 全局 SchedulerService 引用
let globalSchedulerService: SchedulerService | null = null;

/**
 * 设置全局 SchedulerService 引用
 * @internal
 */
export function setSchedulerService(service: SchedulerService): void {
  globalSchedulerService = service;
}

/**
 * 获取全局 SchedulerService 引用
 * @internal
 */
export function getSchedulerService(): SchedulerService | null {
  return globalSchedulerService;
}

/**
 * 定时调度器
 *
 * 提供定时任务调度能力：
 * - Cron 表达式定时
 * - 固定间隔执行
 * - 一次性延迟执行
 *
 * @example
 * const scheduler = new Scheduler({ schedulerService, callerId: 'my-app' });
 * const task = await scheduler.create({
 *   name: '每日同步',
 *   cron: '0 9 * * *',
 *   handler: async () => await syncData()
 * });
 */
export class Scheduler {
  private handlers: Map<string, (ctx: SchedulerTaskContext) => Promise<any>> = new Map();
  private schedulerService: SchedulerService | null;
  private callerId: string;

  constructor(config: SchedulerConfig) {
    this.schedulerService = config.schedulerService;
    this.callerId = config.callerId;
  }

  /**
   * 创建定时任务
   *
   * 修复：createTask 失败时回滚 handler 注册
   */
  async create(options: ScheduleOptions): Promise<ScheduledTaskInfo> {
    if (!this.schedulerService) {
      throw new SchedulerError('SchedulerService not initialized');
    }

    // 验证调度方式
    const hasSchedule = [options.cron, options.interval, options.runAt].filter(Boolean).length;
    if (hasSchedule !== 1) {
      throw new SchedulerError('Must specify exactly one of: cron, interval, or runAt');
    }

    // 确定调度类型
    let scheduleType: ScheduleType;
    if (options.cron) {
      scheduleType = 'cron';
    } else if (options.interval) {
      scheduleType = 'interval';
    } else {
      scheduleType = 'once';
    }

    // 生成 handler ID 并注册
    const handlerId = uuidv4();
    this.handlers.set(handlerId, options.handler);

    // 注册到 SchedulerService（传递支持 signal 的 handler）
    this.schedulerService.registerHandler(this.callerId, handlerId, async (ctx) => {
      const handler = this.handlers.get(handlerId);
      if (!handler) {
        throw new SchedulerError(`Handler not found: ${handlerId}`);
      }
      return await handler(ctx);
    });

    // 创建任务（失败时回滚 handler 注册）
    try {
      const task = await this.schedulerService.createTask({
        pluginId: this.callerId,
        name: options.name,
        description: options.description,
        scheduleType,
        cron: options.cron,
        interval: options.interval,
        runAt: options.runAt,
        handlerId,
        payload: options.payload,
        timeout: options.timeout,
        retry: options.retry,
        retryDelay: options.retryDelay,
        missedPolicy: options.missedPolicy,
        immediate: options.immediate,
        resourceKeys: options.resourceKeys,
        resourceWaitTimeoutMs: options.resourceWaitTimeoutMs,
      });

      return this.toTaskInfo(task);
    } catch (error) {
      // 回滚：删除已注册的 handler
      this.handlers.delete(handlerId);
      this.schedulerService.unregisterHandler(this.callerId, handlerId);
      throw error;
    }
  }

  /**
   * 暂停任务
   */
  async pause(taskId: string): Promise<void> {
    await this.getOwnedTask(taskId, 'pause');
    await this.ensureService().pauseTask(taskId);
  }

  /**
   * 恢复任务
   */
  async resume(taskId: string): Promise<void> {
    await this.getOwnedTask(taskId, 'resume');
    await this.ensureService().resumeTask(taskId);
  }

  /**
   * 取消/删除任务
   */
  async cancel(taskId: string): Promise<void> {
    const task = await this.getOwnedTask(taskId, 'cancel');
    const service = this.ensureService();

    // 注销处理器
    service.unregisterHandler(this.callerId, task.handlerId);
    this.handlers.delete(task.handlerId);

    await service.cancelTask(taskId);
  }

  /**
   * 手动触发任务执行
   */
  async trigger(taskId: string): Promise<ExecutionInfo> {
    await this.getOwnedTask(taskId, 'trigger');
    const execution = await this.ensureService().triggerTask(taskId);
    return this.toExecutionInfo(execution);
  }

  /**
   * 获取所有任务
   */
  async list(): Promise<ScheduledTaskInfo[]> {
    const tasks = await this.ensureService().getTasksByPlugin(this.callerId);
    return tasks.map((task) => this.toTaskInfo(task));
  }

  /**
   * 获取单个任务信息
   */
  async get(taskId: string): Promise<ScheduledTaskInfo | null> {
    const service = this.ensureService();
    const task = await service.getTask(taskId);

    if (!task) return null;

    if (task.pluginId !== this.callerId) {
      throw new SchedulerError('Cannot access task from another caller');
    }

    return this.toTaskInfo(task);
  }

  /**
   * 获取任务的执行历史
   */
  async getHistory(taskId: string, limit: number = 20): Promise<ExecutionInfo[]> {
    await this.getOwnedTask(taskId, 'access history of');
    const executions = await this.ensureService().getTaskHistory(taskId, limit);
    return executions.map((exec) => this.toExecutionInfo(exec));
  }

  /**
   * 清理资源
   * @internal
   *
   * 采用"生命周期任务"策略：插件卸载时删除其所有定时任务
   * 这确保不会产生僵尸任务（持久化但 handler 丢失）
   */
  async dispose(): Promise<void> {
    if (!this.schedulerService) return;

    // 1. 先删除该插件的所有定时任务（从数据库和调度器中移除）
    if (typeof this.schedulerService.deleteTasksByPlugin === 'function') {
      try {
        const deletedCount = await this.schedulerService.deleteTasksByPlugin(this.callerId);
        if (deletedCount > 0) {
          logger.info(`Deleted ${deletedCount} tasks for caller: ${this.callerId}`);
        }
      } catch (error) {
        logger.error(`Failed to delete tasks for caller ${this.callerId}:`, error);
      }
    } else {
      logger.warn(`SchedulerService.deleteTasksByPlugin is unavailable for caller ${this.callerId}`);
    }

    // 2. 注销处理器
    this.schedulerService.unregisterPluginHandlers(this.callerId);
    this.handlers.clear();

    logger.debug(`Disposed for caller: ${this.callerId}`);
  }

  /**
   * 检查服务是否可用
   */
  isAvailable(): boolean {
    return this.schedulerService !== null;
  }

  // ========== 私有方法 ==========

  /**
   * 确保服务已初始化
   */
  private ensureService(): SchedulerService {
    if (!this.schedulerService) {
      throw new SchedulerError('SchedulerService not initialized');
    }
    return this.schedulerService;
  }

  /**
   * 获取并验证任务所有权
   * @param taskId 任务 ID
   * @param operation 操作名称（用于错误信息）
   * @returns 验证通过的任务对象
   */
  private async getOwnedTask(taskId: string, operation: string): Promise<ScheduledTask> {
    const service = this.ensureService();
    const task = await service.getTask(taskId);

    if (!task) {
      throw new SchedulerError(`Task not found: ${taskId}`);
    }

    if (task.pluginId !== this.callerId) {
      throw new SchedulerError(`Cannot ${operation} task from another caller`);
    }

    return task;
  }

  private toTaskInfo(task: ScheduledTask): ScheduledTaskInfo {
    let scheduleDescription: string;
    if (task.scheduleType === 'cron' && task.cronExpression) {
      scheduleDescription = `Cron: ${task.cronExpression}`;
    } else if (task.scheduleType === 'interval' && task.intervalMs) {
      scheduleDescription = `Every ${this.formatInterval(task.intervalMs)}`;
    } else if (task.scheduleType === 'once' && task.runAt) {
      scheduleDescription = `At ${new Date(task.runAt).toLocaleString()}`;
    } else {
      scheduleDescription = 'Unknown';
    }

    return {
      id: task.id,
      name: task.name,
      description: task.description,
      scheduleType: task.scheduleType,
      scheduleDescription,
      status: task.status,
      lastRunAt: task.lastRunAt,
      lastRunStatus: task.lastRunStatus,
      nextRunAt: task.nextRunAt,
      runCount: task.runCount,
      failCount: task.failCount,
      createdAt: task.createdAt,
    };
  }

  private toExecutionInfo(exec: TaskExecution): ExecutionInfo {
    return {
      id: exec.id,
      taskId: exec.taskId,
      status: exec.status,
      startedAt: exec.startedAt,
      finishedAt: exec.finishedAt,
      durationMs: exec.durationMs,
      result: exec.result,
      error: exec.error,
      triggerType: exec.triggerType,
    };
  }

  private formatInterval(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
    return `${Math.round(ms / 86400000)}d`;
  }
}
