/**
 * Task Queue Implementation
 *
 * 基于 p-queue 的并发任务队列实现
 * 从 js-plugin/namespaces/task-queue.ts 提取
 */

import PQueue from 'p-queue';
import { TypedEventEmitter } from '../typed-event-emitter';
import { createLogger } from '../logger';
import { TaskManagerError, TaskCancelledError } from './errors';

const logger = createLogger('TaskQueue');

// ========== 常量配置 ==========

/** 已完成任务的最大保留数量 */
const MAX_COMPLETED_TASKS = 100;

/** 任务记录延迟清理时间（毫秒） */
const TASK_CLEANUP_DELAY_MS = 5000;

/** 历史清理节流间隔（毫秒） */
const HISTORY_CLEANUP_THROTTLE_MS = 1000;

/** 默认并发数 */
const DEFAULT_CONCURRENCY = 3;

/** 默认超时时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 120000;

/** 默认重试延迟（毫秒） */
const DEFAULT_RETRY_DELAY_MS = 5000;
import type {
  TaskQueueOptions,
  TaskOptions,
  TaskContext,
  TaskInfo,
  TaskEvent,
  TaskStatus,
  QueueStats,
  TaskProgress,
  TaskQueueEvents,
  ITaskQueue,
} from './types';

/**
 * 任务记录（统一管理任务相关状态）
 */
interface TaskRecord {
  info: TaskInfo;
  controller: AbortController;
  deferred: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  };
  /** 清理外部 signal listener 的函数 */
  cleanupExternalSignal?: () => void;
}

/**
 * 任务队列实现类
 */
export class TaskQueue extends TypedEventEmitter<TaskQueueEvents> implements ITaskQueue {
  private queue: PQueue;
  private options: TaskQueueOptions;
  private isStopped = false;

  /** 统一的任务记录表（替代原来的三张分散的表） */
  private taskRecords: Map<string, TaskRecord> = new Map();

  /** 清理节流标记 */
  private cleanupScheduled = false;

  constructor(options: TaskQueueOptions = {}) {
    super();

    this.options = {
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      retry: options.retry ?? 0,
      retryDelay: options.retryDelay ?? DEFAULT_RETRY_DELAY_MS,
      rateLimit: options.rateLimit,
      name: options.name ?? 'TaskQueue',
    };

    // 只配置 p-queue 的并发和速率限制，超时由内部机制处理
    const queueOptions: ConstructorParameters<typeof PQueue>[0] = {
      concurrency: this.options.concurrency,
      autoStart: true,
      ...(this.options.rateLimit && {
        interval: this.options.rateLimit.interval,
        intervalCap: this.options.rateLimit.intervalCap,
      }),
    };

    this.queue = new PQueue(queueOptions);

    this.queue.on('idle', () => {
      this.emit('queue:idle', undefined);
    });

    this.queue.on('empty', () => {
      this.emit('queue:drained', undefined);
    });
  }

  async add<T, TMeta = any>(
    task: (ctx: TaskContext<TMeta>) => T | Promise<T>,
    options: TaskOptions<TMeta> = {}
  ): Promise<T> {
    if (this.isStopped) {
      throw new TaskManagerError('Queue has been stopped');
    }

    const taskId = options.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const controller = new AbortController();

    // 设置外部 signal 监听（如果提供）
    let cleanupExternalSignal: (() => void) | undefined;
    if (options.signal) {
      const externalAbortHandler = () => {
        controller.abort(options.signal!.reason);
      };
      options.signal.addEventListener('abort', externalAbortHandler);
      cleanupExternalSignal = () => {
        options.signal!.removeEventListener('abort', externalAbortHandler);
      };
    }

    const taskInfo: TaskInfo<TMeta> = {
      taskId,
      name: options.name,
      status: 'pending',
      createdAt: Date.now(),
      retryCount: 0,
      meta: options.meta,
    };

    const deferred = this.createDeferred<T>();
    // 防止调用方忽略 Promise 时出现未处理的拒绝警告
    deferred.promise.catch(() => {});

    // 统一存储任务记录
    const record: TaskRecord = {
      info: taskInfo,
      controller,
      deferred: deferred as TaskRecord['deferred'],
      cleanupExternalSignal,
    };
    this.taskRecords.set(taskId, record);

    this.emit('task:added', this.createEvent(taskInfo));

    const wrappedTask = async (): Promise<T> => {
      try {
        return await this.executeTask(taskId, task, options, controller, taskInfo);
      } finally {
        // 清理外部 signal listener
        cleanupExternalSignal?.();
      }
    };

    this.queue
      .add(wrappedTask, {
        priority: options.priority ?? 0,
      })
      .then((result) => {
        deferred.resolve(result as T);
        return result;
      })
      .catch((error) => {
        deferred.reject(error);
        return undefined as unknown;
      });

    return deferred.promise as Promise<T>;
  }

