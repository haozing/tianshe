/**
 * 列定义生成器
 * 根据数据 schema 自动生成 TanStack Table 列配置
 */

import React from 'react';
import { ColumnDef } from '@tanstack/react-table';
import {
  Lock,
  Plus,
  Hash,
  Link,
  Type,
  Calendar,
  Mail,
  CheckSquare,
  ChevronDown,
  ListFilter,
  Tags,
  Paperclip,
  Zap,
} from 'lucide-react';
import { ButtonCell } from './ButtonCell';
import type { ColorRule } from '../../../../../core/query-engine/types';
import { GroupCell } from './GroupCell';
import { AggregatedCell } from './AggregatedCell';
import { formatAggregatedValue } from './utils/aggregation';
import { EditableCell } from './EditableCell';
import {
  isSystemColumn,
  isWritableColumn,
} from '../../../../../utils/dataset-column-capabilities';

export type TableRow = Record<string, unknown>;

export interface ColumnMetadata {
  options?: string[];
  separator?: string;
  includeTime?: boolean;
  maxFileSize?: number;
  allowedTypes?: string[];
  colorMap?: Record<string, string>;
  buttonLabel?: string;
  buttonIcon?: string;
  buttonColor?: string;
  buttonVariant?: 'default' | 'primary' | 'success' | 'danger';
  pluginId?: string;
  methodId?: string;
  confirmMessage?: string;
  showResult?: boolean;
  [key: string]: unknown;
}

export interface ColumnComputeParams extends Record<string, unknown> {
  priceField?: string;
  quantityField?: string;
  discountType?: string;
  originalPriceField?: string;
  discountedPriceField?: string;
  field?: string;
  boundaries?: number[];
  labels?: string[];
  fields?: string[];
  separator?: string;
}

export interface ColumnComputeConfig {
  type?: 'amount' | 'discount' | 'bucket' | 'concat' | 'custom' | string;
  expression?: string;
  params?: ColumnComputeParams;
}

export interface ColumnSchema {
  name: string;
  duckdbType?: string; // DuckDB物理类型 (与后端保持一致)
  fieldType?: string; // 业务逻辑类型
  nullable?: boolean; // 是否可空
  metadata?: ColumnMetadata; // 类型特定的元数据
  locked?: boolean; // 是否锁定列
  width?: number; // 列宽
  storageMode?: 'physical' | 'computed'; // 存储模式
  computeConfig?: ColumnComputeConfig; // 计算列配置
}

export interface ColumnOptions {
  enableCheckbox?: boolean; // 是否启用行选择 checkbox
  enableAddColumn?: boolean; // 是否启用添加列按钮
  enableSorting?: boolean; // 是否启用表头本地排序
  editable?: boolean; // 是否可编辑
  datasetId?: string; // 数据集 ID（用于附件上传等功能）
  onCellValueChange?: (rowId: number, columnId: string, newValue: unknown) => void;
  onAddColumn?: () => void;
  onEditColumn?: (columnName: string, columnSchema: ColumnSchema) => void; // 编辑列回调
  readOnly?: boolean;
  colorRules?: ColorRule[]; // 🆕 填色规则
  // 🆕 单元格保存状态和错误
  savingCells?: Set<string>;
  cellErrors?: Map<string, string>;
  data?: TableRow[];
}

/**
 * 格式化计算列公式为可读文本
 */
function formatComputeFormula(computeConfig?: ColumnComputeConfig): string {
  if (!computeConfig) return '';

  const { type, expression, params } = computeConfig;

  switch (type) {
    case 'amount':
      return `金额计算: ${params?.priceField || '?'} × ${params?.quantityField || '?'}`;
    case 'discount':
      if (params?.discountType === 'percentage') {
        return `折扣率: (${params?.originalPriceField || '?'} - ${params?.discountedPriceField || '?'}) / ${params?.originalPriceField || '?'} × 100%`;
      } else {
        return `折扣额: ${params?.originalPriceField || '?'} - ${params?.discountedPriceField || '?'}`;
      }
    case 'bucket':
      return `分桶: ${params?.field || '?'} → [${params?.boundaries?.join(', ') || '?'}]`;
    case 'concat':
      return `拼接: ${params?.fields?.join(` ${params?.separator || '+'} `) || '?'}`;
    case 'custom':
      return `自定义: ${expression || '?'}`;
    default:
      return '计算列';
  }
}

