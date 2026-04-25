import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import type { RowHeightValue } from '../../../../../core/query-engine/types';

interface RowHeightPanelProps {
  currentHeight?: RowHeightValue;
  onClose: () => void;
  onApply: (config: { rowHeight: RowHeightValue }) => void | Promise<void>;
  onSaveAsTemplate?: (config: { rowHeight: RowHeightValue }) => void;
  anchorEl?: HTMLElement | null;
}

export const RowHeightPanel: React.FC<RowHeightPanelProps> = ({
  currentHeight = 'normal',
  onClose,
  onApply,
  onSaveAsTemplate,
  anchorEl,
}) => {
  const [heightMode, setHeightMode] = useState<'preset' | 'custom'>(
    typeof currentHeight === 'number' ? 'custom' : 'preset'
  );
  const [presetHeight, setPresetHeight] = useState<'compact' | 'normal' | 'comfortable'>(
    typeof currentHeight === 'string' ? currentHeight : 'normal'
  );
  const [customHeight, setCustomHeight] = useState(
    typeof currentHeight === 'number' ? currentHeight : 32
  );

  const getCurrentConfig = () => ({
    rowHeight: heightMode === 'preset' ? presetHeight : customHeight,
  });

  const handleApply = () => {
    void onApply(getCurrentConfig());
  };

  const presetOptions = [
    { value: 'compact', label: '紧凑', height: 24, description: '适合大量数据浏览' },
    { value: 'normal', label: '正常', height: 32, description: '默认推荐高度' },
    { value: 'comfortable', label: '舒适', height: 48, description: '适合详细阅读' },
  ];

  // Title content for AnchoredPanel
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">行高设置</span>
      <HelpCircle size={16} className="text-gray-400" />
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl ?? null}
      title={titleContent}
      width="480px"
    >
      <div className="px-5 py-3">
        <div className="space-y-4">
          {/* 预设高度选项 */}
          <div>
            <label className="flex items-center gap-2 mb-3">
              <input
                type="radio"
                checked={heightMode === 'preset'}
                onChange={() => setHeightMode('preset')}
                className="w-4 h-4"
              />
              <span className="font-medium text-gray-700">预设高度</span>
            </label>

            <div className="ml-6 space-y-2">
              {presetOptions.map((option) => (
                <label
                  key={option.value}
                  className={`
                      flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all
                      ${
                        presetHeight === option.value && heightMode === 'preset'
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }
                      ${heightMode !== 'preset' ? 'opacity-50' : ''}
                    `}
                >
                  <input
                    type="radio"
                    name="preset"
                    checked={presetHeight === option.value}
                    onChange={() => {
                      setPresetHeight(option.value as any);
                      setHeightMode('preset');
                    }}
                    disabled={heightMode !== 'preset'}
                    className="w-4 h-4"
                  />
                  <div className="flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-sm text-gray-500">({option.height}px)</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">{option.description}</p>
                  </div>
                  {/* 视觉示例 */}
                  <div className="flex flex-col gap-0.5">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="bg-gray-300 rounded"
                        style={{
                          width: '60px',
                          height: `${option.height / 3}px`,
                        }}
                      />
                    ))}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* 自定义高度 */}
          <div>
            <label className="flex items-center gap-2 mb-3">
              <input
                type="radio"
                checked={heightMode === 'custom'}
                onChange={() => setHeightMode('custom')}
                className="w-4 h-4"
              />
              <span className="font-medium text-gray-700">自定义高度</span>
            </label>

            <div className="ml-6">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  value={customHeight}
                  onChange={(e) => {
                    setCustomHeight(Number(e.target.value));
                    setHeightMode('custom');
                  }}
                  min={16}
                  max={100}
                  disabled={heightMode !== 'custom'}
                  className="flex-1"
                />
                <input
                  type="number"
                  value={customHeight}
                  onChange={(e) => {
                    const val = Math.max(16, Math.min(100, Number(e.target.value)));
                    setCustomHeight(val);
                    setHeightMode('custom');
                  }}
                  disabled={heightMode !== 'custom'}
                  min={16}
                  max={100}
                  className="border rounded px-3 py-1 w-20 text-center"
                />
                <span className="text-sm text-gray-600">px</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">范围：16-100 像素</p>
            </div>
          </div>
        </div>

        {/* 当前设置提示 */}
        <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
          <p>
            <strong>当前行高：</strong>
            {heightMode === 'preset'
              ? `${presetOptions.find((o) => o.value === presetHeight)?.label} (${presetOptions.find((o) => o.value === presetHeight)?.height}px)`
              : `自定义 (${customHeight}px)`}
          </p>
          <p className="text-xs mt-1 text-blue-600">
            * 应用后会写入当前查询模板；另存模板可复用到其他视图
          </p>
        </div>

        {/* Apply Button */}
        <div className="mt-4">
          <button
            onClick={handleApply}
            className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors"
          >
            应用设置
          </button>
        </div>

        {/* Bottom Link */}
        <div className="mt-3">
          <button
            onClick={() => onSaveAsTemplate?.(getCurrentConfig())}
            className="text-sm text-blue-600 hover:text-blue-700 transition-colors"
          >
            保存查询模板
          </button>
        </div>
      </div>
    </AnchoredPanel>
  );
};
