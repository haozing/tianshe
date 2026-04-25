/**
 * Sort Panel - 排序面板
 * 提供多列排序功能
 */

import { useState, useEffect } from 'react';
import { X, ArrowUp, ArrowDown, HelpCircle, Loader2 } from 'lucide-react';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { useDatasetFields } from '../../../hooks';
import { getDefaultSortLabels } from '../../../lib/field-type-helpers';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import type { SortConfig, SortColumn } from '../../../../../core/query-engine/types';
import { toast } from '../../../lib/toast';

interface SortPanelProps {
  datasetId: string;
  onClose: () => void;
  onSaveAsTemplate?: (config: SortConfig) => void; // 🆕 保存查询模板回调
  anchorEl?: HTMLElement | null;
}

export function SortPanel({
  datasetId,
  onClose,
  onSaveAsTemplate,
  anchorEl,
}: SortPanelProps) {
  const updateActiveQueryTemplate = useDatasetStore((state) => state.updateActiveQueryTemplate);
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);
  const [sortColumns, setSortColumns] = useState<SortColumn[]>([]);
  const [applying, setApplying] = useState(false);

  // 🆕 使用 useDatasetFields Hook
  const { availableFields } = useDatasetFields(datasetId);

  // ✅ Load current sort config if exists (从当前查询模板读取)
  useEffect(() => {
    const savedConfig = activeQueryConfig?.sort;
    if (savedConfig && savedConfig.columns) {
      setSortColumns(savedConfig.columns);
    } else {
      setSortColumns([]);
    }
  }, [activeQueryConfig?.sort]);

  // Add sort column
  const handleAddSortColumn = (fieldName?: string) => {
    if (availableFields.length === 0) return;
    const firstField = fieldName || availableFields[0].name;
    setSortColumns([
      ...sortColumns,
      {
        field: firstField,
        direction: 'ASC',
        nullsFirst: false,
      },
    ]);
  };

  // Update sort column
  const handleUpdateSortColumn = (index: number, updates: Partial<SortColumn>) => {
    const newColumns = [...sortColumns];
    newColumns[index] = { ...newColumns[index], ...updates };
    setSortColumns(newColumns);
  };

  // Remove sort column
  const handleRemoveSortColumn = (index: number) => {
    setSortColumns(sortColumns.filter((_, i) => i !== index));
  };

  const handleMoveSortColumn = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= sortColumns.length) {
      return;
    }

    const nextColumns = [...sortColumns];
    const [moved] = nextColumns.splice(index, 1);
    if (!moved) {
      return;
    }
    nextColumns.splice(nextIndex, 0, moved);
    setSortColumns(nextColumns);
  };

  // ✅ Cancel sort - 清除排序配置
  const handleCancelSort = async () => {
    // ✅ 更新默认查询模板，清除排序
    await updateActiveQueryTemplate(datasetId, { sort: undefined });

    // 关闭面板
    onClose();
  };

  // ✅ Apply sorting - 自动保存到当前查询模板
  const handleApply = async () => {
    if (sortColumns.length === 0) {
      toast.warning('请至少添加一个排序字段');
      return;
    }

    const config: SortConfig = {
      columns: sortColumns,
    };

    setApplying(true);
    try {
      // ✅ 调用 updateActiveQueryTemplate 自动保存
      await updateActiveQueryTemplate(datasetId, { sort: config });

      onClose();
    } finally {
      setApplying(false);
    }
  };

  // 🆕 保存为查询模板
  const handleSaveAsTemplate = () => {
    if (sortColumns.length === 0) {
      toast.warning('请至少添加一个排序字段');
      return;
    }

    const config: SortConfig = {
      columns: sortColumns,
    };

    onSaveAsTemplate?.(config);
  };

  // Title content for AnchoredPanel
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">设置排序条件</span>
      <HelpCircle size={16} className="text-gray-400" />
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl ?? null}
      title={titleContent}
      width="580px"
    >
      <div className="px-5 py-3">
        {/* 初始状态：显示"选择条件"下拉框 */}
        {sortColumns.length === 0 ? (
          <div>
            <select
              onChange={(e) => {
                if (e.target.value && availableFields.length > 0) {
                  handleAddSortColumn(e.target.value);
                  e.target.value = '';
                }
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white text-gray-500"
              value=""
            >
              <option value="" disabled>
                选择条件
              </option>
              {availableFields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <>
            {/* Sort Columns */}
            {sortColumns.map((sortCol, index) => {
              // 🆕 使用工具函数获取字段类型和排序标签
              const fieldInfo = availableFields.find((f) => f.name === sortCol.field);
              const sortLabels = getDefaultSortLabels(fieldInfo?.type || '');

              return (
                <div key={index} className="mb-3">
                  <div className="flex items-center gap-2">
                    {/* 排序优先级调整 */}
                    <div className="flex items-center gap-1 text-gray-400">
                      <button
                        type="button"
                        onClick={() => handleMoveSortColumn(index, -1)}
                        disabled={index === 0}
                        className="p-1 rounded hover:bg-gray-100 hover:text-gray-600 disabled:text-gray-300 disabled:cursor-not-allowed"
                        title="上移"
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveSortColumn(index, 1)}
                        disabled={index === sortColumns.length - 1}
                        className="p-1 rounded hover:bg-gray-100 hover:text-gray-600 disabled:text-gray-300 disabled:cursor-not-allowed"
                        title="下移"
                      >
                        <ArrowDown size={14} />
                      </button>
                    </div>

                    {/* 字段选择 */}
                    <select
                      value={sortCol.field}
                      onChange={(e) => handleUpdateSortColumn(index, { field: e.target.value })}
                      className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                    >
                      {availableFields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.name}
                        </option>
                      ))}
                    </select>

                    {/* 排序切换按钮 */}
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleUpdateSortColumn(index, { direction: 'ASC' })}
                        className={`px-3 py-1.5 text-sm border rounded transition-colors ${
                          sortCol.direction === 'ASC'
                            ? 'bg-blue-100 border-blue-300 text-blue-700'
                            : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                        }`}
                        style={{ minWidth: '65px' }}
                      >
                        {sortLabels.asc}
                      </button>
                      <button
                        onClick={() => handleUpdateSortColumn(index, { direction: 'DESC' })}
                        className={`px-3 py-1.5 text-sm border rounded transition-colors ${
                          sortCol.direction === 'DESC'
                            ? 'bg-blue-100 border-blue-300 text-blue-700'
                            : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                        }`}
                        style={{ minWidth: '65px' }}
                      >
                        {sortLabels.desc}
                      </button>
                    </div>

                    {/* 删除按钮 */}
                    <button
                      onClick={() => handleRemoveSortColumn(index)}
                      className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                      title="删除排序"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* NULL 值排序控制 */}
                  <div className="ml-7 mt-1">
                    <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sortCol.nullsFirst ?? false}
                        onChange={(e) =>
                          handleUpdateSortColumn(index, {
                            nullsFirst: e.target.checked,
                          })
                        }
                        className="w-3 h-3 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span>NULL 值优先</span>
                    </label>
                  </div>
                </div>
              );
            })}

            {/* 添加更多排序字段 - 使用下拉框 */}
            <div className="mt-2">
              <select
                onChange={(e) => {
                  if (e.target.value && availableFields.length > 0) {
                    handleAddSortColumn(e.target.value);
                    e.target.value = '';
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white text-gray-500"
                value=""
              >
                <option value="" disabled>
                  选择条件
                </option>
                {availableFields.map((field) => (
                  <option key={field.name} value={field.name}>
                    {field.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="px-5 py-3 border-t border-gray-200 space-y-2">
        <div className="flex justify-between items-center">
          {/* ✅ 左侧：取消排序按钮（从当前查询模板判断） */}
          {activeQueryConfig?.sort?.columns && activeQueryConfig.sort.columns.length > 0 ? (
            <button
              onClick={handleCancelSort}
              className="text-sm text-red-600 hover:text-red-700 transition-colors font-medium"
            >
              取消排序
            </button>
          ) : (
            <div />
          )}

          {/* 右侧：关闭和应用按钮 */}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors"
            >
              关闭
            </button>
            <button
              onClick={handleApply}
              className="px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              disabled={sortColumns.length === 0 || applying}
            >
              {applying && <Loader2 className="w-4 h-4 animate-spin" />}
              {applying ? '正在应用...' : '应用并刷新结果'}
            </button>
          </div>
        </div>

        {/* 🆕 保存查询模板按钮 */}
        {onSaveAsTemplate && (
          <div className="flex justify-center">
            <button
              onClick={handleSaveAsTemplate}
              disabled={sortColumns.length === 0}
              className="text-sm text-blue-600 hover:text-blue-700 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              保存查询模板
            </button>
          </div>
        )}
      </div>
    </AnchoredPanel>
  );
}
