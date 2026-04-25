/**
 * Dataset Tabs Component
 * Grouped table tabs within a dataset content area.
 */

import React, { useState } from 'react';
import { Plus, Filter, Pencil, X } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '../../lib/utils';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DialogV2 } from '../ui/dialog-v2';

export interface TabInfo {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  isDefault?: boolean;
}

interface DatasetTabsProps {
  tabs: TabInfo[];
  selectedTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCreateTab: () => void;
  onDeleteTab?: (tabId: string) => void;
  onRenameTab?: (tabId: string, newName: string) => void;
  onReorder?: (tabIds: string[]) => void;
}

interface SortableTabItemProps {
  tab: TabInfo;
  isSelected: boolean;
  index: number;
  totalTabs: number;
  onSelect: () => void;
  onMoveSelection: (target: 'previous' | 'next' | 'first' | 'last') => void;
  onRenameRequest?: () => void;
  onDeleteRequest?: () => void;
}

function SortableTabItem({
  tab,
  isSelected,
  index,
  totalTabs,
  onSelect,
  onMoveSelection,
  onRenameRequest,
  onDeleteRequest,
}: SortableTabItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const { onKeyDown: dragKeyDown, ...dragListeners } = listeners ?? {};

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onMoveSelection('previous');
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onMoveSelection('next');
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      onMoveSelection('first');
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      onMoveSelection('last');
      return;
    }

    dragKeyDown?.(event);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex cursor-grab select-none active:cursor-grabbing"
      {...attributes}
      {...dragListeners}
      role="tab"
      id={`dataset-tab-${tab.id}`}
      aria-selected={isSelected}
      aria-controls={`dataset-tabpanel-${tab.id}`}
      aria-posinset={index + 1}
      aria-setsize={totalTabs}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      title={tab.description}
    >
      <div
        className={cn(
          'group relative flex min-w-0 flex-col items-start rounded-xl px-4 py-2.5 transition-all',
          isSelected
            ? 'bg-white text-slate-900 shadow-[0_10px_20px_rgba(20,27,45,0.08)]'
            : 'text-slate-600 hover:bg-white/72 hover:text-slate-900'
        )}
      >
        <div className="flex items-center gap-2 w-full">
          {tab.icon ? (
            <span className="text-base">{tab.icon}</span>
          ) : (
            <Filter className="w-4 h-4" />
          )}
          <span className="text-sm font-medium whitespace-nowrap">{tab.name}</span>
          {tab.isDefault && (
            <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-700">
              默认
            </span>
          )}

          <div
            className="ml-auto flex items-center gap-1"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            {onRenameRequest && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRenameRequest();
                }}
                className="shell-icon-button rounded-full p-1.5 text-slate-400 transition-colors hover:bg-sky-100 hover:text-sky-700"
                title="重命名数据表"
              >
                <Pencil className="w-3 h-3 text-sky-700" />
              </button>
            )}
            {onDeleteRequest && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteRequest();
                }}
                className="shell-icon-button rounded-full p-1.5 text-slate-400 transition-colors hover:bg-red-100 hover:text-red-600"
                title="删除数据表"
              >
                <X className="w-3 h-3 text-red-600" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DatasetTabs({
  tabs,
  selectedTabId,
  onSelectTab,
  onCreateTab,
  onDeleteTab,
  onRenameTab,
  onReorder,
}: DatasetTabsProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
  const [renameTarget, setRenameTarget] = useState<TabInfo | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<TabInfo | null>(null);

  const openRenameDialog = (tab: TabInfo) => {
    setRenameTarget(tab);
    setRenameValue(tab.name);
  };

  const closeRenameDialog = () => {
    setRenameTarget(null);
    setRenameValue('');
  };

  const trimmedRenameValue = renameValue.trim();
  const renameDisabled =
    !renameTarget || trimmedRenameValue.length === 0 || trimmedRenameValue === renameTarget.name;

  const handleConfirmRename = () => {
    if (!renameTarget || !onRenameTab) {
      closeRenameDialog();
      return;
    }

    if (renameDisabled) {
      return;
    }

    onRenameTab(renameTarget.id, trimmedRenameValue);
    closeRenameDialog();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = tabs.findIndex((v) => v.id === active.id);
    const newIndex = tabs.findIndex((v) => v.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const reordered = arrayMove(tabs, oldIndex, newIndex);
    onReorder?.(reordered.map((v) => v.id));
  };

  const handleMoveSelection = (
    currentIndex: number,
    target: 'previous' | 'next' | 'first' | 'last'
  ) => {
    if (tabs.length === 0) {
      return;
    }

    const nextIndex =
      target === 'previous'
        ? (currentIndex - 1 + tabs.length) % tabs.length
        : target === 'next'
          ? (currentIndex + 1) % tabs.length
          : target === 'first'
            ? 0
            : tabs.length - 1;

    onSelectTab(tabs[nextIndex].id);
  };

  return (
    <>
      <div className="overflow-x-auto px-4 py-2">
        <div
          className="datasets-workspace-tab-strip shell-tab-strip flex w-max min-w-full items-center gap-2"
          role="tablist"
          aria-label="组内数据表标签"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tabs.map((v) => v.id)} strategy={horizontalListSortingStrategy}>
              {tabs.map((tab, index) => (
                <SortableTabItem
                  key={tab.id}
                  tab={tab}
                  isSelected={selectedTabId === tab.id}
                  index={index}
                  totalTabs={tabs.length}
                  onSelect={() => onSelectTab(tab.id)}
                  onMoveSelection={(target) => handleMoveSelection(index, target)}
                  onRenameRequest={onRenameTab ? () => openRenameDialog(tab) : undefined}
                  onDeleteRequest={onDeleteTab ? () => setDeleteTarget(tab) : undefined}
                />
              ))}
            </SortableContext>
          </DndContext>

          <button
            type="button"
            onClick={onCreateTab}
            className="shell-field-control shell-field-control--inline flex items-center gap-1.5 rounded-[14px] px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-white/82 hover:text-slate-900"
            title="复制当前数据表为新标签页"
          >
            <Plus className="w-4 h-4" />
            <span className="font-medium">复制为新标签页</span>
          </button>
        </div>
      </div>

      <DialogV2
        open={!!renameTarget}
        onClose={closeRenameDialog}
        title="重命名数据表"
        description="修改当前标签页对应数据表的显示名称。"
        maxWidth="sm"
        footer={
          <>
            <button
              type="button"
              onClick={closeRenameDialog}
              className="shell-field-control px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleConfirmRename}
              disabled={renameDisabled}
              className="shell-field-control shell-field-control--active px-4 py-2 text-sm font-medium text-slate-900 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              保存名称
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label htmlFor="dataset-tab-name" className="block text-sm font-medium text-slate-700">
            标签页名称
          </label>
          <input
            id="dataset-tab-name"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !renameDisabled) {
                e.preventDefault();
                handleConfirmRename();
              }
            }}
            className="shell-field-input px-3 py-2 text-sm"
            placeholder="请输入名称"
          />
        </div>
      </DialogV2>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        title={deleteTarget ? `删除数据表“${deleteTarget.name}”？` : '删除数据表'}
        description="删除后将移除这个标签页对应的数据表，且该操作无法撤销。"
        confirmText="确认删除"
        cancelText="取消"
        variant="danger"
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) {
            onDeleteTab?.(target.id);
          }
        }}
      />
    </>
  );
}