/**
 * 根据字段类型和fieldType获取对应的图标
 */
function getFieldIcon(
  duckdbType?: string,
  fieldType?: string,
  locked?: boolean,
  storageMode?: 'physical' | 'computed'
): React.ReactNode {
  const iconSize = 14;

  // 如果是计算列，显示 ƒ 图标（特殊颜色）
  if (storageMode === 'computed') {
    return (
      <span className="text-blue-600 font-serif font-bold italic" style={{ fontSize: '16px' }}>
        ƒ
      </span>
    );
  }

  const iconClass = 'text-gray-500';

  // 如果字段锁定，显示锁图标
  if (locked) {
    return <Lock size={iconSize} className={iconClass} />;
  }

  // 根据 fieldType 优先判断
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

/**
 * 从 schema 创建列定义
 */
export function createColumnsFromSchema(
  schema: ColumnSchema[],
  data?: any[],
  options?: ColumnOptions
): ColumnDef<any>[] {
  // ✅ 移除早期返回，允许 schema 为空
  // 即使 schema 为空，也要显示 checkbox 和"添加列"按钮

  const enableSorting = options?.enableSorting === true;

  // 🆕 过滤掉所有系统列（_row_id, created_at, updated_at 不显示给用户）
  const userSchema =
    schema?.filter((col) => !isSystemColumn(col)) || [];

  const columns: ColumnDef<any>[] = [];

  // 1. 添加 Checkbox 选择列（如果启用）
  if (options?.enableCheckbox) {
    columns.push({
      id: '_select',
      header: ({ table }) => {
        const isSomeSelected = table.getIsSomeRowsSelected();
        return (
          <div className="select-header-cell">
            <input
              type="checkbox"
              className="header-checkbox"
              checked={table.getIsAllRowsSelected()}
              ref={(input) => {
                if (input) {
                  input.indeterminate = isSomeSelected && !table.getIsAllRowsSelected();
                }
              }}
              onChange={table.getToggleAllRowsSelectedHandler()}
            />
          </div>
        );
      },
      cell: ({ row }) => {
        const rowId = (row.original as any)?._row_id;
        return (
          <div className="select-cell">
            <span className="row-id">{typeof rowId === 'number' ? rowId : '-'}</span>
            <input
              type="checkbox"
              className="row-checkbox"
              checked={row.getIsSelected()}
              disabled={!row.getCanSelect()}
              onChange={row.getToggleSelectedHandler()}
            />
          </div>
        );
      },
      size: 50,
      minSize: 50,
      maxSize: 50,
      enableSorting: false,
      enableGrouping: false,
      enableResizing: false,
    });
  }

  // 2. 添加数据列（仅当 schema 存在时）
  // ✅ 即使 userSchema 为空，也会继续处理 checkbox 和"添加列"按钮
  const dataColumns =
    userSchema.length > 0
      ? userSchema.map((col, index) => {
          const sampleValue = data && data.length > 0 ? data[0][col.name] : null;
          const aggregationType = getAggregationType(col.duckdbType, sampleValue);

          const isFirstDataColumn = index === 0;
          const isEditable = options?.editable && isWritableColumn(col);
          const defaultColumnSize =
            col.width ??
            (col.fieldType === 'hyperlink' || col.fieldType === 'url'
              ? 260
              : col.fieldType === 'email'
                ? 220
                : col.fieldType === 'date'
                  ? col.metadata?.includeTime
                    ? 190
                    : 150
                  : col.fieldType === 'attachment'
                    ? 190
                    : col.fieldType === 'button'
                      ? 150
                      : 150);
          const minColumnSize =
            col.fieldType === 'hyperlink' || col.fieldType === 'url' || col.fieldType === 'email'
              ? 180
              : col.fieldType === 'date'
                ? col.metadata?.includeTime
                  ? 170
                  : 130
                : 80;

          // 对于单选字段，提取列中的所有唯一值
          let enhancedMetadata = col.metadata;
          if (col.fieldType === 'single_select' && data && data.length > 0) {
            // 从数据中提取该列的所有非空唯一值
            const uniqueValues = Array.from(
              new Set(
                data
                  .map((row) => row[col.name])
                  .filter((val) => val !== null && val !== undefined && val !== '')
                  .map((val) => String(val))
              )
            ).sort();

            // 合并预设选项和实际值
            const predefinedOptions = col.metadata?.options || [];
            const allOptions = Array.from(new Set([...predefinedOptions, ...uniqueValues])).sort();

            enhancedMetadata = {
              ...col.metadata,
              options: allOptions,
            };
          }

          const columnDef: ColumnDef<any> = {
            accessorKey: col.name,
            id: col.name,
            header: ({ column }) => {
              const tooltipText =
                col.storageMode === 'computed'
                  ? formatComputeFormula(col.computeConfig)
                  : undefined;

              const handleIconClick = (e: React.MouseEvent) => {
                if (col.storageMode === 'computed' && options?.onEditColumn) {
                  e.stopPropagation();
                  options.onEditColumn(col.name, col);
                }
              };

              return (
                <div className="field-header" title={tooltipText}>
                  <span
                    onClick={handleIconClick}
                    style={{ cursor: col.storageMode === 'computed' ? 'pointer' : 'default' }}
                  >
                    {getFieldIcon(col.duckdbType, col.fieldType, col.locked, col.storageMode)}
                  </span>
                  <span className="field-name">{col.name}</span>
                  {column.getCanSort() && (
                    <ChevronDown
                      size={12}
                      className={`sort-indicator ${column.getIsSorted() ? 'sorted' : ''}`}
                    />
                  )}
                </div>
              );
            },
            enableSorting,
            enableGrouping: true,
            enableResizing: true,
            size: defaultColumnSize,
            minSize: minColumnSize,

            // 第一列保持层级缩进；真正参与分组的列无论排第几列都使用分组头渲染。
            cell: ({ row, getValue, column }) => {
              if (isFirstDataColumn || row.getIsGrouped()) {
                return <GroupCell row={row} value={getValue()} />;
              }

              if (col.fieldType === 'button') {
                return (
                  <ButtonCell
                    rowData={row.original}
                    metadata={col.metadata}
                    datasetId={options?.datasetId}
                    readOnly={options?.readOnly}
                  />
                );
              }

              if (isEditable) {
                const rawRowId = (row.original as any)?._row_id;
                if (typeof rawRowId !== 'number') {
                  return renderCellValue(
                    getValue(),
                    col.duckdbType,
                    col.fieldType,
                    enhancedMetadata,
                    options?.colorRules,
                    col.name
                  );
                }

                const rowId = rawRowId;
                const cellKey = `${rowId}-${column.id}`;
                const isSaving = options?.savingCells?.has(cellKey) || false;
                const error = options?.cellErrors?.get(cellKey);

                return (
                  <EditableCell
                    value={getValue()}
                    rowId={rowId}
                    columnId={column.id}
                    type={col.duckdbType}
                    fieldType={col.fieldType}
                    metadata={enhancedMetadata}
                    datasetId={options?.datasetId}
                    onChange={options?.onCellValueChange}
                    isSaving={isSaving}
                    error={error}
                  />
                );
              }

              return renderCellValue(
                getValue(),
                col.duckdbType,
                col.fieldType,
                enhancedMetadata,
                options?.colorRules,
                col.name
              );
            },

            // 聚合函数
            aggregationFn: aggregationType,

            // 聚合单元格渲染
            aggregatedCell: ({ getValue }) => {
              const value = getValue();
              return (
                <AggregatedCell
                  value={value}
                  aggregationType={aggregationType as any}
                  format={(val) =>
                    formatAggregatedValue(val, aggregationType, {
                      currency: isCurrencyField(col.name),
                      decimals: getDecimals(col.duckdbType),
                    })
                  }
                />
              );
            },

            // 根据类型设置对齐方式
            meta: {
              align: isNumericType(col.duckdbType) ? 'right' : 'left',
              fieldName: col.name,
            },
          };

          return columnDef;
        })
      : []; // ✅ 空 schema 时返回空数组

  columns.push(...dataColumns);

  // 3. 添加"添加列"按钮列（如果启用）
  if (options?.enableAddColumn && options?.onAddColumn) {
    columns.push({
      id: '_add',
      header: () => (
        <button
          className="add-column-button"
          onClick={options.onAddColumn}
          title="添加列"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#9ca3af',
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#374151';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '#9ca3af';
          }}
        >
          <Plus size={16} />
        </button>
      ),
      cell: () => null,
      size: 50,
      minSize: 50,
      maxSize: 50,
      enableSorting: false,
      enableGrouping: false,
      enableResizing: false,
    });
  }

  return columns;
}

