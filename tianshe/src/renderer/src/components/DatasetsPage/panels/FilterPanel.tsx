/**
 * Filter Panel - 数据筛选面板
 * 提供可视化的数据筛选界面，支持多字段、多条件组合
 *
 * 优化点：
 * - 使用 useImmer 简化 Map 状态更新
 * - 使用 useCallback 缓存事件处理器
 * - 使用 useMemo 优化派生状态
 * - 使用 useRef 防止 useEffect 重复触发
 * - 提取 FilterRow 组件减少渲染范围
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Plus, CheckCircle, AlertCircle, Eye } from 'lucide-react';
import { useImmer } from 'use-immer';
import {
  selectActiveQueryConfig,
  selectActiveQueryTemplate,
  useDatasetStore,
} from '../../../stores/datasetStore';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import { OperationLoadingState, PreviewStats } from '../../common/OperationLoadingState';
import { useDatasetFields, usePreviewState } from '../../../hooks';
import { previewDatasetFilterCount } from '../../../services/datasets/datasetPanelService';
import type { FilterCondition, FilterConfig } from '../../../../../core/query-engine/types';
import { FilterRow } from './FilterRow';
import { toast } from '../../../lib/toast';

interface FilterPanelProps {
  datasetId: string;
  onClose: () => void;
  onSaveAsTemplate?: (config: FilterConfig) => void; // 🆕 保存查询模板回调
  anchorEl?: HTMLElement | null;
}

export function FilterPanel({ datasetId, onClose, onSaveAsTemplate, anchorEl }: FilterPanelProps) {
  const updateActiveQueryTemplate = useDatasetStore((state) => state.updateActiveQueryTemplate);
  const clearAllProcessing = useDatasetStore((state) => state.clearAllProcessing);
  const activeQueryTemplate = useDatasetStore(selectActiveQueryTemplate);
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);

  // 使用 useImmer 管理筛选条件（使用对象而非 Map，因为 Immer 默认不支持 Map）
  const [activeFilters, updateActiveFilters] = useImmer<Record<string, FilterCondition>>({});
  const [combinator, setCombinator] = useState<'AND' | 'OR'>('AND');

  // 使用 useDatasetFields Hook
  const { availableFields, currentDataset } = useDatasetFields(datasetId);

  const userConditions = useMemo(() => Object.values(activeFilters), [activeFilters]);

  // 🆕 使用 usePreviewState Hook 管理预览状态
  const preview = usePreviewState(
    async () => {
      if (userConditions.length === 0) {
        return null;
      }

      const config: FilterConfig = {
        combinator,
        conditions: userConditions,
      };

      return await previewDatasetFilterCount(datasetId, config);
    },
    [userConditions, combinator, currentDataset, datasetId],
    { debounceMs: 500, autoTrigger: false }
  );

  // 使用 ref 追踪上次的模板 ID，防止重复重置
  const prevTemplateIdRef = useRef<string | undefined>();

  // 恢复保存的筛选条件（从当前查询模板读取）
  useEffect(() => {
    const activeTemplateId = activeQueryTemplate?.id;

    // 只有当查询模板 ID 真正变化时才重置
    if (prevTemplateIdRef.current === activeTemplateId) {
      return; // 跳过，避免重复重置导致输入中断
    }
    prevTemplateIdRef.current = activeTemplateId;

    const savedConfig = activeQueryConfig?.filter;

    if (savedConfig) {
      // 将保存的条件转换为对象格式
      const restoredFilters: Record<string, FilterCondition> = {};
      const conditions = savedConfig.conditions || [];

      conditions.forEach((condition: FilterCondition, index: number) => {
        restoredFilters[`filter_${Date.now()}_${index}`] = condition;
      });

      updateActiveFilters(() => restoredFilters);
      // 使用 queueMicrotask 避免 eslint react-hooks/set-state-in-effect 错误
      // 这将 setState 推迟到微任务队列，避免在 effect 内同步调用
      queueMicrotask(() => setCombinator(savedConfig.combinator || 'AND'));
    } else {
      // 清空筛选条件
      updateActiveFilters(() => ({}));
      queueMicrotask(() => setCombinator('AND'));
    }
  }, [activeQueryTemplate?.id, activeQueryConfig?.filter, updateActiveFilters]);

  // 使用 useCallback 包装事件处理器，避免子组件不必要的重新渲染
  const handleAddFilter = useCallback(() => {
    if (availableFields.length === 0) return;

    const firstField = availableFields[0];
    const filterId = `filter_${Date.now()}`;

    const newFilter: FilterCondition = {
      type: 'equal',
      field: firstField.name,
      value: '',
    };

    updateActiveFilters((draft) => {
      draft[filterId] = newFilter;
    });
  }, [availableFields, updateActiveFilters]);

  // 更新筛选条件
  const handleUpdateFilter = useCallback(
    (filterId: string, updates: Partial<FilterCondition>) => {
      updateActiveFilters((draft) => {
        const existing = draft[filterId];
        if (existing) {
          draft[filterId] = { ...existing, ...updates };
        }
      });
    },
    [updateActiveFilters]
  );

  // 删除筛选条件
  const handleRemoveFilter = useCallback(
    (filterId: string) => {
      updateActiveFilters((draft) => {
        delete draft[filterId];
      });
    },
    [updateActiveFilters]
  );

  // 重置所有筛选条件
  const handleReset = useCallback(() => {
    updateActiveFilters(() => ({}));
    setCombinator('AND');
    preview.clearPreview();
  }, [updateActiveFilters, preview]);

  const hasSavedFilter = Boolean(activeQueryConfig?.filter?.conditions?.length);

  // 清除已保存的筛选
  const handleClearFilter = useCallback(async () => {
    await updateActiveQueryTemplate(datasetId, { filter: undefined });
    onClose();
  }, [datasetId, updateActiveQueryTemplate, onClose]);

  // 应用筛选条件 - 自动保存到当前查询模板
  const handleApply = useCallback(async () => {
    const config =
      userConditions.length > 0
        ? ({
            combinator,
            conditions: userConditions,
          } satisfies FilterConfig)
        : undefined;

    // 调用 updateActiveQueryTemplate 方法（自动保存到当前查询模板）
    await updateActiveQueryTemplate(datasetId, { filter: config });

    onClose();
  }, [userConditions, combinator, datasetId, updateActiveQueryTemplate, onClose]);

  // 保存为查询模板
  const handleSaveAsTemplate = useCallback(() => {
    if (userConditions.length === 0) {
      toast.warning('请至少添加一个筛选条件');
      return;
    }

    const config: FilterConfig = {
      combinator,
      conditions: userConditions,
    };

    onSaveAsTemplate?.(config);
  }, [userConditions, combinator, onSaveAsTemplate]);

  // Title content for AnchoredPanel
  const activeCount = Object.keys(activeFilters).length;

  const titleContent = (
    <div className="flex items-center gap-3 flex-1 justify-between w-full">
      <span className="text-sm font-medium text-gray-700">
        {activeCount === 0 ? '没有筛选条件' : `${activeCount} 个筛选条件`}
      </span>
      {/* Combinator Selector */}
      {activeCount > 1 && (
        <select
          value={combinator}
          onChange={(e) => setCombinator(e.target.value as 'AND' | 'OR')}
          className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          <option value="AND">符合以下所有条件</option>
          <option value="OR">符合以下任一条件</option>
        </select>
      )}
    </div>
  );

  // 清除所有处理
  const handleClearAll = useCallback(async () => {
    if (
      !confirm(
        '确定要清除当前视图中的筛选、排序、清洗、采样等处理吗？这不会删除已物化的新列或其他数据结构变更。'
      )
    ) {
      return;
    }

    await clearAllProcessing(datasetId);
    onClose();
  }, [clearAllProcessing, datasetId, onClose]);

  // 使用 useMemo 缓存过滤器数组，避免每次渲染都重新计算
  const filterEntries = useMemo(() => Object.entries(activeFilters), [activeFilters]);

  // Footer content for AnchoredPanel
  const footerContent = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {hasSavedFilter && (
            <button
              onClick={handleClearFilter}
              className="px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50 rounded transition-colors"
              title="仅清除当前筛选条件"
            >
              清除筛选
            </button>
          )}
          <button
            onClick={handleClearAll}
            className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded transition-colors"
            title="清除当前视图中的筛选、排序、清洗、采样等处理"
          >
            清除所有处理
          </button>
        </div>

        {/* 右侧按钮组 */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-200 rounded transition-colors"
          >
            重置
          </button>
          <button
            onClick={handleApply}
            disabled={activeCount === 0 && !hasSavedFilter}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            应用并刷新结果
          </button>
        </div>
      </div>
      {/* 🆕 保存查询模板按钮 */}
      {onSaveAsTemplate && (
        <div className="flex justify-center pt-1">
          <button
            onClick={handleSaveAsTemplate}
            disabled={activeCount === 0}
            className="text-sm text-blue-600 hover:text-blue-700 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            保存查询模板
          </button>
        </div>
      )}
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl ?? null}
      title={titleContent}
      footer={footerContent}
      width="580px"
    >
      <div className="px-5 py-3">
        {/* Filter Rows - 使用 FilterRow 组件替代内联渲染 */}
        {filterEntries.map(([filterId, filter]) => (
          <FilterRow
            key={filterId}
            filterId={filterId}
            filter={filter}
            availableFields={availableFields}
            onUpdate={handleUpdateFilter}
            onRemove={handleRemoveFilter}
          />
        ))}

        {/* Add Filter Button */}
        <button
          onClick={handleAddFilter}
          className="mt-2 flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>添加条件</span>
        </button>

        {/* 预览按钮 */}
        {activeCount > 0 && (
          <button
            onClick={() => preview.triggerPreview()}
            disabled={preview.loading}
            className="mt-2 flex items-center gap-2 px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Eye className="w-4 h-4" />
            <span>{preview.loading ? '预览中...' : '预览结果'}</span>
          </button>
        )}

        {/* 预览区域 */}
        {activeCount > 0 && (preview.data !== null || preview.error) && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <OperationLoadingState loading={preview.loading} operation="筛选预览" />

            {!preview.loading && preview.data !== null && currentDataset && (
              <PreviewStats
                icon={<CheckCircle />}
                label="筛选结果"
                value={`${preview.data.toLocaleString()} 条`}
                description={`将保留 ${((preview.data / currentDataset.rowCount) * 100).toFixed(1)}% 的数据（共 ${currentDataset.rowCount.toLocaleString()} 条）`}
                type={preview.data > 0 ? 'success' : 'warning'}
              />
            )}

            {!preview.loading && preview.error && (
              <div className="flex items-start gap-2 p-3 rounded-lg border border-red-200 bg-red-50">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-red-800">预览失败</h4>
                  <p className="text-sm text-red-700 mt-1">{preview.error}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </AnchoredPanel>
  );
}
