/**
 * 自定义页面弹窗组件（重构版）
 * 用于在弹出窗口中显示插件的自定义页面
 *
 * 注意：此组件有特殊的尺寸配置需求（width、height、resizable），
 * 因此保持自定义实现，但增加了Portal渲染、ESC键支持、滚动锁定等功能
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { CustomPageInfo } from '../../../../types/js-plugin';
import { CustomPageViewer } from './CustomPageViewer';

interface CustomPagePopupProps {
  page: CustomPageInfo | null;
  isOpen: boolean;
  onClose: () => void;
  datasetId?: string;
}

export function CustomPagePopup({ page, isOpen, onClose, datasetId }: CustomPagePopupProps) {
  // ESC键关闭
  useEffect(() => {
    if (!isOpen) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  // 滚动锁定
  useEffect(() => {
    if (!isOpen) return;

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;

    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, [isOpen]);

  if (!isOpen || !page) return null;

  // 解析弹窗配置
  const popupConfig = page.popup_config ? JSON.parse(page.popup_config) : {};
  const width = popupConfig.width || '80vw';
  const height = popupConfig.height || '80vh';
  const resizable = popupConfig.resizable !== false;

  const content = (
    <div
      className="shell-floating-backdrop fixed inset-0 z-50 flex items-center justify-center animate-in fade-in-0 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-page-title"
    >
      {/* 遮罩层 */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      {/* 弹窗内容 */}
      <div
        className="shell-floating-panel relative flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        style={{
          width,
          height,
          maxWidth: '95vw',
          maxHeight: '95vh',
          resize: resizable ? 'both' : 'none',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="shell-floating-panel__header flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            {page.icon && <span className="text-lg">{page.icon}</span>}
            <h2 id="custom-page-title" className="text-base font-semibold text-slate-900">
              {page.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 transition-colors hover:bg-white/80"
            title="关闭"
            aria-label="关闭对话框"
          >
            <X className="h-5 w-5 text-slate-600" />
          </button>
        </div>

        {/* 页面内容 */}
        <div className="flex-1 overflow-hidden">
          <CustomPageViewer page={page} datasetId={datasetId} />
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
