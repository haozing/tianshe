/**
 * SchedulerService 单元测试
 * 测试重点：重试逻辑、并发锁、自动清理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SchedulerService } from './scheduler-service';
import type { ScheduledTask, TaskExecution } from '../duckdb/scheduled-task-service';

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-' + Math.random().toString(36).substr(2, 9)),
}));

// Mock cron-parser
vi.mock('./cron-parser', () => ({
  getNextCronTime: vi.fn(() => new Date(Date.now() + 60000)),
  parseInterval: vi.fn((interval: string | number) => {
    if (typeof interval === 'number') return interval;
    const match = interval.match(/^(\d+)(s|m|h|d)$/i);
    if (!match) return 60000;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        return 60000;
    }
  }),
  describeCronExpression: vi.fn(() => '每天 09:00'),
  formatInterval: vi.fn((ms: number) => `${ms}ms`),
}));

/**
 * 创建 Mock TaskService
 */
function createMockTaskService() {
  return {
    getTask: vi.fn(),
    getActiveTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    getTasksByPlugin: vi.fn().mockResolvedValue([]),
    getAllTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    createExecution: vi.fn(),
    updateExecution: vi.fn().mockResolvedValue(undefined),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    cleanupOldExecutions: vi.fn().mockResolvedValue(0),
    getStats: vi.fn().mockResolvedValue({
      total: 0,
      active: 0,
      paused: 0,
      disabled: 0,
      todayExecutions: 0,
      todayFailed: 0,
    }),
    deleteTasksByPlugin: vi.fn().mockResolvedValue(0),
  };
}

/**
 * 创建测试用的任务
 */
function createTestTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'test-task-id',
    pluginId: 'test-plugin',
    name: 'Test Task',
    description: 'Test task description',
    scheduleType: 'interval',
    intervalMs: 60000,
    handlerId: 'test-handler',
    payload: { key: 'value' },
    status: 'active',
    timeoutMs: 5000,
    retryCount: 0,
    retryDelayMs: 1000,
    missedPolicy: 'skip',
    runCount: 0,
    failCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('SchedulerService', () => {
  let scheduler: SchedulerService;
  let mockTaskService: ReturnType<typeof createMockTaskService>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockTaskService = createMockTaskService();
    scheduler = new SchedulerService(mockTaskService as any);
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('初始化和清理', () => {
    it('init 应该启动清理定时器', async () => {
      await scheduler.init();

      // 验证 cleanupOldExecutions 被调用（初始化时会执行一次清理）
      expect(mockTaskService.cleanupOldExecutions).toHaveBeenCalledTimes(1);
      expect(mockTaskService.cleanupOldExecutions).toHaveBeenCalledWith(30);
    });

    it('dispose 应该清理定时器', async () => {
      await scheduler.init();
      await scheduler.dispose();

      // 验证清理后不再执行定时清理
      mockTaskService.cleanupOldExecutions.mockClear();

      // 快进 25 小时，如果定时器没被清理，会再次调用
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(mockTaskService.cleanupOldExecutions).not.toHaveBeenCalled();
    });

    it('定期清理应该每 24 小时执行一次', async () => {
      await scheduler.init();

      // 初始化时已经执行了一次
      expect(mockTaskService.cleanupOldExecutions).toHaveBeenCalledTimes(1);

      // 快进 24 小时
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(mockTaskService.cleanupOldExecutions).toHaveBeenCalledTimes(2);

      // 再快进 24 小时
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(mockTaskService.cleanupOldExecutions).toHaveBeenCalledTimes(3);
    });
  });

  describe('并发锁测试', () => {
    it('同一任务不应并发执行', async () => {
      // 使用真实定时器进行此测试
      vi.useRealTimers();

      const task = createTestTask({ retryCount: 0, timeoutMs: 10000 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      // 注册一个慢处理器
      let resolveHandler: () => void;
      const slowHandler = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveHandler = resolve;
          })
      );
      scheduler.registerHandler(task.pluginId, task.handlerId, slowHandler);

      // 第一次触发（不等待完成）
      const firstTrigger = scheduler.triggerTask(task.id);

      // 等待第一个任务开始执行
      await new Promise((r) => setTimeout(r, 10));

      // 第二次触发应该被拒绝
      await expect(scheduler.triggerTask(task.id)).rejects.toThrow(
        `Task ${task.id} is already running`
      );

      // 完成第一个任务
      resolveHandler!();
      await firstTrigger;

      // 恢复 fake timers
      vi.useFakeTimers();
    });

    it('不同任务可以并发执行', async () => {
      // 使用真实定时器进行此测试
      vi.useRealTimers();

      // 使用不同的 handlerId
      const task1 = createTestTask({ id: 'task-1', handlerId: 'handler-1', timeoutMs: 10000 });
      const task2 = createTestTask({ id: 'task-2', handlerId: 'handler-2', timeoutMs: 10000 });

      mockTaskService.getTask.mockImplementation(async (id: string) => {
        if (id === 'task-1') return task1;
        if (id === 'task-2') return task2;
        return null;
      });

      let execCount = 0;
      mockTaskService.createExecution.mockImplementation(async () => ({
        id: `exec-${++execCount}`,
        taskId: 'task',
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      }));

      let resolve1: () => void;
      let resolve2: () => void;

      const handler1 = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolve1 = resolve;
          })
      );

      const handler2 = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolve2 = resolve;
          })
      );

      // 使用不同的 handlerId 注册
      scheduler.registerHandler(task1.pluginId, 'handler-1', handler1);
      scheduler.registerHandler(task2.pluginId, 'handler-2', handler2);

      // 同时触发两个不同的任务
      const trigger1 = scheduler.triggerTask('task-1');
      const trigger2 = scheduler.triggerTask('task-2');

      // 等待处理器被调用
      await new Promise((r) => setTimeout(r, 50));

      // 两个处理器都应该被调用
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();

      // 完成两个任务
      resolve1!();
      resolve2!();
      await Promise.all([trigger1, trigger2]);

      // 恢复 fake timers
      vi.useFakeTimers();
    });
  });

  describe('重试逻辑测试', () => {
    it('无重试配置时，失败应立即返回失败', async () => {
      const task = createTestTask({ retryCount: 0 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const failingHandler = vi.fn().mockRejectedValue(new Error('Handler failed'));
      scheduler.registerHandler(task.pluginId, task.handlerId, failingHandler);

      const result = await scheduler.triggerTask(task.id);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Handler failed');
      expect(failingHandler).toHaveBeenCalledTimes(1);
    });

    it('重试次数用尽后应返回失败', async () => {
      const task = createTestTask({ retryCount: 3, retryDelayMs: 100 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const failingHandler = vi.fn().mockRejectedValue(new Error('Always fails'));
      scheduler.registerHandler(task.pluginId, task.handlerId, failingHandler);

      const resultPromise = scheduler.triggerTask(task.id);

      // 等待所有重试完成（需要等待重试延迟）
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      const result = await resultPromise;

      // 1次初始执行 + 3次重试 = 4次调用
      expect(failingHandler).toHaveBeenCalledTimes(4);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Always fails');
    });

    it('重试期间成功应立即返回成功', async () => {
      const task = createTestTask({ retryCount: 3, retryDelayMs: 100 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      // 第一次和第二次失败，第三次成功
      const handler = vi
        .fn()
        .mockRejectedValueOnce(new Error('First failure'))
        .mockRejectedValueOnce(new Error('Second failure'))
        .mockResolvedValueOnce({ success: true });

      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      const resultPromise = scheduler.triggerTask(task.id);

      // 等待重试
      await vi.advanceTimersByTimeAsync(300);

      const result = await resultPromise;

      expect(handler).toHaveBeenCalledTimes(3);
      expect(result.status).toBe('completed');
      expect(result.result).toEqual({ success: true });
    });

    it('重试间隔应正确等待', async () => {
      const retryDelayMs = 500;
      const task = createTestTask({ retryCount: 2, retryDelayMs });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const callTimes: number[] = [];
      const handler = vi.fn().mockImplementation(() => {
        callTimes.push(Date.now());
        return Promise.reject(new Error('Fail'));
      });

      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      const resultPromise = scheduler.triggerTask(task.id);

      // 等待所有重试
      await vi.advanceTimersByTimeAsync(2000);

      await resultPromise;

      // 验证调用次数
      expect(handler).toHaveBeenCalledTimes(3);

      // 验证间隔（每次间隔应该大于等于 retryDelayMs）
      for (let i = 1; i < callTimes.length; i++) {
        expect(callTimes[i] - callTimes[i - 1]).toBeGreaterThanOrEqual(retryDelayMs);
      }
    });

    it('超时后任务应被取消且不重试', async () => {
      // 使用真实定时器进行此测试
      vi.useRealTimers();

      const timeoutMs = 50;
      // 设置有重试配置的任务
      const task = createTestTask({ retryCount: 3, timeoutMs, retryDelayMs: 10 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      // 模拟一个在超时后会响应的处理器
      // 处理器会检测到任务被中断并抛出一个带有 "abort" 的错误
      const handler = vi.fn().mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              reject(new Error('Task was aborted due to timeout'));
            }, timeoutMs + 10); // 稍微超过超时时间后抛出错误
          })
      );

      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      const result = await scheduler.triggerTask(task.id);

      // 验证任务被取消（因为错误消息包含 "abort"）
      expect(result.status).toBe('cancelled');
      // 超时后不应该重试，只执行一次
      expect(handler).toHaveBeenCalledTimes(1);

      // 恢复 fake timers
      vi.useFakeTimers();
    }, 5000);
  });

  describe('处理器注册测试', () => {
    it('应向 handler 透传 triggerType', async () => {
      const task = createTestTask();

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const handler = vi.fn().mockResolvedValue({ ok: true });
      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      const result = await scheduler.triggerTask(task.id);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          payload: task.payload,
          triggerType: 'manual',
        })
      );
      expect(result.status).toBe('completed');
    });

    it('未注册处理器时执行任务应失败', async () => {
      const task = createTestTask();

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      // 不注册处理器

      const result = await scheduler.triggerTask(task.id);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Handler not found');
    });

    it('注销处理器后执行任务应失败', async () => {
      const task = createTestTask();

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      // 先注册再注销
      const handler = vi.fn().mockResolvedValue({ success: true });
      scheduler.registerHandler(task.pluginId, task.handlerId, handler);
      scheduler.unregisterHandler(task.pluginId, task.handlerId);

      const result = await scheduler.triggerTask(task.id);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Handler not found');
    });

    it('unregisterPluginHandlers 应移除插件的所有处理器', async () => {
      const task1 = createTestTask({ id: 'task-1', handlerId: 'handler-1' });

      // 注册两个处理器
      scheduler.registerHandler(task1.pluginId, 'handler-1', vi.fn().mockResolvedValue({}));
      scheduler.registerHandler(task1.pluginId, 'handler-2', vi.fn().mockResolvedValue({}));

      // 注销插件的所有处理器
      scheduler.unregisterPluginHandlers(task1.pluginId);

      // 验证两个处理器都被移除
      mockTaskService.getTask.mockResolvedValue(task1);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task1.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const result = await scheduler.triggerTask('task-1');
      expect(result.error).toContain('Handler not found');
    });
  });

  describe('任务状态更新测试', () => {
    it('任务成功后应更新统计信息', async () => {
      const task = createTestTask({ runCount: 5, failCount: 2 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const handler = vi.fn().mockResolvedValue({ result: 'success' });
      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      await scheduler.triggerTask(task.id);

      // 验证 updateTask 被调用，且更新了正确的字段
      expect(mockTaskService.updateTask).toHaveBeenCalledWith(task.id, {
        lastRunAt: expect.any(Number),
        lastRunStatus: 'success',
        runCount: 6, // 原来是5，+1
      });

      // 验证 updateExecution 被调用
      expect(mockTaskService.updateExecution).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'completed',
          result: { result: 'success' },
        })
      );
    });

    it('任务失败后应更新失败统计', async () => {
      const task = createTestTask({ runCount: 5, failCount: 2, retryCount: 0 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const handler = vi.fn().mockRejectedValue(new Error('Task failed'));
      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      await scheduler.triggerTask(task.id);

      // 验证 updateTask 被调用，且更新了正确的字段
      expect(mockTaskService.updateTask).toHaveBeenCalledWith(task.id, {
        lastRunAt: expect.any(Number),
        lastRunStatus: 'failed',
        runCount: 6, // 原来是5，+1
        failCount: 3, // 原来是2，+1
      });
    });
  });

  describe('事件发射测试', () => {
    it('任务开始时应发射 task-started 事件', async () => {
      const task = createTestTask();

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const handler = vi.fn().mockResolvedValue({});
      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      const startedHandler = vi.fn();
      scheduler.on('task-started', startedHandler);

      await scheduler.triggerTask(task.id);

      expect(startedHandler).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ status: 'running' })
      );
    });

    it('任务成功时应发射 task-completed 事件', async () => {
      const task = createTestTask();

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const result = { data: 'success' };
      const handler = vi.fn().mockResolvedValue(result);
      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      const completedHandler = vi.fn();
      scheduler.on('task-completed', completedHandler);

      await scheduler.triggerTask(task.id);

      expect(completedHandler).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ status: 'completed' }),
        result
      );
    });

    it('任务失败时应发射 task-failed 事件', async () => {
      const task = createTestTask({ retryCount: 0 });

      mockTaskService.getTask.mockResolvedValue(task);
      mockTaskService.createExecution.mockResolvedValue({
        id: 'exec-1',
        taskId: task.id,
        status: 'running',
        startedAt: Date.now(),
        triggerType: 'manual',
      } as TaskExecution);

      const error = new Error('Task error');
      const handler = vi.fn().mockRejectedValue(error);
      scheduler.registerHandler(task.pluginId, task.handlerId, handler);

      const failedHandler = vi.fn();
      scheduler.on('task-failed', failedHandler);

      await scheduler.triggerTask(task.id);

      expect(failedHandler).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ status: 'failed' }),
        expect.any(Error)
      );
    });
  });
});
