import React, { useState } from 'react';
import { X, Plus, HelpCircle } from 'lucide-react';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import { toast } from '../../../lib/toast';
import type { ColorConfig, ColorRule } from '../../../../../core/query-engine/types';

interface ColumnInfo {
  name: string;
  type: string;
}

interface ColorPanelProps {
  columns: ColumnInfo[];
  onClose: () => void;
  onApply: (config: ColorConfig) => Promise<void> | void;
  onClear?: () => Promise<void> | void;
  onSaveAsTemplate?: (config: ColorConfig) => void;
  anchorEl?: HTMLElement | null;
}

export const ColorPanel: React.FC<ColorPanelProps> = ({
  columns,
  onClose,
  onApply,
  onClear,
  onSaveAsTemplate,
  anchorEl,
}) => {
  const currentConfig = useDatasetStore(selectActiveQueryConfig)?.color;
  const [rules, setRules] = useState<ColorRule[]>(() => currentConfig?.rules ?? []);
  const [applying, setApplying] = useState(false);

  const presetColors = [
    { name: '黄色', value: '#fef3c7' },
    { name: '绿色', value: '#d1fae5' },
    { name: '蓝色', value: '#dbeafe' },
    { name: '红色', value: '#fee2e2' },
    { name: '紫色', value: '#ede9fe' },
    { name: '橙色', value: '#fed7aa' },
  ];

  const addRule = () => {
    if (columns.length === 0) return;
    setRules([
      ...rules,
      {
        id: Date.now().toString(),
        column: columns[0]?.name || '',
        operator: 'eq',
        value: '',
        color: presetColors[0].value,
      },
    ]);
  };

  const removeRule = (id: string) => {
    setRules(rules.filter((r) => r.id !== id));
  };

  const updateRule = (id: string, updates: Partial<ColorRule>) => {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  // Title content for AnchoredPanel
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">条件填色（单元格级别）</span>
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
        {columns.length === 0 && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            当前没有可用于条件填色的字段，请先加载数据或返回基础视图。
          </div>
        )}

        {/* 初始状态：显示"添加颜色规则"按钮 */}
        {rules.length === 0 ? (
          <div>
            <button
              onClick={addRule}
              disabled={columns.length === 0 || applying}
              className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg hover:bg-gray-50 flex items-center justify-center gap-2 text-sm text-gray-600 transition-colors disabled:opacity-50"
            >
              <Plus size={16} />
              添加颜色规则
            </button>
          </div>
        ) : (
          <>
            {/* Color Rules */}
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="mb-3 p-3 border border-gray-200 rounded-lg bg-gray-50 space-y-2"
              >
                {/* First Row: Column + Operator + Value */}
                <div className="flex items-center gap-2">
                  {/* 字段选择 */}
                  <select
                    value={rule.column}
                    onChange={(e) => updateRule(rule.id, { column: e.target.value })}
                    disabled={applying}
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                  >
                    {columns.map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                  </select>

                  {/* 操作符选择 */}
                  <select
                    value={rule.operator}
                    onChange={(e) => updateRule(rule.id, { operator: e.target.value as any })}
                    disabled={applying}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                    style={{ minWidth: '100px' }}
                  >
                    <option value="eq">等于</option>
                    <option value="ne">不等于</option>
                    <option value="gt">大于</option>
                    <option value="lt">小于</option>
                    <option value="gte">≥</option>
                    <option value="lte">≤</option>
                    <option value="contains">包含</option>
                    <option value="startsWith">开头</option>
                    <option value="endsWith">结尾</option>
                    <option value="isEmpty">为空</option>
                    <option value="isNotEmpty">非空</option>
                  </select>

                  {/* 值输入 */}
                  {!['isEmpty', 'isNotEmpty'].includes(rule.operator) && (
                    <input
                      type="text"
                      value={rule.value}
                      onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                      disabled={applying}
                      placeholder="输入值"
                      className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  )}

                  {/* 删除按钮 */}
                  <button
                    onClick={() => removeRule(rule.id)}
                    disabled={applying}
                    className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                    title="删除规则"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Second Row: Color Presets */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 mr-1">填充色:</span>
                  {presetColors.map((preset) => (
                    <button
                      key={preset.value}
                      onClick={() => updateRule(rule.id, { color: preset.value })}
                      disabled={applying}
                      className="w-6 h-6 rounded border-2 hover:scale-110 transition-transform"
                      style={{
                        backgroundColor: preset.value,
                        borderColor: rule.color === preset.value ? '#3b82f6' : '#d1d5db',
                      }}
                      title={preset.name}
                    />
                  ))}
                  {/* 自定义颜色选择器 */}
                  <input
                    type="color"
                    value={rule.color}
                    onChange={(e) => updateRule(rule.id, { color: e.target.value })}
                    disabled={applying}
                    className="w-8 h-8 rounded cursor-pointer border border-gray-300"
                    title="自定义颜色"
                  />
                </div>
              </div>
            ))}

            {/* 添加更多规则按钮 */}
            <div className="mt-2">
              <button
                onClick={addRule}
                disabled={columns.length === 0 || applying}
                className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg hover:bg-gray-50 flex items-center justify-center gap-2 text-sm text-gray-600 transition-colors disabled:opacity-50"
              >
                <Plus size={16} />
                添加规则
              </button>
            </div>

            <div className="mt-4">
              <button
                onClick={() => {
                  const validRules = rules.filter((rule) => {
                    if (!rule.column) return false;
                    if (['isEmpty', 'isNotEmpty'].includes(rule.operator)) return true;
                    return rule.value.trim().length > 0;
                  });

                  if (validRules.length === 0) {
                    toast.warning('请至少配置一条有效的填色规则');
                    return;
                  }

                  void (async () => {
                    setApplying(true);
                    try {
                      await onApply({
                        type: 'color',
                        rules: validRules,
                      });
                    } finally {
                      setApplying(false);
                    }
                  })();
                }}
                disabled={rules.length === 0 || applying}
                className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {applying
                  ? '应用中...'
                  : `应用填色${rules.length > 0 ? ` (${rules.length}条)` : ''}`}
              </button>
            </div>

            {/* 底部链接 */}
            <div className="mt-3 flex items-center justify-between">
              {currentConfig?.rules?.length ? (
                <button
                  onClick={() => {
                    if (!onClear) return;
                    void (async () => {
                      setApplying(true);
                      try {
                        await onClear();
                      } finally {
                        setApplying(false);
                      }
                    })();
                  }}
                  disabled={applying}
                  className="text-sm text-red-600 hover:text-red-700 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
                >
                  清除填色
                </button>
              ) : (
                <div />
              )}

              <button
                onClick={() => {
                  const validRules = rules.filter((rule) => {
                    if (!rule.column) return false;
                    if (['isEmpty', 'isNotEmpty'].includes(rule.operator)) return true;
                    return rule.value.trim().length > 0;
                  });

                  if (validRules.length === 0) {
                    toast.warning('请至少配置一条有效的填色规则');
                    return;
                  }

                  onSaveAsTemplate?.({
                    type: 'color',
                    rules: validRules,
                  });
                }}
                disabled={rules.length === 0 || applying}
                className="text-sm text-blue-600 hover:text-blue-700 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
              >
                保存查询模板
              </button>
            </div>
          </>
        )}
      </div>
    </AnchoredPanel>
  );
};
