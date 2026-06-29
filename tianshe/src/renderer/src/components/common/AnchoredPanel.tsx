/**
 * AnchoredPanel - 基于 Floating UI 的通用弹出面板组件
 *
 * 特性：
 * - ✅ 自动定位（基于 anchor 元素）
 * - ✅ 碰撞检测（自动翻转和偏移）
 * - ✅ 无视觉跳跃（visibility: hidden 策略）
 * - ✅ 标准化结构（Header + Content + Footer）
 * - ✅ ESC 键关闭
 * - ✅ Backdrop 点击关闭
 *
 * 使用示例：
 * ```tsx
 * <AnchoredPanel
 *   open={true}
 *   onClose={handleClose}
 *   anchorEl={buttonRef.current}
 *   title="筛选条件"
 *   footer={<button onClick={handleApply}>应用</button>}
 * >
 *   <div>面板内容</div>
 * </AnchoredPanel>
 * ```
 */

import React, { useEffect } from 'react';
import { useFloating, offset, flip, shift, autoUpdate, Placement } from '@floating-ui/react';
import { X } from 'lucide-react';

export interface AnchoredPanelProps {
  // 基础控制
  open: boolean;
  onClose: () => void;
  anchorEl: HTMLElement | null;

  // 定位配置
  placement?: Placement; // 默认 'bottom-start'
  offsetDistance?: number; // 默认 4px

  // 样式配置
  width?: string | number; // 默认 '580px'
  maxHeight?: string; // 默认 'calc(100vh - 120px)'

  // 内容插槽
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;

  // 高级配置
  closeOnBackdropClick?: boolean; // 默认 true
  showCloseButton?: boolean; // 默认 true
  className?: string;
}

export function AnchoredPanel({
  open,
  onClose,
  anchorEl,
  placement = 'bottom-start',
  offsetDistance = 4,
  width = '580px',
  maxHeight = 'calc(100vh - 120px)',
  title,
  children,
  footer,
  closeOnBackdropClick = true,
  showCloseButton = true,
  className = '',
}: AnchoredPanelProps) {
  // Floating UI 核心 hook
  const { refs, floatingStyles, isPositioned } = useFloating({
    elements: {
      reference: anchorEl,
    },
    placement,
    open,
    middleware: [
      offset(offsetDistance), // 间距
      flip(), // 自动翻转（防止超出视口）
      shift({ padding: 8 }), // 自动偏移（保持在视口内）
    ],
    whileElementsMounted: autoUpdate, // 自动更新位置
  });

  // Destructure to avoid ref access during render
  const { setFloating } = refs;

  // ESC 键关闭
  useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  // 未打开时不渲染
  if (!open) return null;

  return (
    <>
      {/* Backdrop - 遮罩层 */}
      <div
        className="shell-floating-backdrop fixed inset-0 z-40"
        onClick={closeOnBackdropClick ? onClose : undefined}
      />

      {/* Panel - 面板主体 */}
      <div
        ref={setFloating}
        style={{
          ...floatingStyles,
          width: typeof width === 'number' ? `${width}px` : width,
          maxHeight,
          visibility: isPositioned ? 'visible' : 'hidden', // 👈 关键：防止视觉跳跃
        }}
        className={`shell-floating-panel fixed z-50 ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header - 标题栏 */}
        {title && (
          <div className="shell-floating-panel__header flex items-center justify-between px-5 py-3">
            {typeof title === 'string' ? (
              <span className="text-sm font-medium text-slate-700">{title}</span>
            ) : (
              title
            )}
            {showCloseButton && (
              <button
                onClick={onClose}
                className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        )}

        {/* Content - 内容区域（可滚动） */}
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {children}
        </div>

        {/* Footer - 底部操作区 */}
        {footer && <div className="shell-floating-panel__footer px-5 py-3">{footer}</div>}
      </div>
    </>
  );
}
