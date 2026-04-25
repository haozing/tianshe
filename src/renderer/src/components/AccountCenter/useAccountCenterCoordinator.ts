import { useCallback, useEffect, useRef, useState } from 'react';
import { useProfileStore } from '../../stores/profileStore';
import { useAccountStore } from '../../stores/accountStore';
import { useCloudAuthStore } from '../../stores/cloudAuthStore';
import { toast } from '../../lib/toast';
import type { AutomationEngine } from '../../../../types/profile';
import { isCloudSnapshotAvailable } from '../../lib/edition';

const ACCOUNT_BUNDLE_CONFLICT_MESSAGE =
  '账号云端数据已被其他设备更新，已停止自动覆盖。请刷新后确认是否使用本地改动覆盖云端。';

function isAccountBundleConflictMessage(message: string): boolean {
  return message.includes('账号云端数据已被其他设备更新');
}

export type AccountCenterTab = 'accounts' | 'profiles' | 'extensions' | 'running';

export interface CloudProfileListItem {
  profileUid?: string;
  cloudUid: string;
  name: string;
  engine: AutomationEngine;
  ownerUserId: number;
  ownerUserName?: string;
  visibility: 'public' | 'private';
  version: number;
  updatedAt: string;
  lastSyncedAt?: string;
}

export interface AccountCenterProfileRefreshOptions {
  includeGroups?: boolean;
  refreshRunning?: boolean;
}

interface UseAccountCenterCoordinatorParams {
  activeTab: AccountCenterTab;
}

