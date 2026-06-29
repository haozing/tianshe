/**
 * 字段模板选择器组件
 * 用于快速选择预定义的字段模板
 */

import { useState, useMemo } from 'react';
import {
  FIELD_TEMPLATES,
  getTemplatesByCategory,
  searchTemplates,
  type FieldTemplate,
} from '../../lib/field-templates';

interface FieldTemplateSelectorProps {
  onSelect: (template: FieldTemplate) => void;
  onCancel: () => void;
}

const CATEGORY_LABELS = {
  contact: { label: '联系方式', icon: '📇', description: 'Email、电话等联系信息' },
  meta: { label: '元数据', icon: '⚙️', description: '创建时间、ID等系统字段' },
  common: { label: '常用字段', icon: '⭐', description: '状态、优先级等通用字段' },
  business: { label: '业务字段', icon: '💼', description: '金额、数量等业务数据' },
  tech: { label: '技术字段', icon: '🔧', description: 'IP、JSON等技术字段' },
};

export function FieldTemplateSelector({ onSelect, onCancel }: FieldTemplateSelectorProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const templatesByCategory = useMemo(() => getTemplatesByCategory(), []);

  // 根据搜索和分类筛选模板
  const filteredTemplates = useMemo(() => {
    let templates = FIELD_TEMPLATES;

    // 应用搜索
    if (searchQuery.trim()) {
      templates = searchTemplates(searchQuery);
    }

    // 应用分类筛选
    if (selectedCategory !== 'all') {
      templates = templates.filter((t) => t.category === selectedCategory);
    }

    return templates;
  }, [searchQuery, selectedCategory]);

  return (
    <div className="w-full h-full flex flex-col bg-white">
      {/* 头部 */}
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900">选择字段模板</h2>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 transition-colors"
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

        {/* 搜索框 */}
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索模板..."
            className="w-full px-4 py-2 pl-10 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <svg
            className="absolute left-3 top-2.5 w-5 h-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
      </div>

      {/* 分类标签 */}
      <div className="px-6 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2 overflow-x-auto">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
              selectedCategory === 'all'
                ? 'bg-blue-100 text-blue-700'
                : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}
          >
            全部 ({FIELD_TEMPLATES.length})
          </button>
          {Object.entries(CATEGORY_LABELS).map(([key, info]) => {
            const count = templatesByCategory[key]?.length || 0;
            return (
              <button
                key={key}
                onClick={() => setSelectedCategory(key)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                  selectedCategory === key
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-white text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span>{info.icon}</span>
                <span>
                  {info.label} ({count})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 模板列表 */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredTemplates.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 text-5xl mb-3">🔍</div>
            <p className="text-gray-500">
              {searchQuery ? '没有找到匹配的模板' : '该分类下暂无模板'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {filteredTemplates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onSelect={() => onSelect(template)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-6 py-3 border-t border-gray-200 bg-gray-50">
        <p className="text-xs text-gray-500">💡 提示：选择模板后，您仍然可以修改字段配置</p>
      </div>
    </div>
  );
}

/**
 * 模板卡片组件
 */
function TemplateCard({ template, onSelect }: { template: FieldTemplate; onSelect: () => void }) {
  const categoryInfo = CATEGORY_LABELS[template.category];

  return (
    <button
      onClick={onSelect}
      className="text-left p-4 border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-md transition-all group"
    >
      {/* 头部 */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{template.icon}</span>
          <div>
            <h3 className="font-medium text-gray-900 group-hover:text-blue-600 transition-colors">
              {template.name}
            </h3>
            <p className="text-xs text-gray-500">{categoryInfo.label}</p>
          </div>
        </div>
      </div>

      {/* 描述 */}
      <p className="text-sm text-gray-600 mb-3 line-clamp-2">{template.description}</p>

      {/* 配置预览 */}
      <div className="space-y-1">
        <div className="flex items-center text-xs text-gray-500">
          <span className="font-medium w-20">列名:</span>
          <code className="text-gray-700 font-mono">{template.config.columnName}</code>
        </div>
        <div className="flex items-center text-xs text-gray-500">
          <span className="font-medium w-20">类型:</span>
          <span className="text-gray-700">{template.config.fieldType}</span>
        </div>
        {template.config.validationRules && template.config.validationRules.length > 0 && (
          <div className="flex items-center text-xs text-gray-500">
            <span className="font-medium w-20">验证:</span>
            <span className="text-green-600">{template.config.validationRules.length} 条规则</span>
          </div>
        )}
      </div>

      {/* Hover效果 */}
      <div className="mt-3 text-xs text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity">
        点击使用此模板 →
      </div>
    </button>
  );
}
