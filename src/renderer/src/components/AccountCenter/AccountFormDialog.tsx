import { Globe, Sparkles } from 'lucide-react';
import type { BrowserProfile, SavedSite } from '../../../../types/profile';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { DialogV2 } from '../ui/dialog-v2';
import { cn } from '../../lib/utils';
import type { AccountFormState, RecommendedProfileSource } from './accountManagementShared';

interface AccountFormDialogProps {
  open: boolean;
  editingAccountId: string | null;
  accountForm: AccountFormState;
  submittingAccount: boolean;
  savedSites: SavedSite[];
  profiles: BrowserProfile[];
  platformById: Map<string, SavedSite>;
  profileNameById: Map<string, string>;
  recommendedProfileName: string | null;
  recommendedProfileSource: RecommendedProfileSource;
  totalProfileCount: number;
  suggestedAutoProfileName: string;
  onClose: () => void;
  onSubmit: () => void;
  onOpenPlatformDialog: () => void;
  onPlatformChange: (platformId: string) => void;
  onProfileBindingModeChange: (mode: 'select' | 'auto-create') => void;
  onChangeForm: (patch: Partial<AccountFormState>) => void;
  onPasswordChange: (value: string) => void;
}

function DialogSectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

function getBindingModeCardClassName(selected: boolean) {
  return cn(
    'rounded-[18px] border px-4 py-4 text-left transition-[background-color,border-color,box-shadow]',
    selected
      ? 'border-primary/30 bg-primary/[0.045] shadow-[0_12px_24px_rgba(37,99,235,0.08)]'
      : 'border-slate-200/70 bg-white/60 hover:bg-white/82 hover:shadow-[0_10px_22px_rgba(20,27,45,0.06)]'
  );
}

