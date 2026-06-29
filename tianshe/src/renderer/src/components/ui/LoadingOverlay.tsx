/**
 * LoadingOverlay Component
 *
 * 统一的全屏加载遮罩组件，用于替代所有硬编码的loading状态
 *
 * Features:
 * - Portal rendering (Portal渲染到body)
 * - Backdrop blur effect (毛玻璃背景)
 * - Smooth animations (平滑动画)
 * - 3 sizes (small, medium, large)
 * - Optional description text
 */

import React from 'react';
import { createPortal } from 'react-dom';

interface LoadingOverlayProps {
  open: boolean;
  message: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  showBackdrop?: boolean; // 是否显示背景遮罩
  backdropBlur?: boolean; // 是否使用毛玻璃效果
}

export function LoadingOverlay({
  open,
  message,
  description,
  size = 'md',
  showBackdrop = true,
  backdropBlur = true,
}: LoadingOverlayProps) {
  if (!open) return null;

  const sizeClasses = {
    sm: 'h-8 w-8 border-2',
    md: 'h-12 w-12 border-4',
    lg: 'h-16 w-16 border-4',
  }[size];

  const content = (
    <div
      className={`
        fixed inset-0 z-50 flex items-center justify-center
        ${showBackdrop ? 'shell-floating-backdrop' : ''}
        ${backdropBlur ? 'backdrop-blur-sm' : ''}
        animate-in fade-in-0 duration-200
      `}
      role="alert"
      aria-live="assertive"
      aria-busy="true"
    >
      <div className="shell-floating-panel max-w-md mx-4 px-10 py-8 animate-in zoom-in-95 duration-200">
        <div className="flex flex-col items-center gap-4">
          {/* Spinner */}
          <div className="relative">
            <div className={`animate-spin rounded-full border-slate-200 ${sizeClasses}`}></div>
            <div
              className={`absolute left-0 top-0 animate-spin rounded-full border-sky-600 border-t-transparent ${sizeClasses}`}
            ></div>
          </div>

          {/* Message */}
          <div className="text-center">
            <div className="mb-1 text-lg font-semibold text-slate-800">{message}</div>
            {description && <div className="text-sm text-slate-600">{description}</div>}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
