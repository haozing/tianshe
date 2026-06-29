/**
 * SchedulerService - scheduled task scheduler core service.
 * Handles task scheduling, execution, and recovery.
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type {
  ScheduledTaskService,
  ScheduledTask,
  TaskExecution,
  CreateScheduledTaskParams,
} from '../duckdb/scheduled-task-service';
import type {
  ISchedulerService,
  ScheduleType,
  TaskExecutionContext,
  TaskHandler,
} from '../../types/scheduler';
import {
  getNextCronTime,
  parseInterval,
  describeCronExpression,
  formatInterval,
} from './cron-parser';
import { createLogger } from '../../core/logger';
import { resourceCoordinator } from '../../core/resource-coordinator';

const logger = createLogger('SchedulerService');
const DEFAULT_RESOURCE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

type RunningTaskState = {
  controller: AbortController;
  promise: Promise<TaskExecution>;
};

class SchedulerTaskCancelledError extends Error {
  constructor(
    message: string,
    readonly cancelledBy: 'timeout' | 'abort'
  ) {
    super(message);
    this.name = 'SchedulerTaskCancelledError';
    Object.setPrototypeOf(this, SchedulerTaskCancelledError.prototype);
  }
}

/**
 * Scheduler event callbacks.
 */
export interface SchedulerEvents {
  'task-scheduled': (task: ScheduledTask) => void;
  'task-started': (task: ScheduledTask, execution: TaskExecution) => void;
  'task-completed': (task: ScheduledTask, execution: TaskExecution, result: unknown) => void;
  'task-failed': (task: ScheduledTask, execution: TaskExecution, error: Error) => void;
  'task-cancelled': (task: ScheduledTask) => void;
}

export class SchedulerService extends EventEmitter implements ISchedulerService {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private runningTasks: Map<string, RunningTaskState> = new Map();
  private tasksPendingDelete: Set<string> = new Set();
  private tasksSuppressSchedule: Set<string> = new Set();
  private handlers: Map<string, TaskHandler> = new Map();
  private initialized: boolean = false;
  private activeTasksRestored: boolean = false;
  private disposing: boolean = false;

  // 自动清理配置
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24小时
  private readonly CLEANUP_DAYS_TO_KEEP = 30; // Keep 30 days
  constructor(private taskService: ScheduledTaskService) {
    super();
  }

  /**
   * Initialize the scheduler and prepare startup cleanup.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      logger.info('[SchedulerService] Already initialized');
      return;
    }

    logger.info('[SchedulerService] Initializing...');
    this.disposing = false;

    const staleExecutions = await this.taskService.markStaleExecutionsCancelled();
    if (staleExecutions > 0) {
      logger.warn('Marked stale scheduler executions as cancelled during startup', {
        count: staleExecutions,
      });
    }

    // Start periodic cleanup.
    this.startCleanupTimer();

    this.initialized = true;
    logger.info('[SchedulerService] Initialization complete');
  }

  async restoreActiveTasks(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    if (this.activeTasksRestored) {
      logger.info('[SchedulerService] Active tasks already restored');
      return;
    }

    const tasks = await this.taskService.getActiveTasks();
    logger.info('Found active tasks to restore', { taskCount: tasks.length });

    for (const task of tasks) {
      try {
        await this.scheduleTask(task);
      } catch (error) {
        logger.error('Failed to restore scheduled task', { taskId: task.id, error });
      }
    }

    this.activeTasksRestored = true;
  }

  /**
   * Register a task handler.
   * @param pluginId Plugin ID
   * @param handlerId Handler ID
   * @param handler Handler function that receives a context with an abort signal
   */
  registerHandler(
    pluginId: string,
    handlerId: string,
    handler: (ctx: TaskExecutionContext) => Promise<unknown>
  ): void {
    const key = `${pluginId}:${handlerId}`;
    this.handlers.set(key, { pluginId, handlerId, handler });
    logger.info('Scheduler handler registered', { pluginId, handlerId, key });
  }

  /**
   * Unregister a task handler.
   */
  unregisterHandler(pluginId: string, handlerId: string): void {
    const key = `${pluginId}:${handlerId}`;
    this.handlers.delete(key);
    logger.info('Scheduler handler unregistered', { pluginId, handlerId, key });
  }

