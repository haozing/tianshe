/**
 * Button field preview used by AddRecordDrawer.
 * This component only shows metadata state and does not accept record input.
 */

import { PlayCircle, Settings } from 'lucide-react';
import { normalizeButtonMetadata } from '../../../../../utils/button-metadata';

export interface ButtonFieldProps {
  metadata?: any;
  onConfigure?: () => void;
}

export function ButtonField({ metadata, onConfigure }: ButtonFieldProps) {
  const normalizedMetadata = normalizeButtonMetadata(metadata);
  const {
    buttonLabel = '执行',
    buttonIcon = '>',
    buttonVariant = 'primary',
    isConfigured,
    mappingCount,
  } = normalizedMetadata;

  const previewClassName = `
    px-3 py-1.5 text-sm font-medium rounded-xl transition-colors opacity-80 cursor-default
    ${buttonVariant === 'default' ? 'border border-slate-200 bg-white text-slate-700 shadow-sm' : ''}
    ${buttonVariant === 'primary' ? 'bg-slate-900 text-white shadow-sm' : ''}
    ${buttonVariant === 'success' ? 'bg-emerald-600 text-white shadow-sm' : ''}
    ${buttonVariant === 'danger' ? 'bg-rose-600 text-white shadow-sm' : ''}
  `;

  return (
    <div className="shell-soft-card flex items-center gap-3 px-4 py-3">
      {isConfigured ? (
        <>
          <div className={previewClassName}>
            {buttonIcon} {buttonLabel}
          </div>

          <div className="flex-1 text-xs text-slate-600">
            <div className="flex items-center gap-1">
              <PlayCircle className="h-3 w-3 text-sky-600" />
              <span>已配置动作</span>
            </div>
            {mappingCount > 0 && (
              <div className="mt-0.5 text-slate-500">{mappingCount} 个绑定</div>
            )}
          </div>

          {onConfigure && (
            <button
              onClick={onConfigure}
              className="shell-icon-button rounded-full p-2 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
              title="配置按钮"
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
        </>
      ) : (
        <>
          <span className="flex-1 text-sm italic text-slate-400">未配置动作</span>
          {onConfigure && (
            <button
              onClick={onConfigure}
              className="shell-field-control px-3 py-1.5 text-sm font-medium text-sky-700"
            >
              立即配置
            </button>
          )}
        </>
      )}
    </div>
  );
}
