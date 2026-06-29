/**
 * Enhanced Dialog Component v2
 *
 * Features:
 * - Focus trap (焦点锁定)
 * - Scroll lock (滚动锁定)
 * - ESC to close (ESC键关闭)
 * - Backdrop click to close (点击遮罩关闭)
 * - Portal rendering (Portal渲染)
 * - ARIA attributes (无障碍属性)
 * - Animations (动画效果)
 * - Backdrop blur (毛玻璃背景)
 */

import React, { useEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';
  footer?: React.ReactNode;

  // 功能开关
  closeOnEsc?: boolean; // ESC关闭（默认true）
  closeOnBackdropClick?: boolean; // 点击遮罩关闭（默认true）
  showCloseButton?: boolean; // 显示X按钮（默认true）
  lockScroll?: boolean; // 锁定滚动（默认true）
  backdropBlur?: boolean; // 毛玻璃（默认true）
  animated?: boolean; // 动画（默认true）

  // 自定义类名
  className?: string;
  contentClassName?: string;

  // 其他props
  disableCloseButton?: boolean; // 禁用关闭按钮
}

/**
 * 获取所有可聚焦元素
 */
const getFocusableElements = (container: HTMLElement): HTMLElement[] => {
  const selector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  return Array.from(container.querySelectorAll<HTMLElement>(selector));
};

export function DialogV2({
  open,
  onClose,
  title,
  description,
  children,
  maxWidth = 'md',
  footer,
  closeOnEsc = true,
  closeOnBackdropClick = true,
  showCloseButton = true,
  lockScroll = true,
  backdropBlur = true,
  animated = true,
  className = '',
  contentClassName = '',
  disableCloseButton = false,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // 生成唯一ID用于ARIA
  const titleId = useId();
  const descriptionId = useId();

  // 焦点锁定
  useEffect(() => {
    if (!open) return;

    // 保存当前焦点元素
    previousFocusRef.current = document.activeElement as HTMLElement;

    // 聚焦到对话框中的第一个可聚焦元素
    const dialog = dialogRef.current;
    if (dialog) {
      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length > 0) {
        focusableElements[0]?.focus();
      }
    }

    // 处理Tab键循环
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialog) return;

      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: 如果在第一个元素上，跳到最后一个
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        // Tab: 如果在最后一个元素上，跳到第一个
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleTab);

    // 清理：恢复焦点
    return () => {
      document.removeEventListener('keydown', handleTab);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  // 滚动锁定
  useEffect(() => {
    if (!open || !lockScroll) return;

    // 计算滚动条宽度，避免内容跳动
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    // 保存原始样式
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;

    // 锁定滚动
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, [open, lockScroll]);

  // ESC键关闭
  useEffect(() => {
    if (!open || !closeOnEsc) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, closeOnEsc, onClose]);

  if (!open) return null;

  const maxWidthClass = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
    '4xl': 'max-w-4xl',
    '5xl': 'max-w-5xl',
  }[maxWidth];

  const content = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      {/* Backdrop */}
      <div
        className={`
          shell-floating-backdrop absolute inset-0
          ${backdropBlur ? 'backdrop-blur-sm' : ''}
          ${animated ? 'animate-in fade-in-0 duration-200' : ''}
        `}
        onClick={closeOnBackdropClick ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        className={`
          shell-floating-panel relative w-full mx-4
          ${maxWidthClass}
          ${animated ? 'animate-in fade-in-0 zoom-in-95 duration-200' : ''}
          ${className}
        `}
      >
        {/* Header */}
        <div className="shell-floating-panel__header flex items-start justify-between p-4">
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-slate-500">
                {description}
              </p>
            )}
          </div>
          {showCloseButton && (
            <button
              onClick={onClose}
              disabled={disableCloseButton}
              className="ml-4 flex-shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="关闭对话框"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className={`p-4 ${contentClassName}`}>{children}</div>

        {/* Footer */}
        {footer && (
          <div className="shell-floating-panel__footer flex items-center justify-end gap-2 p-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

// 导出一个简化的别名
export const Dialog = DialogV2;
