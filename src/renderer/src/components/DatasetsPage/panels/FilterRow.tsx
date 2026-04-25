/**
 * FilterRow - 筛选条件单行组件
 *
 * 优化点：
 * - 使用 React.memo 减少不必要的重新渲染
 * - 使用 useCallback 缓存所有事件处理器
 * - 使用 CSS display 控制组件显示/隐藏，避免组件销毁重建
 */
import { memo, useCallback } from 'react';
import { X } from 'lucide-react';
import type { FilterCondition } from '../../../../../core/query-engine/types';

interface FilterRowProps {
  filterId: string;
  filter: FilterCondition;
  availableFields: Array<{ name: string; type: string }>;
  onUpdate: (filterId: string, updates: Partial<FilterCondition>) => void;
  onRemove: (filterId: string) => void;
}

/**
 * 筛选行组件 - 负责渲染单个筛选条件
 * 使用 memo 避免父组件更新时不必要的重新渲染
 */
export const FilterRow = memo(function FilterRow({
  filterId,
  filter,
  availableFields,
  onUpdate,
  onRemove,
}: FilterRowProps) {
  const isRangeFilter = filter.type === 'between';
  const isMultiValueFilter = filter.type === 'in' || filter.type === 'not_in';
  const isRelativeTimeFilter = filter.type === 'relative_time';
  const showValueInput = !['null', 'not_null'].includes(filter.type);
  const relativeTimeValue = filter.options?.relativeTimeValue ?? 7;
  const relativeTimeUnit = filter.options?.relativeTimeUnit ?? 'day';
  const relativeTimeDirection = filter.options?.relativeTimeDirection ?? 'past';

  // 所有事件处理器都使用 useCallback 包装，避免每次渲染都创建新函数
  const handleFieldChange = useCallback(
    (field: string) => {
      onUpdate(filterId, { field });
    },
    [filterId, onUpdate]
  );

  const handleTypeChange = useCallback(
    (type: string) => {
      if (type === 'null' || type === 'not_null') {
        onUpdate(filterId, {
          type: type as FilterCondition['type'],
          value: undefined,
          values: undefined,
          options: undefined,
        });
        return;
      }

      if (type === 'between') {
        const nextValues = filter.values?.length === 2 ? [...filter.values] : ['', ''];
        onUpdate(filterId, {
          type: 'between',
          value: undefined,
          values: nextValues,
          options: undefined,
        });
        return;
      }

      if (type === 'in' || type === 'not_in') {
        onUpdate(filterId, {
          type: type as FilterCondition['type'],
          value: undefined,
          values: filter.values && filter.values.length > 0 ? [...filter.values] : [''],
          options: undefined,
        });
        return;
      }

      if (type === 'relative_time') {
        onUpdate(filterId, {
          type: 'relative_time',
          value: undefined,
          values: undefined,
          options: {
            relativeTimeValue,
            relativeTimeUnit,
            relativeTimeDirection,
          },
        });
        return;
      }

      onUpdate(filterId, {
        type: type as FilterCondition['type'],
        value: filter.value ?? '',
        values: undefined,
        options:
          type === 'regex'
            ? {
                regexMaxLength: filter.options?.regexMaxLength,
                regexTimeout: filter.options?.regexTimeout,
              }
            : undefined,
      });
    },
    [
      filter.value,
      filter.values,
      filter.options?.regexMaxLength,
      filter.options?.regexTimeout,
      filterId,
      onUpdate,
      relativeTimeDirection,
      relativeTimeUnit,
      relativeTimeValue,
    ]
  );

  const handleValueChange = useCallback(
    (value: string) => {
      onUpdate(filterId, { value, values: undefined });
    },
    [filterId, onUpdate]
  );

  const handleRangeValueChange = useCallback(
    (index: 0 | 1, value: string) => {
      const nextValues = filter.values?.length === 2 ? [...filter.values] : ['', ''];
      nextValues[index] = value;
      onUpdate(filterId, { value: undefined, values: nextValues });
    },
    [filter.values, filterId, onUpdate]
  );

  const handleListValueChange = useCallback(
    (value: string) => {
      const values = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      onUpdate(filterId, { value: undefined, values });
    },
    [filterId, onUpdate]
  );

  const handleRelativeTimeValueChange = useCallback(
    (value: string) => {
      const nextValue = Number.parseInt(value, 10);
      onUpdate(filterId, {
        value: undefined,
        values: undefined,
        options: {
          relativeTimeUnit,
          relativeTimeDirection,
          relativeTimeValue: Number.isFinite(nextValue) ? nextValue : 0,
        },
      });
    },
    [filterId, onUpdate, relativeTimeDirection, relativeTimeUnit, relativeTimeValue]
  );

  const handleRelativeTimeUnitChange = useCallback(
    (value: string) => {
      onUpdate(filterId, {
        value: undefined,
        values: undefined,
        options: {
          relativeTimeValue,
          relativeTimeDirection,
          relativeTimeUnit: value as NonNullable<FilterCondition['options']>['relativeTimeUnit'],
        },
      });
    },
    [filterId, onUpdate, relativeTimeDirection, relativeTimeUnit, relativeTimeValue]
  );

  const handleRelativeTimeDirectionChange = useCallback(
    (value: string) => {
      onUpdate(filterId, {
        value: undefined,
        values: undefined,
        options: {
          relativeTimeValue,
          relativeTimeUnit,
          relativeTimeDirection:
            value as NonNullable<FilterCondition['options']>['relativeTimeDirection'],
        },
      });
    },
    [filterId, onUpdate, relativeTimeDirection, relativeTimeUnit, relativeTimeValue]
  );

  const handleRemove = useCallback(() => {
    onRemove(filterId);
  }, [filterId, onRemove]);

  return (
    <div className="flex items-center gap-2 mb-2">
      {/* Field Selection */}
      <select
        value={filter.field}
        onChange={(e) => handleFieldChange(e.target.value)}
        className="px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
        style={{ width: '120px' }}
      >
        {availableFields.map((field) => (
          <option key={field.name} value={field.name}>
            {field.name}
          </option>
        ))}
      </select>

      {/* Operator Selection */}
      <select
        value={filter.type}
        onChange={(e) => handleTypeChange(e.target.value)}
        className="px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
        style={{ width: '140px' }}
      >
        <option value="contains">包含</option>
        <option value="not_contains">不包含</option>
        <option value="equal">等于</option>
        <option value="not_equal">不等于</option>
        <option value="greater_than">大于</option>
        <option value="less_than">小于</option>
        <option value="greater_equal">大于等于</option>
        <option value="less_equal">小于等于</option>
        <option value="between">区间</option>
        <option value="in">属于</option>
        <option value="not_in">不属于</option>
        <option value="regex">正则匹配</option>
        <option value="starts_with">开头</option>
        <option value="ends_with">结尾</option>
        <option value="relative_time">相对时间</option>
        <option value="null">为空</option>
        <option value="not_null">非空</option>
      </select>

      {/* Value Input */}
      {showValueInput && !isRangeFilter && !isMultiValueFilter && !isRelativeTimeFilter && (
        <div className="flex-1">
          <input
            type="text"
            value={filter.value || ''}
            onChange={(e) => handleValueChange(e.target.value)}
            placeholder="请输入"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      )}

      {isRangeFilter && (
        <div className="flex flex-1 items-center gap-2">
          <input
            type="text"
            value={filter.values?.[0] ?? ''}
            onChange={(e) => handleRangeValueChange(0, e.target.value)}
            placeholder="最小值"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <span className="text-sm text-gray-400">到</span>
          <input
            type="text"
            value={filter.values?.[1] ?? ''}
            onChange={(e) => handleRangeValueChange(1, e.target.value)}
            placeholder="最大值"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      )}

      {isMultiValueFilter && (
        <div className="flex-1">
          <input
            type="text"
            value={filter.values?.join(', ') ?? ''}
            onChange={(e) => handleListValueChange(e.target.value)}
            placeholder="多个值用逗号分隔"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      )}

      {isRelativeTimeFilter && (
        <div className="flex flex-1 items-center gap-2">
          <select
            value={filter.options?.relativeTimeDirection ?? 'past'}
            onChange={(e) => handleRelativeTimeDirectionChange(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          >
            <option value="past">最近</option>
            <option value="future">未来</option>
          </select>
          <input
            type="number"
            min="0"
            value={String(filter.options?.relativeTimeValue ?? 7)}
            onChange={(e) => handleRelativeTimeValueChange(e.target.value)}
            placeholder="数量"
            className="w-24 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <select
            value={filter.options?.relativeTimeUnit ?? 'day'}
            onChange={(e) => handleRelativeTimeUnitChange(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          >
            <option value="hour">小时</option>
            <option value="day">天</option>
            <option value="week">周</option>
            <option value="month">月</option>
            <option value="year">年</option>
          </select>
        </div>
      )}

      {/* Remove Button */}
      <button
        onClick={handleRemove}
        className="p-1 text-gray-400 hover:text-red-600 transition-colors"
        title="删除条件"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
});