export function useAccountCenterCoordinator({ activeTab }: UseAccountCenterCoordinatorParams) {
  const loadGroups = useProfileStore((state) => state.loadGroups);
  const loadProfiles = useProfileStore((state) => state.loadProfiles);
  const loadStats = useProfileStore((state) => state.loadStats);
  const clearProfileError = useProfileStore((state) => state.clearError);
  const profileLoading = useProfileStore((state) => state.loading);
  const profileError = useProfileStore((state) => state.error);
  const loadAllAccounts = useAccountStore((state) => state.loadAllAccounts);
  const loadSavedSites = useAccountStore((state) => state.loadSavedSites);
  const loadTags = useAccountStore((state) => state.loadTags);
  const clearAccountError = useAccountStore((state) => state.clearError);
  const accountLoading = useAccountStore((state) => state.loading);
  const accountError = useAccountStore((state) => state.error);
  const cloudAuthState = useCloudAuthStore((state) => state.authState);
  const cloudCapabilities = useCloudAuthStore((state) => state.capabilities);
  const activeCloudScope = useCloudAuthStore((state) => state.activeScope);
  const cloudSnapshotAvailable = isCloudSnapshotAvailable();
  const [runningRefreshToken, setRunningRefreshToken] = useState(0);
  const [extensionsRefreshKey, setExtensionsRefreshKey] = useState(0);
  const [profileCloudActionProfileId, setProfileCloudActionProfileId] = useState<string | null>(
    null
  );
  const [isCloudImportOpen, setIsCloudImportOpen] = useState(false);
  const [isCloudImportLoading, setIsCloudImportLoading] = useState(false);
  const [cloudImportTargetUid, setCloudImportTargetUid] = useState<string | null>(null);
  const [cloudMineProfiles, setCloudMineProfiles] = useState<CloudProfileListItem[]>([]);
  const [cloudPublicProfiles, setCloudPublicProfiles] = useState<CloudProfileListItem[]>([]);
  const [isAccountSyncing, setIsAccountSyncing] = useState(false);
  const [accountSyncError, setAccountSyncError] = useState<string | null>(null);
  const [accountBundleDirty, setAccountBundleDirtyState] = useState(false);
  const accountBundleDirtyRef = useRef(false);
  const accountSyncPromiseRef = useRef<Promise<void> | null>(null);

  const setAccountBundleDirty = useCallback((dirty: boolean) => {
    accountBundleDirtyRef.current = dirty;
    setAccountBundleDirtyState(dirty);
  }, []);

  const loadAccountData = useCallback(async () => {
    await Promise.allSettled([loadAllAccounts(), loadSavedSites(), loadTags()]);
  }, [loadAllAccounts, loadSavedSites, loadTags]);

  const refreshAccountCenterData = useCallback(async () => {
    await loadAccountData();
  }, [loadAccountData]);

  const readPersistedAccountBundleDirty = useCallback(async (): Promise<boolean> => {
    return accountBundleDirtyRef.current;
  }, [setAccountBundleDirty]);

  const runAccountSyncCycle = useCallback(
    async (options?: { toastOnError?: boolean; allowConflictResolution?: boolean }) => {
      if (accountSyncPromiseRef.current) {
        return accountSyncPromiseRef.current;
      }

      const promise = (async () => {
        setIsAccountSyncing(true);
        setAccountSyncError(null);

        try {
          const persistedDirty = await readPersistedAccountBundleDirty();
          const cloudReady =
            cloudSnapshotAvailable && cloudAuthState === 'ready' && Boolean(activeCloudScope);
          const canEditAccount = cloudReady && cloudCapabilities?.account.edit === true;
          const canCacheAccount = cloudReady && cloudCapabilities?.account.cache === true;
          const hasDirtyOwnedChanges = accountBundleDirtyRef.current || persistedDirty;

          const pushOwnedAccountBundle = async (onConflict: 'error' | 'overwrite') => {
            if (!window.electronAPI.cloudSnapshot) {
              throw new Error('当前版本未启用云端快照');
            }
            const pushResult = await window.electronAPI.cloudSnapshot.pushAccountBundle({
              onConflict,
            });
            if (!pushResult.success || !pushResult.data) {
              throw new Error(pushResult.error || '推送账号同步失败');
            }
            setAccountBundleDirty(false);
          };

          if (canEditAccount && hasDirtyOwnedChanges) {
            try {
              await pushOwnedAccountBundle('error');
            } catch (error) {
              const message = error instanceof Error ? error.message : '推送账号同步失败';
              if (
                isAccountBundleConflictMessage(message) &&
                options?.allowConflictResolution === true
              ) {
                const shouldOverwrite = window.confirm(
                  '云端账号数据已被其他设备更新。是否以当前本地改动覆盖云端最新版本？'
                );
                if (!shouldOverwrite) {
                  throw new Error(ACCOUNT_BUNDLE_CONFLICT_MESSAGE);
                }
                await pushOwnedAccountBundle('overwrite');
              } else {
                throw error;
              }
            }
          }

          const shouldPullVisibleBundle =
            canCacheAccount && (!accountBundleDirtyRef.current || canEditAccount);
          if (shouldPullVisibleBundle) {
            if (!window.electronAPI.cloudSnapshot) {
              throw new Error('当前版本未启用云端快照');
            }
            const pullResult = await window.electronAPI.cloudSnapshot.pullAccountBundle();
            if (!pullResult.success || !pullResult.data) {
              throw new Error(pullResult.error || '拉取账号同步失败');
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : '账号同步失败';
          setAccountSyncError(message);
          if (options?.toastOnError) {
            toast.error(
              isAccountBundleConflictMessage(message) ? '账号同步冲突' : '账号同步失败',
              message
            );
          }
        } finally {
          await refreshAccountCenterData();
          setIsAccountSyncing(false);
          accountSyncPromiseRef.current = null;
        }
      })();

      accountSyncPromiseRef.current = promise;
      return promise;
    },
    [
      activeCloudScope,
      cloudAuthState,
      cloudCapabilities?.account.cache,
      cloudCapabilities?.account.edit,
      cloudSnapshotAvailable,
      readPersistedAccountBundleDirty,
      refreshAccountCenterData,
      setAccountBundleDirty,
    ]
  );

  const notifyAccountBundleDirty = useCallback(async () => {
    setAccountBundleDirty(true);
    if (cloudSnapshotAvailable && activeTab === 'accounts') {
      await runAccountSyncCycle({ toastOnError: true });
    }
  }, [activeTab, cloudSnapshotAvailable, runAccountSyncCycle, setAccountBundleDirty]);

  const refreshProfileCenterData = useCallback(
    async (options?: AccountCenterProfileRefreshOptions) => {
      const includeGroups = options?.includeGroups ?? false;
      const tasks = [loadProfiles(), loadStats()];
      if (includeGroups) {
        tasks.push(loadGroups());
      }

      await Promise.allSettled(tasks);
      if (options?.refreshRunning) {
        setRunningRefreshToken((value) => value + 1);
      }
    },
    [loadGroups, loadProfiles, loadStats]
  );

  const refreshExtensionsData = useCallback(
    async (options?: { forceRemount?: boolean }) => {
      await loadProfiles();
      if (options?.forceRemount) {
        setExtensionsRefreshKey((value) => value + 1);
      }
    },
    [loadProfiles]
  );

  const loadTabData = useCallback(
    async (tab: AccountCenterTab, options?: { force?: boolean }) => {
      if (tab === 'accounts') {
        await runAccountSyncCycle({
          toastOnError: options?.force === true,
          allowConflictResolution: options?.force === true,
        });
        return;
      }

      if (tab === 'profiles' || tab === 'running') {
        await refreshProfileCenterData({
          includeGroups: true,
          refreshRunning: tab === 'running' && options?.force,
        });
        return;
      }

      await refreshExtensionsData({
        forceRemount: options?.force,
      });
    },
    [refreshExtensionsData, refreshProfileCenterData, runAccountSyncCycle]
  );

  const handleRefresh = useCallback(() => {
    void loadTabData(activeTab, { force: true });
  }, [activeTab, loadTabData]);

  const handlePushProfileToCloud = useCallback(async (profileId: string) => {
    if (!cloudSnapshotAvailable || !window.electronAPI.cloudSnapshot) {
      toast.warning('当前版本未启用云端快照');
      return;
    }

    setProfileCloudActionProfileId(profileId);
    try {
      const result = await window.electronAPI.cloudSnapshot.pushProfile(profileId, {
        onConflict: 'overwrite',
      });
      if (!result.success || !result.data) {
        toast.error('推送环境失败', result.error || '未知错误');
        return;
      }
      toast.success('环境已推送到云端', result.data.cloudUid);
    } catch (error) {
      toast.error('推送环境失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setProfileCloudActionProfileId(null);
    }
  }, [cloudSnapshotAvailable]);

  const handleDeleteCloudProfile = useCallback(async (profileId: string) => {
    if (!cloudSnapshotAvailable || !window.electronAPI.cloudSnapshot) {
      toast.warning('当前版本未启用云端快照');
      return;
    }

    if (!window.confirm('确定删除该环境的云端版本吗？本地环境会保留。')) {
      return;
    }

    setProfileCloudActionProfileId(profileId);
    try {
      const result = await window.electronAPI.cloudSnapshot.deleteCloudProfile(profileId);
      if (!result.success || !result.data) {
        toast.error('删除云端版本失败', result.error || '未知错误');
        return;
      }
      if (result.data.skipped === 'mapping_not_found') {
        toast.info('当前环境没有云端版本映射');
        return;
      }
      toast.success('云端版本已删除');
    } catch (error) {
      toast.error('删除云端版本失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setProfileCloudActionProfileId(null);
    }
  }, [cloudSnapshotAvailable]);

  const loadCloudImportLists = useCallback(async () => {
    if (!cloudSnapshotAvailable || !window.electronAPI.cloudSnapshot) {
      setCloudMineProfiles([]);
      setCloudPublicProfiles([]);
      return;
    }

    setIsCloudImportLoading(true);
    try {
      const [mineResult, publicResult] = await Promise.all([
        window.electronAPI.cloudSnapshot.listMine({ pageIndex: 1, pageSize: 50 }),
        window.electronAPI.cloudSnapshot.listPublic({ pageIndex: 1, pageSize: 50 }),
      ]);

      setCloudMineProfiles(mineResult.success && mineResult.data ? mineResult.data.items : []);
      setCloudPublicProfiles(
        publicResult.success && publicResult.data ? publicResult.data.items : []
      );

      if (!mineResult.success && !publicResult.success) {
        toast.error('加载云端环境列表失败', mineResult.error || publicResult.error || '未知错误');
      }
    } finally {
      setIsCloudImportLoading(false);
    }
  }, [cloudSnapshotAvailable]);

  const handleCloudImportOpenChange = useCallback(
    (open: boolean) => {
      setIsCloudImportOpen(open);
      if (open) {
        void loadCloudImportLists();
      }
    },
    [loadCloudImportLists]
  );

  const openCloudImportDialog = useCallback(() => {
    handleCloudImportOpenChange(true);
  }, [handleCloudImportOpenChange]);

  const handleImportCloudProfile = useCallback(
    async (cloudUid: string) => {
      setCloudImportTargetUid(cloudUid);
      try {
        if (!cloudSnapshotAvailable || !window.electronAPI.cloudSnapshot) {
          throw new Error('当前版本未启用云端快照');
        }

        const result = await window.electronAPI.cloudSnapshot.pullProfile(cloudUid);
        if (!result.success || !result.data) {
          toast.error('导入云端环境失败', result.error || '未知错误');
          return;
        }
        await refreshProfileCenterData({
          includeGroups: true,
        });
        toast.success(
          '云端环境已导入',
          result.data.createdLocal ? '已创建本地环境' : '已更新本地环境'
        );
        setIsCloudImportOpen(false);
      } catch (error) {
        toast.error('导入云端环境失败', error instanceof Error ? error.message : '未知错误');
      } finally {
        setCloudImportTargetUid(null);
      }
    },
    [cloudSnapshotAvailable, refreshProfileCenterData]
  );

  const clearAccountCenterError = useCallback(() => {
    setAccountSyncError(null);
    clearProfileError();
    clearAccountError();
  }, [clearAccountError, clearProfileError]);

  useEffect(() => {
    if (activeTab !== 'accounts') return;
    if (!cloudSnapshotAvailable) return;
    if (cloudAuthState !== 'ready' || !activeCloudScope) return;
    void runAccountSyncCycle();
  }, [
    activeTab,
    activeCloudScope,
    cloudAuthState,
    cloudCapabilities?.account.cache,
    cloudCapabilities?.account.edit,
    cloudSnapshotAvailable,
    runAccountSyncCycle,
  ]);

  const isAccountCenterRefreshing =
    activeTab === 'accounts'
      ? accountLoading.accounts ||
        accountLoading.savedSites ||
        accountLoading.tags ||
        isAccountSyncing
      : activeTab === 'profiles'
        ? profileLoading.profiles ||
          profileLoading.groups ||
          profileLoading.stats ||
          profileCloudActionProfileId !== null ||
          isCloudImportLoading ||
          cloudImportTargetUid !== null
        : activeTab === 'extensions'
          ? profileLoading.profiles
          : profileLoading.profiles || profileLoading.groups || profileLoading.stats;

  const accountCenterError =
    activeTab === 'accounts'
      ? accountSyncError || accountError
      : activeTab === 'profiles' || activeTab === 'extensions' || activeTab === 'running'
        ? profileError
        : profileError || accountError;

  return {
    accountCenterError,
    clearAccountCenterError,
    isAccountCenterRefreshing,
    runningRefreshToken,
    extensionsRefreshKey,
    cloudActionProfileId: profileCloudActionProfileId,
    refreshAccountCenterData,
    refreshProfileCenterData,
    loadTabData,
    handleRefresh,
    runAccountSyncCycle,
    notifyAccountBundleDirty,
    accountBundleDirty,
    handlePushProfileToCloud,
    handleDeleteCloudProfile,
    openCloudImportDialog,
    cloudSnapshotAvailable,
    cloudImportDialogProps: {
      open: isCloudImportOpen,
      onOpenChange: handleCloudImportOpenChange,
      isLoading: isCloudImportLoading,
      targetUid: cloudImportTargetUid,
      mineProfiles: cloudMineProfiles,
      publicProfiles: cloudPublicProfiles,
      onRefresh: () => void loadCloudImportLists(),
      onImport: (cloudUid: string) => void handleImportCloudProfile(cloudUid),
    },
  };
}