/**
 * 根据类型获取聚合函数
 */
function getAggregationType(
  duckdbType: string | undefined,
  _sampleValue: any
): 'sum' | 'mean' | 'count' | 'min' | 'max' {
  if (!duckdbType) return 'count'; // 防御性检查：类型未知时使用计数

  // 整数类型 - 求和
  if (duckdbType === 'INTEGER' || duckdbType === 'BIGINT') {
    return 'sum';
  }

  // 浮点数类型 - 平均值
  if (duckdbType === 'DOUBLE' || duckdbType === 'DECIMAL' || duckdbType === 'FLOAT') {
    return 'mean';
  }

  // 其他数值类型
  if (isNumericType(duckdbType)) {
    return 'sum';
  }

  // 非数值类型 - 计数
  return 'count';
}

/**
 * 判断是否为数值类型
 */
function isNumericType(duckdbType: string | undefined): boolean {
  if (!duckdbType) return false; // 防御性检查

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

  return numericTypes.includes(duckdbType.toUpperCase());
}

/**
 * 判断是否为货币字段
 */
function isCurrencyField(fieldName: string): boolean {
  const currencyKeywords = ['price', 'amount', 'cost', 'fee', '价格', '金额', '费用'];
  const lowerName = fieldName.toLowerCase();

  return currencyKeywords.some((keyword) => lowerName.includes(keyword));
}