  async addAll<T, TMeta = any>(
    tasks: Array<{
      task: (ctx: TaskContext<TMeta>) => T | Promise<T>;
      options?: TaskOptions<TMeta>;
    }>
  ): Promise<T[]> {
    if (this.isStopped) {
      throw new TaskManagerError('Queue has been stopped');
    }

    const promises = tasks.map(({ task, options }) => this.add(task, options));
    return Promise.all(promises);
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const record = this.taskRecords.get(taskId);
    if (!record) {
      return false;
    }

    record.controller.abort(new Error('Task cancelled'));
    return true;
  }

  async cancelTasks(taskIds: string[]): Promise<number> {
    let count = 0;
    for (const taskId of taskIds) {
      const cancelled = await this.cancelTask(taskId);
      if (cancelled) count++;
    }
    return count;
  }

  async cancelAll(): Promise<number> {
    const taskIds = Array.from(this.taskRecords.keys());
    return this.cancelTasks(taskIds);
  }

  getTask(taskId: string): TaskInfo | null {
    const record = this.taskRecords.get(taskId);
    return record?.info || null;
  }

  getAllTasks(filter?: { status?: TaskStatus | TaskStatus[]; name?: string }): TaskInfo[] {
    let tasks = Array.from(this.taskRecords.values()).map((r) => r.info);

    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      tasks = tasks.filter((t) => statuses.includes(t.status));
    }

    if (filter?.name) {
      tasks = tasks.filter((t) => t.name === filter.name);
    }

