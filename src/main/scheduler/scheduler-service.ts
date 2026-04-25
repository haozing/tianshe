/**
 * SchedulerService - 定时任务调度核心服务
 * 负责：任务调度、执行、恢�? */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  ScheduledTaskService,
  ScheduledTask,
  TaskExecution,
  CreateScheduledTaskParams,
} from '../duckdb/scheduled-task-service';
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

/**
 * 任务执行上下文（传递给 handler�? */
interface TaskExecutionContext {
  /** 取消/超时信号 */
  signal: AbortSignal;
  /** 任务载荷 */
  payload?: Record<string, unknown>;
  triggerType?: 'scheduled' | 'manual' | 'recovery';
}

/**
 * 任务处理器注册信�? */
interface TaskHandler {
  pluginId: string;
  handlerId: string;
  handler: (ctx: TaskExecutionContext) => Promise<unknown>;
}

/**
 * 调度器事�? */
export interface SchedulerEvents {
  'task-scheduled': (task: ScheduledTask) => void;
  'task-started': (task: ScheduledTask, execution: TaskExecution) => void;
  'task-completed': (task: ScheduledTask, execution: TaskExecution, result: unknown) => void;
  'task-failed': (task: ScheduledTask, execution: TaskExecution, error: Error) => void;
  'task-cancelled': (task: ScheduledTask) => void;
}

export class SchedulerService extends EventEmitter {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private runningTasks: Map<string, AbortController> = new Map();
  private handlers: Map<string, TaskHandler> = new Map();
  private initialized: boolean = false;

  // 自动清理配置
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24小时
  private readonly CLEANUP_DAYS_TO_KEEP = 30; // 保留30�?
  constructor(private taskService: ScheduledTaskService) {
    super();
  }

  /**
   * 初始化调度器：从数据库恢复任�?   */
  async init(): Promise<void> {
    if (this.initialized) {
      logger.info('[SchedulerService] Already initialized');
      return;
    }

    logger.info('[SchedulerService] Initializing...');

    const tasks = await this.taskService.getActiveTasks();
    console.log(`[SchedulerService] Found ${tasks.length} active tasks to restore`);

    for (const task of tasks) {
      try {
        await this.scheduleTask(task);
      } catch (error) {
        console.error(`[SchedulerService] Failed to restore task ${task.id}:`, error);
      }
    }

    // 启动定期清理任务
    this.startCleanupTimer();

    this.initialized = true;
    logger.info('[SchedulerService] Initialization complete');
  }

  /**
   * 注册任务处理�?   * @param pluginId - 插件 ID
   * @param handlerId - 处理�?ID
   * @param handler - 处理函数，接收包�?signal 的上下文
   */
  registerHandler(
    pluginId: string,
    handlerId: string,
    handler: (ctx: TaskExecutionContext) => Promise<unknown>
  ): void {
    const key = `${pluginId}:${handlerId}`;
    this.handlers.set(key, { pluginId, handlerId, handler });
    console.log(`[SchedulerService] Handler registered: ${key}`);
  }