/**
 * 获取小数位数
 */
function getDecimals(duckdbType: string | undefined): number {
  if (!duckdbType) return 0; // 防御性检查

  if (duckdbType === 'INTEGER' || duckdbType === 'BIGINT' || duckdbType === 'SMALLINT') {
    return 0;
  }

  if (duckdbType === 'DOUBLE' || duckdbType === 'DECIMAL' || duckdbType === 'FLOAT') {
    return 2;
  }

  return 0;
}

/**
 * 判断是否为日期时间类型
 */
function isDateType(duckdbType: string | undefined): boolean {
  if (!duckdbType) return false;
  const dateTypes = ['DATE', 'TIMESTAMP', 'TIME', 'DATETIME'];
  return dateTypes.some((dt) => duckdbType.toUpperCase().includes(dt));
}

/**
 * 根据文件扩展名返回对应的图标
 */
function getFileIcon(extension: string): string {
  const iconMap: Record<string, string> = {
    // 文档
    pdf: '📄',
    doc: '📝',
    docx: '📝',
    txt: '📃',
    rtf: '📝',
    odt: '📝',
    // 表格
    xls: '📊',
    xlsx: '📊',
    csv: '📊',
    ods: '📊',
    // 演示
    ppt: '📊',
    pptx: '📊',
    // 压缩
    zip: '📦',
    rar: '📦',
    '7z': '📦',
    tar: '📦',
    gz: '📦',
    // 代码
    js: '📜',
    ts: '📜',
    jsx: '📜',
    tsx: '📜',
    py: '📜',
    java: '📜',
    cpp: '📜',
    c: '📜',
    go: '📜',
    rs: '📜',
    // 默认
    default: '📎',
  };

  return iconMap[extension] || iconMap['default'];
}

