/**
 * 分组单元格组件
 * 显示分组值、展开/折叠按钮和记录数
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Row } from '@tanstack/react-table';

export interface GroupCellProps {
  row: Row<any>;
  value: any;
  depth?: number;
}

/**
 * 格式化显示值（支持日期对象）
 */
function formatDisplayValue(val: any): string {
  if (val === null || val === undefined) return '';

  // 处理日期对象（DuckDB 格式：{year, month, day, ...}）
  if (typeof val === 'object' && val !== null) {
    if (val.year !== undefined && val.month !== undefined && val.day !== undefined) {
      const year = val.year;
      const month = String(val.month).padStart(2, '0');
      const day = String(val.day).padStart(2, '0');

      if (val.hour !== undefined) {
        const hours = String(val.hour).padStart(2, '0');
        const minutes = String(val.minute || 0).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}`;
      }

      return `${year}/${month}/${day}`;
    }
  }

  return String(val);
}

export function GroupCell({ row, value, depth }: GroupCellProps) {
  const isGrouped = row.getIsGrouped();
  const formattedValue = formatDisplayValue(value);
  const displayValue = formattedValue || '(空)';

  if (!isGrouped) {
    // 非分组行，只显示值
    const actualDepth = depth ?? row.depth;
    return (
      <div
        className="group-cell group-cell--leaf"
        style={{ paddingLeft: `${actualDepth * 20 + 28}px` }}
        title={formattedValue || undefined}
      >
        <span className="group-value group-value--leaf">{displayValue}</span>
      </div>
    );
  }

  const rowDepth = depth ?? row.depth;
  const subRowCount = row.subRows.length;
  const isExpanded = row.getIsExpanded();

  // 🆕 读取分组统计信息（从第一行数据）
  const firstRow = row.subRows[0]?.original;
  const groupCount = firstRow?.__group_count || subRowCount;

  // 🆕 查找数值字段的统计
  const stats: { label: string; value: string }[] = [];
  if (firstRow) {
    Object.keys(firstRow).forEach((key) => {
      if (key.startsWith('__group_sum_')) {
        const fieldName = key.replace('__group_sum_', '');
        if (fieldName.startsWith('_')) {
          return;
        }
        const sumValue = firstRow[key];
        if (sumValue !== null && sumValue !== undefined) {
          stats.push({
            label: `${fieldName} 总计`,
            value: typeof sumValue === 'number' ? sumValue.toLocaleString() : String(sumValue),
          });
        }
      } else if (key.startsWith('__group_avg_')) {
        const fieldName = key.replace('__group_avg_', '');
        if (fieldName.startsWith('_')) {
          return;
        }
        const avgValue = firstRow[key];
        if (avgValue !== null && avgValue !== undefined) {
          stats.push({
            label: `${fieldName} 平均`,
            value: typeof avgValue === 'number' ? avgValue.toFixed(2) : String(avgValue),
          });
        }
      }
    });
  }

  return (
    <div className="group-cell" style={{ paddingLeft: `${rowDepth * 20}px` }}>
      <button
        onClick={row.getToggleExpandedHandler()}
        className="expand-button"
        title={isExpanded ? '折叠' : '展开'}
        aria-label={isExpanded ? '折叠分组' : '展开分组'}
        aria-expanded={isExpanded}
      >
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>

      <span className="group-value" title={formattedValue || undefined}>
        {displayValue}
      </span>

      <span className="group-count">({groupCount} 条)</span>

      {/* 🆕 显示统计信息 */}
      {stats.length > 0 && (
        <span className="group-stats" title={stats.map((stat) => `${stat.label}: ${stat.value}`).join(' | ')}>
          {stats.map((stat, idx) => (
            <span key={idx} className="group-stat">
              {stat.label}: {stat.value}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
