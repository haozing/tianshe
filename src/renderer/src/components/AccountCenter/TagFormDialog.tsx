/**
 * TagFormDialog - 标签管理弹窗
 *
 * 功能：
 * - 创建新标签（保存到独立的 tags 表）
 * - 编辑现有标签（重命名）
 * - 删除标签（同时从所有账号中移除）
 */

import { useState, useEffect } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useCloudAuthStore } from '../../stores/cloudAuthStore';
import { DialogV2 } from '../ui/dialog-v2';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Tag, Loader2, Check, Pencil, Trash2, X, Plus } from 'lucide-react';
import { TAG_COLORS } from '../../../../constants/ui';
import { toast } from '../../lib/toast';
import { isCloudSyncManagedByAnotherUser } from './accountManagementShared';

interface TagFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  /** 预选编辑的标签 ID */
  editTagId?: string | null;
  onDataChanged?: () => Promise<void> | void;
}

function DialogSectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

export function TagFormDialog({
  open,
  onOpenChange,
  onClose,
  editTagId,
  onDataChanged,
}: TagFormDialogProps) {
  const { tags, accounts, createTag, updateTag, deleteTag } = useAccountStore();
  const currentCloudUserId = useCloudAuthStore((state) => state.session.user?.userId ?? null);

  // 表单状态
  const [tagName, setTagName] = useState('');

  // 编辑状态
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingDeleteTag, setPendingDeleteTag] = useState<{
    id: string;
    name: string;
    usageCount: number;
  } | null>(null);

  // 获取每个标签的使用数量
  const getTagUsageCount = (name: string): number => {
    return accounts.filter((a) => (a.tags || []).includes(name)).length;
  };

  const isReadOnlyTag = (tagId: string): boolean => {
    const tag = tags.find((item) => item.id === tagId);
    if (!tag) return false;
    return isCloudSyncManagedByAnotherUser({
      syncManaged: tag.syncManaged,
      syncOwnerUserId: tag.syncOwnerUserId,
      currentUserId: currentCloudUserId,
    });
  };

  // 打开时重置表单，或根据 editTagId 预选编辑项
  useEffect(() => {
    if (open) {
      setTagName('');

      // 如果传入了 editTagId，自动开始编辑该标签
      if (editTagId) {
        const tag = tags.find((t) => t.id === editTagId);
        if (tag) {
          setEditingTagId(editTagId);
          setEditingTagName(tag.name);
          return;
        }
      }

      setEditingTagId(null);
      setEditingTagName('');
    }
  }, [open, editTagId, tags]);

  // 提交表单（创建新标签）
  const handleSubmit = async () => {
    if (!tagName.trim()) {
      return;
    }

    // 检查标签名是否已存在
    const existingTag = tags.find((t) => t.name === tagName.trim());
    if (existingTag) {
      toast.warning(`标签「${tagName.trim()}」已存在`);
      return;
    }

    setIsSubmitting(true);

    try {
      const created = await createTag({ name: tagName.trim() });
      if (!created) {
        return;
      }
      await onDataChanged?.();
      setTagName('');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 删除标签
  const handleDeleteTag = async (tagId: string, tagNameToDelete: string) => {
    if (isReadOnlyTag(tagId)) {
      toast.warning('当前云账号不允许删除这条云端托管标签');
      return;
    }
    const usageCount = getTagUsageCount(tagNameToDelete);
    setPendingDeleteTag({
      id: tagId,
      name: tagNameToDelete,
      usageCount,
    });
  };

  const confirmDeleteTag = async () => {
    if (!pendingDeleteTag) return;

    setIsSubmitting(true);

    try {
      const deleted = await deleteTag(pendingDeleteTag.id);
      if (!deleted) {
        return;
      }
      await onDataChanged?.();
      setPendingDeleteTag(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 开始编辑标签
  const handleStartEditTag = (tagId: string, name: string) => {
    if (isReadOnlyTag(tagId)) {
      toast.warning('当前云账号不允许编辑这条云端托管标签');
      return;
    }
    setEditingTagId(tagId);
    setEditingTagName(name);
  };

  // 取消编辑标签
  const handleCancelEditTag = () => {
    setEditingTagId(null);
    setEditingTagName('');
  };

  // 保存编辑标签（重命名）
  const handleSaveEditTag = async () => {
    if (!editingTagId || !editingTagName.trim()) {
      handleCancelEditTag();
      return;
    }

    const editingTag = tags.find((t) => t.id === editingTagId);
    if (!editingTag || editingTag.name === editingTagName.trim()) {
      handleCancelEditTag();
      return;
    }

    const newName = editingTagName.trim();
    // 检查新标签名是否已存在
    const existingTag = tags.find((t) => t.name === newName && t.id !== editingTagId);
    if (existingTag) {
      toast.warning(`标签「${newName}」已存在`);
      return;
    }

    setIsSubmitting(true);

    try {
      const updated = await updateTag(editingTagId, { name: newName });
      if (!updated) {
        return;
      }
      await onDataChanged?.();
      handleCancelEditTag();
    } finally {
      setIsSubmitting(false);
    }
  };

  // 处理编辑标签的键盘事件
  const handleEditTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEditTag();
    } else if (e.key === 'Escape') {
      handleCancelEditTag();
    }
  };

  // 处理创建标签的键盘事件
  const handleCreateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleDialogClose = () => {
    onClose();
    onOpenChange(false);
  };

  const sectionCardClassName = 'shell-soft-card space-y-4 p-4';
  const listItemClassName =
    'group flex items-center gap-3 rounded-[16px] border border-slate-200/70 bg-white/72 px-3 py-3 transition-[background-color,border-color,box-shadow] hover:bg-white/88';

  return (
    <>
      <DialogV2
        open={open}
        onClose={handleDialogClose}
        title="标签管理"
        maxWidth="md"
        contentClassName="shell-content-muted flex-1 overflow-y-auto p-4"
        footer={
          <Button
            variant="outline"
            onClick={handleDialogClose}
            disabled={isSubmitting}
            className="h-10 rounded-xl border-slate-200/80 bg-white/90 shadow-none hover:bg-white"
          >
            关闭
          </Button>
        }
      >
        <div className="space-y-4">
          <section className={sectionCardClassName}>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[16px] bg-white/62 px-4 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
                  当前标签数
                </div>
                <div className="mt-1 text-sm text-slate-900">{tags.length} 个标签</div>
              </div>
            </div>
          </section>

          <section className={sectionCardClassName}>
            <div className="space-y-3 rounded-[16px] bg-white/62 p-4">
              <div className="flex items-center gap-2">
                <Input
                  id="tagName"
                  value={tagName}
                  onChange={(e) => setTagName(e.target.value)}
                  onKeyDown={handleCreateKeyDown}
                  placeholder="例如：主号、代运营、店铺"
                  disabled={isSubmitting}
                  className="shell-field-input h-10 flex-1 px-3 py-2 text-sm"
                />
                <Button
                  onClick={handleSubmit}
                  disabled={isSubmitting || !tagName.trim()}
                  className="h-10 rounded-xl px-4"
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-4 w-4" />
                  )}
                  添加标签
                </Button>
              </div>
            </div>
          </section>

          <section className={sectionCardClassName}>
            <div className="flex items-center justify-between gap-3">
              <DialogSectionHeader
                title="现有标签"
                description="查看已有标签、使用情况，并支持原地重命名或删除。"
              />
              <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
                共 {tags.length} 项
              </span>
            </div>

            {tags.length > 0 ? (
              <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                {tags.map((tag, index) => {
                  const usageCount = getTagUsageCount(tag.name);
                  const isReadOnly = isReadOnlyTag(tag.id);
                  return (
                    <div key={tag.id} className={listItemClassName}>
                      {editingTagId === tag.id ? (
                        <>
                          <Input
                            value={editingTagName}
                            onChange={(e) => setEditingTagName(e.target.value)}
                            onKeyDown={handleEditTagKeyDown}
                            className="shell-field-input h-10 flex-1 px-3 py-2 text-sm"
                            autoFocus
                            disabled={isSubmitting}
                          />
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 rounded-full border-slate-200/80 bg-white/90 shadow-none"
                              onClick={handleSaveEditTag}
                              disabled={isSubmitting}
                              aria-label={`保存标签 ${tag.name}`}
                            >
                              <Check className="h-4 w-4 text-green-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 rounded-full"
                              onClick={handleCancelEditTag}
                              disabled={isSubmitting}
                              aria-label={`取消编辑标签 ${tag.name}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span
                            className="inline-flex rounded-full px-2.5 py-1 text-xs font-medium"
                            style={{
                              backgroundColor: `${TAG_COLORS[index % TAG_COLORS.length]}20`,
                              color: TAG_COLORS[index % TAG_COLORS.length],
                            }}
                          >
                            {tag.name}
                          </span>
                          <span className="flex-1 text-xs text-slate-500">{usageCount} 个账号</span>
                          {isReadOnly ? (
                            <span className="text-xs text-slate-500">当前仅可查看</span>
                          ) : null}
                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-full"
                              onClick={() => handleStartEditTag(tag.id, tag.name)}
                              disabled={isSubmitting || isReadOnly}
                              title={isReadOnly ? '当前云账号不可编辑该标签' : '重命名标签'}
                              aria-label={`重命名标签 ${tag.name}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-full text-destructive hover:text-destructive"
                              onClick={() => handleDeleteTag(tag.id, tag.name)}
                              disabled={isSubmitting || isReadOnly}
                              title={isReadOnly ? '当前云账号不可删除该标签' : '删除标签'}
                              aria-label={`删除标签 ${tag.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-36 flex-col items-center justify-center rounded-[16px] bg-white/62 text-center text-sm text-slate-500">
                <Tag className="mb-3 h-6 w-6 text-slate-400" />
                暂无标签，在上方输入名称创建第一个标签。
              </div>
            )}
          </section>
        </div>
      </DialogV2>

      <ConfirmDialog
        open={pendingDeleteTag !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setPendingDeleteTag(null);
          }
        }}
        title="删除标签"
        description={
          pendingDeleteTag
            ? pendingDeleteTag.usageCount > 0
              ? `确定删除标签「${pendingDeleteTag.name}」吗？将从 ${pendingDeleteTag.usageCount} 个账号中移除此标签。`
              : `确定删除标签「${pendingDeleteTag.name}」吗？`
            : ''
        }
        confirmText="删除"
        cancelText="取消"
        variant="danger"
        loading={isSubmitting}
        onConfirm={() => void confirmDeleteTag()}
      />
    </>
  );
}
