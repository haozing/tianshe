/**
 * 插件市场状态管理 Store（简化版）
 * 使用 Zustand 管理插件和资源监控的全局状态
 */

import { create } from 'zustand';
import { toast } from '../lib/toast';

// JS插件信息
export interface JSPlugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  icon?: string;
  category?: string;
  installedAt: number;
  path: string;
  // 🆕 是否启用（默认 true）
  enabled?: boolean;
  // 🆕 开发模式相关字段
  devMode?: boolean;
  sourcePath?: string;
  isSymlink?: boolean;
  // 🆕 热重载状态
  hotReloadEnabled?: boolean;
  // 插件来源治理字段
  sourceType?: 'local_private' | 'cloud_managed';
  installChannel?: 'manual_import' | 'cloud_download';
  cloudPluginCode?: string;
  cloudReleaseVersion?: string;
  managedByPolicy?: boolean;
  policyVersion?: string;
  lastPolicySyncAt?: number;
}

// 池状态
export interface PoolStatus {
  size: number;
  maxSize: number;
  available: number;
  isFull: boolean;
  utilizationPercent: number;
}

// 内存使用情况
export interface MemoryUsage {
  estimatedMB: number;
  perViewMB: number;
  activeViews: number;
  maxViews: number;
  utilizationPercent: number;
}

interface PluginStore {
  // ========== 状态 ==========

  // 插件管理
  plugins: JSPlugin[];
  pluginsLoading: boolean;
  searchQuery: string;
  expandedPlugins: Set<string>;

  // 资源监控
  poolStatus: PoolStatus | null;
  memoryUsage: MemoryUsage | null;

  // 错误状态
  error: string | null;

  // ========== 插件操作 ==========

  loadPlugins: () => Promise<void>;
  installPlugin: (devMode?: boolean) => Promise<void>;
  uninstallPlugin: (pluginId: string, pluginName: string, deleteTables?: boolean) => Promise<void>;
  enablePlugin: (pluginId: string, pluginName: string) => Promise<void>; // 🆕 启用插件
  disablePlugin: (pluginId: string, pluginName: string) => Promise<void>; // 🆕 禁用插件
  reloadPlugin: (pluginId: string, pluginName: string) => Promise<void>; // 🆕 重载插件
  repairPlugin: (pluginId: string, pluginName: string) => Promise<void>; // 🆕 修复插件
  openPluginDirectory: (path: string) => Promise<void>; // 🆕 打开插件目录
  toggleHotReload: (pluginId: string, pluginName: string) => Promise<void>; // 🆕 切换热重载
  setSearchQuery: (query: string) => void;
  togglePluginExpanded: (pluginId: string) => void;

  // ========== 资源监控 ==========

  updatePoolStatus: () => Promise<void>;
  updateMemoryUsage: () => Promise<void>;
  startResourceMonitoring: () => void;
  stopResourceMonitoring: () => void;

  // ========== 工具方法 ==========

  clearError: () => void;
  reset: () => void;
}

// 资源监控定时器
let resourceMonitorInterval: NodeJS.Timeout | null = null;

