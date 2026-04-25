/**
 * 可编辑单元格组件
 * 支持内联编辑功能
 */

import React, { useState, useEffect, useRef } from 'react';
import { SingleSelectField } from '../fields/SingleSelectField';
import { MultiSelectField } from '../fields/MultiSelectField';
import { DatePickerField } from '../fields/DatePickerField';
import { AttachmentField } from '../fields/AttachmentField';

export interface EditableCellProps {
  value: any;
  rowId: number;
  columnId: string;
  type?: string;
  fieldType?: string;
  metadata?: any;
  datasetId?: string;
  onChange?: (rowId: number, columnId: string, newValue: any) => void;
  // 🆕 保存状态和错误提示
  isSaving?: boolean;
  error?: string;
}

export function EditableCell({
  value: initialValue,
  rowId,
  columnId,
  type,
  fieldType,
  metadata,
  datasetId,
  onChange,
  isSaving,
  error,
}: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(initialValue);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 多选字段的状态：collapsed（折叠）→ expanded（展开）→ editing（编辑）
  const [multiSelectState, setMultiSelectState] = useState<'collapsed' | 'expanded' | 'editing'>(
    'collapsed'
  );
  // 多选字段容器和面板引用
  const multiSelectContainerRef = useRef<HTMLDivElement>(null);
  const multiSelectPanelRef = useRef<HTMLDivElement>(null);
  const [visibleTagCount, setVisibleTagCount] = useState(1);
  const [panelPosition, setPanelPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // 同步外部值变化
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  // 进入编辑模式时自动聚焦
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // 动态计算多选字段可显示的标签数量
  useEffect(() => {
    if (fieldType !== 'multi_select' || !multiSelectContainerRef.current) return;

    const calculateVisibleTags = () => {
      const container = multiSelectContainerRef.current;
      if (!container) return;

      const containerWidth = container.offsetWidth;
      // 估算每个标签的平均宽度（包括间距）：标签文字 + padding + gap
      // 预留空间给 "+N" 指示器（约 30px）
      const reservedSpace = 40;
      const tagAverageWidth = 60; // 平均标签宽度
      const availableWidth = containerWidth - reservedSpace;
      const count = Math.max(1, Math.floor(availableWidth / tagAverageWidth));
      setVisibleTagCount(count);
    };

    calculateVisibleTags();

    const resizeObserver = new ResizeObserver(calculateVisibleTags);
    resizeObserver.observe(multiSelectContainerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [fieldType, value]);

  // 编辑模式下点击外部关闭面板
  useEffect(() => {
    if (multiSelectState !== 'editing') return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        multiSelectPanelRef.current &&
        !multiSelectPanelRef.current.contains(event.target as Node)
      ) {
        setMultiSelectState('collapsed');
        setPanelPosition(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [multiSelectState]);

  const handleClick = () => {
    setIsEditing(true);
  };

  const computeFloatingPanelPosition = (rect: DOMRect) => {
    const viewportPadding = 8;
    const panelGap = 8;
    const preferredWidth = 300;
    const panelWidth = Math.min(preferredWidth, window.innerWidth - viewportPadding * 2);
    const maxLeft = Math.max(viewportPadding, window.innerWidth - panelWidth - viewportPadding);
    const left = Math.min(Math.max(rect.left, viewportPadding), maxLeft);
    const estimatedPanelHeight = 220;
    const canOpenAbove = rect.top - estimatedPanelHeight - panelGap >= viewportPadding;
    const shouldOpenAbove =
      rect.bottom + estimatedPanelHeight + panelGap > window.innerHeight - viewportPadding &&
      canOpenAbove;

    return {
      top: shouldOpenAbove ? rect.top - estimatedPanelHeight - panelGap : rect.bottom + panelGap,
      left,
      width: panelWidth,
    };
  };

  const handleBlur = () => {
    setIsEditing(false);
    if (value !== initialValue && onChange) {
      onChange(rowId, columnId, value);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let newValue: any = e.target.value;
    setValidationError(null); // 清除之前的错误

    // 根据类型转换值
    if (type && (type.includes('INTEGER') || type === 'BIGINT')) {
      const parsed = parseInt(newValue, 10);
      if (isNaN(parsed) && newValue !== '') {
        setValidationError('请输入有效的整数');
        newValue = null;
      } else {
        newValue = parsed;
      }
    } else if (type && (type === 'DOUBLE' || type === 'FLOAT' || type === 'DECIMAL')) {
      const parsed = parseFloat(newValue);
      if (isNaN(parsed) && newValue !== '') {
        setValidationError('请输入有效的数字');
        newValue = null;
      } else {
        newValue = parsed;
      }
    }

    setValue(newValue);
  };

  // 格式化显示值
  const formatDisplayValue = (val: any): string => {
    if (val === null || val === undefined) return '';

    if (fieldType === 'password') return '••••••••';

    if (fieldType === 'date') {
      // 处理对象类型（DuckDB 可能返回日期对象）
      if (typeof val === 'object' && val !== null) {
        // 如果是日期对象，尝试提取值
        if (val.year !== undefined && val.month !== undefined && val.day !== undefined) {
          const year = val.year;
          const month = String(val.month).padStart(2, '0');
          const day = String(val.day).padStart(2, '0');

          if (metadata?.includeTime && val.hour !== undefined) {
            const hours = String(val.hour).padStart(2, '0');
            const minutes = String(val.minute || 0).padStart(2, '0');
            return `${year}/${month}/${day} ${hours}:${minutes}`;
          }

          return `${year}/${month}/${day}`;
        }

        // 尝试转换为字符串
        val = String(val);
      }

      // 格式化日期显示
      const date = new Date(val);
      if (isNaN(date.getTime())) return String(val);

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');

      if (metadata?.includeTime) {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}`;
      }

      return `${year}/${month}/${day}`;
    }

    if (typeof val === 'number') {
      return val.toLocaleString('zh-CN');
    }

    if (typeof val === 'boolean') {
      return val ? '✓' : '✗';
    }

    return String(val);
  };

  const renderDisplayValue = () => {
    const formattedValue = formatDisplayValue(value);
    const commonClassName = `block max-w-full min-w-0 truncate ${error ? 'text-red-600' : ''}`;

    if (fieldType === 'hyperlink' && value) {
      return (
        <span
          className={`${commonClassName} text-blue-600 underline decoration-blue-300 underline-offset-2`}
          title={String(value)}
        >
          {String(value)}
        </span>
      );
    }

    if (fieldType === 'email' && value) {
      return (
        <span className={`${commonClassName} text-blue-600`} title={String(value)}>
          {String(value)}
        </span>
      );
    }

    if (fieldType === 'password') {
      return (
        <span className={`${commonClassName} tracking-[0.18em] text-slate-500`} title="密码已隐藏">
          {formattedValue}
        </span>
      );
    }

    const valueTitle = formattedValue || undefined;
    return (
      <span className={commonClassName} title={valueTitle}>
        {formattedValue}
      </span>
    );
  };

  // 单选字段使用 SingleSelectField 组件
  if (fieldType === 'single_select') {
    const options = metadata?.options || [];
    const colorMap = metadata?.colorMap || {};

    return (
      <div className="editable-cell single-select-cell">
        <SingleSelectField
          value={value ?? ''}
          options={options}
          colorMap={colorMap}
          inlineMode={true}
          onChange={(newValue) => {
            setValue(newValue);
            if (onChange) {
              onChange(rowId, columnId, newValue);
            }
          }}
          placeholder="请选择"
        />
      </div>
    );
  }

  // 🆕 多选字段使用 MultiSelectField 组件 - 三态显示
  if (fieldType === 'multi_select') {
    const options = metadata?.options || [];
    const separator = metadata?.separator || ',';
    const values = value ? String(value).split(separator).filter(Boolean) : [];

    // 状态2：展开模式 - 显示所有标签，最多3行高度（72px）
    if (multiSelectState === 'expanded') {
      return (
        <div
          ref={multiSelectContainerRef}
          className="editable-cell multi-select-cell shell-field-control shell-field-control--inline cursor-pointer px-2 py-1 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            // 计算面板位置
            const rect = e.currentTarget.getBoundingClientRect();
            setPanelPosition(computeFloatingPanelPosition(rect));
            setMultiSelectState('editing'); // 第二次点击进入编辑模式
          }}
        >
          <div className="flex flex-wrap gap-1 max-h-[72px] overflow-hidden py-1">
            {values.map((val, idx) => (
              <span
                key={idx}
                className="shell-field-chip shell-field-chip--accent inline-flex max-w-full min-w-0 items-center px-2 py-0.5 text-xs"
                title={val}
              >
                <span className="truncate min-w-0">{val}</span>
              </span>
            ))}
          </div>
        </div>
      );
    }

    // 状态1：折叠模式 - 动态显示标签 + "+N" 指示器
    const displayValues = values.slice(0, visibleTagCount);
    const remainingCount = values.length - visibleTagCount;

    return (
      <>
        <div
          ref={multiSelectContainerRef}
          className="editable-cell multi-select-cell shell-field-control shell-field-control--inline cursor-pointer px-2 py-1 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            setMultiSelectState('expanded'); // 第一次点击展开显示
          }}
        >
          <div className="flex items-center gap-1 py-1">
            {values.length > 0 ? (
              <>
                {displayValues.map((val, idx) => (
                  <span
                    key={idx}
                    className="shell-field-chip shell-field-chip--accent inline-flex max-w-full min-w-0 items-center px-2 py-0.5 text-xs"
                    title={val}
                  >
                    <span className="truncate min-w-0">{val}</span>
                  </span>
                ))}
                {remainingCount > 0 && (
                  <span className="whitespace-nowrap text-xs font-medium text-slate-500">
                    +{remainingCount}
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs text-slate-400">点击选择</span>
            )}
          </div>
        </div>

        {/* 状态3：编辑模式 - 浮动面板 */}
        {multiSelectState === 'editing' && panelPosition && (
          <div
            ref={multiSelectPanelRef}
            className="shell-field-panel fixed z-[200] min-w-[300px] max-w-[400px] p-4"
            style={{
              top: `${panelPosition.top}px`,
              left: `${panelPosition.left}px`,
              width: `${panelPosition.width}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">编辑多选字段</span>
              <button
                className="shell-icon-button rounded-full p-1 text-slate-400 transition-colors hover:text-slate-700"
                onClick={() => {
                  setMultiSelectState('collapsed');
                  setPanelPosition(null);
                }}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <MultiSelectField
              value={value ?? ''}
              options={options}
              separator={separator}
              onChange={(newValue) => {
                setValue(newValue);
                if (onChange) {
                  onChange(rowId, columnId, newValue);
                }
                setMultiSelectState('collapsed'); // 保存后返回折叠状态
                setPanelPosition(null);
              }}
            />
          </div>
        )}
      </>
    );
  }

  // 🆕 布尔字段使用 Checkbox 快速切换
  if (fieldType === 'boolean' || (type && type.toUpperCase() === 'BOOLEAN')) {
    const boolValue = value === true || value === 'true' || value === 1;

    return (
      <div
        className="editable-cell editable-cell--boolean boolean-cell flex items-center justify-center cursor-pointer transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          const newValue = !boolValue;
          setValue(newValue);
          if (onChange) {
            onChange(rowId, columnId, newValue);
          }
        }}
        title="点击切换"
      >
        <input type="checkbox" checked={boolValue} readOnly className="cursor-pointer w-4 h-4" />
      </div>
    );
  }

  // 日期字段使用 DatePickerField 组件
  if (fieldType === 'date') {
    return (
      <div className="editable-cell date-cell group">
        <DatePickerField
          value={value ?? ''}
          includeTime={metadata?.includeTime}
          onChange={(newValue) => {
            setValue(newValue);
            if (onChange) {
              onChange(rowId, columnId, newValue);
            }
          }}
          placeholder="年/月/日"
          inlineMode={true}
        />
      </div>
    );
  }

  // 附件字段使用 AttachmentField 组件
  if (fieldType === 'attachment') {
    if (!datasetId) {
      return <div className="editable-cell text-xs text-slate-400">缺少数据集ID</div>;
    }

    return (
      <div className="editable-cell attachment-cell">
        <AttachmentField
          value={value ?? ''}
          datasetId={datasetId}
          metadata={metadata}
          onChange={(newValue) => {
            setValue(newValue);
            if (onChange) {
              onChange(rowId, columnId, newValue);
            }
          }}
          placeholder="点击或拖拽文件到此处上传"
          inlineMode={true}
        />
      </div>
    );
  }

  if (isEditing) {
    // 统一使用多行编辑框的键盘处理
    const handleTextareaKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Enter 或 Cmd+Enter 提交
        setIsEditing(false);
        if (value !== initialValue && onChange) {
          onChange(rowId, columnId, value);
        }
      } else if (e.key === 'Escape') {
        // Escape 取消
        setValue(initialValue);
        setIsEditing(false);
      }
    };

    return (
      <div className="editable-cell editing relative h-full w-full">
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={value ?? ''}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleTextareaKeyDown}
          className={`editable-cell-textarea absolute left-0 top-0 right-0 resize-none bg-white focus:outline-none focus:ring-0 ${validationError ? 'editable-cell-textarea--error' : ''}`}
          style={{
            margin: 0,
            padding: '10px 16px',
            height: '72px', // 3行高度
            minHeight: '72px',
            lineHeight: '1.5',
            zIndex: 100, // 确保在其他单元格之上
            boxSizing: 'border-box',
          }}
        />
        {validationError && (
          <div className="editable-cell-message editable-cell-message--error absolute top-full left-0 z-10 mt-1 whitespace-nowrap">
            {validationError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`editable-cell editable-cell--text relative w-full min-w-0 cursor-text transition-colors ${isSaving ? 'opacity-50' : ''}`}
      onClick={handleClick}
      title="点击编辑"
    >
      {isSaving && (
        <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-80 pointer-events-none">
          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></div>
        </div>
      )}
      {renderDisplayValue()}
      {error && (
        <div className="editable-cell-message editable-cell-message--error absolute top-full left-0 z-10 mt-1 whitespace-nowrap">
          {error}
        </div>
      )}
    </div>
  );
}
