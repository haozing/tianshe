/**
 * ConfirmDialog Component (重构版)
 *
 * 确认对话框组件，用于危险操作或重要决策的二次确认
 *
 * Features:
 * - Portal rendering (Portal渲染)
 * - Focus trap (焦点锁定)
 * - Scroll lock (滚动锁定)
 * - ESC/Enter keyboard shortcuts (键盘快捷键)
 * - Backdrop blur effect (毛玻璃背景)
 * - Smooth animations (平滑动画)
 * - ARIA attributes (无障碍属性)
 * - Variant support (default/danger)
 * - Loading state (加载状态)
 */

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  icon?: React.ReactNode;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmText = '确认',
  cancelText = '取消',
  variant = 'default',
  icon,
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // 焦点锁定
  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement;

    const dialog = dialogRef.current;
    if (dialog) {
      const focusableElements = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusableElements.length > 0) {
        focusableElements[0]?.focus();
      }
    }

    return () => {
      previousFocusRef.current?.focus();
    };
  }, [open]);

  // 滚动锁定
  useEffect(() => {
    if (!open) return;

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;

    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, [open]);

  const handleConfirm = async () => {
    try {
      await onConfirm();
    } catch (error) {
      console.error('[ConfirmDialog] Confirm action failed:', error);
    }
  };

  // 键盘快捷键支持
  useEffect(() => {
    if (!open || loading) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, loading, onOpenChange, handleConfirm]);

  if (!open) return null;

  const content = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
    >
      {/* 背景遮罩 */}
      <div
        className="shell-floating-backdrop absolute inset-0 animate-in fade-in-0 duration-200"
        onClick={() => !loading && onOpenChange(false)}
        aria-hidden="true"
      />

      {/* 对话框内容 */}
      <div
        ref={dialogRef}
        className="shell-floating-panel relative mx-4 w-full max-w-md animate-in fade-in-0 zoom-in-95 duration-200"
      >
        {/* 头部 */}
        <div className="shell-floating-panel__header flex items-start gap-3 p-6 pb-4">
          {icon && (
            <div
              className={`
              flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center
              ${variant === 'danger' ? 'bg-red-100 text-red-600' : 'bg-sky-100 text-sky-600'}
            `}
            >
              {icon}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 id="confirm-dialog-title" className="text-lg font-semibold text-slate-900">
              {title}
            </h3>
            <p id="confirm-dialog-description" className="mt-2 text-sm text-slate-600">
              {description}
            </p>
            {children ? <div className="mt-4">{children}</div> : null}
          </div>
          {!loading && (
            <button
              onClick={() => onOpenChange(false)}
              className="flex-shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700"
              aria-label="关闭对话框"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="shell-floating-panel__footer flex justify-end gap-3 px-6 py-4">
          <button
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="rounded-xl border border-white/80 bg-white/85 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className={`
              flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50
              ${
                variant === 'danger'
                  ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                  : 'bg-slate-900 hover:bg-slate-800 focus:ring-slate-500'
              }
            `}
          >
            {loading && (
              <svg
                className="animate-spin h-4 w-4 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
            )}
            {loading ? '处理中...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
