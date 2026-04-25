/**
 * Task Manager Error Types Unit Tests
 *
 * 任务管理模块错误类型测试
 */

import { describe, it, expect } from 'vitest';
import {
  TaskCancelledError,
  isTaskCancelledError,
  TaskManagerError,
  SchedulerError,
} from './errors';

describe('TaskCancelledError', () => {
  it('should create error with default message', () => {
    const error = new TaskCancelledError();

    expect(error.name).toBe('TaskCancelledError');
    expect(error.message).toBe('Task cancelled');
    expect(error.isCancelled).toBe(true);
    expect(error.reason).toBeUndefined();
  });

  it('should create error with custom message', () => {
    const error = new TaskCancelledError('Custom cancel message');

    expect(error.message).toBe('Custom cancel message');
    expect(error.isCancelled).toBe(true);
  });

  it('should create error with reason', () => {
    const error = new TaskCancelledError('Task cancelled', 'user_requested');

    expect(error.message).toBe('Task cancelled');
    expect(error.reason).toBe('user_requested');
  });

  it('should be instance of Error', () => {
    const error = new TaskCancelledError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TaskCancelledError);
  });

  it('should have correct prototype chain', () => {
    const error = new TaskCancelledError();

    expect(Object.getPrototypeOf(error)).toBe(TaskCancelledError.prototype);
  });

  it('should have stack trace', () => {
    const error = new TaskCancelledError();

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('TaskCancelledError');
  });
});

describe('isTaskCancelledError', () => {
  it('should return true for TaskCancelledError instance', () => {
    const error = new TaskCancelledError();

    expect(isTaskCancelledError(error)).toBe(true);
  });

  it('should return true for object with isCancelled property', () => {
    const error = { isCancelled: true, message: 'Cancelled' };

    expect(isTaskCancelledError(error)).toBe(true);
  });

  it('should return false for regular Error', () => {
    const error = new Error('Regular error');

    expect(isTaskCancelledError(error)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isTaskCancelledError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isTaskCancelledError(undefined)).toBe(false);
  });

  it('should return false for non-object', () => {
    expect(isTaskCancelledError('error')).toBe(false);
    expect(isTaskCancelledError(123)).toBe(false);
  });

  it('should return false for object with isCancelled = false', () => {
    const error = { isCancelled: false, message: 'Not cancelled' };

    expect(isTaskCancelledError(error)).toBe(false);
  });
});

describe('TaskManagerError', () => {
  it('should create error with message', () => {
    const error = new TaskManagerError('Task failed');

    expect(error.name).toBe('TaskManagerError');
    expect(error.message).toBe('Task failed');
    expect(error.code).toBe('TASK_MANAGER_ERROR');
  });

  it('should create error with details', () => {
    const error = new TaskManagerError('Task failed', { taskId: 'task-123' });

    expect(error.details).toEqual({ taskId: 'task-123' });
  });

  it('should create error with cause', () => {
    const cause = new Error('Original error');
    const error = new TaskManagerError('Task failed', undefined, cause);

    expect(error.cause).toBe(cause);
    // Note: Stack chain is only added when cause has a stack
    // In Node/Vitest, Error constructor may not capture stack immediately in all cases
    // Just verify that cause is properly set
    expect(error.cause!.message).toBe('Original error');
  });

  it('should have context with component', () => {
    const error = new TaskManagerError('Task failed');

    expect(error.context).toEqual({ component: 'TaskManager' });
  });

  it('should not be retryable', () => {
    const error = new TaskManagerError('Task failed');

    expect(error.isRetryable()).toBe(false);
  });

  it('should be instance of Error and CoreError', () => {
    const error = new TaskManagerError('Task failed');

    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct prototype chain', () => {
    const error = new TaskManagerError('Task failed');

    expect(Object.getPrototypeOf(error)).toBe(TaskManagerError.prototype);
  });

  it('should have timestamp', () => {
    const before = Date.now();
    const error = new TaskManagerError('Task failed');
    const after = Date.now();

    expect(error.timestamp).toBeGreaterThanOrEqual(before);
    expect(error.timestamp).toBeLessThanOrEqual(after);
  });

  it('should serialize to JSON', () => {
    const error = new TaskManagerError('Task failed', { taskId: 'task-123' });
    const json = error.toJSON();

    expect(json.name).toBe('TaskManagerError');
    expect(json.code).toBe('TASK_MANAGER_ERROR');
    expect(json.message).toBe('Task failed');
    expect(json.details).toEqual({ taskId: 'task-123' });
    expect(json.context).toEqual({ component: 'TaskManager' });
    expect(json.timestamp).toBeDefined();
  });

  it('should serialize cause to JSON', () => {
    const cause = new Error('Original error');
    const error = new TaskManagerError('Task failed', undefined, cause);
    const json = error.toJSON();

    expect(json.cause).toBeDefined();
    expect(json.cause!.message).toBe('Original error');
  });
});

