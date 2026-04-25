/**
 * Dataset Toolbar Component
 * Provides actions: add record, field config, filter, group, sort, row height, fill color
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Filter,
  Group,
  SortAsc,
  AlignJustify,
  Paintbrush,
  BarChart3,
  Sparkles,
  Link2,
  Target,
  MoreHorizontal,
  Columns,
  Dices,
  Package,
  Download,
  Settings,
  ChevronDown,
} from 'lucide-react';
import { useToolbarButtons } from '../../hooks/useJSPluginUIExtensions';
import { JSPluginToolbarButton } from './TanStackDataTable/ToolbarButton';
import { selectActiveQueryConfig, useDatasetStore } from '../../stores/datasetStore';
import { cn } from '../../lib/utils';

type SelectedRow = Record<string, unknown>;

interface DatasetToolbarProps {
  datasetId: string;
  selectedRows?: SelectedRow[]; // For batch execution
  onCreateTabCopy?: () => void;
  onAddRecord?: () => void;
  onAddColumn?: () => void; // New: Add column button
  onFilter?: () => void;
  onAggregate?: () => void;
  onClean?: () => void;
  onLookup?: () => void;
  onDedupe?: () => void;
  onSort?: () => void;
  onColumn?: () => void;
  onSample?: () => void;
  onGroup?: () => void;
  onRowHeight?: () => void;
  onFillColor?: () => void;
  onExport?: () => void;
  onToolbarOrderConfig?: () => void; // New: Open toolbar order dialog
  onRefreshData?: () => void; // Callback to refresh data after toolbar button execution
  filterButtonRef?: React.RefObject<HTMLButtonElement>;
  groupButtonRef?: React.RefObject<HTMLButtonElement>;
  sortButtonRef?: React.RefObject<HTMLButtonElement>;
  fillColorButtonRef?: React.RefObject<HTMLButtonElement>;
  cleanButtonRef?: React.RefObject<HTMLButtonElement>;
  dedupeButtonRef?: React.RefObject<HTMLButtonElement>;
  moreButtonRef?: React.RefObject<HTMLDivElement>; // 🆕 "更多"按钮的ref
  readOnly?: boolean; // 快照只读模式
}

const toolbarMenuItemClasses =
  'shell-field-option flex w-full items-center gap-3 px-3 py-2.5 text-sm text-slate-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const toolbarMenuHeaderClasses =
  'px-3 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500';
const toolbarBadgeClasses =
  'shell-field-chip shell-field-chip--accent absolute -right-1 -top-1 flex min-h-[18px] min-w-[18px] items-center justify-center px-1 text-[10px] font-semibold leading-none';
const toolbarActiveMetaClasses =
  'shell-field-chip shell-field-chip--accent ml-auto inline-flex px-2 py-0.5 text-[10px] font-semibold';

export function DatasetToolbar({
  datasetId,
  selectedRows = [],
  onCreateTabCopy,
  onAddRecord,
  onAddColumn,
  onFilter,
  onAggregate,
  onClean,
  onLookup,
  onDedupe,
  onSort,
  onColumn,
  onSample,
  onGroup,
  onRowHeight,
  onFillColor,
  onExport,
  onToolbarOrderConfig,
  onRefreshData,
  filterButtonRef,
  groupButtonRef,
  sortButtonRef,
  fillColorButtonRef,
  cleanButtonRef,
  dedupeButtonRef,
  moreButtonRef, // 🆕
  readOnly = false,
}: DatasetToolbarProps) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showRunMenu, setShowRunMenu] = useState(false);
  const moreMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const runMenuTriggerRef = useRef<HTMLButtonElement>(null);

  const runMenuOpen = showRunMenu && !readOnly;
  const moreMenuId = 'dataset-toolbar-more-menu';
  const runMenuId = 'dataset-toolbar-plugin-menu';

  // 从 store 读取当前查询模板配置，用于显示筛选/排序/清洗/采样角标
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);
  const filterCount = activeQueryConfig?.filter?.conditions?.length || 0;
  const hasGroup = !!activeQueryConfig?.group;
  const hasAggregate = !!activeQueryConfig?.aggregate;
  const sortCount = activeQueryConfig?.sort?.columns?.length || 0;
  const colorRuleCount = activeQueryConfig?.color?.rules?.length || 0;
  const hasColorRules = colorRuleCount > 0;
  const hasRowHeight = activeQueryConfig?.rowHeight !== undefined;
  const cleanCount = activeQueryConfig?.clean?.length || 0;
  const hasSample = !!activeQueryConfig?.sample;

  // JS Plugin UI Extensions - Toolbar Buttons
  const { toolbarButtons: jsPluginToolbarButtons, executeToolbarButton } =
    useToolbarButtons(datasetId);

  const handleAddRecord = () => {
    onAddRecord?.();
  };

  const handleFilter = () => {
    onFilter?.();
  };

  const handleGroup = () => {
    onGroup?.();
  };

  const handleSort = () => {
    onSort?.();
  };

  const handleFillColor = () => {
    onFillColor?.();
  };

  useEffect(() => {
    if (!showMoreMenu && !runMenuOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      if (showMoreMenu) {
        setShowMoreMenu(false);
        moreMenuTriggerRef.current?.focus();
        return;
      }

      if (runMenuOpen) {
        setShowRunMenu(false);
        runMenuTriggerRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [runMenuOpen, showMoreMenu]);

  return (
    <div className="flex flex-col" role="toolbar" aria-label="数据表工具栏">
      {/* Toolbar */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5 xl:items-center">
        {/* Left Side - Main Tools */}
        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
          <div className="flex min-w-max items-center gap-2 pr-2">
            {/* Add Record */}
            <button
              type="button"
              onClick={handleAddRecord}
              disabled={readOnly}
              className={cn(
                getToolbarButtonClasses({ disabled: readOnly, emphasized: true }),
                'px-3.5'
              )}
              title={readOnly ? '数据未就绪，暂不支持新增记录' : '添加记录'}
            >
              <Plus className="w-4 h-4" />
              <span>添加记录</span>
            </button>

            {onCreateTabCopy && (
              <button
                type="button"
                onClick={onCreateTabCopy}
                className={getToolbarButtonClasses()}
                title="复制当前数据表为新标签页"
              >
                <Package className="w-4 h-4" />
                <span>复制为新标签页</span>
              </button>
            )}

            <div className="mx-1 h-6 w-px shrink-0 bg-slate-200/70" />

            {/* Data Processing - Main Functions */}
            <button
              type="button"
              ref={filterButtonRef}
              onClick={handleFilter}
              className={cn(getToolbarButtonClasses({ active: filterCount > 0 }), 'relative')}
              title="筛选"
            >
              <Filter className="w-4 h-4" />
              <span>筛选</span>
              {filterCount > 0 && <span className={toolbarBadgeClasses}>{filterCount}</span>}
            </button>

            <button
              type="button"
              ref={groupButtonRef}
              onClick={handleGroup}
              className={getToolbarButtonClasses({ active: hasGroup })}
              title="分组"
            >
              <Group className="w-4 h-4" />
              <span>分组</span>
            </button>

            <button
              type="button"
              ref={sortButtonRef}
              onClick={handleSort}
              className={cn(getToolbarButtonClasses({ active: sortCount > 0 }), 'relative')}
              title="排序"
            >
              <SortAsc className="w-4 h-4" />
              <span>排序</span>
              {sortCount > 0 && <span className={toolbarBadgeClasses}>{sortCount}</span>}
            </button>

            <button
              type="button"
              ref={fillColorButtonRef}
              onClick={handleFillColor}
              className={cn(getToolbarButtonClasses({ active: hasColorRules }), 'relative')}
              title="填色"
            >
              <Paintbrush className="w-4 h-4" />
              <span>填色</span>
              {hasColorRules && <span className={toolbarBadgeClasses}>{colorRuleCount}</span>}
            </button>

            <div className="mx-1 h-6 w-px shrink-0 bg-slate-200/70" />

            {/* Data Processing - Secondary Functions */}
            <button
              type="button"
              ref={cleanButtonRef}
              onClick={() => onClean?.()}
              disabled={readOnly}
              className={cn(
                getToolbarButtonClasses({
                  active: cleanCount > 0,
                  disabled: readOnly,
                }),
                'relative'
              )}
              title={readOnly ? '数据未就绪，暂不支持清洗' : '清洗'}
            >
              <Sparkles className="w-4 h-4" />
              <span>清洗</span>
              {cleanCount > 0 && <span className={toolbarBadgeClasses}>{cleanCount}</span>}
            </button>

            <button
              type="button"
              ref={dedupeButtonRef}
              onClick={() => onDedupe?.()}
              className={getToolbarButtonClasses()}
              title="去重"
            >
              <Target className="w-4 h-4" />
              <span>去重</span>
            </button>

            <button
              type="button"
              onClick={() => onExport?.()}
              className={getToolbarButtonClasses()}
              title="导出"
            >
              <Download className="w-4 h-4" />
              <span>导出</span>
            </button>

            {/* Plugin Configuration Button */}
            {onToolbarOrderConfig && (
              <button
                type="button"
                onClick={onToolbarOrderConfig}
                className={getToolbarButtonClasses()}
                title="配置插件按钮"
              >
                <Settings className="w-4 h-4" />
              </button>
            )}

          </div>
        </div>

        <div className="flex shrink-0 items-start gap-2 xl:items-center">
          {/* More Functions */}
          <div className="relative" ref={moreButtonRef}>
            <ToolbarButton
              buttonRef={moreMenuTriggerRef}
              icon={<MoreHorizontal className="w-4 h-4" />}
              label="更多"
              onClick={() => setShowMoreMenu(!showMoreMenu)}
              active={showMoreMenu}
              menuId={moreMenuId}
              hasPopup="menu"
            />

            {/* Dropdown Menu */}
            {showMoreMenu && (
              <>
                {/* Backdrop */}
                <div
                  className="fixed inset-0 z-10"
                  aria-hidden="true"
                  onClick={() => {
                    setShowMoreMenu(false);
                    moreMenuTriggerRef.current?.focus();
                  }}
                />

                {/* Menu */}
                <div
                  id={moreMenuId}
                  role="menu"
                  aria-label="更多功能菜单"
                  className="shell-field-panel absolute right-0 top-full z-20 mt-2 min-w-[220px] p-1"
                >
                  <div className="py-1">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (readOnly) {
                          setShowMoreMenu(false);
                          return;
                        }
                        onAddColumn?.();
                        setShowMoreMenu(false);
                      }}
                      disabled={readOnly}
                      className={toolbarMenuItemClasses}
                    >
                      <Columns className="w-4 h-4" />
                      <span>添加列</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onColumn?.();
                        setShowMoreMenu(false);
                      }}
                      className={toolbarMenuItemClasses}
                    >
                      <Columns className="w-4 h-4" />
                      <span>列管理</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onRowHeight?.();
                        setShowMoreMenu(false);
                      }}
                      className={cn(
                        toolbarMenuItemClasses,
                        hasRowHeight && 'bg-sky-50 font-medium text-sky-700'
                      )}
                    >
                      <AlignJustify className="w-4 h-4" />
                      <span>行高设置</span>
                      {hasRowHeight && <span className={toolbarActiveMetaClasses}>已配置</span>}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onSample?.();
                        setShowMoreMenu(false);
                      }}
                      className={cn(
                        toolbarMenuItemClasses,
                        hasSample && 'bg-sky-50 font-medium text-sky-700'
                      )}
                    >
                      <Dices className="w-4 h-4" />
                      <span>采样</span>
                      {hasSample && <span className={toolbarActiveMetaClasses}>已配置</span>}
                    </button>
                    <div className="my-1 border-t border-slate-200/90"></div>

                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAggregate?.();
                        setShowMoreMenu(false);
                      }}
                      className={cn(
                        toolbarMenuItemClasses,
                        hasAggregate && 'bg-sky-50 font-medium text-sky-700'
                      )}
                    >
                      <BarChart3 className="w-4 h-4" />
                      <span>聚合</span>
                      {hasAggregate && <span className={toolbarActiveMetaClasses}>已配置</span>}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onLookup?.();
                        setShowMoreMenu(false);
                      }}
                      className={toolbarMenuItemClasses}
                    >
                      <Link2 className="w-4 h-4" />
                      <span>关联</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Right Side - Plugin Button (仅在有插件时显示) */}
          {jsPluginToolbarButtons.length > 0 && (
            <div className="relative">
              <button
                ref={runMenuTriggerRef}
                type="button"
                onClick={() => {
                  if (readOnly) {
                    setShowRunMenu(false);
                    return;
                  }
                  setShowRunMenu(!showRunMenu);
                }}
                disabled={readOnly}
                aria-expanded={runMenuOpen}
                aria-haspopup="menu"
                aria-controls={runMenuId}
                className={getToolbarButtonClasses({
                  active: runMenuOpen,
                  disabled: readOnly,
                })}
                title={readOnly ? '数据未就绪，暂不支持执行插件操作' : '插件功能'}
              >
                <Package className="w-4 h-4" />
                <span>插件</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {/* Plugin Functions Dropdown Menu */}
              {runMenuOpen && (
                <>
                  {/* Backdrop */}
                  <div
                    className="fixed inset-0 z-10"
                    aria-hidden="true"
                    onClick={() => {
                      setShowRunMenu(false);
                      runMenuTriggerRef.current?.focus();
                    }}
                  />

                  {/* Menu */}
                  <div
                    id={runMenuId}
                    role="menu"
                    aria-label="插件功能菜单"
                    className="shell-field-panel absolute right-0 top-full z-20 mt-2 min-w-[220px] p-1"
                  >
                    <div className="max-h-[320px] overflow-y-auto py-1">
                      {/* Plugin Functions Header */}
                      <div className={toolbarMenuHeaderClasses} role="presentation">
                        插件功能
                      </div>

                      {/* Plugin Buttons */}
                      {jsPluginToolbarButtons.map((button) => (
                        <JSPluginToolbarButton
                          key={button.id}
                          button={button}
                          selectedRows={selectedRows}
                          disabled={readOnly}
                          onExecute={async (btn, rows) => {
                            const result = await executeToolbarButton(btn, rows);
                            setShowRunMenu(false);
                            return result;
                          }}
                          onSuccess={onRefreshData}
                          variant="menu"
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ToolbarButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  variant?: 'default' | 'primary';
  menuId?: string;
  hasPopup?: 'menu' | 'dialog';
  buttonRef?: React.RefObject<HTMLButtonElement>;
}

function ToolbarButton({
  icon,
  label,
  onClick,
  active,
  variant = 'default',
  menuId,
  hasPopup,
  buttonRef,
}: ToolbarButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-expanded={active}
      aria-haspopup={hasPopup}
      aria-controls={menuId}
      className={getToolbarButtonClasses({
        active,
        emphasized: variant === 'primary',
      })}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function getToolbarButtonClasses({
  active = false,
  disabled = false,
  emphasized = false,
}: {
  active?: boolean;
  disabled?: boolean;
  emphasized?: boolean;
} = {}) {
  return cn(
    'shell-field-control shell-field-control--inline flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[14px] px-3.5 text-sm font-medium transition-colors',
    disabled
      ? 'cursor-not-allowed border-transparent bg-transparent text-slate-400 shadow-none'
      : active
        ? 'border-transparent bg-white/95 text-sky-700 shadow-[0_10px_18px_rgba(20,27,45,0.08)]'
        : emphasized
          ? 'border-transparent bg-slate-900 text-white shadow-[0_12px_24px_rgba(15,23,42,0.14)] hover:bg-slate-800 hover:text-white'
          : 'bg-transparent text-slate-700 hover:bg-white/82 hover:text-slate-900'
  );
}
