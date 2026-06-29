import React, { useState } from 'react';
import { HelpCircle, TrendingUp, Loader2 } from 'lucide-react';
import { AnchoredPanel } from '../../common/AnchoredPanel';
import type { GroupConfig } from '../../../../../core/query-engine/types';
import { selectActiveQueryConfig, useDatasetStore } from '../../../stores/datasetStore';
import { toast } from '../../../lib/toast';

interface ColumnInfo {
  name: string;
  type: string;
}

interface GroupPanelProps {
  columns: ColumnInfo[];
  onClose: () => void;
  onApply: (config: GroupConfig | null) => void;
  anchorEl?: HTMLElement | null;
}

export const GroupPanel: React.FC<GroupPanelProps> = ({
  columns,
  onClose,
  onApply,
  anchorEl,
}) => {
  // ✅ 从当前查询模板读取分组配置
  const currentConfig = useDatasetStore(selectActiveQueryConfig)?.group;

  // 状态管理
  const [selectedField, setSelectedField] = useState<string>(
    currentConfig?.field || columns[0]?.name || ''
  );
  const [order, setOrder] = useState<'asc' | 'desc'>(currentConfig?.order || 'asc');
  const [showStats, setShowStats] = useState<boolean>(currentConfig?.showStats !== false);
  const [applying, setApplying] = useState(false);

  // 判断字段类型
  const fieldInfo = columns.find((col) => col.name === selectedField);
  const isNumeric =
    fieldInfo?.type?.toLowerCase().includes('int') ||
    fieldInfo?.type?.toLowerCase().includes('float') ||
    fieldInfo?.type?.toLowerCase().includes('double') ||
    fieldInfo?.type?.toLowerCase().includes('decimal') ||
    fieldInfo?.type?.toLowerCase().includes('numeric');

  // 应用分组
  const handleApply = async () => {
    if (!selectedField) {
      toast.warning('请选择分组字段');
      return;
    }

    const config: GroupConfig = {
      field: selectedField,
      order,
      showStats,
    };

    setApplying(true);
    try {
      await onApply(config);
    } finally {
      setApplying(false);
    }
  };

  // 取消分组
  const handleCancel = async () => {
    setApplying(true);
    try {
      await onApply(null); // 传递 null 表示取消分组
    } finally {
      setApplying(false);
    }
  };

  // Title content
  const titleContent = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">分组设置</span>
      <HelpCircle size={16} className="text-gray-400" />
    </div>
  );

  return (
    <AnchoredPanel
      open={true}
      onClose={onClose}
      anchorEl={anchorEl ?? null}
      title={titleContent}
      width="420px"
    >
      <div className="px-5 py-4 space-y-4">
        {/* 分组字段选择 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">分组字段</label>
          <select
            value={selectedField}
            onChange={(e) => setSelectedField(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          >
            {columns.map((col) => (
              <option key={col.name} value={col.name}>
                {col.name} ({col.type})
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">数据将按此字段分组显示</p>
        </div>

        {/* 排序方向 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">排序方向</label>
          <div className="flex gap-2">
            <button
              onClick={() => setOrder('asc')}
              className={`flex-1 px-4 py-2 text-sm border rounded transition-colors ${
                order === 'asc'
                  ? 'bg-blue-100 border-blue-300 text-blue-700'
                  : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {isNumeric ? '0 → 9' : 'A → Z'}
            </button>
            <button
              onClick={() => setOrder('desc')}
              className={`flex-1 px-4 py-2 text-sm border rounded transition-colors ${
                order === 'desc'
                  ? 'bg-blue-100 border-blue-300 text-blue-700'
                  : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {isNumeric ? '9 → 0' : 'Z → A'}
            </button>
          </div>
        </div>

        {/* 显示统计信息 */}
        <div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showStats}
              onChange={(e) => setShowStats(e.target.checked)}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">显示分组统计</span>
            <TrendingUp size={14} className="text-gray-400" />
          </label>
          <p className="text-xs text-gray-500 mt-1 ml-6">
            为每个分组显示计数、求和、平均值等统计信息
          </p>
        </div>

        {/* 说明 */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-xs text-blue-800">
            <strong>提示：</strong>分组后数据会按选定字段排列，相同值的记录会显示在一起。
            {showStats && '统计信息会显示在分组标题处。'}
          </p>
        </div>
      </div>

      {/* 底部按钮 */}
      <div className="px-5 py-3 border-t border-gray-200 flex justify-between">
        {currentConfig ? (
          <button
            onClick={handleCancel}
            disabled={applying}
            className="text-sm text-red-600 hover:text-red-700 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {applying && <Loader2 className="w-3 h-3 animate-spin" />}
            {applying ? '取消中...' : '取消分组'}
          </button>
        ) : (
          <div />
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            关闭
          </button>
          <button
            onClick={handleApply}
            disabled={applying}
            className="px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {applying ? '应用中...' : '应用分组'}
          </button>
        </div>
      </div>
    </AnchoredPanel>
  );
};