  /**
   * 注销插件的所有处理器
   */
  unregisterPluginHandlers(pluginId: string): void {
    for (const key of this.handlers.keys()) {
      if (key.startsWith(`${pluginId}:`)) {
        this.handlers.delete(key);
      }
    }
    logger.info('All scheduler handlers unregistered for plugin', { pluginId });
  }

  /**
   * 创建定时任务
   */
  async createTask(params: {
    pluginId: string;
    name: string;
    description?: string;
    scheduleType: 'cron' | 'interval' | 'once';
    cron?: string;
    interval?: string | number;
    runAt?: Date | number;
    handlerId: string;
    payload?: Record<string, unknown>;
    timeout?: number;
    retry?: number;
    retryable?: boolean;
    retryDelay?: number;
    missedPolicy?: 'skip' | 'run_once';
    immediate?: boolean;
    resourceKeys?: string[];
    resourceWaitTimeoutMs?: number;
  }): Promise<ScheduledTask> {
    const taskId = uuidv4();
    const now = Date.now();
    this.validateCreateTaskSchedule(params);

    // 计算下次执行时间
    let nextRunAt: number | undefined;
    let intervalMs: number | undefined;
    let cronExpression: string | undefined;
    let runAtTimestamp: number | undefined;

    if (params.scheduleType === 'cron' && params.cron) {
      cronExpression = params.cron;
      const nextDate = getNextCronTime(params.cron);
      nextRunAt = nextDate.getTime();
    } else if (params.scheduleType === 'interval' && params.interval) {
      intervalMs = parseInterval(params.interval);
      // Immediate interval tasks run as soon as possible; otherwise wait one interval.
      nextRunAt = params.immediate ? now : now + intervalMs;
    } else if (params.scheduleType === 'once' && params.runAt) {
      runAtTimestamp = params.runAt instanceof Date ? params.runAt.getTime() : params.runAt;
      nextRunAt = runAtTimestamp;
    }

    const createParams: CreateScheduledTaskParams = {
      id: taskId,
      pluginId: params.pluginId,
      name: params.name,
      description: params.description,
      scheduleType: params.scheduleType,
      cronExpression,
      intervalMs,
      runAt: runAtTimestamp,
      handlerId: params.handlerId,
      payload: params.payload,
      timeoutMs: params.timeout ?? 120000,
      retryCount: params.retryable === false ? 0 : params.retry ?? 0,
      retryDelayMs: params.retryDelay ?? 5000,
      missedPolicy: params.missedPolicy ?? 'skip',
      resourceKeys: params.resourceKeys,
      resourceWaitTimeoutMs: params.resourceWaitTimeoutMs,
      nextRunAt,
    };

    const task = await this.taskService.createTask(createParams);

    // 调度任务
    await this.scheduleTask(task);

    this.emit('task-scheduled', task);
    logger.info('Scheduled task created', {
      taskId: task.id,
      taskName: task.name,
      nextRunAt,
    });

    return task;
  }

  private validateCreateTaskSchedule(params: {
    scheduleType: ScheduleType;
    cron?: string;
    interval?: string | number;
    runAt?: Date | number;
  }): void {
    const hasCron = params.cron !== undefined && params.cron !== '';
    const hasInterval = params.interval !== undefined && params.interval !== '';
    const hasRunAt = params.runAt !== undefined;
    const provided = [hasCron, hasInterval, hasRunAt].filter(Boolean).length;

    if (provided !== 1) {
      throw new Error('Exactly one of cron, interval, or runAt must be provided');
    }
    if (params.scheduleType === 'cron' && !hasCron) {
      throw new Error('cron is required for cron scheduled tasks');
    }
    if (params.scheduleType === 'interval' && !hasInterval) {
      throw new Error('interval is required for interval scheduled tasks');
    }
    if (params.scheduleType === 'once' && !hasRunAt) {
      throw new Error('runAt is required for once scheduled tasks');
    }
    if (params.scheduleType !== 'cron' && hasCron) {
      throw new Error('cron can only be used with cron scheduled tasks');
    }
    if (params.scheduleType !== 'interval' && hasInterval) {
      throw new Error('interval can only be used with interval scheduled tasks');
    }
    if (params.scheduleType !== 'once' && hasRunAt) {
      throw new Error('runAt can only be used with once scheduled tasks');
    }
  }

