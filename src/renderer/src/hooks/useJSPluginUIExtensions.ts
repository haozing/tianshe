/**
 * JS Plugin UI扩展 Hook
 * 用于获取和管理插件的工具栏按钮
 */

import { useState, useEffect, useCallback } from 'react';
import { useEventSubscription } from './useElectronAPI';
import { pluginFacade } from '../services/datasets/pluginFacade';
import { pluginEvents } from '../services/datasets/pluginEvents';

export interface ToolbarButton {
  id: string;
  pluginId: string;
  contributionId: string;
  label: string;
  icon: string;
  confirmMessage: string | null;
  commandId: string;
  requiresSelection: boolean;
  minSelection: number;
  maxSelection: number | null;
  order: number;
}

/**
 * 获取数据集的工具栏按钮
 */
export function useToolbarButtons(datasetId: string | null) {
  const [toolbarButtons, setToolbarButtons] = useState<ToolbarButton[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 🆕 添加刷新触发器
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    if (!datasetId) {
      setToolbarButtons([]);
      return;
    }

    async function loadToolbarButtons() {
      setLoading(true);
      setError(null);

      try {
        const result = await pluginFacade.getToolbarButtons(datasetId!);

        if (result.success && result.toolbarButtons) {
          setToolbarButtons(result.toolbarButtons);
        } else {
          setError(result.error || 'Failed to load toolbar buttons');
          setToolbarButtons([]);
        }
      } catch (err: any) {
        console.error('[ToolbarButtons] Failed to load toolbar buttons:', err);
        setError(err.message || 'Unknown error');
        setToolbarButtons([]);
      } finally {
        setLoading(false);
      }
    }

    loadToolbarButtons();
  }, [datasetId, refreshTrigger]); // 🆕 添加 refreshTrigger 依赖

  useEventSubscription(pluginEvents.subscribeToPluginStateChanged, () => {
      // 触发重新加载
      setRefreshTrigger((prev) => prev + 1);
    });

  /**
   * 执行工具栏按钮命令
   */
  const executeToolbarButton = useCallback(
    async (
      button: ToolbarButton,
      selectedRows: any[]
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      try {
        // 验证选中行数量
        if (button.requiresSelection) {
          const count = selectedRows.length;
          if (count < button.minSelection) {
            return {
              success: false,
              error: `请至少选中 ${button.minSelection} 行`,
            };
          }
          if (button.maxSelection && count > button.maxSelection) {
            return {
              success: false,
              error: `最多只能选中 ${button.maxSelection} 行`,
            };
          }
        }

        // 显示确认对话框（如果有）
        if (button.confirmMessage) {
          const message = button.confirmMessage.replace('{count}', String(selectedRows.length));
          const confirmed = window.confirm(message);
          if (!confirmed) {
            return { success: false, error: 'User cancelled' };
          }
        }

        const result = await pluginFacade.executeToolbarButton(
          button.pluginId,
          button.commandId,
          selectedRows
        );

        return result;
      } catch (err: any) {
        console.error('[ToolbarButtons] Failed to execute toolbar button:', err);
        return {
          success: false,
          error: err.message || 'Unknown error',
        };
      }
    },
    []
  );

  return {
    toolbarButtons,
    loading,
    error,
    executeToolbarButton,
  };
}
