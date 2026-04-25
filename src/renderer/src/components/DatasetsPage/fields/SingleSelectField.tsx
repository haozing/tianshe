/**
 * 单选字段组件
 * 支持彩色标签、搜索、创建新选项
 */

import React, { useState, useRef, useEffect } from 'react';
import { X, Plus, ChevronDown } from 'lucide-react';

export interface SingleSelectFieldProps {
  value: string;
  options: string[];
  colorMap?: Record<string, string>;
  onChange: (value: string) => void;
  onCreateOption?: (option: string) => void;
  placeholder?: string;
  inlineMode?: boolean;
}

export function SingleSelectField({
  value,
  options,
  colorMap = {},
  onChange,
  onCreateOption,
  placeholder = '请选择项',
  inlineMode = false,
}: SingleSelectFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 过滤选项
  const filteredOptions = options.filter((option) =>
    option.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // 自动聚焦搜索框
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // 获取选项颜色
  const getOptionColor = (option: string): string => {
    return colorMap[option] || '#3B82F6';
  };

  // 选择选项
  const handleSelectOption = (option: string) => {
    onChange(option);
    setIsOpen(false);
    setSearchTerm('');
  };

  // 创建新选项
  const handleCreateOption = () => {
    if (searchTerm.trim() && !options.includes(searchTerm.trim())) {
      const newOption = searchTerm.trim();
      onCreateOption?.(newOption);
      onChange(newOption);
      setIsOpen(false);
      setSearchTerm('');
    }
  };

  // 清除选择
  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
  };

  const triggerClassName = `
    shell-field-control flex w-full items-center gap-2 cursor-pointer transition-colors
    ${inlineMode ? 'shell-field-control--inline min-h-[32px] px-2 py-1' : 'min-h-[42px] px-3 py-2'}
    ${isOpen ? 'shell-field-control--active' : ''}
  `;

  const chipClassName = `
    shell-field-chip inline-flex items-center gap-1.5 font-medium max-w-full min-w-0
    ${inlineMode ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'}
  `;

  return (
    <div
      ref={dropdownRef}
      className="relative w-full"
      style={{ position: 'relative', zIndex: isOpen ? 100 : 1 }}
    >
      <div
        onClick={() => setIsOpen(true)}
        className={triggerClassName}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) {
            e.stopPropagation();
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {value ? (
            <div
              className={chipClassName}
              style={{
                backgroundColor: `${getOptionColor(value)}20`,
                color: getOptionColor(value),
              }}
            >
              <span className="truncate min-w-0" title={value}>
                {value}
              </span>
              {isOpen && (
                <button
                  onClick={handleClear}
                  className="shell-icon-button rounded-full p-0.5 hover:opacity-70"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ) : (
            <span className={`${inlineMode ? 'text-xs' : 'text-sm'} flex-1 text-slate-400`}>
              {placeholder}
            </span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${
            isOpen ? 'rotate-180 text-sky-600' : ''
          }`}
        />
      </div>

      {isOpen && (
        <div
          className="shell-field-panel absolute left-0 right-0 top-full z-[100] mt-2 flex max-h-72 flex-col overflow-hidden"
          style={{ zIndex: 100 }}
        >
          <div className="border-b border-slate-200/80 p-2">
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (filteredOptions.length > 0) {
                    handleSelectOption(filteredOptions[0]);
                  } else if (searchTerm.trim()) {
                    handleCreateOption();
                  }
                }
              }}
              placeholder="查找或创建选项"
              className="shell-field-input px-3 py-2 text-sm"
            />
          </div>

          <div className="overflow-y-auto flex-1">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => (
                <div
                  key={option}
                  onClick={() => handleSelectOption(option)}
                  className="shell-field-option mx-2 my-1 cursor-pointer px-3 py-2"
                >
                  <div
                    className="shell-field-chip inline-flex items-center px-2.5 py-1 text-sm font-medium"
                    style={{
                      backgroundColor: `${getOptionColor(option)}20`,
                      color: getOptionColor(option),
                    }}
                  >
                    {option}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-sm text-slate-400">
                {searchTerm ? '未找到匹配的选项' : '暂无选项'}
              </div>
            )}
          </div>

          {searchTerm.trim() && !options.includes(searchTerm.trim()) && (
            <div className="border-t border-slate-200/80 p-2">
              <button
                onClick={handleCreateOption}
                className="shell-field-option flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-sky-700"
              >
                <Plus className="w-4 h-4" />
                <span>创建 &quot;{searchTerm.trim()}&quot;</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