  /**
   * 暂停任务
   */
  async pauseTask(taskId: string): Promise<void> {
    this.cancelTimer(taskId);

    const runningTask = this.runningTasks.get(taskId);
    if (runningTask) {
      this.tasksSuppressSchedule.add(taskId);
      runningTask.controller.abort();
      try {
        await this.waitForRunningTask(taskId);
      } finally {
        this.tasksSuppressSchedule.delete(taskId);
      }
    }

    await this.taskService.updateTask(taskId, { status: 'paused' });

    logger.info('Scheduled task paused', { taskId });
  }

  /**
   * 恢复任务
   */
  async resumeTask(taskId: string): Promise<void> {
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    await this.taskService.updateTask(taskId, { status: 'active' });

    // 重新计算下次执行时间
    const nextRunAt = this.calculateNextRun(task);
    if (nextRunAt) {
      await this.taskService.updateTask(taskId, { nextRunAt });
    }

    // 重新调度
    const updatedTask = await this.taskService.getTask(taskId);
    if (updatedTask) {
      await this.scheduleTask(updatedTask);
    }

    logger.info('Scheduled task resumed', { taskId });
  }

  /**
   * 取消/删除任务
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = await this.taskService.getTask(taskId);

    this.cancelTimer(taskId);

    const runningTask = this.runningTasks.get(taskId);
    if (runningTask) {
      this.tasksPendingDelete.add(taskId);
      this.tasksSuppressSchedule.add(taskId);
      runningTask.controller.abort();
      await this.waitForRunningTask(taskId);
    }

    // 从数据库删除
    try {
      await this.taskService.deleteTask(taskId);
    } finally {
      this.tasksPendingDelete.delete(taskId);
      this.tasksSuppressSchedule.delete(taskId);
    }

    // 发射事件（使用删除前获取的任务信息）
    if (task) {
      this.emit('task-cancelled', task);
    }

    logger.info('Scheduled task cancelled', { taskId });
  }

  /**
   * 手动触发任务
   */
  async triggerTask(taskId: string): Promise<TaskExecution> {
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return await this.executeTask(task, 'manual');
  }

