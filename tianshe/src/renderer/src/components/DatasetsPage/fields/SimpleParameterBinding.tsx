/**
 * 简单参数绑定组件
 *
 * 用于配置按钮字段的参数绑定
 * 支持字段绑定和固定值两种方式
 */

import { Plus, X, ArrowRight, Database, Hash } from 'lucide-react';
import type { ParameterBinding } from '@/main/duckdb/types';

// 重新导出类型，方便其他组件使用
export type { ParameterBinding };

export interface SimpleParameterBindingProps {
  /** 可用的数据表列 */
  columns: Array<{ name: string; type: string }>;
  /** 当前绑定值 */
  bindings: ParameterBinding[];
  /** 变更回调 */
  onChange: (bindings: ParameterBinding[]) => void;
}

export function SimpleParameterBinding({
  columns,
  bindings,
  onChange,
}: SimpleParameterBindingProps) {
  // 添加新绑定
  const addBinding = () => {
    onChange([
      ...bindings,
      {
        parameterName: '',
        bindingType: 'field',
        fieldName: '',
      },
    ]);
  };

  // 删除绑定
  const removeBinding = (index: number) => {
    const newBindings = bindings.filter((_, i) => i !== index);
    onChange(newBindings);
  };

  // 更新绑定
  const updateBinding = (index: number, field: keyof ParameterBinding, value: any) => {
    const newBindings = [...bindings];
    newBindings[index] = { ...newBindings[index], [field]: value };

    // 切换类型时清空对应的值
    if (field === 'bindingType') {
      if (value === 'field') {
        newBindings[index].fixedValue = undefined;
      } else if (value === 'fixed') {
        newBindings[index].fieldName = undefined;
      } else {
        newBindings[index].fieldName = undefined;
        newBindings[index].fixedValue = undefined;
      }
    }

    onChange(newBindings);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">参数绑定</div>
        <button
          onClick={addBinding}
          className="shell-field-control inline-flex items-center gap-1 px-3 py-1.5 text-sm text-sky-700"
        >
          <Plus className="w-4 h-4" />
          添加参数
        </button>
      </div>

      <div className="rounded-2xl border border-sky-200 bg-sky-50/90 p-4 text-xs text-sky-900">
        <p>将数据表字段的值传递给插件方法作为参数。</p>
        <ul className="mt-2 space-y-1 list-disc list-inside text-sky-800">
          <li>
            <strong>字段</strong>：使用当前行对应列的值
          </li>
          <li>
            <strong>固定值</strong>：使用固定的值
          </li>
          <li>
            <strong>行ID</strong>：传递当前行的 _row_id
          </li>
          <li>
            <strong>数据集ID</strong>：传递当前数据集的 ID
          </li>
        </ul>
      </div>

      {bindings.length > 0 ? (
        <div className="space-y-3">
          {bindings.map((binding, index) => (
            <div key={index} className="shell-soft-card space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="shell-field-chip shell-field-chip--ghost inline-flex items-center gap-2 px-2.5 py-1 text-xs">
                  <span>参数 {index + 1}</span>
                </div>
                <button
                  onClick={() => removeBinding(index)}
                  className="shell-icon-button rounded-full p-2 text-slate-400 transition-colors hover:text-red-600"
                  title="删除"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid gap-3 lg:grid-cols-[140px_24px_160px_minmax(0,1fr)]">
                <input
                  type="text"
                  value={binding.parameterName}
                  onChange={(e) => updateBinding(index, 'parameterName', e.target.value)}
                  placeholder="参数名"
                  className="shell-field-input w-full px-3 py-2 font-mono text-sm"
                />

                <div className="flex items-center justify-center text-slate-400">
                  <ArrowRight className="h-4 w-4" />
                </div>

                <select
                  value={binding.bindingType}
                  onChange={(e) =>
                    updateBinding(
                      index,
                      'bindingType',
                      e.target.value as ParameterBinding['bindingType']
                    )
                  }
                  className="shell-field-input px-3 py-2 text-sm"
                >
                  <option value="field">字段</option>
                  <option value="fixed">固定值</option>
                  <option value="rowid">行ID</option>
                  <option value="datasetId">数据集ID</option>
                </select>

                {binding.bindingType === 'field' && (
                  <select
                    value={binding.fieldName || ''}
                    onChange={(e) => updateBinding(index, 'fieldName', e.target.value)}
                    className="shell-field-input min-w-0 px-3 py-2 text-sm"
                  >
                    <option value="">选择字段</option>
                    {columns.map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                )}

                {binding.bindingType === 'fixed' && (
                  <input
                    type="text"
                    value={binding.fixedValue ?? ''}
                    onChange={(e) => updateBinding(index, 'fixedValue', e.target.value)}
                    placeholder="输入固定值"
                    className="shell-field-input min-w-0 px-3 py-2 text-sm"
                  />
                )}

                {binding.bindingType === 'rowid' && (
                  <div className="shell-content-muted flex min-w-0 items-center gap-2 rounded-2xl border border-slate-200/80 px-3 py-2 text-sm text-slate-600">
                    <Hash className="w-4 h-4" />
                    <span>当前行的 _row_id</span>
                  </div>
                )}

                {binding.bindingType === 'datasetId' && (
                  <div className="shell-content-muted flex min-w-0 items-center gap-2 rounded-2xl border border-slate-200/80 px-3 py-2 text-sm text-slate-600">
                    <Database className="w-4 h-4" />
                    <span>当前数据集 ID</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="shell-upload-dropzone py-8 text-center text-sm text-slate-500">
          暂无参数绑定
        </div>
      )}
    </div>
  );
}
