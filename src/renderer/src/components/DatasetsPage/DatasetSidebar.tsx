/**
 * Dataset Sidebar Component
 * Shows list of dataset categories (云服务账号, 服务器账号, etc.)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
  Server,
  Mail,
  Youtube,
  Shield,
  LayoutDashboard,
  HardDrive,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  FileSpreadsheet,
  FolderPlus,
  Folder,
  FolderOpen,
  Table2,
  MoreVertical,
  Trash2,
  Loader2,
} from 'lucide-react';
import type { DatasetCategory, TableInfo } from './types';

interface DatasetSidebarProps {
  categories: DatasetCategory[];
  selectedCategory: string | null;
  selectedTableId: string | null; // 当前选中的表ID
  onSelectCategory: (categoryId: string) => void;
  onSelectTable: (tableId: string) => void; // 选中表的回调
  searchQuery: string;
  onSearchChange: (query: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onImportExcel?: () => void;
  onCreateDataset?: () => void;
  onCreateFolder?: () => void;
  onDeleteCategory?: (categoryId: string) => void;
  onImportExcelToFolder?: (folderId: string) => void; // 向文件夹导入Excel
  onCreateDatasetInFolder?: (folderId: string) => void; // 在文件夹中创建数据表
  onCreateSubfolder?: (parentId: string) => void; // 创建子文件夹
  onDeleteTable?: (datasetId: string) => void; // 删除数据表
  deletingItemId?: string | null; // 当前正在删除的侧边栏项
}

interface VisibleCategory extends DatasetCategory {
  childFolders: VisibleCategory[];
}

const categoryIcons: Record<string, React.ReactNode> = {
  'cloud-accounts': <Database className="w-5 h-5" />,
  'server-accounts': <Server className="w-5 h-5" />,
  'email-accounts': <Mail className="w-5 h-5" />,
  'youtube-accounts': <Youtube className="w-5 h-5" />,
  vpn: <Shield className="w-5 h-5" />,
  dashboard: <LayoutDashboard className="w-5 h-5" />,
  bt: <HardDrive className="w-5 h-5" />,
};

const sidebarRowBaseClasses =
  'group relative mb-1 flex w-full items-center gap-3 rounded-[18px] px-3 py-2 text-left transition-all duration-200';
const sidebarRowSelectedClasses =
  'bg-white/95 text-slate-900 shadow-[0_12px_28px_rgba(20,27,45,0.08)]';
const sidebarRowIdleClasses = 'text-slate-700 hover:bg-white/78 hover:text-slate-900';
const sidebarMenuButtonClasses =
  'shell-icon-button rounded-full p-1.5 text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700';
const sidebarMenuItemClasses =
  'shell-field-option flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 transition-colors';
const sidebarActionButtonClasses =
  'shell-field-control shell-field-control--inline flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:text-slate-900';

export function DatasetSidebar({
  categories,
  selectedCategory,
  selectedTableId,
  onSelectCategory,
  onSelectTable,
  searchQuery,
  onSearchChange,
  collapsed,
  onToggleCollapse,
  onImportExcel,
  onCreateDataset,
  onCreateFolder,
  onDeleteCategory,
  onImportExcelToFolder,
  onCreateDatasetInFolder,
  onCreateSubfolder,
  onDeleteTable,
  deletingItemId,
}: DatasetSidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showCollapsedQuickPanel, setShowCollapsedQuickPanel] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const collapsedSearchInputRef = useRef<HTMLInputElement>(null);
  const collapsedQuickPanelRef = useRef<HTMLDivElement>(null);
  const collapsedQuickSearchButtonRef = useRef<HTMLButtonElement>(null);
  const collapsedQuickPanelId = 'dataset-sidebar-collapsed-quick-panel';

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isSearchActive = normalizedSearchQuery.length > 0;

  const rootCategories = useMemo(
    () => categories.filter((category) => !category.isFolder || !category.parentId),
    [categories]
  );

  const childFoldersByParent = useMemo(() => {
    const map = new Map<string, DatasetCategory[]>();

    for (const category of categories) {
      if (!category.isFolder || !category.parentId) {
        continue;
      }

      const siblings = map.get(category.parentId) ?? [];
      siblings.push(category);
      map.set(category.parentId, siblings);
    }

    return map;
  }, [categories]);

  const { visibleRootCategories, searchExpandedFolders } = useMemo(() => {
    const cloneFullSubtree = (category: DatasetCategory): VisibleCategory => ({
      ...category,
      tables: [...category.tables],
      childFolders: (childFoldersByParent.get(category.id) ?? []).map(cloneFullSubtree),
    });

    const filterCategoryTree = (category: DatasetCategory): VisibleCategory | null => {
      if (!isSearchActive) {
        return cloneFullSubtree(category);
      }

      if (category.name.toLowerCase().includes(normalizedSearchQuery)) {
        return cloneFullSubtree(category);
      }

      const visibleTables = category.tables.filter((table) =>
        table.name.toLowerCase().includes(normalizedSearchQuery)
      );
      const visibleChildFolders = (childFoldersByParent.get(category.id) ?? [])
        .map(filterCategoryTree)
        .filter((child): child is VisibleCategory => child !== null);

      if (visibleTables.length === 0 && visibleChildFolders.length === 0) {
        return null;
      }

      return {
        ...category,
        tables: visibleTables,
        childFolders: visibleChildFolders,
      };
    };

    const nextVisibleRoots = rootCategories
      .map(filterCategoryTree)
      .filter((category): category is VisibleCategory => category !== null);

    const nextExpandedFolders = new Set<string>();
    if (isSearchActive) {
      const collectExpandedFolders = (category: VisibleCategory) => {
        if (!category.isFolder) {
          return;
        }

        nextExpandedFolders.add(category.id);
        category.childFolders.forEach(collectExpandedFolders);
      };

      nextVisibleRoots.forEach(collectExpandedFolders);
    }

    return {
      visibleRootCategories: nextVisibleRoots,
      searchExpandedFolders: nextExpandedFolders,
    };
  }, [childFoldersByParent, isSearchActive, normalizedSearchQuery, rootCategories]);

  const effectiveExpandedFolders = isSearchActive ? searchExpandedFolders : expandedFolders;

  const toggleFolder = (categoryId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  const countVisibleItems = (category: VisibleCategory): number =>
    category.tables.length +
    category.childFolders.reduce((sum, childCategory) => sum + countVisibleItems(childCategory), 0);

  const getCategoryTreeItemId = (categoryId: string) => `dataset-sidebar-treeitem-${categoryId}`;
  const getCategoryGroupId = (categoryId: string) => `dataset-sidebar-group-${categoryId}`;
  const getTableTreeItemId = (tableId: string) => `dataset-sidebar-table-${tableId}`;

  const handleExpandSidebar = () => {
    setShowCollapsedQuickPanel(false);
    onToggleCollapse();
  };

  // 切换菜单显示/隐藏
  const toggleMenu = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡到父级 button，避免触发选择数据表
    setOpenMenuId(openMenuId === categoryId ? null : categoryId);
  };

  // 处理删除操作
  const handleDeleteCategory = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡
    setOpenMenuId(null); // 立即关闭菜单
    onDeleteCategory?.(categoryId);
  };

  const handleCategoryActivate = (category: DatasetCategory) => {
    if (category.isFolder) {
      onSelectCategory(category.id);
      toggleFolder(category.id);
      return;
    }

    onSelectCategory(category.id);
    if (collapsed && showCollapsedQuickPanel) {
      setShowCollapsedQuickPanel(false);
    }
  };

  const renderTableRow = (table: TableInfo, ownerCategoryId: string, depth: number) => {
    const isTableSelected = selectedCategory === ownerCategoryId && selectedTableId === table.id;
    const isCustomPage = table.isCustomPage;
    const selectedTextClass = isCustomPage ? 'text-violet-600' : 'text-sky-700';
    const handleSelectVisibleTable = () => {
      onSelectCategory(ownerCategoryId);
      onSelectTable(table.id);
      if (collapsed && showCollapsedQuickPanel) {
        setShowCollapsedQuickPanel(false);
      }
    };

    return (
      <div key={table.id} className="relative group" style={{ marginLeft: depth * 24 }}>
        <div
          id={getTableTreeItemId(table.id)}
          role="treeitem"
          tabIndex={0}
          aria-level={depth + 1}
          aria-selected={isTableSelected}
          onClick={handleSelectVisibleTable}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelectVisibleTable();
            }
          }}
          className={`${sidebarRowBaseClasses} cursor-pointer py-1.5 ${
            isTableSelected
              ? `${sidebarRowSelectedClasses} ${selectedTextClass}`
              : `${sidebarRowIdleClasses} text-slate-600`
          }`}
        >
          {isTableSelected && (
            <span
              aria-hidden="true"
              className={`absolute left-1 top-2 bottom-2 w-1 rounded-full ${
                isCustomPage ? 'bg-violet-500/85' : 'bg-sky-500/85'
              }`}
            />
          )}

          {isCustomPage ? (
            table.customPageInfo?.icon ? (
              <span className="text-base">{table.customPageInfo.icon}</span>
            ) : (
              <LayoutDashboard
                className={`w-4 h-4 ${isTableSelected ? selectedTextClass : 'text-slate-400'}`}
              />
            )
          ) : (
            <Table2
              className={`w-4 h-4 ${isTableSelected ? selectedTextClass : 'text-slate-400'}`}
            />
          )}

          <span
            className={`flex-1 truncate text-sm ${
              isTableSelected ? `${selectedTextClass} font-medium` : 'text-slate-600'
            }`}
          >
            {table.name}
          </span>

          {!isCustomPage && (
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={(e) => toggleMenu(`table_${table.id}`, e)}
                className={sidebarMenuButtonClasses}
                title="更多操作"
                aria-label={`${table.name} 更多操作`}
                aria-haspopup="menu"
                aria-expanded={openMenuId === `table_${table.id}`}
                aria-controls={`dataset-sidebar-menu-table-${table.id}`}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>

              {openMenuId === `table_${table.id}` && (
                <div
                  id={`dataset-sidebar-menu-table-${table.id}`}
                  role="menu"
                  aria-label={`${table.name} 操作菜单`}
                  className="shell-field-panel absolute right-0 top-full z-10 mt-2 w-48 p-1 animate-in fade-in-0 slide-in-from-top-2 duration-200"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(null);
                      onDeleteTable?.(table.datasetId);
                    }}
                    disabled={deletingItemId === table.datasetId}
                    className="shell-field-option flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingItemId === table.datasetId ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    <span>
                      {deletingItemId === table.datasetId ? '删除中...' : '删除数据表'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderFolderContent = (category: VisibleCategory, depth: number) => {
    const nextDepth = depth + 1;
    const hasVisibleChildren = category.childFolders.length > 0 || category.tables.length > 0;

    if (!hasVisibleChildren && !category.pluginId) {
      return (
        <div
          style={{ marginLeft: nextDepth * 24 }}
          className="mx-1 rounded-2xl border border-dashed border-slate-200/80 bg-white/45 px-3 py-2 text-xs italic text-slate-500"
        >
          可拖拽内容到这里
        </div>
      );
    }

    return (
      <div
        id={getCategoryGroupId(category.id)}
        role="group"
        aria-labelledby={getCategoryTreeItemId(category.id)}
      >
        {category.childFolders.map((childFolder) => renderCategoryNode(childFolder, nextDepth))}
        {category.tables.map((table) => renderTableRow(table, category.id, nextDepth))}
      </div>
    );
  };

  const renderCategoryNode = (category: VisibleCategory, depth = 0): React.ReactNode => {
    const isSelected = selectedCategory === category.id;
    const isFolder = !!category.isFolder;
    const isExpanded = effectiveExpandedFolders.has(category.id);
    const icon = categoryIcons[category.id] || <Database className="w-5 h-5" />;

    return (
      <div key={category.id}>
        <div
          id={getCategoryTreeItemId(category.id)}
          onClick={() => handleCategoryActivate(category)}
          role="treeitem"
          tabIndex={0}
          aria-level={depth + 1}
          aria-selected={isSelected}
          aria-expanded={isFolder ? isExpanded : undefined}
          aria-controls={isFolder ? getCategoryGroupId(category.id) : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleCategoryActivate(category);
              return;
            }

            if (isFolder && e.key === 'ArrowRight' && !isExpanded) {
              e.preventDefault();
              onSelectCategory(category.id);
              toggleFolder(category.id);
              return;
            }

            if (isFolder && e.key === 'ArrowLeft' && isExpanded) {
              e.preventDefault();
              onSelectCategory(category.id);
              toggleFolder(category.id);
            }
          }}
          className={`${sidebarRowBaseClasses} cursor-pointer ${
            isSelected ? sidebarRowSelectedClasses : sidebarRowIdleClasses
          }`}
          style={depth > 0 ? { marginLeft: depth * 24 } : undefined}
        >
          {isSelected && (
            <span
              aria-hidden="true"
              className={`absolute left-1 top-2 bottom-2 w-1 rounded-full ${
                isFolder ? 'bg-sky-500/80' : 'bg-sky-600/85'
              }`}
            />
          )}

          {isFolder && (
            <span className="text-slate-400">
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </span>
          )}

          <span className={isSelected ? 'text-slate-900' : 'text-slate-500'}>
            {isFolder ? (
              isExpanded ? (
                <FolderOpen className="w-5 h-5" />
              ) : (
                <Folder className="w-5 h-5" />
              )
            ) : (
              icon
            )}
          </span>

          <span className="flex-1 truncate text-sm font-medium">{category.name}</span>

          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={(e) => toggleMenu(category.id, e)}
              className={sidebarMenuButtonClasses}
              title="更多操作"
              aria-label={`${category.name} 更多操作`}
              aria-haspopup="menu"
              aria-expanded={openMenuId === category.id}
              aria-controls={`dataset-sidebar-menu-${category.id}`}
            >
              <MoreVertical className="h-4 w-4" />
            </button>

            {openMenuId === category.id && (
              <div
                id={`dataset-sidebar-menu-${category.id}`}
                role="menu"
                aria-label={`${category.name} 操作菜单`}
                className="shell-field-panel absolute right-0 top-full z-10 mt-2 w-52 p-1 animate-in fade-in-0 slide-in-from-top-2 duration-200"
              >
                {isFolder ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        onImportExcelToFolder?.(category.id);
                      }}
                      className={sidebarMenuItemClasses}
                    >
                      <FileSpreadsheet className="h-4 w-4 text-green-600" />
                      <span>导入 Excel</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        onCreateDatasetInFolder?.(category.id);
                      }}
                      className={sidebarMenuItemClasses}
                    >
                      <Table2 className="h-4 w-4 text-violet-600" />
                      <span>创建数据表</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        onCreateSubfolder?.(category.id);
                      }}
                      className={sidebarMenuItemClasses}
                    >
                      <FolderPlus className="h-4 w-4 text-slate-600" />
                      <span>创建子文件夹</span>
                    </button>
                    <div className="my-1 border-t border-slate-200/90"></div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(e) => handleDeleteCategory(category.id, e)}
                      className="shell-field-option flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                      <span>删除文件夹</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(e) => handleDeleteCategory(category.id, e)}
                    disabled={deletingItemId === category.id}
                    className="shell-field-option flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingItemId === category.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    <span>{deletingItemId === category.id ? '删除中...' : '删除数据表'}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {isFolder && isExpanded && renderFolderContent(category, depth)}
      </div>
    );
  };

  // 点击外部区域关闭菜单
  useEffect(() => {
    const handleClickOutside = () => {
      if (openMenuId) {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openMenuId]);

  useEffect(() => {
    if (!showCollapsedQuickPanel) {
      return;
    }

    collapsedSearchInputRef.current?.focus();
    collapsedSearchInputRef.current?.select();
  }, [showCollapsedQuickPanel]);

  useEffect(() => {
    if (!showCollapsedQuickPanel) {
      return;
    }

    const handlePointerDownOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (collapsedQuickPanelRef.current?.contains(target)) {
        return;
      }

      if (collapsedQuickSearchButtonRef.current?.contains(target)) {
        return;
      }

      setShowCollapsedQuickPanel(false);
    };

    document.addEventListener('mousedown', handlePointerDownOutside);
    return () => document.removeEventListener('mousedown', handlePointerDownOutside);
  }, [showCollapsedQuickPanel]);

  useEffect(() => {
    if (!showCollapsedQuickPanel) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      setShowCollapsedQuickPanel(false);
      collapsedQuickSearchButtonRef.current?.focus();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showCollapsedQuickPanel]);

  // 折叠状态下的 UI
  if (collapsed) {
    const handleCollapsedCategoryActivate = (category: VisibleCategory) => {
      handleCategoryActivate(category);
      if (category.isFolder) {
        handleExpandSidebar();
      }
    };

    return (
      <div className="shell-sidebar-surface relative flex h-full flex-col">
        {/* 折叠顶部操作 */}
        <div className="datasets-workspace-sidebar-header space-y-2 p-3">
          <button
            type="button"
            ref={collapsedQuickSearchButtonRef}
            onClick={() => {
              const nextValue = !showCollapsedQuickPanel;
              setShowCollapsedQuickPanel(nextValue);
            }}
            className="shell-icon-button flex w-full items-center justify-center rounded-[18px] p-2.5 text-slate-600 transition-colors hover:bg-white/75 hover:text-slate-900"
            title="快速搜索"
            aria-label="快速搜索"
            aria-haspopup="dialog"
            aria-expanded={showCollapsedQuickPanel}
            aria-controls={collapsedQuickPanelId}
          >
            <Search className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={handleExpandSidebar}
            className="shell-icon-button flex w-full items-center justify-center rounded-[18px] p-2.5 text-slate-600 transition-colors hover:bg-white/75 hover:text-slate-900"
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            <ChevronLeft className="h-5 w-5 rotate-180" />
          </button>
        </div>

        {/* 只显示图标的分类列表 */}
        <div className="flex-1 overflow-y-auto p-2" role="tree" aria-label="数据目录">
          {visibleRootCategories.map((category) => {
            const isSelected = selectedCategory === category.id;
            const visibleItemCount = countVisibleItems(category);
            const icon =
              category.isFolder ?
                effectiveExpandedFolders.has(category.id) ?
                  <FolderOpen className="h-5 w-5" />
                : <Folder className="h-5 w-5" />
              : categoryIcons[category.id] || <Database className="h-5 w-5" />;

            return (
              <button
                type="button"
                key={category.id}
                onClick={() => handleCollapsedCategoryActivate(category)}
                className={`${sidebarRowBaseClasses} justify-center px-0 ${
                  isSelected ? sidebarRowSelectedClasses : 'text-slate-600 hover:bg-white/72'
                }`}
                title={category.name}
                role="treeitem"
                aria-level={1}
                aria-selected={isSelected}
                aria-expanded={category.isFolder ? effectiveExpandedFolders.has(category.id) : undefined}
              >
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="absolute left-1 top-2 bottom-2 w-1 rounded-full bg-sky-500/80"
                  />
                )}
                {icon}
                {visibleItemCount > 0 && (
                  <span className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-sky-600 px-1 text-[10px] font-semibold text-white shadow-[0_6px_12px_rgba(14,165,233,0.16)]">
                    {visibleItemCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 折叠状态下的底部操作区 */}
        <div className="datasets-workspace-sidebar-footer space-y-1 p-2">
          <button
            type="button"
            onClick={onImportExcel}
            className="shell-icon-button flex w-full items-center justify-center rounded-[18px] p-2.5 text-slate-600 transition-colors hover:bg-white/75 hover:text-slate-900"
            title="导入 Excel"
          >
            <FileSpreadsheet className="h-5 w-5 text-green-600" />
          </button>
          <button
            type="button"
            onClick={onCreateDataset}
            className="shell-icon-button flex w-full items-center justify-center rounded-[18px] p-2.5 text-slate-600 transition-colors hover:bg-white/75 hover:text-slate-900"
            title="数据表"
          >
            <Table2 className="h-5 w-5 text-violet-600" />
          </button>
          <button
            type="button"
            onClick={onCreateFolder}
            className="shell-icon-button flex w-full items-center justify-center rounded-[18px] p-2.5 text-slate-600 transition-colors hover:bg-white/75 hover:text-slate-900"
            title="文件夹"
          >
            <FolderPlus className="h-5 w-5 text-slate-600" />
          </button>
        </div>

        {showCollapsedQuickPanel && (
          <div
            ref={collapsedQuickPanelRef}
            id={collapsedQuickPanelId}
            role="dialog"
            aria-modal="false"
            aria-label="折叠侧边栏快速搜索"
            className="shell-field-panel absolute left-full top-3 z-30 ml-3 flex w-[min(20rem,calc(100vw-6rem))] max-w-[20rem] flex-col p-3 shadow-[0_24px_56px_rgba(20,27,45,0.18)]"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">快速搜索</p>
                <p className="mt-1 text-xs text-slate-500">折叠态下直接浏览目录和数据表</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  handleExpandSidebar();
                }}
                className="shell-icon-button rounded-full p-2 text-slate-500 transition-colors hover:bg-white/80 hover:text-slate-900"
                title="展开完整侧边栏"
              >
                <ChevronLeft className="h-4 w-4 rotate-180" />
              </button>
            </div>

            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                ref={collapsedSearchInputRef}
                type="text"
                placeholder="搜索"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                aria-label="快速搜索数据目录"
                className="shell-field-input py-2.5 pl-10 pr-3 text-sm"
              />
            </div>

            <div
              className="mt-3 max-h-[min(30rem,calc(100vh-10rem))] overflow-y-auto pr-1"
              role="tree"
              aria-label="快速搜索结果"
            >
              {visibleRootCategories.length > 0 ? (
                visibleRootCategories.map((category) => renderCategoryNode(category))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200/80 bg-white/55 px-4 py-6 text-sm text-slate-500">
                  未找到匹配的数据表
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 展开状态下的 UI
  return (
    <div className="shell-sidebar-surface flex h-full flex-col">
      {/* Search Header with Collapse Button */}
      <div className="datasets-workspace-sidebar-header p-4">
        <div className="flex items-center gap-2">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="搜索数据目录"
              className="shell-field-input py-2.5 pl-10 pr-3 text-sm"
            />
          </div>

          {/* Collapse Button */}
          <button
            type="button"
            onClick={onToggleCollapse}
            className="shell-icon-button shrink-0 rounded-full p-2.5 text-slate-600 transition-colors hover:bg-white/75 hover:text-slate-900"
            title="收起侧边栏"
            aria-label="收起侧边栏"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Category List */}
      <div className="flex-1 overflow-y-auto p-2" role="tree" aria-label="数据目录">
        {visibleRootCategories.length > 0 ? (
          visibleRootCategories.map((category) => renderCategoryNode(category))
        ) : (
          <div className="px-3 py-6 text-sm text-slate-500">未找到匹配的数据表</div>
        )}
      </div>

      {/* 底部操作区 */}
      <div className="datasets-workspace-sidebar-footer space-y-2 p-3">
        <div className="mb-1 px-1 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
          新建
        </div>

        <button
          type="button"
          onClick={onImportExcel}
          className={sidebarActionButtonClasses}
        >
          <FileSpreadsheet className="h-4 w-4 text-green-600" />
          <span>导入 Excel</span>
        </button>

        <button
          type="button"
          onClick={onCreateDataset}
          className={sidebarActionButtonClasses}
        >
          <Table2 className="h-4 w-4 text-violet-600" />
          <span>数据表</span>
        </button>

        <button
          type="button"
          onClick={onCreateFolder}
          className={sidebarActionButtonClasses}
        >
          <FolderPlus className="h-4 w-4 text-slate-600" />
          <span>文件夹</span>
        </button>
      </div>
    </div>
  );
}
