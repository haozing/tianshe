/**
 * Scheduler Unit Tests
 *
 * 定时任务调度器测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Scheduler, setSchedulerService, getSchedulerService } from './scheduler';
import type { ScheduleOptions } from './scheduler';
import { SchedulerError } from './errors';

// Mock SchedulerService
function createMockSchedulerService() {
  const handlers = new Map<string, Map<string, Function>>();

  return {
    // Handler management
    registerHandler: vi.fn((pluginId: string, handlerId: string, handler: Function) => {
      if (!handlers.has(pluginId)) {
        handlers.set(pluginId, new Map());
      }
      handlers.get(pluginId)!.set(handlerId, handler);
    }),
    unregisterHandler: vi.fn((pluginId: string, handlerId: string) => {
      handlers.get(pluginId)?.delete(handlerId);
    }),
    unregisterPluginHandlers: vi.fn((pluginId: string) => {
      handlers.delete(pluginId);
    }),

    // Task management
    createTask: vi.fn().mockResolvedValue({
      id: 'task-123',
      pluginId: 'test-caller',
      name: 'Test Task',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      handlerId: 'handler-123',
      status: 'active',
      runCount: 0,
      failCount: 0,
      createdAt: Date.now(),
      nextRunAt: Date.now() + 86400000,
    }),
    getTask: vi.fn().mockResolvedValue({
      id: 'task-123',
      pluginId: 'test-caller',
      name: 'Test Task',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      handlerId: 'handler-123',
      status: 'active',
      runCount: 5,
      failCount: 1,
      createdAt: Date.now() - 86400000,
      lastRunAt: Date.now() - 3600000,
      lastRunStatus: 'completed',
      nextRunAt: Date.now() + 3600000,
    }),
    getTasksByPlugin: vi.fn().mockResolvedValue([]),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    resumeTask: vi.fn().mockResolvedValue(undefined),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    triggerTask: vi.fn().mockResolvedValue({
      id: 'exec-123',
      taskId: 'task-123',
      status: 'completed',
      startedAt: Date.now(),
      finishedAt: Date.now() + 1000,
      durationMs: 1000,
      triggerType: 'manual',
    }),
    getTaskHistory: vi.fn().mockResolvedValue([]),
    deleteTasksByPlugin: vi.fn().mockResolvedValue(2),
  };
}

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let mockService: ReturnType<typeof createMockSchedulerService>;
  const callerId = 'test-caller';

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockSchedulerService();
    scheduler = new Scheduler({
      schedulerService: mockService as any,
      callerId,
    });
  });

  // ========== 初始化测试 ==========

  describe('initialization', () => {
    it('should create scheduler with config', () => {
      expect(scheduler).toBeDefined();
      expect(scheduler.isAvailable()).toBe(true);
    });

    it('should report unavailable when service is null', () => {
      const unavailableScheduler = new Scheduler({
        schedulerService: null,
        callerId: 'test',
      });
      expect(unavailableScheduler.isAvailable()).toBe(false);
    });
  });

  // ========== 全局服务管理测试 ==========

  describe('global service management', () => {
    afterEach(() => {
      // Reset global service
      setSchedulerService(null as any);
    });

    it('should set and get global scheduler service', () => {
      expect(getSchedulerService()).toBeNull();

      setSchedulerService(mockService as any);
      expect(getSchedulerService()).toBe(mockService);
    });
  });

  // ========== create 方法测试 ==========

  describe('create', () => {
    it('should create cron task', async () => {
      const options: ScheduleOptions = {
        name: 'Daily Task',
        cron: '0 9 * * *',
        handler: vi.fn().mockResolvedValue('done'),
      };

      const taskInfo = await scheduler.create(options);

      expect(mockService.registerHandler).toHaveBeenCalled();
      expect(mockService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: callerId,
          name: 'Daily Task',
          scheduleType: 'cron',
          cron: '0 9 * * *',
        })
      );
      expect(taskInfo.id).toBe('task-123');
      expect(taskInfo.scheduleType).toBe('cron');
      expect(taskInfo.scheduleDescription).toContain('Cron:');
    });

    it('should create interval task', async () => {
      mockService.createTask.mockResolvedValueOnce({
        id: 'task-456',
        pluginId: callerId,
        name: 'Interval Task',
        scheduleType: 'interval',
        intervalMs: 60000,
        handlerId: 'handler-456',
        status: 'active',
        runCount: 0,
        failCount: 0,
        createdAt: Date.now(),
      });

      const options: ScheduleOptions = {
        name: 'Interval Task',
        interval: 60000,
        handler: vi.fn(),
      };

      const taskInfo = await scheduler.create(options);

      expect(mockService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleType: 'interval',
          interval: 60000,
        })
      );
      expect(taskInfo.scheduleType).toBe('interval');
      expect(taskInfo.scheduleDescription).toContain('Every');
    });

    it('should create one-time task', async () => {
      const runAt = Date.now() + 3600000;
      mockService.createTask.mockResolvedValueOnce({
        id: 'task-789',
        pluginId: callerId,
        name: 'One-time Task',
        scheduleType: 'once',
        runAt,
        handlerId: 'handler-789',
        status: 'active',
        runCount: 0,
        failCount: 0,
        createdAt: Date.now(),
      });

      const options: ScheduleOptions = {
        name: 'One-time Task',
        runAt,
        handler: vi.fn(),
      };

      const taskInfo = await scheduler.create(options);

      expect(mockService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleType: 'once',
          runAt,
        })
      );
      expect(taskInfo.scheduleType).toBe('once');
      expect(taskInfo.scheduleDescription).toContain('At');
    });

    it('should throw when no schedule type specified', async () => {
      const options: ScheduleOptions = {
        name: 'Invalid Task',
        handler: vi.fn(),
      };

      await expect(scheduler.create(options)).rejects.toThrow(SchedulerError);
      await expect(scheduler.create(options)).rejects.toThrow(
        'Must specify exactly one of: cron, interval, or runAt'
      );
    });

    it('should throw when multiple schedule types specified', async () => {
      const options: ScheduleOptions = {
        name: 'Invalid Task',
        cron: '0 9 * * *',
        interval: 60000,
        handler: vi.fn(),
      };

      await expect(scheduler.create(options)).rejects.toThrow(SchedulerError);
    });

    it('should throw when service not initialized', async () => {
      const unavailableScheduler = new Scheduler({
        schedulerService: null,
        callerId: 'test',
      });

      await expect(
        unavailableScheduler.create({
          name: 'Task',
          cron: '* * * * *',
          handler: vi.fn(),
        })
      ).rejects.toThrow('SchedulerService not initialized');
    });

    it('should rollback handler on createTask failure', async () => {
      mockService.createTask.mockRejectedValueOnce(new Error('Create failed'));

      await expect(
        scheduler.create({
          name: 'Task',
          cron: '* * * * *',
          handler: vi.fn(),
        })
      ).rejects.toThrow('Create failed');

      // Handler should be unregistered
      expect(mockService.unregisterHandler).toHaveBeenCalled();
    });

    it('should pass optional configuration', async () => {
      const options: ScheduleOptions = {
        name: 'Configured Task',
        cron: '0 9 * * *',
        handler: vi.fn(),
        description: 'Test description',
        timeout: 30000,
        retry: 3,
        retryDelay: 1000,
        missedPolicy: 'run_once',
        payload: { key: 'value' },
      };

      await scheduler.create(options);

      expect(mockService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Test description',
          timeout: 30000,
          retry: 3,
          retryDelay: 1000,
          missedPolicy: 'run_once',
          payload: { key: 'value' },
        })
      );
    });
  });

  // ========== pause/resume 测试 ==========

  describe('pause', () => {
    it('should pause task', async () => {
      await scheduler.pause('task-123');

      expect(mockService.getTask).toHaveBeenCalledWith('task-123');
      expect(mockService.pauseTask).toHaveBeenCalledWith('task-123');
    });

    it('should throw when task not found', async () => {
      mockService.getTask.mockResolvedValueOnce(null);

      await expect(scheduler.pause('unknown')).rejects.toThrow('Task not found');
    });

    it('should throw when task belongs to another caller', async () => {
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-123',
        pluginId: 'other-caller',
      });

      await expect(scheduler.pause('task-123')).rejects.toThrow(
        'Cannot pause task from another caller'
      );
    });
  });

  describe('resume', () => {
    it('should resume task', async () => {
      await scheduler.resume('task-123');

      expect(mockService.getTask).toHaveBeenCalledWith('task-123');
      expect(mockService.resumeTask).toHaveBeenCalledWith('task-123');
    });

    it('should throw when task belongs to another caller', async () => {
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-123',
        pluginId: 'other-caller',
      });

      await expect(scheduler.resume('task-123')).rejects.toThrow(
        'Cannot resume task from another caller'
      );
    });
  });

  // ========== cancel 测试 ==========

  describe('cancel', () => {
    it('should cancel task and cleanup handler', async () => {
      await scheduler.cancel('task-123');

      expect(mockService.getTask).toHaveBeenCalledWith('task-123');
      expect(mockService.unregisterHandler).toHaveBeenCalledWith(callerId, 'handler-123');
      expect(mockService.cancelTask).toHaveBeenCalledWith('task-123');
    });

    it('should throw when task not found', async () => {
      mockService.getTask.mockResolvedValueOnce(null);

      await expect(scheduler.cancel('unknown')).rejects.toThrow('Task not found');
    });

    it('should throw when task belongs to another caller', async () => {
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-123',
        pluginId: 'other-caller',
        handlerId: 'handler-123',
      });

      await expect(scheduler.cancel('task-123')).rejects.toThrow(
        'Cannot cancel task from another caller'
      );
    });
  });

  // ========== trigger 测试 ==========

  describe('trigger', () => {
    it('should trigger task and return execution info', async () => {
      const execInfo = await scheduler.trigger('task-123');

      expect(mockService.getTask).toHaveBeenCalledWith('task-123');
      expect(mockService.triggerTask).toHaveBeenCalledWith('task-123');
      expect(execInfo.id).toBe('exec-123');
      expect(execInfo.taskId).toBe('task-123');
      expect(execInfo.status).toBe('completed');
      expect(execInfo.triggerType).toBe('manual');
    });

    it('should throw when task belongs to another caller', async () => {
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-123',
        pluginId: 'other-caller',
      });

      await expect(scheduler.trigger('task-123')).rejects.toThrow(
        'Cannot trigger task from another caller'
      );
    });
  });

  // ========== list/get 测试 ==========

  describe('list', () => {
    it('should list tasks for caller', async () => {
      mockService.getTasksByPlugin.mockResolvedValueOnce([
        {
          id: 'task-1',
          pluginId: callerId,
          name: 'Task 1',
          scheduleType: 'cron',
          cronExpression: '0 * * * *',
          status: 'active',
          runCount: 10,
          failCount: 0,
          createdAt: Date.now(),
        },
        {
          id: 'task-2',
          pluginId: callerId,
          name: 'Task 2',
          scheduleType: 'interval',
          intervalMs: 3600000,
          status: 'paused',
          runCount: 5,
          failCount: 2,
          createdAt: Date.now(),
        },
      ]);

      const tasks = await scheduler.list();

      expect(mockService.getTasksByPlugin).toHaveBeenCalledWith(callerId);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].name).toBe('Task 1');
      expect(tasks[1].name).toBe('Task 2');
    });

    it('should return empty array when no tasks', async () => {
      const tasks = await scheduler.list();

      expect(tasks).toEqual([]);
    });
  });

  describe('get', () => {
    it('should get task info', async () => {
      const taskInfo = await scheduler.get('task-123');

      expect(mockService.getTask).toHaveBeenCalledWith('task-123');
      expect(taskInfo).not.toBeNull();
      expect(taskInfo!.id).toBe('task-123');
      expect(taskInfo!.runCount).toBe(5);
      expect(taskInfo!.failCount).toBe(1);
    });

    it('should return null when task not found', async () => {
      mockService.getTask.mockResolvedValueOnce(null);

      const taskInfo = await scheduler.get('unknown');

      expect(taskInfo).toBeNull();
    });

    it('should throw when task belongs to another caller', async () => {
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-123',
        pluginId: 'other-caller',
      });

      await expect(scheduler.get('task-123')).rejects.toThrow(
        'Cannot access task from another caller'
      );
    });
  });

  // ========== getHistory 测试 ==========

  describe('getHistory', () => {
    it('should get execution history', async () => {
      mockService.getTaskHistory.mockResolvedValueOnce([
        {
          id: 'exec-1',
          taskId: 'task-123',
          status: 'completed',
          startedAt: Date.now() - 7200000,
          finishedAt: Date.now() - 7199000,
          durationMs: 1000,
          triggerType: 'scheduled',
        },
        {
          id: 'exec-2',
          taskId: 'task-123',
          status: 'failed',
          startedAt: Date.now() - 3600000,
          finishedAt: Date.now() - 3599000,
          durationMs: 1000,
          error: 'Connection timeout',
          triggerType: 'scheduled',
        },
      ]);

      const history = await scheduler.getHistory('task-123');

      expect(mockService.getTask).toHaveBeenCalledWith('task-123');
      expect(mockService.getTaskHistory).toHaveBeenCalledWith('task-123', 20);
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe('completed');
      expect(history[1].status).toBe('failed');
      expect(history[1].error).toBe('Connection timeout');
    });

    it('should respect limit parameter', async () => {
      await scheduler.getHistory('task-123', 50);

      expect(mockService.getTaskHistory).toHaveBeenCalledWith('task-123', 50);
    });

    it('should throw when task belongs to another caller', async () => {
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-123',
        pluginId: 'other-caller',
      });

      await expect(scheduler.getHistory('task-123')).rejects.toThrow(
        'Cannot access history of task from another caller'
      );
    });
  });

  // ========== dispose 测试 ==========

  describe('dispose', () => {
    it('should delete tasks and unregister handlers', async () => {
      await scheduler.dispose();

      expect(mockService.deleteTasksByPlugin).toHaveBeenCalledWith(callerId);
      expect(mockService.unregisterPluginHandlers).toHaveBeenCalledWith(callerId);
    });

    it('should handle dispose when service is null', async () => {
      const unavailableScheduler = new Scheduler({
        schedulerService: null,
        callerId: 'test',
      });

      // Should not throw
      await expect(unavailableScheduler.dispose()).resolves.toBeUndefined();
    });

    it('should handle deleteTasksByPlugin error gracefully', async () => {
      mockService.deleteTasksByPlugin.mockRejectedValueOnce(new Error('Delete failed'));

      // Should not throw, just log error
      await expect(scheduler.dispose()).resolves.toBeUndefined();
      expect(mockService.unregisterPluginHandlers).toHaveBeenCalled();
    });
  });

  // ========== scheduleDescription 格式化测试 ==========

  describe('schedule description formatting', () => {
    it('should format cron description', async () => {
      mockService.createTask.mockResolvedValueOnce({
        id: 'task-cron',
        pluginId: callerId,
        name: 'Cron Task',
        scheduleType: 'cron',
        cronExpression: '0 9 * * 1-5',
        handlerId: 'handler',
        status: 'active',
        runCount: 0,
        failCount: 0,
        createdAt: Date.now(),
      });

      const taskInfo = await scheduler.create({
        name: 'Cron Task',
        cron: '0 9 * * 1-5',
        handler: vi.fn(),
      });

      expect(taskInfo.scheduleDescription).toBe('Cron: 0 9 * * 1-5');
    });

    it('should format interval descriptions', async () => {
      const testCases = [
        { intervalMs: 500, expected: '500ms' },
        { intervalMs: 30000, expected: '30s' },
        { intervalMs: 300000, expected: '5m' },
        { intervalMs: 7200000, expected: '2h' },
        { intervalMs: 172800000, expected: '2d' },
      ];

      for (const { intervalMs, expected } of testCases) {
        mockService.createTask.mockResolvedValueOnce({
          id: `task-interval-${intervalMs}`,
          pluginId: callerId,
          name: 'Interval Task',
          scheduleType: 'interval',
          intervalMs,
          handlerId: 'handler',
          status: 'active',
          runCount: 0,
          failCount: 0,
          createdAt: Date.now(),
        });

        const taskInfo = await scheduler.create({
          name: 'Interval Task',
          interval: intervalMs,
          handler: vi.fn(),
        });

        expect(taskInfo.scheduleDescription).toBe(`Every ${expected}`);
      }
    });

    it('should format once description', async () => {
      const runAt = new Date('2024-01-15T09:00:00').getTime();
      mockService.createTask.mockResolvedValueOnce({
        id: 'task-once',
        pluginId: callerId,
        name: 'Once Task',
        scheduleType: 'once',
        runAt,
        handlerId: 'handler',
        status: 'active',
        runCount: 0,
        failCount: 0,
        createdAt: Date.now(),
      });

      const taskInfo = await scheduler.create({
        name: 'Once Task',
        runAt,
        handler: vi.fn(),
      });

      expect(taskInfo.scheduleDescription).toContain('At');
    });

    it('should handle unknown schedule type', async () => {
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-unknown',
        pluginId: callerId,
        name: 'Unknown Task',
        scheduleType: 'unknown' as any,
        handlerId: 'handler',
        status: 'active',
        runCount: 0,
        failCount: 0,
        createdAt: Date.now(),
      });

      const taskInfo = await scheduler.get('task-unknown');

      expect(taskInfo!.scheduleDescription).toBe('Unknown');
    });
  });

  // ========== Handler 调用测试 ==========

  describe('handler invocation', () => {
    it('should invoke registered handler with context', async () => {
      const handler = vi.fn().mockResolvedValue('result');

      await scheduler.create({
        name: 'Handler Test',
        cron: '* * * * *',
        handler,
      });

      // Get the registered handler from mock
      const registerCall = mockService.registerHandler.mock.calls[0];
      const wrappedHandler = registerCall[2];

      // Invoke the handler
      const ctx = {
        signal: new AbortController().signal,
        payload: { test: true },
      };
      const result = await wrappedHandler(ctx);

      expect(result).toBe('result');
    });

    it('should throw when handler not found during invocation', async () => {
      await scheduler.create({
        name: 'Handler Test',
        cron: '* * * * *',
        handler: vi.fn(),
      });

      const registerCall = mockService.registerHandler.mock.calls[0];
      const wrappedHandler = registerCall[2];
      const handlerId = registerCall[1];

      // Cancel the task to remove handler
      mockService.getTask.mockResolvedValueOnce({
        id: 'task-123',
        pluginId: callerId,
        handlerId,
      });
      await scheduler.cancel('task-123');

      // Now try to invoke - should throw
      await expect(wrappedHandler({ signal: new AbortController().signal })).rejects.toThrow(
        'Handler not found'
      );
    });
  });
});
