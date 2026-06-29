import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatasetSidebar } from '../DatasetSidebar';
import type { DatasetCategory } from '../types';

const categories: DatasetCategory[] = [
  {
    id: 'finance',
    name: 'Finance',
    tables: [],
    isFolder: true,
    parentId: null,
  },
  {
    id: 'finance-reports',
    name: 'Monthly Reports',
    tables: [
      {
        id: 'table_sales',
        name: 'Sales Report',
        datasetId: 'ds_sales',
      },
    ],
    isFolder: true,
    parentId: 'finance',
  },
  {
    id: 'customers',
    name: 'Customers',
    tables: [
      {
        id: 'table_customers',
        name: 'Customers',
        datasetId: 'ds_customers',
      },
    ],
    isFolder: false,
  },
];

function SidebarHarness() {
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <DatasetSidebar
      categories={categories}
      selectedCategory={null}
      selectedTableId={null}
      onSelectCategory={vi.fn()}
      onSelectTable={vi.fn()}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      collapsed={false}
      onToggleCollapse={vi.fn()}
      onImportExcel={vi.fn()}
      onCreateDataset={vi.fn()}
      onCreateFolder={vi.fn()}
      onDeleteCategory={vi.fn()}
      onImportExcelToFolder={vi.fn()}
      onCreateDatasetInFolder={vi.fn()}
      onCreateSubfolder={vi.fn()}
      onDeleteTable={vi.fn()}
      deletingItemId={null}
    />
  );
}

const clickCategory = (name: string) => {
  const target = screen.getByText(name).closest('[role="treeitem"],[role="button"]');
  expect(target).toBeTruthy();
  fireEvent.click(target!);
};

