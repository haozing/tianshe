/**
 * Lookup Panel - 数据关联面板
 * 提供数据关联功能（JOIN 和码值映射）
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, Plus, HelpCircle, Loader2, CheckCircle, AlertTriangle } from 'lucide-react';
import { useDatasetFields } from '../../../hooks';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import { toast } from '../../../lib/toast';
import { previewDatasetLookup } from '../../../services/datasets/datasetPanelService';
import {
  OperationLoadingState,
  PreviewStats,
  PreviewTable,
  PreviewWarning,
} from '../../common/OperationLoadingState';
import type {
  LookupConfig,
  LookupPreviewResult,
  LookupPreviewStep,
} from '../../../../../core/query-engine/types';

interface LookupPanelProps {
  datasetId: string;
  onClose: () => void;
  onApply: (config: LookupConfig[]) => void;
  anchorEl?: HTMLElement | null;
}

type ValidationErrors = Record<string, string | null>;

function isLookupConfigComplete(lookup: LookupConfig): boolean {
  if (lookup.type === 'join') {
    return Boolean(
      (lookup.lookupDatasetId || lookup.lookupTable) && lookup.joinKey && lookup.lookupKey
    );
  }

  return Boolean(lookup.joinKey && lookup.lookupKey && lookup.codeMapping);
}

function toPreviewSteps(
  previewResult: LookupPreviewResult | null,
  lookups: LookupConfig[]
): LookupPreviewStep[] {
  if (!previewResult) return [];
  if (Array.isArray(previewResult.steps) && previewResult.steps.length > 0) {
    return previewResult.steps;
  }

  if (lookups.length === 0) return [];

  return [
    {
      index: 0,
      lookup: lookups[0],
      stats: previewResult.stats,
      sampleMatched: previewResult.sampleMatched,
      sampleUnmatched: previewResult.sampleUnmatched,
      warnings: previewResult.warnings,
      generatedSQL: previewResult.generatedSQL,
    },
  ];
}

export function LookupPanel({ datasetId, onClose, onApply, anchorEl }: LookupPanelProps) {
  const { datasets } = useDatasetStore();
  const { currentDataset, availableFields } = useDatasetFields(datasetId);
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);
  const [lookups, setLookups] = useState<Map<string, LookupConfig>>(new Map());
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<LookupPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const previewTimerRef = useRef<NodeJS.Timeout | null>(null);
  const previewRequestIdRef = useRef(0);

  const lookupEntries = useMemo(() => Array.from(lookups.entries()), [lookups]);
  const lookupConfigs = useMemo(() => lookupEntries.map(([, lookup]) => lookup), [lookupEntries]);
  const existingColumnNames = useMemo(
    () => availableFields.map((field) => field.name),
    [availableFields]
  );

  useEffect(() => {
    const persistedLookups = activeQueryConfig?.lookup as LookupConfig[] | undefined;
    if (!persistedLookups || persistedLookups.length === 0) return;

    setLookups((prev) => {
      if (prev.size > 0) return prev;
      const next = new Map<string, LookupConfig>();
      persistedLookups.forEach((cfg, idx) => {
        next.set(`lookup_${idx}`, cfg);
      });
      return next;
    });
  }, [activeQueryConfig?.lookup]);

  const setLookupValidationError = useCallback((lookupId: string, message: string | null) => {
    setValidationErrors((prev) => {
      if ((prev[lookupId] ?? null) === (message ?? null)) {
        return prev;
      }

      const next = { ...prev };
      if (message) {
        next[lookupId] = message;
      } else {
        delete next[lookupId];
      }
      return next;
    });
  }, []);

  const previewLookup = useCallback(
    async (configs: LookupConfig[], errors: ValidationErrors) => {
      const requestId = ++previewRequestIdRef.current;

      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }

      if (configs.length === 0) {
        setPreviewResult(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      const firstValidationError = Object.values(errors).find((message): message is string =>
        Boolean(message)
      );
      if (firstValidationError) {
        setPreviewResult(null);
        setPreviewError(firstValidationError);
        setPreviewLoading(false);
        return;
      }

      if (!configs.every(isLookupConfigComplete)) {
        setPreviewResult(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      setPreviewError(null);

      previewTimerRef.current = setTimeout(async () => {
        if (requestId !== previewRequestIdRef.current) return;

        setPreviewLoading(true);
        try {
          const result = await previewDatasetLookup(datasetId, configs, {
            limit: 5,
          });

          if (requestId !== previewRequestIdRef.current) return;

          setPreviewResult(result);
          setPreviewError(null);
        } catch (error: any) {
          if (requestId !== previewRequestIdRef.current) return;
          console.error('[LookupPanel] Failed to preview lookup:', error);
          setPreviewError(error.message || '预览失败');
          setPreviewResult(null);
        } finally {
          if (requestId === previewRequestIdRef.current) {
            setPreviewLoading(false);
          }
        }
      }, 400);
    },
    [datasetId]
  );

  useEffect(() => {
    if (currentDataset) {
      void previewLookup(lookupConfigs, validationErrors);
    }

    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
    };
  }, [lookupConfigs, currentDataset, previewLookup, validationErrors]);

  const lookupDatasets = useMemo(() => {
    return datasets.filter((ds) => ds.id !== datasetId);
  }, [datasets, datasetId]);

  const previewSteps = useMemo(
    () => toPreviewSteps(previewResult, lookupConfigs),
    [previewResult, lookupConfigs]
  );

  const handleAddLookup = () => {
    const lookupId = `lookup_${Date.now()}`;
    const defaultJoinField = availableFields[0]?.name || '';
    setLookups((prev) => {
      const next = new Map(prev);
      next.set(lookupId, {
        type: 'join',
        joinKey: defaultJoinField,
        lookupKey: '',
        leftJoin: true,
      });
      return next;
    });
  };

  const handleUpdateLookup = (lookupId: string, updates: Partial<LookupConfig>) => {
    setLookups((prev) => {
      const next = new Map(prev);
      const existing = next.get(lookupId);
      if (!existing) {
        return prev;
      }

      if (updates.type && updates.type !== existing.type) {
        next.set(lookupId, {
          type: updates.type,
          joinKey: existing.joinKey,
          lookupKey: '',
          leftJoin: true,
        } as LookupConfig);
      } else {
        next.set(lookupId, { ...existing, ...updates });
      }

      return next;
    });
  };

  const handleRemoveLookup = (lookupId: string) => {
    setLookups((prev) => {
      const next = new Map(prev);
      next.delete(lookupId);
      return next;
    });
    setLookupValidationError(lookupId, null);
  };

  const handleApply = async () => {
    if (lookupConfigs.length === 0) {
      toast.warning('请至少添加一个关联');
      return;
    }

    const firstValidationError = Object.values(validationErrors).find(
      (message): message is string => Boolean(message)
    );
    if (firstValidationError) {
      toast.warning(firstValidationError);
      return;
    }

    if (!lookupConfigs.every(isLookupConfigComplete)) {
      toast.warning('请先补全所有关联配置');
      return;
    }

    setApplying(true);
    try {
      await onApply(lookupConfigs);
      onClose();
    } finally {
      setApplying(false);
    }
  };

  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">数据关联</span>
      <HelpCircle size={16} className="text-gray-400" />
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl ?? null}
      title={titleContent}
      width="720px"
    >
      <div className="px-5 py-3">
        <div className="space-y-4">
          {lookupEntries.map(([lookupId, lookup]) => (
            <LookupCard
              key={lookupId}
              lookupId={lookupId}
              lookup={lookup}
              availableFields={availableFields}
              existingColumnNames={existingColumnNames}
              lookupDatasets={lookupDatasets}
              onUpdate={handleUpdateLookup}
              onRemove={handleRemoveLookup}
              onValidationChange={setLookupValidationError}
            />
          ))}

          <button
            onClick={handleAddLookup}
            className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>添加关联</span>
          </button>

          {lookupConfigs.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <OperationLoadingState loading={previewLoading} operation="关联预览" />

              {!previewLoading && previewSteps.length > 0 && currentDataset && (
                <div className="space-y-4">
                  {previewSteps.map((step) => (
                    <LookupPreviewSection
                      key={`${step.index}-${step.lookup.type}`}
                      step={step}
                      stepCount={previewSteps.length}
                    />
                  ))}
                </div>
              )}

              {!previewLoading && previewError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  预览失败: {previewError}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4">
          <button
            onClick={handleApply}
            disabled={lookupConfigs.length === 0 || applying}
            className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {applying
              ? '正在关联...'
              : `应用关联${lookupConfigs.length > 0 ? ` (${lookupConfigs.length}个)` : ''}`}
          </button>
        </div>

        <div className="mt-3 text-xs text-gray-500">
          当前关联配置会自动保存到当前查询模板，不需要额外点“保存查询模板”。
        </div>
      </div>
    </AnchoredPanel>
  );
}

function LookupPreviewSection({ step, stepCount }: { step: LookupPreviewStep; stepCount: number }) {
  const title =
    stepCount > 1
      ? `关联 ${step.index + 1} · ${step.lookup.type === 'join' ? 'JOIN' : 'MAP'}`
      : '关联预览';

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 p-3">
      <div className="text-sm font-medium text-gray-700">{title}</div>

      <div className="grid grid-cols-3 gap-3">
        <PreviewStats
          icon={<CheckCircle />}
          label="匹配主表行数"
          value={step.stats.matchedRows.toLocaleString()}
          description={`匹配率: ${(step.stats.matchRate * 100).toFixed(1)}%`}
          type="success"
        />
        <PreviewStats
          icon={<AlertTriangle />}
          label="未匹配主表行数"
          value={step.stats.unmatchedRows.toLocaleString()}
          description={`${step.stats.totalRows > 0 ? ((step.stats.unmatchedRows / step.stats.totalRows) * 100).toFixed(1) : '0.0'}%`}
          type={step.stats.unmatchedRows > 0 ? 'warning' : 'info'}
        />
        <PreviewStats
          label="执行后行数"
          value={(step.stats.resultRows ?? step.stats.totalRows).toLocaleString()}
          description="按当前关联配置执行后的记录数"
          type="info"
        />
      </div>

      {step.warnings && step.warnings.length > 0 && (
        <div className="space-y-2">
          {step.warnings.map((warning, idx) => (
            <PreviewWarning key={idx} title="注意" message={warning} />
          ))}
        </div>
      )}

      {step.sampleMatched.length > 0 && (
        <PreviewTable
          title="匹配样本（前5条）"
          columns={Object.keys(step.sampleMatched[0])}
          rows={step.sampleMatched}
          maxRows={5}
        />
      )}

      {step.sampleUnmatched.length > 0 && (
        <PreviewTable
          title="未匹配样本（前5条）"
          columns={Object.keys(step.sampleUnmatched[0])}
          rows={step.sampleUnmatched}
          maxRows={5}
        />
      )}
    </div>
  );
}

interface LookupCardProps {
  lookupId: string;
  lookup: LookupConfig;
  availableFields: Array<{ name: string; type: string; fieldType: string }>;
  existingColumnNames: string[];
  lookupDatasets: Array<{ id: string; name: string; rowCount: number }>;
  onUpdate: (lookupId: string, updates: Partial<LookupConfig>) => void;
  onRemove: (lookupId: string) => void;
  onValidationChange: (lookupId: string, message: string | null) => void;
}

function LookupCard({
  lookupId,
  lookup,
  availableFields,
  existingColumnNames,
  lookupDatasets,
  onUpdate,
  onRemove,
  onValidationChange,
}: LookupCardProps) {
  const { availableFields: lookupDatasetFields, isLoading: lookupDatasetLoading } =
    useDatasetFields(lookup.lookupDatasetId || '');
  const [codeMappingText, setCodeMappingText] = useState(
    lookup.codeMapping
      ? JSON.stringify(lookup.codeMapping, null, 2)
      : '{\n  "1": "Male",\n  "2": "Female"\n}'
  );
  const [codeMappingError, setCodeMappingError] = useState<string | null>(null);

  useEffect(() => {
    setCodeMappingText(
      lookup.codeMapping
        ? JSON.stringify(lookup.codeMapping, null, 2)
        : '{\n  "1": "Male",\n  "2": "Female"\n}'
    );
    setCodeMappingError(null);
  }, [lookup.codeMapping, lookup.type]);

  useEffect(() => {
    let nextError: string | null = null;

    if (lookup.type === 'map') {
      const outputName = lookup.lookupKey.trim();
      if (!outputName) {
        nextError = '输出列名不能为空';
      } else if (existingColumnNames.includes(outputName)) {
        nextError = `输出列名 '${outputName}' 已存在，请换一个名字`;
      } else if (codeMappingError) {
        nextError = codeMappingError;
      }
    }

    onValidationChange(lookupId, nextError);

    return () => {
      onValidationChange(lookupId, null);
    };
  }, [
    codeMappingError,
    existingColumnNames,
    lookup.lookupKey,
    lookup.type,
    lookupId,
    onValidationChange,
  ]);

  const selectedLookupColumns = lookup.selectColumns ?? [];

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white hover:border-blue-300 transition-colors">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-700 mb-1">关联类型</label>
            <select
              value={lookup.type}
              onChange={(e) => onUpdate(lookupId, { type: e.target.value as 'join' | 'map' })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
            >
              <option value="join">JOIN 关联</option>
              <option value="map">码值映射</option>
            </select>
          </div>
          <div className="pt-5">
            <button
              onClick={() => onRemove(lookupId)}
              className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
              title="删除关联"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {lookup.type === 'join' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">主表关联键</label>
                <select
                  value={lookup.joinKey}
                  onChange={(e) => onUpdate(lookupId, { joinKey: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
                >
                  {availableFields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">维表关联键</label>
                {lookup.lookupDatasetId ? (
                  <select
                    value={lookup.lookupKey}
                    onChange={(e) => onUpdate(lookupId, { lookupKey: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
                    disabled={lookupDatasetLoading || lookupDatasetFields.length === 0}
                  >
                    <option value="">
                      {lookupDatasetLoading ? '加载维表字段中...' : '选择维表字段'}
                    </option>
                    {lookupDatasetFields.map((field) => (
                      <option key={field.name} value={field.name}>
                        {field.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={lookup.lookupKey}
                    onChange={(e) => onUpdate(lookupId, { lookupKey: e.target.value })}
                    placeholder="维表中的字段名"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
                  />
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">维表数据集</label>
              <select
                value={lookup.lookupDatasetId || ''}
                onChange={(e) =>
                  onUpdate(lookupId, {
                    lookupDatasetId: e.target.value || undefined,
                    lookupKey: '',
                    selectColumns: undefined,
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
              >
                <option value="">选择维表数据集</option>
                {lookupDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} ({dataset.rowCount} 行)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">要获取的列</label>
              <select
                multiple={true}
                size={Math.min(Math.max(lookupDatasetFields.length, 3), 8)}
                value={selectedLookupColumns}
                onChange={(e) => {
                  const columns = Array.from(e.currentTarget.selectedOptions).map(
                    (option) => option.value
                  );
                  onUpdate(lookupId, {
                    selectColumns: columns.length > 0 ? columns : undefined,
                  });
                }}
                disabled={
                  !lookup.lookupDatasetId ||
                  lookupDatasetLoading ||
                  lookupDatasetFields.length === 0
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
              >
                {lookupDatasetFields.map((field) => (
                  <option key={field.name} value={field.name}>
                    {field.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                留空时默认带回维表所有非系统列。按住 Ctrl 或 Command 可多选。
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`leftJoin_${lookupId}`}
                checked={lookup.leftJoin || false}
                onChange={(e) => onUpdate(lookupId, { leftJoin: e.target.checked })}
                className="w-4 h-4 text-blue-600 focus:ring-blue-500"
              />
              <label htmlFor={`leftJoin_${lookupId}`} className="text-sm text-gray-700">
                LEFT JOIN (保留主表所有记录)
              </label>
            </div>
          </div>
        )}

        {lookup.type === 'map' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">源字段</label>
                <select
                  value={lookup.joinKey}
                  onChange={(e) => onUpdate(lookupId, { joinKey: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
                >
                  {availableFields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">输出列名</label>
                <input
                  type="text"
                  value={lookup.lookupKey}
                  onChange={(e) => onUpdate(lookupId, { lookupKey: e.target.value })}
                  placeholder="映射后的列名"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {existingColumnNames.includes(lookup.lookupKey.trim()) && lookup.lookupKey.trim() && (
              <div className="text-xs text-red-600">
                输出列名与现有列重复，当前实现不再允许覆盖原列。
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                码值映射 (JSON)
              </label>
              <textarea
                value={codeMappingText}
                onChange={(e) => {
                  const nextText = e.target.value;
                  setCodeMappingText(nextText);

                  try {
                    const mapping = JSON.parse(nextText);
                    setCodeMappingError(null);
                    onUpdate(lookupId, { codeMapping: mapping });
                  } catch {
                    setCodeMappingError('码值映射 JSON 无法解析，当前不会应用这次修改');
                  }
                }}
                rows={6}
                placeholder='{"1": "Male", "2": "Female"}'
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">JSON 格式：键为源值，值为映射后的值</p>
              {codeMappingError && <p className="text-xs text-red-600 mt-1">{codeMappingError}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
