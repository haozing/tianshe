/**
 * 多选字段组件
 * 支持标签输入、下拉建议
 */

import React, { useState, useRef, useEffect } from 'react';
import { X, ChevronDown } from 'lucide-react';

export interface MultiSelectFieldProps {
  value: string; // 逗号分隔的值
  options?: string[]; // 已有选项（用于建议）
  separator?: string; // 分隔符
  onChange: (value: string) => void;
  placeholder?: string;
}

export function MultiSelectField({
  value,
  options = [],
  separator = ',',
  onChange,
  placeholder = '请选择项',
}: MultiSelectFieldProps) {
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 将值转换为标签数组
  const selectedTags = value
    ? value
        .split(separator)
        .map((v) => v.trim())
        .filter(Boolean)
    : [];

  // 过滤建议选项（排除已选）
  const filteredSuggestions = options.filter(
    (option) =>
      !selectedTags.includes(option) && option.toLowerCase().includes(inputValue.toLowerCase())
  );

  // 点击外部关闭建议
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // 添加标签
  const addTag = (tag: string) => {
    if (tag.trim() && !selectedTags.includes(tag.trim())) {
      const newTags = [...selectedTags, tag.trim()];
      onChange(newTags.join(separator));
      setInputValue('');
      setShowSuggestions(false);
    }
  };

  // 删除标签
  const removeTag = (index: number) => {
    const newTags = selectedTags.filter((_, i) => i !== index);
    onChange(newTags.join(separator));
  };

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && selectedTags.length > 0) {
      // 删除最后一个标签
      removeTag(selectedTags.length - 1);
    }
  };

  // 聚焦时显示建议
  const handleFocus = () => {
    if (options.length > 0) {
      setShowSuggestions(true);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        className="shell-field-control flex min-h-[42px] flex-wrap gap-1.5 px-3 py-2"
        onClick={() => inputRef.current?.focus()}
      >
        {selectedTags.map((tag, index) => (
          <div
            key={index}
            className="shell-field-chip shell-field-chip--accent flex max-w-full min-w-0 items-center gap-1.5 px-2.5 py-1 text-sm"
          >
            <span className="truncate min-w-0" title={tag}>
              {tag}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeTag(index);
              }}
              className="shell-icon-button rounded-full p-0.5 hover:opacity-70"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}

        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (e.target.value && options.length > 0) {
              setShowSuggestions(true);
            }
          }}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder={selectedTags.length === 0 ? placeholder : '添加更多...'}
          className="min-w-[100px] flex-1 border-0 bg-transparent text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
        />

        {options.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowSuggestions(!showSuggestions);
              inputRef.current?.focus();
            }}
            className="shell-icon-button self-center rounded-full p-1 text-slate-400 hover:text-slate-700"
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                showSuggestions ? 'rotate-180 text-sky-600' : ''
              }`}
            />
          </button>
        )}
      </div>

      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="shell-field-panel absolute left-0 right-0 top-full z-50 mt-2 max-h-56 overflow-y-auto p-2">
          {filteredSuggestions.map((option, index) => (
            <div
              key={index}
              onClick={() => addTag(option)}
              className="shell-field-option cursor-pointer px-3 py-2"
            >
              <span className="text-sm text-slate-700">{option}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
