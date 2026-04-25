/**
 * Dedupe Panel - 去重面板
 * 提供去重功能（查询模板级去重：仅保留首条/末条记录，不会物理删除原表数据）
 */

import { useState, useEffect, useMemo } from 'react';
import { X, Plus, HelpCircle, Eye, TrendingUp, AlertCircle, Loader2 } from 'lucide-react';
import { useDatasetFields } from '../../../hooks';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import { PreviewWarning } from '../../common/OperationLoadingState';
import { toast } from '../../../lib/toast';
import {
  deleteDatasetRowsByDictionaryFilter,
  previewDatasetDedupe,
} from '../../../services/datasets/datasetPanelService';
import { PAGINATION_THRESHOLDS } from '../../../lib/pagination-strategy';
import { DictionarySelector } from './DictionarySelector';
import type {
  DedupeConfig,
  DedupePreviewStats,
  DedupeOrderColumn,
  QueryConfig,
} from '../../../../../core/query-engine/types';

interface DedupePanelProps {
  datasetId: string;
  onClose: () => void;
  onApply: (config: QueryConfig) => Promise<void> | void;
  onSaveAsTemplate?: (config: QueryConfig) => void; // 🆕 保存查询模板回调
  onClear?: () => Promise<void> | void;
  anchorEl?: HTMLElement | null;
  readOnly?: boolean; // 快照只读模式（禁用物理删除）
}