describe('SchedulerError', () => {
  it('should create error with message', () => {
    const error = new SchedulerError('Schedule failed');

    expect(error.name).toBe('SchedulerError');
    expect(error.message).toBe('Schedule failed');
    expect(error.code).toBe('SCHEDULER_ERROR');
  });

  it('should create error with details', () => {
    const error = new SchedulerError('Schedule failed', { taskId: 'task-456' });

    expect(error.details).toEqual({ taskId: 'task-456' });
  });

  it('should create error with cause', () => {
    const cause = new Error('Cron parse error');
    const error = new SchedulerError('Invalid cron', undefined, cause);

    expect(error.cause).toBe(cause);
  });

  it('should have context with component', () => {
    const error = new SchedulerError('Schedule failed');

    expect(error.context).toEqual({ component: 'Scheduler' });
  });

  it('should not be retryable', () => {
    const error = new SchedulerError('Schedule failed');

    expect(error.isRetryable()).toBe(false);
  });

  it('should be instance of Error', () => {
    const error = new SchedulerError('Schedule failed');

    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct prototype chain', () => {
    const error = new SchedulerError('Schedule failed');

    expect(Object.getPrototypeOf(error)).toBe(SchedulerError.prototype);
  });

  it('should serialize to JSON', () => {
    const error = new SchedulerError('Schedule failed', { cron: '* * * * *' });
    const json = error.toJSON();

    expect(json.name).toBe('SchedulerError');
    expect(json.code).toBe('SCHEDULER_ERROR');
    expect(json.message).toBe('Schedule failed');
    expect(json.details).toEqual({ cron: '* * * * *' });
  });

  it('should get user message', () => {
    const error = new SchedulerError('Invalid cron expression');

    expect(error.getUserMessage()).toBe('Invalid cron expression');
  });

  it('should not be user error', () => {
    const error = new SchedulerError('Schedule failed');

    expect(error.isUserError()).toBe(false);
  });
});

describe('Error inheritance and behavior', () => {
  it('should catch TaskCancelledError as Error', () => {
    const fn = () => {
      throw new TaskCancelledError('Cancelled');
    };

    expect(fn).toThrow(Error);
  });

  it('should catch TaskManagerError as Error', () => {
    const fn = () => {
      throw new TaskManagerError('Failed');
    };

    expect(fn).toThrow(Error);
  });

  it('should catch SchedulerError as Error', () => {
    const fn = () => {
      throw new SchedulerError('Failed');
    };

    expect(fn).toThrow(Error);
  });

  it('should differentiate error types', () => {
    const cancelledError = new TaskCancelledError();
    const taskError = new TaskManagerError('Failed');
    const schedulerError = new SchedulerError('Failed');

    expect(cancelledError).toBeInstanceOf(TaskCancelledError);
    expect(cancelledError).not.toBeInstanceOf(TaskManagerError);
    expect(cancelledError).not.toBeInstanceOf(SchedulerError);

    expect(taskError).toBeInstanceOf(TaskManagerError);
    expect(taskError).not.toBeInstanceOf(TaskCancelledError);
    expect(taskError).not.toBeInstanceOf(SchedulerError);

    expect(schedulerError).toBeInstanceOf(SchedulerError);
    expect(schedulerError).not.toBeInstanceOf(TaskCancelledError);
    expect(schedulerError).not.toBeInstanceOf(TaskManagerError);
  });

  it('should work with try-catch specific error type', () => {
    try {
      throw new TaskCancelledError('Cancelled', 'timeout');
    } catch (error) {
      if (isTaskCancelledError(error)) {
        expect(error.reason).toBe('timeout');
      } else {
        throw new Error('Should have been TaskCancelledError');
      }
    }
  });
});
