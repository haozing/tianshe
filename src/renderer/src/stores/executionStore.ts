/**
 * 执行状态管理 Store
 * 使用 Zustand 管理持久化执行的全局状态
 */

import { create } from 'zustand';

interface ExecutionInfo {
  executionId: string;
  pluginId: string;
  pluginName: string;
  startedAt: number;
}

interface ExecutionStore {
  // 状态
  activeExecutions: Map<string, ExecutionInfo>;
  loading: boolean;
  error: string | null;

  // 查询
  isExecuting: (pluginId: string) => boolean;
  getActiveExecutions: () => ExecutionInfo[];
  getExecutionByPlugin: (pluginId: string) => ExecutionInfo | null;

  // 操作
  startExecution: (executionId: string, pluginId: string, pluginName: string) => void;
  stopExecution: (executionId: string) => Promise<boolean>;
  stopAll: () => Promise<void>;

  // 同步
  syncActiveExecutions: () => Promise<void>;

  // UI 状态
  clearError: () => void;
}

export const useExecutionStore = create<ExecutionStore>((set, get) => ({
  // 初始状态
  activeExecutions: new Map(),
  loading: false,
  error: null,

  // 检查插件是否正在执行
  isExecuting: (pluginId: string) => {
    const executions = Array.from(get().activeExecutions.values());
    return executions.some((exec) => exec.pluginId === pluginId);
  },

  // 获取所有活跃执行
  getActiveExecutions: () => {
    return Array.from(get().activeExecutions.values());
  },

  // 根据插件 ID 获取执行信息
  getExecutionByPlugin: (pluginId: string) => {
    const executions = Array.from(get().activeExecutions.values());
    return executions.find((exec) => exec.pluginId === pluginId) || null;
  },

  // 开始执行（本地记录）
  startExecution: (executionId: string, pluginId: string, pluginName: string) => {
    set((state) => {
      const newMap = new Map(state.activeExecutions);
      newMap.set(executionId, {
        executionId,
        pluginId,
        pluginName,
        startedAt: Date.now(),
      });
      return { activeExecutions: newMap };
    });
  },

  // 停止执行
  stopExecution: async (executionId: string) => {
    set({ loading: true, error: null });
    try {
      const response = await window.electronAPI.execution.stop(executionId);
      if (response.success) {
        set((state) => {
          const newMap = new Map(state.activeExecutions);
          newMap.delete(executionId);
          return { activeExecutions: newMap, loading: false };
        });
        return true;
      } else {
        set({ error: response.error || 'Failed to stop execution', loading: false });
        return false;
      }
    } catch (error: any) {
      set({ error: error.message, loading: false });
      return false;
    }
  },

  // 停止所有执行
  stopAll: async () => {
    set({ loading: true, error: null });
    try {
      const executionIds = Array.from(get().activeExecutions.keys());
      const results = await Promise.allSettled(
        executionIds.map((id) => window.electronAPI.execution.stop(id))
      );

      // 统计失败的执行
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        console.error('[ExecutionStore] Some executions failed to stop:', failures);
      }

      // 清空活跃执行列表
      set({ activeExecutions: new Map(), loading: false });
    } catch (error: any) {
      set({ error: error.message, loading: false });
    }
  },

  // 同步活跃执行列表（从主进程获取）
  syncActiveExecutions: async () => {
    try {
      const response = await window.electronAPI.execution.getActive();
      if (response.success && response.executions) {
        const newMap = new Map();
        for (const exec of response.executions) {
          newMap.set(exec.id, {
            executionId: exec.id,
            pluginId: exec.workflowId, // 🔧 使用 workflowId 作为 pluginId
            pluginName: exec.workflow,
            startedAt: exec.startedAt,
          });
        }
        set({ activeExecutions: newMap });
      }
    } catch (error: any) {
      console.error('[ExecutionStore] Failed to sync active executions:', error);
    }
  },

  // 清除错误
  clearError: () => {
    set({ error: null });
  },
}));
