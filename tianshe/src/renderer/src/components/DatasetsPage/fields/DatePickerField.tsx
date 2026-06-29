/**
 * 日期选择器组件
 * 支持月历选择、时间选择
 */

import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface DatePickerFieldProps {
  value: string; // YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS
  includeTime?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  inlineMode?: boolean; // 内联模式（用于表格单元格）
}

export function DatePickerField({
  value,
  includeTime = false,
  onChange,
  placeholder = '年/月/日',
  inlineMode = false,
}: DatePickerFieldProps) {
  const [showCalendar, setShowCalendar] = useState(false);
  const [viewDate, setViewDate] = useState<Date>(new Date());
  const [timeValue, setTimeValue] = useState('00:00:00');
  const [panelPlacement, setPanelPlacement] = useState<
    'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  >('bottom-start');
  const containerRef = useRef<HTMLDivElement>(null);

  // 解析现有值
  useEffect(() => {
    if (value) {
      // 字符串类型
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        // 使用 queueMicrotask 将 setState 调用延迟到微任务队列
        queueMicrotask(() => {
          setViewDate(parsed);
          if (includeTime) {
            const hours = String(parsed.getHours()).padStart(2, '0');
            const minutes = String(parsed.getMinutes()).padStart(2, '0');
            const seconds = String(parsed.getSeconds()).padStart(2, '0');
            setTimeValue(`${hours}:${minutes}:${seconds}`);
          }
        });
      }
    }
  }, [value, includeTime]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowCalendar(false);
      }
    };

    if (showCalendar) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showCalendar]);

  // 格式化显示值
  const formatDisplayValue = (val: any): string => {
    if (!val) return '';

    // 处理对象类型（DuckDB 可能返回日期对象）
    if (typeof val === 'object' && val !== null) {
      // 如果是日期对象，尝试提取值
      if (val.year !== undefined && val.month !== undefined && val.day !== undefined) {
        const year = val.year;
        const month = String(val.month).padStart(2, '0');
        const day = String(val.day).padStart(2, '0');

        if (includeTime && val.hour !== undefined) {
          const hours = String(val.hour).padStart(2, '0');
          const minutes = String(val.minute || 0).padStart(2, '0');
          return `${year}/${month}/${day} ${hours}:${minutes}`;
        }

        return `${year}/${month}/${day}`;
      }

      // 尝试转换为字符串
      val = String(val);
    }

    const date = new Date(val);
    if (isNaN(date.getTime())) return String(val);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (includeTime) {
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}/${month}/${day} ${hours}:${minutes}`;
    }

    return `${year}/${month}/${day}`;
  };

  // 获取月历数据
  const getCalendarDays = (): (Date | null)[] => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    // 当月第一天
    const firstDay = new Date(year, month, 1);
    const firstDayOfWeek = firstDay.getDay(); // 0-6 (周日-周六)

    // 当月最后一天
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();

    const days: (Date | null)[] = [];

    // 填充前置空白
    for (let i = 0; i < firstDayOfWeek; i++) {
      days.push(null);
    }

    // 填充当月日期
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(new Date(year, month, i));
    }

    return days;
  };

  // 选择日期
  const handleSelectDate = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (includeTime) {
      const [hours = '00', minutes = '00', seconds = '00'] = timeValue.split(':');
      onChange(`${year}-${month}-${day} ${hours}:${minutes}:${seconds}`);
    } else {
      onChange(`${year}-${month}-${day}`);
      setShowCalendar(false);
    }
  };

  // 切换月份
  const changeMonth = (delta: number) => {
    const newDate = new Date(viewDate);
    newDate.setMonth(newDate.getMonth() + delta);
    setViewDate(newDate);
  };

  // 更新时间
  const handleTimeChange = (newTime: string) => {
    setTimeValue(newTime);
    if (value) {
      const date = new Date(value);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      onChange(`${year}-${month}-${day} ${newTime}`);
    }
  };

  // 判断是否为今天
  const isToday = (date: Date): boolean => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };

  // 判断是否为选中日期
  const isSelected = (date: Date): boolean => {
    if (!value) return false;
    const selected = new Date(value);
    return (
      date.getDate() === selected.getDate() &&
      date.getMonth() === selected.getMonth() &&
      date.getFullYear() === selected.getFullYear()
    );
  };

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const calendarDays = getCalendarDays();
  const displayValue = formatDisplayValue(value);
  const computePanelPlacement = () => {
    const panelRect = containerRef.current?.getBoundingClientRect();
    if (!panelRect || typeof window === 'undefined') {
      return 'bottom-start' as const;
    }

    const viewportPadding = 8;
    const panelWidth = Math.min(296, window.innerWidth - viewportPadding * 2);
    const panelHeight = includeTime ? 385 : 320;
    const alignEnd =
      panelRect.left + panelWidth > window.innerWidth - viewportPadding &&
      panelRect.right - panelWidth >= viewportPadding;
    const showAbove =
      panelRect.bottom + panelHeight + viewportPadding > window.innerHeight &&
      panelRect.top - panelHeight >= viewportPadding;

    return `${showAbove ? 'top' : 'bottom'}-${alignEnd ? 'end' : 'start'}` as const;
  };
  const triggerClassName = `
    shell-field-control flex w-full min-w-0 items-center gap-2 cursor-pointer transition-colors
    ${inlineMode ? 'shell-field-control--inline group min-h-[32px] px-2 py-1' : 'min-h-[42px] px-3 py-2'}
    ${showCalendar ? 'shell-field-control--active' : ''}
  `;
  const panelClassName = `
    shell-field-panel absolute z-50 w-[min(296px,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] p-4
    ${panelPlacement.startsWith('top') ? 'bottom-full mb-2' : 'top-full mt-2'}
    ${panelPlacement.endsWith('end') ? 'right-0' : 'left-0'}
  `;

  return (
    <div ref={containerRef} className="relative w-full min-w-0">
      <div
        className={triggerClassName}
        onClick={() => {
          if (!showCalendar) {
            setPanelPlacement(computePanelPlacement());
          }
          setShowCalendar(!showCalendar);
        }}
        title={displayValue || undefined}
      >
        <input
          type="text"
          value={displayValue}
          readOnly
          placeholder={placeholder}
          className="min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent text-sm tabular-nums text-slate-700 placeholder:text-slate-400 focus:outline-none"
        />
        {inlineMode ? (
          value && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
              }}
              className="shell-icon-button rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-70"
            >
              <X className="h-3 w-3 text-slate-400" />
            </button>
          )
        ) : value ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            className="shell-icon-button rounded-full p-1 text-slate-400 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <Calendar className="h-4 w-4 text-slate-400" />
        )}
      </div>

      {showCalendar && (
        <div className={panelClassName}>
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => changeMonth(-1)}
              className="shell-icon-button rounded-full p-1.5 text-slate-500 hover:text-slate-700"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-semibold text-slate-800">
              {viewDate.getFullYear()}年 {viewDate.getMonth() + 1}月
            </div>
            <button
              onClick={() => changeMonth(1)}
              className="shell-icon-button rounded-full p-1.5 text-slate-500 hover:text-slate-700"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-2">
            {weekDays.map((day) => (
              <div
                key={day}
                className="flex h-9 w-9 items-center justify-center text-center text-xs font-medium text-slate-500"
              >
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((date, index) => (
              <div
                key={index}
                className={`
                  shell-calendar-day flex h-9 w-9 items-center justify-center text-center text-sm cursor-pointer
                  ${!date ? 'cursor-default' : ''}
                  ${date && isToday(date) ? 'shell-calendar-day--today' : ''}
                  ${date && isSelected(date) ? 'shell-calendar-day--selected' : ''}
                  ${date && !isSelected(date) ? 'text-slate-700' : ''}
                `}
                onClick={() => date && handleSelectDate(date)}
              >
                {date?.getDate() || ''}
              </div>
            ))}
          </div>

          {includeTime && (
            <div className="mt-3 border-t border-slate-200/80 pt-3">
              <label className="mb-2 block text-xs text-slate-600">时间</label>
              <input
                type="time"
                step="1"
                value={timeValue.substring(0, 8)}
                onChange={(e) => {
                  // step="1" 时浏览器返回 HH:MM:SS，不需要再添加 :00
                  const newTime = e.target.value;
                  // 确保格式为 HH:MM:SS
                  const formattedTime = newTime.split(':').length === 3 ? newTime : newTime + ':00';
                  handleTimeChange(formattedTime);
                }}
                className="shell-field-input px-3 py-2 text-sm"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
