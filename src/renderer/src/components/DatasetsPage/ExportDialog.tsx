/**
 * ExportDialog - 数据导出对话框（重构版）
 * 允许用户选择导出格式和基本选项
 *
 * 使用增强版DialogV2组件，支持焦点锁定、滚动锁定、ESC关闭等功能
 * 使用 react-hook-form + zod 进行表单管理和验证
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { FileDown, AlertTriangle, Info } from 'lucide-react';
import { DialogV2 } from '../ui/dialog-v2';
import { Button } from '../ui/button';
import type { ExportFormat, ExportOptions } from '@/types/electron';

const EXPORT_FORMAT_OPTIONS = [
  { value: 'csv', label: 'CSV', description: '通用格式' },
  { value: 'xlsx', label: 'Excel', description: 'XLSX 格式' },
  { value: 'txt', label: 'TXT', description: '纯文本' },
  { value: 'json', label: 'JSON', description: '结构化数据' },
  { value: 'parquet', label: 'Parquet', description: '列式存储' },
] as const satisfies ReadonlyArray<{
  value: ExportFormat;
  label: string;
  description: string;
}>;

// Zod 验证 schema
const exportSchema = z.object({
  format: z.enum(['csv', 'xlsx', 'txt', 'json', 'parquet']),
  mode: z.enum(['structure', 'data']),
  respectHiddenColumns: z.boolean(),
  postExportAction: z.enum(['keep', 'delete']),
});

type ExportFormData = z.infer<typeof exportSchema>;

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExport: (options: ExportDialogOptions) => Promise<void>;
  datasetName: string;
  totalRows: number;
  hasHiddenColumns: boolean;
  availableColumns: string[];
  hiddenColumns?: string[];
}

export type ExportDialogOptions = Pick<
  ExportOptions,
  'format' | 'mode' | 'respectHiddenColumns' | 'columns' | 'postExportAction'
>;

export function ExportDialog({
  isOpen,
  onClose,
  onExport,
  datasetName,
  totalRows,
  hasHiddenColumns,
  availableColumns,
  hiddenColumns,
}: ExportDialogProps) {
  // 使用 react-hook-form 管理表单状态
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { isSubmitting },
  } = useForm<ExportFormData>({
    resolver: zodResolver(exportSchema),
    defaultValues: {
      format: 'csv',
      mode: 'data',
      respectHiddenColumns: true,
      postExportAction: 'keep',
    },
  });

  // 监听表单值（用于条件渲染）
  const format = watch('format');
  const mode = watch('mode');
  const respectHiddenColumns = watch('respectHiddenColumns');
  const postExportAction = watch('postExportAction');

  const hiddenColumnsSet = useMemo(() => new Set(hiddenColumns ?? []), [hiddenColumns]);

  // 导出字段选择（默认全选）
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(() => new Set());
  const [lastAvailableColumns, setLastAvailableColumns] = useState<string[]>([]);

  useEffect(() => {
    if (availableColumns.length === 0) return;

    // 首次初始化：默认全选
    if (selectedColumns.size === 0) {
      setSelectedColumns(new Set(availableColumns));
      setLastAvailableColumns(availableColumns);
      return;
    }

    // 数据集/字段变更：尽量保留用户选择，并在“之前全选”的情况下自动选中新字段
    const wasAllSelected =
      lastAvailableColumns.length > 0 && selectedColumns.size === lastAvailableColumns.length;
    const nextSelected = new Set<string>();

    for (const col of availableColumns) {
      if (selectedColumns.has(col) || (wasAllSelected && !selectedColumns.has(col))) {
        // 如果之前是全选，则新字段也默认选中
        if (wasAllSelected) nextSelected.add(col);
        else if (selectedColumns.has(col)) nextSelected.add(col);
      }
    }

    setSelectedColumns(nextSelected);
    setLastAvailableColumns(availableColumns);
  }, [availableColumns]);

  const selectedColumnsInOrder = useMemo(
    () => availableColumns.filter((col) => selectedColumns.has(col)),
    [availableColumns, selectedColumns]
  );

  const effectiveSelectedColumnsInOrder = useMemo(() => {
    if (!respectHiddenColumns) return selectedColumnsInOrder;
    return selectedColumnsInOrder.filter((col) => !hiddenColumnsSet.has(col));
  }, [hiddenColumnsSet, respectHiddenColumns, selectedColumnsInOrder]);

  const isAllSelected =
    selectedColumns.size === availableColumns.length && availableColumns.length > 0;
  const canExportColumns =
    mode !== 'data' || (availableColumns.length > 0 && effectiveSelectedColumnsInOrder.length > 0);

  const toggleColumn = (column: string) => {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  };

  const selectAllColumns = () => setSelectedColumns(new Set(availableColumns));
  const clearAllColumns = () => setSelectedColumns(new Set());
  const resetColumns = () => setSelectedColumns(new Set(availableColumns));

  // 表单提交处理
  const onSubmit = handleSubmit(async (data) => {
    try {
      await onExport({
        format: data.format,
        mode: data.mode,
        respectHiddenColumns: data.respectHiddenColumns,
        columns:
          data.mode === 'data' ? (isAllSelected ? undefined : selectedColumnsInOrder) : undefined,
        postExportAction: data.postExportAction,
      });
      onClose();
    } catch (error) {
      console.error('[ExportDialog] Export failed:', error);
    }
  });

  // 估算导出行数
  const estimatedRows = mode === 'structure' ? 0 : totalRows;
  const willSplitFiles = format === 'xlsx' && estimatedRows > 1_000_000;
  const filesCount = willSplitFiles ? Math.ceil(estimatedRows / 1_000_000) : 1;

  return (
    <DialogV2
      open={isOpen}
      onClose={onClose}
      title="导出数据集"
      maxWidth="2xl"
      closeOnEsc={!isSubmitting}
      closeOnBackdropClick={!isSubmitting}
      disableCloseButton={isSubmitting}
      contentClassName="max-h-[calc(90vh-200px)] overflow-y-auto"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={isSubmitting || !canExportColumns}>
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                <span>导出中...</span>
              </>
            ) : (
              <>
                <FileDown className="w-4 h-4 mr-2" />
                <span>导出</span>
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {/* Dataset Info */}
        <div className="shell-soft-card p-4">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-sky-600" />
            <div className="text-sm">
              <p className="font-medium text-slate-900">数据集：{datasetName}</p>
              <p className="mt-1 text-slate-600">总行数：{totalRows.toLocaleString()}</p>
              {hasHiddenColumns && <p className="text-slate-600">当前有隐藏字段</p>}
            </div>
          </div>
        </div>

        {/* Export Format */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">导出格式</label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {EXPORT_FORMAT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setValue('format', option.value)}
                disabled={isSubmitting}
                className={`rounded-xl border-2 p-3 text-sm font-medium transition-colors disabled:opacity-50 ${
                  format === option.value
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <div className="font-semibold">{option.label}</div>
                <div className="mt-1 text-xs text-gray-500">{option.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Export Mode */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">导出内容</label>
          <div className="space-y-2">
            <label className="shell-soft-card flex cursor-pointer items-center gap-2 p-3 hover:bg-white">
              <input
                type="radio"
                {...register('mode')}
                value="data"
                disabled={isSubmitting}
                className="w-4 h-4"
              />
              <div className="flex-1">
                <div className="font-medium text-sm">表数据</div>
                <div className="text-xs text-gray-500">
                  导出 {totalRows.toLocaleString()} 行数据
                </div>
              </div>
            </label>
            <label className="shell-soft-card flex cursor-pointer items-center gap-2 p-3 hover:bg-white">
              <input
                type="radio"
                {...register('mode')}
                value="structure"
                disabled={isSubmitting}
                className="w-4 h-4"
              />
              <div className="flex-1">
                <div className="font-medium text-sm">仅表结构</div>
                <div className="text-xs text-gray-500">仅导出列名和类型，不含数据</div>
              </div>
            </label>
          </div>
        </div>

        {/* Hidden Columns */}
        {mode === 'data' && hasHiddenColumns && (
          <div>
            <label className="shell-soft-card flex cursor-pointer items-center gap-2 p-3 hover:bg-white">
              <input
                type="checkbox"
                {...register('respectHiddenColumns')}
                disabled={isSubmitting}
                className="w-4 h-4"
              />
              <div className="flex-1">
                <div className="font-medium text-sm">排除隐藏字段</div>
                <div className="text-xs text-gray-500">不导出当前隐藏的字段</div>
              </div>
            </label>
          </div>
        )}

        {/* Export Columns */}
        {mode === 'data' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">导出字段</label>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={selectAllColumns}
                disabled={isSubmitting || availableColumns.length === 0}
              >
                全选
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearAllColumns}
                disabled={isSubmitting || availableColumns.length === 0}
              >
                全不选
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={resetColumns}
                disabled={isSubmitting || availableColumns.length === 0}
              >
                重置
              </Button>
              <div className="text-xs text-gray-500 ml-auto">
                已选 {selectedColumnsInOrder.length}/{availableColumns.length}
                {respectHiddenColumns && hiddenColumnsSet.size > 0 && (
                  <span className="ml-1">
                    （实际导出 {effectiveSelectedColumnsInOrder.length}）
                  </span>
                )}
              </div>
            </div>

            <div className="shell-soft-card max-h-56 overflow-auto">
              {availableColumns.length === 0 ? (
                <div className="p-3 text-sm text-gray-500">暂无可导出的字段</div>
              ) : (
                <div className="p-2 space-y-1">
                  {availableColumns.map((col) => {
                    const isHidden = hiddenColumnsSet.has(col);
                    const disabled =
                      isSubmitting || (respectHiddenColumns && isHidden && hasHiddenColumns);
                    const checked = selectedColumns.has(col);

                    return (
                      <label
                        key={col}
                        className={`flex items-start gap-2 px-2 py-1 rounded hover:bg-gray-50 ${
                          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
                        }`}
                        title={col}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleColumn(col)}
                          className="w-4 h-4 mt-0.5"
                        />
                        <span
                          className={`text-sm leading-5 break-all ${
                            isHidden ? 'text-gray-500' : 'text-gray-900'
                          }`}
                        >
                          {col}
                        </span>
                        {isHidden && (
                          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 shrink-0">
                            隐藏
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {!canExportColumns && (
              <div className="text-xs text-red-600 mt-2">请至少选择 1 个可导出的字段</div>
            )}
          </div>
        )}

        {/* Post Export Action */}
        {mode === 'data' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">导出后操作</label>
            <div className="space-y-2">
              <label className="shell-soft-card flex cursor-pointer items-center gap-2 p-3 hover:bg-white">
                <input
                  type="radio"
                  {...register('postExportAction')}
                  value="keep"
                  disabled={isSubmitting}
                  className="w-4 h-4"
                />
                <div className="flex-1">
                  <div className="font-medium text-sm">保留原数据</div>
                  <div className="text-xs text-gray-500">推荐选项，数据不做任何修改</div>
                </div>
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-[18px] border border-red-200 bg-red-50/65 p-3 hover:bg-red-50">
                <input
                  type="radio"
                  {...register('postExportAction')}
                  value="delete"
                  disabled={isSubmitting}
                  className="w-4 h-4"
                />
                <div className="flex-1">
                  <div className="font-medium text-sm text-red-600">物理删除已导出数据</div>
                  <div className="text-xs text-red-500">危险操作！数据将永久删除，无法恢复</div>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Excel Split Warning */}
        {willSplitFiles && (
          <div className="rounded-[18px] border border-amber-200 bg-amber-50/75 p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-yellow-800">
                <p className="font-medium">大文件拆分提示</p>
                <p className="mt-1">
                  数据量较大（{estimatedRows.toLocaleString()} 行），将自动拆分为{' '}
                  <strong>{filesCount}</strong> 个 Excel 文件（每个文件最多 100 万行）
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Delete Warning */}
        {postExportAction === 'delete' && (
          <div className="rounded-[18px] border border-red-200 bg-red-50/75 p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-red-800">
                <p className="font-medium">危险操作警告</p>
                <p className="mt-1">此操作将永久删除已导出的数据，无法恢复。</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </DialogV2>
  );
}
