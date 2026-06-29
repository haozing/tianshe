/**
 * Task Manager Error Types
 *
 * 任务管理模块的错误类型定义
 */

import { CoreError } from '../errors/BaseError';

/**
 * 任务取消错误
 *
 * 当任务被取消时抛出此错误，统一取消语义
 * 无论是内部取消（cancelTask）还是外部取消（abort signal）都使用此错误
 */
export class TaskCancelledError extends Error {
  readonly isCancelled = true;

  constructor(
    message: string = 'Task cancelled',
    public readonly reason?: string
  ) {
    super(message);
    this.name = 'TaskCancelledError';
    Object.setPrototypeOf(this, TaskCancelledError.prototype);
  }
}

/**
 * 检查是否是任务取消错误
 */
export function isTaskCancelledError(error: any): error is TaskCancelledError {
  return error instanceof TaskCancelledError || error?.isCancelled === true;
}

/**
 * 任务管理器错误
 */
export class TaskManagerError extends CoreError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super('TASK_MANAGER_ERROR', message, details, { component: 'TaskManager' }, cause);
    this.name = 'TaskManagerError';
    Object.setPrototypeOf(this, TaskManagerError.prototype);
  }

  override isRetryable(): boolean {
    return false;
  }
}

/**
 * 调度器错误
 */
export class SchedulerError extends CoreError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super('SCHEDULER_ERROR', message, details, { component: 'Scheduler' }, cause);
    this.name = 'SchedulerError';
    Object.setPrototypeOf(this, SchedulerError.prototype);
  }

  override isRetryable(): boolean {
    return false;
  }
}

// 注：isTaskManagerError 和 isSchedulerError 已删除
// 原因：这些函数从未被使用，属于死代码
// 如果需要类型检查，请直接使用 instanceof
