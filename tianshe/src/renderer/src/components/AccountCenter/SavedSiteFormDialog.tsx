/**
 * SavedSiteFormDialog - 平台信息管理弹窗
 *
 * 功能：
 * - 新增/编辑/删除平台
 */

import { useEffect, useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useCloudAuthStore } from '../../stores/cloudAuthStore';
import { DialogV2 } from '../ui/dialog-v2';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Globe, Loader2, Plus, Pencil, Trash2, Check, X, Link2 } from 'lucide-react';
import { toast } from '../../lib/toast';
import { isCloudSyncManagedByAnotherUser } from './accountManagementShared';

interface SavedSiteFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  editSiteId?: string | null;
  onDataChanged?: () => Promise<void> | void;
}

const SITE_ICONS = ['🌐', '🛍', '📦', '🧾', '💼', '🏬', '🎯', '📱', '📷', '🔷'];

function DialogSectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

function getSiteIconButtonClassName(selected: boolean, compact = false) {
  return [
    compact ? 'h-7 w-7 rounded-[10px] text-sm' : 'h-9 w-9 rounded-[12px] text-base',
    'inline-flex items-center justify-center border transition-[background-color,border-color,box-shadow]',
    selected
      ? 'border-primary/30 bg-primary/10 text-slate-900 shadow-sm'
      : 'border-slate-200/70 bg-white/72 hover:border-slate-300/80 hover:bg-white',
  ].join(' ');
}

