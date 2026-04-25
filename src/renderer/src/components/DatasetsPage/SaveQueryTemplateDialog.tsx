/**
 * SaveQueryTemplateDialog - 保存查询模板对话框
 * 允许用户将当前筛选/排序/分组配置保存为查询模板
 */

import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Save, Loader } from 'lucide-react';
import { DialogV2 } from '../ui/dialog-v2';
import { Button } from '../ui/button';
import type { TabInfo } from './DatasetTabs';

const saveQueryTemplateSchema = z.object({
  name: z.string().min(1, '请输入模板名称').max(50, '模板名称不能超过50个字符').trim(),
  icon: z.string().max(2, '图标最多2个字符').optional().or(z.literal('')),
  description: z.string().max(200, '描述不能超过200个字符').optional().or(z.literal('')),
});

type SaveQueryTemplateFormData = z.infer<typeof saveQueryTemplateSchema>;

interface SaveQueryTemplateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, description?: string, icon?: string) => Promise<void>;
  defaultName?: string;
  editingTemplate?: TabInfo | null;
}

export function SaveQueryTemplateDialog({
  isOpen,
  onClose,
  onSave,
  defaultName = '',
  editingTemplate = null,
}: SaveQueryTemplateDialogProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<SaveQueryTemplateFormData>({
    resolver: zodResolver(saveQueryTemplateSchema),
    defaultValues: {
      name: '',
      icon: '',
      description: '',
    },
  });

  useEffect(() => {
    if (editingTemplate) {
      reset({
        name: editingTemplate.name || '',
        icon: editingTemplate.icon || '',
        description: editingTemplate.description || '',
      });
    } else {
      reset({
        name: defaultName,
        icon: '',
        description: '',
      });
    }
  }, [editingTemplate, defaultName, isOpen, reset]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      await onSave(
        data.name.trim(),
        data.description?.trim() || undefined,
        data.icon?.trim() || undefined
      );
      reset();
      onClose();
    } catch (err) {
      console.error('[SaveQueryTemplateDialog] Failed to save query template:', err);
      setError('root', {
        type: 'manual',
        message: err instanceof Error ? err.message : '保存模板失败，请重试',
      });
    }
  });

  const handleClose = () => {
    if (!isSubmitting) {
      reset();
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isSubmitting) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <DialogV2
      open={isOpen}
      onClose={handleClose}
      title={editingTemplate ? '编辑模板' : '保存查询模板'}
      maxWidth="md"
      closeOnEsc={!isSubmitting}
      closeOnBackdropClick={!isSubmitting}
      disableCloseButton={isSubmitting}
      footer={
        <>
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader className="w-4 h-4 animate-spin mr-2" />
                <span>保存中...</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                <span>保存</span>
              </>
            )}
          </Button>
        </>
      }
    >
      <form onKeyDown={handleKeyDown}>
        {errors.root && (
          <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm flex items-start gap-2 mb-4">
            <span className="text-red-600 font-bold">⚠️</span>
            <span>{errors.root.message}</span>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label htmlFor="template-name" className="block text-sm font-medium text-gray-700 mb-1">
              模板名称 <span className="text-red-500">*</span>
            </label>
            <input
              id="template-name"
              type="text"
              {...register('name')}
              placeholder="例如：高价商品、本月新增"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isSubmitting}
              autoFocus
            />
            {errors.name && <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>}
          </div>

          <div>
            <label htmlFor="template-icon" className="block text-sm font-medium text-gray-700 mb-1">
              图标（可选）
            </label>
            <input
              id="template-icon"
              type="text"
              {...register('icon')}
              placeholder="例如：💎、📊、🔥"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isSubmitting}
              maxLength={2}
            />
            <p className="mt-1 text-xs text-gray-500">支持 emoji 图标</p>
            {errors.icon && <p className="mt-1 text-sm text-red-600">{errors.icon.message}</p>}
          </div>

          <div>
            <label htmlFor="template-description" className="block text-sm font-medium text-gray-700 mb-1">
              描述（可选）
            </label>
            <textarea
              id="template-description"
              {...register('description')}
              placeholder="简要描述这个模板的用途"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={3}
              disabled={isSubmitting}
            />
            {errors.description && (
              <p className="mt-1 text-sm text-red-600">{errors.description.message}</p>
            )}
          </div>
        </div>
      </form>
    </DialogV2>
  );
}
