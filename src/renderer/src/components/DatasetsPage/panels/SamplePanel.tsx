/**
 * Sample Panel - 数据采样面板
 * 提供百分比采样、固定行数采样、分层采样
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Plus, Percent, Hash, Layers, HelpCircle, Loader2 } from 'lucide-react';
import { useDatasetFields } from '../../../hooks';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import { OperationLoadingState, PreviewStats } from '../../common/OperationLoadingState';
import { previewDatasetSample } from '../../../services/datasets/datasetPanelService';
import type { SampleConfig } from '../../../../../core/query-engine/types';
import { toast } from '../../../lib/toast';

interface SamplePanelProps {
  datasetId: string;
  onClose: () => void;
  onApply: (config: SampleConfig) => void;
  onSaveAsTemplate?: (config: SampleConfig) => void; // 🆕 保存查询模板回调
  onClear?: () => void; // ✅ 清除采样回调
  anchorEl?: HTMLElement | null;
}

export function SamplePanel({
  datasetId,
  onClose,
  onApply,
  onSaveAsTemplate,
  onClear,
  anchorEl,
}: SamplePanelProps) {
  const { currentDataset, availableFields } = useDatasetFields(datasetId);
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);
  const [sampleType, setSampleType] = useState<'percentage' | 'rows' | 'stratified'>('percentage');
  const [value, setValue] = useState<number>(10);
  const [seed, setSeed] = useState<number | undefined>(42);
  const [useSeed, setUseSeed] = useState(false);
  const [stratifyBy, setStratifyBy] = useState<string[]>([]);

  // Preview state
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<any | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const previewTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 从当前查询配置恢复采样状态，确保面板与实际配置一致
  useEffect(() => {
    const saved = activeQueryConfig?.sample;

    if (saved) {
      setSampleType(saved.type);
      if (typeof saved.value === 'number') {
        setValue(saved.value);
      } else {
        setValue(saved.type === 'rows' ? 1000 : 10);
      }
      setStratifyBy(saved.stratifyBy || []);
      if (saved.seed !== undefined) {
        setUseSeed(true);
        setSeed(saved.seed);
      } else {
        setUseSeed(false);
        setSeed(42);
      }
    } else {
      setSampleType('percentage');
      setValue(10);
      setSeed(42);
      setUseSeed(false);
      setStratifyBy([]);
    }
  }, [activeQueryConfig?.sample, datasetId]);

  // Preview sample with debouncing
  const previewSample = useCallback(
    async (
      type: 'percentage' | 'rows' | 'stratified',
      val: number,
      strat: string[],
      useSd: boolean,
      sd?: number
    ) => {
      // Clear previous timer
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }

      // Validate config
      if (type === 'stratified' && strat.length === 0) {
        setPreviewResult(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      setPreviewLoading(true);
      setPreviewError(null);

      previewTimerRef.current = setTimeout(async () => {
        try {
          const config: SampleConfig = {
            type,
            value: val,
            stratifyBy: type === 'stratified' ? strat : undefined,
            seed: useSd ? sd : undefined,
          };

          const previewQueryConfig = activeQueryConfig
            ? {
                ...JSON.parse(JSON.stringify(activeQueryConfig)),
                sample: undefined,
              }
            : undefined;

          const result = await previewDatasetSample(
            datasetId,
            config,
            previewQueryConfig
          );

          setPreviewResult(result);
          setPreviewError(null);
        } catch (error: any) {
          console.error('[SamplePanel] Failed to preview sample:', error);
          setPreviewError(error.message || '预览失败');
          setPreviewResult(null);
        } finally {
          setPreviewLoading(false);
        }
      }, 500);
    },
    [datasetId, activeQueryConfig]
  );

  // Trigger preview when config changes
  useEffect(() => {
    if (currentDataset) {
      previewSample(sampleType, value, stratifyBy, useSeed, seed);
    }

    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
    };
  }, [sampleType, value, stratifyBy, useSeed, seed, currentDataset, previewSample]);

  // Add stratify field
  const handleAddStratifyField = () => {
    if (availableFields.length === 0) return;
    const firstField = availableFields[0].name;
    if (!stratifyBy.includes(firstField)) {
      setStratifyBy([...stratifyBy, firstField]);
    }
  };

  // Remove stratify field
  const handleRemoveStratifyField = (index: number) => {
    setStratifyBy(stratifyBy.filter((_, i) => i !== index));
  };

  // Update stratify field
  const handleUpdateStratifyField = (index: number, fieldValue: string) => {
    const newFields = [...stratifyBy];
    newFields[index] = fieldValue;
    setStratifyBy(newFields);
  };

  // Apply sampling
  const handleApply = async () => {
    if (sampleType === 'stratified' && stratifyBy.length === 0) {
      toast.warning('分层采样需要至少选择一个分层字段');
      return;
    }

    const config: SampleConfig = {
      type: sampleType,
      value,
      stratifyBy: sampleType === 'stratified' ? stratifyBy : undefined,
      seed: useSeed ? seed : undefined,
    };

    setApplying(true);
    try {
      await onApply(config);
      onClose();
    } finally {
      setApplying(false);
    }
  };

  // 🆕 保存为查询模板
  const handleSaveAsTemplate = () => {
    if (sampleType === 'stratified' && stratifyBy.length === 0) {
      toast.warning('分层采样需要至少选择一个分层字段');
      return;
    }

    const config: SampleConfig = {
      type: sampleType,
      value,
      stratifyBy: sampleType === 'stratified' ? stratifyBy : undefined,
      seed: useSeed ? seed : undefined,
    };

    onSaveAsTemplate?.(config);
  };

  // Title content for AnchoredPanel
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">数据采样</span>
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
        {/* 实时预览 */}
        <div className="mb-4">
          <OperationLoadingState loading={previewLoading} operation="采样预览" />

          {!previewLoading && previewResult && currentDataset && (
            <div className="space-y-3">
              <PreviewStats
                label="采样结果"
                value={`${previewResult.sampleSize.toLocaleString()} 条`}
                description={`采样比例：${(previewResult.samplingRatio * 100).toFixed(2)}%（采样前：${previewResult.stats.originalRows.toLocaleString()} 条）`}
                type="success"
              />

              {/* 采样方法信息 */}
              <div className="p-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600">
                <div>
                  采样方法:{' '}
                  {previewResult.stats.method === 'percentage'
                    ? '百分比采样'
                    : previewResult.stats.method === 'rows'
                      ? '固定行数采样'
                      : '分层采样'}
                </div>
                {previewResult.stats.seed !== undefined && (
                  <div>随机种子: {previewResult.stats.seed}</div>
                )}
                {previewResult.stats.stratifyBy && previewResult.stats.stratifyBy.length > 0 && (
                  <div>分层字段: {previewResult.stats.stratifyBy.join(', ')}</div>
                )}
              </div>

              {previewResult.quality && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 space-y-1">
                  <div>
                    代表性评分: {(previewResult.quality.representativeness * 100).toFixed(1)}%
                  </div>
                  {previewResult.quality.distributionMatch && (
                    <div>分布匹配: {previewResult.quality.distributionMatch}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {!previewLoading && previewError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              预览失败: {previewError}
            </div>
          )}
        </div>

        <div className="space-y-4">
          {/* Sample Type Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">采样方式</label>
            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={() => setSampleType('percentage')}
                className={`
                    p-4 rounded-lg border-2 transition-all
                    ${
                      sampleType === 'percentage'
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }
                  `}
              >
                <Percent
                  className={`w-6 h-6 mx-auto mb-2 ${sampleType === 'percentage' ? 'text-blue-600' : 'text-gray-400'}`}
                />
                <div className="text-sm font-medium text-gray-900">百分比</div>
                <div className="text-xs text-gray-500 mt-1">按比例采样</div>
              </button>

              <button
                onClick={() => setSampleType('rows')}
                className={`
                    p-4 rounded-lg border-2 transition-all
                    ${
                      sampleType === 'rows'
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }
                  `}
              >
                <Hash
                  className={`w-6 h-6 mx-auto mb-2 ${sampleType === 'rows' ? 'text-blue-600' : 'text-gray-400'}`}
                />
                <div className="text-sm font-medium text-gray-900">固定行数</div>
                <div className="text-xs text-gray-500 mt-1">指定数量</div>
              </button>

              <button
                onClick={() => setSampleType('stratified')}
                className={`
                    p-4 rounded-lg border-2 transition-all
                    ${
                      sampleType === 'stratified'
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }
                  `}
              >
                <Layers
                  className={`w-6 h-6 mx-auto mb-2 ${sampleType === 'stratified' ? 'text-blue-600' : 'text-gray-400'}`}
                />
                <div className="text-sm font-medium text-gray-900">分层采样</div>
                <div className="text-xs text-gray-500 mt-1">按分组采样</div>
              </button>
            </div>

            {/* ✅ 采样方式说明 */}
            <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
              <div className="flex items-start gap-2">
                <HelpCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div>
                  {sampleType === 'percentage' ? (
                    <>
                      <strong>百分比采样为近似值</strong>：每行独立随机选择，实际行数会略有波动。
                      如需精确行数，请使用&quot;固定行数&quot;模式。
                    </>
                  ) : sampleType === 'rows' ? (
                    <>
                      <strong>固定行数采样</strong>：保证返回精确的指定行数（除非总数不足）。
                    </>
                  ) : (
                    <>
                      <strong>分层采样</strong>：在每个分组内随机采样指定行数，优先保证各组都有样本。
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Percentage Sampling */}
          {sampleType === 'percentage' && (
            <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
              <label className="block text-sm font-medium text-gray-700 mb-2">采样百分比 (%)</label>
              <input
                type="number"
                min="0.001"
                max="99.9"
                step="0.01"
                value={value}
                onChange={(e) => {
                  const newValue = parseFloat(e.target.value);
                  if (newValue >= 0.001 && newValue <= 99.9) {
                    setValue(newValue);
                  } else if (newValue > 99.9) {
                    setValue(99.9);
                  } else {
                    setValue(0.001);
                  }
                }}
                className={`w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 ${
                  value > 80 ? 'border-orange-300 bg-orange-50' : 'border-gray-300'
                }`}
              />
              <div className="mt-2 space-y-1">
                <p className="text-xs text-gray-500">范围: 0.001% - 99.9%（最多采样1000万行）</p>
                {value > 80 && (
                  <p className="text-xs text-orange-600 flex items-center gap-1">
                    <span>⚠️</span>
                    <span>采样百分比较高，性能提升有限。建议使用全量查询。</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Rows Sampling */}
          {sampleType === 'rows' && (
            <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
              <label className="block text-sm font-medium text-gray-700 mb-2">采样行数</label>
              <input
                type="number"
                min="1"
                max="10000000"
                step="1"
                value={value}
                onChange={(e) => {
                  const newValue = parseInt(e.target.value);
                  if (!isNaN(newValue) && newValue >= 1 && newValue <= 10_000_000) {
                    setValue(newValue);
                  } else if (newValue > 10_000_000) {
                    setValue(10_000_000);
                  } else {
                    setValue(1);
                  }
                }}
                className={`w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 ${
                  value > 1_000_000 ? 'border-orange-300 bg-orange-50' : 'border-gray-300'
                }`}
              />
              <div className="mt-2 space-y-1">
                <p className="text-xs text-gray-500">范围: 1 - 10,000,000 行</p>
                {value > 1_000_000 && (
                  <p className="text-xs text-orange-600 flex items-center gap-1">
                    <span>⚠️</span>
                    <span>采样行数较大，可能影响性能。建议使用百分比采样。</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Stratified Sampling */}
          {sampleType === 'stratified' && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">分层字段</label>
                <div className="space-y-2">
                  {stratifyBy.map((field, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <select
                        value={field}
                        onChange={(e) => handleUpdateStratifyField(index, e.target.value)}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                      >
                        {availableFields.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.name} ({f.type})
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleRemoveStratifyField(index)}
                        className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                        title="删除字段"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={handleAddStratifyField}
                    className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    <span>添加分层字段</span>
                  </button>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                <label className="block text-sm font-medium text-gray-700 mb-2">每组采样行数</label>
                <input
                  type="number"
                  min="1"
                  max="100000"
                  step="1"
                  value={value}
                  onChange={(e) => {
                    const newValue = parseInt(e.target.value);
                    if (!isNaN(newValue) && newValue >= 1 && newValue <= 100_000) {
                      setValue(newValue);
                    } else if (newValue > 100_000) {
                      setValue(100_000);
                    } else {
                      setValue(1);
                    }
                  }}
                  className={`w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 ${
                    value > 10_000 ? 'border-orange-300 bg-orange-50' : 'border-gray-300'
                  }`}
                />
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-gray-500">
                    从每个分组中随机抽取指定数量的记录（最多100,000行）
                  </p>
                  {value > 10_000 && (
                    <p className="text-xs text-orange-600 flex items-center gap-1">
                      <span>⚠️</span>
                      <span>每组采样数量较大，在高基数字段上可能导致性能问题。</span>
                    </p>
                  )}
                  {stratifyBy.length > 3 && (
                    <p className="text-xs text-orange-600 flex items-center gap-1">
                      <span>⚠️</span>
                      <span>分层字段过多（{stratifyBy.length}个），会产生大量分组。</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Random Seed (for percentage and rows) */}
          {(sampleType === 'percentage' || sampleType === 'rows') && (
            <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
              <label className="flex items-center gap-2 mb-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useSeed}
                  onChange={(e) => setUseSeed(e.target.checked)}
                  className="w-4 h-4 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700">
                  使用随机种子（可复现结果）
                </span>
              </label>

              {useSeed && (
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={seed || 0}
                  onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
                  placeholder="输入随机种子"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
          )}
        </div>

        {/* Apply Button */}
        <div className="mt-4">
          <button
            onClick={handleApply}
            disabled={(sampleType === 'stratified' && stratifyBy.length === 0) || applying}
            className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {applying ? '正在应用...' : '应用并刷新结果'}
          </button>
          <p className="mt-2 text-xs text-gray-500 text-center">
            应用后会按当前筛选/排序等已设置条件刷新结果快照
          </p>
        </div>

        {/* ✅ Clear Sample Button */}
        {activeQueryConfig?.sample && onClear && (
          <div className="mt-2">
            <button
              onClick={() => {
                if (confirm('确定要清除采样配置吗？')) {
                  onClear();
                  onClose();
                }
              }}
              className="w-full px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
            >
              <X className="w-4 h-4" />
              清除采样
            </button>
          </div>
        )}

        {/* Bottom Link */}
        {onSaveAsTemplate && (
          <div className="mt-3 flex justify-center">
            <button
              onClick={handleSaveAsTemplate}
              disabled={sampleType === 'stratified' && stratifyBy.length === 0}
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
