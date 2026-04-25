import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import type {
  BrowserProfile,
  ExtensionPackage,
  ProfileExtensionBinding,
} from '../../../../types/profile';
import { toast } from '../../lib/toast';
import { useCloudAuthStore } from '../../stores/cloudAuthStore';
import {
  getBrowserExtensionCatalogCapabilities,
  listBrowserExtensionCatalog,
} from '../../services/browserExtensionCloud';
import { isCloudBrowserExtensionCatalogAvailable } from '../../lib/edition';
import {
  EMPTY_RUNTIME_CATALOG_CAPABILITIES,
  type RuntimeCatalogCapabilityState,
} from '../PluginMarket/pluginMarketShared';
import { ExtensionPackagesBindingTab } from './ExtensionPackagesBindingTab';
import { ExtensionPackagesRepositoryTab } from './ExtensionPackagesRepositoryTab';
import {
  type BatchBindPayload,
  type BatchUnbindPayload,
  type CloudCatalogItem,
  type PanelTab,
  type PendingBatchAction,
  type RunningProfileImpact,
  type RunningProfileImpactItem,
  toPackageKey,
} from './extensionPackagesShared';
import { cn } from '../../lib/utils';

const EXTENSION_PACKAGES_IPC_UNAVAILABLE_MESSAGE =
  '当前运行版本未注册扩展中心主进程能力，请重新构建并重启桌面端后重试。';

interface ExtensionPackagesPanelProps {
  profiles: BrowserProfile[];
  onProfileDataChanged?: (options?: { refreshRunning?: boolean }) => Promise<void> | void;
}

