import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ToolbarButton } from '../../../hooks/useJSPluginUIExtensions';
import { renderStringIcon } from '../../../lib/string-icon';
import { toast } from '../../../lib/toast';
import { cn } from '../../../lib/utils';

type DatasetRow = Record<string, unknown>;

interface ToolbarButtonProps {
  button: ToolbarButton;
  selectedRows: DatasetRow[];
  onExecute: (
    button: ToolbarButton,
    selectedRows: DatasetRow[]
  ) => Promise<{ success: boolean; error?: string }>;
  onSuccess?: () => void;
  disabled?: boolean;
  variant?: 'toolbar' | 'menu';
}

export function JSPluginToolbarButton({
  button,
  selectedRows,
  onExecute,
  onSuccess,
  disabled = false,
  variant = 'toolbar',
}: ToolbarButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (loading || disabled) return;

    setLoading(true);
    try {
      const result = await onExecute(button, selectedRows);

      if (result.success) {
        onSuccess?.();
      } else if (result.error) {
        if (!result.error.includes('取消') && !result.error.includes('cancelled')) {
          toast.error('操作失败', result.error);
        }
      }
    } catch (error) {
      console.error('[ToolbarButton] Toolbar button execution failed:', error);
      const message = error instanceof Error ? error.message : '执行失败';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const isDisabled = disabled || (button.requiresSelection && selectedRows.length === 0);

  let title = button.label;
  if (button.requiresSelection) {
    if (button.minSelection > 0 && button.maxSelection) {
      title += ` (需要选择 ${button.minSelection}-${button.maxSelection} 行)`;
    } else if (button.minSelection > 0) {
      title += ` (至少选择 ${button.minSelection} 行)`;
    } else if (button.maxSelection) {
      title += ` (最多选择 ${button.maxSelection} 行)`;
    }
  }

  const buttonClassName =
    variant === 'menu'
      ? 'shell-field-option flex w-full items-center gap-3 px-3 py-2.5 text-sm text-slate-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'
      : cn(
          'shell-field-control flex h-10 shrink-0 items-center gap-2 whitespace-nowrap px-3.5 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900',
          'disabled:cursor-not-allowed disabled:border-transparent disabled:bg-white/35 disabled:text-slate-400 disabled:shadow-none'
        );

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDisabled || loading}
      role={variant === 'menu' ? 'menuitem' : undefined}
      className={buttonClassName}
      title={title}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        renderStringIcon(button.icon, {
          size: 16,
          lucideClassName: 'w-4 h-4',
          emojiClassName: 'text-base leading-none',
          imageClassName: 'w-4 h-4 object-contain',
          fallback: <span className="text-xs">?</span>,
          alt: button.label,
        })
      )}
      <span>{loading ? '执行中...' : button.label}</span>
    </button>
  );
}
