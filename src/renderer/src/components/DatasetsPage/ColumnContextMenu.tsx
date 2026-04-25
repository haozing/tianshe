/**
 * Column Context Menu - 列右键菜单
 * 提供快捷操作：重命名、隐藏、删除等
 */

import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { Edit2, Eye, EyeOff, Trash2, Copy, Lock, Settings } from 'lucide-react';

interface ColumnContextMenuProps {
  x: number;
  y: number;
  column: {
    name: string;
    selected: boolean;
  };
  onClose: () => void;
  onRename: () => void;
  onToggleVisibility: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onLock?: () => void;
  onProperties?: () => void;
}

export function ColumnContextMenu({
  x,
  y,
  column,
  onClose,
  onRename,
  onToggleVisibility,
  onDelete,
  onDuplicate,
  onLock,
  onProperties,
}: ColumnContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y });

  // Adjust position to prevent menu from going off screen
  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const menuRect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = x;
    let adjustedY = y;

    // Prevent menu from going off right edge
    if (x + menuRect.width > viewportWidth) {
      adjustedX = viewportWidth - menuRect.width - 10;
    }

    // Prevent menu from going off bottom edge
    if (y + menuRect.height > viewportHeight) {
      adjustedY = viewportHeight - menuRect.height - 10;
    }

    queueMicrotask(() => {
      setAdjustedPosition({ x: adjustedX, y: adjustedY });
    });
  }, [x, y]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[180px]"
      style={{
        left: `${adjustedPosition.x}px`,
        top: `${adjustedPosition.y}px`,
      }}
    >
      {/* Column name header */}
      <div className="px-3 py-2 border-b border-gray-100">
        <div className="text-xs font-medium text-gray-500">列操作</div>
        <div
          className="text-sm font-semibold text-gray-900 truncate max-w-[200px]"
          title={column.name}
        >
          {column.name}
        </div>
      </div>

      {/* Menu items */}
      <MenuItem
        icon={<Edit2 className="w-4 h-4" />}
        label="重命名"
        onClick={() => handleAction(onRename)}
      />

      <MenuItem
        icon={column.selected ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        label={column.selected ? '隐藏列' : '显示列'}
        onClick={() => handleAction(onToggleVisibility)}
      />

      {onDuplicate && (
        <MenuItem
          icon={<Copy className="w-4 h-4" />}
          label="复制列"
          onClick={() => handleAction(onDuplicate)}
        />
      )}

      {onLock && (
        <MenuItem
          icon={<Lock className="w-4 h-4" />}
          label="锁定列"
          onClick={() => handleAction(onLock)}
        />
      )}

      {onProperties && (
        <>
          <div className="my-1 border-t border-gray-100" />
          <MenuItem
            icon={<Settings className="w-4 h-4" />}
            label="字段属性"
            onClick={() => handleAction(onProperties)}
          />
        </>
      )}

      <div className="my-1 border-t border-gray-100" />

      <MenuItem
        icon={<Trash2 className="w-4 h-4" />}
        label="删除列"
        onClick={() => handleAction(onDelete)}
        variant="danger"
      />
    </div>
  );
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
  disabled?: boolean;
}

function MenuItem({ icon, label, onClick, variant = 'default', disabled = false }: MenuItemProps) {
  const baseClasses = 'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors';
  const variantClasses =
    variant === 'danger' ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-50';
  const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';

  return (
    <div
      className={`${baseClasses} ${variantClasses} ${disabledClasses}`}
      onClick={disabled ? undefined : onClick}
    >
      <span className={variant === 'danger' ? 'text-red-600' : 'text-gray-500'}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}
