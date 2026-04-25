/**
 * TanStack Table - 主表格组件
 * 支持分组、展开/折叠、聚合等功能
 */

import React, { useMemo, useRef } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  getFilteredRowModel,
  ColumnDef,
  flexRender,
  GroupingState,
  ExpandedState,
  ColumnSizingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronDown,
  ChevronRight,
  Table as TableIcon,
  Lock,
  Plus,
  Settings,
  X,
  Eye,
  EyeOff,
  MoreHorizontal,
  GripVertical,
  HelpCircle,
  Type,
  Calendar,
  Hash,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import type { ColorRule } from '../../../../../core/query-engine/types';
import { applyColorRules } from './columns';
import './styles/table.css';

export interface ColumnManagerColumn {
  id: string;
  header?: string;
  duckdbType?: string;
  isVisible?: boolean;
  isDefaultHidden?: boolean;
  isViewHidden?: boolean;
  isViewForcedVisible?: boolean;
  isViewExcludedByProjection?: boolean;
}

export interface TanStackDataTableProps {
  data: any[];
  columns?: ColumnDef<any>[];
  grouping?: string[];
  onGroupingChange?: (grouping: string[]) => void;
  loading?: boolean;
  loadingMore?: boolean; // 加载更多数据时的状态
  emptyMessage?: string;
  rowHeight?: 'normal' | 'compact' | 'comfortable' | number;
  onRowSelectionChange?: (selectedRows: any[]) => void;
  onCellValueChange?: (rowId: number, columnId: string, newValue: any) => void;
  editable?: boolean;
  enableVirtualization?: boolean; // 是否启用虚拟滚动，默认在数据 > 500 时自动启用
  showFooter?: boolean; // 是否显示底部汇总行
  showColumnManager?: boolean; // 是否显示列管理面板
  onColumnManagerChange?: (show: boolean) => void; // 列管理面板显示状态变化回调
  onScrollEnd?: () => void; // 滚动到底部的回调
  hasMore?: boolean; // 是否还有更多数据
  totalRowCount?: number; // 数据集的总行数
  filteredTotalCount?: number; // 🆕 筛选后的总行数（当有筛选条件时）
  countContext?: {
    hasFilter?: boolean;
    hasSample?: boolean;
  };
  colorRules?: ColorRule[]; // 🆕 填色规则
  onAddColumn?: () => void;
  onRenameColumn?: (columnName: string, newName: string) => Promise<void> | void;
  onDeleteColumn?: (columnName: string) => Promise<void> | void;
  onReorderColumns?: (columnNames: string[]) => Promise<void> | void;
  columnManagerColumns?: ColumnManagerColumn[];
  onToggleColumnVisibility?: (columnId: string, nextVisible: boolean) => Promise<void> | void;
  onSetDefaultColumnVisibility?: (columnId: string, nextVisible: boolean) => Promise<void> | void;
}

const LOAD_MORE_THRESHOLD_PX = 600;