  /**
   * 注销任务处理�?   */
  unregisterHandler(pluginId: string, handlerId: string): void {
    const key = `${pluginId}:${handlerId}`;
    this.handlers.delete(key);
    console.log(`[SchedulerService] Handler unregistered: ${key}`);
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
    console.log(`[SchedulerService] All handlers unregistered for plugin: ${pluginId}`);
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
    retryDelay?: number;
    missedPolicy?: 'skip' | 'run_once';
    immediate?: boolean;
    resourceKeys?: string[];
    resourceWaitTimeoutMs?: number;
  }): Promise<ScheduledTask> {
    const taskId = uuidv4();
    const now = Date.now();

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
      // 如果 immediate �?true，立即执行；否则等待第一个间�?      nextRunAt = params.immediate ? now : now + intervalMs;
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
      retryCount: params.retry ?? 0,
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
    console.log(
      `[SchedulerService] Task created: ${task.name} (${task.id}), next run: ${nextRunAt ? new Date(nextRunAt).toLocaleString() : 'N/A'}`
    );

    return task;
  }

  /**
   * 暂停任务
   */
  async pauseTask(taskId: string): Promise<void> {
    this.cancelTimer(taskId);

    const controller = this.runningTasks.get(taskId);
    if (controller) {
      controller.abort();
      this.runningTasks.delete(taskId);
    }

    await this.taskService.updateTask(taskId, { status: 'paused' });

    console.log(`[SchedulerService] Task paused: ${taskId}`);
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

    console.log(`[SchedulerService] Task resumed: ${taskId}`);
  }

  /**
   * 取消/删除任务
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = await this.taskService.getTask(taskId);

    this.cancelTimer(taskId);

    const controller = this.runningTasks.get(taskId);
    if (controller) {
      controller.abort();
      this.runningTasks.delete(taskId);
    }

    // 从数据库删除
    await this.taskService.deleteTask(taskId);

    // 发射事件（使用删除前获取的任务信息）
    if (task) {
      this.emit('task-cancelled', task);
    }

    console.log(`[SchedulerService] Task cancelled: ${taskId}`);
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
   * 获取插件的所有任�?   */
  async getTasksByPlugin(pluginId: string): Promise<ScheduledTask[]> {
    return await this.taskService.getTasksByPlugin(pluginId);
  }

  /**
   * 获取所有任�?   */
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
   * 删除插件的所有任�?   */
  async deleteTasksByPlugin(pluginId: string): Promise<number> {
    const tasks = await this.taskService.getTasksByPlugin(pluginId);
    for (const task of tasks) {
      this.cancelTimer(task.id);
      const controller = this.runningTasks.get(task.id);
      if (controller) {
        controller.abort();
        this.runningTasks.delete(task.id);
      }
    }

    return await this.taskService.deleteTasksByPlugin(pluginId);
  }

  /**
   * 获取任务的人类可读调度描�?   */
  getScheduleDescription(task: ScheduledTask): string {
    if (task.scheduleType === 'cron' && task.cronExpression) {
      return describeCronExpression(task.cronExpression);
    } else if (task.scheduleType === 'interval' && task.intervalMs) {
      return `�?${formatInterval(task.intervalMs)}`;
    } else if (task.scheduleType === 'once' && task.runAt) {
      return `�?${new Date(task.runAt).toLocaleString()}`;
    }
    return '未知';
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    logger.info('[SchedulerService] Disposing...');

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('[SchedulerService] Cleanup timer cancelled');
    }

    // 取消所有定时器
    for (const [taskId, timer] of this.timers) {
      clearTimeout(timer);
      console.log(`[SchedulerService] Timer cancelled: ${taskId}`);
    }
    this.timers.clear();

    for (const [taskId, controller] of this.runningTasks) {
      controller.abort();
      console.log(`[SchedulerService] Running task aborted: ${taskId}`);
    }
    this.runningTasks.clear();

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
      console.log(`[SchedulerService] Task ${task.id} is not active, skipping schedule`);
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
      // 一次性任务已过期或无法计算下次执行时�?      console.log(`[SchedulerService] No next run time for task ${task.id}`);
      return;
    }

    // 检查是否错过了执行时间
    if (nextRun < now) {
      console.log(`[SchedulerService] Task ${task.id} missed execution time`);

      if (task.missedPolicy === 'run_once') {
        // 立即执行一�?        console.log(`[SchedulerService] Running missed task: ${task.id}`);
        await this.executeTask(task, 'recovery');
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
   * 设置定时�?   */
  private setTimer(taskId: string, runAt: number): void {
    this.cancelTimer(taskId);

    const delay = runAt - Date.now();

    const maxDelay = 24 * 60 * 60 * 1000; // 24 Сʱ

    if (delay > maxDelay) {
      const timer = setTimeout(() => {
        this.setTimer(taskId, runAt);
      }, maxDelay);
      this.timers.set(taskId, timer);
      console.log(
        `[SchedulerService] Intermediate timer set for task ${taskId}, actual run at: ${new Date(runAt).toLocaleString()}`
      );
    } else if (delay > 0) {
      const timer = setTimeout(() => {
        this.onTimerFired(taskId);
      }, delay);
      this.timers.set(taskId, timer);
      console.log(
        `[SchedulerService] Timer set for task ${taskId}, run in ${Math.round(delay / 1000)}s`
      );
    } else {
      // 立即执行
      setImmediate(() => {
        this.onTimerFired(taskId);
      });
    }
  }

  /**
   * 取消定时�?   */
  private cancelTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  /**
   * 定时器触�?   */
  private async onTimerFired(taskId: string): Promise<void> {
    this.timers.delete(taskId);

    const task = await this.taskService.getTask(taskId);
    if (!task || task.status !== 'active') {
      console.log(`[SchedulerService] Task ${taskId} no longer active, skipping execution`);
      return;
    }

    // 执行任务
    await this.executeTask(task, 'scheduled');

    if (task.scheduleType !== 'once') {
      const nextRun = this.calculateNextRun(task, Date.now());
      if (nextRun) {
        await this.taskService.updateTask(taskId, { nextRunAt: nextRun });
        this.setTimer(taskId, nextRun);
      }
    } else {
      // 一次性任务执行完成后禁用
      await this.taskService.updateTask(taskId, { status: 'disabled' });
    }
  }

  /**
   * 执行任务（支持重试）
   */
  private async executeTask(
    task: ScheduledTask,
    triggerType: 'scheduled' | 'manual' | 'recovery'
  ): Promise<TaskExecution> {
    if (this.runningTasks.has(task.id)) {
      console.log(`[SchedulerService] Task ${task.id} is already running, skipping execution`);
      throw new Error(`Task ${task.id} is already running`);
    }

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

    const controller = new AbortController();
    this.runningTasks.set(task.id, controller);
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
      console.log(
        `[SchedulerService] Task started: ${task.name} (${task.id}), trigger: ${triggerType}, maxRetries: ${maxRetries}`
      );

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
          console.log(
            `[SchedulerService] Task cancelled before attempt: ${task.name} (${task.id})`
          );
          break;
        }

        // 设置超时
        const timeoutId = setTimeout(() => {
          controller.abort(new Error(`Task timed out after ${task.timeoutMs}ms`));
        }, task.timeoutMs);

        try {
          if (attempt > 0) {
            console.log(
              `[SchedulerService] Retry ${attempt}/${maxRetries} for task: ${task.name} (${task.id})`
            );
          }

          // Execute handler with the current resource context
          const result = await invokeHandler();

          const finishedAt = Date.now();
          await this.taskService.updateExecution(executionId, {
            status: 'completed',
            finishedAt,
            durationMs: finishedAt - startTime,
            result,
          });

          // 更新任务统计
          await this.taskService.updateTask(task.id, {
            lastRunAt: startTime,
            lastRunStatus: 'success',
            runCount: task.runCount + 1,
          });

          const updatedExecution: TaskExecution = {
            ...runningExecution,
            status: 'completed',
            finishedAt,
            durationMs: finishedAt - startTime,
            result,
          };

          this.emit('task-completed', task, updatedExecution, result);
          console.log(
            `[SchedulerService] Task completed: ${task.name} (${task.id}), duration: ${finishedAt - startTime}ms${attempt > 0 ? `, after ${attempt} retries` : ''}`
          );

          return updatedExecution;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));

          if (controller.signal.aborted) {
            console.log(`[SchedulerService] Task cancelled/timeout: ${task.name} (${task.id})`);
            break;
          }

          console.error(
            `[SchedulerService] Task attempt ${attempt + 1} failed: ${task.name} (${task.id}):`,
            lastError.message
          );

          attempt++;

          // 如果还有重试机会，等待后继续
          if (attempt <= maxRetries) {
            console.log(
              `[SchedulerService] Waiting ${retryDelayMs}ms before retry ${attempt}/${maxRetries}`
            );
            await this.sleep(retryDelayMs);
          }
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ResourceAcquireTimeoutError') {
        lastError = new Error('Resource wait timeout');
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      // 确保执行结束后清�?runningTasks（无论成功、失败还是取消）
      if (resourceLease) {
        await resourceLease.release().catch(() => undefined);
      }
      this.runningTasks.delete(task.id);
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

    // 更新任务统计
    // 修复：cancelled 不计�?failCount，lastRunStatus 区分 cancelled �?failed
    await this.taskService.updateTask(task.id, {
      lastRunAt: startTime,
      lastRunStatus: isCancelled ? 'cancelled' : 'failed',
      runCount: task.runCount + 1,
      failCount: isCancelled ? task.failCount : task.failCount + 1,
    });

    const updatedExecution: TaskExecution = {
      ...runningExecution,
      status,
      finishedAt,
      durationMs: finishedAt - startTime,
      error: lastError?.message ?? 'Unknown error',
    };

    this.emit('task-failed', task, updatedExecution, lastError ?? new Error('Unknown error'));
    console.error(
      `[SchedulerService] Task failed after ${attempt} attempts: ${task.name} (${task.id}):`,
      lastError?.message
    );

    return updatedExecution;
  }

  /**
   * 辅助方法：延迟执�?   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 启动定期清理定时�?   */
  private startCleanupTimer(): void {
    this.performCleanup();

    // 设置定期清理
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.CLEANUP_INTERVAL_MS);

    console.log(
      `[SchedulerService] Cleanup timer started, interval: ${this.CLEANUP_INTERVAL_MS / 1000 / 60 / 60}h, keep: ${this.CLEANUP_DAYS_TO_KEEP} days`
    );
  }

  /**
   * 执行清理操作
   */
  private async performCleanup(): Promise<void> {
    try {
      const count = await this.taskService.cleanupOldExecutions(this.CLEANUP_DAYS_TO_KEEP);
      if (count > 0) {
        console.log(`[SchedulerService] Cleaned up ${count} old execution records`);
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