export function SavedSiteFormDialog({
  open,
  onOpenChange,
  onClose,
  editSiteId,
  onDataChanged,
}: SavedSiteFormDialogProps) {
  const { savedSites, accounts, createSavedSite, updateSavedSite, deleteSavedSite } =
    useAccountStore();
  const currentCloudUserId = useCloudAuthStore((state) => state.session.user?.userId ?? null);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [icon, setIcon] = useState('🌐');

  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingUrl, setEditingUrl] = useState('');
  const [editingIcon, setEditingIcon] = useState('🌐');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingDeleteSite, setPendingDeleteSite] = useState<{
    id: string;
    name: string;
    usageCount: number;
  } | null>(null);

  const getSiteUsageCount = (siteId: string): number => {
    return accounts.filter((a) => a.platformId === siteId).length;
  };

  const isReadOnlySite = (siteId: string): boolean => {
    const site = savedSites.find((item) => item.id === siteId);
    if (!site) return false;
    return isCloudSyncManagedByAnotherUser({
      syncManaged: site.syncManaged,
      syncOwnerUserId: site.syncOwnerUserId,
      currentUserId: currentCloudUserId,
    });
  };

  useEffect(() => {
    if (!open) return;

    setName('');
    setUrl('');
    setIcon('🌐');

    if (editSiteId) {
      const site = savedSites.find((s) => s.id === editSiteId);
      if (site) {
        setEditingSiteId(site.id);
        setEditingName(site.name);
        setEditingUrl(site.url);
        setEditingIcon(site.icon || '🌐');
        return;
      }
    }

    setEditingSiteId(null);
    setEditingName('');
    setEditingUrl('');
    setEditingIcon('🌐');
  }, [open, editSiteId, savedSites]);

  const handleSubmit = async () => {
    if (!name.trim() || !url.trim()) return;

    const existing = savedSites.find((s) => s.name === name.trim());
    if (existing) {
      toast.warning(`平台「${name.trim()}」已存在`);
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await createSavedSite({
        name: name.trim(),
        url: url.trim(),
        icon,
      });
      if (!created) {
        toast.error('新增平台失败，请稍后重试');
        return;
      }
      await onDataChanged?.();
      setName('');
      setUrl('');
      setIcon('🌐');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartEdit = (siteId: string) => {
    if (isReadOnlySite(siteId)) {
      toast.warning('当前云账号不允许编辑这条云端托管平台');
      return;
    }
    const site = savedSites.find((s) => s.id === siteId);
    if (!site) return;
    setEditingSiteId(site.id);
    setEditingName(site.name);
    setEditingUrl(site.url);
    setEditingIcon(site.icon || '🌐');
  };

  const handleCancelEdit = () => {
    setEditingSiteId(null);
    setEditingName('');
    setEditingUrl('');
    setEditingIcon('🌐');
  };

  const handleSaveEdit = async () => {
    if (!editingSiteId || !editingName.trim() || !editingUrl.trim()) {
      handleCancelEdit();
      return;
    }

    const conflict = savedSites.find(
      (s) => s.name === editingName.trim() && s.id !== editingSiteId
    );
    if (conflict) {
      toast.warning(`平台「${editingName.trim()}」已存在`);
      return;
    }

    setIsSubmitting(true);
    try {
      const editingSite = savedSites.find((s) => s.id === editingSiteId);
      const updated = await updateSavedSite(editingSiteId, {
        name: editingName.trim(),
        url: editingUrl.trim(),
        icon: editingIcon,
        ...(editingSite?.syncSourceId ? { syncCanonicalName: editingName.trim() } : {}),
      });
      if (!updated) {
        toast.error('更新平台失败，请稍后重试');
        return;
      }
      await onDataChanged?.();
      handleCancelEdit();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (siteId: string, siteName: string) => {
    if (isReadOnlySite(siteId)) {
      toast.warning('当前云账号不允许删除这条云端托管平台');
      return;
    }
    const usageCount = getSiteUsageCount(siteId);
    if (usageCount > 0) {
      return;
    }
    setPendingDeleteSite({ id: siteId, name: siteName, usageCount });
  };

  const confirmDeleteSite = async () => {
    if (!pendingDeleteSite) return;
    setIsSubmitting(true);
    try {
      const deleted = await deleteSavedSite(pendingDeleteSite.id);
      if (!deleted) {
        toast.error('删除平台失败，请稍后重试');
        return;
      }
      await onDataChanged?.();
      setPendingDeleteSite(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void handleSubmit();
  };

  const handleDialogClose = () => {
    onClose();
    onOpenChange(false);
  };

  const sectionCardClassName = 'shell-soft-card space-y-4 p-4';
  const supportiveBlockClassName = 'rounded-[16px] bg-white/62 p-4';
  const listItemClassName =
    'group rounded-[16px] border border-slate-200/70 bg-white/72 px-3 py-3 transition-[background-color,border-color,box-shadow] hover:bg-white/88';

  return (
    <>
      <DialogV2
        open={open}
        onClose={handleDialogClose}
        title="平台管理"
        maxWidth="3xl"
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

            <div className="space-y-3 rounded-[16px] bg-white/62 p-4">
              <div className="space-y-2">
                <Label className="text-xs font-medium text-slate-600">平台图标</Label>
                <div className="flex flex-wrap gap-2">
                  {SITE_ICONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setIcon(emoji)}
                      disabled={isSubmitting}
                      className={getSiteIconButtonClassName(icon === emoji)}
                      aria-label={`选择图标 ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="saved-site-name" className="text-xs font-medium text-slate-600">
                    平台名称
                  </Label>
                  <Input
                    id="saved-site-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={handleCreateKeyDown}
                    placeholder="例如：淘宝、京东、抖店"
                    disabled={isSubmitting}
                    className="shell-field-input h-10 px-3 py-2 text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="saved-site-url" className="text-xs font-medium text-slate-600">
                    默认 URL
                  </Label>
                  <Input
                    id="saved-site-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={handleCreateKeyDown}
                    placeholder="https://example.com/login"
                    disabled={isSubmitting}
                    className="shell-field-input h-10 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Button
                  onClick={() => void handleSubmit()}
                  disabled={isSubmitting || !name.trim() || !url.trim()}
                  className="h-10 rounded-xl px-4"
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-4 w-4" />
                  )}
                  添加平台
                </Button>
              </div>
            </div>
          </section>

          <section className={sectionCardClassName}>
            <div className="flex items-center justify-between gap-3">
              <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
                共 {savedSites.length} 项
              </span>
            </div>

            {savedSites.length > 0 ? (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {savedSites.map((site) => {
                  const usageCount = getSiteUsageCount(site.id);
                  const isEditing = editingSiteId === site.id;
                  const isReadOnly = isReadOnlySite(site.id);
                  const canDeleteSite = usageCount === 0;

                  return (
                    <div key={site.id} className={listItemClassName}>
                      {isEditing ? (
                        <div className="space-y-3">
                          <div className="flex flex-wrap gap-2">
                            {SITE_ICONS.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => setEditingIcon(emoji)}
                                disabled={isSubmitting}
                                className={getSiteIconButtonClassName(editingIcon === emoji, true)}
                                aria-label={`编辑图标 ${emoji}`}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <Input
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              className="shell-field-input h-10 px-3 py-2 text-sm"
                              disabled={isSubmitting}
                              placeholder="平台名称"
                            />
                            <Input
                              value={editingUrl}
                              onChange={(e) => setEditingUrl(e.target.value)}
                              className="shell-field-input h-10 px-3 py-2 text-sm"
                              disabled={isSubmitting}
                              placeholder="默认 URL"
                            />
                          </div>

                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              className="h-9 rounded-xl border-slate-200/80 bg-white/90 px-3 shadow-none"
                              onClick={handleCancelEdit}
                              disabled={isSubmitting}
                            >
                              <X className="mr-1 h-4 w-4" />
                              取消
                            </Button>
                            <Button
                              className="h-9 rounded-xl px-3"
                              onClick={() => void handleSaveEdit()}
                              disabled={isSubmitting}
                            >
                              <Check className="mr-1 h-4 w-4" />
                              保存
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-3">
                          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[14px] bg-white/92 text-lg shadow-sm">
                            {site.icon || '🌐'}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-slate-900">
                                {site.name}
                              </span>
                              <span className="shell-field-chip shell-field-chip--ghost px-2.5 py-1 text-[11px]">
                                {usageCount} 个账号
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                              <Link2 className="h-3.5 w-3.5 flex-shrink-0" />
                              <span className="truncate">{site.url}</span>
                            </div>
                            {isReadOnly ? (
                              <div className="mt-2 text-xs text-slate-500">
                                该平台由其他云账号托管，当前仅可查看。
                              </div>
                            ) : null}
                            {!canDeleteSite ? (
                              <div className="mt-2 text-xs text-amber-700">
                                当前仍有账号引用该平台，请先处理关联账号。
                              </div>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-full"
                              onClick={() => handleStartEdit(site.id)}
                              disabled={isSubmitting || isReadOnly}
                              title={isReadOnly ? '当前云账号不可编辑该平台' : '编辑平台'}
                              aria-label={`编辑平台 ${site.name}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-full text-destructive hover:text-destructive"
                              onClick={() => void handleDelete(site.id, site.name)}
                              disabled={isSubmitting || isReadOnly || !canDeleteSite}
                              title={
                                isReadOnly
                                  ? '当前云账号不可删除该平台'
                                  : canDeleteSite
                                    ? '删除平台'
                                    : '请先处理引用该平台的账号'
                              }
                              aria-label={`删除平台 ${site.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-40 flex-col items-center justify-center rounded-[16px] bg-white/62 text-center text-sm text-slate-500">
                <Globe className="mb-3 h-6 w-6 text-slate-400" />
                暂无平台，请先在上方创建一个平台。
              </div>
            )}
          </section>
        </div>
      </DialogV2>

      <ConfirmDialog
        open={pendingDeleteSite !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setPendingDeleteSite(null);
          }
        }}
        title="删除平台"
        description={
          pendingDeleteSite
            ? pendingDeleteSite.usageCount > 0
              ? `确定删除平台「${pendingDeleteSite.name}」吗？当前有 ${pendingDeleteSite.usageCount} 个账号使用该平台。`
              : `确定删除平台「${pendingDeleteSite.name}」吗？`
            : ''
        }
        confirmText="删除"
        cancelText="取消"
        variant="danger"
        loading={isSubmitting}
        onConfirm={() => void confirmDeleteSite()}
      />
    </>
  );
}
