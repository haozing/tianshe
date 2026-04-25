import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { ProfileGroup } from '../../../../types/profile';
import { UNGROUPED_GROUP_ID, useProfileStore } from '../../stores/profileStore';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

function filterGroupTree(nodes: ProfileGroup[], keyword: string): ProfileGroup[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return nodes;

  const walk = (node: ProfileGroup): ProfileGroup | null => {
    const children = (node.children || [])
      .map(walk)
      .filter((child): child is ProfileGroup => Boolean(child));
    const selfMatch = node.name.toLowerCase().includes(q);
    if (selfMatch || children.length > 0) {
      return { ...node, children };
    }
    return null;
  };

  return nodes.map(walk).filter((node): node is ProfileGroup => Boolean(node));
}

function collectSubtreeIds(node: ProfileGroup, out: Set<string>) {
  out.add(node.id);
  for (const child of node.children || []) {
    collectSubtreeIds(child, out);
  }
}

function findGroupById(nodes: ProfileGroup[], groupId: string): ProfileGroup | null {
  for (const node of nodes) {
    if (node.id === groupId) return node;
    const found = node.children ? findGroupById(node.children, groupId) : null;
    if (found) return found;
  }
  return null;
}

export function ProfileGroupTree() {
  const { profiles, groups, selectedGroupId, selectGroup, createGroup, updateGroup, deleteGroup } =
    useProfileStore();
  const [keyword, setKeyword] = useState('');
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());

  const isSearchActive = keyword.trim().length > 0;

  const { tree, subtreeCounts, ungroupedCount, totalCount } = useMemo(() => {
    const directCounts = new Map<string, number>();
    let ungrouped = 0;

    for (const profile of profiles) {
      if (profile.groupId) {
        directCounts.set(profile.groupId, (directCounts.get(profile.groupId) || 0) + 1);
      } else {
        ungrouped += 1;
      }
    }

    const subtree = new Map<string, number>();
    const compute = (node: ProfileGroup): number => {
      let count = directCounts.get(node.id) || 0;
      for (const child of node.children || []) {
        count += compute(child);
      }
      subtree.set(node.id, count);
      return count;
    };
    for (const root of groups) {
      compute(root);
    }

    return {
      tree: filterGroupTree(groups, keyword),
      subtreeCounts: subtree,
      ungroupedCount: ungrouped,
      totalCount: profiles.length,
    };
  }, [groups, keyword, profiles]);

  const toggleCollapsed = (groupId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleCreateRoot = async () => {
    const name = window.prompt('分组名称');
    if (!name || !name.trim()) return;
    const created = await createGroup({ name: name.trim() });
    if (created) {
      selectGroup(created.id);
    }
  };

  const handleCreateChild = async (parent: ProfileGroup) => {
    const name = window.prompt('子分组名称');
    if (!name || !name.trim()) return;
    const created = await createGroup({ name: name.trim(), parentId: parent.id });
    if (created) {
      selectGroup(created.id);
    }
  };

  const handleRename = async (group: ProfileGroup) => {
    const name = window.prompt('重命名分组', group.name);
    if (!name || !name.trim() || name.trim() === group.name) return;
    await updateGroup(group.id, { name: name.trim() });
  };

  const handleDelete = async (group: ProfileGroup) => {
    const actualGroup = findGroupById(groups, group.id) || group;
    const subtreeCount = subtreeCounts.get(actualGroup.id) || 0;
    if (subtreeCount > 0) {
      alert(`该分组（含子分组）还有 ${subtreeCount} 个配置，请先移动或删除配置。`);
      return;
    }

    const hasChildren = (actualGroup.children || []).length > 0;
    const ok = window.confirm(
      hasChildren ? '确定删除该分组及其子分组吗？（仅允许空分组）' : '确定删除该分组吗？'
    );
    if (!ok) return;

    if (selectedGroupId && selectedGroupId !== UNGROUPED_GROUP_ID) {
      const subtreeIds = new Set<string>();
      collectSubtreeIds(actualGroup, subtreeIds);
      if (subtreeIds.has(selectedGroupId)) {
        selectGroup(null);
      }
    }

    await deleteGroup(actualGroup.id, hasChildren);
  };

  const renderNode = (node: ProfileGroup, depth: number) => {
    const hasChildren = (node.children || []).length > 0;
    const isCollapsed = !isSearchActive && collapsedIds.has(node.id);
    const isSelected = selectedGroupId === node.id;
    const count = subtreeCounts.get(node.id) || 0;

    return (
      <div key={node.id}>
        <div
          className={cn(
            'group flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors',
            isSelected
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-700 hover:bg-white/70 hover:text-slate-900'
          )}
          style={{ paddingLeft: 12 + depth * 12 }}
          onClick={() => selectGroup(node.id)}
        >
          {hasChildren ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 flex-shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                if (isSearchActive) return;
                toggleCollapsed(node.id);
              }}
              disabled={isSearchActive}
            >
              {isCollapsed ? (
                <ChevronRight className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </Button>
          ) : (
            <span className="w-5 flex-shrink-0" />
          )}

          {node.icon ? (
            <span className="w-5 text-center flex-shrink-0">{node.icon}</span>
          ) : node.color ? (
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: node.color }}
            />
          ) : (
            <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          )}

          <span className="flex-1 truncate text-sm" title={node.name}>
            {node.name}
          </span>

          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCreateChild(node);
                  }}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  添加子分组
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRename(node);
                  }}
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(node);
                  }}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className={cn('text-xs', isSelected ? 'text-slate-500' : 'text-muted-foreground')}>
            {count}
          </span>
        </div>

        {!isCollapsed &&
          (node.children || []).map((child) => {
            return renderNode(child, depth + 1);
          })}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">

      <div className="mb-4">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索分组"
          className="h-10 rounded-[10px]"
        />
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
        <button
          type="button"
          className={cn(
            'flex items-center justify-between rounded-2xl border border-[rgba(214,221,234,0.92)] px-4 py-3 text-left text-sm transition-colors',
            selectedGroupId === null
              ? 'bg-white text-slate-900 shadow-sm'
              : 'bg-white/72 text-slate-700 hover:bg-white/90'
          )}
          onClick={() => selectGroup(null)}
        >
          <span className="inline-flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            全部环境
          </span>
          <span className="text-xs text-slate-500">{totalCount}</span>
        </button>

        <button
          type="button"
          className={cn(
            'flex items-center justify-between rounded-2xl border border-[rgba(214,221,234,0.92)] px-4 py-3 text-left text-sm transition-colors',
            selectedGroupId === UNGROUPED_GROUP_ID
              ? 'bg-white text-slate-900 shadow-sm'
              : 'bg-white/72 text-slate-700 hover:bg-white/90'
          )}
          onClick={() => selectGroup(UNGROUPED_GROUP_ID)}
        >
          <span className="inline-flex items-center gap-2">
            <Folder className="h-4 w-4" />
            未分组
          </span>
          <span className="text-xs text-slate-500">{ungroupedCount}</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/70 p-2">
        {tree.length > 0 ? (
          <div className="flex flex-col gap-0.5">{tree.map((node) => renderNode(node, 0))}</div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {isSearchActive ? '未找到匹配的分组' : '暂无分组'}
          </div>
        )}
      </div>
    </div>
  );
}
