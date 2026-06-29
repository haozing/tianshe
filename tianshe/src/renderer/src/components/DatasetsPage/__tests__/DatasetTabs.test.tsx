import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DatasetTabs } from '../DatasetTabs';

describe('DatasetTabs', () => {
  const baseTabs = [
    { id: 'ds1', name: '主表', isDefault: true },
    { id: 'ds2', name: '副本表', isDefault: false },
  ];

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should render tabs and allow switching tab', () => {
    const onSelectTab = vi.fn();

    render(
      <DatasetTabs
        tabs={baseTabs}
        selectedTabId="ds1"
        onSelectTab={onSelectTab}
        onCreateTab={vi.fn()}
      />
    );

    expect(screen.getByText('主表')).toBeInTheDocument();
    expect(screen.getByText('副本表')).toBeInTheDocument();
    expect(screen.getByText('默认')).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: '组内数据表标签' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /主表/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /副本表/ })).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(screen.getByText('副本表'));
    expect(onSelectTab).toHaveBeenCalledWith('ds2');
  });

  it('should support keyboard navigation between tabs', () => {
    const onSelectTab = vi.fn();

    render(
      <DatasetTabs
        tabs={baseTabs}
        selectedTabId="ds1"
        onSelectTab={onSelectTab}
        onCreateTab={vi.fn()}
      />
    );

    const firstTab = screen.getByRole('tab', { name: /主表/ });

    fireEvent.keyDown(firstTab, { key: 'ArrowRight' });
    fireEvent.keyDown(firstTab, { key: 'End' });
    fireEvent.keyDown(firstTab, { key: 'Home' });

    expect(onSelectTab).toHaveBeenNthCalledWith(1, 'ds2');
    expect(onSelectTab).toHaveBeenNthCalledWith(2, 'ds2');
    expect(onSelectTab).toHaveBeenNthCalledWith(3, 'ds1');
  });

  it('should trigger create callback when clicking copy button', () => {
    const onCreateTab = vi.fn();

    render(
      <DatasetTabs
        tabs={baseTabs}
        selectedTabId="ds1"
        onSelectTab={vi.fn()}
        onCreateTab={onCreateTab}
      />
    );

    fireEvent.click(screen.getByText('复制为新标签页'));
    expect(onCreateTab).toHaveBeenCalledTimes(1);
  });

  it('should delete tab after confirming in the custom dialog', () => {
    const onDeleteTab = vi.fn();

    render(
      <DatasetTabs
        tabs={baseTabs}
        selectedTabId="ds1"
        onSelectTab={vi.fn()}
        onCreateTab={vi.fn()}
        onDeleteTab={onDeleteTab}
      />
    );

    const deleteButtons = screen.getAllByTitle('删除数据表');
    fireEvent.click(deleteButtons[1]);
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(onDeleteTab).toHaveBeenCalledWith('ds2');
  });

  it('should not delete tab when closing the delete dialog', () => {
    const onDeleteTab = vi.fn();

    render(
      <DatasetTabs
        tabs={baseTabs}
        selectedTabId="ds1"
        onSelectTab={vi.fn()}
        onCreateTab={vi.fn()}
        onDeleteTab={onDeleteTab}
      />
    );

    const deleteButtons = screen.getAllByTitle('删除数据表');
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onDeleteTab).not.toHaveBeenCalled();
  });

  it('should rename tab through the custom rename dialog', () => {
    const onRenameTab = vi.fn();

    render(
      <DatasetTabs
        tabs={baseTabs}
        selectedTabId="ds1"
        onSelectTab={vi.fn()}
        onCreateTab={vi.fn()}
        onRenameTab={onRenameTab}
      />
    );

    const renameButtons = screen.getAllByTitle('重命名数据表');
    fireEvent.click(renameButtons[1]);
    fireEvent.change(screen.getByLabelText('标签页名称'), {
      target: { value: '  新副本表  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));

    expect(onRenameTab).toHaveBeenCalledWith('ds2', '新副本表');
  });

  it('should disable rename submission when the name is unchanged', () => {
    const onRenameTab = vi.fn();

    render(
      <DatasetTabs
        tabs={baseTabs}
        selectedTabId="ds1"
        onSelectTab={vi.fn()}
        onCreateTab={vi.fn()}
        onRenameTab={onRenameTab}
      />
    );

    const renameButtons = screen.getAllByTitle('重命名数据表');
    fireEvent.click(renameButtons[1]);
    fireEvent.change(screen.getByLabelText('标签页名称'), {
      target: { value: '  副本表  ' },
    });

    expect(screen.getByRole('button', { name: '保存名称' })).toBeDisabled();
    expect(onRenameTab).not.toHaveBeenCalled();
  });
});
