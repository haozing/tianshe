import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2, Monitor, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cn } from '../../lib/utils';
import { toast } from '../../lib/toast';
import type { BrowserProfile, PoolBrowserInfo } from '../../../../types/profile';

interface RunningBrowsersPanelProps {
  profiles: BrowserProfile[];
  visibleProfileIds: string[];
  refreshToken: number;
  onChanged?: () => void;
}

const statusLabels: Record<PoolBrowserInfo['status'], string> = {
  creating: '创建中',
  idle: '空闲',
  locked: '使用中',
  destroying: '销毁中',
};

const statusDot: Record<PoolBrowserInfo['status'], string> = {
  creating: 'bg-amber-500',
  idle: 'bg-slate-400',
  locked: 'bg-emerald-500',
  destroying: 'bg-red-500',
};

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function shortId(id: string): string {
  if (!id) return '-';
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

const statusPriority: Record<PoolBrowserInfo['status'], number> = {
  locked: 0,
  idle: 1,
  creating: 2,
  destroying: 3,
};

function canOpenBrowser(browser: PoolBrowserInfo): boolean {
  if (browser.status !== 'idle' && browser.status !== 'locked') {
    return false;
  }
  if (browser.engine === 'electron' && !browser.viewId) {
    return false;
  }
  return true;
}

function getOpenTitle(browser: PoolBrowserInfo): string {
  if (browser.status === 'creating') return '创建中，暂不可打开';
  if (browser.status === 'destroying') return '销毁中，暂不可打开';
  if (browser.engine === 'electron' && !browser.viewId) return '视图未就绪，暂不可打开';
  return browser.engine === 'electron' ? '打开' : '前置窗口';
}

export function RunningBrowsersPanel({
  profiles,
  visibleProfileIds,
  refreshToken,
  onChanged,
}: RunningBrowsersPanelProps) {
  const [browsers, setBrowsers] = useState<PoolBrowserInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingBrowserIds, setActingBrowserIds] = useState<Set<string>>(new Set());
  const [openingBrowserIds, setOpeningBrowserIds] = useState<Set<string>>(new Set());
  const [destroyTarget, setDestroyTarget] = useState<PoolBrowserInfo | null>(null);
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);

  const profileNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of profiles) {
      map[p.id] = p.name;
    }
    return map;
  }, [profiles]);

  const visibleProfileIdsKey = useMemo(() => {
    return Array.from(
      new Set(
        (Array.isArray(visibleProfileIds) ? visibleProfileIds : [])
          .map((id) => String(id).trim())
          .filter((id) => id.length > 0)
      )
    )
      .sort()
      .join('|');
  }, [visibleProfileIds]);

  const normalizedVisibleProfileIds = useMemo(
    () => (visibleProfileIdsKey ? visibleProfileIdsKey.split('|') : []),
    [visibleProfileIdsKey]
  );

  const visibleIdSet = useMemo(
    () => new Set(normalizedVisibleProfileIds),
    [normalizedVisibleProfileIds]
  );

  const visibleBrowsers = useMemo(() => {
    return browsers
      .filter((b) => visibleIdSet.has(b.sessionId))
      .sort(
        (a, b) =>
          statusPriority[a.status] - statusPriority[b.status] || b.lastAccessedAt - a.lastAccessedAt
      );
  }, [browsers, visibleIdSet]);

  const summary = useMemo(() => {
    const total = visibleBrowsers.length;
    const locked = visibleBrowsers.filter((b) => b.status === 'locked').length;
    const idle = visibleBrowsers.filter((b) => b.status === 'idle').length;
    const creating = visibleBrowsers.filter((b) => b.status === 'creating').length;
    const destroying = visibleBrowsers.filter((b) => b.status === 'destroying').length;
    return { total, locked, idle, creating, destroying };
  }, [visibleBrowsers]);

  const groupedVisibleBrowsers = useMemo(() => {
    const map = new Map<
      string,
      {
        profileId: string;
        profileName: string;
        browsers: PoolBrowserInfo[];
        summary: {
          total: number;
          locked: number;
          idle: number;
          creating: number;
          destroying: number;
        };
      }
    >();

    for (const browser of visibleBrowsers) {
      const profileId = browser.sessionId;
      let group = map.get(profileId);
      if (!group) {
        group = {
          profileId,
          profileName: profileNameById[profileId] || profileId,
          browsers: [],
          summary: {
            total: 0,
            locked: 0,
            idle: 0,
            creating: 0,
            destroying: 0,
          },
        };
        map.set(profileId, group);
      }

      group.browsers.push(browser);
      group.summary.total += 1;
      if (browser.status === 'locked') group.summary.locked += 1;
      if (browser.status === 'idle') group.summary.idle += 1;
      if (browser.status === 'creating') group.summary.creating += 1;
      if (browser.status === 'destroying') group.summary.destroying += 1;
    }

    return Array.from(map.values()).sort(
      (a, b) =>
        b.summary.locked - a.summary.locked ||
        b.summary.total - a.summary.total ||
        a.profileName.localeCompare(b.profileName, 'zh-CN')
    );
  }, [profileNameById, visibleBrowsers]);

  const hiddenByFilterCount = useMemo(
    () => Math.max(0, browsers.length - visibleBrowsers.length),
    [browsers.length, visibleBrowsers.length]
  );

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.profile.poolListBrowsers();
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      if (result.success && result.data) {
        setBrowsers(result.data);
      } else {
        setError(result.error || '加载运行中浏览器失败');
      }
    } catch (err) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setError(err instanceof Error ? err.message : '加载运行中浏览器失败');
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const handleOpen = async (browser: PoolBrowserInfo) => {
    if (!canOpenBrowser(browser)) {
      toast.warning('该实例当前不可打开', `状态：${statusLabels[browser.status]}`);
      return;
    }

    setOpeningBrowserIds((prev) => {
      const next = new Set(prev);
      next.add(browser.id);
      return next;
    });

    try {
      const profileName = profileNameById[browser.sessionId] || browser.sessionId;
      const result = await window.electronAPI.profile.poolShowBrowser(browser.id, {
        title: `浏览器 - ${profileName}`,
      });
      if (!result.success) {
        toast.error('打开/前置失败', result.error || '未知错误');
      } else {
        // 成功后刷新列表，确保最近访问时间/状态同步
        await load();
        if (result.data?.relaunched) {
          onChanged?.();
        }
      }
    } catch (err) {
      toast.error('打开/前置失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setOpeningBrowserIds((prev) => {
        const next = new Set(prev);
        next.delete(browser.id);
        return next;
      });
    }
  };

  const handleConfirmDestroy = async () => {
    if (!destroyTarget) return;
    const browser = destroyTarget;

    setActingBrowserIds((prev) => {
      const next = new Set(prev);
      next.add(browser.id);
      return next;
    });

    try {
      const result = await window.electronAPI.profile.poolRelease(browser.id, { destroy: true });
      if (!result.success) {
        toast.error('关闭失败', result.error || '未知错误');
        return;
      }

      await load();
      onChanged?.();
      setDestroyTarget(null);
    } catch (err) {
      toast.error('关闭失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setActingBrowserIds((prev) => {
        const next = new Set(prev);
        next.delete(browser.id);
        return next;
      });
    }
  };

  if (isLoading && visibleBrowsers.length === 0) {
    return (
      <div className="shell-soft-card flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="shell-soft-card p-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
              可见实例
            </div>
            <div className="mt-2 text-xl font-semibold text-slate-900">{summary.total}</div>
            <div className="mt-2 text-xs leading-5 text-slate-500">
              当前分组过滤后可见的浏览器实例数量。
            </div>
          </div>

          <div className="shell-soft-card p-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
              使用中
            </div>
            <div className="mt-2 text-xl font-semibold text-slate-900">{summary.locked}</div>
            <div className="mt-2 text-xs leading-5 text-slate-500">
              空闲 {summary.idle}，创建中 {summary.creating}，销毁中 {summary.destroying}。
            </div>
          </div>

          <div className="shell-soft-card p-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
              筛选范围
            </div>
            <div className="mt-2 text-xl font-semibold text-slate-900">
              {visibleProfileIds.length}
            </div>
            <div className="mt-2 text-xs leading-5 text-slate-500">
              {hiddenByFilterCount > 0
                ? `还有 ${hiddenByFilterCount} 个实例位于其他分组。`
                : '当前没有被左侧分组隐藏的实例。'}
            </div>
          </div>

          <div className="shell-soft-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
                  云端快照
                </div>
                <div className="mt-2 text-xl font-semibold text-slate-900">手动</div>
                <div className="mt-1 text-xs text-slate-500">环境和账号按需上传/下载。</div>
              </div>
              <Button variant="outline" size="sm" onClick={load} disabled={isLoading}>
                <RefreshCw className={cn('mr-1 h-4 w-4', isLoading && 'animate-spin')} />
                刷新
              </Button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => setError(null)}>
              关闭
            </Button>
          </div>
        ) : null}

        {visibleBrowsers.length === 0 ? (
          <div className="shell-soft-card flex h-64 flex-col items-center justify-center text-muted-foreground">
            <Monitor className="mb-4 h-12 w-12 opacity-50" />
            {browsers.length === 0 ? (
              <>
                <p>暂无运行中的浏览器实例</p>
                <p className="text-sm mt-1">你可以在“环境配置”中启动浏览器</p>
              </>
            ) : (
              <>
                <p>当前分组下暂无运行中的浏览器实例</p>
                <p className="text-sm mt-1">可切换左侧分组查看其它实例</p>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groupedVisibleBrowsers.map((group) => (
              <section key={group.profileId} className="shell-soft-card overflow-hidden p-0">
                <div className="flex items-center justify-between gap-3 border-b border-[rgba(214,221,234,0.92)] px-4 py-3">
                  <div
                    className="truncate text-sm font-semibold text-slate-900"
                    title={group.profileName}
                  >
                    {group.profileName}
                  </div>
                  <div className="flex-shrink-0 text-right text-xs text-slate-500">
                    {group.summary.total} 个实例（使用中 {group.summary.locked} / 空闲{' '}
                    {group.summary.idle}
                    {group.summary.creating > 0 ? ` / 创建中 ${group.summary.creating}` : ''}
                    {group.summary.destroying > 0 ? ` / 销毁中 ${group.summary.destroying}` : ''}）
                  </div>
                </div>

                <div className="flex flex-col gap-2 p-3">
                  {group.browsers.map((browser) => {
                    const isOpening = openingBrowserIds.has(browser.id);
                    const isActing = actingBrowserIds.has(browser.id);
                    const openDisabled = isOpening || isActing || !canOpenBrowser(browser);
                    const lockInfo =
                      browser.status === 'locked' && browser.lockedBy
                        ? `${browser.lockedBy.source}${browser.lockedBy.pluginId ? `/${browser.lockedBy.pluginId}` : ''}`
                        : null;

                    return (
                      <div
                        key={browser.id}
                        className={cn(
                          'rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/78 px-4 py-3 transition-shadow hover:shadow-[0_16px_32px_rgba(20,27,45,0.08)]',
                          'flex items-center gap-4'
                        )}
                      >
                        <div
                          className={cn(
                            'w-2 h-2 rounded-full flex-shrink-0',
                            statusDot[browser.status]
                          )}
                          title={statusLabels[browser.status]}
                        />

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-medium truncate" title={browser.id}>
                              Browser {shortId(browser.id)}
                            </span>
                            <span className="text-xs text-muted-foreground flex-shrink-0">
                              {statusLabels[browser.status]}
                            </span>
                            {lockInfo && (
                              <span
                                className="text-xs text-muted-foreground truncate"
                                title={lockInfo}
                              >
                                · {lockInfo}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            Engine {browser.engine}
                            {browser.viewId ? ` · View ${shortId(browser.viewId)}` : ''}
                          </div>
                        </div>

                        <div className="text-xs text-muted-foreground flex-shrink-0 hidden lg:block w-52 text-right">
                          <div title={formatTime(browser.createdAt)}>
                            创建: {formatTime(browser.createdAt)}
                          </div>
                          <div title={formatTime(browser.lastAccessedAt)}>
                            最近: {formatTime(browser.lastAccessedAt)}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleOpen(browser)}
                            disabled={openDisabled}
                            title={getOpenTitle(browser)}
                          >
                            {isOpening ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <ExternalLink className="w-4 h-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => setDestroyTarget(browser)}
                            disabled={isActing || browser.status === 'destroying'}
                            title="关闭（销毁）"
                          >
                            {isActing ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!destroyTarget}
        onOpenChange={(open) => !open && setDestroyTarget(null)}
        title="确认关闭浏览器实例"
        description={
          destroyTarget
            ? `确定关闭该浏览器实例吗？Profile: ${profileNameById[destroyTarget.sessionId] || destroyTarget.sessionId}，Browser: ${destroyTarget.id}`
            : ''
        }
        confirmText="关闭实例"
        cancelText="取消"
        variant="danger"
        loading={!!destroyTarget && actingBrowserIds.has(destroyTarget.id)}
        onConfirm={handleConfirmDestroy}
      />
    </>
  );
}
