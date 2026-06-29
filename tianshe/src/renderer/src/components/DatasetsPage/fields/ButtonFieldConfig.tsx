/**
 * 按钮字段配置组件（重构版）
 *
 * 支持：
 * - JS 插件方法绑定
 * - 参数绑定（字段/固定值/行ID/数据集ID）
 * - 返回值绑定
 * - 触发链配置
 */

import { useState, useEffect } from 'react';
import { AlertCircle, Settings, Link, Zap, ChevronDown } from 'lucide-react';
import { usePluginStore } from '../../../stores/pluginStore';
import { SimpleParameterBinding } from './SimpleParameterBinding';
import { SimpleReturnBinding } from './SimpleReturnBinding';
import { TriggerChainConfig } from './TriggerChainConfig';
import type {
  ParameterBinding,
  ReturnBinding,
  TriggerChainConfig as ButtonTriggerChainConfig,
} from '../../../../../main/duckdb/types';
import {
  buildButtonMetadataForPersistence,
  normalizeButtonMetadata,
} from '../../../../../utils/button-metadata';

export interface ButtonFieldConfigProps {
  value: any;
  columns: Array<{ name: string; type: string }>;
  onChange: (config: any) => void;
}

type TabType = 'basic' | 'params' | 'returns' | 'triggers';