/**
 * 检查单元格值是否匹配规则
 */
function matchesRule(cellValue: any, operator: ColorRule['operator'], ruleValue: string): boolean {
  // 处理 null/undefined
  if (cellValue === null || cellValue === undefined) {
    return operator === 'isEmpty';
  }

  const cellStr = String(cellValue);

  switch (operator) {
    case 'eq':
      return cellStr === ruleValue;
    case 'ne':
      return cellStr !== ruleValue;
    case 'gt':
      return Number(cellValue) > Number(ruleValue);
    case 'lt':
      return Number(cellValue) < Number(ruleValue);
    case 'gte':
      return Number(cellValue) >= Number(ruleValue);
    case 'lte':
      return Number(cellValue) <= Number(ruleValue);
    case 'contains':
      return cellStr.toLowerCase().includes(ruleValue.toLowerCase());
    case 'startsWith':
      return cellStr.toLowerCase().startsWith(ruleValue.toLowerCase());
    case 'endsWith':
      return cellStr.toLowerCase().endsWith(ruleValue.toLowerCase());
    case 'isEmpty':
      return cellStr === '' || cellValue === null || cellValue === undefined;
    case 'isNotEmpty':
      return cellStr !== '' && cellValue !== null && cellValue !== undefined;
    default:
      return false;
  }
}

/**
 * 应用颜色规则到单元格值
 * @param cellValue 单元格值
 * @param columnName 列名
 * @param colorRules 颜色规则数组
 * @returns 背景色（如果匹配），否则返回 undefined
 */
export function applyColorRules(
  cellValue: any,
  columnName: string,
  colorRules?: ColorRule[]
): string | undefined {
  if (!colorRules || colorRules.length === 0) {
    return undefined;
  }

  // 遍历规则（按顺序，第一个匹配的规则生效）
  for (const rule of colorRules) {
    if (rule.column === columnName) {
      if (matchesRule(cellValue, rule.operator, rule.value)) {
        return rule.color;
      }
    }
  }

  return undefined;
}

/**
 * 渲染单元格值（支持自定义类型）
 */
