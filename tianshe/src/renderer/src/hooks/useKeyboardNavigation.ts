/**
 * useKeyboardNavigation Hook
 * 处理数据表的键盘导航
 * 支持：Tab（横向）、Enter（向下）、Shift+Tab（反向）、方向键
 */

import { useEffect, RefObject } from 'react';

interface KeyboardNavigationOptions {
  enabled?: boolean;
  onNavigate?: (direction: 'up' | 'down' | 'left' | 'right' | 'next' | 'prev') => void;
  onEnterEditMode?: () => void;
  onExitEditMode?: () => void;
}

export function useKeyboardNavigation(
  containerRef: RefObject<HTMLElement>,
  options: KeyboardNavigationOptions = {}
) {
  const { enabled = true, onNavigate, onEnterEditMode, onExitEditMode } = options;

  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 如果焦点在输入框内，某些快捷键需要跳过
      const target = e.target as HTMLElement;
      const isInInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Tab键：横向导航（在编辑状态下也生效）
      if (e.key === 'Tab') {
        if (!e.shiftKey) {
          // Tab: 移动到下一个单元格
          e.preventDefault();
          onNavigate?.('next');
        } else {
          // Shift+Tab: 移动到上一个单元格
          e.preventDefault();
          onNavigate?.('prev');
        }
        return;
      }

      // Enter键：向下移动或进入编辑模式
      if (e.key === 'Enter') {
        if (isInInput) {
          // 在编辑模式下，Enter保存并向下移动
          e.preventDefault();
          onExitEditMode?.();
          onNavigate?.('down');
        } else {
          // 非编辑模式下，Enter进入编辑
          e.preventDefault();
          onEnterEditMode?.();
        }
        return;
      }

      // Escape键：退出编辑模式
      if (e.key === 'Escape') {
        if (isInInput) {
          e.preventDefault();
          onExitEditMode?.();
        }
        return;
      }

      // 方向键：仅在非编辑模式下生效
      if (!isInInput) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault();
            onNavigate?.('up');
            break;
          case 'ArrowDown':
            e.preventDefault();
            onNavigate?.('down');
            break;
          case 'ArrowLeft':
            e.preventDefault();
            onNavigate?.('left');
            break;
          case 'ArrowRight':
            e.preventDefault();
            onNavigate?.('right');
            break;
        }
      }
    };

    const container = containerRef.current;
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, containerRef, onNavigate, onEnterEditMode, onExitEditMode]);
}
