import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TanStackDataTable } from './index';

function buildRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    _row_id: index + 1,
    name: `row-${index + 1}`,
    value: index + 1,
  }));
}

function attachScrollMetrics(
  element: HTMLDivElement,
  initial: { clientHeight: number; scrollHeight: number; scrollTop: number }
) {
  let clientHeight = initial.clientHeight;
  let scrollHeight = initial.scrollHeight;
  let scrollTop = initial.scrollTop;

  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });

  return {
    setScrollTop(value: number) {
      scrollTop = value;
    },
    setScrollHeight(value: number) {
      scrollHeight = value;
    },
    setClientHeight(value: number) {
      clientHeight = value;
    },
  };
}

function getWrapper(container: HTMLElement) {
  const wrapper = container.querySelector('.tanstack-table-wrapper');
  expect(wrapper).not.toBeNull();
  return wrapper as HTMLDivElement;
}

describe('TanStackDataTable load-more behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T00:00:01.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces burst scroll events into one load-more request', async () => {
    const onScrollEnd = vi.fn();
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <TanStackDataTable
          data={buildRows(20)}
          enableVirtualization={false}
          showFooter={false}
          hasMore
          loading={false}
          loadingMore={false}
          onScrollEnd={onScrollEnd}
        />
      ));
      await Promise.resolve();
    });

    const wrapper = getWrapper(container);
    const metrics = attachScrollMetrics(wrapper, {
      clientHeight: 300,
      scrollHeight: 1200,
      scrollTop: 0,
    });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    expect(onScrollEnd).not.toHaveBeenCalled();

    await act(async () => {
      metrics.setScrollTop(650);
      fireEvent.scroll(wrapper);
      fireEvent.scroll(wrapper);
      fireEvent.scroll(wrapper);
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it('rechecks after data append when the user is still near the bottom', async () => {
    const onScrollEnd = vi.fn();
    const initialRows = buildRows(20);
    const appendedRows = buildRows(30);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <TanStackDataTable
          data={initialRows}
          enableVirtualization={false}
          showFooter={false}
          hasMore
          loading={false}
          loadingMore={false}
          onScrollEnd={onScrollEnd}
        />
      );
      await Promise.resolve();
    });

    const wrapper = getWrapper(view.container);
    const metrics = attachScrollMetrics(wrapper, {
      clientHeight: 300,
      scrollHeight: 1200,
      scrollTop: 0,
    });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    expect(onScrollEnd).not.toHaveBeenCalled();

    await act(async () => {
      metrics.setScrollTop(650);
      fireEvent.scroll(wrapper);
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(onScrollEnd).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <TanStackDataTable
          data={initialRows}
          enableVirtualization={false}
          showFooter={false}
          hasMore
          loading={false}
          loadingMore
          onScrollEnd={onScrollEnd}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(onScrollEnd).toHaveBeenCalledTimes(1);

    metrics.setScrollHeight(1400);
    await act(async () => {
      view.rerender(
        <TanStackDataTable
          data={appendedRows}
          enableVirtualization={false}
          showFooter={false}
          hasMore
          loading={false}
          loadingMore={false}
          onScrollEnd={onScrollEnd}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(onScrollEnd).toHaveBeenCalledTimes(2);
  });

  it('does not reorder rows when clicking a column header', async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <TanStackDataTable
          data={[
            { _row_id: 1, value: 2 },
            { _row_id: 2, value: 1 },
          ]}
          columns={[{ accessorKey: 'value', id: 'value', header: 'Value' } as any]}
          enableVirtualization={false}
          showFooter={false}
          hasMore
          loading={false}
        />
      ));
      await Promise.resolve();
    });

    const getRenderedValues = () =>
      Array.from(container.querySelectorAll('tbody tr td'))
        .map((cell) => cell.textContent?.trim())
        .filter((value): value is string => Boolean(value));

    expect(getRenderedValues()).toEqual(['2', '1']);

    const header = container.querySelector('th');
    expect(header).not.toBeNull();

    await act(async () => {
      fireEvent.click(header as HTMLTableCellElement);
      await Promise.resolve();
    });

    expect(getRenderedValues()).toEqual(['2', '1']);
  });

  it('opens the column manager as a shell drawer and exposes menu semantics for column actions', async () => {
    const onToggleColumnVisibility = vi.fn();
    const onRenameColumn = vi.fn();
    const onDeleteColumn = vi.fn();
    const onSetDefaultColumnVisibility = vi.fn();
    const onReorderColumns = vi.fn();

    function ColumnManagerHarness() {
      const [showColumnManager, setShowColumnManager] = React.useState(false);

      return (
        <TanStackDataTable
          data={buildRows(2)}
          columns={[
            { id: '_select', header: '', cell: () => null, size: 48 } as any,
            { accessorKey: 'name', id: 'name', header: 'Name' } as any,
            { accessorKey: 'value', id: 'value', header: 'Value' } as any,
          ]}
          columnManagerColumns={[
            { id: 'name', header: 'Name', isVisible: true },
            { id: 'value', header: 'Value', isVisible: true },
          ]}
          enableVirtualization={false}
          showColumnManager={showColumnManager}
          onColumnManagerChange={setShowColumnManager}
          onToggleColumnVisibility={onToggleColumnVisibility}
          onRenameColumn={onRenameColumn}
          onDeleteColumn={onDeleteColumn}
          onSetDefaultColumnVisibility={onSetDefaultColumnVisibility}
          onReorderColumns={onReorderColumns}
        />
      );
    }

    const { container } = render(<ColumnManagerHarness />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '字段配置' }));
      await Promise.resolve();
    });

    const dialog = screen.getByRole('dialog', { name: '字段配置' });
    expect(dialog).toBeInTheDocument();
    expect(container.querySelector('.shell-drawer-surface')).toBeInTheDocument();
    expect(within(dialog).getByText('Name')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Name 更多操作' }));
      await Promise.resolve();
    });

    expect(screen.getByRole('menu', { name: 'Name 字段操作菜单' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '设为默认隐藏' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
      await Promise.resolve();
    });

    expect(screen.queryByRole('menu', { name: 'Name 字段操作菜单' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '字段配置' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
      await Promise.resolve();
    });

    expect(screen.queryByRole('dialog', { name: '字段配置' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '字段配置' })).toHaveFocus();
  });
});
