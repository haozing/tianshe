/**
 * 自定义页面 Hook
 * 用于获取和管理插件的自定义页面
 */

import { useState, useEffect, useCallback } from 'react';
import { pluginFacade } from '../services/datasets/pluginFacade';
import type { CustomPageInfo } from '../../../types/js-plugin';

/**
 * 插件页面分组数据结构
 */
export interface PluginPagesGroup {
  pluginId: string;
  pluginName: string;
  pluginIcon: string;
  pages: CustomPageInfo[];
}

/**
 * 获取所有插件的自定义页面（针对特定数据集）
 */
export function useCustomPages(datasetId: string | null) {
  const [customPages, setCustomPages] = useState<CustomPageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCustomPages = useCallback(async () => {
    if (!datasetId) {
      setCustomPages([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 获取所有已激活插件
      const pluginsResult = await pluginFacade.listPlugins();
      if (!pluginsResult.success || !pluginsResult.plugins) {
        setError('Failed to load plugins');
        setCustomPages([]);
        return;
      }

      const allPages: CustomPageInfo[] = [];

      // 遍历所有插件，获取自定义页面
      for (const plugin of pluginsResult.plugins) {
        try {
          const pagesResult = await pluginFacade.getCustomPages(plugin.id, datasetId);

          if (pagesResult.success && pagesResult.pages) {
            // 过滤出embedded模式的页面
            const embeddedPages = pagesResult.pages.filter(
              (page: any) => page.display_mode === 'embedded'
            );
            allPages.push(...embeddedPages);
          }
        } catch (err) {
          console.warn(`[useCustomPages] Failed to load custom pages for plugin ${plugin.id}:`, err);
          // 继续加载其他插件的页面
        }
      }

      // 按order_index排序
      allPages.sort((a, b) => a.order_index - b.order_index);

      setCustomPages(allPages);
    } catch (err: any) {
      console.error('[useCustomPages] Failed to load custom pages:', err);
      setError(err.message || 'Unknown error');
      setCustomPages([]);
    } finally {
      setLoading(false);
    }
  }, [datasetId]);

  useEffect(() => {
    loadCustomPages();
  }, [loadCustomPages]);

  return {
    customPages,
    loading,
    error,
    reload: loadCustomPages,
  };
}

/**
 * 获取所有插件的自定义页面，按插件分组
 * @param options - datasetId: 针对特定数据集过滤；loadAll: 加载所有插件的所有页面
 */
export function usePluginPagesGrouped(options: { datasetId?: string | null; loadAll?: boolean }) {
  const [pluginGroups, setPluginGroups] = useState<PluginPagesGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { datasetId, loadAll = false } = options;

  const loadPluginPages = useCallback(async () => {
    // 如果既没有 datasetId 也不是 loadAll 模式，则清空
    if (!datasetId && !loadAll) {
      setPluginGroups([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 获取所有已激活插件
      const pluginsResult = await pluginFacade.listPlugins();
      if (!pluginsResult.success || !pluginsResult.plugins) {
        setError('Failed to load plugins');
        setPluginGroups([]);
        return;
      }

      const groups: PluginPagesGroup[] = [];

      // 遍历所有插件
      for (const plugin of pluginsResult.plugins) {
        try {
          // loadAll 模式下不传 datasetId，加载所有页面
          const pagesResult = await pluginFacade.getCustomPages(
            plugin.id,
            loadAll ? undefined : datasetId || undefined
          );

          if (pagesResult.success && pagesResult.pages && pagesResult.pages.length > 0) {
            // 按order_index排序
            const sortedPages = [...pagesResult.pages].sort(
              (a, b) => a.order_index - b.order_index
            );

            groups.push({
              pluginId: plugin.id,
              pluginName: plugin.name,
              pluginIcon: plugin.icon || '🔌',
              pages: sortedPages,
            });
          }
        } catch (err) {
          console.warn(`[useCustomPages] Failed to load pages for plugin ${plugin.id}:`, err);
        }
      }

      setPluginGroups(groups);
    } catch (err: any) {
      console.error('[useCustomPages] Failed to load plugin pages:', err);
      setError(err.message || 'Unknown error');
      setPluginGroups([]);
    } finally {
      setLoading(false);
    }
  }, [datasetId, loadAll]);

  useEffect(() => {
    loadPluginPages();
  }, [loadPluginPages]);

  return {
    pluginGroups,
    loading,
    error,
    reload: loadPluginPages,
  };
}

/**
 * 获取所有可用的弹出页面（不限定数据集）
 */
export function usePopupPages() {
  const [popupPages, setPopupPages] = useState<CustomPageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPopupPages = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // 获取所有已激活插件
      const pluginsResult = await pluginFacade.listPlugins();
      if (!pluginsResult.success || !pluginsResult.plugins) {
        setError('Failed to load plugins');
        setPopupPages([]);
        return;
      }

      const allPages: CustomPageInfo[] = [];

      // 遍历所有插件，获取弹出页面（不传datasetId）
      for (const plugin of pluginsResult.plugins) {
        try {
          const pagesResult = await pluginFacade.getCustomPages(plugin.id);

          if (pagesResult.success && pagesResult.pages) {
            // 过滤出popup模式的页面
            const filteredPopupPages = pagesResult.pages.filter(
              (page: any) => page.display_mode === 'popup'
            );
            allPages.push(...filteredPopupPages);
          }
        } catch (err) {
          console.warn(`[useCustomPages] Failed to load popup pages for plugin ${plugin.id}:`, err);
        }
      }

      // 按order_index排序
      allPages.sort((a, b) => a.order_index - b.order_index);

      setPopupPages(allPages);
    } catch (err: any) {
      console.error('[useCustomPages] Failed to load popup pages:', err);
      setError(err.message || 'Unknown error');
      setPopupPages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPopupPages();
  }, [loadPopupPages]);

  return {
    popupPages,
    loading,
    error,
    reload: loadPopupPages,
  };
}
