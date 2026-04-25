/**
 * 多值输入组件
 * 支持输入多个关键词，用于 contains_any 等筛选类型
 *
 * 优化点：
 * - 使用 React.memo 防止不必要的重新渲染
 * - 使用 useCallback 缓存事件处理器
 * - 不禁用输入框，在逻辑层面阻止超过最大值
 */
import React, { useState, useRef, useCallback, memo } from 'react';
import { X } from 'lucide-react';
import { toast } from '../../../lib/toast';

interface MultiValueInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  maxValues?: number;
}

export const MultiValueInput = memo(function MultiValueInput({
  values,
  onChange,
  placeholder = '输入关键词，回车添加',
  maxValues = 100,
}: MultiValueInputProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 检查是否达到最大值
  const isMaxReached = values.length >= maxValues;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && inputValue.trim()) {
        e.preventDefault();

        // 检测输入值中是否包含分隔符，支持一次性输入多个词
        const separatorRegex = /[,，\s;；]+/;
        const inputValues = inputValue
          .split(separatorRegex)
          .map((v) => v.trim())
          .filter((v) => v.length > 0);

        if (inputValues.length > 1) {
          // 批量添加
          const newValues = inputValues.filter((v) => !values.includes(v));
          const totalCount = values.length + newValues.length;

          if (totalCount > maxValues) {
            toast.warning(`最多只能添加 ${maxValues} 个词（当前已有 ${values.length} 个）`);
            return;
          }

          onChange([...values, ...newValues]);
          setInputValue('');
        } else {
          // 单个添加（原有逻辑）
          if (values.length >= maxValues) {
            toast.warning(`最多只能添加 ${maxValues} 个词（当前已有 ${values.length} 个）`);
            return;
          }

          if (!values.includes(inputValue.trim())) {
            onChange([...values, inputValue.trim()]);
          }
          setInputValue('');
        }
      } else if (e.key === 'Backspace' && !inputValue && values.length > 0) {
        // 删除最后一个标签
        onChange(values.slice(0, -1));
      }
    },
    [inputValue, values, onChange, maxValues]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // 获取粘贴的文本
      const pastedText = e.clipboardData.getData('text');

      if (!pastedText.trim()) return;

      // 检测是否包含分隔符
      const separatorRegex = /[,，\s;；\n\r\t]+/;
      if (separatorRegex.test(pastedText)) {
        e.preventDefault(); // 阻止默认粘贴行为

        // 分割文本
        const newValues = pastedText
          .split(separatorRegex)
          .map((v) => v.trim())
          .filter((v) => v.length > 0) // 去除空值
          .filter((v) => !values.includes(v)); // 去重

        // 检查数量限制
        const totalCount = values.length + newValues.length;
        if (totalCount > maxValues) {
          toast.warning(
            `粘贴的内容过多，最多只能添加 ${maxValues} 个词（当前已有 ${values.length} 个）`
          );

          // 只添加允许的数量
          const allowedCount = maxValues - values.length;
          if (allowedCount > 0) {
            onChange([...values, ...newValues.slice(0, allowedCount)]);
          }
          return;
        }

        // 批量添加
        if (newValues.length > 0) {
          onChange([...values, ...newValues]);
          setInputValue(''); // 清空输入框
        }
      }
      // 如果没有分隔符，使用默认粘贴行为（粘贴到输入框）
    },
    [values, onChange, maxValues]
  );

  const handleRemove = useCallback(
    (index: number) => {
      onChange(values.filter((_, i) => i !== index));
    },
    [values, onChange]
  );

  return (
    <div className="flex-1 flex flex-col gap-1">
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border border-gray-300 rounded focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent min-h-[38px]">
        {/* 已添加的标签 */}
        {values.map((value, index) => (
          <span
            key={index}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-sm bg-blue-100 text-blue-700 rounded"
          >
            {value}
            <button
              onClick={() => handleRemove(index)}
              className="hover:text-blue-900"
              type="button"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}

        {/* 输入框 - 不再禁用，在逻辑层面阻止添加 */}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={values.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[100px] outline-none text-sm"
        />
      </div>

      {/* 提示信息 */}
      <div className="flex justify-between text-xs text-gray-500">
        <span>支持批量粘贴，自动识别逗号/空格/换行等分隔符</span>
        <span className={isMaxReached ? 'text-orange-600 font-medium' : ''}>
          {values.length} / {maxValues} {isMaxReached && '(已达上限)'}
        </span>
      </div>
    </div>
  );
});
