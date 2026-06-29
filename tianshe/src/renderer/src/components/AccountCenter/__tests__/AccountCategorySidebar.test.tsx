import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountCategorySidebar } from '../AccountCategorySidebar';

describe('AccountCategorySidebar', () => {
  it('renders all accounts entry and keeps sections mutually exclusive', () => {
    const onExpandedSectionChange = vi.fn();
    const onSelectCategory = vi.fn();

    const { rerender } = render(
      <AccountCategorySidebar
        expandedSection="site"
        selectedCategoryId={null}
        accountsCount={12}
        siteCategories={[
          { id: 'site:taobao', name: '淘宝', count: 6 },
          { id: 'site:jd', name: '京东', count: 3 },
        ]}
        tagCategories={[
          { id: 'tag:主号', name: '主号', count: 4 },
          { id: 'tag:店铺', name: '店铺', count: 2 },
        ]}
        onExpandedSectionChange={onExpandedSectionChange}
        onSelectCategory={onSelectCategory}
      />
    );

    expect(screen.getByRole('button', { name: /全部账号/ })).toBeInTheDocument();
    expect(screen.getByText('淘宝')).toBeInTheDocument();
    expect(screen.queryByText('主号')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /按标签/ }));
    expect(onExpandedSectionChange).toHaveBeenCalledWith('tag');

    rerender(
      <AccountCategorySidebar
        expandedSection="tag"
        selectedCategoryId="tag:主号"
        accountsCount={12}
        siteCategories={[
          { id: 'site:taobao', name: '淘宝', count: 6 },
          { id: 'site:jd', name: '京东', count: 3 },
        ]}
        tagCategories={[
          { id: 'tag:主号', name: '主号', count: 4 },
          { id: 'tag:店铺', name: '店铺', count: 2 },
        ]}
        onExpandedSectionChange={onExpandedSectionChange}
        onSelectCategory={onSelectCategory}
      />
    );

    expect(screen.getByText('主号')).toBeInTheDocument();
    expect(screen.queryByText('淘宝')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /全部账号/ }));
    expect(onSelectCategory).toHaveBeenCalledWith(null);
  });
});