export function TanStackDataTable({
  data,
  columns: externalColumns,
  grouping: externalGrouping = [],
  onGroupingChange,
  loading = false,
  loadingMore = false,
  emptyMessage = '暂无数据',
  rowHeight = 'normal',
  onRowSelectionChange,
  onCellValueChange: _onCellValueChange,
  editable: _editable = false,
  enableVirtualization,
  showFooter = true,
  showColumnManager = false,
  onColumnManagerChange,
  onScrollEnd,
  hasMore = false,
  totalRowCount,
  filteredTotalCount, // 🆕 接收筛选后的总行数
  countContext,
  colorRules: _colorRules, // 🆕 接收填色规则
  onAddColumn,
  onRenameColumn,
  onDeleteColumn,
  onReorderColumns,
  columnManagerColumns,
  onToggleColumnVisibility,
  onSetDefaultColumnVisibility,
}: TanStackDataTableProps) {
  // 状态管理
  const [grouping, setGrouping] = React.useState<GroupingState>(externalGrouping);
  const [expanded, setExpanded] = React.useState<ExpandedState>({});
  const [rowSelection, setRowSelection] = React.useState({});
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({});
  const [columnMenuOpen, setColumnMenuOpen] = React.useState<string | null>(null);
  const [visibilityOverrides, setVisibilityOverrides] = React.useState<Record<string, boolean>>({});

  // 使用外部控制的列管理面板状态
  const showSettingsPopup = showColumnManager;
  const setShowSettingsPopup = (show: boolean) => {
    onColumnManagerChange?.(show);
  };

  React.useEffect(() => {
    if (!columnManagerColumns || Object.keys(visibilityOverrides).length === 0) {
      return;
    }

    setVisibilityOverrides((current) => {
      let didChange = false;
      const next = { ...current };

      for (const column of columnManagerColumns) {
        const syncedVisibility = column.isVisible !== false;
        if (next[column.id] === syncedVisibility) {
          delete next[column.id];
          didChange = true;
        }
      }

      return didChange ? next : current;
    });
  }, [columnManagerColumns, visibilityOverrides]);

  // 虚拟滚动相关
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const tableWrapperRef = useRef<HTMLDivElement>(null); // wrapper 的 ref，用于滚动监听
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const loadMoreCheckTimeoutRef = useRef<number | null>(null);
  // 记录上次的纵向滚动位置，用于区分横向/纵向滚动
  const loadMoreLockedRef = useRef(false);
  const lastVerticalScrollTopRef = useRef<number>(0);

  const clearScheduledLoadMoreCheck = React.useCallback(() => {
    if (loadMoreCheckTimeoutRef.current !== null) {
      window.clearTimeout(loadMoreCheckTimeoutRef.current);
      loadMoreCheckTimeoutRef.current = null;
    }
  }, []);

  const checkShouldLoadMore = React.useCallback(() => {
    const container = tableWrapperRef.current;
    if (
      !container ||
      !onScrollEnd ||
      !hasMore ||
      loadingMore ||
      loading ||
      loadMoreLockedRef.current
    ) {
      return;
    }

    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceToBottom <= LOAD_MORE_THRESHOLD_PX) {
      loadMoreLockedRef.current = true;
      onScrollEnd();
    }
  }, [onScrollEnd, hasMore, loadingMore, loading]);

  const scheduleLoadMoreCheck = React.useCallback(() => {
    if (loadMoreCheckTimeoutRef.current !== null) {
      return;
    }

    loadMoreCheckTimeoutRef.current = window.setTimeout(() => {
      loadMoreCheckTimeoutRef.current = null;
      checkShouldLoadMore();
    }, 0);
  }, [checkShouldLoadMore]);

  const closeColumnManager = React.useCallback(() => {
    setColumnMenuOpen(null);
    setShowSettingsPopup(false);
    settingsButtonRef.current?.focus();
  }, [setShowSettingsPopup]);
  // 🆕 跟踪数据变化，用于清除选择状态
  const prevDataRef = useRef<any[]>([]);
  const handleScroll = React.useCallback(() => {
    const container = tableWrapperRef.current;
    if (!container) return;

    const currentScrollTop = container.scrollTop;
    if (currentScrollTop === lastVerticalScrollTopRef.current) {
      return;
    }

    lastVerticalScrollTopRef.current = currentScrollTop;
    scheduleLoadMoreCheck();
  }, [scheduleLoadMoreCheck]);

  React.useEffect(() => {
    const container = tableWrapperRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      clearScheduledLoadMoreCheck();
      container.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll, clearScheduledLoadMoreCheck]);

  React.useEffect(() => {
    if (!tableWrapperRef.current || !onScrollEnd || !hasMore || loadingMore || loading) {
      return;
    }

    scheduleLoadMoreCheck();
    return clearScheduledLoadMoreCheck;
  }, [
    data.length,
    onScrollEnd,
    hasMore,
    loadingMore,
    loading,
    scheduleLoadMoreCheck,
    clearScheduledLoadMoreCheck,
  ]);

  React.useEffect(() => {
    if (!showSettingsPopup) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.stopPropagation();

      if (columnMenuOpen) {
        setColumnMenuOpen(null);
        return;
      }

      closeColumnManager();
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [showSettingsPopup, columnMenuOpen, closeColumnManager]);
  React.useEffect(() => {
    if (!loadingMore || !hasMore) {
      loadMoreLockedRef.current = false;
    }
  }, [loadingMore, hasMore, data.length]);

  // 辅助函数：比较数组是否相等（浅比较）
  const arraysEqual = React.useCallback((a: string[], b: string[]) => {
    return a.length === b.length && a.every((val, idx) => val === b[idx]);
  }, []);

  // 同步外部分组状态（优化：使用浅比较而非JSON.stringify）
  React.useEffect(() => {
    if (!arraysEqual(grouping, externalGrouping)) {
      setGrouping(externalGrouping);
      // 当分组变化时，智能展开策略
      if (externalGrouping.length > 0) {
        // 展开第一层的前5个分组（避免一次性渲染太多）
        const initialExpanded: ExpandedState = {};
        for (let i = 0; i < Math.min(5, 10); i++) {
          initialExpanded[String(i)] = true;
        }
        setExpanded(initialExpanded);
      } else {
        setExpanded({});
      }
    }
  }, [externalGrouping, grouping, arraysEqual]);

  // 通知外部分组变化（优化：避免循环调用）
  const handleGroupingChange = React.useCallback(
    (updater: any) => {
      setGrouping(updater);
      if (onGroupingChange) {
        const newGrouping = typeof updater === 'function' ? updater(grouping) : updater;
        if (!arraysEqual(newGrouping, externalGrouping)) {
          onGroupingChange(newGrouping);
        }
      }
    },
    [onGroupingChange, grouping, externalGrouping, arraysEqual]
  );

  // 使用 ref 存储最新的回调函数，避免无限循环
  const onRowSelectionChangeRef = React.useRef(onRowSelectionChange);
  React.useEffect(() => {
    onRowSelectionChangeRef.current = onRowSelectionChange;
  }, [onRowSelectionChange]);

  // 通知外部行选择变化
  React.useEffect(() => {
    if (onRowSelectionChangeRef.current) {
      const selectedRows = Object.keys(rowSelection)
        .filter((key) => (rowSelection as Record<string, boolean>)[key])
        .map((key) => data[parseInt(key)])
        .filter(Boolean);
      onRowSelectionChangeRef.current(selectedRows);
    }
  }, [rowSelection, data]); // ✅ 移除 onRowSelectionChange 依赖

  // 🆕 当数据刷新时（非增量加载），清除选择状态
  React.useEffect(() => {
    const prevData = prevDataRef.current;

    // 判断是否为数据刷新（而非增量加载）
    // 如果新数据的第一条与旧数据的第一条不同，说明是刷新
    const isRefresh =
      data.length > 0 && prevData.length > 0 && data[0]?._row_id !== prevData[0]?._row_id;

    // 如果是数据刷新，清除选择状态
    if (isRefresh) {
      setRowSelection({});
    }

    prevDataRef.current = data;
  }, [data]);

  // 默认列定义（如果没有外部传入）
  // 优化：只在数据结构变化时重新生成，而非每次数据变化
  const dataStructureKey = useMemo(() => {
    if (!data || data.length === 0) return '';
    return Object.keys(data[0]).sort().join(',');
  }, [data]);

  const defaultColumns = useMemo<ColumnDef<any>[]>(() => {
    if (!data || data.length === 0) return [];

    const firstRow = data[0];
    const keys = Object.keys(firstRow);

    return keys.map((key, index) => ({
      accessorKey: key,
      id: key,
      header: key,

      // 第一列添加分组渲染
      cell:
        index === 0
          ? ({ row, getValue }) => {
              const value = getValue();

              if (row.getIsGrouped()) {
                return (
                  <div className="group-cell" style={{ paddingLeft: `${row.depth * 20}px` }}>
                    <button
                      onClick={row.getToggleExpandedHandler()}
                      className="expand-button"
                      title={row.getIsExpanded() ? '折叠' : '展开'}
                    >
                      {row.getIsExpanded() ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    <span className="group-value">{String(value)}</span>
                    <span className="group-count">({row.subRows.length} 条)</span>
                  </div>
                );
              }

              // 非分组行，但有缩进
              return <div style={{ paddingLeft: `${row.depth * 20 + 28}px` }}>{String(value)}</div>;
            }
          : undefined,

      // 聚合函数（根据数据类型自动选择）
      aggregationFn: typeof firstRow[key] === 'number' ? 'sum' : 'count',

      // 聚合单元格渲染
      aggregatedCell: ({ getValue }) => {
        const value = getValue();
        const type = typeof firstRow[key] === 'number' ? 'sum' : 'count';

        return (
          <span className={`aggregated-cell ${type}`}>
            {type === 'sum' && '∑ '}
            {type === 'count' && '# '}
            {typeof value === 'number' ? value.toLocaleString() : String(value ?? '')}
          </span>
        );
      },
    }));
  }, [dataStructureKey]);

  const columns = externalColumns || defaultColumns;

  // 创建表格实例
  const table = useReactTable({
    data,
    columns,
    state: {
      grouping,
      expanded,
      rowSelection,
      columnSizing,
    },
    onGroupingChange: handleGroupingChange,
    onExpandedChange: setExpanded,
    onRowSelectionChange: setRowSelection,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    // 启用行选择（需要有效的 _row_id，避免对聚合/派生行误操作）
    enableRowSelection: (row) => typeof (row.original as any)?._row_id === 'number',
    enableMultiRowSelection: true,
    // 启用列宽调整
    columnResizeMode: 'onChange',
    // 自动重置页面状态
    autoResetExpanded: false,
  });

  // 获取行数据（在所有 Hooks 之前计算）
  const rows = table.getRowModel().rows;

  // 计算行高样式类名
  const rowHeightClass = typeof rowHeight === 'number' ? '' : `row-height-${rowHeight}`;

  // 计算实际行高（像素值）
  const getRowHeightPx = () => {
    if (typeof rowHeight === 'number') return rowHeight;
    switch (rowHeight) {
      case 'compact':
        return 32;
      case 'comfortable':
        return 48;
      case 'normal':
      default:
        return 42;
    }
  };

  const estimatedRowHeight = getRowHeightPx();

  // 智能判断是否启用虚拟滚动（数据量 >= 50 时自动启用，避免在加载更多时切换模式）
  // 设置为50是因为pageSize=50，这样第一次加载后就启用虚拟滚动，避免中途切换
  const shouldUseVirtualization =
    enableVirtualization !== undefined ? enableVirtualization : rows.length >= 50;

  // 🔴 关键修复：无论如何都要调用 useVirtualizer，但通过 enabled 控制是否启用
  // 这确保 Hooks 调用顺序一致
  const rowVirtualizer = useVirtualizer({
    count: rows.length || 0, // 即使没有数据也要提供 count
    getScrollElement: () => tableWrapperRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 5, // 减少 overscan 数量，降低渲染开销
    enabled: shouldUseVirtualization && !loading && rows.length > 0, // 通过 enabled 控制
  });

  const virtualRows =
    shouldUseVirtualization && rows.length > 0
      ? rowVirtualizer.getVirtualItems()
      : rows.map((_, index) => ({
          index,
          start: index * estimatedRowHeight,
          size: estimatedRowHeight,
        }));

  const totalSize =
    shouldUseVirtualization && rows.length > 0
      ? rowVirtualizer.getTotalSize()
      : rows.length * estimatedRowHeight;

  const paddingTop = virtualRows.length > 0 ? virtualRows[0]?.start || 0 : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize -
        (virtualRows[virtualRows.length - 1]?.start || 0) -
        (virtualRows[virtualRows.length - 1]?.size || 0)
      : 0;

  // 渲染底部汇总行内容（提取为函数以便复用）
  const renderFooterContent = () => {
    if (!showFooter) return null;

    const selectedCount = Object.keys(rowSelection).filter(
      (k) => (rowSelection as Record<string, boolean>)[k]
    ).length;

    return table.getFooterGroups()[0]?.headers.map((header) => {
      return (
        <td
          key={header.id}
          style={{
            width: header.getSize(),
            textAlign:
              header.column.id === '_select' || header.column.id === '_add' ? 'center' : 'left',
          }}
        >
          {header.column.id === '_select' ? (
            // Checkbox列：显示设置图标
            <button
              ref={settingsButtonRef}
              type="button"
              className="footer-settings-button shell-icon-button"
              onClick={() => {
                if (showSettingsPopup) {
                  closeColumnManager();
                  return;
                }

                setColumnMenuOpen(null);
                setShowSettingsPopup(true);
              }}
              title="字段配置"
              aria-label="字段配置"
              aria-haspopup="dialog"
              aria-expanded={showSettingsPopup}
            >
              <Settings size={16} />
            </button>
          ) : header.column.id === '_add' ? null : header.index === 1 ? ( // 添加列：空
            // 第一个数据列：显示选中数量或总行数
            <span className="footer-cell footer-total">
              {selectedCount > 0
                ? `已选中 ${selectedCount.toLocaleString()} 条记录`
                : filteredTotalCount !== undefined
                  ? (() => {
                      const loadedText = data.length.toLocaleString();
                      const totalText = filteredTotalCount.toLocaleString();
                      const hasFilter = !!countContext?.hasFilter;
                      const hasSample = !!countContext?.hasSample;

                      if (hasSample) {
                        const prefix = hasFilter ? '筛选+采样后共' : '采样后共';
                        if (totalRowCount !== undefined) {
                          return `已加载 ${loadedText} / ${prefix} ${totalText} 条记录（数据集共 ${totalRowCount.toLocaleString()} 条）`;
                        }
                        return `已加载 ${loadedText} / ${prefix} ${totalText} 条记录`;
                      }

                      if (hasFilter) {
                        return `已加载 ${loadedText} / 筛选后共 ${totalText} 条记录`;
                      }

                      return `已加载 ${loadedText} / 共 ${totalText} 条记录`;
                    })()
                  : totalRowCount !== undefined
                    ? `已加载 ${data.length.toLocaleString()} / 总共 ${totalRowCount.toLocaleString()} 条记录`
                    : `共 ${data.length.toLocaleString()} 条记录`}
            </span>
          ) : (
            // 其他列：空或显示聚合信息
            <span className="footer-cell"></span>
          )}
        </td>
      );
    });
  };

  const getManageableColumns = React.useCallback(() => {
    if (columnManagerColumns && columnManagerColumns.length > 0) {
      return columnManagerColumns
        .filter((column) => !column.id.startsWith('_'))
        .map((column) => ({
          id: column.id,
          header: column.header ?? column.id,
          duckdbType: column.duckdbType,
          isVisible: visibilityOverrides[column.id] ?? (column.isVisible !== false),
          isDefaultHidden: column.isDefaultHidden === true,
          isViewHidden: column.isViewHidden === true,
          isViewForcedVisible: column.isViewForcedVisible === true,
          isViewExcludedByProjection: column.isViewExcludedByProjection === true,
          tableColumn: table.getColumn(column.id),
        }));
    }

    return table
      .getAllColumns()
      .filter((column) => !column.id.startsWith('_'))
      .map((column) => {
        const columnDef: any = column.columnDef;
        return {
          id: column.id,
          header: typeof columnDef.header === 'string' ? columnDef.header : column.id,
          duckdbType: columnDef.meta?.duckdbType,
          isVisible: column.getIsVisible(),
          isDefaultHidden: false,
          isViewHidden: false,
          isViewForcedVisible: false,
          isViewExcludedByProjection: false,
          tableColumn: column,
        };
      });
  }, [columnManagerColumns, table, visibilityOverrides]);

  const handleToggleColumnVisibility = React.useCallback(
    async (columnId: string, currentVisible: boolean) => {
      const nextVisible = !currentVisible;
      const tableColumn = table.getColumn(columnId);

      if (!onToggleColumnVisibility) {
        tableColumn?.toggleVisibility(nextVisible);
        return;
      }

      setVisibilityOverrides((current) => ({ ...current, [columnId]: nextVisible }));
      if (tableColumn) {
        tableColumn.toggleVisibility(nextVisible);
      }

      try {
        await onToggleColumnVisibility(columnId, nextVisible);
      } catch (error) {
        setVisibilityOverrides((current) => ({ ...current, [columnId]: currentVisible }));
        if (tableColumn) {
          tableColumn.toggleVisibility(currentVisible);
        }
        console.error('[TanStackDataTable] Failed to toggle column visibility:', error);
      }
    },
    [onToggleColumnVisibility, table]
  );

  const moveColumn = React.useCallback(
    async (columnId: string, direction: -1 | 1) => {
      if (!onReorderColumns) return;

      const currentOrder = getManageableColumns().map((col) => col.id);
      const currentIndex = currentOrder.indexOf(columnId);
      const targetIndex = currentIndex + direction;
      if (currentIndex < 0 || targetIndex < 0 || targetIndex >= currentOrder.length) return;

      const nextOrder = [...currentOrder];
      const [moved] = nextOrder.splice(currentIndex, 1);
      nextOrder.splice(targetIndex, 0, moved);
      try {
        await onReorderColumns(nextOrder);
      } catch (error) {
        console.error('[TanStackDataTable] Failed to reorder columns:', error);
      }
    },
    [getManageableColumns, onReorderColumns]
  );

  const renameColumn = React.useCallback(
    async (columnId: string) => {
      if (!onRenameColumn) return;
      const nextName = window.prompt('请输入新列名', columnId);
      if (!nextName) return;
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === columnId) return;
      try {
        await onRenameColumn(columnId, trimmed);
      } catch (error) {
        console.error('[TanStackDataTable] Failed to rename column:', error);
      }
    },
    [onRenameColumn]
  );

  const deleteColumn = React.useCallback(
    async (columnId: string) => {
      if (!onDeleteColumn) return;
      try {
        await onDeleteColumn(columnId);
      } catch (error) {
        console.error('[TanStackDataTable] Failed to delete column:', error);
      }
    },
    [onDeleteColumn]
  );

  // 判断是否全选
  const isAllSelected = table.getIsAllRowsSelected();

  // 加载状态 - 保证在所有 hooks 调用之后再早返回
  if (loading) {
    return (
      <div className="tanstack-table-container">
        <div className="table-loading">
          <div className="table-loading-spinner" />
        </div>
      </div>
    );
  }

  // 空状态 - 保证在所有 hooks 调用之后再早返回
  if (!data || data.length === 0) {
    return (
      <div className="tanstack-table-container">
        <div className="table-empty-state">
          <TableIcon size={64} strokeWidth={1} />
          <p>{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tanstack-table-container" ref={tableContainerRef}>
      <div className="tanstack-table-wrapper" ref={tableWrapperRef}>
        <table
          className={`tanstack-table ${rowHeightClass} ${isAllSelected ? 'all-selected' : ''}`}
        >
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    style={{
                      width: header.getSize(),
                    }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}

                    {/* 列宽调整手柄 */}
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className={`column-resizer ${
                          header.column.getIsResizing() ? 'isResizing' : ''
                        }`}
                        style={{
                          transform: header.column.getIsResizing()
                            ? `translateX(${table.getState().columnSizingInfo.deltaOffset ?? 0}px)`
                            : '',
                        }}
                      />
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: 'center', padding: '40px' }}>
                  <div className="table-empty-state">
                    <p>没有匹配的数据</p>
                  </div>
                </td>
              </tr>
            ) : (
              <>
                {/* 虚拟滚动 - 上方填充 */}
                {paddingTop > 0 && (
                  <tr>
                    <td colSpan={columns.length} style={{ height: `${paddingTop}px` }} />
                  </tr>
                )}

                {/* 渲染可见行 */}
                {virtualRows.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  const rowClasses = [];
                  if (row.getIsGrouped()) rowClasses.push('grouped-row');
                  if (row.getIsSelected()) rowClasses.push('selected');

                  return (
                    <tr
                      key={row.id}
                      className={rowClasses.join(' ')}
                      style={{
                        height: `${virtualRow.size}px`,
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        (() => {
                          const cellMeta = cell.column.columnDef.meta as
                            | { fieldName?: string }
                            | undefined;
                          const cellColor =
                            !_colorRules ||
                            cell.getIsGrouped() ||
                            cell.getIsAggregated() ||
                            cell.getIsPlaceholder() ||
                            !cellMeta?.fieldName
                              ? undefined
                              : applyColorRules(cell.getValue(), cellMeta.fieldName, _colorRules);

                          return (
                            <td
                              key={cell.id}
                              className={typeof cell.getValue() === 'number' ? 'cell-number' : ''}
                              style={cellColor ? { backgroundColor: cellColor } : undefined}
                            >
                          {cell.getIsGrouped() ? (
                            // 分组单元格
                            flexRender(cell.column.columnDef.cell, cell.getContext())
                          ) : cell.getIsAggregated() ? (
                            // 聚合单元格
                            flexRender(
                              cell.column.columnDef.aggregatedCell ?? cell.column.columnDef.cell,
                              cell.getContext()
                            )
                          ) : cell.getIsPlaceholder() ? (
                            // 占位符
                            <span className="placeholder-cell">-</span>
                          ) : (
                            // 普通单元格
                            flexRender(cell.column.columnDef.cell, cell.getContext())
                          )}
                            </td>
                          );
                        })()
                      ))}
                    </tr>
                  );
                })}

                {/* 虚拟滚动 - 下方填充 */}
                {paddingBottom > 0 && (
                  <tr>
                    <td colSpan={columns.length} style={{ height: `${paddingBottom}px` }} />
                  </tr>
                )}

                {/* 加载更多指示器 */}
                {loadingMore && (
                  <tr>
                    <td colSpan={columns.length} style={{ textAlign: 'center', padding: '20px' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '8px',
                        }}
                      >
                        <div
                          className="table-loading-spinner"
                          style={{ width: '20px', height: '20px' }}
                        />
                        <span style={{ color: '#6b7280', fontSize: '14px' }}>加载更多数据...</span>
                      </div>
                    </td>
                  </tr>
                )}

                {/* 没有更多数据提示 */}
                {!hasMore && !loadingMore && data.length > 0 && (
                  <tr>
                    <td colSpan={columns.length} style={{ textAlign: 'center', padding: '16px' }}>
                      <span style={{ color: '#9ca3af', fontSize: '13px' }}>已加载全部数据</span>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* 底部汇总行 - 从table中分离，使用绝对定位固定在底部 */}
      {showFooter && (
        <div className="tanstack-table-footer">
          <table className={`tanstack-table-footer-table ${rowHeightClass}`}>
            <tbody>
              <tr>{renderFooterContent()}</tr>
            </tbody>
          </table>
        </div>
      )}

      {/* 设置弹窗 */}
      {showSettingsPopup && (
        <div
          className="table-column-manager-overlay"
          onClick={closeColumnManager}
        >
          <div
            role="dialog"
            aria-modal="false"
            aria-label="字段配置"
            className="table-column-manager-drawer shell-drawer-surface"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹窗头部 - 固定 */}
            <div className="table-column-manager-header shell-drawer-header">
              <div className="table-column-manager-title-group">
                <h3 className="table-column-manager-title">
                  字段配置
                </h3>
                <HelpCircle size={16} className="text-slate-400" />
              </div>
              <button
                type="button"
                onClick={closeColumnManager}
                className="shell-icon-button table-column-manager-close"
                title="关闭字段配置"
                aria-label="关闭字段配置"
              >
                <X size={20} />
              </button>
            </div>

            {/* 列管理列表 - 可滚动 */}
            <div
              className="table-column-manager-list"
              onClick={() => setColumnMenuOpen(null)}
            >
              {getManageableColumns().map((column, index, orderedColumns) => {
                const columnId = column.id;
                const header = column.header || columnId;

                // 根据列类型选择图标
                const getColumnIcon = () => {
                  const duckdbType = column.duckdbType?.toLowerCase() || '';

                  if (duckdbType.includes('date') || duckdbType.includes('timestamp')) {
                    return <Calendar size={16} color="#6b7280" />;
                  } else if (
                    duckdbType.includes('int') ||
                    duckdbType.includes('float') ||
                    duckdbType.includes('double') ||
                    duckdbType.includes('decimal')
                  ) {
                    return <Hash size={16} color="#6b7280" />;
                  } else {
                    return <Type size={16} color="#6b7280" />;
                  }
                };

                const isVisible = column.isVisible;
                const isFirstColumn = index === 0;
                const isLastColumn = index === orderedColumns.length - 1;

                return (
                  <div
                    key={columnId}
                    className="table-column-manager-row"
                  >
                    {!isFirstColumn && (
                      <GripVertical size={16} className="table-column-manager-drag" />
                    )}
                    {isFirstColumn && <div className="table-column-manager-spacer" />}

                    {/* 列图标 */}
                    {getColumnIcon()}

                    {/* 列名 */}
                    <div className="table-column-manager-copy">
                      <div className="table-column-manager-name">{header}</div>
                      {(column.isDefaultHidden ||
                        column.isViewHidden ||
                        column.isViewForcedVisible ||
                        column.isViewExcludedByProjection) && (
                        <div className="table-column-manager-badges">
                          {column.isDefaultHidden && (
                            <span className="shell-field-chip shell-field-chip--ghost px-1.5 py-0.5 text-[11px] leading-5 text-slate-600">
                              默认隐藏
                            </span>
                          )}
                          {column.isViewHidden && (
                            <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[11px] leading-5 text-red-700">
                              当前视图隐藏
                            </span>
                          )}
                          {column.isViewForcedVisible && (
                            <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] leading-5 text-emerald-700">
                              当前视图强制显示
                            </span>
                          )}
                          {column.isViewExcludedByProjection && (
                            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] leading-5 text-amber-700">
                              当前视图未选中
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 锁定图标（仅第一列显示） */}
                    {isFirstColumn && <Lock size={14} className="text-slate-400" />}

                    {/* 上移/下移 */}
                    {onReorderColumns && (
                      <div className="table-column-manager-order">
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            await moveColumn(columnId, -1);
                          }}
                          disabled={isFirstColumn}
                          className="shell-icon-button table-column-manager-order-button"
                          title="上移"
                          aria-label={`${header} 上移`}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            await moveColumn(columnId, 1);
                          }}
                          disabled={isLastColumn}
                          className="shell-icon-button table-column-manager-order-button"
                          title="下移"
                          aria-label={`${header} 下移`}
                        >
                          <ArrowDown size={14} />
                        </button>
                      </div>
                    )}

                    {/* 可见性切换按钮 */}
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await handleToggleColumnVisibility(columnId, isVisible);
                      }}
                      className="shell-icon-button table-column-manager-icon-button"
                      title={isVisible ? '隐藏字段' : '显示字段'}
                      aria-label={`${header}${isVisible ? ' 隐藏字段' : ' 显示字段'}`}
                    >
                      {isVisible ? (
                        <Eye size={16} className="text-slate-500" />
                      ) : (
                        <EyeOff size={16} className="text-slate-300" />
                      )}
                    </button>

                    {/* 更多操作菜单 */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setColumnMenuOpen(columnMenuOpen === columnId ? null : columnId);
                        }}
                        className="shell-icon-button table-column-manager-icon-button"
                        title="更多操作"
                        aria-label={`${header} 更多操作`}
                        aria-haspopup="menu"
                        aria-expanded={columnMenuOpen === columnId}
                        aria-controls={`column-manager-menu-${columnId}`}
                      >
                        <MoreHorizontal size={16} />
                      </button>

                      {/* 下拉菜单 */}
                      {columnMenuOpen === columnId && (
                        <div
                          id={`column-manager-menu-${columnId}`}
                          role="menu"
                          aria-label={`${header} 字段操作菜单`}
                          className="shell-field-panel absolute right-0 top-full z-[1100] mt-2 min-w-[12rem] p-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={async () => {
                              setColumnMenuOpen(null);
                              await renameColumn(columnId);
                            }}
                            disabled={!onRenameColumn}
                            className="shell-field-option flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Pencil size={14} />
                            <span>重命名</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={async () => {
                              setColumnMenuOpen(null);
                              await onSetDefaultColumnVisibility?.(
                                columnId,
                                column.isDefaultHidden === true
                              );
                            }}
                            disabled={!onSetDefaultColumnVisibility}
                            className="shell-field-option flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {column.isDefaultHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                            <span>{column.isDefaultHidden ? '设为默认显示' : '设为默认隐藏'}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={async () => {
                              setColumnMenuOpen(null);
                              await deleteColumn(columnId);
                            }}
                            disabled={!onDeleteColumn}
                            className="shell-field-option flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-red-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                          >
                            <Trash2 size={14} />
                            <span>删除</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 新增字段按钮 - 固定在底部 */}
            <div className="table-column-manager-footer shell-drawer-footer">
              <button
                type="button"
                onClick={() => {
                  onAddColumn?.();
                }}
                disabled={!onAddColumn}
                className="shell-field-control shell-field-control--inline table-column-manager-add-button"
              >
                <Plus size={16} />
                <span>新增字段</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
