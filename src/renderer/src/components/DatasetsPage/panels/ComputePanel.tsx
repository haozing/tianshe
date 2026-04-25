/**
 * Compute Panel - 计算列面板
 * 提供创建虚拟计算列的功能
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Plus, RotateCcw, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { useDatasetFields } from '../../../hooks';
import type { ComputeConfig, ComputeColumn } from '../../../../../core/query-engine/types';
import { toast } from '../../../lib/toast';
import { validateDatasetComputeExpression } from '../../../services/datasets/datasetPanelService';

interface ComputePanelProps {
  datasetId: string;
  onClose: () => void;
  onApply: (config: ComputeConfig) => void;
}

type ComputeType = 'amount' | 'discount' | 'bucket' | 'concat' | 'custom';

export function ComputePanel({ datasetId, onClose, onApply }: ComputePanelProps) {
  const [computedColumns, setComputedColumns] = useState<Map<string, ComputeColumn>>(new Map());
  const [applying, setApplying] = useState(false);

  // 🆕 使用 useDatasetFields Hook（包含数值字段）
  const { availableFields, numericFields = [] } = useDatasetFields(datasetId, {
    includeNumericFields: true,
  });

  // Add computed column
  const handleAddColumn = () => {
    const columnId = `column_${Date.now()}`;
    const newColumn: ComputeColumn = {
      name: `computed_${computedColumns.size + 1}`,
      type: 'custom',
      expression: '',
    };
    setComputedColumns(new Map(computedColumns).set(columnId, newColumn));
  };

  // Update computed column
  const handleUpdateColumn = (columnId: string, updates: Partial<ComputeColumn>) => {
    setComputedColumns((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(columnId);
      if (existing) {
        // Reset type-specific fields when type changes
        if (updates.type && updates.type !== existing.type) {
          newMap.set(columnId, {
            name: existing.name,
            type: updates.type,
            params: undefined,
            expression: undefined,
          });
        } else {
          newMap.set(columnId, { ...existing, ...updates });
        }
      }
      return newMap;
    });
  };

  // Remove computed column
  const handleRemoveColumn = (columnId: string) => {
    setComputedColumns((prev) => {
      const newMap = new Map(prev);
      newMap.delete(columnId);
      return newMap;
    });
  };

  // Reset all
  const handleReset = () => {
    setComputedColumns(new Map());
  };

  // Apply computation
  const handleApply = async () => {
    if (computedColumns.size === 0) {
      toast.warning('请至少添加一个计算列');
      return;
    }

    const config: ComputeConfig = Array.from(computedColumns.values());

    setApplying(true);
    try {
      await onApply(config);
      onClose();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">🧮 计算列</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              创建虚拟计算列（金额、折扣、分桶、拼接等）
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stats */}
        <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
          <div className="flex items-center gap-6 text-sm">
            <div>
              <span className="text-gray-600">当前列数:</span>
              <span className="ml-2 font-semibold text-gray-900">{availableFields.length}</span>
            </div>
            <div className="w-px h-4 bg-gray-300" />
            <div>
              <span className="text-gray-600">计算列数:</span>
              <span className="ml-2 font-semibold text-blue-600">{computedColumns.size}</span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-4">
            {Array.from(computedColumns.entries()).map(([columnId, column]) => (
              <ComputeColumnCard
                key={columnId}
                columnId={columnId}
                column={column}
                datasetId={datasetId}
                availableFields={availableFields}
                numericFields={numericFields}
                onUpdate={handleUpdateColumn}
                onRemove={handleRemoveColumn}
              />
            ))}

            {/* Add Column Button */}
            <button
              onClick={handleAddColumn}
              className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>添加计算列</span>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 rounded transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              重置
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 rounded transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleApply}
              disabled={computedColumns.size === 0 || applying}
              className="flex items-center gap-2 px-6 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {applying && <Loader2 className="w-4 h-4 animate-spin" />}
              {applying
                ? '应用中...'
                : `✓ 应用计算${computedColumns.size > 0 ? ` (${computedColumns.size}列)` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Compute Column Card Component
interface ComputeColumnCardProps {
  columnId: string;
  column: ComputeColumn;
  datasetId: string;
  availableFields: Array<{ name: string; type: string; fieldType: string }>;
  numericFields: Array<{ name: string; type: string; fieldType: string }>;
  onUpdate: (columnId: string, updates: Partial<ComputeColumn>) => void;
  onRemove: (columnId: string) => void;
}

function ComputeColumnCard({
  columnId,
  column,
  datasetId,
  availableFields,
  numericFields,
  onUpdate,
  onRemove,
}: ComputeColumnCardProps) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white hover:border-blue-300 transition-colors">
      <div className="space-y-4">
        {/* Column Name and Type */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-700 mb-1">列名</label>
            <input
              type="text"
              value={column.name}
              onChange={(e) => onUpdate(columnId, { name: e.target.value })}
              placeholder="输入列名"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-700 mb-1">计算类型</label>
            <select
              value={column.type}
              onChange={(e) => onUpdate(columnId, { type: e.target.value as ComputeType })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="amount">金额计算 (价格×数量)</option>
              <option value="discount">折扣计算</option>
              <option value="bucket">分桶/分组</option>
              <option value="concat">字段拼接</option>
              <option value="custom">自定义表达式</option>
            </select>
          </div>
          <div className="pt-5">
            <button
              onClick={() => onRemove(columnId)}
              className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
              title="删除列"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Type-specific fields */}
        {column.type === 'amount' && (
          <AmountFields
            column={column}
            numericFields={numericFields}
            onUpdate={(updates) => onUpdate(columnId, updates)}
          />
        )}
        {column.type === 'discount' && (
          <DiscountFields
            column={column}
            numericFields={numericFields}
            onUpdate={(updates) => onUpdate(columnId, updates)}
          />
        )}
        {column.type === 'bucket' && (
          <BucketFields
            column={column}
            numericFields={numericFields}
            onUpdate={(updates) => onUpdate(columnId, updates)}
          />
        )}
        {column.type === 'concat' && (
          <ConcatFields
            column={column}
            availableFields={availableFields}
            onUpdate={(updates) => onUpdate(columnId, updates)}
          />
        )}
        {column.type === 'custom' && (
          <CustomFields
            column={column}
            datasetId={datasetId}
            onUpdate={(updates) => onUpdate(columnId, updates)}
          />
        )}
      </div>
    </div>
  );
}

// Amount Fields
interface AmountFieldsProps {
  column: ComputeColumn;
  numericFields: Array<{ name: string; type: string; fieldType: string }>;
  onUpdate: (updates: Partial<ComputeColumn>) => void;
}

function AmountFields({ column, numericFields, onUpdate }: AmountFieldsProps) {
  return (
    <div className="flex gap-3">
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-700 mb-1">价格字段</label>
        <select
          value={column.params?.priceField || ''}
          onChange={(e) => onUpdate({ params: { ...column.params, priceField: e.target.value } })}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">选择字段</option>
          {numericFields.map((f: any) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-700 mb-1">数量字段</label>
        <select
          value={column.params?.quantityField || ''}
          onChange={(e) =>
            onUpdate({ params: { ...column.params, quantityField: e.target.value } })
          }
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">选择字段</option>
          {numericFields.map((f: any) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Discount Fields
interface DiscountFieldsProps {
  column: ComputeColumn;
  numericFields: Array<{ name: string; type: string; fieldType: string }>;
  onUpdate: (updates: Partial<ComputeColumn>) => void;
}

function DiscountFields({ column, numericFields, onUpdate }: DiscountFieldsProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-700 mb-1">原价字段</label>
          <select
            value={column.params?.originalPriceField || ''}
            onChange={(e) =>
              onUpdate({ params: { ...column.params, originalPriceField: e.target.value } })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="">选择字段</option>
            {numericFields.map((f: any) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-700 mb-1">折后价字段</label>
          <select
            value={column.params?.discountedPriceField || ''}
            onChange={(e) =>
              onUpdate({ params: { ...column.params, discountedPriceField: e.target.value } })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="">选择字段</option>
            {numericFields.map((f: any) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">折扣类型</label>
        <select
          value={column.params?.discountType || 'percentage'}
          onChange={(e) =>
            onUpdate({
              params: { ...column.params, discountType: e.target.value as 'percentage' | 'amount' },
            })
          }
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="percentage">百分比 (%)</option>
          <option value="amount">金额</option>
        </select>
      </div>
    </div>
  );
}

// Bucket Fields
interface BucketFieldsProps {
  column: ComputeColumn;
  numericFields: Array<{ name: string; type: string; fieldType: string }>;
  onUpdate: (updates: Partial<ComputeColumn>) => void;
}

function BucketFields({ column, numericFields, onUpdate }: BucketFieldsProps) {
  const [boundariesText, setBoundariesText] = useState(
    column.params?.boundaries?.join(', ') || '0,100,200'
  );
  const [labelsText, setLabelsText] = useState(column.params?.labels?.join(', ') || '');

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">数值字段</label>
        <select
          value={column.params?.field || ''}
          onChange={(e) => onUpdate({ params: { ...column.params, field: e.target.value } })}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">选择字段</option>
          {numericFields.map((f: any) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">分桶边界 (逗号分隔)</label>
        <input
          type="text"
          value={boundariesText}
          onChange={(e) => {
            setBoundariesText(e.target.value);
            const boundaries = e.target.value
              .split(',')
              .map((v) => parseFloat(v.trim()))
              .filter((v) => !isNaN(v));
            onUpdate({ params: { ...column.params, boundaries } });
          }}
          placeholder="例如: 0,100,200,500"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          标签 (可选，逗号分隔)
        </label>
        <input
          type="text"
          value={labelsText}
          onChange={(e) => {
            setLabelsText(e.target.value);
            const labels = e.target.value
              ? e.target.value.split(',').map((v) => v.trim())
              : undefined;
            onUpdate({ params: { ...column.params, labels } });
          }}
          placeholder="例如: 低,中,高,极高"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        />
      </div>
    </div>
  );
}

// Concat Fields
interface ConcatFieldsProps {
  column: ComputeColumn;
  availableFields: Array<{ name: string; type: string; fieldType: string }>;
  onUpdate: (updates: Partial<ComputeColumn>) => void;
}

function ConcatFields({ column, availableFields, onUpdate }: ConcatFieldsProps) {
  const [fieldsText, setFieldsText] = useState(column.params?.fields?.join(', ') || '');

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          要拼接的字段 (逗号分隔)
        </label>
        <input
          type="text"
          value={fieldsText}
          onChange={(e) => {
            setFieldsText(e.target.value);
            const fields = e.target.value
              .split(',')
              .map((v) => v.trim())
              .filter((v) => v);
            onUpdate({ params: { ...column.params, fields } });
          }}
          placeholder="例如: 姓, 名"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          可用字段: {availableFields.map((f: any) => f.name).join(', ')}
        </p>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">分隔符 (可选)</label>
        <input
          type="text"
          value={column.params?.separator || ''}
          onChange={(e) => onUpdate({ params: { ...column.params, separator: e.target.value } })}
          placeholder="例如: 空格、逗号等"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
        />
      </div>
    </div>
  );
}

// Custom Fields
interface CustomFieldsProps {
  column: ComputeColumn;
  datasetId: string;
  onUpdate: (updates: Partial<ComputeColumn>) => void;
}

function CustomFields({ column, datasetId, onUpdate }: CustomFieldsProps) {
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<any | null>(null);
  const validationTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Validate expression with debouncing
  const validateExpression = useCallback(
    async (expression: string) => {
      if (validationTimerRef.current) {
        clearTimeout(validationTimerRef.current);
      }

      if (!expression || expression.trim().length === 0) {
        setValidation(null);
        return;
      }

      setValidating(true);

      validationTimerRef.current = setTimeout(async () => {
        try {
          const result = await validateDatasetComputeExpression(datasetId, expression, {
            limit: 3,
          });

          setValidation(result);
        } catch (error: any) {
          console.error('[ComputePanel] Failed to validate expression:', error);
          setValidation({ valid: false, error: error.message || '验证失败' });
        } finally {
          setValidating(false);
        }
      }, 500);
    },
    [datasetId]
  );

  // Trigger validation when expression changes
  useEffect(() => {
    if (column.expression) {
      validateExpression(column.expression);
    }
    return () => {
      if (validationTimerRef.current) {
        clearTimeout(validationTimerRef.current);
      }
    };
  }, [column.expression, validateExpression]);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">SQL 表达式</label>
        <textarea
          value={column.expression || ''}
          onChange={(e) => onUpdate({ expression: e.target.value })}
          placeholder="例如: price * 1.1, UPPER(name), CASE WHEN age > 18 THEN 'Adult' ELSE 'Minor' END"
          rows={3}
          className={`w-full px-3 py-2 border rounded-md text-sm font-mono focus:ring-2 focus:border-transparent ${
            validation
              ? validation.valid
                ? 'border-green-300 focus:ring-green-500'
                : 'border-red-300 focus:ring-red-500'
              : 'border-gray-300 focus:ring-blue-500'
          }`}
        />
        <p className="text-xs text-gray-500 mt-1">
          可以使用 DuckDB SQL 表达式，如函数、运算符、CASE WHEN 等
        </p>
      </div>

      {/* Validation Status */}
      {validating && (
        <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-200 rounded text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
          <span className="text-blue-700">验证中...</span>
        </div>
      )}

      {!validating && validation && validation.valid && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 p-2 bg-green-50 border border-green-200 rounded">
            <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium text-green-900">表达式有效</div>
              {validation.stats?.dataType && (
                <div className="text-xs text-green-700 mt-0.5">
                  数据类型: {validation.stats.dataType}
                </div>
              )}
            </div>
          </div>

          {validation.previewValues && validation.previewValues.length > 0 && (
            <div className="p-2 bg-gray-50 border border-gray-200 rounded">
              <div className="text-xs font-medium text-gray-700 mb-1">预览值（前3条）：</div>
              <div className="flex flex-wrap gap-2">
                {validation.previewValues.map((val: any, idx: number) => (
                  <span
                    key={idx}
                    className="px-2 py-1 bg-white border border-gray-200 rounded text-xs font-mono text-gray-900"
                  >
                    {val === null ? '(null)' : String(val)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {validation.stats && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {validation.stats.nullCount !== undefined && (
                <div className="p-2 bg-white border border-gray-200 rounded">
                  <span className="text-gray-600">空值数: </span>
                  <span className="font-semibold text-gray-900">{validation.stats.nullCount}</span>
                </div>
              )}
              {validation.stats.distinctCount !== undefined && (
                <div className="p-2 bg-white border border-gray-200 rounded">
                  <span className="text-gray-600">唯一值: </span>
                  <span className="font-semibold text-gray-900">
                    {validation.stats.distinctCount}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!validating && validation && !validation.valid && (
        <div className="flex items-start gap-2 p-2 bg-red-50 border border-red-200 rounded">
          <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-red-900">表达式无效</div>
            <div className="text-xs text-red-700 mt-1">{validation.error}</div>
          </div>
        </div>
      )}
    </div>
  );
}