export function AccountFormDialog({
  open,
  editingAccountId,
  accountForm,
  submittingAccount,
  savedSites,
  profiles,
  platformById,
  profileNameById,
  recommendedProfileName,
  recommendedProfileSource,
  totalProfileCount,
  suggestedAutoProfileName,
  onClose,
  onSubmit,
  onOpenPlatformDialog,
  onPlatformChange,
  onProfileBindingModeChange,
  onChangeForm,
  onPasswordChange,
}: AccountFormDialogProps) {
  const selectedPlatformName = accountForm.platformId
    ? platformById.get(accountForm.platformId)?.name || null
    : null;
  const selectedProfileName = accountForm.profileId && profileNameById.get(accountForm.profileId);
  const canAutoCreateProfile =
    !editingAccountId && accountForm.profileBindingMode === 'auto-create';
  const hasSelectableProfiles = profiles.length > 0;
  const profileRecommendationText = !accountForm.platformId
    ? totalProfileCount > 0
      ? '先选择平台。系统会优先复用未绑定所选平台账号的环境，只有现有环境全部占用时才自动创建。'
      : '当前还没有浏览器环境，选择平台后会默认自动创建一个新环境。'
    : recommendedProfileSource === 'available-profile' && recommendedProfileName
      ? `已默认选中可复用环境「${recommendedProfileName}」，该环境下目前没有${selectedPlatformName ? `「${selectedPlatformName}」` : '当前'}平台账号。`
      : totalProfileCount > 0
        ? `当前所有现有环境都已绑定${selectedPlatformName ? `「${selectedPlatformName}」` : '该'}平台账号，系统已自动切换为创建新环境。`
        : '当前还没有浏览器环境，系统会在保存账号时自动创建一个新环境。';
  const controlClassName = 'shell-field-input h-10 px-3 py-2 text-sm';
  const textAreaClassName = 'shell-field-input min-h-[112px] resize-y px-3 py-2 text-sm';
  const supportBlockClassName =
    'rounded-[16px] bg-slate-50/84 p-3 text-xs leading-5 text-slate-500';

  return (
    <DialogV2
      open={open}
      onClose={onClose}
      title={editingAccountId ? '编辑账号' : '新建账号'}
      maxWidth="5xl"
      closeOnEsc={!submittingAccount}
      closeOnBackdropClick={!submittingAccount}
      disableCloseButton={submittingAccount}
      className="shell-drawer-surface mx-0 ml-auto mr-0 mt-[var(--app-titlebar-height)] flex h-[calc(100dvh-var(--app-titlebar-height))] max-h-[calc(100dvh-var(--app-titlebar-height))] max-w-[780px] self-start flex-col rounded-none border-y-0 border-r-0"
      contentClassName="shell-content-muted flex-1 overflow-y-auto p-4"
      footer={
        <>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={submittingAccount}
            className="h-10 rounded-xl border-slate-200/80 bg-white/90 shadow-none hover:bg-white"
          >
            取消
          </Button>
          <Button onClick={onSubmit} disabled={submittingAccount} className="h-10 rounded-xl">
            {submittingAccount ? '保存中...' : '保存账号'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">

        <section className="shell-soft-card space-y-4 p-4">

          <div className="space-y-2">
            <Label className="text-xs font-medium text-slate-600">平台</Label>
            <div className="flex gap-2">
              <Select
                value={accountForm.platformId}
                onValueChange={onPlatformChange}
                className={cn(controlClassName, 'flex-1')}
              >
                <option value="">请选择平台</option>
                {savedSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                onClick={onOpenPlatformDialog}
                className="h-10 shrink-0 rounded-xl border-slate-200/80 bg-white/90 px-4 shadow-none hover:bg-white"
              >
                新建平台
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-600">名称</Label>
              <Input
                value={accountForm.displayName}
                onChange={(e) => onChangeForm({ displayName: e.target.value })}
                placeholder="请输入账号名称"
                className={controlClassName}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-600">用户账号</Label>
              <Input
                value={accountForm.accountName}
                onChange={(e) => onChangeForm({ accountName: e.target.value })}
                placeholder="请输入用户账号"
                className={controlClassName}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-600">用户密码</Label>
              <Input
                type="password"
                value={accountForm.password}
                onChange={(e) => onPasswordChange(e.target.value)}
                placeholder="请输入用户密码"
                className={controlClassName}
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label className="text-xs font-medium text-slate-600">登录 URL</Label>
              <Input
                value={accountForm.tabUrl}
                onChange={(e) => onChangeForm({ tabUrl: e.target.value })}
                placeholder="https://example.com/login"
                className={controlClassName}
              />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),240px]">
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-600">备注</Label>
              <textarea
                value={accountForm.notes}
                onChange={(e) => onChangeForm({ notes: e.target.value })}
                placeholder="记录登录约束、用途、负责人等说明"
                rows={4}
                className={textAreaClassName}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-600">标签（逗号分隔）</Label>
              <Input
                value={accountForm.tagsText}
                onChange={(e) => onChangeForm({ tagsText: e.target.value })}
                placeholder="电商, 主号, 运营"
                className={controlClassName}
              />
              <div className={supportBlockClassName}>标签会用于账号筛选和同步后的本地分组。</div>
            </div>
          </div>
        </section>

        <section className="shell-soft-card space-y-4 p-4">
          <div className="space-y-4">
            <DialogSectionHeader
              title="浏览器环境"
              description="环境放在最后确认。系统会优先复用未绑定当前平台账号的环境，只有全部占用时才默认自动创建。"
            />

            <div className="flex items-start gap-3 rounded-[16px] bg-white/62 p-4">
              <div className="rounded-[14px] bg-white p-2 text-slate-700 shadow-sm">
                {canAutoCreateProfile ? (
                  <Sparkles className="h-5 w-5" />
                ) : (
                  <Globe className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium text-slate-900">账号浏览器环境</div>
                <p className="text-xs leading-5 text-slate-500">{profileRecommendationText}</p>
              </div>
            </div>

            {!editingAccountId && (
              <div className="grid gap-3 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => onProfileBindingModeChange('select')}
                  className={getBindingModeCardClassName(
                    accountForm.profileBindingMode === 'select'
                  )}
                >
                  <div className="text-sm font-medium text-slate-900">复用已有环境</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    只展示当前平台可复用的环境；如果现有环境都已占用，会自动切到创建新环境。
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onProfileBindingModeChange('auto-create')}
                  className={getBindingModeCardClassName(
                    accountForm.profileBindingMode === 'auto-create'
                  )}
                >
                  <div className="text-sm font-medium text-slate-900">自动创建环境</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    保存账号时自动创建一个 Extension 引擎环境，并立即完成绑定。
                  </p>
                </button>
              </div>
            )}

            <div className="space-y-2">
              {!canAutoCreateProfile ? (
                <>
                  <Label className="text-xs font-medium text-slate-600">选择浏览器环境</Label>
                  <Select
                    value={accountForm.profileId}
                    onValueChange={(value) => onChangeForm({ profileId: value })}
                    className={controlClassName}
                  >
                    <option value="">请选择账号浏览器环境</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs leading-5 text-slate-500">
                    {selectedProfileName
                      ? `当前账号环境：${selectedProfileName}`
                      : hasSelectableProfiles
                        ? editingAccountId
                          ? '请选择一个环境，保存后会使用该环境启动登录。'
                          : '只展示当前平台还未绑定的环境，后续登录会直接使用该环境启动。'
                        : '现有环境都已绑定该平台账号，请切换到自动创建环境。'}
                  </p>
                </>
              ) : (
                <>
                  <Label className="text-xs font-medium text-slate-600">自动创建环境名称</Label>
                  <Input
                    value={accountForm.autoProfileName}
                    onChange={(e) => onChangeForm({ autoProfileName: e.target.value })}
                    placeholder={suggestedAutoProfileName}
                    className={controlClassName}
                  />
                  <p className="text-xs leading-5 text-slate-500">
                    默认名称：{suggestedAutoProfileName}。保存时会按 Extension 引擎创建。
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </DialogV2>
  );
}