export const usePluginStore = create<PluginStore>((set, get) => ({
  // ========== 初始状态 ==========

  plugins: [],
  pluginsLoading: false,
  searchQuery: '',
  expandedPlugins: new Set<string>(),

  poolStatus: null,
  memoryUsage: null,

  error: null,

  // ========== 插件操作实现 ==========

  loadPlugins: async () => {
    set({ pluginsLoading: true, error: null });

    try {
      const result = await window.electronAPI.jsPlugin.list();

      if (result.success && result.plugins) {
        // ✅ 热重载状态已经包含在 list() API 返回的数据中，无需额外请求
        set({
          plugins: result.plugins,
          pluginsLoading: false,
        });
      } else {
        throw new Error(result.error || 'Failed to load plugins');
      }
    } catch (error: any) {
      set({
        pluginsLoading: false,
        error: `加载插件列表失败：${error.message}`,
      });
    }
  },

  installPlugin: async (devMode?: boolean) => {
    set({ error: null });

    try {
      // 🆕 获取应用信息，判断是否打包
      const appInfoResult: any = await window.electronAPI.getAppInfo();
      const shouldShowDevOptions = appInfoResult?.info?.shouldShowDevOptions ?? false;

      // 🆕 如果不是开发环境，强制使用生产模式
      const finalDevMode = shouldShowDevOptions ? (devMode ?? false) : false;

      // jsPlugin.import() 会自动打开文件选择对话框
      const result = await window.electronAPI.jsPlugin.import(undefined, {
        devMode: finalDevMode,
      });

      if (result.success && result.pluginId) {
        const isUpdated = result.operation === 'updated';
        let message = `${isUpdated ? '插件更新成功' : '插件安装成功'}: ${result.pluginId}`;
        if (result.warnings && result.warnings.length > 0) {
          message += '\n\n警告：\n' + result.warnings.join('\n');
        }
        if (finalDevMode) {
          message += '\n\n已启用开发模式，修改源文件后点击重载按钮即可生效。';
        }
        toast.success(message);
        await get().loadPlugins();
      } else if (result.error) {
        throw new Error(result.error);
      }
      // 如果用户取消选择，不显示任何消息
    } catch (error: any) {
      const errorMsg = `插件安装失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
    }
  },

  uninstallPlugin: async (pluginId: string, pluginName: string, deleteTables: boolean = false) => {
    set({ error: null });

    try {
      const result = await window.electronAPI.jsPlugin.uninstall(pluginId, deleteTables);

      if (result.success) {
        toast.success('插件已卸载', `${pluginName}${deleteTables ? '（包括数据表）' : ''}`);
        await get().loadPlugins();
      } else {
        throw new Error(result.error || 'Failed to uninstall plugin');
      }
    } catch (error: any) {
      const errorMsg = `卸载失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
      throw error; // 重新抛出错误，让调用方知道失败了
    }
  },

  // 🆕 启用插件
  enablePlugin: async (pluginId: string, pluginName: string) => {
    set({ error: null });

    try {
      const result = await window.electronAPI.jsPlugin.enable(pluginId);

      if (result.success) {
        // 重新加载插件列表以获取最新状态
        await get().loadPlugins();
        toast.success(`插件已启用: ${pluginName}`);
      } else {
        throw new Error(result.error || 'Failed to enable plugin');
      }
    } catch (error: any) {
      const errorMsg = `启用失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
    }
  },

  // 🆕 禁用插件
  disablePlugin: async (pluginId: string, pluginName: string) => {
    set({ error: null });

    try {
      const result = await window.electronAPI.jsPlugin.disable(pluginId);

      if (result.success) {
        // 重新加载插件列表以获取最新状态
        await get().loadPlugins();
        toast.info(`插件已禁用: ${pluginName}\n\n插件不会在 Activity Bar 中显示。`);
      } else {
        throw new Error(result.error || 'Failed to disable plugin');
      }
    } catch (error: any) {
      const errorMsg = `禁用失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
    }
  },

  // 🆕 重载插件
  reloadPlugin: async (pluginId: string, pluginName: string) => {
    set({ error: null });

    try {
      const result = await window.electronAPI.jsPlugin.reload(pluginId);

      if (result.success) {
        toast.success(`插件已重载: ${pluginName}\n\n最新代码已生效。`);
        await get().loadPlugins();
      } else {
        throw new Error(result.error || 'Failed to reload plugin');
      }
    } catch (error: any) {
      const errorMsg = `重载失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
    }
  },

  // 🆕 修复插件
  repairPlugin: async (pluginId: string, pluginName: string) => {
    set({ error: null });

    try {
      const result = await window.electronAPI.jsPlugin.repairPlugin(pluginId);

      if (result.success && result.result) {
        if (result.result.success) {
          toast.success('修复成功', `${pluginName}\n\n${result.result.message}`);
          await get().loadPlugins();
        } else {
          toast.error('修复失败', result.result.message);
        }
      } else {
        throw new Error('Failed to repair plugin');
      }
    } catch (error: any) {
      const errorMsg = `修复失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
    }
  },

  // 🆕 打开插件目录
  openPluginDirectory: async (path: string) => {
    set({ error: null });

    try {
      const errorMsg = await window.electronAPI.shell.openPath(path);

      if (errorMsg) {
        throw new Error(errorMsg);
      }
    } catch (error: any) {
      const errorMsg = `打开目录失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
    }
  },

  // 🆕 切换热重载
  toggleHotReload: async (pluginId: string, pluginName: string) => {
    set({ error: null });

    try {
      // 获取当前状态
      const plugin = get().plugins.find((p) => p.id === pluginId);
      const currentlyEnabled = plugin?.hotReloadEnabled ?? false;

      let result;
      if (currentlyEnabled) {
        // 禁用热重载
        result = await window.electronAPI.jsPlugin.disableHotReload(pluginId);
        if (result.success) {
          toast.info(`热重载已禁用: ${pluginName}\n\n修改源文件后需要手动点击重载按钮。`);
        }
      } else {
        // 启用热重载
        result = await window.electronAPI.jsPlugin.enableHotReload(pluginId);
        if (result.success) {
          toast.success(
            `热重载已启用: ${pluginName}\n\n现在修改源文件后会自动重新加载插件。\n防抖延迟：1秒`
          );
        }
      }

      if (!result.success) {
        throw new Error(result.message || result.error || 'Operation failed');
      }

      // 重新加载插件列表以获取最新状态
      await get().loadPlugins();
    } catch (error: any) {
      const errorMsg = `热重载操作失败: ${error.message}`;
      set({ error: errorMsg });
      toast.error('操作失败', errorMsg);
    }
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  togglePluginExpanded: (pluginId: string) => {
    set((state) => {
      const newSet = new Set(state.expandedPlugins);
      if (newSet.has(pluginId)) {
        newSet.delete(pluginId);
      } else {
        newSet.add(pluginId);
      }
      return { expandedPlugins: newSet };
    });
  },

  // ========== 资源监控实现 ==========

  updatePoolStatus: async () => {
    try {
      const result = await window.electronAPI.view.getDetailedPoolStatus();

      if (result.success && result.status) {
        set({ poolStatus: result.status });
      }
    } catch (error) {
      console.error('[PluginStore] Failed to update pool status:', error);
    }
  },

  updateMemoryUsage: async () => {
    try {
      const result = await window.electronAPI.view.getMemoryUsage();

      if (result.success && result.usage) {
        set({ memoryUsage: result.usage });
      }
    } catch (error) {
      console.error('[PluginStore] Failed to update memory usage:', error);
    }
  },

  startResourceMonitoring: () => {
    // 如果已经在监控，先停止
    if (resourceMonitorInterval) {
      clearInterval(resourceMonitorInterval);
    }

    // 立即更新一次
    get().updatePoolStatus();
    get().updateMemoryUsage();

    // 每3秒更新一次
    resourceMonitorInterval = setInterval(() => {
      get().updatePoolStatus();
      get().updateMemoryUsage();
    }, 3000);
  },

  stopResourceMonitoring: () => {
    if (resourceMonitorInterval) {
      clearInterval(resourceMonitorInterval);
      resourceMonitorInterval = null;
    }
  },

  // ========== 工具方法 ==========

  clearError: () => {
    set({ error: null });
  },

  reset: () => {
    // 停止资源监控
    get().stopResourceMonitoring();

    // 重置所有状态
    set({
      plugins: [],
      pluginsLoading: false,
      searchQuery: '',
      expandedPlugins: new Set<string>(),
      poolStatus: null,
      memoryUsage: null,
      error: null,
    });
  },
}));

// 导出便捷的 selector hooks
export const usePlugins = () => usePluginStore((state) => state.plugins);
export const usePoolStatus = () => usePluginStore((state) => state.poolStatus);
export const useMemoryUsage = () => usePluginStore((state) => state.memoryUsage);