  /**
   * 获取任务信息
   */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    return await this.taskService.getTask(taskId);
  }

  /**
   * Get all tasks owned by a plugin.
   */
  async getTasksByPlugin(pluginId: string): Promise<ScheduledTask[]> {
    return await this.taskService.getTasksByPlugin(pluginId);
  }

  /**
   * Get all tasks.
   */
  async getAllTasks(options?: {
    status?: string;
    pluginId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: ScheduledTask[]; total: number }> {
    return await this.taskService.getAllTasks(options);
  }

  /**
   * 获取任务执行历史
   */
  async getTaskHistory(taskId: string, limit?: number): Promise<TaskExecution[]> {
    return await this.taskService.getExecutions(taskId, limit);
  }

  /**
   * 获取最近的执行记录
   */
  async getRecentExecutions(limit?: number): Promise<TaskExecution[]> {
    return await this.taskService.getRecentExecutions(limit);
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    paused: number;
    disabled: number;
    todayExecutions: number;
    todayFailed: number;
  }> {
    return await this.taskService.getStats();
  }

  /**
   * Delete all tasks owned by a plugin.
   */
  async deleteTasksByPlugin(pluginId: string): Promise<number> {
    const tasks = await this.taskService.getTasksByPlugin(pluginId);
    for (const task of tasks) {
      this.cancelTimer(task.id);
      const runningTask = this.runningTasks.get(task.id);
      if (runningTask) {
        this.tasksPendingDelete.add(task.id);
        this.tasksSuppressSchedule.add(task.id);
        runningTask.controller.abort();
      }
    }

    await Promise.allSettled(tasks.map((task) => this.waitForRunningTask(task.id)));

    try {
      return await this.taskService.deleteTasksByPlugin(pluginId);
    } finally {
      for (const task of tasks) {
        this.tasksPendingDelete.delete(task.id);
        this.tasksSuppressSchedule.delete(task.id);
      }
    }
  }

  /**
   * Get a human-readable schedule description.
   */
  getScheduleDescription(task: ScheduledTask): string {
    if (task.scheduleType === 'cron' && task.cronExpression) {
      return describeCronExpression(task.cronExpression);
    } else if (task.scheduleType === 'interval' && task.intervalMs) {
      return `每 ${formatInterval(task.intervalMs)}`;
    } else if (task.scheduleType === 'once' && task.runAt) {
      return `一次性 ${new Date(task.runAt).toLocaleString()}`;
    }
    return '未知';
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    logger.info('[SchedulerService] Disposing...');
    this.disposing = true;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('[SchedulerService] Cleanup timer cancelled');
    }

    // 取消所有定时器
    for (const [taskId, timer] of this.timers) {
      clearTimeout(timer);
      logger.info('Scheduler timer cancelled', { taskId });
    }
    this.timers.clear();

    const runningTaskPromises: Promise<TaskExecution>[] = [];
    for (const [taskId, runningTask] of this.runningTasks) {
      this.tasksSuppressSchedule.add(taskId);
      runningTask.controller.abort();
      runningTaskPromises.push(runningTask.promise);
      logger.info('Scheduler running task aborted', { taskId });
    }

    await Promise.allSettled(runningTaskPromises);
    this.runningTasks.clear();
    this.tasksPendingDelete.clear();
    this.tasksSuppressSchedule.clear();

    this.handlers.clear();

    this.initialized = false;
    logger.info('[SchedulerService] Disposed');
  }

  // ========== 私有方法 ==========

  /**
   * 调度单个任务
   */
  private async scheduleTask(task: ScheduledTask): Promise<void> {
    if (task.status !== 'active') {
      logger.info('Scheduled task is not active, skipping schedule', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }

    // 计算下次执行时间
    let nextRun = task.nextRunAt;
    const now = Date.now();

    if (!nextRun) {
      nextRun = this.calculateNextRun(task);
      if (nextRun) {
        await this.taskService.updateTask(task.id, { nextRunAt: nextRun });
      }
    }

    if (!nextRun) {
      logger.info('No next run time for scheduled task', { taskId: task.id });
      if (task.scheduleType === 'once') {
        await this.markOnceTaskTriggered(task, 'no-next-run');
      }
      return;
    }

    // 检查是否错过了执行时间
    if (nextRun < now) {
      logger.info('Scheduled task missed execution time', {
        taskId: task.id,
        nextRun,
        now,
      });

      if (task.missedPolicy === 'run_once') {
        logger.info('Running missed scheduled task', { taskId: task.id });
        const taskForExecution =
          task.scheduleType === 'once'
            ? await this.markOnceTaskTriggered(task, 'missed-recovery')
            : task;
        await this.executeTask(taskForExecution, 'recovery');
      } else if (task.scheduleType === 'once') {
        await this.markOnceTaskTriggered(task, 'missed-skip');
        return;
      }

      if (task.scheduleType === 'once') {
        return;
      }

      // 重新计算下次执行时间
      nextRun = this.calculateNextRun(task, now);
      if (nextRun) {
        await this.taskService.updateTask(task.id, { nextRunAt: nextRun });
      }
    }

    if (nextRun && nextRun > now) {
      this.setTimer(task.id, nextRun);
    }
  }

  /**
   * Set a timer for a task.
   */
  private setTimer(taskId: string, runAt: number): void {
    this.cancelTimer(taskId);

    const delay = runAt - Date.now();

    const maxDelay = 24 * 60 * 60 * 1000; // 24 hours

    if (delay > maxDelay) {
      const timer = setTimeout(() => {
        this.setTimer(taskId, runAt);
      }, maxDelay);
      this.timers.set(taskId, timer);
      logger.info('Intermediate scheduler timer set', {
        taskId,
        runAt,
        delayMs: maxDelay,
      });
    } else if (delay > 0) {
      const timer = setTimeout(() => {
        this.onTimerFired(taskId);
      }, delay);
      this.timers.set(taskId, timer);
      logger.info('Scheduler timer set', {
        taskId,
        delayMs: delay,
      });
    } else {
      // 立即执行
      setImmediate(() => {
        this.onTimerFired(taskId);
      });
    }
  }

  /**
   * Cancel a task timer.
   */
  private cancelTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  /**
   * Handle a fired timer.
   */
  private async onTimerFired(taskId: string): Promise<void> {
    this.timers.delete(taskId);

    const task = await this.taskService.getTask(taskId);
    if (!task || task.status !== 'active') {
      logger.info('Scheduled task no longer active, skipping execution', { taskId });
      return;
    }

    try {
      const taskForExecution =
        task.scheduleType === 'once'
          ? await this.markOnceTaskTriggered(task, 'scheduled')
          : task;
      await this.executeTask(taskForExecution, 'scheduled');
    } catch (error) {
      logger.error('Scheduled task execution failed during timer fire', { taskId, error });
    } finally {
      try {
        if (this.disposing || this.tasksSuppressSchedule.has(taskId)) {
          logger.info('Scheduled task reschedule suppressed by lifecycle operation', { taskId });
        } else {
          const latestTask = await this.taskService.getTask(taskId);
          if (!latestTask || latestTask.status !== 'active') {
            logger.info('Scheduled task no longer active after execution, skipping reschedule', {
              taskId,
            });
          } else if (latestTask.scheduleType !== 'once') {
            const nextRun = this.calculateNextRun(latestTask, Date.now());
            if (nextRun) {
              await this.taskService.updateTask(taskId, { nextRunAt: nextRun });
              this.setTimer(taskId, nextRun);
            }
          } else {
            // 一次性任务执行完成后禁用
            await this.taskService.updateTask(taskId, { status: 'disabled' });
          }
        }
      } catch (rescheduleError) {
        logger.error('Failed to update scheduled task after timer fire', {
          taskId,
          error: rescheduleError,
        });
      }
    }
  }

  private async waitForRunningTask(taskId: string): Promise<void> {
    const runningTask = this.runningTasks.get(taskId);
    if (!runningTask) {
      return;
    }

    await runningTask.promise.catch(() => undefined);
  }

  /**
   * 一次性任务触发前先持久化为 disabled，避免崩溃后重复触发。
   */
  private async markOnceTaskTriggered(task: ScheduledTask, reason: string): Promise<ScheduledTask> {
    if (task.scheduleType !== 'once') {
      return task;
    }

    await this.taskService.updateTask(task.id, { status: 'disabled' });
    logger.info('Once scheduled task marked triggered before execution', {
      taskId: task.id,
      reason,
    });

    return {
      ...task,
      status: 'disabled',
    };
  }

  /**
   * 执行任务（支持重试）
   */
  private async executeTask(
    task: ScheduledTask,
    triggerType: 'scheduled' | 'manual' | 'recovery'
  ): Promise<TaskExecution> {
    if (this.runningTasks.has(task.id)) {
      logger.info('Scheduled task is already running, skipping execution', { taskId: task.id });
      throw new Error(`Task ${task.id} is already running`);
    }

    const controller = new AbortController();
    const runningTask: RunningTaskState = {
      controller,
      promise: Promise.resolve(null as unknown as TaskExecution),
    };

    runningTask.promise = this.runTaskExecution(task, triggerType, controller).finally(() => {
      if (this.runningTasks.get(task.id) === runningTask) {
        this.runningTasks.delete(task.id);
      }
    });
    this.runningTasks.set(task.id, runningTask);

    return await runningTask.promise;
  }

  private async runTaskExecution(
    task: ScheduledTask,
    triggerType: 'scheduled' | 'manual' | 'recovery',
    controller: AbortController
  ): Promise<TaskExecution> {
    const executionId = uuidv4();
    const maxRetries = task.retryCount ?? 0;
    const retryDelayMs = task.retryDelayMs ?? 5000;
    const resourceKeys = Array.isArray(task.resourceKeys)
      ? Array.from(new Set(task.resourceKeys.map((key) => String(key || '').trim()).filter(Boolean)))
      : [];
    const resourceWaitTimeoutMs =
      typeof task.resourceWaitTimeoutMs === 'number' && task.resourceWaitTimeoutMs > 0
        ? task.resourceWaitTimeoutMs
        : DEFAULT_RESOURCE_WAIT_TIMEOUT_MS;
    const queuedAt = Date.now();

    // 创建执行记录
    const execution = await this.taskService.createExecution({
      id: executionId,
      taskId: task.id,
      triggerType,
      status: 'pending',
      startedAt: queuedAt,
    });

    let startTime = queuedAt;
    let runningExecution: TaskExecution = execution;
    let lastError: Error | null = null;
    let attempt = 0;
    let resourceContext:
      | {
          ownerToken: string;
          heldKeys: Set<string>;
          profileLeases: Map<string, unknown>;
        }
      | null = null;

    let resourceLease = null;

    try {
      if (resourceKeys.length > 0) {
        resourceLease = await resourceCoordinator.acquire(resourceKeys, {
          ownerToken: executionId,
          timeoutMs: resourceWaitTimeoutMs,
          signal: controller.signal,
        });
        resourceContext = {
          ownerToken: resourceLease.ownerToken,
          heldKeys: new Set(resourceLease.keys),
          profileLeases: new Map(),
        };
      }

      // 重试循环
      const handlerKey = `${task.pluginId}:${task.handlerId}`;
      const handlerInfo = this.handlers.get(handlerKey);
      if (!handlerInfo) {
        throw new Error(`Handler not found: ${handlerKey}`);
      }

      startTime = Date.now();
      await this.taskService.updateExecution(executionId, {
        status: 'running',
        startedAt: startTime,
      });
      runningExecution = {
        ...execution,
        status: 'running',
        startedAt: startTime,
      };

      this.emit('task-started', task, runningExecution);
      logger.info('Scheduled task started', {
        taskId: task.id,
        taskName: task.name,
        triggerType,
        maxRetries,
      });

      const invokeHandler = async () => {
        const runHandler = async () =>
          await handlerInfo.handler({
            signal: controller.signal,
            payload: task.payload,
            triggerType,
          });

        if (!resourceContext) {
          return await runHandler();
        }

        return await resourceCoordinator.runWithContext(resourceContext, runHandler);
      };

      while (attempt <= maxRetries) {
        // 检查是否已被取消（在循环开始时检查，处理重试间隔期间的取消）
        if (controller.signal.aborted) {
          logger.info('Scheduled task cancelled before attempt', {
            taskId: task.id,
            taskName: task.name,
            attempt,
          });
          break;
        }

        // Run the handler through a hard-settling cancellation race so scheduler state is released
        // even when the handler ignores AbortSignal.
        try {
          if (attempt > 0) {
            logger.info('Retrying scheduled task', {
              taskId: task.id,
              taskName: task.name,
              attempt,
              maxRetries,
            });
          }

          // Execute handler with the current resource context
          const result = await this.invokeHandlerWithHardCancellation(
            task,
            controller,
            invokeHandler
          );
          if (controller.signal.aborted) {
            const abortReason = controller.signal.reason;
            throw abortReason instanceof Error ? abortReason : new Error(String(abortReason));
          }

          const finishedAt = Date.now();
          await this.taskService.updateExecution(executionId, {
            status: 'completed',
            finishedAt,
            durationMs: finishedAt - startTime,
            result,
          });

          // 更新任务统计
          if (!this.tasksPendingDelete.has(task.id)) {
            await this.taskService.updateTask(task.id, {
              lastRunAt: startTime,
              lastRunStatus: 'success',
              runCount: task.runCount + 1,
            });
          }

          const updatedExecution: TaskExecution = {
            ...runningExecution,
            status: 'completed',
            finishedAt,
            durationMs: finishedAt - startTime,
            result,
          };

          this.emit('task-completed', task, updatedExecution, result);
          logger.info('Scheduled task completed', {
            taskId: task.id,
            taskName: task.name,
            durationMs: finishedAt - startTime,
            retryCount: attempt,
          });

          return updatedExecution;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));

          if (controller.signal.aborted) {
            logger.info('Scheduled task cancelled or timed out', {
              taskId: task.id,
              taskName: task.name,
            });
            break;
          }

          logger.error('Scheduled task attempt failed', {
            taskId: task.id,
            taskName: task.name,
            attempt: attempt + 1,
            error: lastError.message,
          });

          attempt++;

          // 如果还有重试机会，等待后继续
          if (attempt <= maxRetries) {
            logger.info('Waiting before scheduled task retry', {
              taskId: task.id,
              retryDelayMs,
              attempt,
              maxRetries,
            });
            await this.sleep(retryDelayMs);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ResourceAcquireTimeoutError') {
        lastError = new Error('Resource wait timeout');
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      if (resourceLease) {
        await resourceLease.release().catch(() => undefined);
      }
    }

    const finishedAt = Date.now();
    const isCancelled = controller.signal.aborted;
    const status = isCancelled ? 'cancelled' : 'failed';

    await this.taskService.updateExecution(executionId, {
      status,
      finishedAt,
      durationMs: finishedAt - startTime,
      error: lastError?.message ?? 'Unknown error',
    });

    // Update task statistics.
    // Cancelled runs do not increment failCount, while lastRunStatus preserves cancelled vs failed.
    if (!this.tasksPendingDelete.has(task.id)) {
      await this.taskService.updateTask(task.id, {
        lastRunAt: startTime,
        lastRunStatus: isCancelled ? 'cancelled' : 'failed',
        runCount: task.runCount + 1,
        failCount: isCancelled ? task.failCount : task.failCount + 1,
      });
    }

    const updatedExecution: TaskExecution = {
      ...runningExecution,
      status,
      finishedAt,
      durationMs: finishedAt - startTime,
      error: lastError?.message ?? 'Unknown error',
    };

    this.emit('task-failed', task, updatedExecution, lastError ?? new Error('Unknown error'));
    logger.error('Scheduled task failed after attempts', {
      taskId: task.id,
      taskName: task.name,
      attempt,
      error: lastError?.message,
    });

    return updatedExecution;
  }

  /**
   * Invoke a handler with hard cancellation.
   */
  private async invokeHandlerWithHardCancellation(
    task: ScheduledTask,
    controller: AbortController,
    invokeHandler: () => Promise<unknown>
  ): Promise<unknown> {
    if (controller.signal.aborted) {
      const abortReason = controller.signal.reason;
      throw abortReason instanceof Error
        ? abortReason
        : new SchedulerTaskCancelledError(String(abortReason || 'Task cancelled'), 'abort');
    }

    const handlerPromise = Promise.resolve().then(() => invokeHandler());
    handlerPromise.catch(() => undefined);

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        controller.signal.removeEventListener('abort', onAbort);
      };

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const toAbortError = () => {
        const abortReason = controller.signal.reason;
        return abortReason instanceof Error
          ? abortReason
          : new SchedulerTaskCancelledError(String(abortReason || 'Task cancelled'), 'abort');
      };

      const onAbort = () => {
        finish(() => reject(toAbortError()));
      };

      handlerPromise.then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error))
      );

      controller.signal.addEventListener('abort', onAbort, { once: true });

      if (task.timeoutMs > 0 && Number.isFinite(task.timeoutMs)) {
        timeoutId = setTimeout(() => {
          const error = new SchedulerTaskCancelledError(
            `Task timed out after ${task.timeoutMs}ms`,
            'timeout'
          );
          if (!controller.signal.aborted) {
            controller.abort(error);
          }
          finish(() => reject(error));
        }, task.timeoutMs);
      }

      if (controller.signal.aborted) {
        onAbort();
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start the periodic cleanup timer.
   */
  private startCleanupTimer(): void {
    this.performCleanup();

    // Schedule periodic cleanup.
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.CLEANUP_INTERVAL_MS);

    logger.info('Scheduler cleanup timer started', {
      intervalMs: this.CLEANUP_INTERVAL_MS,
      keepDays: this.CLEANUP_DAYS_TO_KEEP,
    });
  }

  /**
   * 执行清理操作
   */
  private async performCleanup(): Promise<void> {
    try {
      const count = await this.taskService.cleanupOldExecutions(this.CLEANUP_DAYS_TO_KEEP);
      if (count > 0) {
        logger.info('Cleaned up old scheduler execution records', { count });
      }
    } catch (error) {
      logger.error('[SchedulerService] Cleanup failed:', error);
    }
  }

  /**
   * 计算下次执行时间
   */
  private calculateNextRun(task: ScheduledTask, after?: number): number | undefined {
    const afterDate = after ? new Date(after) : new Date();

    if (task.scheduleType === 'cron' && task.cronExpression) {
      const next = getNextCronTime(task.cronExpression, afterDate);
      return next.getTime();
    } else if (task.scheduleType === 'interval' && task.intervalMs) {
      return afterDate.getTime() + task.intervalMs;
    } else if (task.scheduleType === 'once' && task.runAt) {
      if (task.runAt > afterDate.getTime()) {
        return task.runAt;
      }
      return undefined;
    }

    return undefined;
  }
}