describe('DatasetSidebar search behavior', () => {
  it('should open the collapsed quick-search panel, focus the input, and keep folder browsing available', () => {
    function CollapsedSearchHarness() {
      const [collapsed, setCollapsed] = useState(true);
      const [searchQuery, setSearchQuery] = useState('');

      return (
        <DatasetSidebar
          categories={categories}
          selectedCategory={null}
          selectedTableId={null}
          onSelectCategory={vi.fn()}
          onSelectTable={vi.fn()}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          onImportExcel={vi.fn()}
          onCreateDataset={vi.fn()}
          onCreateFolder={vi.fn()}
          onDeleteCategory={vi.fn()}
          onImportExcelToFolder={vi.fn()}
          onCreateDatasetInFolder={vi.fn()}
          onCreateSubfolder={vi.fn()}
          onDeleteTable={vi.fn()}
          deletingItemId={null}
        />
      );
    }

    render(<CollapsedSearchHarness />);

    fireEvent.click(screen.getByTitle('快速搜索'));

    const searchInput = screen.getByPlaceholderText('搜索');
    expect(searchInput).toHaveFocus();
    expect(screen.getByText('快速搜索')).toBeInTheDocument();

    clickCategory('Finance');

    expect(screen.getByText('Monthly Reports')).toBeInTheDocument();
  });

  it('should show subtree item counts in collapsed mode badges', () => {
    render(
      <DatasetSidebar
        categories={categories}
        selectedCategory={null}
        selectedTableId={null}
        onSelectCategory={vi.fn()}
        onSelectTable={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        collapsed
        onToggleCollapse={vi.fn()}
        onImportExcel={vi.fn()}
        onCreateDataset={vi.fn()}
        onCreateFolder={vi.fn()}
        onDeleteCategory={vi.fn()}
        onImportExcelToFolder={vi.fn()}
        onCreateDatasetInFolder={vi.fn()}
        onCreateSubfolder={vi.fn()}
        onDeleteTable={vi.fn()}
        deletingItemId={null}
      />
    );

    const financeButton = screen.getByTitle('Finance');
    const customersButton = screen.getByTitle('Customers');

    expect(within(financeButton).getByText('1')).toBeInTheDocument();
    expect(within(customersButton).getByText('1')).toBeInTheDocument();
  });

  it('should expose tree semantics and support keyboard expansion', () => {
    render(<SidebarHarness />);

    const tree = screen.getByRole('tree', { name: '数据目录' });
    expect(tree).toBeInTheDocument();

    const financeItem = screen.getByRole('treeitem', { name: /Finance/ });
    expect(financeItem).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(financeItem, { key: 'ArrowRight' });
    expect(financeItem).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group')).toBeInTheDocument();

    fireEvent.keyDown(financeItem, { key: 'ArrowLeft' });
    expect(financeItem).toHaveAttribute('aria-expanded', 'false');
  });

  it('should select folders while toggling expansion so the workspace context stays aligned', () => {
    const onSelectCategory = vi.fn();

    render(
      <DatasetSidebar
        categories={categories}
        selectedCategory={null}
        selectedTableId={null}
        onSelectCategory={onSelectCategory}
        onSelectTable={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        onImportExcel={vi.fn()}
        onCreateDataset={vi.fn()}
        onCreateFolder={vi.fn()}
        onDeleteCategory={vi.fn()}
        onImportExcelToFolder={vi.fn()}
        onCreateDatasetInFolder={vi.fn()}
        onCreateSubfolder={vi.fn()}
        onDeleteTable={vi.fn()}
        deletingItemId={null}
      />
    );

    clickCategory('Finance');

    expect(onSelectCategory).toHaveBeenCalledWith('finance');
    expect(screen.getByText('Monthly Reports')).toBeInTheDocument();
  });

  it('should auto-expand matching table paths and restore manual expansion when search is cleared', () => {
    render(<SidebarHarness />);

    clickCategory('Finance');
    expect(screen.getByText('Monthly Reports')).toBeInTheDocument();
    expect(screen.queryByText('Sales Report')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('搜索'), {
      target: { value: 'sales' },
    });

    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Monthly Reports')).toBeInTheDocument();
    expect(screen.getByText('Sales Report')).toBeInTheDocument();
    expect(screen.queryByText('Customers')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('搜索'), {
      target: { value: '' },
    });

    expect(screen.getByText('Monthly Reports')).toBeInTheDocument();
    expect(screen.queryByText('Sales Report')).not.toBeInTheDocument();
    expect(screen.getByText('Customers')).toBeInTheDocument();
  });

  it('should keep a matched folder subtree and hide unrelated entries', () => {
    render(<SidebarHarness />);

    fireEvent.change(screen.getByPlaceholderText('搜索'), {
      target: { value: 'finance' },
    });

    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Monthly Reports')).toBeInTheDocument();
    expect(screen.getByText('Sales Report')).toBeInTheDocument();
    expect(screen.queryByText('Customers')).not.toBeInTheDocument();
  });

  it('should close the collapsed quick-search panel on Escape and restore trigger focus', () => {
    function CollapsedSearchHarness() {
      const [collapsed, setCollapsed] = useState(true);
      const [searchQuery, setSearchQuery] = useState('');

      return (
        <DatasetSidebar
          categories={categories}
          selectedCategory={null}
          selectedTableId={null}
          onSelectCategory={vi.fn()}
          onSelectTable={vi.fn()}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          onImportExcel={vi.fn()}
          onCreateDataset={vi.fn()}
          onCreateFolder={vi.fn()}
          onDeleteCategory={vi.fn()}
          onImportExcelToFolder={vi.fn()}
          onCreateDatasetInFolder={vi.fn()}
          onCreateSubfolder={vi.fn()}
          onDeleteTable={vi.fn()}
          deletingItemId={null}
        />
      );
    }

    render(<CollapsedSearchHarness />);

    const quickSearchButton = screen.getByTitle('快速搜索');
    fireEvent.click(quickSearchButton);

    expect(screen.getByRole('dialog', { name: '折叠侧边栏快速搜索' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '折叠侧边栏快速搜索' })).not.toBeInTheDocument();
    expect(quickSearchButton).toHaveFocus();
  });
});
