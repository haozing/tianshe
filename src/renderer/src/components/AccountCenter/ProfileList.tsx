/**
 * ProfileList - 浏览器配置列表
 * 显示浏览器配置列表，支持 Grid/List 视图，并可直接启动浏览器实例（BrowserPool）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Monitor,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Wifi,
  WifiOff,
  Shield,
  Play,
  Upload,
  CloudOff,
} from 'lucide-react';
import { useProfileStore } from '../../stores/profileStore';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn } from '../../lib/utils';
import { toast } from '../../lib/toast';
import type { AutomationEngine, BrowserProfile, PoolBrowserInfo } from '../../../../types/profile';

interface ProfileListProps {
  profiles: BrowserProfile[];
  viewMode: 'grid' | 'list';
  isLoading: boolean;
  cloudEnabled: boolean;
  cloudActionProfileId: string | null;
  onPushCloud: (id: string) => void;
  onDeleteCloud: (id: string) => void;
  onEdit: (id: string) => void;
  onProfileDataChanged?: (options?: { refreshRunning?: boolean }) => Promise<void> | void;
  onProfileMutationApplied?: () => Promise<void> | void;
}

interface ProfileCardProps {
  profile: BrowserProfile;
  variant: 'card' | 'list';
  cloudEnabled: boolean;
  cloudActionProfileId: string | null;
  runtimeSummary?: ProfileRuntimeSummary;
  hasLoadedRuntimeState: boolean;
  onPushCloud: (id: string) => void;
  onDeleteCloud: (id: string) => void;
  onEdit: () => void;
  onProfileDataChanged?: (options?: { refreshRunning?: boolean }) => Promise<void> | void;
  onProfileMutationApplied?: () => Promise<void> | void;
}

interface ProfileRuntimeSummary {
  total: number;
  locked: number;
  idle: number;
  creating: number;
  destroying: number;
}

type ProfileVisualStatus = 'idle' | 'started' | 'locked' | 'creating' | 'destroying' | 'error';

const statusColors: Record<ProfileVisualStatus, string> = {
  idle: 'bg-slate-400',
  started: 'bg-sky-500',
  locked: 'bg-emerald-500',
  creating: 'bg-amber-500',
  destroying: 'bg-rose-500',
  error: 'bg-red-500',
};

const statusLabels: Record<ProfileVisualStatus, string> = {
  idle: '空闲',
  started: '空闲实例',
  locked: '使用中',
  creating: '创建中',
  destroying: '销毁中',
  error: '错误',
};

const accentBorders: Partial<Record<ProfileVisualStatus, string>> = {
  started: 'border-sky-300/80',
  locked: 'border-emerald-300/80',
  creating: 'border-amber-300/80',
  destroying: 'border-rose-300/80',
  error: 'border-red-300/80',
};

function summarizeRuntimeByProfile(browsers: PoolBrowserInfo[]): Record<string, ProfileRuntimeSummary> {
  const summaryByProfileId: Record<string, ProfileRuntimeSummary> = {};

  for (const browser of browsers) {
    const current = summaryByProfileId[browser.sessionId] || {
      total: 0,
      locked: 0,
      idle: 0,
      creating: 0,
      destroying: 0,
    };
    current.total += 1;
    if (browser.status === 'locked') current.locked += 1;
    if (browser.status === 'idle') current.idle += 1;
    if (browser.status === 'creating') current.creating += 1;
    if (browser.status === 'destroying') current.destroying += 1;
    summaryByProfileId[browser.sessionId] = current;
  }

  return summaryByProfileId;
}

function resolveProfileVisualStatus(
  profile: BrowserProfile,
  runtimeSummary: ProfileRuntimeSummary | undefined,
  hasLoadedRuntimeState: boolean
): {
  key: ProfileVisualStatus;
  label: string;
  hasLiveBrowser: boolean;
  canActivateExistingBrowser: boolean;
} {
  if (runtimeSummary && runtimeSummary.total > 0) {
    if (runtimeSummary.locked > 0) {
      return {
        key: 'locked',
        label: statusLabels.locked,
        hasLiveBrowser: true,
        canActivateExistingBrowser: true,
      };
    }

    if (runtimeSummary.idle > 0) {
      return {
        key: 'started',
        label: statusLabels.started,
        hasLiveBrowser: true,
        canActivateExistingBrowser: true,
      };
    }

    if (runtimeSummary.creating > 0) {
      return {
        key: 'creating',
        label: statusLabels.creating,
        hasLiveBrowser: true,
        canActivateExistingBrowser: false,
      };
    }

    return {
      key: 'destroying',
      label: statusLabels.destroying,
      hasLiveBrowser: true,
      canActivateExistingBrowser: false,
    };
  }

  if (profile.status === 'error') {
    return {
      key: 'error',
      label: statusLabels.error,
      hasLiveBrowser: false,
      canActivateExistingBrowser: false,
    };
  }

  if (!hasLoadedRuntimeState && profile.status === 'active') {
    return {
      key: 'started',
      label: statusLabels.started,
      hasLiveBrowser: true,
      canActivateExistingBrowser: true,
    };
  }

  return {
    key: 'idle',
    label: statusLabels.idle,
    hasLiveBrowser: false,
    canActivateExistingBrowser: false,
  };
}

function ProfileCard({
  profile,
  variant,
  cloudEnabled,
  cloudActionProfileId,
  runtimeSummary,
  hasLoadedRuntimeState,
  onPushCloud,
  onDeleteCloud,
  onEdit,
  onProfileDataChanged,
  onProfileMutationApplied,
}: ProfileCardProps) {
  const deleteProfile = useProfileStore((state) => state.deleteProfile);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const engine: AutomationEngine = profile.engine;
  const engineLabel =
    engine === 'extension' ? 'Extension' : engine === 'ruyi' ? 'Ruyi' : 'Electron';
  const cloudActionBusy = cloudActionProfileId === profile.id;
  const visualStatus = resolveProfileVisualStatus(profile, runtimeSummary, hasLoadedRuntimeState);
  const isCreatingOrDestroying =
    visualStatus.key === 'creating' || visualStatus.key === 'destroying';

  const handleDelete = async () => {
    if (profile.isSystem) {
      toast.warning('系统配置不可删除');
      return;
    }

    if (visualStatus.hasLiveBrowser) {
      toast.warning(`浏览器实例${visualStatus.label}，请先关闭浏览器实例`);
      return;
    }

    setIsDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    setIsDeleting(true);
    try {
      const deleted = await deleteProfile(profile.id);
      if (deleted) {
        await onProfileMutationApplied?.();
      }
    } catch (error) {
      console.error('[ProfileList] Failed to delete profile:', error);
      toast.error('删除失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setIsDeleteConfirmOpen(false);
      setIsDeleting(false);
    }
  };

  const launchWithOptions = async (launchOptions?: {
    strategy?: 'any' | 'fresh' | 'reuse' | 'specific';
    browserId?: string;
  }) => {
    setIsLaunching(true);
    try {
      const result = await window.electronAPI.profile.poolLaunch(profile.id, {
        strategy: launchOptions?.strategy || 'reuse',
        browserId: launchOptions?.browserId,
        timeout: 30000,
        engine,
      });
      if (!result.success) {
        toast.error('启动失败', result.error || '未知错误');
        return;
      }

      await onProfileDataChanged?.({ refreshRunning: true });
    } catch (error) {
      console.error('[ProfileList] Failed to launch profile browser:', error);
      toast.error('启动失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setIsLaunching(false);
    }
  };

  const activateExistingBrowser = async (): Promise<boolean> => {
    const listResult = await window.electronAPI.profile.poolListBrowsers();
    if (!listResult.success || !listResult.data) {
      return false;
    }

    const running = listResult.data
      .filter((item) => item.sessionId === profile.id && item.engine === engine)
      .sort((a, b) => {
        const scoreA = a.status === 'locked' ? 2 : a.status === 'idle' ? 1 : 0;
        const scoreB = b.status === 'locked' ? 2 : b.status === 'idle' ? 1 : 0;
        return scoreB - scoreA || b.lastAccessedAt - a.lastAccessedAt;
      })[0];

    if (!running) {
      return false;
    }

    const showResult = await window.electronAPI.profile.poolShowBrowser(running.id, {
      title: `浏览器 - ${profile.name}`,
    });
    return showResult.success;
  };

  const handleLaunch = async () => {
    if (visualStatus.key === 'creating') {
      toast.info('浏览器创建中', '请等待实例就绪后再前置窗口');
      return;
    }

    if (visualStatus.key === 'destroying') {
      toast.warning('浏览器销毁中', '请等待实例关闭完成后再重新启动');
      return;
    }

    if (visualStatus.canActivateExistingBrowser) {
      try {
        const activated = await activateExistingBrowser();
        if (activated) {
          await onProfileDataChanged?.({ refreshRunning: true });
          return;
        }
      } catch (error) {
        console.warn(
          '[ProfileList] Failed to activate existing persistent browser, fallback to launch:',
          error
        );
      }
    }
    await launchWithOptions();
  };

  const getProxyInfo = () => {
    if (!profile.proxy || profile.proxy.type === 'none') {
      return null;
    }
    return `${profile.proxy.type.toUpperCase()} ${profile.proxy.host}:${profile.proxy.port}`;
  };

  const getFingerprintSummary = () => {
    const fp = profile.fingerprint;
    const parts: string[] = [];
    const os =
      fp.identity.hardware.osFamily === 'macos'
        ? 'macOS'
        : fp.identity.hardware.osFamily === 'linux'
          ? 'Linux'
          : 'Windows';
    const browser =
      fp.identity.hardware.browserFamily === 'firefox'
        ? 'Firefox'
        : fp.identity.hardware.userAgent.includes('Edg/')
          ? 'Edge'
          : 'Chrome';
    if (os) parts.push(os);
    if (browser) parts.push(browser);
    if (parts.length) return parts.join(' / ');

    const ua = fp.identity.hardware.userAgent || '';
    const inferredOs = ua.includes('Windows')
      ? 'Windows'
      : ua.includes('Mac')
        ? 'macOS'
        : ua.includes('Linux')
          ? 'Linux'
          : '';
    const inferredBrowser = ua.includes('Edg/')
      ? 'Edge'
      : ua.includes('Firefox/')
        ? 'Firefox'
        : ua
          ? 'Chrome'
          : '';
    if (inferredOs && inferredBrowser) return `${inferredOs} / ${inferredBrowser}`;
    if (inferredOs) return inferredOs;
    if (inferredBrowser) return inferredBrowser;
    return 'Windows / Chrome';
  };

  const proxyInfo = getProxyInfo();
  const actionLabel = visualStatus.canActivateExistingBrowser ? '前置窗口' : '启动浏览器';

  if (variant === 'card') {
    return (
      <>
        <div
          className={cn(
            'shell-soft-card flex flex-col gap-4 p-5 transition-shadow hover:shadow-[0_16px_32px_rgba(20,27,45,0.08)]',
            accentBorders[visualStatus.key]
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {profile.color ? (
                  <div
                    className="h-3 w-3 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: profile.color }}
                  />
                ) : (
                  <Monitor className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                )}
                <h3 className="truncate text-sm font-semibold text-slate-900" title={profile.name}>
                  {profile.name}
                </h3>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                  <span className={cn('h-2 w-2 rounded-full', statusColors[visualStatus.key])} />
                  {visualStatus.label}
                </span>
                <span className="inline-flex rounded-full border border-sky-100 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700">
                  {engineLabel}
                </span>
                {runtimeSummary && runtimeSummary.total > 0 ? (
                  <span className="inline-flex rounded-full border border-slate-200 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-500">
                    实例 {runtimeSummary.total}
                  </span>
                ) : null}
                {cloudEnabled && cloudActionBusy ? (
                  <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                    云端同步中
                  </span>
                ) : null}
              </div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void handleLaunch()} disabled={isLaunching}>
                  <Play className="mr-2 h-4 w-4" />
                  Launch {engineLabel}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="mr-2 h-4 w-4" />
                  编辑
                </DropdownMenuItem>
                {cloudEnabled ? (
                  <>
                    <DropdownMenuItem
                      onClick={() => onPushCloud(profile.id)}
                      disabled={cloudActionBusy}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      推送到云端
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => onDeleteCloud(profile.id)}
                      disabled={cloudActionBusy}
                    >
                      <CloudOff className="mr-2 h-4 w-4" />
                      删除云端版本
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={handleDelete}
                  disabled={isDeleting || profile.isSystem}
                >
                  {isDeleting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              <span className="truncate">{getFingerprintSummary()}</span>
            </div>
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4" />
              <span className="truncate">Engine: {engineLabel}</span>
            </div>

            <div className="flex items-center gap-2">
              {proxyInfo ? (
                <>
                  <Wifi className="h-4 w-4" />
                  <span className="truncate text-xs">{proxyInfo}</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-4 w-4 opacity-50" />
                  <span className="text-xs opacity-50">无代理</span>
                </>
              )}
            </div>
          </div>

          {profile.notes ? (
            <div
              className="rounded-2xl border border-white/70 bg-white/60 px-3 py-3 text-xs leading-5 text-slate-500"
              title={profile.notes}
            >
              {profile.notes}
            </div>
          ) : null}

          <div className="flex gap-2 border-t border-white/70 pt-1">
            <Button
              variant={visualStatus.canActivateExistingBrowser ? 'outline' : 'default'}
              size="sm"
              className="w-full"
              onClick={() => void handleLaunch()}
              disabled={isLaunching || isCreatingOrDestroying}
            >
              {isLaunching ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              {actionLabel}
            </Button>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>使用 {profile.totalUses} 次</span>
            <span>创建于: {new Date(profile.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        <ConfirmDialog
          open={isDeleteConfirmOpen}
          onOpenChange={setIsDeleteConfirmOpen}
          title="删除浏览器环境"
          description={`确定要删除浏览器配置“${profile.name}”吗？删除后账号会保留，但 accounts.profile_id 会被清空，需要在账号中心中重新绑定环境。`}
          confirmText="删除"
          cancelText="取消"
          variant="danger"
          loading={isDeleting}
          onConfirm={() => void confirmDelete()}
        />
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          'shell-soft-card px-4 py-3 transition-shadow hover:shadow-[0_16px_32px_rgba(20,27,45,0.08)]',
          'flex items-center gap-4',
          accentBorders[visualStatus.key]
        )}
      >
        {profile.color ? (
          <div
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: profile.color }}
          />
        ) : (
          <Monitor className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}

        <div
          className={cn('h-2 w-2 flex-shrink-0 rounded-full', statusColors[visualStatus.key])}
          title={visualStatus.label}
        />

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium text-slate-900">{profile.name}</h3>
            <span className="inline-flex rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] text-slate-600">
              {engineLabel}
            </span>
            <span className="inline-flex rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] text-slate-600">
              {visualStatus.label}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{getFingerprintSummary()}</span>
            {proxyInfo && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span className="truncate">{proxyInfo}</span>
              </>
            )}
          </div>
        </div>

        <div className="hidden w-16 flex-shrink-0 text-right text-sm text-muted-foreground lg:block">
          {profile.totalUses} 次
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => void handleLaunch()}
            disabled={isLaunching || isCreatingOrDestroying}
            title={actionLabel}
          >
            {isLaunching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} title="编辑">
            <Pencil className="w-4 h-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="更多">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void handleLaunch()} disabled={isLaunching}>
                <Play className="w-4 h-4 mr-2" />
                {actionLabel}
              </DropdownMenuItem>
              {cloudEnabled ? (
                <>
                  <DropdownMenuItem
                    onClick={() => onPushCloud(profile.id)}
                    disabled={cloudActionBusy}
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    推送到云端
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onDeleteCloud(profile.id)}
                    disabled={cloudActionBusy}
                  >
                    <CloudOff className="w-4 h-4 mr-2" />
                    删除云端版本
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={handleDelete}
                disabled={isDeleting || profile.isSystem}
              >
                {isDeleting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4 mr-2" />
                )}
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ConfirmDialog
        open={isDeleteConfirmOpen}
        onOpenChange={setIsDeleteConfirmOpen}
        title="删除浏览器环境"
        description={`确定要删除浏览器配置“${profile.name}”吗？删除后账号会保留，但 accounts.profile_id 会被清空，需要在账号中心中重新绑定环境。`}
        confirmText="删除"
        cancelText="取消"
        variant="danger"
        loading={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

export function ProfileList({
  profiles,
  viewMode,
  isLoading,
  cloudEnabled,
  cloudActionProfileId,
  onPushCloud,
  onDeleteCloud,
  onEdit,
  onProfileDataChanged,
  onProfileMutationApplied,
}: ProfileListProps) {
  const [runtimeSummaryByProfileId, setRuntimeSummaryByProfileId] = useState<
    Record<string, ProfileRuntimeSummary>
  >({});
  const [hasLoadedRuntimeState, setHasLoadedRuntimeState] = useState(false);
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const profileIdsKey = useMemo(
    () =>
      Array.from(new Set(profiles.map((profile) => profile.id)))
        .sort()
        .join('|'),
    [profiles]
  );

  const loadRuntimeSummary = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!profileIdsKey) {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setRuntimeSummaryByProfileId({});
        setHasLoadedRuntimeState(true);
      }
      return;
    }

    let loadedSuccessfully = false;
    try {
      const result = await window.electronAPI.profile.poolListBrowsers();
      if (!mountedRef.current || seq !== loadSeqRef.current) return;

      if (result.success && result.data) {
        setRuntimeSummaryByProfileId(summarizeRuntimeByProfile(result.data));
        loadedSuccessfully = true;
      } else {
        setRuntimeSummaryByProfileId({});
      }
    } catch {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setRuntimeSummaryByProfileId({});
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setHasLoadedRuntimeState(loadedSuccessfully);
      }
    }
  }, [profileIdsKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setHasLoadedRuntimeState(false);
    void loadRuntimeSummary();
  }, [loadRuntimeSummary]);

  if (isLoading && profiles.length === 0) {
    return (
      <div className="shell-soft-card flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="shell-soft-card flex h-64 flex-col items-center justify-center text-muted-foreground">
        <Monitor className="mb-4 h-12 w-12 opacity-50" />
        <p>暂无浏览器配置</p>
        <p className="text-sm mt-1">点击“添加浏览器”创建第一个配置</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        viewMode === 'grid'
          ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'
          : 'flex flex-col gap-2'
      )}
    >
      {profiles.map((profile) => (
        <ProfileCard
          key={profile.id}
          profile={profile}
          variant={viewMode === 'grid' ? 'card' : 'list'}
          cloudEnabled={cloudEnabled}
          cloudActionProfileId={cloudActionProfileId}
          runtimeSummary={runtimeSummaryByProfileId[profile.id]}
          hasLoadedRuntimeState={hasLoadedRuntimeState}
          onPushCloud={onPushCloud}
          onDeleteCloud={onDeleteCloud}
          onEdit={() => onEdit(profile.id)}
          onProfileDataChanged={onProfileDataChanged}
          onProfileMutationApplied={onProfileMutationApplied}
        />
      ))}
    </div>
  );
}
