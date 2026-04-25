/**
 * scheduler.test.ts - 调度器命名空间测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-1234'),
}));

// Mock scheduler helpers
vi.mock('../../../main/scheduler', () => ({
  describeCronExpression: vi.fn((cron) => `Cron: ${cron}`),
  formatInterval: vi.fn((ms) => `${ms}ms`),
}));

import {
  SchedulerNamespace,
  setSchedulerService,
  getSchedulerService,
  type CreateTaskOptions,
} from './scheduler';
import type { SchedulerService } from '../../../main/scheduler';
import type { ScheduledTask, TaskExecution } from '../../../types/scheduler';

describe('SchedulerNamespace', () => {
  let scheduler: SchedulerNamespace;
  let mockSchedulerService: SchedulerService;

  const createMockTask = (overrides = {}): ScheduledTask => ({
    id: 'task-123',
    pluginId: 'test-plugin',
    name: 'Test Task',
    description: 'A test task',
    scheduleType: 'cron',
    cronExpression: '0 9 * * *',
    intervalMs: undefined,
    runAt: undefined,
    handlerId: 'handler-123',
    payload: {},
    timeout: 120000,
    retry: 0,
    retryDelay: 5000,
    missedPolicy: 'skip',
    status: 'active',
    lastRunAt: undefined,
    lastRunStatus: undefined,
    nextRunAt: Date.now() + 86400000,
    runCount: 0,
    failCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  const createMockExecution = (overrides = {}): TaskExecution => ({
    id: 'exec-123',
    taskId: 'task-123',
    status: 'completed',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    durationMs: 1000,
    result: { success: true },
    error: undefined,
    triggerType: 'scheduled',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // 创建 mock SchedulerService
    mockSchedulerService = {
      createTask: vi.fn(),
      getTask: vi.fn(),
      getTasksByPlugin: vi.fn(),
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      cancelTask: vi.fn(),
      triggerTask: vi.fn(),
      getTaskHistory: vi.fn(),
      deleteTasksByPlugin: vi.fn().mockResolvedValue(0),
      registerHandler: vi.fn(),
      unregisterHandler: vi.fn(),
      unregisterPluginHandlers: vi.fn(),
    } as unknown as SchedulerService;

    // 设置全局 SchedulerService
    setSchedulerService(mockSchedulerService);

    scheduler = new SchedulerNamespace('test-plugin');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('setSchedulerService / getSchedulerService', () => {
    it('应该设置和获取全局 SchedulerService', () => {
      const result = getSchedulerService();

      expect(result).toBe(mockSchedulerService);
    });
  });

  describe('create', () => {
    it('应该创建 Cron 定时任务', async () => {
      const mockTask = createMockTask();
      (mockSchedulerService.createTask as any).mockResolvedValue(mockTask);

      const options: CreateTaskOptions = {
        name: 'Daily Sync',
        cron: '0 9 * * *',
        handler: vi.fn(),
      };

      const result = await scheduler.create(options);

      expect(result.id).toBe('task-123');
      expect(result.name).toBe('Test Task');
      expect(result.scheduleType).toBe('cron');
      expect(mockSchedulerService.registerHandler).toHaveBeenCalled();
      expect(mockSchedulerService.createTask).toHaveBeenCalled();
    });

    it('应该创建固定间隔任务', async () => {
      const mockTask = createMockTask({ scheduleType: 'interval', intervalMs: 1800000 });
      (mockSchedulerService.createTask as any).mockResolvedValue(mockTask);

      const options: CreateTaskOptions = {
        name: 'Periodic Check',
        interval: '30m',
        handler: vi.fn(),
        immediate: true,
      };

      const result = await scheduler.create(options);

      expect(result.scheduleType).toBe('interval');
    });

    it('应该创建一次性任务', async () => {
      const runAt = Date.now() + 60000;
      const mockTask = createMockTask({ scheduleType: 'once', runAt });
      (mockSchedulerService.createTask as any).mockResolvedValue(mockTask);

      const options: CreateTaskOptions = {
        name: 'Delayed Task',
        runAt: new Date(runAt),
        handler: vi.fn(),
      };

      const result = await scheduler.create(options);

      expect(result.scheduleType).toBe('once');
    });

    it('应该拒绝多种调度方式同时指定', async () => {
      const options: CreateTaskOptions = {
        name: 'Invalid Task',
        cron: '0 9 * * *',
        interval: '30m', // 同时指定两种
        handler: vi.fn(),
      };

      await expect(scheduler.create(options)).rejects.toThrow('exactly one of');
    });

    it('应该拒绝没有调度方式', async () => {
      const options: CreateTaskOptions = {
        name: 'Invalid Task',
        handler: vi.fn(),
      };

      await expect(scheduler.create(options)).rejects.toThrow('exactly one of');
    });

    it('应该在 SchedulerService 未初始化时抛出错误', async () => {
      setSchedulerService(null as any);
      scheduler = new SchedulerNamespace('test-plugin');

      const options: CreateTaskOptions = {
        name: 'Test',
        cron: '0 9 * * *',
        handler: vi.fn(),
      };

      await expect(scheduler.create(options)).rejects.toThrow('SchedulerService not initialized');
    });
  });

  describe('pause', () => {
    it('应该暂停任务', async () => {
      const mockTask = createMockTask();
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await scheduler.pause('task-123');

      expect(mockSchedulerService.pauseTask).toHaveBeenCalledWith('task-123');
    });

    it('应该拒绝暂停其他插件的任务', async () => {
      const mockTask = createMockTask({ pluginId: 'other-plugin' });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await expect(scheduler.pause('task-123')).rejects.toThrow('another caller');
    });

    it('应该处理任务不存在', async () => {
      (mockSchedulerService.getTask as any).mockResolvedValue(null);

      await expect(scheduler.pause('non-existent')).rejects.toThrow('not found');
    });
  });

  describe('resume', () => {
    it('应该恢复任务', async () => {
      const mockTask = createMockTask();
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await scheduler.resume('task-123');

      expect(mockSchedulerService.resumeTask).toHaveBeenCalledWith('task-123');
    });

    it('应该拒绝恢复其他插件的任务', async () => {
      const mockTask = createMockTask({ pluginId: 'other-plugin' });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await expect(scheduler.resume('task-123')).rejects.toThrow('another caller');
    });
  });

  describe('cancel', () => {
    it('应该取消任务', async () => {
      const mockTask = createMockTask();
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await scheduler.cancel('task-123');

      expect(mockSchedulerService.unregisterHandler).toHaveBeenCalled();
      expect(mockSchedulerService.cancelTask).toHaveBeenCalledWith('task-123');
    });

    it('应该拒绝取消其他插件的任务', async () => {
      const mockTask = createMockTask({ pluginId: 'other-plugin' });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await expect(scheduler.cancel('task-123')).rejects.toThrow('another caller');
    });
  });

  describe('trigger', () => {
    it('应该手动触发任务', async () => {
      const mockTask = createMockTask();
      const mockExecution = createMockExecution();
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);
      (mockSchedulerService.triggerTask as any).mockResolvedValue(mockExecution);

      const result = await scheduler.trigger('task-123');

      expect(result.id).toBe('exec-123');
      expect(result.status).toBe('completed');
      expect(mockSchedulerService.triggerTask).toHaveBeenCalledWith('task-123');
    });

    it('应该拒绝触发其他插件的任务', async () => {
      const mockTask = createMockTask({ pluginId: 'other-plugin' });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await expect(scheduler.trigger('task-123')).rejects.toThrow('another caller');
    });
  });

  describe('list', () => {
    it('应该返回当前插件的所有任务', async () => {
      const mockTasks = [
        createMockTask({ id: 'task-1', name: 'Task 1' }),
        createMockTask({ id: 'task-2', name: 'Task 2' }),
      ];
      (mockSchedulerService.getTasksByPlugin as any).mockResolvedValue(mockTasks);

      const result = await scheduler.list();

      expect(result).toHaveLength(2);
      expect(mockSchedulerService.getTasksByPlugin).toHaveBeenCalledWith('test-plugin');
    });

    it('应该返回空数组当没有任务', async () => {
      (mockSchedulerService.getTasksByPlugin as any).mockResolvedValue([]);

      const result = await scheduler.list();

      expect(result).toEqual([]);
    });
  });

  describe('get', () => {
    it('应该返回任务信息', async () => {
      const mockTask = createMockTask();
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      const result = await scheduler.get('task-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('task-123');
    });

    it('应该返回 null 当任务不存在', async () => {
      (mockSchedulerService.getTask as any).mockResolvedValue(null);

      const result = await scheduler.get('non-existent');

      expect(result).toBeNull();
    });

    it('应该拒绝访问其他插件的任务', async () => {
      const mockTask = createMockTask({ pluginId: 'other-plugin' });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await expect(scheduler.get('task-123')).rejects.toThrow('another caller');
    });
  });

  describe('getHistory', () => {
    it('应该返回执行历史', async () => {
      const mockTask = createMockTask();
      const mockExecutions = [
        createMockExecution({ id: 'exec-1' }),
        createMockExecution({ id: 'exec-2', status: 'failed' }),
      ];
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);
      (mockSchedulerService.getTaskHistory as any).mockResolvedValue(mockExecutions);

      const result = await scheduler.getHistory('task-123', 10);

      expect(result).toHaveLength(2);
      expect(mockSchedulerService.getTaskHistory).toHaveBeenCalledWith('task-123', 10);
    });

    it('应该使用默认限制 20', async () => {
      const mockTask = createMockTask();
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);
      (mockSchedulerService.getTaskHistory as any).mockResolvedValue([]);

      await scheduler.getHistory('task-123');

      expect(mockSchedulerService.getTaskHistory).toHaveBeenCalledWith('task-123', 20);
    });

    it('应该拒绝访问其他插件的任务历史', async () => {
      const mockTask = createMockTask({ pluginId: 'other-plugin' });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      await expect(scheduler.getHistory('task-123')).rejects.toThrow('another caller');
    });
  });

  describe('dispose', () => {
    it('应该清理资源', async () => {
      await scheduler.dispose();

      expect(mockSchedulerService.unregisterPluginHandlers).toHaveBeenCalledWith('test-plugin');
    });

    it('应该在 SchedulerService 未初始化时安全返回', async () => {
      setSchedulerService(null as any);

      await expect(scheduler.dispose()).resolves.not.toThrow();
    });
  });

  describe('TaskInfo 转换', () => {
    it('应该正确转换 Cron 任务', async () => {
      const mockTask = createMockTask({
        scheduleType: 'cron',
        cronExpression: '0 9 * * *',
      });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      const result = await scheduler.get('task-123');

      expect(result!.scheduleDescription).toContain('Cron');
    });

    it('应该正确转换间隔任务', async () => {
      const mockTask = createMockTask({
        scheduleType: 'interval',
        intervalMs: 1800000,
        cronExpression: undefined,
      });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      const result = await scheduler.get('task-123');

      expect(result!.scheduleDescription).toContain('Every');
    });

    it('应该正确转换一次性任务', async () => {
      const runAt = Date.now() + 60000;
      const mockTask = createMockTask({
        scheduleType: 'once',
        runAt,
        cronExpression: undefined,
      });
      (mockSchedulerService.getTask as any).mockResolvedValue(mockTask);

      const result = await scheduler.get('task-123');

      expect(result!.scheduleDescription).toContain('At ');
    });
  });
});
