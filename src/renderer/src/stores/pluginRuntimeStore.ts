import { create } from 'zustand';
import { toast } from '../lib/toast';
import type {
  JSPluginRuntimeStatus,
  JSPluginRuntimeStatusChangeEvent,
} from '../../../types/js-plugin';

interface PluginRuntimeStore {
  statuses: Record<string, JSPluginRuntimeStatus>;
  loading: boolean;
  error: string | null;
  loadStatuses: () => Promise<void>;
  cancelPluginTasks: (pluginId: string, pluginName?: string) => Promise<void>;
  subscribe: () => () => void;
  reset: () => void;
}

let runtimeStatusUnsubscribe: (() => void) | null = null;

function applyRuntimeStatusChange(
  current: Record<string, JSPluginRuntimeStatus>,
  event: JSPluginRuntimeStatusChangeEvent
): Record<string, JSPluginRuntimeStatus> {
  const next = { ...current };
  if (event.removed || !event.status) {
    delete next[event.pluginId];
    return next;
  }

  next[event.pluginId] = event.status;
  return next;
}

export const usePluginRuntimeStore = create<PluginRuntimeStore>((set, get) => ({
  statuses: {},
  loading: false,
  error: null,

  loadStatuses: async () => {
    set({ loading: true, error: null });

    try {
      const result = await window.electronAPI.jsPlugin.listRuntimeStatuses();
      if (!result.success || !Array.isArray(result.statuses)) {
        throw new Error(result.error || 'Failed to load plugin runtime statuses');
      }

      const statuses = result.statuses.reduce<Record<string, JSPluginRuntimeStatus>>((acc, status) => {
        if (status?.pluginId) {
          acc[status.pluginId] = status;
        }
        return acc;
      }, {});

      set({
        statuses,
        loading: false,
      });
    } catch (error: any) {
      set({
        loading: false,
        error: `加载插件运行状态失败：${error.message}`,
      });
    }
  },

  cancelPluginTasks: async (pluginId: string, pluginName?: string) => {
    try {
      const result = await window.electronAPI.jsPlugin.cancelPluginTasks(pluginId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to cancel plugin tasks');
      }

      const pluginLabel = pluginName || pluginId;
      const cancelledCount = Number(result.cancelled || 0);
      if (cancelledCount > 0) {
        toast.success('已停止插件任务', `${pluginLabel}：已取消 ${cancelledCount} 个任务`);
      } else {
        toast.info('当前没有可停止的任务', pluginLabel);
      }

      await get().loadStatuses();
    } catch (error: any) {
      const message = `停止任务失败：${error.message}`;
      set({ error: message });
      toast.error('停止插件任务失败', error.message);
    }
  },

  subscribe: () => {
    if (runtimeStatusUnsubscribe) {
      return runtimeStatusUnsubscribe;
    }

    runtimeStatusUnsubscribe = window.electronAPI.jsPlugin.onPluginRuntimeStatusChanged((event) => {
      set((state) => ({
        statuses: applyRuntimeStatusChange(state.statuses, event),
      }));
    });

    return () => {
      runtimeStatusUnsubscribe?.();
      runtimeStatusUnsubscribe = null;
    };
  },

  reset: () => {
    runtimeStatusUnsubscribe?.();
    runtimeStatusUnsubscribe = null;
    set({
      statuses: {},
      loading: false,
      error: null,
    });
  },
}));

export const usePluginRuntimeStatuses = () => usePluginRuntimeStore((state) => state.statuses);