function renderCellValue(
  value: any,
  duckdbType: string | undefined,
  fieldType?: string,
  metadata?: any,
  colorRules?: ColorRule[], // 🆕 填色规则
  columnName?: string // 🆕 列名
): React.ReactNode {
  // 🆕 计算背景色（所有类型通用）
  const backgroundColor = applyColorRules(value, columnName || '', colorRules);

  if (value === null || value === undefined) {
    return (
      <span className="placeholder-cell" style={{ backgroundColor }}>
        -
      </span>
    );
  }

  // 单选类型 - 显示彩色标签
  if (fieldType === 'single_select' && value) {
    const valueStr = String(value);
    const colorMap = metadata?.colorMap || {};
    const color = colorMap[valueStr] || '#3B82F6';

    return (
      <div style={{ backgroundColor, padding: '4px' }} className="max-w-full min-w-0">
        <span
          className="inline-flex items-center px-2.5 py-0.5 rounded text-sm font-medium max-w-full min-w-0"
          style={{ backgroundColor: `${color}20`, color: color }}
          title={valueStr}
        >
          <span className="truncate min-w-0">{valueStr}</span>
        </span>
      </div>
    );
  }

  // 多选类型 - 显示多个标签
  if (fieldType === 'multi_select' && value) {
    const separator = metadata?.separator || ',';
    const values = String(value)
      .split(separator)
      .map((x) => x.trim())
      .filter(Boolean);

    return (
      <div
        className="flex flex-wrap gap-1 max-w-full min-w-0"
        style={{ backgroundColor, padding: '4px' }}
      >
        {values.map((val, idx) => (
          <span
            key={idx}
            className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-600 max-w-full min-w-0"
            title={val}
          >
            <span className="truncate min-w-0">{val}</span>
          </span>
        ))}
      </div>
    );
  }

  // ==========================================
  // 附件类型 - 图片/文档/视频等（独立类型）
  // ==========================================
  if (fieldType === 'attachment' && value) {
    const valueStr = String(value);
    const separator = metadata?.separator || ',';
    const urls = valueStr
      .split(separator)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    // 1. 图片附件
    if (metadata?.isImage) {
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {urls.slice(0, 3).map((url, idx) => (
            <a
              key={idx}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={url}
                alt={`img-${idx}`}
                className="w-10 h-10 object-cover rounded border border-gray-200 hover:border-blue-400 transition-colors cursor-pointer"
                onError={(e) => {
                  const target = e.currentTarget;
                  target.src =
                    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjZjNmNGY2Ii8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtc2l6ZT0iMTIiIGZpbGw9IiM5Y2EzYWYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7vvJ88L3RleHQ+PC9zdmc+';
                }}
              />
            </a>
          ))}
          {urls.length > 3 && <span className="text-xs text-gray-500">+{urls.length - 3}</span>}
        </div>
      );
    }

    // 2. 文档附件
    if (metadata?.isDocument || metadata?.fileType === 'document') {
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {urls.slice(0, 3).map((url, idx) => {
            const fileName = url.split('/').pop() || 'file';
            const ext = fileName.split('.').pop()?.toLowerCase() || '';

            return (
              <a
                key={idx}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 bg-gray-50 hover:bg-gray-100 rounded text-xs border border-gray-200 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-sm">{getFileIcon(ext)}</span>
                <span className="max-w-[100px] truncate text-gray-700">{fileName}</span>
              </a>
            );
          })}
          {urls.length > 3 && (
            <span className="text-xs text-gray-500">+{urls.length - 3} 文件</span>
          )}
        </div>
      );
    }

    // 3. 视频附件
    if (metadata?.isVideo) {
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {urls.slice(0, 2).map((url, idx) => {
            const fileName = url.split('/').pop() || 'video';
            return (
              <a
                key={idx}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 bg-blue-50 hover:bg-blue-100 rounded text-xs border border-blue-200 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-sm">🎬</span>
                <span className="max-w-[100px] truncate text-blue-700">{fileName}</span>
              </a>
            );
          })}
          {urls.length > 2 && (
            <span className="text-xs text-gray-500">+{urls.length - 2} 视频</span>
          )}
        </div>
      );
    }

    // 4. 音频附件
    if (metadata?.isAudio) {
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {urls.slice(0, 2).map((url, idx) => {
            const fileName = url.split('/').pop() || 'audio';
            return (
              <a
                key={idx}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 bg-purple-50 hover:bg-purple-100 rounded text-xs border border-purple-200 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-sm">🎵</span>
                <span className="max-w-[100px] truncate text-purple-700">{fileName}</span>
              </a>
            );
          })}
          {urls.length > 2 && (
            <span className="text-xs text-gray-500">+{urls.length - 2} 音频</span>
          )}
        </div>
      );
    }

    // 5. 压缩包附件
    if (metadata?.isArchive) {
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {urls.slice(0, 2).map((url, idx) => {
            const fileName = url.split('/').pop() || 'archive';
            return (
              <a
                key={idx}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 bg-orange-50 hover:bg-orange-100 rounded text-xs border border-orange-200 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-sm">📦</span>
                <span className="max-w-[100px] truncate text-orange-700">{fileName}</span>
              </a>
            );
          })}
          {urls.length > 2 && (
            <span className="text-xs text-gray-500">+{urls.length - 2} 压缩包</span>
          )}
        </div>
      );
    }

    // 6. 其他附件类型（通用处理）
    return (
      <div className="flex items-center gap-1 flex-wrap">
        {urls.slice(0, 3).map((url, idx) => {
          const fileName = url.split('/').pop() || 'file';
          return (
            <a
              key={idx}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:text-blue-800 underline"
              onClick={(e) => e.stopPropagation()}
            >
              {fileName}
            </a>
          );
        })}
        {urls.length > 3 && <span className="text-xs text-gray-500">+{urls.length - 3}</span>}
      </div>
    );
  }

  // 日期类型处理（优先处理，支持多种格式）
  if (fieldType === 'date' || isDateType(duckdbType)) {
    let dateValue: Date | null = null;

    // 尝试将值转换为Date对象
    if (value instanceof Date) {
      dateValue = value;
    } else if (typeof value === 'string') {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        dateValue = parsed;
      }
    } else if (typeof value === 'number') {
      // 时间戳（毫秒）
      dateValue = new Date(value);
    } else if (typeof value === 'object' && value !== null) {
      // 处理 DuckDB 日期对象格式：{year, month, day, hour?, minute?, second?}
      if (value.year !== undefined && value.month !== undefined && value.day !== undefined) {
        dateValue = new Date(
          value.year,
          value.month - 1, // JavaScript 月份从 0 开始
          value.day,
          value.hour || 0,
          value.minute || 0,
          value.second || 0
        );
      }
      // 保留原有的 valueOf 逻辑作为后备
      else if ('valueOf' in value) {
        try {
          const timestamp = value.valueOf();
          if (typeof timestamp === 'number' && !isNaN(timestamp)) {
            dateValue = new Date(timestamp);
          }
        } catch (e) {
          console.warn('[TanStackColumns] Failed to parse date value:', e);
        }
      }
    }

    // 渲染日期
    if (dateValue && !isNaN(dateValue.getTime())) {
      const year = dateValue.getFullYear();
      const month = String(dateValue.getMonth() + 1).padStart(2, '0');
      const day = String(dateValue.getDate()).padStart(2, '0');

      // 根据 metadata 或类型决定是否显示时间
      const includeTime = metadata?.includeTime || duckdbType?.toUpperCase().includes('TIMESTAMP');

      if (includeTime) {
        const hours = String(dateValue.getHours()).padStart(2, '0');
        const minutes = String(dateValue.getMinutes()).padStart(2, '0');
        const formattedValue = `${year}/${month}/${day} ${hours}:${minutes}`;
        return (
          <div
            className="max-w-full min-w-0 truncate tabular-nums"
            style={{ backgroundColor, padding: '4px' }}
            title={formattedValue}
          >
            {formattedValue}
          </div>
        );
      } else {
        const formattedValue = `${year}/${month}/${day}`;
        return (
          <div
            className="max-w-full min-w-0 truncate tabular-nums"
            style={{ backgroundColor, padding: '4px' }}
            title={formattedValue}
          >
            {formattedValue}
          </div>
        );
      }
    }

    // 无法解析的日期，按字符串显示
    return (
      <span className="text-gray-400" style={{ backgroundColor, padding: '4px' }}>
        {String(value)}
      </span>
    );
  }

  // ==========================================
  // 超链接类型 - 普通网址（非附件）
  // ==========================================
  if (fieldType === 'hyperlink' && value) {
    const valueStr = String(value);
    const separator = metadata?.separator || ',';
    const urls = valueStr
      .split(separator)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    // 单个链接
    if (urls.length === 1) {
      return (
        <div className="max-w-full min-w-0" style={{ backgroundColor, padding: '4px' }}>
          <a
            href={urls[0]}
            target="_blank"
            rel="noopener noreferrer"
            className="block max-w-full truncate text-blue-600 underline transition-colors hover:text-blue-800 hover:no-underline"
            onClick={(e) => e.stopPropagation()}
            title={urls[0]}
          >
            {urls[0]}
          </a>
        </div>
      );
    }

    // 多个链接
    return (
      <div className="flex flex-col gap-0.5" style={{ backgroundColor, padding: '4px' }}>
        {urls.slice(0, 2).map((url, idx) => (
          <a
            key={idx}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 text-xs underline hover:no-underline transition-colors truncate max-w-[200px]"
            onClick={(e) => e.stopPropagation()}
          >
            {url}
          </a>
        ))}
        {urls.length > 2 && <span className="text-xs text-gray-500">+{urls.length - 2} 链接</span>}
      </div>
    );
  }

  // 自定义字段类型渲染
  if (fieldType) {
    switch (fieldType) {
      case 'url': {
        // URL 类型渲染
        const isUrl = /^https?:\/\//.test(String(value));
        if (isUrl) {
          return (
            <div className="max-w-full min-w-0" style={{ backgroundColor, padding: '4px' }}>
              <a
                href={String(value)}
                target="_blank"
                rel="noopener noreferrer"
                className="block max-w-full truncate text-blue-600 hover:underline"
                onClick={(e) => e.stopPropagation()}
                title={String(value)}
              >
                {String(value)}
              </a>
            </div>
          );
        }
        break;
      }

      case 'server':
        // 高亮显示服务器 IP
        return (
          <div style={{ backgroundColor, padding: '4px' }}>
            <span className="px-2 py-1 bg-yellow-100 text-gray-900 rounded text-sm">
              {String(value)}
            </span>
          </div>
        );

      case 'email': {
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));
        if (isEmail) {
          return (
            <div className="max-w-full min-w-0" style={{ backgroundColor, padding: '4px' }}>
              <a
                href={`mailto:${value}`}
                className="block max-w-full truncate text-blue-600 hover:underline"
                onClick={(e) => e.stopPropagation()}
                title={String(value)}
              >
                {String(value)}
              </a>
            </div>
          );
        }
        break;
      }

      case 'password':
        return (
          <span className="text-gray-400" style={{ backgroundColor, padding: '4px' }}>
            ••••••••
          </span>
        );
    }
  }

  // 数值类型
  if (isNumericType(duckdbType) && typeof value === 'number') {
    const decimals = getDecimals(duckdbType);
    const format = metadata?.format;

    let formattedValue: string;
    // 根据格式类型显示
    switch (format) {
      case 'percentage':
        formattedValue = `${(value * 100).toFixed(decimals)}%`;
        break;
      case 'currency':
        formattedValue = `¥${value.toLocaleString('zh-CN', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })}`;
        break;
      case 'integer':
        formattedValue = value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
        break;
      case 'decimal':
      default:
        formattedValue = value.toLocaleString('zh-CN', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
        break;
    }
    return <div style={{ backgroundColor, padding: '4px' }}>{formattedValue}</div>;
  }

  // 布尔类型
  if (typeof value === 'boolean') {
    return (
      <div style={{ backgroundColor, padding: '4px' }}>
        <span className={value ? 'text-green-600' : 'text-red-600'}>{value ? '✓' : '✗'}</span>
      </div>
    );
  }

  // 数组类型（DuckDB LIST）
  if (Array.isArray(value)) {
    return (
      <div style={{ backgroundColor, padding: '4px' }}>
        <span className="text-gray-700">[{value.map((v) => String(v)).join(', ')}]</span>
      </div>
    );
  }

  // 字符串类型（默认渲染，应用背景色）
  return (
    <div
      className="max-w-full min-w-0 truncate"
      style={{ backgroundColor, padding: '4px' }}
      title={String(value)}
    >
      {String(value)}
    </div>
  );
}

/**
 * 创建自定义列定义
 */
export function createCustomColumn<T = any>(
  config: Partial<ColumnDef<T>> & {
    accessorKey: string;
    header: string;
  }
): ColumnDef<T> {
  return {
    enableSorting: false,
    enableGrouping: true,
    ...config,
  } as ColumnDef<T>;
}
