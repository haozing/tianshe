import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Globe, Tag } from 'lucide-react';
import { cn } from '../../lib/utils';

interface AccountCategoryItem {
  id: string;
  name: string;
  count: number;
}

interface AccountCategorySidebarProps {
  expandedSection: 'site' | 'tag';
  selectedCategoryId: string | null;
  accountsCount: number;
  siteCategories: AccountCategoryItem[];
  tagCategories: AccountCategoryItem[];
  onExpandedSectionChange: (section: 'site' | 'tag') => void;
  onSelectCategory: (categoryId: string | null) => void;
}

interface CategorySectionProps {
  title: string;
  count: number;
  icon: ReactNode;
  expanded: boolean;
  emptyText: string;
  categories: AccountCategoryItem[];
  selectedCategoryId: string | null;
  onExpand: () => void;
  onSelectCategory: (categoryId: string) => void;
}

function getCategoryItemClassName(selected: boolean) {
  return cn(
    'flex w-full items-center justify-between rounded-[16px] border-l-[3px] px-3 py-2.5 text-left text-sm transition-[background-color,color,box-shadow,border-color]',
    selected
      ? 'border-l-blue-500 bg-white text-slate-900 shadow-sm'
      : 'border-l-transparent text-slate-600 hover:bg-white/72 hover:text-slate-900'
  );
}

function CategorySection({
  title,
  count,
  icon,
  expanded,
  emptyText,
  categories,
  selectedCategoryId,
  onExpand,
  onSelectCategory,
}: CategorySectionProps) {
  return (
    <section className="overflow-hidden rounded-[18px] bg-white/52">
      <button
        type="button"
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-[16px] px-3 py-3 text-left text-sm transition-colors',
          expanded ? 'bg-white/82 text-slate-900' : 'text-slate-700 hover:bg-white/58'
        )}
        onClick={onExpand}
      >
        <span className="flex items-center gap-2 truncate">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {icon}
          <span>{title}</span>
        </span>
        <span className="text-xs text-slate-500">{count}</span>
      </button>

      {expanded ? (
        <div className="mt-1 max-h-60 space-y-1 overflow-y-auto border-t border-white/70 px-2 py-2">
          {categories.length > 0 ? (
            categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={getCategoryItemClassName(selectedCategoryId === category.id)}
                onClick={() => onSelectCategory(category.id)}
              >
                <span className="truncate">{category.name}</span>
                <span className="text-xs text-slate-500">{category.count}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-xs text-slate-500">{emptyText}</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function AccountCategorySidebar({
  expandedSection,
  selectedCategoryId,
  accountsCount,
  siteCategories,
  tagCategories,
  onExpandedSectionChange,
  onSelectCategory,
}: AccountCategorySidebarProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden p-4">

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        <button
          type="button"
          className={cn(
            'sm:col-span-2 xl:col-span-1',
            getCategoryItemClassName(selectedCategoryId === null)
          )}
          onClick={() => onSelectCategory(null)}
        >
          <span>全部账号</span>
          <span className="text-xs text-slate-500">{accountsCount}</span>
        </button>

        <CategorySection
          title="按平台"
          count={siteCategories.length}
          icon={<Globe className="h-4 w-4 text-slate-500" />}
          expanded={expandedSection === 'site'}
          emptyText="当前没有平台分类。"
          categories={siteCategories}
          selectedCategoryId={selectedCategoryId}
          onExpand={() => onExpandedSectionChange('site')}
          onSelectCategory={onSelectCategory}
        />

        <CategorySection
          title="按标签"
          count={tagCategories.length}
          icon={<Tag className="h-4 w-4 text-slate-500" />}
          expanded={expandedSection === 'tag'}
          emptyText="当前没有标签分类。"
          categories={tagCategories}
          selectedCategoryId={selectedCategoryId}
          onExpand={() => onExpandedSectionChange('tag')}
          onSelectCategory={onSelectCategory}
        />
      </div>
    </div>
  );
}