export function ExtensionPackagesPanel({
  profiles,
  onProfileDataChanged,
}: ExtensionPackagesPanelProps) {
  const cloudReady = useCloudAuthStore((state) => state.authState === 'ready');
  const loadCloudSession = useCloudAuthStore((state) => state.loadSession);
  const cloudCatalogAvailable = isCloudBrowserExtensionCatalogAvailable();

  const extensionProfiles = useMemo(
    () => profiles.filter((item) => item.engine === 'extension'),
    [profiles]
  );

  const [tab, setTab] = useState<PanelTab>('repository');
  const [isLoading, setIsLoading] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [featureUnavailableMessage, setFeatureUnavailableMessage] = useState<string | null>(null);
  const [isLoadingCloudCatalog, setIsLoadingCloudCatalog] = useState(false);
  const [cloudCatalogCapabilities, setCloudCatalogCapabilities] =
    useState<RuntimeCatalogCapabilityState>(EMPTY_RUNTIME_CATALOG_CAPABILITIES);
  const [packages, setPackages] = useState<ExtensionPackage[]>([]);
  const [selectedPackageKeys, setSelectedPackageKeys] = useState<string[]>([]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);

  const [previewProfileId, setPreviewProfileId] = useState<string>('');
  const [previewBindings, setPreviewBindings] = useState<ProfileExtensionBinding[]>([]);

  const [localImportPaths, setLocalImportPaths] = useState<string[]>([]);
  const [cloudKeyword, setCloudKeyword] = useState('');
  const [cloudCatalogItems, setCloudCatalogItems] = useState<CloudCatalogItem[]>([]);
  const [selectedCloudExtensionIds, setSelectedCloudExtensionIds] = useState<string[]>([]);
  const [removePackageWhenUnused, setRemovePackageWhenUnused] = useState(false);
  const [pendingBatchAction, setPendingBatchAction] = useState<PendingBatchAction | null>(null);

  const selectedPackages = useMemo(() => {
    const map = new Map(packages.map((pkg) => [toPackageKey(pkg), pkg]));
    return selectedPackageKeys
      .map((key) => map.get(key))
      .filter((pkg): pkg is ExtensionPackage => Boolean(pkg));
  }, [packages, selectedPackageKeys]);

  const selectedProfileMap = useMemo(() => {
    return new Map(extensionProfiles.map((profile) => [profile.id, profile]));
  }, [extensionProfiles]);

  const selectedProfileItems = useMemo(() => {
    return selectedProfileIds
      .map((id) => selectedProfileMap.get(id))
      .filter((item): item is BrowserProfile => Boolean(item));
  }, [selectedProfileIds, selectedProfileMap]);

  const resolveUnavailableMessage = useCallback((error: unknown): string | null => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('No handler registered for')) {
      return EXTENSION_PACKAGES_IPC_UNAVAILABLE_MESSAGE;
    }
    return null;
  }, []);

  const refreshPackages = useCallback(async () => {
    try {
      const result = await window.electronAPI.extensionPackages.listPackages();
      if (!result.success || !result.data) {
        throw new Error(result.error || '加载扩展仓库失败');
      }
      setFeatureUnavailableMessage(null);
      setPackages(result.data);
    } catch (error) {
      const unavailableMessage = resolveUnavailableMessage(error);
      if (unavailableMessage) {
        setFeatureUnavailableMessage(unavailableMessage);
        setPackages([]);
        return;
      }
      throw error;
    }
  }, [resolveUnavailableMessage]);

  const refreshPreviewBindings = useCallback(async (profileId: string) => {
    const normalizedProfileId = String(profileId || '').trim();
    if (!normalizedProfileId) {
      setPreviewBindings([]);
      return;
    }
    try {
      const result =
        await window.electronAPI.extensionPackages.listProfileBindings(normalizedProfileId);
      if (!result.success || !result.data) {
        throw new Error(result.error || '加载绑定关系失败');
      }
      setFeatureUnavailableMessage(null);
      setPreviewBindings(result.data);
    } catch (error) {
      const unavailableMessage = resolveUnavailableMessage(error);
      if (unavailableMessage) {
        setFeatureUnavailableMessage(unavailableMessage);
        setPreviewBindings([]);
        return;
      }
      throw error;
    }
  }, [resolveUnavailableMessage]);

  const mergePackages = useCallback((nextPackages: ExtensionPackage[]) => {
    if (nextPackages.length === 0) return;
    setPackages((prev) => {
      const merged = new Map(prev.map((item) => [toPackageKey(item), item]));
      for (const item of nextPackages) {
        merged.set(toPackageKey(item), item);
      }
      return Array.from(merged.values()).sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    });
  }, []);

  const refreshCloudCatalog = useCallback(
    async (keyword?: string, forceRefresh = false) => {
      if (!cloudCatalogAvailable || !cloudReady) {
        setCloudCatalogCapabilities(EMPTY_RUNTIME_CATALOG_CAPABILITIES);
        setCloudCatalogItems([]);
        setSelectedCloudExtensionIds([]);
        return;
      }

      setIsLoadingCloudCatalog(true);
      try {
        setCloudCatalogCapabilities((prev) => ({
          ...prev,
          loading: true,
          error: undefined,
        }));
        const capabilityResult = await getBrowserExtensionCatalogCapabilities({ forceRefresh });
        if (!capabilityResult.success || !capabilityResult.data) {
          throw new Error(capabilityResult.error || '获取云端扩展目录权限失败');
        }

        const nextCapabilities: RuntimeCatalogCapabilityState = {
          loading: false,
          actions: {
            view: capabilityResult.data.actions?.view === true,
            install: capabilityResult.data.actions?.install === true,
            use: false,
            cache: false,
          },
          policyVersion: capabilityResult.data.policyVersion,
          error: undefined,
        };
        setCloudCatalogCapabilities(nextCapabilities);

        if (!nextCapabilities.actions.view) {
          setCloudCatalogItems([]);
          setSelectedCloudExtensionIds([]);
          return;
        }

        const result = await listBrowserExtensionCatalog({
          pageIndex: 1,
          pageSize: 200,
          keyword: String(keyword || '').trim() || undefined,
        });
        if (!result.success || !result.data) {
          throw new Error(result.error || '获取云端扩展列表失败');
        }

        const items = (Array.isArray(result.data.items) ? result.data.items : []).map((item) => ({
          extensionId: String(item.extensionId || '').trim(),
          name: String(item.name || item.extensionId || '').trim(),
          description: String(item.description || '').trim() || undefined,
          currentVersion: String(item.currentVersion || '').trim() || undefined,
          canInstall: item.canInstall !== false,
          installReason: String(item.installReason || '').trim() || undefined,
        }));
        setCloudCatalogItems(items.filter((item) => item.extensionId.length > 0));
        setSelectedCloudExtensionIds((prev) =>
          prev.filter((extensionId) => items.some((item) => item.extensionId === extensionId))
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        setCloudCatalogCapabilities((prev) => ({
          ...prev,
          loading: false,
          error: message,
        }));
        setCloudCatalogItems([]);
        setSelectedCloudExtensionIds([]);
      } finally {
        setIsLoadingCloudCatalog(false);
      }
    },
    [cloudCatalogAvailable, cloudReady]
  );

  useEffect(() => {
    if (!cloudCatalogAvailable) return;
    void loadCloudSession();
  }, [cloudCatalogAvailable, loadCloudSession]);

  useEffect(() => {
    setIsLoading(true);
    void refreshPackages()
      .catch((error) => {
        toast.error('初始化扩展管理失败', error instanceof Error ? error.message : '未知错误');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [refreshPackages]);

  useEffect(() => {
    void refreshCloudCatalog();
  }, [cloudReady, refreshCloudCatalog]);

  useEffect(() => {
    const validIds = new Set(extensionProfiles.map((profile) => profile.id));
    setSelectedProfileIds((prev) => prev.filter((id) => validIds.has(id)));

    setPreviewProfileId((prev) => {
      if (prev && validIds.has(prev)) return prev;
      return extensionProfiles[0]?.id || '';
    });
  }, [extensionProfiles]);

  useEffect(() => {
    const validKeys = new Set(packages.map((pkg) => toPackageKey(pkg)));
    setSelectedPackageKeys((prev) => prev.filter((key) => validKeys.has(key)));
  }, [packages]);

  useEffect(() => {
    if (featureUnavailableMessage) {
      setPreviewBindings([]);
      return;
    }
    if (!previewProfileId) {
      setPreviewBindings([]);
      return;
    }

    void refreshPreviewBindings(previewProfileId).catch((error) => {
      toast.error('加载绑定关系失败', error instanceof Error ? error.message : '未知错误');
    });
  }, [featureUnavailableMessage, previewProfileId, refreshPreviewBindings]);

  const togglePackageSelection = (pkg: ExtensionPackage, checked: boolean) => {
    const key = toPackageKey(pkg);
    setSelectedPackageKeys((prev) => {
      if (checked) {
        if (prev.includes(key)) return prev;
        return [...prev, key];
      }
      return prev.filter((item) => item !== key);
    });
  };

  const toggleProfileSelection = (profileId: string, checked: boolean) => {
    setSelectedProfileIds((prev) => {
      if (checked) {
        if (prev.includes(profileId)) return prev;
        return [...prev, profileId];
      }
      return prev.filter((id) => id !== profileId);
    });
  };

  const selectAllPackages = () => {
    setSelectedPackageKeys(packages.map((pkg) => toPackageKey(pkg)));
  };

  const clearPackageSelection = () => {
    setSelectedPackageKeys([]);
  };

  const selectAllProfiles = () => {
    setSelectedProfileIds(extensionProfiles.map((profile) => profile.id));
  };

  const clearProfileSelection = () => {
    setSelectedProfileIds([]);
  };

  const canSelectCloudItem = (item: CloudCatalogItem): boolean => item.canInstall !== false;

  const toggleCloudSelection = (extensionId: string, checked: boolean) => {
    setSelectedCloudExtensionIds((prev) => {
      if (checked) {
        if (prev.includes(extensionId)) return prev;
        return [...prev, extensionId];
      }
      return prev.filter((item) => item !== extensionId);
    });
  };

  const selectAllCloudItems = () => {
    setSelectedCloudExtensionIds(
      cloudCatalogItems.filter((item) => canSelectCloudItem(item)).map((item) => item.extensionId)
    );
  };

  const clearCloudSelection = () => {
    setSelectedCloudExtensionIds([]);
  };

  const selectSucceededPackages = useCallback((items: ExtensionPackage[]) => {
    if (items.length === 0) return;
    setSelectedPackageKeys((prev) => {
      const merged = new Set(prev);
      for (const pkg of items) {
        merged.add(toPackageKey(pkg));
      }
      return Array.from(merged);
    });
  }, []);

  const appendLocalImportPaths = (paths: string[]) => {
    const normalized = paths
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0);
    if (normalized.length === 0) return;
    setLocalImportPaths((prev) => Array.from(new Set([...prev, ...normalized])));
  };

  const notifyRefreshWarnings = useCallback((title: string, warnings: string[]) => {
    if (warnings.length === 0) return;
    toast.warning(title, warnings.join('；'));
  }, []);

  const refreshAfterProfileMutation = useCallback(
    async (options: {
      affectedProfileIds: string[];
      refreshRunning: boolean;
      previewActionLabel: string;
      pageActionLabel: string;
    }) => {
      const warnings: string[] = [];

      if (previewProfileId && options.affectedProfileIds.includes(previewProfileId)) {
        try {
          await refreshPreviewBindings(previewProfileId);
        } catch (error) {
          warnings.push(
            `${options.previewActionLabel}未刷新：${
              error instanceof Error ? error.message : '未知错误'
            }`
          );
        }
      }

      try {
        await onProfileDataChanged?.({
          refreshRunning: options.refreshRunning,
        });
      } catch (error) {
        warnings.push(
          `${options.pageActionLabel}未刷新：${error instanceof Error ? error.message : '未知错误'}`
        );
      }

      return warnings;
    },
    [onProfileDataChanged, previewProfileId, refreshPreviewBindings]
  );

  const collectRunningProfileImpact = useCallback(
    async (profileIds: string[]): Promise<RunningProfileImpact> => {
      const normalizedProfileIds = Array.from(
        new Set(
          profileIds.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
        )
      );
      if (normalizedProfileIds.length === 0) {
        return {
          affectedProfiles: [],
          destroyedBrowsers: 0,
        };
      }

      const result = await window.electronAPI.profile.poolListBrowsers();
      if (!result.success || !result.data) {
        throw new Error(result.error || '获取运行中实例失败');
      }

      const targetIds = new Set(normalizedProfileIds);
      const counts = new Map<string, number>();
      for (const browser of result.data) {
        const profileId = String(browser.sessionId || '').trim();
        if (!profileId || !targetIds.has(profileId)) continue;
        counts.set(profileId, (counts.get(profileId) || 0) + 1);
      }

      const affectedProfiles = normalizedProfileIds
        .map((profileId) => {
          const browserCount = counts.get(profileId) || 0;
          if (browserCount <= 0) return null;
          return {
            profileId,
            profileName: selectedProfileMap.get(profileId)?.name || profileId,
            browserCount,
          };
        })
        .filter((item): item is RunningProfileImpactItem => Boolean(item));

      return {
        affectedProfiles,
        destroyedBrowsers: affectedProfiles.reduce((sum, item) => sum + item.browserCount, 0),
      };
    },
    [selectedProfileMap]
  );

  const handleSelectLocalDirectories = async () => {
    setIsWorking(true);
    try {
      const result = await window.electronAPI.extensionPackages.selectLocalDirectories();
      if (!result.success || !result.data) {
        throw new Error(result.error || '选择目录失败');
      }
      if (result.data.canceled || result.data.paths.length === 0) return;
      appendLocalImportPaths(result.data.paths);
    } catch (error) {
      toast.error('选择目录失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setIsWorking(false);
    }
  };

  const handleSelectLocalArchives = async () => {
    setIsWorking(true);
    try {
      const result = await window.electronAPI.extensionPackages.selectLocalArchives();
      if (!result.success || !result.data) {
        throw new Error(result.error || '选择压缩包失败');
      }
      if (result.data.canceled || result.data.paths.length === 0) return;
      appendLocalImportPaths(result.data.paths);
    } catch (error) {
      toast.error('选择压缩包失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setIsWorking(false);
    }
  };

  const handleImportLocal = async () => {
    if (localImportPaths.length === 0) {
      toast.warning('请先选择本地目录或 ZIP 文件');
      return;
    }

    setIsWorking(true);
    try {
      const result = await window.electronAPI.extensionPackages.importLocalPackages(
        localImportPaths.map((entry) => ({ path: entry }))
      );
      if (!result.success || !result.data) {
        throw new Error(result.error || '导入本地扩展失败');
      }

      const warnings: string[] = [];
      const succeeded = Array.isArray(result.data.succeeded) ? result.data.succeeded : [];
      const failed = Array.isArray(result.data.failed) ? result.data.failed : [];

      if (succeeded.length > 0) {
        mergePackages(succeeded);
        selectSucceededPackages(succeeded);
      }

      if (failed.length > 0) {
        setLocalImportPaths(
          Array.from(
            new Set(
              failed.map((item) => String(item.path || '').trim()).filter((item) => item.length > 0)
            )
          )
        );
      } else {
        setLocalImportPaths([]);
      }

      try {
        await refreshPackages();
      } catch (error) {
        warnings.push(`仓库列表未刷新：${error instanceof Error ? error.message : '未知错误'}`);
      }

      if (succeeded.length > 0) {
        toast.success('导入完成', `成功 ${succeeded.length} 个，失败 ${failed.length} 个`);
        notifyRefreshWarnings('导入已生效，但部分后续操作未完成', warnings);
        if (failed.length > 0) {
          toast.warning('部分导入失败', failed.map((item) => item.error).join('；'));
        }
        return;
      }

      const failureMessage = failed.map((item) => item.error).join('；') || '未知错误';
      toast.error('导入本地扩展失败', failureMessage);
    } catch (error) {
      toast.error('导入本地扩展失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setIsWorking(false);
    }
  };

  const handleDownloadSelectedCloud = async () => {
    if (
      !cloudCatalogAvailable ||
      !window.electronAPI.extensionPackages.downloadCloudCatalogPackages
    ) {
      toast.warning('当前版本未启用云端扩展目录');
      return;
    }
    if (!cloudReady) {
      toast.warning('请先登录云端账号');
      return;
    }
    if (selectedCloudExtensionIds.length === 0) {
      toast.warning('请至少选择一个云端扩展');
      return;
    }

    const catalogMap = new Map(cloudCatalogItems.map((item) => [item.extensionId, item]));
    const inputs = selectedCloudExtensionIds.map((extensionId) => ({
      extensionId,
      name: catalogMap.get(extensionId)?.name,
    }));

    setIsWorking(true);
    try {
      const result =
        await window.electronAPI.extensionPackages.downloadCloudCatalogPackages(inputs);
      if (!result.success || !result.data) {
        throw new Error(result.error || '下载云端扩展失败');
      }

      const warnings: string[] = [];
      const succeeded = Array.isArray(result.data.succeeded) ? result.data.succeeded : [];
      const failed = Array.isArray(result.data.failed) ? result.data.failed : [];

      if (succeeded.length > 0) {
        mergePackages(succeeded);
        selectSucceededPackages(succeeded);
      }
      setSelectedCloudExtensionIds(
        failed
          .map((item) => String(item.extensionId || '').trim())
          .filter((item) => item.length > 0)
      );

      try {
        await refreshPackages();
      } catch (error) {
        warnings.push(`仓库列表未刷新：${error instanceof Error ? error.message : '未知错误'}`);
      }

      if (succeeded.length > 0) {
        toast.success('下载完成', `成功 ${succeeded.length} 个，失败 ${failed.length} 个`);
        notifyRefreshWarnings('下载已生效，但部分后续操作未完成', warnings);
        if (failed.length > 0) {
          toast.warning('部分下载失败', failed.map((item) => item.error).join('；'));
        }
        return;
      }

      const failureMessage = failed.map((item) => item.error).join('；') || '未知错误';
      toast.error('下载云端扩展失败', failureMessage);
    } catch (error) {
      toast.error('下载云端扩展失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setIsWorking(false);
    }
  };

  const getBatchBindConflicts = (): string[] => {
    const versionsByExtensionId = new Map<string, Set<string>>();
    for (const pkg of selectedPackages) {
      const versions = versionsByExtensionId.get(pkg.extensionId) || new Set<string>();
      versions.add(String(pkg.version || '').trim() || 'latest');
      versionsByExtensionId.set(pkg.extensionId, versions);
    }

    return Array.from(versionsByExtensionId.entries())
      .filter(([, versions]) => versions.size > 1)
      .map(([extensionId, versions]) => `${extensionId} (${Array.from(versions).join(', ')})`);
  };

  const buildBatchPackages = () => {
    return selectedPackages;
  };

  const submitBatchBind = useCallback(
    async (payload: BatchBindPayload) => {
      setIsWorking(true);
      try {
        const result = await window.electronAPI.extensionPackages.batchBind({
          profileIds: payload.profileIds,
          packages: payload.packages,
        });

        if (!result.success || !result.data) {
          throw new Error(result.error || '批量绑定失败');
        }

        const warnings = await refreshAfterProfileMutation({
          affectedProfileIds: payload.profileIds,
          refreshRunning:
            result.data.destroyedBrowsers > 0 || result.data.restartFailures.length > 0,
          previewActionLabel: '绑定预览',
          pageActionLabel: '账号中心数据',
        });
        if (result.data.restartFailures.length > 0) {
          warnings.push(`有 ${result.data.restartFailures.length} 个环境的运行中实例未能自动关闭`);
        }

        const impactSummary =
          result.data.destroyedBrowsers > 0
            ? `，关闭 ${result.data.destroyedBrowsers} 个运行中实例`
            : '';
        toast.success(
          '绑定完成',
          `已为 ${payload.profileCount} 个环境绑定 ${payload.packageCount} 个扩展${impactSummary}`
        );
        notifyRefreshWarnings('绑定已保存，但部分后续操作未完成', warnings);
        setPendingBatchAction(null);
      } catch (error) {
        toast.error('批量绑定失败', error instanceof Error ? error.message : '未知错误');
      } finally {
        setIsWorking(false);
      }
    },
    [notifyRefreshWarnings, refreshAfterProfileMutation]
  );

  const submitBatchUnbind = useCallback(
    async (payload: BatchUnbindPayload) => {
      setIsWorking(true);
      try {
        const result = await window.electronAPI.extensionPackages.batchUnbind(payload);

        if (!result.success || !result.data) {
          throw new Error(result.error || '批量解绑失败');
        }

        const warnings = await refreshAfterProfileMutation({
          affectedProfileIds: payload.profileIds,
          refreshRunning:
            result.data.destroyedBrowsers > 0 || result.data.restartFailures.length > 0,
          previewActionLabel: '解绑预览',
          pageActionLabel: '账号中心数据',
        });
        if (result.data.removedPackages.length > 0) {
          const removedPackageKeys = new Set(result.data.removedPackages);
          setPackages((prev) => prev.filter((item) => !removedPackageKeys.has(toPackageKey(item))));
        }
        if (payload.removePackageWhenUnused && result.data.removedPackages.length > 0) {
          try {
            await refreshPackages();
          } catch (error) {
            warnings.push(`仓库列表未刷新：${error instanceof Error ? error.message : '未知错误'}`);
          }
        }
        if (result.data.restartFailures.length > 0) {
          warnings.push(`有 ${result.data.restartFailures.length} 个环境的运行中实例未能自动关闭`);
        }

        const impactSummary =
          result.data.destroyedBrowsers > 0
            ? `，关闭 ${result.data.destroyedBrowsers} 个运行中实例`
            : '';
        toast.success(
          '解绑完成',
          `解绑 ${result.data.removedBindings} 条，清理 ${result.data.removedPackages.length} 个扩展包${impactSummary}`
        );
        notifyRefreshWarnings('解绑已保存，但部分后续操作未完成', warnings);
        setPendingBatchAction(null);
      } catch (error) {
        toast.error('批量解绑失败', error instanceof Error ? error.message : '未知错误');
      } finally {
        setIsWorking(false);
      }
    },
    [notifyRefreshWarnings, refreshAfterProfileMutation, refreshPackages]
  );

  const handleBatchBind = async () => {
    if (selectedProfileIds.length === 0) {
      toast.warning('请至少选择一个扩展环境');
      return;
    }

    const bindPackages = buildBatchPackages();
    if (bindPackages.length === 0) {
      toast.warning('请至少选择一个扩展包');
      return;
    }

    const conflicts = getBatchBindConflicts();
    if (conflicts.length > 0) {
      toast.error('批量绑定失败', `同一扩展不能同时绑定多个版本: ${conflicts.join('; ')}`);
      return;
    }

    const payload: BatchBindPayload = {
      profileIds: [...selectedProfileIds],
      packages: bindPackages.map((pkg, index) => ({
        extensionId: pkg.extensionId,
        version: pkg.version,
        installMode: 'required',
        sortOrder: index,
        enabled: true,
      })),
      profileCount: selectedProfileIds.length,
      packageCount: bindPackages.length,
    };

    try {
      const impact = await collectRunningProfileImpact(payload.profileIds);
      if (impact.destroyedBrowsers > 0) {
        setPendingBatchAction({
          type: 'bind',
          payload,
          impact,
        });
        return;
      }
      await submitBatchBind(payload);
    } catch (error) {
      toast.error('批量绑定失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  const handleBatchUnbind = async () => {
    if (selectedProfileIds.length === 0) {
      toast.warning('请至少选择一个扩展环境');
      return;
    }

    const extensionIds = Array.from(new Set(selectedPackages.map((pkg) => pkg.extensionId)));
    if (extensionIds.length === 0) {
      toast.warning('请至少选择一个扩展包');
      return;
    }

    try {
      const payload: BatchUnbindPayload = {
        profileIds: [...selectedProfileIds],
        extensionIds,
        removePackageWhenUnused,
      };
      const impact = await collectRunningProfileImpact(payload.profileIds);
      if (impact.destroyedBrowsers > 0) {
        setPendingBatchAction({
          type: 'unbind',
          payload,
          impact,
        });
        return;
      }
      await submitBatchUnbind(payload);
    } catch (error) {
      toast.error('批量解绑失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  const handleConfirmPendingAction = async () => {
    if (!pendingBatchAction) return;
    if (pendingBatchAction.type === 'bind') {
      await submitBatchBind(pendingBatchAction.payload);
      return;
    }
    await submitBatchUnbind(pendingBatchAction.payload);
  };

  const handleRefreshPackages = useCallback(() => {
    void refreshPackages().catch((error) => {
      toast.error('刷新扩展仓库失败', error instanceof Error ? error.message : '未知错误');
    });
  }, [refreshPackages]);

  const handleRefreshCloudCatalog = useCallback(() => {
    void refreshCloudCatalog(cloudKeyword, true);
  }, [cloudKeyword, refreshCloudCatalog]);

  const confirmDescription = useMemo(() => {
    if (!pendingBatchAction) return '';
    const profilesText = pendingBatchAction.impact.affectedProfiles
      .map((item) => `${item.profileName} (${item.browserCount} 个实例)`)
      .join('、');
    const actionText = pendingBatchAction.type === 'bind' ? '更新扩展绑定' : '移除扩展绑定';
    return `继续后将关闭 ${pendingBatchAction.impact.destroyedBrowsers} 个运行中实例以${actionText}：${profilesText}。`;
  }, [pendingBatchAction]);

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">扩展中心</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
            支持环境 {extensionProfiles.length}
          </span>
          <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
            仓库 {packages.length}
          </span>
          <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
            已选包 {selectedPackages.length}
          </span>
        </div>
      </div>

      <div className="shell-tab-strip self-start">
        <button
          type="button"
          className={cn('shell-tab-button', tab === 'repository' && 'shell-tab-button--active')}
          onClick={() => setTab('repository')}
          aria-pressed={tab === 'repository'}
        >
          仓库
        </button>
        <button
          type="button"
          className={cn('shell-tab-button', tab === 'binding' && 'shell-tab-button--active')}
          onClick={() => setTab('binding')}
          aria-pressed={tab === 'binding'}
        >
          批量绑定
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-[20px] border border-[rgba(214,221,234,0.92)] bg-[linear-gradient(180deg,rgba(248,250,254,0.98),rgba(255,255,255,0.98))] p-4 shadow-[0_12px_28px_rgba(20,27,45,0.06)]">
        <div className="h-full overflow-auto">
          {featureUnavailableMessage ? (
            <div className="flex h-full min-h-[280px] items-center justify-center rounded-[18px] border border-dashed border-amber-300 bg-amber-50/80 p-6 text-center">
              <div className="max-w-xl space-y-2">
                <h3 className="text-sm font-semibold text-amber-950">扩展中心当前不可用</h3>
                <p className="text-sm leading-6 text-amber-900">{featureUnavailableMessage}</p>
              </div>
            </div>
          ) : tab === 'repository' ? (
            <ExtensionPackagesRepositoryTab
              isLoading={isLoading}
              isWorking={isWorking}
              isLoadingCloudCatalog={isLoadingCloudCatalog}
              localImportPaths={localImportPaths}
              onSelectLocalDirectories={() => void handleSelectLocalDirectories()}
              onSelectLocalArchives={() => void handleSelectLocalArchives()}
              onClearLocalImportPaths={() => setLocalImportPaths([])}
              onImportLocal={() => void handleImportLocal()}
              cloudLoggedIn={cloudReady}
              cloudCatalogAvailable={cloudCatalogAvailable}
              cloudCapabilityState={cloudCatalogCapabilities}
              cloudKeyword={cloudKeyword}
              onCloudKeywordChange={setCloudKeyword}
              onRefreshCloudCatalog={handleRefreshCloudCatalog}
              onSelectAllCloudItems={selectAllCloudItems}
              onClearCloudSelection={clearCloudSelection}
              cloudCatalogItems={cloudCatalogItems}
              selectedCloudExtensionIds={selectedCloudExtensionIds}
              onToggleCloudSelection={toggleCloudSelection}
              onDownloadSelectedCloud={() => void handleDownloadSelectedCloud()}
              canSelectCloudItem={canSelectCloudItem}
              packages={packages}
              selectedPackageKeys={selectedPackageKeys}
              selectedPackagesCount={selectedPackages.length}
              onTogglePackageSelection={togglePackageSelection}
              onSelectAllPackages={selectAllPackages}
              onClearPackageSelection={clearPackageSelection}
              onRefreshPackages={handleRefreshPackages}
            />
          ) : (
            <ExtensionPackagesBindingTab
              isLoading={isLoading}
              isWorking={isWorking}
              extensionProfiles={extensionProfiles}
              selectedProfileIds={selectedProfileIds}
              selectedProfileCount={selectedProfileItems.length}
              selectedPackagesCount={selectedPackages.length}
              removePackageWhenUnused={removePackageWhenUnused}
              onSelectAllProfiles={selectAllProfiles}
              onClearProfileSelection={clearProfileSelection}
              onToggleProfileSelection={toggleProfileSelection}
              onBatchBind={() => void handleBatchBind()}
              onBatchUnbind={() => void handleBatchUnbind()}
              onRemovePackageWhenUnusedChange={setRemovePackageWhenUnused}
              previewProfileId={previewProfileId}
              onPreviewProfileChange={setPreviewProfileId}
              previewBindings={previewBindings}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingBatchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingBatchAction(null);
          }
        }}
        title="检测到运行中实例"
        description={confirmDescription}
        confirmText="继续并关闭实例"
        cancelText="取消"
        variant="danger"
        loading={isWorking}
        onConfirm={() => void handleConfirmPendingAction()}
      />
    </div>
  );
}

