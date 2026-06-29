/**
 * ImportPreviewDialog - 导入预览对话框（重构版）
 * 显示数据集导入预览，允许用户确认或调整字段类型
 *
 * 使用增强版DialogV2组件，支持焦点锁定、滚动锁定、ESC关闭等功能
 */

import React from 'react';
import { DialogV2 } from '../ui/dialog-v2';
import { Button } from '../ui/button';
import {
  Hash,
  Link,
  Type,
  Calendar,
  Mail,
  CheckSquare,
  ListFilter,
  Tags,
  Paperclip,
  Zap,
  Lock,
} from 'lucide-react';

interface EnhancedColumnSchema {
  name: string;
  duckdbType: string;
  fieldType: string;
  nullable: boolean;
  metadata?: Record<string, unknown>;
  storageMode?: 'physical' | 'computed';
  computeConfig?: Record<string, unknown>;
}

interface ImportPreviewDialogProps {
  open: boolean;
  datasetId: string;
  schema: EnhancedColumnSchema[];
  sampleData: Record<string, unknown>[];
  onConfirm: (schema: EnhancedColumnSchema[]) => void;
  onCancel: () => void;
}

/**
 * 根据字段类型获取对应的图标
 */
function getFieldIcon(
  duckdbType?: string,
  fieldType?: string,
  locked?: boolean,
  storageMode?: 'physical' | 'computed'
): React.ReactNode {
  const iconSize = 14;
  const iconClass = 'text-gray-500';

  // 如果是计算列，显示 ƒ 图标
  if (storageMode === 'computed') {
    return (
      <span className="text-blue-600 font-serif font-bold italic" style={{ fontSize: '16px' }}>
        ƒ
      </span>
    );
  }

  // 如果字段锁定，显示锁图标
  if (locked) {
    return <Lock size={iconSize} className={iconClass} />;
  }

  // 根据 fieldType 判断
  if (fieldType) {
    switch (fieldType) {
      case 'url':
      case 'hyperlink':
        return <Link size={iconSize} className={iconClass} />;
      case 'email':
        return <Mail size={iconSize} className={iconClass} />;
      case 'date':
        return <Calendar size={iconSize} className={iconClass} />;
      case 'boolean':
        return <CheckSquare size={iconSize} className={iconClass} />;
      case 'single_select':
        return <ListFilter size={iconSize} className={iconClass} />;
      case 'multi_select':
        return <Tags size={iconSize} className={iconClass} />;
      case 'attachment':
        return <Paperclip size={iconSize} className={iconClass} />;
      case 'button':
        return <Zap size={iconSize} className={iconClass} />;
      default:
        break;
    }
  }

  // 根据 DuckDB 类型判断
  if (duckdbType) {
    if (isNumericType(duckdbType)) {
      return <Hash size={iconSize} className={iconClass} />;
    }
  }

  // 默认文本图标
  return <Type size={iconSize} className={iconClass} />;
}

function isNumericType(duckdbType: string): boolean {
  const numericTypes = [
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'TINYINT',
    'DOUBLE',
    'DECIMAL',
    'FLOAT',
    'NUMERIC',
    'REAL',
  ];
  return numericTypes.some((nt) => duckdbType.toUpperCase().includes(nt));
}

function renderCellValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-gray-400">-</span>;
  }

  if (typeof value === 'boolean') {
    return value ? '✓' : '✗';
  }

  if (typeof value === 'object') {
    return <span className="text-gray-400">[对象]</span>;
  }

  const stringValue = String(value);
  if (stringValue.length > 50) {
    return stringValue.substring(0, 50) + '...';
  }

  return stringValue;
}

export function ImportPreviewDialog({
  open,
  datasetId: _datasetId,
  schema,
  sampleData,
  onConfirm,
  onCancel,
}: ImportPreviewDialogProps) {
  return (
    <DialogV2
      open={open}
      onClose={onCancel}
      title="导入预览 - 确认字段类型"
      description={`识别到 ${schema.length} 列，前 ${sampleData.length} 行数据`}
      maxWidth="5xl"
      contentClassName="max-h-[calc(90vh-250px)] overflow-auto"
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => onConfirm(schema)}>确认导入</Button>
        </>
      }
    >
      <div className="border rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {schema.map((col) => (
                <th
                  key={col.name}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider"
                >
                  <div className="flex items-center gap-2">
                    {getFieldIcon(col.duckdbType, col.fieldType, false, col.storageMode)}
                    <div className="flex flex-col">
                      <span className="font-semibold">{col.name}</span>
                      <span className="text-gray-400 normal-case font-normal">{col.fieldType}</span>
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sampleData.map((row, idx) => (
              <tr key={idx} className="hover:bg-gray-50">
                {schema.map((col) => (
                  <td key={col.name} className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap">
                    {renderCellValue(row[col.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DialogV2>
  );
}
