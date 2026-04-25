/**
 * 触发链配置组件
 *
 * 用于配置按钮执行后触发下一个按钮
 */

import { useState } from 'react';
import { Plus, X, ArrowRight, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import type {
  TriggerCondition,
  TriggerRule,
  TriggerChainConfig as TriggerChainConfigData,
} from '@/main/duckdb/types';

// 重新导出类型，方便其他组件使用
export type { TriggerCondition, TriggerRule, TriggerChainConfigData };

export interface TriggerChainConfigProps {
  /** 可用的按钮列 */
  buttonColumns: Array<{ name: string }>;
  /** 当前配置 */
  config?: TriggerChainConfigData;
  /** 变更回调 */
  onChange: (config: TriggerChainConfigData | undefined) => void;
}

export function TriggerChainConfig({ buttonColumns, config, onChange }: TriggerChainConfigProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 默认配置
  const defaultConfig: TriggerChainConfigData = {
    enabled: false,
    maxDepth: 5,
    triggers: [],
    errorStrategy: {
      onCurrentFail: 'stop',
      onChildFail: 'ignore',
    },
  };

  const currentConfig = config || defaultConfig;

  // 更新配置
  const updateConfig = (updates: Partial<TriggerChainConfigData>) => {
    const newConfig = { ...currentConfig, ...updates };
    onChange(newConfig.enabled ? newConfig : undefined);
  };

  // 添加触发规则
  const addTrigger = () => {
    const newTriggers = [
      ...currentConfig.triggers,
      {
        condition: { type: 'on_success' as const },
        nextButton: { columnName: '', delay: 0 },
      },
    ];
    updateConfig({ triggers: newTriggers, enabled: true });
  };

  // 删除触发规则
  const removeTrigger = (index: number) => {
    const newTriggers = currentConfig.triggers.filter((_, i) => i !== index);
    updateConfig({
      triggers: newTriggers,
      enabled: newTriggers.length > 0,
    });
  };

  // 更新触发规则
  const updateTrigger = (index: number, updates: Partial<TriggerRule>) => {
    const newTriggers = [...currentConfig.triggers];
    newTriggers[index] = { ...newTriggers[index], ...updates };
    updateConfig({ triggers: newTriggers });
  };

  // 更新触发条件
  const updateCondition = (index: number, updates: Partial<TriggerCondition>) => {
    const trigger = currentConfig.triggers[index];
    updateTrigger(index, {
      condition: { ...trigger.condition, ...updates },
    });
  };

  // 更新下一个按钮配置
  const updateNextButton = (index: number, updates: Partial<TriggerRule['nextButton']>) => {
    const trigger = currentConfig.triggers[index];
    updateTrigger(index, {
      nextButton: { ...trigger.nextButton, ...updates },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">触发链</div>
        <button
          onClick={addTrigger}
          className="shell-field-control inline-flex items-center gap-1 px-3 py-1.5 text-sm text-sky-700"
        >
          <Plus className="w-4 h-4" />
          添加触发
        </button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50/90 p-4 text-xs text-slate-800">
        <p>按钮执行完成后，可以自动触发其他按钮（链式执行）。</p>
        <p className="mt-2 text-slate-600">最大触发深度：{currentConfig.maxDepth || 5} 层</p>
      </div>

      {currentConfig.triggers.length > 0 ? (
        <div className="space-y-3">
          {currentConfig.triggers.map((trigger, index) => (
            <div key={index} className="shell-soft-card space-y-4 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="shell-field-chip shell-field-chip--ghost inline-flex items-center gap-2 px-2.5 py-1 text-xs">
                  规则 {index + 1}
                </div>
                <button
                  onClick={() => removeTrigger(index)}
                  className="shell-icon-button rounded-full p-2 text-slate-400 transition-colors hover:text-red-600"
                  title="删除"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid gap-3 lg:grid-cols-[48px_minmax(0,180px)_minmax(0,1fr)]">
                <span className="flex items-center text-sm text-slate-600">当</span>
                <select
                  value={trigger.condition.type}
                  onChange={(e) =>
                    updateCondition(index, { type: e.target.value as TriggerCondition['type'] })
                  }
                  className="shell-field-input px-3 py-2 text-sm"
                >
                  <option value="always">始终</option>
                  <option value="on_success">成功时</option>
                  <option value="on_failure">失败时</option>
                  <option value="on_return_value">返回值满足条件</option>
                </select>

                {trigger.condition.type === 'on_return_value' && (
                  <div className="grid gap-3 md:grid-cols-[120px_120px_minmax(0,1fr)]">
                    <input
                      type="text"
                      value={trigger.condition.returnField || ''}
                      onChange={(e) => updateCondition(index, { returnField: e.target.value })}
                      placeholder="返回字段"
                      className="shell-field-input w-full px-3 py-2 font-mono text-sm"
                    />
                    <select
                      value={trigger.condition.operator || 'eq'}
                      onChange={(e) =>
                        updateCondition(index, {
                          operator: e.target.value as TriggerCondition['operator'],
                        })
                      }
                      className="shell-field-input px-3 py-2 text-sm"
                    >
                      <option value="eq">=</option>
                      <option value="ne">!=</option>
                      <option value="gt">&gt;</option>
                      <option value="lt">&lt;</option>
                      <option value="contains">包含</option>
                      <option value="exists">存在</option>
                    </select>
                    {trigger.condition.operator !== 'exists' && (
                      <input
                        type="text"
                        value={trigger.condition.value ?? ''}
                        onChange={(e) => updateCondition(index, { value: e.target.value })}
                        placeholder="值"
                        className="shell-field-input w-full px-3 py-2 text-sm"
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="grid gap-3 lg:grid-cols-[24px_48px_minmax(0,1fr)_48px_104px_40px]">
                <div className="flex items-center justify-center text-slate-400">
                  <ArrowRight className="w-4 h-4" />
                </div>
                <span className="flex items-center text-sm text-slate-600">触发</span>
                <select
                  value={trigger.nextButton.columnName}
                  onChange={(e) => updateNextButton(index, { columnName: e.target.value })}
                  className="shell-field-input min-w-0 px-3 py-2 text-sm"
                >
                  <option value="">选择按钮列</option>
                  {buttonColumns.map((col) => (
                    <option key={col.name} value={col.name}>
                      {col.name}
                    </option>
                  ))}
                </select>

                <span className="flex items-center text-sm text-slate-600">延迟</span>
                <input
                  type="number"
                  value={trigger.nextButton.delay || 0}
                  onChange={(e) =>
                    updateNextButton(index, { delay: parseInt(e.target.value) || 0 })
                  }
                  min={0}
                  step={100}
                  className="shell-field-input w-full px-3 py-2 text-sm"
                />
                <span className="flex items-center text-sm text-slate-500">ms</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="shell-upload-dropzone py-8 text-center text-sm text-slate-500">
          暂无触发链配置
        </div>
      )}

      {currentConfig.triggers.length > 0 && (
        <div className="border-t border-slate-200/80 pt-4">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="shell-field-control inline-flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900"
          >
            {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            高级选项
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-3">
              <div className="shell-content-muted flex items-center gap-3 rounded-2xl border border-slate-200/80 px-4 py-3">
                <span className="text-sm text-slate-600">最大触发深度：</span>
                <input
                  type="number"
                  value={currentConfig.maxDepth || 5}
                  onChange={(e) => updateConfig({ maxDepth: parseInt(e.target.value) || 5 })}
                  min={1}
                  max={10}
                  className="shell-field-input w-20 px-3 py-1.5 text-sm"
                />
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50/90 p-4 text-xs">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-700">当前按钮失败时：</span>
                      <select
                        value={currentConfig.errorStrategy?.onCurrentFail || 'stop'}
                        onChange={(e) =>
                          updateConfig({
                            errorStrategy: {
                              ...currentConfig.errorStrategy!,
                              onCurrentFail: e.target.value as 'stop' | 'skip_next' | 'continue',
                            },
                          })
                        }
                        className="shell-field-input px-3 py-1.5 text-xs"
                      >
                        <option value="stop">停止触发链</option>
                        <option value="skip_next">跳过下一个</option>
                        <option value="continue">继续执行</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-700">子链失败时：</span>
                      <select
                        value={currentConfig.errorStrategy?.onChildFail || 'ignore'}
                        onChange={(e) =>
                          updateConfig({
                            errorStrategy: {
                              ...currentConfig.errorStrategy!,
                              onChildFail: e.target.value as 'stop' | 'ignore',
                            },
                          })
                        }
                        className="shell-field-input px-3 py-1.5 text-xs"
                      >
                        <option value="ignore">忽略错误</option>
                        <option value="stop">停止执行</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
