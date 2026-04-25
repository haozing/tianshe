/**
 * 聚合单元格组件
 * 显示聚合值（求和、平均、计数等）
 */
export interface AggregatedCellProps {
  value: any;
  aggregationType?: 'sum' | 'mean' | 'count' | 'min' | 'max';
  format?: (value: any) => string;
}

export function AggregatedCell({ value, aggregationType = 'sum', format }: AggregatedCellProps) {
  if (value === null || value === undefined) {
    return <span className="placeholder-cell">-</span>;
  }

  const formattedValue = format ? format(value) : formatValue(value, aggregationType);

  const prefix = getPrefix(aggregationType);

  return (
    <span className={`aggregated-cell ${aggregationType}`}>
      {prefix}
      {formattedValue}
    </span>
  );
}

function getPrefix(type: string): string {
  switch (type) {
    case 'sum':
      return '∑ ';
    case 'mean':
      return '平均 ';
    case 'count':
      return '# ';
    case 'min':
      return '最小 ';
    case 'max':
      return '最大 ';
    default:
      return '';
  }
}

function formatValue(value: any, type: string): string {
  if (typeof value === 'number') {
    if (type === 'mean' || type === 'sum') {
      // 保留2位小数
      return value.toLocaleString('zh-CN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
    }
    return value.toLocaleString('zh-CN');
  }

  return String(value);
}
