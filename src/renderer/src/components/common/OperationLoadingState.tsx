/**
 * 统一的操作加载状态组件
 * 用于显示数据操作的加载状态和进度
 */

import React from 'react';
import { Loader2, Info, AlertTriangle } from 'lucide-react';

export interface OperationLoadingStateProps {
  loading: boolean;
  operation: string; // "筛选"、"聚合"、"排序"等
  progress?: number; // 可选的进度百分比 (0-100)
  message?: string; // 可选的详细信息
  type?: 'info' | 'warning' | 'error'; // 消息类型
}

export function OperationLoadingState({
  loading,
  operation,
  progress,
  message,
  type = 'info',
}: OperationLoadingStateProps) {
  if (!loading && !message) return null;

  const getIcon = () => {
    if (loading) return <Loader2 className="w-4 h-4 animate-spin" />;
    if (type === 'warning') return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    if (type === 'error') return <AlertTriangle className="w-4 h-4 text-red-500" />;
    return <Info className="w-4 h-4 text-blue-500" />;
  };

  const getBackgroundColor = () => {
    if (type === 'warning') return 'bg-yellow-50 border-yellow-200';
    if (type === 'error') return 'bg-red-50 border-red-200';
    return 'bg-blue-50 border-blue-200';
  };

  return (
    <div className={`flex items-center gap-2 p-3 rounded-lg border ${getBackgroundColor()}`}>
      {getIcon()}

      <div className="flex-1">
        <div className="text-sm font-medium text-gray-700">
          {loading ? `正在${operation}...` : message}
        </div>

        {progress !== undefined && progress >= 0 && progress <= 100 && (
          <div className="mt-1">
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs text-gray-500 mt-1">{progress.toFixed(0)}%</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 预览统计信息组件
 */
export interface PreviewStatsProps {
  icon?: React.ReactNode;
  label: string;
  value: string | number;
  description?: string;
  type?: 'success' | 'warning' | 'info' | 'error';
}

export function PreviewStats({
  icon,
  label,
  value,
  description,
  type = 'info',
}: PreviewStatsProps) {
  const getTextColor = () => {
    switch (type) {
      case 'success':
        return 'text-green-600';
      case 'warning':
        return 'text-yellow-600';
      case 'error':
        return 'text-red-600';
      default:
        return 'text-blue-600';
    }
  };

  const getBgColor = () => {
    switch (type) {
      case 'success':
        return 'bg-green-50 border-green-200';
      case 'warning':
        return 'bg-yellow-50 border-yellow-200';
      case 'error':
        return 'bg-red-50 border-red-200';
      default:
        return 'bg-blue-50 border-blue-200';
    }
  };

  return (
    <div className={`p-3 rounded-lg border ${getBgColor()}`}>
      <div className="flex items-start gap-2">
        {icon && <div className={`flex-shrink-0 ${getTextColor()}`}>{icon}</div>}
        <div className="flex-1">
          <div className="text-sm text-gray-600">{label}</div>
          <div className={`text-lg font-semibold ${getTextColor()}`}>
            {typeof value === 'number' ? value.toLocaleString() : value}
          </div>
          {description && <div className="text-xs text-gray-500 mt-1">{description}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * 预览警告组件
 */
export interface PreviewWarningProps {
  title: string;
  message: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function PreviewWarning({ title, message, action }: PreviewWarningProps) {
  return (
    <div className="p-3 rounded-lg border border-yellow-200 bg-yellow-50">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-yellow-800">{title}</h4>
          <p className="text-sm text-yellow-700 mt-1">{message}</p>
          {action && (
            <button
              onClick={action.onClick}
              className="mt-2 text-sm font-medium text-yellow-800 hover:text-yellow-900 underline"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 预览表格组件（用于显示样本数据）
 */
export interface PreviewTableProps {
  title?: string;
  columns: string[];
  rows: any[];
  maxRows?: number;
}

export function PreviewTable({ title, columns, rows, maxRows = 5 }: PreviewTableProps) {
  const displayRows = rows.slice(0, maxRows);

  return (
    <div className="mt-3">
      {title && <h4 className="text-sm font-medium text-gray-700 mb-2">{title}</h4>}

      <div className="overflow-x-auto border rounded-lg">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col, idx) => (
                <th
                  key={idx}
                  className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {displayRows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-gray-50">
                {columns.map((col, colIdx) => (
                  <td key={colIdx} className="px-3 py-2 text-sm text-gray-900 whitespace-nowrap">
                    {formatCellValue(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > maxRows && (
        <p className="text-xs text-gray-500 mt-2">
          显示前 {maxRows} 条，共 {rows.length} 条
        </p>
      )}
    </div>
  );
}

/**
 * 格式化单元格值
 */
function formatCellValue(value: any): string {
  if (value === null || value === undefined) {
    return '(null)';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
