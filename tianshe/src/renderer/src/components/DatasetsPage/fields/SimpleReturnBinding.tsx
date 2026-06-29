/**
 * 简单返回值绑定组件
 *
 * 用于配置按钮执行后的返回值如何写回数据表
 */

import { Plus, X, ArrowRight } from 'lucide-react';
import type { ReturnBinding } from '@/main/duckdb/types';

// 重新导出类型，方便其他组件使用
export type { ReturnBinding };

export interface SimpleReturnBindingProps {
  /** 可用的数据表列 */
  columns: Array<{ name: string; type: string }>;
  /** 当前绑定值 */
  bindings: ReturnBinding[];
  /** 变更回调 */
  onChange: (bindings: ReturnBinding[]) => void;
}

export function SimpleReturnBinding({ columns, bindings, onChange }: SimpleReturnBindingProps) {
  // 添加新绑定
  const addBinding = () => {
    onChange([
      ...bindings,
      {
        returnField: '',
        targetColumn: '',
        updateCondition: 'on_success',
      },
    ]);
  };

  // 删除绑定
  const removeBinding = (index: number) => {
    const newBindings = bindings.filter((_, i) => i !== index);
    onChange(newBindings);
  };

  // 更新绑定
  const updateBinding = (index: number, field: keyof ReturnBinding, value: any) => {
    const newBindings = [...bindings];
    newBindings[index] = { ...newBindings[index], [field]: value };
    onChange(newBindings);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">返回值绑定</div>
        <button
          onClick={addBinding}
          className="shell-field-control inline-flex items-center gap-1 px-3 py-1.5 text-sm text-sky-700"
        >
          <Plus className="w-4 h-4" />
          添加绑定
        </button>
      </div>

      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/90 p-4 text-xs text-emerald-900">
        <p>将插件方法的返回值自动写入数据表对应字段。</p>
        <p className="mt-2 text-emerald-800">
          例如：返回值 <code className="bg-emerald-100 px-1 rounded">imageUrl</code> 写入列{' '}
          <code className="bg-emerald-100 px-1 rounded">商品图片</code>
        </p>
      </div>

      {bindings.length > 0 ? (
        <div className="space-y-3">
          {bindings.map((binding, index) => (
            <div key={index} className="shell-soft-card space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="shell-field-chip shell-field-chip--ghost inline-flex items-center gap-2 px-2.5 py-1 text-xs">
                  <span>绑定 {index + 1}</span>
                </div>
                <button
                  onClick={() => removeBinding(index)}
                  className="shell-icon-button rounded-full p-2 text-slate-400 transition-colors hover:text-red-600"
                  title="删除"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid gap-3 lg:grid-cols-[140px_24px_minmax(0,1fr)_132px]">
                <input
                  type="text"
                  value={binding.returnField}
                  onChange={(e) => updateBinding(index, 'returnField', e.target.value)}
                  placeholder="返回字段名"
                  className="shell-field-input w-full px-3 py-2 font-mono text-sm"
                />

                <div className="flex items-center justify-center text-slate-400">
                  <ArrowRight className="w-4 h-4" />
                </div>

                <select
                  value={binding.targetColumn}
                  onChange={(e) => updateBinding(index, 'targetColumn', e.target.value)}
                  className="shell-field-input min-w-0 px-3 py-2 text-sm"
                >
                  <option value="">选择目标列</option>
                  {columns.map((col) => (
                    <option key={col.name} value={col.name}>
                      {col.name}
                    </option>
                  ))}
                </select>

                <select
                  value={binding.updateCondition || 'on_success'}
                  onChange={(e) =>
                    updateBinding(
                      index,
                      'updateCondition',
                      e.target.value as ReturnBinding['updateCondition']
                    )
                  }
                  className="shell-field-input w-full px-3 py-2 text-sm"
                >
                  <option value="always">始终</option>
                  <option value="on_success">成功时</option>
                  <option value="on_change">有值时</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="shell-upload-dropzone py-8 text-center text-sm text-slate-500">
          暂无返回值绑定
        </div>
      )}
    </div>
  );
}
