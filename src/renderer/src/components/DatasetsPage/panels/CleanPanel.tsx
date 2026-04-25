/**
 * Clean Panel - 数据清洗面板
 * 提供数据清洗功能（去空格、大小写转换、替换、单位换算等）
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { X, Plus, Trash2, HelpCircle, AlertCircle, Sparkles, Save, Eye } from 'lucide-react';
import { useImmer } from 'use-immer';
import { useDatasetFields, usePreviewState } from '../../../hooks';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import { toast } from '../../../lib/toast';
import {
  materializeDatasetCleanColumns,
  previewDatasetClean,
} from '../../../services/datasets/datasetPanelService';
import {
  OperationLoadingState,
  PreviewStats,
  PreviewTable,
  PreviewWarning,
} from '../../common/OperationLoadingState';
import type {
  CleanConfig,
  CleanFieldConfig,
  CleanOperation,
  CleanPreviewResult,
} from '../../../../../core/query-engine/types';
import { buildMaterializedCleanColumnSpecs } from '../../../../../utils/clean-materialization';

interface CleanPanelProps {
  datasetId: string;
  onClose: () => void;
  onApply: (config: CleanConfig) => Promise<void> | void;
  onSaveAsTemplate?: (config: CleanConfig) => void;
  onClear?: () => Promise<void> | void;
  anchorEl?: HTMLElement | null;
}

function toEditableCleanFields(config?: CleanConfig): Record<string, CleanFieldConfig> {
  const editableFields: Record<string, CleanFieldConfig> = {};

  (config || []).forEach((field, index) => {
    editableFields[`field_${index}`] = {
      ...field,
      outputField: field.outputField?.trim() || undefined,
      operations:
        field.operations && field.operations.length > 0
          ? [...field.operations]
          : [{ type: 'trim' }],
    };
  });

  return editableFields;
}

function normalizeCleanConfig(cleanFields: Record<string, CleanFieldConfig>): CleanConfig {
  return Object.values(cleanFields).map((field) => ({
    ...field,
    outputField: field.outputField?.trim() || undefined,
    operations:
      field.operations && field.operations.length > 0 ? [...field.operations] : [{ type: 'trim' }],
  }));
}

export function CleanPanel({
  datasetId,
  onClose,
  onApply,
  onSaveAsTemplate,
  onClear,
  anchorEl,
}: CleanPanelProps) {
  const [cleanFields, updateCleanFields] = useImmer<Record<string, CleanFieldConfig>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [materializing, setMaterializing] = useState(false);
  const [applying, setApplying] = useState(false);
  const { currentDataset, applyLocalDatasetSchema } = useDatasetStore();
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);

  // 🆕 使用 useDatasetFields Hook
  const { availableFields } = useDatasetFields(datasetId);
  const cleanConfig = useMemo(() => normalizeCleanConfig(cleanFields), [cleanFields]);
  const hasSavedClean = Boolean(activeQueryConfig?.clean?.length);

  useEffect(() => {
    updateCleanFields(() => toEditableCleanFields(activeQueryConfig?.clean));
    setValidationError(null);
  }, [activeQueryConfig?.clean, updateCleanFields]);

  const preview = usePreviewState<CleanPreviewResult | null>(
    async () => {
      if (cleanConfig.length === 0) {
        return null;
      }

      return await previewDatasetClean(datasetId, cleanConfig, { limit: 10 });
    },
    [datasetId, cleanConfig, currentDataset?.id],
    { debounceMs: 500 }
  );

  // Add field to clean
  const handleAddField = useCallback(() => {
    if (availableFields.length === 0) return;
    const fieldId = `field_${Date.now()}`;
    updateCleanFields((draft) => {
      const baseField = availableFields[0].name;
      const newField: CleanFieldConfig = {
        field: baseField,
        outputField: undefined,
        operations: [{ type: 'trim' }],
      };
      draft[fieldId] = newField;
    });
  }, [availableFields, updateCleanFields]);

  // Update field
  const handleUpdateField = useCallback(
    (fieldId: string, updates: Partial<CleanFieldConfig>) => {
      updateCleanFields((draft) => {
        const existing = draft[fieldId];
        if (!existing) return;
        Object.assign(existing, updates);
      });
    },
    [updateCleanFields]
  );

  // Remove field
  const handleRemoveField = useCallback(
    (fieldId: string) => {
      updateCleanFields((draft) => {
        delete draft[fieldId];
      });
    },
    [updateCleanFields]
  );

  // Add operation to field
  const handleAddOperation = useCallback(
    (fieldId: string) => {
      updateCleanFields((draft) => {
        if (draft[fieldId]) {
          draft[fieldId].operations.push({ type: 'trim' });
        }
      });
    },
    [updateCleanFields]
  );

  // Update operation
  const handleUpdateOperation = useCallback(
    (fieldId: string, opIndex: number, updates: Partial<CleanOperation>) => {
      updateCleanFields((draft) => {
        if (draft[fieldId] && draft[fieldId].operations[opIndex]) {
          Object.assign(draft[fieldId].operations[opIndex], updates);
        }
      });
    },
    [updateCleanFields]
  );

  // Remove operation
  const handleRemoveOperation = useCallback(
    (fieldId: string, opIndex: number) => {
      updateCleanFields((draft) => {
        if (draft[fieldId] && draft[fieldId].operations.length > 1) {
          draft[fieldId].operations.splice(opIndex, 1);
        }
      });
    },
    [updateCleanFields]
  );

  const handleApply = useCallback(async () => {
    if (cleanConfig.length === 0) {
      toast.warning('请至少添加一个清洗字段');
      return;
    }

    setValidationError(null);
    setApplying(true);

    try {
      await onApply(cleanConfig);
      onClose();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setValidationError(message);
      toast.error('应用清洗失败', message);
    } finally {
      setApplying(false);
    }
  }, [cleanConfig, onApply, onClose]);

  const handleClear = useCallback(async () => {
    if (!onClear) return;

    try {
      await onClear();
      onClose();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setValidationError(message);
      toast.error('清除清洗失败', message);
    }
  }, [onClear, onClose]);

  const handleSaveAsTemplate = useCallback(() => {
    if (cleanConfig.length === 0) {
      toast.warning('请至少添加一个清洗字段');
      return;
    }

    onSaveAsTemplate?.(cleanConfig);
  }, [cleanConfig, onSaveAsTemplate]);

  // 物化写入到新列
  const handleMaterializeToNewColumns = useCallback(async () => {
    if (materializing) return;

    if (cleanConfig.length === 0) {
      setValidationError('请至少添加一个清洗字段');
      return;
    }

    const missingOutputFields = cleanConfig
      .filter((c) => !(c.outputField && c.outputField.trim()))
      .map((c) => c.field);

    if (missingOutputFields.length > 0) {
      setValidationError(`请为所有字段填写“输出列名”（未填写：${missingOutputFields.join(', ')}）`);
      return;
    }

    const outputFields = cleanConfig.map((c) => c.outputField!.trim());

    const duplicate = outputFields.find((name, idx) => outputFields.indexOf(name) !== idx);
    if (duplicate) {
      setValidationError(`输出列名重复：${duplicate}`);
      return;
    }

    const sameAsSource = cleanConfig.find((c) => c.outputField && c.outputField.trim() === c.field);
    if (sameAsSource?.outputField) {
      setValidationError(
        `输出列名不能与源字段同名：${sameAsSource.outputField}（物化写入仅支持写入新列以保留原数据）`
      );
      return;
    }

    if (
      !confirm(
        '将把清洗结果写入数据表的新列（会修改数据表结构，可能耗时）。建议先备份数据。确定继续？'
      )
    ) {
      return;
    }

    setValidationError(null);
    setMaterializing(true);

    try {
      const result = await materializeDatasetCleanColumns(datasetId, cleanConfig);

      if (currentDataset?.id === datasetId && Array.isArray(currentDataset.schema)) {
        const existingNames = new Set(currentDataset.schema.map((column) => column.name));
        const inferredColumns = buildMaterializedCleanColumnSpecs(
          cleanConfig,
          currentDataset.schema
        );
        const inferredColumnsByName = new Map(
          inferredColumns.map((column) => [column.name, column] as const)
        );
        const createdColumns = (result.createdColumns || [])
          .filter((name) => !existingNames.has(name))
          .map((name) => {
            const inferredColumn = inferredColumnsByName.get(name);
            return {
              name,
              duckdbType: inferredColumn?.duckdbType || 'VARCHAR',
              fieldType: inferredColumn?.fieldType || 'text',
              nullable: true,
              storageMode: 'physical',
              metadata: {
                description: '清洗生成列（物化）',
              },
            };
          });

        applyLocalDatasetSchema(datasetId, [...currentDataset.schema, ...createdColumns]);
      }

      toast.success(`物化完成：写入 ${result.updatedColumns.length} 列`);
      onClose();
    } catch (error: unknown) {
      console.error('[CleanPanel] Failed to materialize clean to new columns:', error);
      const message = error instanceof Error ? error.message : String(error);
      setValidationError(message);
      toast.error('物化写入失败', message);
    } finally {
      setMaterializing(false);
    }
  }, [cleanConfig, currentDataset, datasetId, materializing, onClose, applyLocalDatasetSchema]);

  // Reset all clean configurations
  const handleReset = useCallback(() => {
    updateCleanFields(() => ({}));
    setValidationError(null);
    preview.clearPreview();
  }, [preview, updateCleanFields]);

  // Title content for AnchoredPanel
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">数据清洗</span>
      <HelpCircle size={16} className="text-gray-400" />
    </div>
  );

  // Footer content for AnchoredPanel
  const footerContent = (
    <div className="px-5 py-3 border-t border-gray-200 bg-gray-50">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {hasSavedClean && onClear && (
            <button
              onClick={() => void handleClear()}
              className="px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50 rounded transition-colors"
              title="仅清除当前清洗视图，不删除已物化列"
            >
              清除清洗
            </button>
          )}
          {onSaveAsTemplate && (
            <button
              onClick={handleSaveAsTemplate}
              disabled={cleanConfig.length === 0}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors disabled:text-gray-400"
            >
              保存为模板
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={handleReset}
            disabled={materializing || applying}
            className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-200 rounded transition-colors"
          >
            重置
          </button>
          <button
            onClick={() => void handleApply()}
            disabled={cleanConfig.length === 0 || applying || materializing}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-blue-200 disabled:cursor-not-allowed"
            title="将清洗应用到当前视图并刷新结果"
          >
            应用并刷新结果
          </button>
          <button
            onClick={() => void handleMaterializeToNewColumns()}
            disabled={cleanConfig.length === 0 || materializing || applying}
            className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded transition-colors disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
            title="将清洗结果写入新列（会修改数据表结构）"
          >
            写入新列
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl || null}
      title={titleContent}
      footer={footerContent}
      width="680px"
    >
      {/* 验证错误提示 */}
      {validationError && (
        <div className="px-5 py-3 bg-red-50 border-b border-red-200">
          <div className="flex items-center gap-2 text-sm text-red-800">
            <AlertCircle size={16} />
            <span>{validationError}</span>
          </div>
        </div>
      )}

      <div className="px-5 py-3">
        <PreviewWarning
          title="清洗模式说明"
          message="“应用并刷新结果”只影响当前视图；“写入新列”会修改数据表结构，且不会被“清除所有处理”撤销。"
        />

        {/* Configuration Section */}
        {Object.keys(cleanFields).length === 0 ? (
          <div className="mt-3">
            <button
              onClick={handleAddField}
              className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>添加清洗字段</span>
            </button>
          </div>
        ) : (
          <>
            <div className="mt-3 space-y-3">
              {Object.entries(cleanFields).map(([fieldId, field]) => (
                <CleanFieldCard
                  key={fieldId}
                  fieldId={fieldId}
                  field={field}
                  availableFields={availableFields}
                  onUpdateField={handleUpdateField}
                  onRemoveField={handleRemoveField}
                  onAddOperation={handleAddOperation}
                  onUpdateOperation={handleUpdateOperation}
                  onRemoveOperation={handleRemoveOperation}
                />
              ))}

              {/* Add More Fields Button */}
              <button
                onClick={handleAddField}
                className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" />
                <span>添加字段</span>
              </button>
            </div>
          </>
        )}

        {(preview.loading || preview.error || preview.data) && (
          <div className="mt-4 space-y-3 border-t border-gray-200 pt-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <Eye className="w-4 h-4 text-gray-500" />
              <span>预览</span>
            </div>

            <OperationLoadingState
              loading={preview.loading}
              operation="预览清洗"
              message={preview.error || undefined}
              type={preview.error ? 'error' : 'info'}
            />

            {preview.data && (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <PreviewStats
                    icon={<Sparkles className="w-4 h-4" />}
                    label="修改行数"
                    value={preview.data.stats.changedRows}
                    description={`共 ${preview.data.stats.totalRows} 行样本`}
                    type="success"
                  />
                  <PreviewStats
                    label="总变更数"
                    value={preview.data.stats.totalChanges}
                    description="按字段累积统计"
                    type="info"
                  />
                  <PreviewStats
                    icon={<Save className="w-4 h-4" />}
                    label="受影响字段"
                    value={Object.keys(preview.data.stats.byField).length}
                    description="当前预览中发生变化的字段数"
                    type="warning"
                  />
                </div>

                {preview.data.changes.length > 0 ? (
                  <PreviewTable
                    title="变更样本"
                    columns={['rowIndex', 'field', 'originalValue', 'cleanedValue', 'changeType']}
                    rows={preview.data.changes.map((change) => ({
                      rowIndex: change.rowIndex,
                      field: change.field,
                      originalValue: change.originalValue,
                      cleanedValue: change.cleanedValue,
                      changeType: change.changeType,
                    }))}
                    maxRows={8}
                  />
                ) : (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500">
                    当前配置不会改变预览样本中的数据。
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </AnchoredPanel>
  );
}

// Clean Field Card Component
interface CleanFieldCardProps {
  fieldId: string;
  field: CleanFieldConfig;
  availableFields: Array<{ name: string; type: string; fieldType: string }>;
  onUpdateField: (fieldId: string, updates: Partial<CleanFieldConfig>) => void;
  onRemoveField: (fieldId: string) => void;
  onAddOperation: (fieldId: string) => void;
  onUpdateOperation: (fieldId: string, opIndex: number, updates: Partial<CleanOperation>) => void;
  onRemoveOperation: (fieldId: string, opIndex: number) => void;
}

const CleanFieldCard = React.memo(
  ({
    fieldId,
    field,
    availableFields,
    onUpdateField,
    onRemoveField,
    onAddOperation,
    onUpdateOperation,
    onRemoveOperation,
  }: CleanFieldCardProps) => {
    return (
      <div className="border border-gray-200 rounded-lg p-4 bg-white hover:border-blue-300 transition-colors">
        <div className="space-y-3">
          {/* Field Selection and Output */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">源字段</label>
              <select
                value={field.field}
                onChange={(e) => onUpdateField(fieldId, { field: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
              >
                {availableFields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name} ({f.type})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                输出列名 (可选)
              </label>
              <input
                type="text"
                value={field.outputField || ''}
                onChange={(e) => onUpdateField(fieldId, { outputField: e.target.value })}
                placeholder="留空表示覆盖当前字段；写入新列时必须填写"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="pt-5">
              <button
                onClick={() => onRemoveField(fieldId)}
                className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                title="删除字段"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Operations */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-700">清洗操作</label>
              <button
                onClick={() => onAddOperation(fieldId)}
                className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                添加操作
              </button>
            </div>
            {field.operations.map((operation, opIndex) => (
              <OperationRow
                key={opIndex}
                operation={operation}
                onUpdate={(updates) => onUpdateOperation(fieldId, opIndex, updates)}
                onRemove={() => onRemoveOperation(fieldId, opIndex)}
                disableRemove={field.operations.length === 1}
              />
            ))}
            {field.operations.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-2">暂无操作，点击上方添加</p>
            )}
          </div>
        </div>
      </div>
    );
  }
);

CleanFieldCard.displayName = 'CleanFieldCard';

// Operation Row Component
interface OperationRowProps {
  operation: CleanOperation;
  onUpdate: (updates: Partial<CleanOperation>) => void;
  onRemove: () => void;
  disableRemove?: boolean;
}

const OperationRow = React.memo(
  ({ operation, onUpdate, onRemove, disableRemove = false }: OperationRowProps) => {
    return (
      <div className="flex items-center gap-2 bg-gray-50 p-2 rounded">
        <select
          value={operation.type}
          onChange={(e) => onUpdate({ type: e.target.value as any, params: undefined })}
          className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
        >
          <optgroup label="文本清洗">
            <option value="trim">去首尾空格 (TRIM)</option>
            <option value="trim_start">去开头空格 (LTRIM)</option>
            <option value="trim_end">去结尾空格 (RTRIM)</option>
            <option value="upper">转大写 (UPPER)</option>
            <option value="lower">转小写 (LOWER)</option>
            <option value="title">首字母大写 (TITLE)</option>
            <option value="to_halfwidth">全角转半角</option>
            <option value="to_fullwidth">半角转全角</option>
            <option value="replace">替换</option>
            <option value="regex_replace">正则替换</option>
          </optgroup>
          <optgroup label="空值处理">
            <option value="fill_null">填充空值 (COALESCE)</option>
            <option value="coalesce">多字段合并 (取首个非空)</option>
            <option value="nullif">条件转空值 (NULLIF)</option>
          </optgroup>
          <optgroup label="类型转换">
            <option value="cast">类型转换 (CAST)</option>
            <option value="try_cast">安全转换 (TRY_CAST)</option>
          </optgroup>
          <optgroup label="数值处理">
            <option value="unit_convert">单位换算</option>
            <option value="round">四舍五入 (ROUND)</option>
            <option value="floor">向下取整 (FLOOR)</option>
            <option value="ceil">向上取整 (CEIL)</option>
            <option value="abs">绝对值 (ABS)</option>
          </optgroup>
          <optgroup label="日期时间">
            <option value="parse_date">解析日期 (STRPTIME)</option>
            <option value="format_date">格式化日期 (STRFTIME)</option>
          </optgroup>
          <optgroup label="高级清洗">
            <option value="normalize_space">标准化空格</option>
            <option value="remove_special_chars">移除特殊字符</option>
            <option value="truncate">截断文本</option>
            <option value="normalize_email">邮箱标准化</option>
            <option value="split_part">拆分字符串</option>
            <option value="concat_fields">连接字段</option>
            <option value="extract_numbers">提取数字</option>
          </optgroup>
        </select>

        {/* Operation-specific parameters */}
        {operation.type === 'replace' && (
          <>
            <input
              type="text"
              value={operation.params?.search || ''}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, search: e.target.value } })
              }
              placeholder="查找"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={operation.params?.replaceWith || ''}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, replaceWith: e.target.value } })
              }
              placeholder="替换为"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}

        {operation.type === 'regex_replace' && (
          <>
            <input
              type="text"
              value={operation.params?.pattern || ''}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, pattern: e.target.value } })
              }
              placeholder="正则表达式"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs font-mono focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={operation.params?.replacement || ''}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, replacement: e.target.value } })
              }
              placeholder="替换为"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}

        {operation.type === 'fill_null' && (
          <input
            type="text"
            value={operation.params?.value || ''}
            onChange={(e) => onUpdate({ params: { value: e.target.value } })}
            placeholder="填充值"
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
          />
        )}

        {operation.type === 'nullif' && (
          <input
            type="text"
            value={operation.params?.nullValue || ''}
            onChange={(e) => onUpdate({ params: { nullValue: e.target.value } })}
            placeholder="转为空值的值（如：0, 空字符串）"
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
          />
        )}

        {operation.type === 'coalesce' && (
          <>
            <input
              type="text"
              placeholder="字段名（逗号分隔）"
              value={operation.params?.fields?.join(',') || ''}
              onChange={(e) => {
                const fields = e.target.value
                  .split(',')
                  .map((f) => f.trim())
                  .filter(Boolean);
                onUpdate({ params: { ...operation.params, fields } });
              }}
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={operation.params?.value || ''}
              onChange={(e) => onUpdate({ params: { ...operation.params, value: e.target.value } })}
              placeholder="默认值（可选）"
              className="w-24 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}

        {(operation.type === 'cast' || operation.type === 'try_cast') && (
          <select
            value={operation.params?.targetType || 'INTEGER'}
            onChange={(e) => onUpdate({ params: { targetType: e.target.value as any } })}
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
          >
            <optgroup label="文本">
              <option value="VARCHAR">字符串 (VARCHAR)</option>
              <option value="TEXT">文本 (TEXT)</option>
            </optgroup>
            <optgroup label="数值">
              <option value="INTEGER">整数 (INTEGER)</option>
              <option value="BIGINT">长整数 (BIGINT)</option>
              <option value="DOUBLE">浮点数 (DOUBLE)</option>
              <option value="DECIMAL">高精度小数 (DECIMAL)</option>
            </optgroup>
            <optgroup label="布尔">
              <option value="BOOLEAN">布尔值 (BOOLEAN)</option>
            </optgroup>
            <optgroup label="日期时间">
              <option value="DATE">日期 (DATE)</option>
              <option value="TIMESTAMP">时间戳 (TIMESTAMP)</option>
              <option value="TIME">时间 (TIME)</option>
            </optgroup>
          </select>
        )}

        {operation.type === 'unit_convert' && (
          <input
            type="number"
            step="any"
            value={operation.params?.conversionFactor || 1}
            onChange={(e) => onUpdate({ params: { conversionFactor: parseFloat(e.target.value) } })}
            placeholder="转换系数"
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
          />
        )}

        {operation.type === 'round' && (
          <input
            type="number"
            min="0"
            max="10"
            value={operation.params?.decimals ?? 0}
            onChange={(e) => onUpdate({ params: { decimals: parseInt(e.target.value) } })}
            placeholder="小数位数"
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
          />
        )}

        {(operation.type === 'parse_date' || operation.type === 'format_date') && (
          <div className="flex-1">
            <input
              type="text"
              value={operation.params?.dateFormat || '%Y-%m-%d'}
              onChange={(e) => onUpdate({ params: { dateFormat: e.target.value } })}
              placeholder="日期格式"
              className="w-full px-2 py-1 border border-gray-300 rounded text-xs font-mono focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-xs text-gray-400 mt-0.5">
              示例: %Y-%m-%d (2025-01-15), %d/%m/%Y (15/01/2025)
            </div>
          </div>
        )}

        {/* 新增操作的参数输入 */}
        {operation.type === 'truncate' && (
          <>
            <input
              type="number"
              min="1"
              value={operation.params?.maxLength || 50}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, maxLength: parseInt(e.target.value) } })
              }
              placeholder="最大长度"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={operation.params?.suffix || '...'}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, suffix: e.target.value } })
              }
              placeholder="后缀"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}

        {operation.type === 'split_part' && (
          <>
            <input
              type="text"
              value={operation.params?.delimiter || ','}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, delimiter: e.target.value } })
              }
              placeholder="分隔符"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="number"
              min="1"
              value={operation.params?.index || 1}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, index: parseInt(e.target.value) } })
              }
              placeholder="索引"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}

        {operation.type === 'concat_fields' && (
          <>
            <input
              type="text"
              placeholder="字段名（逗号分隔）"
              value={operation.params?.fields?.join(',') || ''}
              onChange={(e) => {
                const fields = e.target.value
                  .split(',')
                  .map((f) => f.trim())
                  .filter(Boolean);
                onUpdate({ params: { ...operation.params, fields } });
              }}
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={operation.params?.separator || ' '}
              onChange={(e) =>
                onUpdate({ params: { ...operation.params, separator: e.target.value } })
              }
              placeholder="分隔符"
              className="w-16 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}

        {operation.type === 'remove_special_chars' && (
          <input
            type="text"
            value={operation.params?.keepPattern || 'a-zA-Z0-9\\s'}
            onChange={(e) => onUpdate({ params: { keepPattern: e.target.value } })}
            placeholder="保留字符（正则）"
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs font-mono focus:ring-2 focus:ring-blue-500"
          />
        )}

        <button
          onClick={onRemove}
          disabled={disableRemove}
          className="p-1 text-red-600 hover:bg-red-50 rounded transition-colors disabled:text-gray-300 disabled:hover:bg-transparent"
          title={disableRemove ? '每个字段至少保留一个清洗操作' : '删除操作'}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    );
  }
);

OperationRow.displayName = 'OperationRow';