    return tasks;
  }

  getStats(): QueueStats {
    const tasks = Array.from(this.taskRecords.values()).map((r) => r.info);

    return {
      total: tasks.length,
      running: tasks.filter((t) => t.status === 'running').length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      isPaused: this.queue.isPaused,
    };
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.start();
  }

  /**
   * 清空队列
   *
   * 行为：
   * 1. 清空 pending 任务（未开始的）- reject TaskCancelledError
   * 2. 取消 running 任务（正在执行的）- 通过 abort signal
   * 3. 统一发出 cancelled 事件
   *
   * 修复：pending 任务也统一 reject TaskCancelledError，保持语义一致
   */
  clear(): void {
    // 1. 清空 p-queue 中的 pending 任务
    this.queue.clear();

    // 2. 处理所有任务
    for (const [taskId, record] of Array.from(this.taskRecords.entries())) {
      const { info: taskInfo, controller, deferred, cleanupExternalSignal } = record;

      if (taskInfo.status === 'pending') {
        // pending 任务：统一 reject TaskCancelledError（与 running 任务取消语义一致）
        taskInfo.status = 'cancelled';
        taskInfo.finishedAt = Date.now();
        taskInfo.duration = taskInfo.finishedAt - (taskInfo.startedAt || taskInfo.createdAt);
        this.emit('task:cancelled', this.createEvent(taskInfo));

        // 清理外部 signal listener（修复泄漏）
        cleanupExternalSignal?.();

        // 统一使用 reject TaskCancelledError
        deferred.reject(new TaskCancelledError('Task cancelled', 'Queue cleared'));
        this.taskRecords.delete(taskId);
      } else if (taskInfo.status === 'running') {
        // running 任务：通过 abort signal 取消
        // executeTask 会处理 signal.aborted 并发出 cancelled 事件
        controller.abort(new Error('Task cancelled by clear()'));
        // 不在这里 delete，让 executeTask 处理
      }
    }
  }

  /**
   * 停止队列
   *
   * 修复：
   * 1. 先处理 pending 任务，避免 pause 状态下死锁
   * 2. 统一取消语义
   */
  async stop(): Promise<void> {
    if (this.isStopped) {
      return;
    }

    this.isStopped = true;

    logger.info(`Stopping queue: ${this.options.name}`);

    // 1. 确保队列不是暂停状态（否则 Promise.allSettled 可能卡住）
    this.queue.start();

    // 2. 清空 p-queue 的 pending 任务
    this.queue.clear();

    // 3. 先处理 pending 任务，让它们的 promise settle
    for (const [taskId, record] of Array.from(this.taskRecords.entries())) {
      const { info: taskInfo, deferred, cleanupExternalSignal } = record;

      if (taskInfo.status === 'pending') {
        taskInfo.status = 'cancelled';
        taskInfo.finishedAt = Date.now();
        taskInfo.duration = taskInfo.finishedAt - (taskInfo.startedAt || taskInfo.createdAt);
        this.emit('task:cancelled', this.createEvent(taskInfo));

        // 清理外部 signal listener
        cleanupExternalSignal?.();

        deferred.reject(new TaskCancelledError('Task cancelled', 'Queue stopped'));
        this.taskRecords.delete(taskId);
      }
    }

    // 4. 取消 running 任务
    await this.cancelAll();

    // 5. 等待 running 任务真正结束（现在只剩 running 任务的 promise）
    const runningPromises = Array.from(this.taskRecords.values())
      .filter((r) => r.info.status === 'running' || r.info.status === 'cancelled')
      .map((r) => r.deferred.promise);
    await Promise.allSettled(runningPromises);

    // 6. 等待 p-queue 完全空闲
    await this.queue.onIdle();

    // 7. 清理
    this.removeAllListeners();

    if (typeof this.queue.removeAllListeners === 'function') {
      this.queue.removeAllListeners();
    }

    this.taskRecords.clear();

    logger.info(`Queue stopped: ${this.options.name}`);
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  /**
   * 执行单个任务（内部方法）
   *
   * 修复：
   * 1. 超时不破坏并发上限 - 超时只触发 abort signal，等待任务真正结束
   * 2. taskId 复用竞态 - 延迟清理时检查 controller 引用
   */
  private async executeTask<T, TMeta>(
    taskId: string,
    task: (ctx: TaskContext<TMeta>) => T | Promise<T>,
    options: TaskOptions<TMeta>,
    controller: AbortController,
    taskInfo: TaskInfo<TMeta>
  ): Promise<T> {
    const maxRetry = options.retry ?? this.options.retry ?? 0;
    const taskTimeout = options.timeout ?? this.options.timeout ?? DEFAULT_TIMEOUT_MS;
    let retryCount = 0;

    // 保存 controller 引用，用于延迟清理时检查
    const controllerRef = controller;

    const attempt = async (): Promise<T> => {
      taskInfo.status = 'running';
      taskInfo.startedAt = Date.now();
      this.emit('task:started', this.createEvent(taskInfo));

      // 设置超时定时器（只触发 abort，不直接 reject）
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      if (taskTimeout > 0 && Number.isFinite(taskTimeout)) {
        timeoutId = setTimeout(() => {
          controller.abort(new Error(`Task timeout after ${taskTimeout}ms`));
        }, taskTimeout);
      }

      try {
        const ctx: TaskContext<TMeta> = {
          signal: controller.signal,
          taskId,
          meta: options.meta,
          updateProgress: (progress: TaskProgress) => {
            taskInfo.progress = progress;
            this.emit('task:progress', this.createEvent(taskInfo));
          },
        };

        // 直接等待任务完成（不用 Promise.race，确保并发槽位只在任务真正结束时释放）
        const result = await task(ctx);

        // 检查是否在任务执行期间被取消/超时
        if (controller.signal.aborted) {
          throw new TaskCancelledError('Task cancelled', 'Aborted during execution');
        }

        taskInfo.status = 'completed';
        taskInfo.finishedAt = Date.now();
        taskInfo.duration = taskInfo.finishedAt - (taskInfo.startedAt || taskInfo.createdAt);

        this.emit('task:completed', this.createEvent(taskInfo));

        return result;
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          const abortReason = controller.signal.reason;
          const reason =
            abortReason instanceof Error ? abortReason.message : String(abortReason || 'cancelled');
          const cancellationError = new TaskCancelledError('Task cancelled', reason);

          taskInfo.status = 'cancelled';
          taskInfo.finishedAt = Date.now();
          taskInfo.duration = taskInfo.finishedAt - (taskInfo.startedAt || taskInfo.createdAt);
          taskInfo.error = cancellationError;

          this.emit('task:cancelled', this.createEvent(taskInfo));

          throw cancellationError;
        }

        if (retryCount < maxRetry) {
          // 重试前检查是否已被取消，避免浪费时间等待
          if (controller.signal.aborted) {
            const abortReason = controller.signal.reason;
            const reason =
              abortReason instanceof Error
                ? abortReason.message
                : String(abortReason || 'cancelled');
            throw new TaskCancelledError('Task cancelled before retry', reason);
          }

          retryCount++;
          taskInfo.retryCount = retryCount;

          logger.warn(
            `Task ${taskInfo.name || taskId} failed, retrying (${retryCount}/${maxRetry})`
          );

          await new Promise((resolve) =>
            setTimeout(resolve, this.options.retryDelay ?? DEFAULT_RETRY_DELAY_MS)
          );

          return attempt();
        }

        taskInfo.status = 'failed';
        taskInfo.finishedAt = Date.now();
        taskInfo.duration = taskInfo.finishedAt - (taskInfo.startedAt || taskInfo.createdAt);
        taskInfo.error = error instanceof Error ? error : new Error(String(error));

        this.emit('task:failed', this.createEvent(taskInfo));
        throw error;
      } finally {
        // 清理超时定时器
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // 延迟清理任务记录（给调用方一点时间检查状态）
        // 修复竞态：检查 controller 引用是否仍是当前任务的
        setTimeout(() => {
          const record = this.taskRecords.get(taskId);
          if (record && record.controller === controllerRef) {
            this.taskRecords.delete(taskId);
          }
        }, TASK_CLEANUP_DELAY_MS);

        // 触发历史任务清理（节流处理）
        this.scheduleHistoryCleanup();
      }
    };

    return attempt();
  }

  /**
   * 调度历史任务清理（节流）
   */
  private scheduleHistoryCleanup(): void {
    if (this.cleanupScheduled) return;
    this.cleanupScheduled = true;

    // 延迟执行，避免频繁清理
    setTimeout(() => {
      this.cleanupScheduled = false;
      this.cleanupCompletedTasks();
    }, HISTORY_CLEANUP_THROTTLE_MS);
  }

  /**
   * 清理已完成的任务历史
   *
   * 保留最近 MAX_COMPLETED_TASKS 个已完成/失败/取消的任务
   * 正在运行和等待中的任务不会被清理
   */
  private cleanupCompletedTasks(): void {
    const completedTasks: Array<{ id: string; finishedAt: number }> = [];

    for (const [taskId, record] of this.taskRecords) {
      const taskInfo = record.info;
      if (
        taskInfo.status === 'completed' ||
        taskInfo.status === 'failed' ||
        taskInfo.status === 'cancelled'
      ) {
        completedTasks.push({
          id: taskId,
          finishedAt: taskInfo.finishedAt || 0,
        });
      }
    }

    // 如果已完成任务超过限制，删除最早的
    if (completedTasks.length > MAX_COMPLETED_TASKS) {
      // 按完成时间排序（最早的在前）
      completedTasks.sort((a, b) => a.finishedAt - b.finishedAt);

      // 删除超出限制的部分
      const toDelete = completedTasks.slice(0, completedTasks.length - MAX_COMPLETED_TASKS);
      for (const { id } of toDelete) {
        this.taskRecords.delete(id);
      }
    }
  }

  /**
   * 创建 Deferred Promise
   */
  private createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  }

  private createEvent<TMeta>(taskInfo: TaskInfo<TMeta>): TaskEvent<TMeta> {
    return {
      taskId: taskInfo.taskId,
      name: taskInfo.name,
      status: taskInfo.status,
      meta: taskInfo.meta,
      error: taskInfo.error,
      progress: taskInfo.progress,
      duration: taskInfo.duration,
    };
  }
}

/**
 * 创建任务队列的工厂函数
 */
export function createTaskQueue(options?: TaskQueueOptions): TaskQueue {
  return new TaskQueue(options);
}
