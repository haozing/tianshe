import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Account,
  BrowserProfile,
  SavedSite,
  UpdateAccountParams,
} from '../../../../types/profile';
import { useAccountStore } from '../../stores/accountStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SavedSiteFormDialog } from './SavedSiteFormDialog';
import { TagFormDialog } from './TagFormDialog';
import { AccountCategorySidebar } from './AccountCategorySidebar';
import { AccountFormDialog } from './AccountFormDialog';
import { AccountTable } from './AccountTable';
import { ListFilter, Loader2, MoreHorizontal, Tag, Globe } from 'lucide-react';
import { toast } from '../../lib/toast';
import { useCloudAuthStore } from '../../stores/cloudAuthStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  type AccountFormState,
  INITIAL_FORM_STATE,
  buildSuggestedAutoProfileName,
  getRecommendedProfileBinding,
  getReusableProfileIdsForPlatform,
  normalizeTags,
  normalizeBoundProfileId,
  isAccountReadOnlyForCloudUser,
} from './accountManagementShared';

interface AccountManagementPanelProps {
  createRequestId?: string | null;
  profiles: BrowserProfile[];
  onOwnedBundleChanged: () => Promise<void> | void;
  onProfileDataChanged: () => Promise<void> | void;
}

export function AccountManagementPanel({
  createRequestId,
  profiles,
  onOwnedBundleChanged,
  onProfileDataChanged,
}: AccountManagementPanelProps) {
  const {
    accounts,
    savedSites,
    categoryMode,
    selectedCategoryId,
    loading,
    error,
    createAccount,
    createAccountWithAutoProfile,
    updateAccount,
    deleteAccount,
    revealAccountSecret,
    loginAccount,
    setCategoryMode,
    selectCategory,
    getCategoriesBySite,
    getCategoriesByTag,
    getFilteredAccounts,
    clearError,
  } = useAccountStore();
  const currentCloudUserId = useCloudAuthStore((state) => state.session.user?.userId ?? null);

  const [keyword, setKeyword] = useState('');
  const [isAccountDialogOpen, setIsAccountDialogOpen] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [accountForm, setAccountForm] = useState<AccountFormState>(INITIAL_FORM_STATE);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [submittingAccount, setSubmittingAccount] = useState(false);
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string | null>>({});
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});
  const [pendingDeleteAccount, setPendingDeleteAccount] = useState<Account | null>(null);
  const handledCreateRequestIdRef = useRef<string | null>(null);

  const [isPlatformDialogOpen, setIsPlatformDialogOpen] = useState(false);
  const [isTagDialogOpen, setIsTagDialogOpen] = useState(false);

  const profileNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of profiles) {
      map.set(profile.id, profile.name);
    }
    return map;
  }, [profiles]);

  const platformById = useMemo(() => {
    const map = new Map<string, SavedSite>();
    for (const site of savedSites) {
      map.set(site.id, site);
    }
    return map;
  }, [savedSites]);
  const selectedPlatform = accountForm.platformId
    ? platformById.get(accountForm.platformId)
    : undefined;
  const recommendedProfileBinding = useMemo(
    () =>
      getRecommendedProfileBinding({
        platformId: accountForm.platformId,
        accounts,
        profiles,
        preferredProfileId: accountForm.profileId,
        excludeAccountId: editingAccountId,
      }),
    [accountForm.platformId, accountForm.profileId, accounts, editingAccountId, profiles]
  );
  const recommendedProfileName =
    recommendedProfileBinding.profileId.length > 0
      ? profileNameById.get(recommendedProfileBinding.profileId) || null
      : null;
  const reusableProfileIds = useMemo(
    () =>
      getReusableProfileIdsForPlatform({
        platformId: accountForm.platformId,
        accounts,
        profiles,
        excludeAccountId: editingAccountId,
      }),
    [accountForm.platformId, accounts, editingAccountId, profiles]
  );
  const selectableProfiles = useMemo(() => {
    if (editingAccountId) {
      return profiles;
    }

    if (!accountForm.platformId) {
      return profiles;
    }

    const reusableProfileIdSet = new Set(reusableProfileIds);
    return profiles.filter((profile) => reusableProfileIdSet.has(profile.id));
  }, [accountForm.platformId, editingAccountId, profiles, reusableProfileIds]);
  const suggestedAutoProfileName = buildSuggestedAutoProfileName(
    selectedPlatform?.name,
    accountForm.displayName,
    accountForm.accountName
  );

  const currentCategories = categoryMode === 'tag' ? getCategoriesByTag() : getCategoriesBySite();
  const selectedCategory = currentCategories.find((item) => item.id === selectedCategoryId) || null;
  const baseFilteredAccounts = getFilteredAccounts();
  const keywordValue = keyword.trim().toLowerCase();
  const filteredAccounts = keywordValue
    ? baseFilteredAccounts.filter((account) => {
        const platformName =
          (account.platformId ? platformById.get(account.platformId)?.name : undefined) || '';
        const haystacks = [
          account.displayName || '',
          account.name,
          platformName,
          account.loginUrl,
          account.notes || '',
          (account.tags || []).join(','),
        ];
        return haystacks.some((text) => text.toLowerCase().includes(keywordValue));
      })
    : baseFilteredAccounts;
  const filterSummary = selectedCategory
    ? `${categoryMode === 'tag' ? '标签' : '平台'}：${selectedCategory.name}`
    : '全部账号';

  useEffect(() => {
    if (selectedCategoryId === null) return;
    const exists = currentCategories.some((item) => item.id === selectedCategoryId);
    if (!exists) {
      selectCategory(null);
    }
  }, [currentCategories, selectedCategoryId, selectCategory]);

  const resetAccountForm = () => {
    setEditingAccountId(null);
    setAccountForm(INITIAL_FORM_STATE);
    setPasswordTouched(false);
  };

  const openCreateAccount = () => {
    setEditingAccountId(null);
    const recommendation = getRecommendedProfileBinding({
      platformId: '',
      accounts,
      profiles,
    });
    setAccountForm({
      ...INITIAL_FORM_STATE,
      profileId: recommendation.profileId,
      profileBindingMode: recommendation.mode,
    });
    setPasswordTouched(false);
    setIsAccountDialogOpen(true);
  };

  useEffect(() => {
    if (!createRequestId || handledCreateRequestIdRef.current === createRequestId) {
      return;
    }
    handledCreateRequestIdRef.current = createRequestId;
    openCreateAccount();
  }, [createRequestId]);

  const openEditAccount = (account: Account) => {
    if (isAccountReadOnlyForCloudUser(account, currentCloudUserId)) {
      toast.warning('当前账号不允许编辑这条云端托管记录');
      return;
    }
    setEditingAccountId(account.id);
    const platform = account.platformId ? platformById.get(account.platformId) : undefined;

    setAccountForm({
      platformId: platform?.id || '',
      profileId: normalizeBoundProfileId(account.profileId),
      profileBindingMode: 'select',
      autoProfileName: '',
      displayName: account.displayName || '',
      accountName: account.name,
      password: '',
      tabUrl: account.loginUrl,
      tagsText: (account.tags || []).join(', '),
      notes: account.notes || '',
    });
    setPasswordTouched(false);
    setIsAccountDialogOpen(true);
  };

  const closeAccountDialog = () => {
    setIsAccountDialogOpen(false);
    resetAccountForm();
  };

  const handleChangeForm = (patch: Partial<AccountFormState>) => {
    setAccountForm((prev) => ({ ...prev, ...patch }));
  };

  const handlePlatformChange = (platformId: string) => {
    const platform = platformById.get(platformId);
    setAccountForm((prev) => {
      const nextTabUrl = platform?.url || '';
      if (editingAccountId) {
        return {
          ...prev,
          platformId,
          tabUrl: nextTabUrl,
        };
      }

      const recommendation = getRecommendedProfileBinding({
        platformId,
        accounts,
        profiles,
        preferredProfileId: prev.profileId,
      });

      return {
        ...prev,
        platformId,
        tabUrl: nextTabUrl,
        profileBindingMode: recommendation.mode,
        profileId: recommendation.profileId,
        autoProfileName: '',
      };
    });
  };

  const handleProfileBindingModeChange = (mode: 'select' | 'auto-create') => {
    setAccountForm((prev) => {
      if (mode === 'select') {
        const recommendation = getRecommendedProfileBinding({
          platformId: prev.platformId,
          accounts,
          profiles,
          preferredProfileId: prev.profileId,
          excludeAccountId: editingAccountId,
        });
        return {
          ...prev,
          profileBindingMode: recommendation.mode,
          profileId: recommendation.profileId,
          autoProfileName: '',
        };
      }

      return {
        ...prev,
        profileBindingMode: 'auto-create',
        profileId: '',
        autoProfileName: '',
      };
    });
  };

  const canAutoCreateProfile =
    !editingAccountId && accountForm.profileBindingMode === 'auto-create';

  const handleSubmitAccount = async () => {
    if (!accountForm.platformId) {
      toast.warning('请选择平台');
      return;
    }
    const trimmedDisplayName = accountForm.displayName.trim();
    if (!trimmedDisplayName) {
      toast.warning('请输入名称');
      return;
    }
    const trimmedAccountName = accountForm.accountName.trim();
    if (!trimmedAccountName) {
      toast.warning('请输入用户账号');
      return;
    }
    if (!accountForm.tabUrl.trim()) {
      toast.warning('请输入登录 URL');
      return;
    }

    const platform = platformById.get(accountForm.platformId);
    if (!platform) {
      toast.error('所选平台不存在，请刷新后重试');
      return;
    }

    const tagsArray = normalizeTags(accountForm.tagsText);

    setSubmittingAccount(true);
    try {
      let effectiveProfileId = accountForm.profileId.trim();
      if (canAutoCreateProfile) {
        const newProfileName = accountForm.autoProfileName.trim() || suggestedAutoProfileName;
        const created = await createAccountWithAutoProfile({
          profile: {
            name: newProfileName,
            engine: 'extension',
            notes: `账号 ${trimmedDisplayName} 自动创建`,
          },
          account: {
            platformId: platform.id,
            displayName: trimmedDisplayName,
            name: trimmedAccountName,
            password: accountForm.password.length > 0 ? accountForm.password : null,
            loginUrl: accountForm.tabUrl.trim(),
            tags: tagsArray,
            notes: accountForm.notes.trim() || null,
          },
        });
        if (!created) {
          toast.error('自动创建 Extension 环境失败，请重试');
          return;
        }
        effectiveProfileId = created.profileId;
        await onProfileDataChanged();
        await onOwnedBundleChanged();
        closeAccountDialog();
        return;
      }

      if (!effectiveProfileId) {
        toast.warning('请选择账号浏览器环境');
        return;
      }

      if (!editingAccountId) {
        const reusableProfileIdSet = new Set(
          getReusableProfileIdsForPlatform({
            platformId: platform.id,
            accounts,
            profiles,
          })
        );
        if (!reusableProfileIdSet.has(effectiveProfileId)) {
          const nextRecommendation = getRecommendedProfileBinding({
            platformId: platform.id,
            accounts,
            profiles,
            preferredProfileId: effectiveProfileId,
          });
          setAccountForm((prev) => ({
            ...prev,
            profileBindingMode: nextRecommendation.mode,
            profileId: nextRecommendation.profileId,
            autoProfileName: nextRecommendation.mode === 'auto-create' ? prev.autoProfileName : '',
          }));
          toast.warning(
            nextRecommendation.mode === 'select'
              ? '所选环境已绑定该平台账号，已切换到下一个可复用环境'
              : '当前所有环境都已绑定该平台账号，请使用自动创建环境'
          );
          return;
        }
      }

      if (editingAccountId) {
        const updatePayload: UpdateAccountParams = {
          profileId: effectiveProfileId,
          platformId: platform.id,
          displayName: trimmedDisplayName,
          name: trimmedAccountName,
          loginUrl: accountForm.tabUrl.trim(),
          tags: tagsArray,
          notes: accountForm.notes.trim() || null,
        };
        if (passwordTouched) {
          updatePayload.password = accountForm.password.length > 0 ? accountForm.password : null;
        }
        const updated = await updateAccount(editingAccountId, updatePayload);
        if (!updated) return;
      } else {
        const created = await createAccount({
          profileId: effectiveProfileId,
          platformId: platform.id,
          displayName: trimmedDisplayName,
          name: trimmedAccountName,
          password: accountForm.password.length > 0 ? accountForm.password : null,
          loginUrl: accountForm.tabUrl.trim(),
          tags: tagsArray,
          notes: accountForm.notes.trim() || null,
        });
        if (!created) return;
      }

      await onOwnedBundleChanged();
      closeAccountDialog();
    } finally {
      setSubmittingAccount(false);
    }
  };

  const handleDeleteAccount = async (account: Account) => {
    if (isAccountReadOnlyForCloudUser(account, currentCloudUserId)) {
      toast.warning('当前账号不允许删除这条云端托管记录');
      return;
    }
    setPendingDeleteAccount(account);
  };

  const confirmDeleteAccount = async () => {
    if (!pendingDeleteAccount) return;
    const deleted = await deleteAccount(pendingDeleteAccount.id);
    if (deleted) {
      await onOwnedBundleChanged();
    }
    setPendingDeleteAccount(null);
  };

  const handleOpenBrowser = async (account: Account) => {
    const result = await loginAccount(account.id);
    if (!result.success) {
      toast.error('启动失败', result.error || '未知错误');
    }
  };

  const togglePasswordVisible = async (account: Account) => {
    if (!account.hasPassword || isAccountReadOnlyForCloudUser(account, currentCloudUserId)) {
      return;
    }

    const accountId = account.id;
    const isVisible = Boolean(visiblePasswords[accountId]);
    if (!isVisible && !(accountId in revealedPasswords)) {
      const secret = await revealAccountSecret(accountId);
      if (secret === null) {
        return;
      }
      setRevealedPasswords((prev) => ({
        ...prev,
        [accountId]: secret,
      }));
    }

    setVisiblePasswords((prev) => ({
      ...prev,
      [accountId]: !isVisible,
    }));
  };

  return (
    <div className="grid h-full min-h-0 gap-3 p-3 xl:grid-cols-[272px_minmax(0,1fr)]">
      <div className="shell-subpanel min-h-0 overflow-hidden rounded-[20px] border">
        <AccountCategorySidebar
          expandedSection={categoryMode}
          selectedCategoryId={selectedCategoryId}
          accountsCount={accounts.length}
          siteCategories={getCategoriesBySite()}
          tagCategories={getCategoriesByTag()}
          onExpandedSectionChange={setCategoryMode}
          onSelectCategory={(categoryId) => {
            if (categoryId?.startsWith('tag:')) {
              setCategoryMode('tag');
            } else if (categoryId?.startsWith('site:')) {
              setCategoryMode('site');
            }
            selectCategory(categoryId);
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="space-y-3 rounded-[18px] bg-[linear-gradient(180deg,rgba(255,255,255,0.84),rgba(248,250,254,0.74))] px-4 py-4 backdrop-blur-sm">
          <div className="space-y-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="relative min-w-[240px] flex-1 xl:max-w-xl">
                <ListFilter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  className="h-10 rounded-[10px] border-slate-200/80 bg-white/96 pl-9 shadow-none"
                  placeholder="搜索名称、登录账号、平台、URL、标签"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {keywordValue ? (
                  <Button
                    variant="ghost"
                    className="h-10 rounded-[10px] px-4 text-slate-600 hover:bg-white/72 hover:text-slate-900"
                    onClick={() => setKeyword('')}
                  >
                    清除搜索
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      className="h-10 rounded-[10px] border-slate-200/80 bg-white/90 px-4 shadow-none hover:bg-white"
                    >
                      <MoreHorizontal className="mr-1 h-4 w-4" />
                      数据维护
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setIsPlatformDialogOpen(true)}>
                      <Globe className="mr-2 h-4 w-4" />
                      平台信息
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setIsTagDialogOpen(true)}>
                      <Tag className="mr-2 h-4 w-4" />
                      标签管理
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={clearError}>
              关闭
            </Button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          <AccountTable
            accounts={filteredAccounts}
            currentCloudUserId={currentCloudUserId}
            profileNameById={profileNameById}
            platformById={platformById}
            revealedPasswords={revealedPasswords}
            visiblePasswords={visiblePasswords}
            onOpenBrowser={(account) => void handleOpenBrowser(account)}
            onTogglePasswordVisible={(account) => void togglePasswordVisible(account)}
            onEditAccount={openEditAccount}
            onDeleteAccount={(account) => void handleDeleteAccount(account)}
          />
        </div>
      </div>

      <AccountFormDialog
        open={isAccountDialogOpen}
        editingAccountId={editingAccountId}
        accountForm={accountForm}
        submittingAccount={submittingAccount}
        savedSites={savedSites}
        profiles={selectableProfiles}
        platformById={platformById}
        profileNameById={profileNameById}
        recommendedProfileName={recommendedProfileName}
        recommendedProfileSource={recommendedProfileBinding.source}
        totalProfileCount={profiles.length}
        suggestedAutoProfileName={suggestedAutoProfileName}
        onClose={closeAccountDialog}
        onSubmit={() => void handleSubmitAccount()}
        onOpenPlatformDialog={() => setIsPlatformDialogOpen(true)}
        onPlatformChange={handlePlatformChange}
        onProfileBindingModeChange={handleProfileBindingModeChange}
        onChangeForm={handleChangeForm}
        onPasswordChange={(value) => {
          setPasswordTouched(true);
          handleChangeForm({ password: value });
        }}
      />

      <SavedSiteFormDialog
        open={isPlatformDialogOpen}
        onOpenChange={setIsPlatformDialogOpen}
        onClose={() => setIsPlatformDialogOpen(false)}
        onDataChanged={onOwnedBundleChanged}
      />

      <TagFormDialog
        open={isTagDialogOpen}
        onOpenChange={setIsTagDialogOpen}
        onClose={() => setIsTagDialogOpen(false)}
        onDataChanged={onOwnedBundleChanged}
      />

      <ConfirmDialog
        open={pendingDeleteAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteAccount(null);
          }
        }}
        title="删除账号"
        description={
          pendingDeleteAccount
            ? `确定删除账号「${pendingDeleteAccount.displayName || pendingDeleteAccount.name}」吗？`
            : ''
        }
        confirmText="删除"
        cancelText="取消"
        variant="danger"
        loading={loading.mutation}
        onConfirm={() => void confirmDeleteAccount()}
      />
    </div>
  );
}
