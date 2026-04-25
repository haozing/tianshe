/**
 * 验证规则编辑器组件
 * 用于可视化配置字段的验证规则
 */

import React, { useState } from 'react';
import type { ValidationRule } from '@/main/duckdb/types';

interface ValidationRulesEditorProps {
  fieldType: string;
  rules: ValidationRule[];
  onChange: (rules: ValidationRule[]) => void;
  existingColumns?: string[]; // 用于引用检查
}

// 常用正则表达式模式
const REGEX_PATTERNS = {
  email: {
    pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    label: 'Email地址',
    errorMessage: '请输入有效的Email地址',
  },
  phone: {
    pattern: '^1[3-9]\\d{9}$',
    label: '中国手机号',
    errorMessage: '请输入有效的11位手机号',
  },
  url: {
    pattern: '^https?://.*',
    label: 'URL链接',
    errorMessage: '请输入有效的URL（以http://或https://开头）',
  },
  zipcode: {
    pattern: '^\\d{6}$',
    label: '邮政编码',
    errorMessage: '请输入6位邮政编码',
  },
  idcard: {
    pattern: '^\\d{17}[\\dXx]$',
    label: '身份证号',
    errorMessage: '请输入有效的18位身份证号',
  },
};

export function ValidationRulesEditor({
  fieldType,
  rules,
  onChange,
  existingColumns: _existingColumns = [],
}: ValidationRulesEditorProps) {
  const [showCustomRegex, setShowCustomRegex] = useState(false);
  const [showCustomCheck, setShowCustomCheck] = useState(false);

  // 辅助函数：检查规则是否存在
  const hasRule = (type: string): boolean => {
    return rules.some((r) => r.type === type);
  };

  // 辅助函数：获取规则
  const getRule = (type: string): ValidationRule | undefined => {
    return rules.find((r) => r.type === type);
  };

  // 辅助函数：添加或更新规则
  const setRule = (rule: ValidationRule) => {
    const newRules = rules.filter((r) => r.type !== rule.type);
    newRules.push(rule);
    onChange(newRules);
  };

  // 辅助函数：移除规则
  const removeRule = (type: string) => {
    onChange(rules.filter((r) => r.type !== type));
  };

  // 切换规则开关
  const toggleRule = (type: string, defaultRule: ValidationRule) => {
    if (hasRule(type)) {
      removeRule(type);
    } else {
      setRule(defaultRule);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-gray-700">数据验证规则</h3>

      {/* 必填规则 */}
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          id="rule-required"
          checked={hasRule('required')}
          onChange={() =>
            toggleRule('required', {
              type: 'required',
              errorMessage: '此字段为必填项',
            })
          }
          className="mt-1"
        />
        <label htmlFor="rule-required" className="flex-1 cursor-pointer">
          <div className="font-medium text-sm">必填字段</div>
          <div className="text-xs text-gray-500">不允许为空值（NULL）</div>
        </label>
      </div>

      {/* 唯一性规则 */}
      {fieldType !== 'multi_select' && fieldType !== 'button' && (
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="rule-unique"
            checked={hasRule('unique')}
            onChange={() =>
              toggleRule('unique', {
                type: 'unique',
                errorMessage: '此字段值必须唯一',
              })
            }
            className="mt-1"
          />
          <label htmlFor="rule-unique" className="flex-1 cursor-pointer">
            <div className="font-medium text-sm">唯一性约束</div>
            <div className="text-xs text-gray-500">不允许重复值</div>
          </label>
        </div>
      )}

      {/* 数值范围规则 */}
      {fieldType === 'number' && (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="rule-range"
              checked={hasRule('range')}
              onChange={() => {
                if (hasRule('range')) {
                  removeRule('range');
                } else {
                  setRule({
                    type: 'range',
                    params: { min: undefined, max: undefined },
                    errorMessage: '数值超出允许范围',
                  });
                }
              }}
              className="mt-1"
            />
            <label htmlFor="rule-range" className="flex-1">
              <div className="font-medium text-sm">数值范围</div>
              <div className="text-xs text-gray-500">限制数值的最小值和最大值</div>
            </label>
          </div>

          {hasRule('range') && (
            <div className="ml-6 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 w-16">最小值</span>
                <input
                  type="number"
                  value={getRule('range')?.params?.min ?? ''}
                  onChange={(e) => {
                    const currentRule = getRule('range')!;
                    setRule({
                      ...currentRule,
                      params: {
                        ...currentRule.params,
                        min: e.target.value ? Number(e.target.value) : undefined,
                      },
                    });
                  }}
                  placeholder="不限制"
                  className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 w-16">最大值</span>
                <input
                  type="number"
                  value={getRule('range')?.params?.max ?? ''}
                  onChange={(e) => {
                    const currentRule = getRule('range')!;
                    setRule({
                      ...currentRule,
                      params: {
                        ...currentRule.params,
                        max: e.target.value ? Number(e.target.value) : undefined,
                      },
                    });
                  }}
                  placeholder="不限制"
                  className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 文本长度规则 */}
      {(fieldType === 'text' ||
        fieldType === 'email' ||
        fieldType === 'phone' ||
        fieldType === 'url') && (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="rule-length"
              checked={hasRule('length')}
              onChange={() => {
                if (hasRule('length')) {
                  removeRule('length');
                } else {
                  setRule({
                    type: 'length',
                    params: { minLength: undefined, maxLength: undefined },
                    errorMessage: '文本长度超出允许范围',
                  });
                }
              }}
              className="mt-1"
            />
            <label htmlFor="rule-length" className="flex-1">
              <div className="font-medium text-sm">文本长度</div>
              <div className="text-xs text-gray-500">限制文本的最小和最大长度</div>
            </label>
          </div>

          {hasRule('length') && (
            <div className="ml-6 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 w-16">最小长度</span>
                <input
                  type="number"
                  min="0"
                  value={getRule('length')?.params?.minLength ?? ''}
                  onChange={(e) => {
                    const currentRule = getRule('length')!;
                    setRule({
                      ...currentRule,
                      params: {
                        ...currentRule.params,
                        minLength: e.target.value ? Number(e.target.value) : undefined,
                      },
                    });
                  }}
                  placeholder="不限制"
                  className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 w-16">最大长度</span>
                <input
                  type="number"
                  min="0"
                  value={getRule('length')?.params?.maxLength ?? ''}
                  onChange={(e) => {
                    const currentRule = getRule('length')!;
                    setRule({
                      ...currentRule,
                      params: {
                        ...currentRule.params,
                        maxLength: e.target.value ? Number(e.target.value) : undefined,
                      },
                    });
                  }}
                  placeholder="不限制"
                  className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 正则表达式规则 */}
      {(fieldType === 'text' ||
        fieldType === 'email' ||
        fieldType === 'phone' ||
        fieldType === 'url') && (
        <div className="space-y-2">
          <div className="font-medium text-sm">正则表达式验证</div>
          <div className="text-xs text-gray-500 mb-2">使用正则表达式验证文本格式</div>

          {/* 常用模式快捷按钮 */}
          <div className="flex flex-wrap gap-2">
            {Object.entries(REGEX_PATTERNS).map(([key, pattern]) => (
              <button
                key={key}
                onClick={() => {
                  setRule({
                    type: 'regex',
                    params: { pattern: pattern.pattern },
                    errorMessage: pattern.errorMessage,
                  });
                  setShowCustomRegex(false);
                }}
                className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 transition-colors"
              >
                {pattern.label}
              </button>
            ))}
            <button
              onClick={() => setShowCustomRegex(!showCustomRegex)}
              className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 transition-colors"
            >
              自定义
            </button>
          </div>

          {/* 自定义正则表达式输入 */}
          {(showCustomRegex ||
            (hasRule('regex') &&
              !Object.values(REGEX_PATTERNS).some(
                (p) => p.pattern === getRule('regex')?.params?.pattern
              ))) && (
            <div className="space-y-2 mt-2">
              <input
                type="text"
                value={getRule('regex')?.params?.pattern || ''}
                onChange={(e) => {
                  if (e.target.value) {
                    setRule({
                      type: 'regex',
                      params: { pattern: e.target.value },
                      errorMessage: getRule('regex')?.errorMessage || '格式不正确',
                    });
                  } else {
                    removeRule('regex');
                  }
                }}
                placeholder="例如: ^\d{6}$ (6位数字)"
                className="w-full px-2 py-1 border border-gray-300 rounded text-sm font-mono"
              />
              <input
                type="text"
                value={getRule('regex')?.errorMessage || ''}
                onChange={(e) => {
                  const currentRule = getRule('regex');
                  if (currentRule) {
                    setRule({
                      ...currentRule,
                      errorMessage: e.target.value,
                    });
                  }
                }}
                placeholder="错误提示信息"
                className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
              />
            </div>
          )}

          {/* 显示当前规则 */}
          {hasRule('regex') && (
            <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs">
              <div className="font-medium text-blue-900">当前规则</div>
              <div className="text-blue-700 font-mono mt-1">
                {getRule('regex')?.params?.pattern}
              </div>
              <div className="text-blue-600 mt-1">{getRule('regex')?.errorMessage}</div>
            </div>
          )}
        </div>
      )}

      {/* 枚举值规则 */}
      {fieldType === 'single_select' && (
        <div className="space-y-2">
          <div className="font-medium text-sm">允许的值</div>
          <div className="text-xs text-gray-500">限制只能选择指定的值（已在选项配置中设置）</div>
        </div>
      )}

      {/* 自定义SQL CHECK约束 */}
      <div className="space-y-2">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="rule-check"
            checked={hasRule('check')}
            onChange={() => {
              if (hasRule('check')) {
                removeRule('check');
                setShowCustomCheck(false);
              } else {
                setRule({
                  type: 'check',
                  params: { expression: '' },
                  errorMessage: '数据不符合验证规则',
                });
                setShowCustomCheck(true);
              }
            }}
            className="mt-1"
          />
          <label htmlFor="rule-check" className="flex-1">
            <div className="font-medium text-sm">自定义SQL验证</div>
            <div className="text-xs text-gray-500">使用SQL表达式进行复杂验证</div>
          </label>
        </div>

        {hasRule('check') && showCustomCheck && (
          <div className="ml-6 space-y-2">
            <textarea
              value={getRule('check')?.params?.expression || ''}
              onChange={(e) => {
                const currentRule = getRule('check')!;
                setRule({
                  ...currentRule,
                  params: {
                    expression: e.target.value,
                  },
                });
              }}
              placeholder="例如: age >= 18 AND age <= 100"
              rows={3}
              className="w-full px-2 py-1 border border-gray-300 rounded text-sm font-mono"
            />
            <div className="text-xs text-gray-500">可以引用当前行的其他列，使用DuckDB SQL语法</div>
            <input
              type="text"
              value={getRule('check')?.errorMessage || ''}
              onChange={(e) => {
                const currentRule = getRule('check')!;
                setRule({
                  ...currentRule,
                  errorMessage: e.target.value,
                });
              }}
              placeholder="错误提示信息"
              className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
            />
          </div>
        )}
      </div>

      {/* 规则摘要 */}
      {rules.length > 0 && (
        <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded">
          <div className="text-sm font-medium text-gray-700 mb-2">
            已启用的验证规则 ({rules.length})
          </div>
          <ul className="space-y-1">
            {rules.map((rule, index) => (
              <li key={index} className="text-xs text-gray-600 flex items-start gap-2">
                <span className="text-green-600">✓</span>
                <span className="flex-1">
                  {rule.type === 'required' && '必填'}
                  {rule.type === 'unique' && '唯一性'}
                  {rule.type === 'range' &&
                    `数值范围: ${rule.params.min ?? '不限'} ~ ${rule.params.max ?? '不限'}`}
                  {rule.type === 'length' &&
                    `文本长度: ${rule.params.minLength ?? '不限'} ~ ${rule.params.maxLength ?? '不限'}`}
                  {rule.type === 'regex' && `正则: ${rule.params.pattern}`}
                  {rule.type === 'check' && `SQL: ${rule.params.expression}`}
                  {rule.type === 'enum' && `枚举: ${rule.params.values?.join(', ')}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