export function DedupePanel({
  datasetId,
  onClose,
  onApply,
  onSaveAsTemplate,
  onClear,
  anchorEl,
  readOnly = false,
}: DedupePanelProps) {
  const { refreshDatasetView, applyLocalDatasetCountDelta } = useDatasetStore();
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);
  const queryResult = useDatasetStore((state) =>
    state.activeQueryDatasetId === datasetId ? state.queryResult : null
  );
  const { currentDataset, availableFields: schemaFields } = useDatasetFields(datasetId);
  const availableFields = useMemo(() => {
    const fieldsByName = new Map(schemaFields.map((field) => [field.name, field]));

    for (const columnName of queryResult?.columns || []) {
      if (!fieldsByName.has(columnName)) {
        fieldsByName.set(columnName, {
          name: columnName,
          type: 'UNKNOWN',
          fieldType: 'text',
        });
      }
    }

    return Array.from(fieldsByName.values());
  }, [queryResult?.columns, schemaFields]);
  const defaultTieBreaker = useMemo(
    () => (availableFields.some((field) => field.name === '_row_id') ? '_row_id' : undefined),
    [availableFields]
  );
  const [partitionByFields, setPartitionByFields] = useState<string[]>([]);

  // ✨ 新增：支持独立排序方向
  const [orderByColumns, setOrderByColumns] = useState<DedupeOrderColumn[]>([]);

  // ✨ 使用 keepStrategy 替代 keepFirst
  const [keepStrategy, setKeepStrategy] = useState<'first' | 'last'>('first');
  const [tieBreaker, setTieBreaker] = useState<string | undefined>(undefined);

  // ✨ 词库匹配删除（从筛选面板迁移到去重面板）
  const [dictFilterEnabled, setDictFilterEnabled] = useState(false);
  const [dictFilterType, setDictFilterType] = useState<'contains_multi' | 'excludes_multi'>(
    'contains_multi'
  );
  const [dictTargetField, setDictTargetField] = useState<string>('');
  const [dictDatasetId, setDictDatasetId] = useState<string | undefined>(undefined);
  const [dictFieldName, setDictFieldName] = useState<string | undefined>(undefined);

  const dictDeleteMessage = useMemo(() => {
    return dictFilterType === 'contains_multi'
      ? '将删除【不包含词库任一词】的记录'
      : '将删除【包含词库任一词】的记录';
  }, [dictFilterType]);
  const previewBaseConfig = useMemo(() => {
    if (!activeQueryConfig) {
      return {};
    }

    const baseConfig = { ...activeQueryConfig };
    delete baseConfig.dedupe;
    delete baseConfig.sample;
    delete baseConfig.sort;
    delete baseConfig.columns;
    return baseConfig;
  }, [activeQueryConfig]);

  // ✨ 新增：预览相关状态
  const [previewStats, setPreviewStats] = useState<DedupePreviewStats | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const sourceRowCount =
    previewStats?.totalRows ?? queryResult?.filteredTotalCount ?? currentDataset?.rowCount ?? 0;
  const hasSavedDedupe = Boolean(activeQueryConfig?.dedupe);

  useEffect(() => {
    const savedDedupe = activeQueryConfig?.dedupe;
    if (savedDedupe) {
      setPartitionByFields(savedDedupe.partitionBy || []);
      setOrderByColumns(savedDedupe.orderBy || []);
      setKeepStrategy(savedDedupe.keepStrategy === 'last' ? 'last' : 'first');
      setTieBreaker(savedDedupe.tieBreaker || defaultTieBreaker);
    } else {
      setPartitionByFields([]);
      setOrderByColumns([]);
      setKeepStrategy('first');
      setTieBreaker(defaultTieBreaker);
    }
  }, [activeQueryConfig?.dedupe, datasetId, defaultTieBreaker]);

  useEffect(() => {
    setPreviewStats(null);
    setPreviewError(null);
  }, [partitionByFields, orderByColumns, keepStrategy, tieBreaker]);

  // 词库过滤（Aho-Corasick）：仅用于“直接删除”，不写入查询模板配置

  // 默认选择一个目标字段
  useEffect(() => {
    if (dictTargetField) return;
    if (schemaFields.length === 0) return;
    setDictTargetField(schemaFields[0].name);
  }, [schemaFields, dictTargetField]);

  useEffect(() => {
    if (readOnly && dictFilterEnabled) {
      setDictFilterEnabled(false);
    }
  }, [dictFilterEnabled, readOnly]);

  // Add partition field
  const handleAddPartitionField = () => {
    if (availableFields.length === 0) return;
    const firstField = availableFields[0].name;
    if (!partitionByFields.includes(firstField)) {
      setPartitionByFields([...partitionByFields, firstField]);
    }
  };

  // Remove partition field
  const handleRemovePartitionField = (index: number) => {
    setPartitionByFields(partitionByFields.filter((_, i) => i !== index));
  };

  // Update partition field
  const handleUpdatePartitionField = (index: number, value: string) => {
    const newFields = [...partitionByFields];
    newFields[index] = value;
    setPartitionByFields(newFields);
  };

  // ✨ 新增：添加排序列（支持方向控制）
  const handleAddOrderColumn = () => {
    if (availableFields.length === 0) return;
    const firstField = availableFields[0].name;
    setOrderByColumns([...orderByColumns, { field: firstField, direction: 'ASC' }]);
  };

  // ✨ 移除排序列
  const handleRemoveOrderColumn = (index: number) => {
    setOrderByColumns(orderByColumns.filter((_, i) => i !== index));
  };

  // ✨ 更新排序列字段
  const handleUpdateOrderColumnField = (index: number, field: string) => {
    const newColumns = [...orderByColumns];
    newColumns[index] = { ...newColumns[index], field };
    setOrderByColumns(newColumns);
  };

  // ✨ 更新排序列方向
  const handleUpdateOrderColumnDirection = (index: number, direction: 'ASC' | 'DESC') => {
    const newColumns = [...orderByColumns];
    newColumns[index] = { ...newColumns[index], direction };
    setOrderByColumns(newColumns);
  };

  const handleDictionaryChange = (dictionaryDatasetId: string, fieldName: string) => {
    const normalizedDatasetId = dictionaryDatasetId || undefined;
    const normalizedFieldName = fieldName || undefined;
    setDictDatasetId(normalizedDatasetId);
    setDictFieldName(normalizedFieldName);
  };

  // ✨ 构建去重配置（查询模板级去重：ROW_NUMBER 过滤重复）
  const buildDedupeConfig = (): DedupeConfig => {
    const effectiveTieBreaker =
      tieBreaker && !orderByColumns.some((column) => column.field === tieBreaker)
        ? tieBreaker
        : undefined;

    return {
      type: 'row_number',
      partitionBy: partitionByFields,
      orderBy: orderByColumns.length > 0 ? orderByColumns : undefined,
      keepStrategy,
      tieBreaker: effectiveTieBreaker,
    };
  };

  // ✨ 新增：预览去重效果
  const handlePreview = async () => {
    if (partitionByFields.length === 0) {
      setPreviewError('请至少选择一个去重字段');
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const config = buildDedupeConfig();
      const result = await previewDatasetDedupe(datasetId, config, {
        baseConfig: previewBaseConfig,
      });

      setPreviewStats(result.stats);
    } catch (error) {
      console.error('[DedupePanel] Preview error:', error);
      setPreviewError(error instanceof Error ? error.message : '预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  // Reset all
  // Apply deduplication
  const handleApply = async () => {
    if (readOnly && dictFilterEnabled) {
      toast.warning('数据未就绪，暂不支持词库物理删除');
      return;
    }

    if (partitionByFields.length === 0 && !dictFilterEnabled) {
      toast.warning('请至少选择一个去重字段，或启用词库删除');
      return;
    }

    const dictTarget = dictTargetField || schemaFields[0]?.name;
    const dictId = dictDatasetId;
    const dictField = dictFieldName || 'word';

    if (dictFilterEnabled) {
      if (!dictTarget) {
        toast.warning('请先选择要匹配的字段');
        return;
      }
      if (!dictId) {
        toast.warning('请先选择词库数据集');
        return;
      }
    }

    setApplying(true);
    try {
      if (dictFilterEnabled) {
        const confirmed = window.confirm(
          `确认执行词库删除？\n\n${dictDeleteMessage}\n\n该操作为物理删除，无法恢复。`
        );
        if (!confirmed) return;

        const result = await deleteDatasetRowsByDictionaryFilter({
          datasetId,
          targetField: dictTarget!,
          dictDatasetId: dictId!,
          dictField,
          filterType: dictFilterType,
        });

        const deletedCount = result.deletedCount ?? 0;

        toast.success(`已删除 ${deletedCount} 行数据`);

        // 刷新数据集信息（rowCount 等）
        // 若仅执行词库删除，则立即刷新表格数据
        if (deletedCount > 0) {
          applyLocalDatasetCountDelta(datasetId, -deletedCount);
        }
        await refreshDatasetView(datasetId);
      }

      if (partitionByFields.length > 0) {
        await onApply({ dedupe: buildDedupeConfig() });
      }

      onClose();
    } catch (error) {
      console.error('[DedupePanel] Apply error:', error);
      toast.error('应用失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setApplying(false);
    }
  };

  // 🆕 保存为查询模板
  const handleSaveAsTemplate = () => {
    if (partitionByFields.length === 0) {
      toast.warning('词库删除不会保存为查询模板，请先设置去重字段');
      return;
    }

    try {
      onSaveAsTemplate?.({ dedupe: buildDedupeConfig() });
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : '配置有误，请检查');
    }
  };

  const handleClear = async () => {
    if (!onClear) return;

    try {
      await onClear();
      onClose();
    } catch (error) {
      console.error('[DedupePanel] Clear error:', error);
      toast.error('清除去重失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  // Title content for AnchoredPanel
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">数据去重</span>
      <HelpCircle size={16} className="text-gray-400" />
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl ?? null}
      title={titleContent}
      width="620px"
    >
      <div className="px-5 py-3">
        <div className="space-y-4">
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <label className="block text-sm font-medium text-gray-700 mb-1">去重方式</label>
            <div className="text-sm text-gray-700 font-medium">仅保留每组一条（不改动原表）</div>
            <p className="text-xs text-gray-500 mt-1">
              这是查询模板级去重：只影响当前结果/导出结果，不会物理删除数据表
            </p>
          </div>

          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium text-gray-700">词库物理删除（可选）</label>
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dictFilterEnabled}
                  disabled={readOnly}
                  onChange={(e) => setDictFilterEnabled(e.target.checked)}
                  className="w-4 h-4 text-blue-600 focus:ring-blue-500"
                />
                <span>启用</span>
              </label>
            </div>

            {readOnly && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                数据未就绪，已禁用词库物理删除。
              </p>
            )}

            {dictFilterEnabled && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <select
                    value={dictFilterType}
                    onChange={(e) =>
                      setDictFilterType(e.target.value as 'contains_multi' | 'excludes_multi')
                    }
                    className="w-44 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="contains_multi">删除未匹配词库</option>
                    <option value="excludes_multi">删除匹配词库</option>
                  </select>

                  <select
                    value={dictTargetField}
                    onChange={(e) => setDictTargetField(e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {schemaFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name} ({f.type})
                      </option>
                    ))}
                  </select>
                </div>

                <DictionarySelector
                  datasetId={dictDatasetId}
                  fieldName={dictFieldName}
                  onChange={handleDictionaryChange}
                />

                <p className="text-xs text-gray-600">当前规则：{dictDeleteMessage}</p>
                <p className="text-xs text-gray-500">
                  该操作会先执行物理删除，再刷新当前视图；不会写入查询模板。
                </p>
              </div>
            )}
          </div>

          {/* Partition By Fields */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">
              🔍 去重字段 (根据这些字段判断是否重复)
            </h3>
            <div className="space-y-2">
              {partitionByFields.map((field, index) => (
                <div key={index} className="flex items-center gap-2">
                  <select
                    value={field}
                    onChange={(e) => handleUpdatePartitionField(index, e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {availableFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name} ({f.type})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleRemovePartitionField(index)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                    title="删除字段"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={handleAddPartitionField}
                className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>添加去重字段</span>
              </button>
            </div>
          </div>

          {/* ✨ Order By Columns（支持独立方向控制） */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">
              📊 排序字段 (可选，用于确定保留哪条记录)
            </h3>
            <div className="space-y-2">
              {orderByColumns.map((col, index) => (
                <div key={index} className="flex items-center gap-2">
                  <select
                    value={col.field}
                    onChange={(e) => handleUpdateOrderColumnField(index, e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {availableFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name} ({f.type})
                      </option>
                    ))}
                  </select>
                  {/* ✨ 方向控制 */}
                  <select
                    value={col.direction}
                    onChange={(e) =>
                      handleUpdateOrderColumnDirection(index, e.target.value as 'ASC' | 'DESC')
                    }
                    className="px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="ASC">升序 ↑</option>
                    <option value="DESC">降序 ↓</option>
                  </select>
                  <button
                    onClick={() => handleRemoveOrderColumn(index)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                    title="删除字段"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={handleAddOrderColumn}
                className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>添加排序字段</span>
              </button>
            </div>
          </div>

          {/* ✨ Keep Strategy */}
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <label className="block text-sm font-medium text-gray-700 mb-2">保留策略</label>
            <select
              value={keepStrategy}
              onChange={(e) => setKeepStrategy(e.target.value as 'first' | 'last')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="first">保留首条记录（最早/最小）</option>
              <option value="last">保留末条记录（最新/最大）</option>
            </select>
            <p className="text-xs text-gray-500 mt-2">
              会基于上方排序字段先排序，再保留排序后的首条或末条记录。
            </p>
          </div>
        </div>

        {/* ✨ 预览统计区域 */}
        <div className="mt-4 space-y-3">
          {/* 预览按钮 */}
          <button
            onClick={handlePreview}
            disabled={partitionByFields.length === 0 || previewLoading}
            className="w-full px-4 py-2 bg-purple-50 text-purple-700 text-sm font-medium rounded-lg hover:bg-purple-100 transition-colors disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {previewLoading ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-purple-600 border-t-transparent rounded-full"></div>
                <span>分析中...</span>
              </>
            ) : (
              <>
                <Eye className="w-4 h-4" />
                <span>🔍 预览去重效果</span>
              </>
            )}
          </button>

          {dictFilterEnabled && (
            <p className="text-xs text-gray-500">
              提示：当前预览只覆盖查询模板级去重，不包含词库物理删除。
            </p>
          )}

          {/* 错误提示 */}
          {previewError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-900">预览失败</p>
                <p className="text-xs text-red-700 mt-1">{previewError}</p>
              </div>
            </div>
          )}

          {/* 统计信息 */}
          {previewStats && (
            <div className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="w-5 h-5 text-blue-600" />
                <h4 className="text-sm font-semibold text-gray-900">去重效果预览</h4>
              </div>

              {/* 关键指标 */}
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="bg-white rounded-md p-3 shadow-sm">
                  <div className="text-xs text-gray-500 mb-1">总行数</div>
                  <div className="text-lg font-bold text-gray-900">
                    {previewStats.totalRows.toLocaleString()}
                  </div>
                </div>
                <div className="bg-white rounded-md p-3 shadow-sm">
                  <div className="text-xs text-gray-500 mb-1">重复行数</div>
                  <div className="text-lg font-bold text-orange-600">
                    {previewStats.duplicateRows.toLocaleString()}
                  </div>
                </div>
                <div className="bg-white rounded-md p-3 shadow-sm border-2 border-red-200">
                  <div className="text-xs text-red-600 mb-1">将删除</div>
                  <div className="text-lg font-bold text-red-600">
                    {previewStats.willBeRemoved.toLocaleString()}
                  </div>
                </div>
                <div className="bg-white rounded-md p-3 shadow-sm border-2 border-green-200">
                  <div className="text-xs text-green-600 mb-1">将保留</div>
                  <div className="text-lg font-bold text-green-600">
                    {previewStats.willBeKept.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* 重复度信息 */}
              {previewStats.duplicateGroups > 0 && (
                <div className="bg-white/80 rounded-md p-3 text-xs">
                  <p className="text-gray-700">
                    <span className="font-semibold">{previewStats.duplicateGroups}</span>{' '}
                    组重复数据， 占比{' '}
                    <span className="font-semibold text-orange-600">
                      {((previewStats.duplicateRows / previewStats.totalRows) * 100).toFixed(1)}%
                    </span>
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Large Dataset Warning */}
          {sourceRowCount > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION && (
            <PreviewWarning
              title="大数据集提示"
              message={`当前去重输入约有 ${sourceRowCount.toLocaleString()} 行记录。去重操作需要扫描全量输入并计算分组，在大数据集上可能需要较长时间。${
                previewStats && previewStats.willBeKept > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION
                  ? `去重后仍有 ${previewStats.willBeKept.toLocaleString()} 行记录，建议先应用筛选或采样以减少数据量。`
                  : ''
              }`}
            />
          )}

          {/* Result Still Large Warning */}
          {previewStats && previewStats.willBeKept > PAGINATION_THRESHOLDS.FORCE_PAGINATION && (
            <PreviewWarning
              title="结果集过大"
              message={`去重后仍有 ${previewStats.willBeKept.toLocaleString()} 行记录（超过 ${PAGINATION_THRESHOLDS.FORCE_PAGINATION.toLocaleString()} 行阈值）。建议先进行筛选或采样操作，以确保最佳性能。`}
            />
          )}
        </div>

        {/* Apply Button */}
        <div className="mt-4">
          {partitionByFields.length === 0 && dictFilterEnabled && (
            <div className="mb-2 text-xs text-gray-500">当前仅执行词库删除（未设置去重字段）。</div>
          )}
          <button
            onClick={handleApply}
            disabled={
              (!dictFilterEnabled && partitionByFields.length === 0) ||
              applying ||
              (dictFilterEnabled && (!dictDatasetId || !dictTargetField))
            }
            className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed font-medium flex items-center justify-center gap-2"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {applying
              ? partitionByFields.length === 0
                ? '正在应用...'
                : '正在去重...'
              : partitionByFields.length === 0
                ? '执行词库删除'
                : dictFilterEnabled
                  ? '执行词库删除并应用去重'
                  : previewStats
                    ? `✅ 应用去重 (过滤 ${previewStats.willBeRemoved.toLocaleString()} 行)`
                    : '应用去重'}
          </button>
        </div>

        {hasSavedDedupe && onClear && (
          <div className="mt-2">
            <button
              onClick={() => {
                if (confirm('确定要清除去重配置吗？')) {
                  void handleClear();
                }
              }}
              className="w-full px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
            >
              <X className="w-4 h-4" />
              清除去重
            </button>
          </div>
        )}

        {/* Bottom Link */}
        {onSaveAsTemplate && (
          <div className="mt-3 flex justify-center">
            <button
              onClick={handleSaveAsTemplate}
              disabled={partitionByFields.length === 0}
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
