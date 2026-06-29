/**
 * Aggregate Panel - 数据聚合面板
 * 提供分组聚合功能，支持 GROUP BY 和多种聚合函数
 */

import { useState } from 'react';
import {
  X,
  Plus,
  BarChart3,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { useDatasetFields, usePreviewState } from '../../../hooks';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import { toast } from '../../../lib/toast';
import { previewDatasetAggregate } from '../../../services/datasets/datasetPanelService';
import {
  OperationLoadingState,
  PreviewStats,
  PreviewTable,
  PreviewWarning,
} from '../../common/OperationLoadingState';
import { shouldShowPaginationWarning } from '../../../lib/pagination-strategy';
import type {
  AggregateConfig,
  AggregateMeasure,
  FilterCondition,
} from '../../../../../core/query-engine/types';

interface AggregatePanelProps {
  datasetId: string;
  onClose: () => void;
  onApply: (config: AggregateConfig) => Promise<void> | void;
  onClear?: () => Promise<void> | void;
  onSaveAsTemplate?: (config: AggregateConfig) => void; // 🆕 保存查询模板回调
  anchorEl?: HTMLElement | null;
}

export function AggregatePanel({
  datasetId,
  onClose,
  onApply,
  onClear,
  onSaveAsTemplate,
  anchorEl,
}: AggregatePanelProps) {
  const currentConfig = useDatasetStore(selectActiveQueryConfig)?.aggregate;
  const [groupByFields, setGroupByFields] = useState<string[]>(() => currentConfig?.groupBy ?? []);
  const [measures, setMeasures] = useState<Map<string, AggregateMeasure>>(
    () =>
      new Map(
        (currentConfig?.measures ?? []).map((measure, index) => [`measure_${index}`, measure])
      )
  );
  const [showHaving, setShowHaving] = useState(
    () => (currentConfig?.having?.conditions?.length ?? 0) > 0
  ); // 🆕 是否显示HAVING编辑器
  const [havingConditions, setHavingConditions] = useState<FilterCondition[]>(
    () => currentConfig?.having?.conditions ?? []
  ); // 🆕 HAVING条件
  const [applying, setApplying] = useState(false);

  // 🆕 使用 useDatasetFields Hook（包含数值字段）
  const {
    availableFields,
    numericFields = [],
    currentDataset,
  } = useDatasetFields(datasetId, {
    includeNumericFields: true,
  });

  // 🆕 使用 usePreviewState Hook 管理预览状态
  const preview = usePreviewState(
    async () => {
      if (groupByFields.length === 0 || measures.size === 0) {
        return null;
      }

      const config: AggregateConfig = {
        groupBy: groupByFields,
        measures: Array.from(measures.values()),
        having: havingConditions.length > 0 ? { conditions: havingConditions } : undefined,
      };

      return await previewDatasetAggregate(datasetId, config, {
        limit: 5,
      });
    },
    [groupByFields, measures, havingConditions, currentDataset, datasetId],
    { debounceMs: 500 }
  );

  // Add group by field
  const handleAddGroupBy = () => {
    if (availableFields.length === 0) return;
    const firstField = availableFields[0].name;
    if (!groupByFields.includes(firstField)) {
      setGroupByFields([...groupByFields, firstField]);
    }
  };

  // Remove group by field
  const handleRemoveGroupBy = (index: number) => {
    setGroupByFields(groupByFields.filter((_, i) => i !== index));
  };

  // Update group by field
  const handleUpdateGroupBy = (index: number, value: string) => {
    const newFields = [...groupByFields];
    newFields[index] = value;
    setGroupByFields(newFields);
  };

  // Add measure
  const handleAddMeasure = () => {
    const measureId = `measure_${Date.now()}`;
    const newMeasure: AggregateMeasure = {
      name: `count_${measures.size + 1}`,
      function: 'COUNT',
      field: undefined,
    };
    setMeasures(new Map(measures).set(measureId, newMeasure));
  };

  // Update measure
  const handleUpdateMeasure = (measureId: string, updates: Partial<AggregateMeasure>) => {
    setMeasures((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(measureId);
      if (existing) {
        newMap.set(measureId, { ...existing, ...updates });
      }
      return newMap;
    });
  };

  // Remove measure
  const handleRemoveMeasure = (measureId: string) => {
    setMeasures((prev) => {
      const newMap = new Map(prev);
      newMap.delete(measureId);
      return newMap;
    });
  };

  // Apply aggregation
  const buildConfig = (): AggregateConfig => ({
    groupBy: groupByFields,
    measures: Array.from(measures.values()),
    having: havingConditions.length > 0 ? { conditions: havingConditions } : undefined,
  });

  const handleApply = async () => {
    if (groupByFields.length === 0) {
      toast.warning('请至少选择一个分组字段');
      return;
    }
    if (measures.size === 0) {
      toast.warning('请至少添加一个聚合指标');
      return;
    }

    setApplying(true);
    try {
      await onApply(buildConfig());
    } finally {
      setApplying(false);
    }
  };

  // Get aggregate functions that require a field
  const requiresField = (func: string): boolean => {
    // COUNT(*) 不需要字段，其他都需要
    return func !== 'COUNT';
  };

  // 🆕 保存为查询模板
  const handleSaveAsTemplate = () => {
    if (groupByFields.length === 0) {
      toast.warning('请至少选择一个分组字段');
      return;
    }
    if (measures.size === 0) {
      toast.warning('请至少添加一个聚合指标');
      return;
    }

    // 调用父组件的回调
    if (onSaveAsTemplate) {
      onSaveAsTemplate(buildConfig());
    }
  };

  const handleClear = async () => {
    if (!onClear) return;

    setApplying(true);
    try {
      await onClear();
    } finally {
      setApplying(false);
    }
  };

  // Title content for AnchoredPanel
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">数据聚合</span>
      <HelpCircle size={16} className="text-gray-400" />
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl ?? null}
      title={titleContent}
      width="680px"
    >
      <div className="px-5 py-3">
        <div className="space-y-4">
          {/* Group By Section */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">🔍 分组字段 (GROUP BY)</h3>
            <div className="space-y-2">
              {groupByFields.map((field, index) => (
                <div key={index} className="flex items-center gap-2">
                  <select
                    value={field}
                    onChange={(e) => handleUpdateGroupBy(index, e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {availableFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name} ({f.type})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleRemoveGroupBy(index)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                    title="删除分组字段"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={handleAddGroupBy}
                className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>添加分组字段</span>
              </button>
            </div>
          </div>

          {/* Measures Section */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">📈 聚合指标</h3>
            <div className="space-y-3">
              {Array.from(measures.entries()).map(([measureId, measure]) => (
                <div
                  key={measureId}
                  className="border border-gray-200 rounded-lg p-4 bg-white hover:border-blue-300 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {/* Function Selection */}
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        聚合函数
                      </label>
                      <select
                        value={measure.function}
                        onChange={(e) =>
                          handleUpdateMeasure(measureId, {
                            function: e.target.value as any,
                            field: requiresField(e.target.value)
                              ? numericFields[0]?.name || ''
                              : undefined,
                          })
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <optgroup label="基础聚合">
                          <option value="COUNT">计数 (COUNT)</option>
                          <option value="COUNT_DISTINCT">去重计数 (COUNT DISTINCT)</option>
                          <option value="SUM">求和 (SUM)</option>
                          <option value="AVG">平均值 (AVG)</option>
                          <option value="MAX">最大值 (MAX)</option>
                          <option value="MIN">最小值 (MIN)</option>
                          <option value="STDDEV">标准差 (STDDEV)</option>
                          <option value="VARIANCE">方差 (VARIANCE)</option>
                        </optgroup>
                        <optgroup label="数组聚合">
                          <option value="STRING_AGG">字符串聚合 (STRING_AGG)</option>
                          <option value="ARRAY_AGG">数组聚合 (ARRAY_AGG)</option>
                          <option value="LIST">去重数组 (LIST)</option>
                        </optgroup>
                        <optgroup label="统计聚合">
                          <option value="MEDIAN">中位数 (MEDIAN)</option>
                          <option value="MODE">众数 (MODE)</option>
                          <option value="QUANTILE">分位数 (QUANTILE)</option>
                          <option value="APPROX_COUNT_DISTINCT">近似去重 (APPROX)</option>
                        </optgroup>
                        <optgroup label="条件聚合">
                          <option value="ARG_MIN">最小值对应字段 (ARG_MIN)</option>
                          <option value="ARG_MAX">最大值对应字段 (ARG_MAX)</option>
                          <option value="FIRST">首个值 (FIRST)</option>
                          <option value="LAST">末尾值 (LAST)</option>
                        </optgroup>
                        <optgroup label="高级聚合">
                          <option value="HISTOGRAM">直方图 (HISTOGRAM)</option>
                        </optgroup>
                      </select>
                    </div>

                    {/* Field Selection (if required) */}
                    {requiresField(measure.function) && (
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-700 mb-1">字段</label>
                        <select
                          value={measure.field || ''}
                          onChange={(e) =>
                            handleUpdateMeasure(measureId, { field: e.target.value })
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          {(['SUM', 'AVG', 'STDDEV', 'VARIANCE'].includes(measure.function)
                            ? numericFields
                            : availableFields
                          ).map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Alias Name */}
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        结果列名
                      </label>
                      <input
                        type="text"
                        value={measure.name}
                        onChange={(e) => handleUpdateMeasure(measureId, { name: e.target.value })}
                        placeholder="输入列名"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>

                    {/* Remove Button */}
                    <div className="pt-5">
                      <button
                        onClick={() => handleRemoveMeasure(measureId)}
                        className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                        title="删除指标"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={handleAddMeasure}
                className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>添加聚合指标</span>
              </button>
            </div>
          </div>

          {/* 🆕 HAVING 条件 (可选) */}
          <div>
            <button
              onClick={() => setShowHaving(!showHaving)}
              className="w-full flex items-center justify-between py-2 text-sm font-medium text-gray-700 hover:text-gray-900"
            >
              <span>🔍 HAVING 条件 (可选)</span>
              {showHaving ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>

            {showHaving && (
              <div className="mt-2 space-y-3">
                {havingConditions.map((condition, index) => (
                  <div key={index} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                    <div className="flex items-center gap-2">
                      {/* 字段选择 */}
                      <select
                        value={condition.field}
                        onChange={(e) => {
                          const newConditions = [...havingConditions];
                          newConditions[index] = { ...condition, field: e.target.value };
                          setHavingConditions(newConditions);
                        }}
                        className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                      >
                        <option value="">选择字段</option>
                        <optgroup label="分组字段">
                          {groupByFields.map((field) => (
                            <option key={field} value={field}>
                              {field}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="聚合指标">
                          {Array.from(measures.values()).map((m) => (
                            <option key={m.name} value={m.name}>
                              {m.name}
                            </option>
                          ))}
                        </optgroup>
                      </select>

                      {/* 运算符 */}
                      <select
                        value={condition.type}
                        onChange={(e) => {
                          const newConditions = [...havingConditions];
                          newConditions[index] = { ...condition, type: e.target.value as any };
                          setHavingConditions(newConditions);
                        }}
                        className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
                      >
                        <option value="greater_than">&gt;</option>
                        <option value="less_than">&lt;</option>
                        <option value="greater_equal">&gt;=</option>
                        <option value="less_equal">&lt;=</option>
                        <option value="equal">=</option>
                        <option value="not_equal">!=</option>
                      </select>

                      {/* 值 */}
                      <input
                        type="number"
                        value={condition.value || ''}
                        onChange={(e) => {
                          const newConditions = [...havingConditions];
                          newConditions[index] = {
                            ...condition,
                            value: parseFloat(e.target.value),
                          };
                          setHavingConditions(newConditions);
                        }}
                        placeholder="值"
                        className="w-24 px-2 py-1 border border-gray-300 rounded text-sm"
                      />

                      {/* 删除按钮 */}
                      <button
                        onClick={() => {
                          setHavingConditions(havingConditions.filter((_, i) => i !== index));
                        }}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}

                {/* 添加条件按钮 */}
                <button
                  onClick={() => {
                    setHavingConditions([
                      ...havingConditions,
                      {
                        type: 'greater_than',
                        field: groupByFields[0] || Array.from(measures.values())[0]?.name || '',
                        value: 0,
                      },
                    ]);
                  }}
                  className="w-full py-2 border border-dashed border-gray-300 rounded text-sm text-gray-600 hover:border-blue-500 hover:text-blue-600 flex items-center justify-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  <span>添加HAVING条件</span>
                </button>

                <p className="text-xs text-gray-500 mt-2">
                  💡 HAVING用于筛选聚合后的结果，例如：订单数量 &gt; 10
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 🆕 预览区域 */}
        {groupByFields.length > 0 && measures.size > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <OperationLoadingState loading={preview.loading} operation="聚合预览" />

            {!preview.loading && preview.data && (
              <div className="space-y-3">
                <PreviewStats
                  label="聚合结果"
                  value={`${preview.data.estimatedRows.toLocaleString()} 条`}
                  description={`数据降维：${(preview.data.reductionRatio * 100).toFixed(1)}%（原始：${preview.data.stats.originalRows.toLocaleString()} 条）`}
                  type="success"
                />

                {preview.data.sampleRows && preview.data.sampleRows.length > 0 && (
                  <PreviewTable
                    title="预览（前5条）"
                    columns={Object.keys(preview.data.sampleRows[0])}
                    rows={preview.data.sampleRows}
                    maxRows={5}
                  />
                )}

                {shouldShowPaginationWarning('aggregate', preview.data.estimatedRows).show && (
                  <PreviewWarning
                    title="数据量提示"
                    message={
                      shouldShowPaginationWarning('aggregate', preview.data.estimatedRows).message!
                    }
                  />
                )}
              </div>
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

        {/* Apply Button */}
        <div className="mt-4">
          <button
            onClick={handleApply}
            disabled={groupByFields.length === 0 || measures.size === 0 || applying}
            className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {applying ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-4 w-4 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                应用中...
              </span>
            ) : (
              <>
                <BarChart3 className="w-4 h-4" />
                <span>应用聚合 {measures.size > 0 && `(${measures.size}个指标)`}</span>
              </>
            )}
          </button>
        </div>

        {/* Bottom Actions */}
        <div className="mt-3 flex items-center justify-between">
          {currentConfig ? (
            <button
              onClick={() => {
                void handleClear();
              }}
              disabled={applying}
              className="text-sm text-red-600 hover:text-red-700 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              清除聚合
            </button>
          ) : (
            <div />
          )}

          <button
            onClick={handleSaveAsTemplate}
            disabled={groupByFields.length === 0 || measures.size === 0 || applying}
            className="text-sm text-blue-600 hover:text-blue-700 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            保存查询模板
          </button>
        </div>
      </div>
    </AnchoredPanel>
  );
}
