/**
 * SchedulerIPCHandler 单元测试
 * 测试定时任务调度相关的 IPC 处理器
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { SchedulerIPCHandler } from './scheduler-handler';
import type { IpcMainInvokeEvent } from 'electron';

// Mock electron 的 ipcMain
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock handleIPCError
vi.mock('../ipc-utils', () => ({
  handleIPCError: vi.fn((error: unknown) => {
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: 'Unknown error occurred' };
  }),
}));

import { ipcMain } from 'electron';
import { handleIPCError } from '../ipc-utils';

describe('SchedulerIPCHandler', () => {
  let handler: SchedulerIPCHandler;
  let mockSchedulerService: any;
  let registeredHandlers: Map<string, Function>;

  beforeEach(() => {
    // 清除所有模拟
    vi.clearAllMocks();

    // 创建 registeredHandlers 存储
    registeredHandlers = new Map();

    // Mock ipcMain.handle 以捕获注册的处理器
    (ipcMain.handle as Mock).mockImplementation((channel: string, fn: Function) => {
      registeredHandlers.set(channel, fn);
    });

    // 创建 mock schedulerService
    mockSchedulerService = {
      getAllTasks: vi.fn(),
      getTasksByPlugin: vi.fn(),
      getTask: vi.fn(),
      getTaskHistory: vi.fn(),
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      triggerTask: vi.fn(),
      cancelTask: vi.fn(),
      getStats: vi.fn(),
      getRecentExecutions: vi.fn(),
    };

    // 创建处理器实例
    handler = new SchedulerIPCHandler(mockSchedulerService);
  });

  afterEach(() => {
    registeredHandlers.clear();
  });

  describe('register', () => {
    it('应该注册所有 IPC 处理器', () => {
      // 执行注册
      handler.register();

      // 验证所有处理器都已注册
      expect(ipcMain.handle).toHaveBeenCalledTimes(10);

      // 验证任务查询处理器
      expect(registeredHandlers.has('scheduler:get-all-tasks')).toBe(true);
      expect(registeredHandlers.has('scheduler:get-tasks-by-plugin')).toBe(true);
      expect(registeredHandlers.has('scheduler:get-task')).toBe(true);
      expect(registeredHandlers.has('scheduler:get-task-history')).toBe(true);

      // 验证任务管理处理器
      expect(registeredHandlers.has('scheduler:pause-task')).toBe(true);
      expect(registeredHandlers.has('scheduler:resume-task')).toBe(true);
      expect(registeredHandlers.has('scheduler:trigger-task')).toBe(true);
      expect(registeredHandlers.has('scheduler:cancel-task')).toBe(true);

      // 验证统计信息处理器
      expect(registeredHandlers.has('scheduler:get-stats')).toBe(true);
      expect(registeredHandlers.has('scheduler:get-recent-executions')).toBe(true);
    });
  });

  describe('scheduler:get-all-tasks', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功获取所有定时任务', async () => {
      // 准备测试数据
      const mockTasks = [
        { id: 'task1', name: 'Task 1', cron: '0 0 * * *' },
        { id: 'task2', name: 'Task 2', cron: '0 12 * * *' },
      ];
      mockSchedulerService.getAllTasks.mockResolvedValue({
        tasks: mockTasks,
        total: 2,
      });

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-all-tasks')!;
      const result = await handlerFn({} as IpcMainInvokeEvent);

      // 验证结果
      expect(result).toEqual({
        success: true,
        tasks: mockTasks,
        total: 2,
      });
      expect(mockSchedulerService.getAllTasks).toHaveBeenCalledTimes(1);
    });

    it('应该处理获取任务失败的情况', async () => {
      // 模拟错误
      const error = new Error('Database connection failed');
      mockSchedulerService.getAllTasks.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-all-tasks')!;
      const result = await handlerFn({} as IpcMainInvokeEvent);

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Database connection failed',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:get-tasks-by-plugin', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功获取指定插件的任务', async () => {
      // 准备测试数据
      const pluginId = 'test-plugin';
      const mockTasks = [
        { id: 'task1', pluginId, name: 'Task 1' },
        { id: 'task2', pluginId, name: 'Task 2' },
      ];
      mockSchedulerService.getTasksByPlugin.mockResolvedValue(mockTasks);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-tasks-by-plugin')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, pluginId);

      // 验证结果
      expect(result).toEqual({
        success: true,
        tasks: mockTasks,
      });
      expect(mockSchedulerService.getTasksByPlugin).toHaveBeenCalledWith(pluginId);
    });

    it('应该处理插件任务获取失败的情况', async () => {
      // 模拟错误
      const error = new Error('Plugin not found');
      mockSchedulerService.getTasksByPlugin.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-tasks-by-plugin')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'invalid-plugin');

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Plugin not found',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:get-task', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功获取单个任务详情', async () => {
      // 准备测试数据
      const taskId = 'task-123';
      const mockTask = {
        id: taskId,
        name: 'Test Task',
        cron: '0 0 * * *',
        status: 'active',
      };
      mockSchedulerService.getTask.mockResolvedValue(mockTask);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, taskId);

      // 验证结果
      expect(result).toEqual({
        success: true,
        task: mockTask,
      });
      expect(mockSchedulerService.getTask).toHaveBeenCalledWith(taskId);
    });

    it('应该处理任务不存在的情况', async () => {
      // 模拟错误
      const error = new Error('Task not found');
      mockSchedulerService.getTask.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'non-existent');

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Task not found',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:get-task-history', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功获取任务执行历史（带限制）', async () => {
      // 准备测试数据
      const taskId = 'task-123';
      const limit = 10;
      const mockExecutions = [
        { id: 'exec1', taskId, status: 'success', timestamp: Date.now() },
        { id: 'exec2', taskId, status: 'failed', timestamp: Date.now() - 1000 },
      ];
      mockSchedulerService.getTaskHistory.mockResolvedValue(mockExecutions);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task-history')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, taskId, limit);

      // 验证结果
      expect(result).toEqual({
        success: true,
        executions: mockExecutions,
      });
      expect(mockSchedulerService.getTaskHistory).toHaveBeenCalledWith(taskId, limit);
    });

    it('应该成功获取任务执行历史（不带限制）', async () => {
      // 准备测试数据
      const taskId = 'task-123';
      const mockExecutions = [{ id: 'exec1', taskId, status: 'success', timestamp: Date.now() }];
      mockSchedulerService.getTaskHistory.mockResolvedValue(mockExecutions);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task-history')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, taskId);

      // 验证结果
      expect(result).toEqual({
        success: true,
        executions: mockExecutions,
      });
      expect(mockSchedulerService.getTaskHistory).toHaveBeenCalledWith(taskId, undefined);
    });

    it('应该处理获取历史失败的情况', async () => {
      // 模拟错误
      const error = new Error('History not available');
      mockSchedulerService.getTaskHistory.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task-history')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'task-123', 10);

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'History not available',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:pause-task', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功暂停任务', async () => {
      // 准备测试数据
      const taskId = 'task-123';
      mockSchedulerService.pauseTask.mockResolvedValue(undefined);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:pause-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, taskId);

      // 验证结果
      expect(result).toEqual({ success: true });
      expect(mockSchedulerService.pauseTask).toHaveBeenCalledWith(taskId);
    });

    it('应该处理暂停任务失败的情况', async () => {
      // 模拟错误
      const error = new Error('Task already paused');
      mockSchedulerService.pauseTask.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:pause-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'task-123');

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Task already paused',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:resume-task', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功恢复任务', async () => {
      // 准备测试数据
      const taskId = 'task-123';
      mockSchedulerService.resumeTask.mockResolvedValue(undefined);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:resume-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, taskId);

      // 验证结果
      expect(result).toEqual({ success: true });
      expect(mockSchedulerService.resumeTask).toHaveBeenCalledWith(taskId);
    });

    it('应该处理恢复任务失败的情况', async () => {
      // 模拟错误
      const error = new Error('Task already running');
      mockSchedulerService.resumeTask.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:resume-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'task-123');

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Task already running',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:trigger-task', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功手动触发任务执行', async () => {
      // 准备测试数据
      const taskId = 'task-123';
      const mockExecution = {
        id: 'exec-456',
        taskId,
        status: 'running',
        startTime: Date.now(),
      };
      mockSchedulerService.triggerTask.mockResolvedValue(mockExecution);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:trigger-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, taskId);

      // 验证结果
      expect(result).toEqual({
        success: true,
        execution: mockExecution,
      });
      expect(mockSchedulerService.triggerTask).toHaveBeenCalledWith(taskId);
    });

    it('应该处理触发任务失败的情况', async () => {
      // 模拟错误
      const error = new Error('Task is paused');
      mockSchedulerService.triggerTask.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:trigger-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'task-123');

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Task is paused',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:cancel-task', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功取消/删除任务', async () => {
      // 准备测试数据
      const taskId = 'task-123';
      mockSchedulerService.cancelTask.mockResolvedValue(undefined);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:cancel-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, taskId);

      // 验证结果
      expect(result).toEqual({ success: true });
      expect(mockSchedulerService.cancelTask).toHaveBeenCalledWith(taskId);
    });

    it('应该处理取消任务失败的情况', async () => {
      // 模拟错误
      const error = new Error('Task not found');
      mockSchedulerService.cancelTask.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:cancel-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'task-123');

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Task not found',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:get-stats', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功获取调度器统计信息', async () => {
      // 准备测试数据
      const mockStats = {
        totalTasks: 10,
        activeTasks: 7,
        pausedTasks: 3,
        totalExecutions: 1000,
        successfulExecutions: 950,
        failedExecutions: 50,
      };
      mockSchedulerService.getStats.mockResolvedValue(mockStats);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-stats')!;
      const result = await handlerFn({} as IpcMainInvokeEvent);

      // 验证结果
      expect(result).toEqual({
        success: true,
        stats: mockStats,
      });
      expect(mockSchedulerService.getStats).toHaveBeenCalledTimes(1);
    });

    it('应该处理获取统计信息失败的情况', async () => {
      // 模拟错误
      const error = new Error('Stats service unavailable');
      mockSchedulerService.getStats.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-stats')!;
      const result = await handlerFn({} as IpcMainInvokeEvent);

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Stats service unavailable',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('scheduler:get-recent-executions', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该成功获取最近的执行记录（带限制）', async () => {
      // 准备测试数据
      const limit = 20;
      const mockExecutions = [
        { id: 'exec1', taskId: 'task1', status: 'success', timestamp: Date.now() },
        { id: 'exec2', taskId: 'task2', status: 'failed', timestamp: Date.now() - 1000 },
      ];
      mockSchedulerService.getRecentExecutions.mockResolvedValue(mockExecutions);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-recent-executions')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, limit);

      // 验证结果
      expect(result).toEqual({
        success: true,
        executions: mockExecutions,
      });
      expect(mockSchedulerService.getRecentExecutions).toHaveBeenCalledWith(limit);
    });

    it('应该成功获取最近的执行记录（不带限制）', async () => {
      // 准备测试数据
      const mockExecutions = [
        { id: 'exec1', taskId: 'task1', status: 'success', timestamp: Date.now() },
      ];
      mockSchedulerService.getRecentExecutions.mockResolvedValue(mockExecutions);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-recent-executions')!;
      const result = await handlerFn({} as IpcMainInvokeEvent);

      // 验证结果
      expect(result).toEqual({
        success: true,
        executions: mockExecutions,
      });
      expect(mockSchedulerService.getRecentExecutions).toHaveBeenCalledWith(undefined);
    });

    it('应该处理获取执行记录失败的情况', async () => {
      // 模拟错误
      const error = new Error('Execution history not available');
      mockSchedulerService.getRecentExecutions.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-recent-executions')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 10);

      // 验证错误处理
      expect(result).toEqual({
        success: false,
        error: 'Execution history not available',
      });
      expect(handleIPCError).toHaveBeenCalledWith(error);
    });
  });

  describe('边界情况和错误处理', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该处理空字符串任务 ID', async () => {
      // 模拟错误
      const error = new Error('Invalid task ID');
      mockSchedulerService.getTask.mockRejectedValue(error);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, '');

      // 验证错误处理
      expect(result.success).toBe(false);
      expect(handleIPCError).toHaveBeenCalled();
    });

    it('应该处理负数限制值', async () => {
      // 准备测试数据 - service 应该处理负数
      const mockExecutions: any[] = [];
      mockSchedulerService.getRecentExecutions.mockResolvedValue(mockExecutions);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-recent-executions')!;
      await handlerFn({} as IpcMainInvokeEvent, -1);

      // 验证 service 被调用（具体验证由 service 层处理）
      expect(mockSchedulerService.getRecentExecutions).toHaveBeenCalledWith(-1);
    });

    it('应该处理非错误对象的异常', async () => {
      // 模拟非标准错误
      mockSchedulerService.getAllTasks.mockRejectedValue('String error');

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-all-tasks')!;
      const result = await handlerFn({} as IpcMainInvokeEvent);

      // 验证错误处理
      expect(result.success).toBe(false);
      expect(handleIPCError).toHaveBeenCalledWith('String error');
    });

    it('应该处理 null 或 undefined 返回值', async () => {
      // 模拟空返回
      mockSchedulerService.getTask.mockResolvedValue(null);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, 'task-123');

      // 验证结果
      expect(result).toEqual({
        success: true,
        task: null,
      });
    });

    it('应该处理并发调用相同处理器', async () => {
      // 准备测试数据
      mockSchedulerService.getAllTasks.mockResolvedValue({
        tasks: [],
        total: 0,
      });

      // 获取处理器
      const handlerFn = registeredHandlers.get('scheduler:get-all-tasks')!;

      // 并发执行
      const results = await Promise.all([
        handlerFn({} as IpcMainInvokeEvent),
        handlerFn({} as IpcMainInvokeEvent),
        handlerFn({} as IpcMainInvokeEvent),
      ]);

      // 验证所有调用都成功
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.success).toBe(true);
      });
      expect(mockSchedulerService.getAllTasks).toHaveBeenCalledTimes(3);
    });
  });

  describe('类型安全性', () => {
    beforeEach(() => {
      handler.register();
    });

    it('应该正确处理 TypeScript 类型（任务查询）', async () => {
      // 准备强类型测试数据
      const mockTask: {
        id: string;
        name: string;
        cron: string;
        pluginId: string;
        status: 'active' | 'paused';
      } = {
        id: 'task-123',
        name: 'Test Task',
        cron: '0 0 * * *',
        pluginId: 'plugin-1',
        status: 'active',
      };

      mockSchedulerService.getTask.mockResolvedValue(mockTask);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:get-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, mockTask.id);

      // 验证类型安全的结果
      expect(result).toEqual({
        success: true,
        task: mockTask,
      });
    });

    it('应该正确处理 TypeScript 类型（执行记录）', async () => {
      // 准备强类型测试数据
      const mockExecution: {
        id: string;
        taskId: string;
        status: 'success' | 'failed' | 'running';
        timestamp: number;
      } = {
        id: 'exec-456',
        taskId: 'task-123',
        status: 'running',
        timestamp: Date.now(),
      };

      mockSchedulerService.triggerTask.mockResolvedValue(mockExecution);

      // 获取处理器并执行
      const handlerFn = registeredHandlers.get('scheduler:trigger-task')!;
      const result = await handlerFn({} as IpcMainInvokeEvent, mockExecution.taskId);

      // 验证类型安全的结果
      expect(result).toEqual({
        success: true,
        execution: mockExecution,
      });
    });
  });
});