export function ButtonFieldConfig({ value = {}, columns, onChange }: ButtonFieldConfigProps) {
  const normalizedValue = normalizeButtonMetadata(value);
  const {
    pluginId = '',
    methodId = '',
    buttonLabel = '执行',
    buttonIcon = '▶️',
    buttonVariant = 'primary',
    confirmMessage = '',
    showResult = true,
    timeout = 120000,
  } = normalizedValue;
  const parameterBindings = normalizedValue.parameterBindings as ParameterBinding[];
  const returnBindings = normalizedValue.returnBindings as ReturnBinding[];
  const triggerChain = normalizedValue.triggerChain as ButtonTriggerChainConfig | undefined;

  const [activeTab, setActiveTab] = useState<TabType>('basic');
  const { plugins, loadPlugins, pluginsLoading } = usePluginStore();

  // 加载插件列表
  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  // 更新配置
  const updateConfig = (updates: Record<string, unknown>) => {
    onChange(buildButtonMetadataForPersistence({ ...value, ...updates }));
  };

  // 获取当前选中插件的按钮列（用于触发链）
  const buttonColumns = columns
    .filter((col) => col.type === 'button')
    .map((col) => ({ name: col.name }));

  // 按钮样式选项
  const variantOptions = [
    {
      value: 'default',
      label: '默认',
      color:
        'border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50',
    },
    {
      value: 'primary',
      label: '主要',
      color: 'bg-slate-900 text-white shadow-sm hover:bg-slate-800',
    },
    {
      value: 'success',
      label: '成功',
      color: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700',
    },
    {
      value: 'danger',
      label: '危险',
      color: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700',
    },
  ];

  // Tab 配置
  const tabs: Array<{ id: TabType; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'basic', label: '基础配置', icon: <Settings className="w-4 h-4" /> },
    {
      id: 'params',
      label: '参数绑定',
      icon: <Link className="w-4 h-4" />,
      badge: parameterBindings.length,
    },
    {
      id: 'returns',
      label: '返回值',
      icon: <ChevronDown className="w-4 h-4" />,
      badge: returnBindings.length,
    },
    {
      id: 'triggers',
      label: '触发链',
      icon: <Zap className="w-4 h-4" />,
      badge: triggerChain?.triggers?.length || 0,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="shell-tab-strip flex w-full flex-wrap gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`
              shell-tab-button flex items-center gap-2
              ${activeTab === tab.id ? 'shell-tab-button--active text-slate-900' : 'text-slate-500'}
            `}
          >
            {tab.icon}
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="shell-field-chip shell-field-chip--accent px-1.5 py-0.5 text-xs">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'basic' && (
        <div className="space-y-4">
          <div className="shell-soft-card space-y-4 p-5">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                绑定的插件 <span className="text-rose-500">*</span>
              </label>
              <select
                value={pluginId}
                onChange={(e) => updateConfig({ pluginId: e.target.value, methodId: '' })}
                className="shell-field-input px-3 py-2 text-sm"
                disabled={pluginsLoading}
              >
                <option value="">{pluginsLoading ? '加载中...' : '选择插件'}</option>
                {plugins
                  .filter((p) => p.enabled !== false)
                  .map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.icon || '🔌'} {plugin.name} (v{plugin.version})
                    </option>
                  ))}
              </select>
              {!pluginId && (
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  选择一个插件，点击按钮时将调用该插件的方法。
                </p>
              )}
            </div>

            {pluginId && (
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  方法 ID <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={methodId}
                  onChange={(e) => updateConfig({ methodId: e.target.value })}
                  placeholder="例如: publishProduct"
                  className="shell-field-input w-full px-3 py-2 font-mono text-sm"
                />
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  输入插件中使用 <code className="bg-slate-100 px-1 rounded">registerCommand</code>{' '}
                  注册的命令 ID。
                </p>
              </div>
            )}
          </div>

          <div className="shell-soft-card space-y-4 p-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">按钮文字</label>
                <input
                  type="text"
                  value={buttonLabel}
                  onChange={(e) => updateConfig({ buttonLabel: e.target.value })}
                  placeholder="执行"
                  className="shell-field-input w-full px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  按钮图标（Emoji）
                </label>
                <input
                  type="text"
                  value={buttonIcon}
                  onChange={(e) => updateConfig({ buttonIcon: e.target.value })}
                  placeholder="▶️"
                  className="shell-field-input w-full px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">按钮样式</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {variantOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => updateConfig({ buttonVariant: option.value })}
                    className={`
                      shell-field-control flex items-center justify-center px-3 py-2 text-sm font-medium transition-all
                      ${buttonVariant === option.value ? 'shell-field-control--active' : ''}
                      ${option.color}
                    `}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                执行超时（毫秒）
              </label>
              <input
                type="number"
                value={timeout}
                onChange={(e) => updateConfig({ timeout: parseInt(e.target.value) || 120000 })}
                min={1000}
                step={1000}
                className="shell-field-input w-full px-3 py-2 text-sm"
              />
              <p className="mt-2 text-xs text-slate-500">默认 120 秒（120000 毫秒）。</p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                确认消息（可选）
              </label>
              <input
                type="text"
                value={confirmMessage}
                onChange={(e) => updateConfig({ confirmMessage: e.target.value })}
                placeholder="确定要执行该操作吗？"
                className="shell-field-input w-full px-3 py-2 text-sm"
              />
              <p className="mt-2 text-xs text-slate-500">设置后，点击按钮时会先弹出确认对话框。</p>
            </div>

            <label className="shell-content-muted flex items-center gap-3 rounded-2xl border border-slate-200/80 px-4 py-3">
              <input
                type="checkbox"
                id="showResult"
                checked={showResult}
                onChange={(e) => updateConfig({ showResult: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-1 focus:ring-sky-500"
              />
              <span className="text-sm text-slate-700">执行完成后显示结果通知</span>
            </label>
          </div>

          <div className="shell-soft-card space-y-4 p-5">
            <div>
              <label className="mb-3 block text-sm font-medium text-slate-700">按钮预览</label>
              <div className="shell-content-muted rounded-2xl border border-slate-200/80 p-4">
                <button
                  disabled
                  className={`
                    px-4 py-2 text-sm font-medium rounded-xl transition-colors opacity-75 cursor-not-allowed
                    ${variantOptions.find((o) => o.value === buttonVariant)?.color}
                  `}
                >
                  {buttonIcon} {buttonLabel}
                </button>
              </div>
            </div>

            {(!pluginId || !methodId) && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                  <div className="text-xs text-amber-800">
                    <p className="font-medium">配置不完整</p>
                    <p className="mt-1 leading-5">请选择插件并输入方法 ID，按钮才能正常工作。</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'params' && (
        <div className="shell-soft-card p-5">
          <SimpleParameterBinding
            columns={columns}
            bindings={parameterBindings}
            onChange={(bindings) => updateConfig({ parameterBindings: bindings })}
          />
        </div>
      )}

      {activeTab === 'returns' && (
        <div className="shell-soft-card p-5">
          <SimpleReturnBinding
            columns={columns}
            bindings={returnBindings}
            onChange={(bindings) => updateConfig({ returnBindings: bindings })}
          />
        </div>
      )}

      {activeTab === 'triggers' && (
        <div className="shell-soft-card p-5">
          <TriggerChainConfig
            buttonColumns={buttonColumns}
            config={triggerChain}
            onChange={(config) => updateConfig({ triggerChain: config })}
          />
        </div>
      )}
    </div>
  );
}
