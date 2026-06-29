/**
 * Scheduler Store - 定时任务状态管理
 */

import { create } from 'zustand';
import { createRendererLogger } from '../lib/logger';
import type { ScheduledTask, TaskExecution, TaskStats } from '../../../types/scheduler';

const logger = createRendererLogger('SchedulerStore');

// 重新导出类型供组件使用
export type { ScheduledTask, TaskExecution, TaskStats };

// 兼容旧名称
export type SchedulerStats = TaskStats;

interface SchedulerStore {
  // 状态
  tasks: ScheduledTask[];
  stats: SchedulerStats | null;
  recentExecutions: TaskExecution[];
  isLoading: boolean;
  error: string | null;

  // 操作
  fetchTasks: () => Promise<void>;
  fetchStats: () => Promise<void>;
  fetchRecentExecutions: (limit?: number) => Promise<void>;
  pauseTask: (taskId: string) => Promise<void>;
  resumeTask: (taskId: string) => Promise<void>;
  triggerTask: (taskId: string) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  getTaskHistory: (taskId: string, limit?: number) => Promise<TaskExecution[]>;
  refresh: () => Promise<void>;
}

export const useSchedulerStore = create<SchedulerStore>((set, get) => ({
  // 初始状态
  tasks: [],
  stats: null,
  recentExecutions: [],
  isLoading: false,
  error: null,

  // 获取所有任务
  fetchTasks: async () => {
    set({ isLoading: true, error: null });
    try {
      const result = await window.electronAPI.scheduler.getAllTasks();
      if (result.success && result.tasks) {
        set({ tasks: result.tasks });
      } else {
        set({ error: result.error || '获取任务列表失败' });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '获取任务列表失败' });
    } finally {
      set({ isLoading: false });
    }
  },

  // 获取统计信息
  fetchStats: async () => {
    try {
      const result = await window.electronAPI.scheduler.getStats();
      if (result.success && result.stats) {
        set({ stats: result.stats });
      }
    } catch (error) {
      logger.error('Failed to fetch scheduler stats', {
        operation: 'scheduler.stats.fetch',
        error,
      });
    }
  },

  // 获取最近执行记录
  fetchRecentExecutions: async (limit = 20) => {
    try {
      const result = await window.electronAPI.scheduler.getRecentExecutions(limit);
      if (result.success && result.executions) {
        set({ recentExecutions: result.executions });
      }
    } catch (error) {
      logger.error('Failed to fetch recent scheduler executions', {
        operation: 'scheduler.executions.fetchRecent',
        limit,
        error,
      });
    }
  },

  // 暂停任务
  pauseTask: async (taskId: string) => {
    const result = await window.electronAPI.scheduler.pauseTask(taskId);
    if (result.success) {
      await get().refresh();
    } else {
      throw new Error(result.error || '暂停任务失败');
    }
  },

  // 恢复任务
  resumeTask: async (taskId: string) => {
    const result = await window.electronAPI.scheduler.resumeTask(taskId);
    if (result.success) {
      await get().refresh();
    } else {
      throw new Error(result.error || '恢复任务失败');
    }
  },

  // 手动触发任务
  triggerTask: async (taskId: string) => {
    const result = await window.electronAPI.scheduler.triggerTask(taskId);
    if (result.success) {
      await get().refresh();
    } else {
      throw new Error(result.error || '触发任务失败');
    }
  },

  // 取消任务
  cancelTask: async (taskId: string) => {
    const result = await window.electronAPI.scheduler.cancelTask(taskId);
    if (result.success) {
      await get().refresh();
    } else {
      throw new Error(result.error || '取消任务失败');
    }
  },

  // 获取任务执行历史
  getTaskHistory: async (taskId: string, limit = 20) => {
    try {
      const result = await window.electronAPI.scheduler.getTaskHistory(taskId, limit);
      if (result.success && result.executions) {
        return result.executions;
      }
      return [];
    } catch (error) {
      logger.error('Failed to fetch scheduler task history', {
        operation: 'scheduler.taskHistory.fetch',
        taskId,
        limit,
        error,
      });
      return [];
    }
  },

  // 刷新所有数据
  refresh: async () => {
    await Promise.all([get().fetchTasks(), get().fetchStats(), get().fetchRecentExecutions()]);
  },
}));
