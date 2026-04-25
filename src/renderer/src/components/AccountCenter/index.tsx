import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Download,
  LayoutGrid,
  List,
  MonitorPlay,
  Puzzle,
  RefreshCw,
  UserRoundCog,
  Users,
  type LucideIcon,
  Plus,
} from 'lucide-react';
import { UNGROUPED_GROUP_ID, useProfileStore } from '../../stores/profileStore';
import { useUIStore } from '../../stores/uiStore';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { ProfileGroupTree } from './ProfileGroupTree';
import { ProfileList } from './ProfileList';
import { ProfileFormDialog } from './ProfileFormDialog';
import { RunningBrowsersPanel } from './RunningBrowsersPanel';
import { ExtensionPackagesPanel } from './ExtensionPackagesPanel';
import { AccountManagementPanel } from './AccountManagementPanel';
import { CloudProfileImportDialog } from './CloudProfileImportDialog';
import { type AccountCenterTab, useAccountCenterCoordinator } from './useAccountCenterCoordinator';
import { PageFrameHeader } from '../layout/PageFrameHeader';

type ViewMode = 'grid' | 'list';

export function AccountCenterPage() {
  const profiles = useProfileStore((state) => state.profiles);
  const groups = useProfileStore((state) => state.groups);
  const selectedGroupId = useProfileStore((state) => state.selectedGroupId);
  const profileLoading = useProfileStore((state) => state.loading);
  const accountCenterTab = useUIStore((state) => state.accountCenterTab) as AccountCenterTab;
  const setAccountCenterTab = useUIStore((state) => state.setAccountCenterTab);

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [accountCreateRequestId, setAccountCreateRequestId] = useState<string | null>(null);
  const {
    accountCenterError,
    clearAccountCenterError,
    isAccountCenterRefreshing,
    runningRefreshToken,
    extensionsRefreshKey,
    cloudActionProfileId,
    refreshAccountCenterData,
    refreshProfileCenterData,
    loadTabData,
    handleRefresh,
    notifyAccountBundleDirty,
    handlePushProfileToCloud,
    handleDeleteCloudProfile,
    openCloudImportDialog,
    cloudSnapshotAvailable,
    cloudImportDialogProps,
  } = useAccountCenterCoordinator({
    activeTab: accountCenterTab,
  });

  useEffect(() => {
    void loadTabData(accountCenterTab);
  }, [accountCenterTab, loadTabData]);

  const handleProfileMutationApplied = useCallback(async () => {
    await Promise.allSettled([
      refreshProfileCenterData({ includeGroups: true }),
      refreshAccountCenterData(),
    ]);
    await notifyAccountBundleDirty();
  }, [notifyAccountBundleDirty, refreshAccountCenterData, refreshProfileCenterData]);

  const filteredProfiles = useMemo(() => {
    if (selectedGroupId === null) return profiles;
    if (selectedGroupId === UNGROUPED_GROUP_ID) {
      return profiles.filter((p) => p.groupId === null);
    }

    const selectedIds = new Set<string>();
    const collectIds = (node: any) => {
      selectedIds.add(node.id);
      for (const child of node.children || []) {
        collectIds(child);
      }
    };
    const findAndCollect = (nodes: any[]): boolean => {
      for (const node of nodes) {
        if (node.id === selectedGroupId) {
          collectIds(node);
          return true;
        }
        if (node.children && findAndCollect(node.children)) {
          return true;
        }
      }
      return false;
    };

    findAndCollect(Array.isArray(groups) ? groups : []);
    if (selectedIds.size === 0) {
      selectedIds.add(selectedGroupId);
    }

    return profiles.filter((p) => p.groupId && selectedIds.has(p.groupId));
  }, [groups, profiles, selectedGroupId]);

  const filteredProfileIds = useMemo(() => filteredProfiles.map((p) => p.id), [filteredProfiles]);

  const tabOptions: Array<{
    value: AccountCenterTab;
    label: string;
    icon: LucideIcon;
  }> = [
    { value: 'accounts', label: '账号视图', icon: Users },
    { value: 'profiles', label: '环境配置', icon: UserRoundCog },
    { value: 'extensions', label: '扩展中心', icon: Puzzle },
    { value: 'running', label: '运行中', icon: MonitorPlay },
  ];

  const handleCreateProfile = () => {
    setEditingProfileId(null);
    setIsFormOpen(true);
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingProfileId(null);
  };

  const handleCreateAccount = () => {
    setAccountCenterTab('accounts');
    setAccountCreateRequestId(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  };

  return (
    <div className="shell-content-surface flex h-full flex-col">
      <PageFrameHeader
        title="账号中心"
        className="workspace-page-header"
        actions={
          <div className="page-header-control-group">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isAccountCenterRefreshing}
              className="page-header-action-button"
            >
              <RefreshCw
                className={cn('mr-1 h-4 w-4', isAccountCenterRefreshing && 'animate-spin')}
              />
              刷新
            </Button>

            {accountCenterTab === 'accounts' ? (
              <Button size="sm" onClick={handleCreateAccount} className="page-header-action-button">
                <Plus className="mr-1 h-4 w-4" />
                新增账号
              </Button>
            ) : null}

            {accountCenterTab === 'profiles' ? (
              <Button size="sm" onClick={handleCreateProfile} className="page-header-action-button">
                <Plus className="mr-1 h-4 w-4" />
                新建环境
              </Button>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="更多"
                  className="page-header-action-button"
                >
                  更多
                  <ChevronDown className="ml-1 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[220px] rounded-2xl border border-slate-200/90 bg-white/95 p-1.5 shadow-[0_16px_40px_rgba(20,27,45,0.12)]"
              >
                {tabOptions.map(({ value, label, icon: Icon }) => {
                  const isActive = accountCenterTab === value;
                  return (
                    <DropdownMenuItem
                      key={value}
                      onClick={() => setAccountCenterTab(value)}
                      className={cn(
                        'rounded-xl px-3 py-2.5 text-slate-600',
                        isActive && 'bg-slate-100 text-slate-900'
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        {label}
                      </span>
                    </DropdownMenuItem>
                  );
                })}

                {accountCenterTab === 'profiles' ? (
                  <>
                    {cloudSnapshotAvailable ? (
                      <>
                        <DropdownMenuSeparator className="bg-slate-200/90" />
                        <DropdownMenuItem
                          onClick={openCloudImportDialog}
                          className="rounded-xl px-3 py-2.5 text-slate-600"
                        >
                          <span className="inline-flex items-center gap-2">
                            <Download className="h-4 w-4" />
                            从云端导入
                          </span>
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    <DropdownMenuSeparator className="bg-slate-200/90" />
                    <DropdownMenuItem
                      onClick={() => setViewMode('grid')}
                      className={cn(
                        'rounded-xl px-3 py-2.5 text-slate-600',
                        viewMode === 'grid' && 'bg-slate-100 text-slate-900'
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <LayoutGrid className="h-4 w-4" />
                        网格视图
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setViewMode('list')}
                      className={cn(
                        'rounded-xl px-3 py-2.5 text-slate-600',
                        viewMode === 'list' && 'bg-slate-100 text-slate-900'
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <List className="h-4 w-4" />
                        列表视图
                      </span>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <div className="shell-content-muted flex flex-1 flex-col overflow-hidden p-4">
        {accountCenterError ? (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700">
            <span>{accountCenterError}</span>
            <Button variant="ghost" size="sm" onClick={clearAccountCenterError}>
              关闭
            </Button>
          </div>
        ) : null}

        <div className={cn('min-h-0 flex-1 overflow-hidden', accountCenterError && 'mt-4')}>
          {accountCenterTab === 'accounts' ? (
            <div className="h-full overflow-hidden">
              <AccountManagementPanel
                createRequestId={accountCreateRequestId}
                profiles={profiles}
                onOwnedBundleChanged={notifyAccountBundleDirty}
                onProfileDataChanged={() => refreshProfileCenterData({ includeGroups: true })}
              />
            </div>
          ) : accountCenterTab === 'extensions' ? (
            <div className="h-full overflow-hidden rounded-[20px] border border-[rgba(214,221,234,0.92)] bg-white/88 shadow-[0_12px_28px_rgba(20,27,45,0.06)]">
              <div className="h-full overflow-auto p-3">
                <ExtensionPackagesPanel
                  key={extensionsRefreshKey}
                  profiles={profiles}
                  onProfileDataChanged={refreshProfileCenterData}
                />
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[280px_minmax(0,1fr)]">
              <div className="shell-subpanel min-h-0 overflow-hidden rounded-[20px] border">
                <ProfileGroupTree />
              </div>

              <div className="min-h-0 overflow-hidden rounded-[20px] border border-[rgba(214,221,234,0.92)] bg-white/88 shadow-[0_12px_28px_rgba(20,27,45,0.06)]">
                <div className="h-full overflow-auto p-3">
                  {accountCenterTab === 'profiles' ? (
                    <ProfileList
                      profiles={filteredProfiles}
                      viewMode={viewMode}
                      isLoading={profileLoading.profiles}
                      cloudEnabled={cloudSnapshotAvailable}
                      cloudActionProfileId={cloudActionProfileId}
                      onPushCloud={(id) => void handlePushProfileToCloud(id)}
                      onDeleteCloud={(id) => void handleDeleteCloudProfile(id)}
                      onEdit={(id) => {
                        setEditingProfileId(id);
                        setIsFormOpen(true);
                      }}
                      onProfileDataChanged={refreshProfileCenterData}
                      onProfileMutationApplied={handleProfileMutationApplied}
                    />
                  ) : (
                    <RunningBrowsersPanel
                      profiles={profiles}
                      visibleProfileIds={filteredProfileIds}
                      refreshToken={runningRefreshToken}
                      onChanged={() => {
                        void refreshProfileCenterData({
                          refreshRunning: true,
                        });
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {accountCenterTab === 'profiles' ? (
        <ProfileFormDialog
          open={isFormOpen}
          onOpenChange={setIsFormOpen}
          profileId={editingProfileId}
          onClose={handleFormClose}
          onProfileMutationApplied={handleProfileMutationApplied}
        />
      ) : null}

      {cloudSnapshotAvailable ? <CloudProfileImportDialog {...cloudImportDialogProps} /> : null}
    </div>
  );
}

export const BrowsersPage = AccountCenterPage;

export default AccountCenterPage;
