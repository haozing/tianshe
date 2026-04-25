import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  CircleAlert,
  Clock3,
  House,
  Trash2,
  Package,
  Cloud,
  HardDrive,
  Square,
  Power,
  PowerOff,
  Settings,
  RefreshCw,
  Wrench,
  FolderOpen,
  Zap,
  ZapOff,
  MoreVertical,
  Search,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Progress } from '../ui/progress';
import { SimpleDropdownMenu } from '../ui/dropdown-menu';
import { usePluginStore, type JSPlugin } from '../../stores/pluginStore';
import { usePluginRuntimeStore } from '../../stores/pluginRuntimeStore';
import { renderStringIcon } from '../../lib/string-icon';
import { cn } from '../../lib/utils';
import { UninstallPluginDialog } from './UninstallPluginDialog';
import { PluginConfigDialog } from './PluginConfigDialog';
import { CloudPluginCatalogPanel } from './CloudPluginCatalogPanel';
import { PageFrameHeader } from '../layout/PageFrameHeader';
import type { JSPluginRuntimeStatus } from '../../../../types/js-plugin';
import { isCloudCatalogAvailable } from '../../lib/edition';

type AppInfoState = {
  loading: boolean;
  shouldShowDevOptions: boolean;
  isPackaged: boolean;
};

type InstallMode = 'archive' | 'dev' | null;

type PluginRuntimeRow = {
  plugin: JSPlugin;
  runtimeStatus?: JSPluginRuntimeStatus;
  runtimeLabel: string;
  runtimeSummary: string | null;
  canCancelTasks: boolean;
  lastActivityAt: string | null;
  updatedAt: string | null;
};

function matchesPluginSearch(plugin: JSPlugin, searchQuery: string): boolean {
  const keyword = searchQuery.trim().toLowerCase();
  if (!keyword) return true;

  return [
    plugin.id,
    plugin.name,
    plugin.author,
    plugin.description,
    plugin.category,
    plugin.cloudPluginCode,
  ].some((value) =>
    String(value || '')
      .toLowerCase()
      .includes(keyword)
  );
}

function isCloudManagedPlugin(plugin: JSPlugin): boolean {
  return plugin.sourceType === 'cloud_managed';
}

function getSourceChipClassName(plugin: JSPlugin): string {
  return isCloudManagedPlugin(plugin)
    ? 'shell-field-chip--accent'
    : 'border-emerald-200/80 bg-emerald-50 text-emerald-700';
}

function getSourceBadgeLabel(plugin: JSPlugin): string {
  return isCloudManagedPlugin(plugin) ? '云托管' : '本地私有';
}

function getPluginSourceSummary(plugin: JSPlugin): string {
  const installChannel = plugin.installChannel === 'cloud_download' ? '云端下载' : '手动导入';
  return `来源：${getSourceBadgeLabel(plugin)} · 渠道：${installChannel}`;
}

function getPluginDevSummary(plugin: JSPlugin): string | null {
  if (!plugin.devMode) return null;
  const installMode = plugin.isSymlink ? '符号链接' : '复制模式';
  const hotReload = plugin.hotReloadEnabled ? '热重载已启用' : '热重载未启用';
  return `开发模式：${installMode} · ${hotReload}`;
}

function formatRuntimeTimestamp(timestamp?: number): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(timestamp).toLocaleString('zh-CN');
}

function getPluginRuntimeLabel(plugin: JSPlugin, runtimeStatus?: JSPluginRuntimeStatus): string {
  if (plugin.enabled === false) {
    return '已禁用';
  }

  if (!runtimeStatus) {
    return '未启动';
  }

  if (runtimeStatus.lifecyclePhase === 'error' || runtimeStatus.workState === 'error') {
    return '异常';
  }

  if (runtimeStatus.lifecyclePhase === 'starting') {
    return '启动中';
  }

  if (runtimeStatus.lifecyclePhase === 'stopping') {
    return '停止中';
  }

  if (runtimeStatus.workState === 'busy') {
    return runtimeStatus.runningTasks > 0 ? '运行中' : '排队中';
  }

  if (runtimeStatus.lifecyclePhase === 'active') {
    return '空闲';
  }

  return '未启动';
}

function getPluginRuntimeChipClassName(
  plugin: JSPlugin,
  runtimeStatus?: JSPluginRuntimeStatus
): string {
  const runtimeLabel = getPluginRuntimeLabel(plugin, runtimeStatus);

  switch (runtimeLabel) {
    case '运行中':
    case '排队中':
      return 'border-blue-200/80 bg-blue-50 text-blue-700';
    case '空闲':
      return 'border-emerald-200/80 bg-emerald-50 text-emerald-700';
    case '启动中':
    case '停止中':
      return 'border-amber-200/80 bg-amber-50 text-amber-700';
    case '异常':
      return 'border-red-200/80 bg-red-50 text-red-700';
    case '已禁用':
      return 'border-slate-200/80 bg-slate-100 text-slate-600';
    default:
      return 'border-slate-200/80 bg-slate-50 text-slate-600';
  }
}

function getPluginRuntimeSummary(runtimeStatus?: JSPluginRuntimeStatus): string | null {
  if (!runtimeStatus) {
    return null;
  }

  if (runtimeStatus.lastError?.message) {
    return runtimeStatus.lastError.message;
  }

  if (runtimeStatus.currentSummary) {
    return runtimeStatus.currentSummary;
  }

  if (runtimeStatus.runningTasks > 0 || runtimeStatus.pendingTasks > 0) {
    return `运行 ${runtimeStatus.runningTasks} · 排队 ${runtimeStatus.pendingTasks}`;
  }

  if (runtimeStatus.failedTasks > 0 || runtimeStatus.cancelledTasks > 0) {
    return `失败 ${runtimeStatus.failedTasks} · 已取消 ${runtimeStatus.cancelledTasks}`;
  }

  if (runtimeStatus.lifecyclePhase === 'active') {
    return '插件已激活，当前空闲';
  }

  if (runtimeStatus.lifecyclePhase === 'starting') {
    return '正在初始化插件';
  }

  if (runtimeStatus.lifecyclePhase === 'stopping') {
    return '正在停止插件';
  }

  return '插件尚未激活';
}

function hasCancelableTasks(runtimeStatus?: JSPluginRuntimeStatus): boolean {
  if (!runtimeStatus) {
    return false;
  }

  return runtimeStatus.runningTasks > 0 || runtimeStatus.pendingTasks > 0;
}

function getPluginRuntimeSortWeight(
  plugin: JSPlugin,
  runtimeStatus?: JSPluginRuntimeStatus
): number {
  const label = getPluginRuntimeLabel(plugin, runtimeStatus);

  switch (label) {
    case '异常':
      return 0;
    case '运行中':
      return 1;
    case '排队中':
      return 2;
    case '启动中':
      return 3;
    case '停止中':
      return 4;
    case '空闲':
      return 5;
    case '未启动':
      return 6;
    case '已禁用':
      return 7;
    default:
      return 8;
  }
}

export function PluginMarket() {
  const {
    plugins,
    pluginsLoading,
    searchQuery,
    expandedPlugins,
    loadPlugins,
    installPlugin,
    uninstallPlugin,
    enablePlugin,
    disablePlugin,
    reloadPlugin,
    repairPlugin,
    openPluginDirectory,
    toggleHotReload,
    setSearchQuery,
    togglePluginExpanded,
  } = usePluginStore();
  const {
    statuses: runtimeStatuses,
    loading: runtimeLoading,
    loadStatuses,
    cancelPluginTasks,
    subscribe: subscribeRuntimeStatuses,
  } = usePluginRuntimeStore();

  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);
  const [selectedPlugin, setSelectedPlugin] = useState<{ id: string; name: string } | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [selectedPluginForConfig, setSelectedPluginForConfig] = useState<JSPlugin | null>(null);
  const [activeView, setActiveView] = useState<'home' | 'catalog' | 'installed'>('home');
  const cloudCatalogAvailable = isCloudCatalogAvailable();
  const [appInfo, setAppInfo] = useState<AppInfoState>({
    loading: true,
    shouldShowDevOptions: false,
    isPackaged: false,
  });
  const [installingMode, setInstallingMode] = useState<InstallMode>(null);

  const handleUninstallClick = (pluginId: string, pluginName: string) => {
    setSelectedPlugin({ id: pluginId, name: pluginName });
    setUninstallDialogOpen(true);
  };

  const handleConfigClick = (plugin: JSPlugin) => {
    setSelectedPluginForConfig(plugin);
    setConfigDialogOpen(true);
  };

  const handleUninstallConfirm = async (deleteTables: boolean) => {
    if (!selectedPlugin) return;
    await uninstallPlugin(selectedPlugin.id, selectedPlugin.name, deleteTables);
  };

  const handleInstallPlugin = async (devMode: boolean) => {
    setInstallingMode(devMode ? 'dev' : 'archive');
    try {
      await installPlugin(devMode);
    } finally {
      setInstallingMode(null);
    }
  };

  useEffect(() => {
    void Promise.all([loadPlugins(), loadStatuses()]);
    const unsubscribe = subscribeRuntimeStatuses();
    return unsubscribe;
  }, [loadPlugins, loadStatuses, subscribeRuntimeStatuses]);

  useEffect(() => {
    if (!cloudCatalogAvailable && activeView === 'catalog') {
      setActiveView('home');
    }
  }, [activeView, cloudCatalogAvailable]);

  useEffect(() => {
    let mounted = true;

    window.electronAPI
      .getAppInfo()
      .then((result) => {
        if (!mounted) return;
        setAppInfo({
          loading: false,
          shouldShowDevOptions: result?.info?.shouldShowDevOptions ?? false,
          isPackaged: result?.info?.isPackaged ?? false,
        });
      })
      .catch(() => {
        if (!mounted) return;
        setAppInfo({
          loading: false,
          shouldShowDevOptions: false,
          isPackaged: false,
        });
      });

    return () => {
      mounted = false;
    };
  }, []);

  const filteredLocalPlugins = plugins.filter(
    (plugin) => !isCloudManagedPlugin(plugin) && matchesPluginSearch(plugin, searchQuery)
  );
  const filteredCloudPlugins = plugins.filter(
    (plugin) => isCloudManagedPlugin(plugin) && matchesPluginSearch(plugin, searchQuery)
  );
  const filteredInstalledPlugins = [...filteredLocalPlugins, ...filteredCloudPlugins];
  const canImportLocalPlugins = appInfo.shouldShowDevOptions;
  const isImporting = installingMode !== null;
  const searchKeyword = searchQuery.trim();
  const runtimeRows = [...plugins]
    .map<PluginRuntimeRow>((plugin) => {
      const runtimeStatus = runtimeStatuses[plugin.id];
      return {
        plugin,
        runtimeStatus,
        runtimeLabel: getPluginRuntimeLabel(plugin, runtimeStatus),
        runtimeSummary: getPluginRuntimeSummary(runtimeStatus),
        canCancelTasks: hasCancelableTasks(runtimeStatus),
        lastActivityAt: formatRuntimeTimestamp(runtimeStatus?.lastActivityAt),
        updatedAt: formatRuntimeTimestamp(runtimeStatus?.updatedAt),
      };
    })
    .sort((left, right) => {
      const weightDiff =
        getPluginRuntimeSortWeight(left.plugin, left.runtimeStatus) -
        getPluginRuntimeSortWeight(right.plugin, right.runtimeStatus);
      if (weightDiff !== 0) {
        return weightDiff;
      }

      const rightUpdatedAt = right.runtimeStatus?.updatedAt ?? 0;
      const leftUpdatedAt = left.runtimeStatus?.updatedAt ?? 0;
      if (rightUpdatedAt !== leftUpdatedAt) {
        return rightUpdatedAt - leftUpdatedAt;
      }

      return left.plugin.name.localeCompare(right.plugin.name, 'zh-CN');
    });
  const filteredPluginCount = filteredInstalledPlugins.length;
  const filteredRunningPluginCount = filteredInstalledPlugins.filter((plugin) =>
    hasCancelableTasks(runtimeStatuses[plugin.id])
  ).length;
  const filteredRuntimeErrorPluginCount = filteredInstalledPlugins.filter((plugin) => {
    const runtimeStatus = runtimeStatuses[plugin.id];
    return runtimeStatus?.workState === 'error' || runtimeStatus?.lifecyclePhase === 'error';
  }).length;
  const toolbarButtonClassName =
    'h-10 rounded-[10px] border-slate-200/80 bg-white/90 px-4 shadow-none hover:bg-white';
  const cardActionButtonClassName =
    'h-9 rounded-[10px] border-slate-200/70 bg-white/88 px-3 text-slate-600 shadow-none hover:bg-white hover:text-slate-900';
  const homeCardButtonClassName =
    'h-8 rounded-[10px] border-slate-200/80 bg-white/90 px-3 text-xs text-slate-600 shadow-none hover:bg-white hover:text-slate-900';
  const totalPlugins = plugins.length;
  const enabledPluginCount = plugins.filter((plugin) => plugin.enabled !== false).length;
  const disabledPluginCount = totalPlugins - enabledPluginCount;
  const totalRunningTasks = runtimeRows.reduce(
    (sum, row) => sum + (row.runtimeStatus?.runningTasks ?? 0),
    0
  );
  const totalPendingTasks = runtimeRows.reduce(
    (sum, row) => sum + (row.runtimeStatus?.pendingTasks ?? 0),
    0
  );
  const totalFailedTasks = runtimeRows.reduce(
    (sum, row) => sum + (row.runtimeStatus?.failedTasks ?? 0),
    0
  );
  const totalRunningPluginCount = runtimeRows.filter((row) => row.canCancelTasks).length;
  const totalRuntimeErrorPluginCount = runtimeRows.filter(
    (row) =>
      row.runtimeStatus?.workState === 'error' || row.runtimeStatus?.lifecyclePhase === 'error'
  ).length;
  const busyRuntimeRows = runtimeRows.filter((row) =>
    ['运行中', '排队中', '启动中', '停止中'].includes(row.runtimeLabel)
  );
  const attentionRuntimeRows = runtimeRows.filter((row) => row.runtimeLabel === '异常');
  const readyRuntimeRows = runtimeRows.filter((row) => row.runtimeLabel === '空闲');

  const handleRefreshInstalled = async () => {
    await Promise.all([loadPlugins(), loadStatuses()]);
  };

  const openPluginManager = (pluginId: string) => {
    setActiveView('installed');
    if (!expandedPlugins.has(pluginId)) {
      togglePluginExpanded(pluginId);
    }
  };

  const renderHomeRuntimeCard = (row: PluginRuntimeRow) => {
    const { plugin, runtimeStatus, runtimeLabel, runtimeSummary, canCancelTasks, lastActivityAt } =
      row;

    return (
      <article key={plugin.id} className="shell-soft-card flex h-full flex-col gap-4 border p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-white/90 text-blue-600 shadow-sm">
            {renderStringIcon(plugin.icon, {
              size: 20,
              lucideClassName: 'h-5 w-5 text-blue-600',
              emojiClassName: 'text-lg leading-none',
              imageClassName: 'h-5 w-5 object-contain',
              fallback: <Package className="h-5 w-5 text-blue-600" />,
              alt: plugin.name,
            })}
          </div>

          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">{plugin.name}</h3>
              <span
                className={cn(
                  'shell-field-chip px-2.5 py-1 text-[11px]',
                  getPluginRuntimeChipClassName(plugin, runtimeStatus)
                )}
              >
                {runtimeLabel}
              </span>
              <span
                className={cn(
                  'shell-field-chip px-2.5 py-1 text-[11px]',
                  getSourceChipClassName(plugin)
                )}
              >
                {getSourceBadgeLabel(plugin)}
              </span>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-slate-500">
                作者：{plugin.author} · ID：{plugin.id}
              </p>
              <p className="text-sm leading-6 text-slate-600">
                {runtimeSummary || '插件已安装，可从这里快速查看当前运行态。'}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
          <span className="shell-field-chip shell-field-chip--ghost justify-center px-2.5 py-2 text-[11px]">
            队列 {runtimeStatus?.activeQueues ?? 0}
          </span>
          <span className="shell-field-chip shell-field-chip--ghost justify-center px-2.5 py-2 text-[11px]">
            运行 {runtimeStatus?.runningTasks ?? 0} · 排队 {runtimeStatus?.pendingTasks ?? 0}
          </span>
          <span className="shell-field-chip shell-field-chip--ghost justify-center px-2.5 py-2 text-[11px]">
            失败 {runtimeStatus?.failedTasks ?? 0} · 已取消 {runtimeStatus?.cancelledTasks ?? 0}
          </span>
          <span className="shell-field-chip shell-field-chip--ghost justify-center px-2.5 py-2 text-[11px]">
            最近活动 {lastActivityAt || '暂无'}
          </span>
        </div>

        {typeof runtimeStatus?.progressPercent === 'number' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
              <span>{runtimeStatus.currentOperation || '当前进度'}</span>
              <span>{runtimeStatus.progressPercent}%</span>
            </div>
            <Progress value={runtimeStatus.progressPercent} className="w-full" />
          </div>
        ) : null}

        {runtimeStatus?.lastError?.message ? (
          <div className="rounded-[14px] border border-red-200/80 bg-red-50/90 p-3 text-sm text-red-700">
            <p className="font-medium">最近错误</p>
            <p className="mt-1 break-words leading-6">{runtimeStatus.lastError.message}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-slate-200/70 pt-3">
          <Button
            variant="outline"
            size="sm"
            className={homeCardButtonClassName}
            onClick={() => openPluginManager(plugin.id)}
          >
            <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
            进入管理
          </Button>

          <Button
            variant="outline"
            size="sm"
            className={homeCardButtonClassName}
            onClick={() => cancelPluginTasks(plugin.id, plugin.name)}
            disabled={!canCancelTasks}
          >
            <Square className="mr-1.5 h-3.5 w-3.5 text-orange-600" />
            停止任务
          </Button>
        </div>
      </article>
    );
  };

  const renderHomeRuntimeSection = ({
    title,
    description,
    rows,
    emptyMessage,
    icon,
  }: {
    title: string;
    description: string;
    rows: PluginRuntimeRow[];
    emptyMessage: string;
    icon: ReactNode;
  }) => (
    <section className="shell-subpanel min-h-0 overflow-hidden rounded-[20px] border">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 bg-white/68 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            {icon}
            <span>{title}</span>
          </div>
          <p className="text-xs leading-5 text-slate-500">{description}</p>
        </div>
        <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
          {rows.length} 个
        </span>
      </div>

      <div className="p-3">
        {rows.length === 0 ? (
          <div className="shell-soft-card flex min-h-[220px] flex-col items-center justify-center gap-2 border px-6 text-center">
            <p className="text-sm font-medium text-slate-700">{title}暂无内容</p>
            <p className="max-w-sm text-sm leading-6 text-slate-500">{emptyMessage}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {rows.map(renderHomeRuntimeCard)}
          </div>
        )}
      </div>
    </section>
  );

  const renderInstalledPluginCard = (plugin: JSPlugin) => {
    const expanded = expandedPlugins.has(plugin.id);
    const devSummary = getPluginDevSummary(plugin);
    const runtimeStatus = runtimeStatuses[plugin.id];
    const runtimeLabel = getPluginRuntimeLabel(plugin, runtimeStatus);
    const runtimeSummary = getPluginRuntimeSummary(runtimeStatus);
    const canCancelTasks = hasCancelableTasks(runtimeStatus);
    const lastActivityAt = formatRuntimeTimestamp(runtimeStatus?.lastActivityAt);
    const updatedAt = formatRuntimeTimestamp(runtimeStatus?.updatedAt);

    return (
      <article key={plugin.id} className="shell-soft-card flex h-full flex-col border p-4">
        <div className="space-y-4">
          <button
            type="button"
            className="flex w-full items-start gap-3 rounded-[14px] text-left transition-colors hover:bg-white/70"
            onClick={() => togglePluginExpanded(plugin.id)}
            title="点击查看详情"
          >
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-white/90 text-blue-600 shadow-sm">
              {renderStringIcon(plugin.icon, {
                size: 20,
                lucideClassName: 'h-5 w-5 text-blue-600',
                emojiClassName: 'text-lg leading-none',
                imageClassName: 'h-5 w-5 object-contain',
                fallback: <Package className="h-5 w-5 text-blue-600" />,
                alt: plugin.name,
              })}
            </div>

            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-900">{plugin.name}</h3>
                <span className="shell-field-chip shell-field-chip--ghost px-2.5 py-1 text-[11px]">
                  v{plugin.version}
                </span>
                {plugin.category ? (
                  <span className="shell-field-chip shell-field-chip--ghost px-2.5 py-1 text-[11px]">
                    {plugin.category}
                  </span>
                ) : null}
                <span
                  className={cn(
                    'shell-field-chip px-2.5 py-1 text-[11px]',
                    getSourceChipClassName(plugin)
                  )}
                >
                  {getSourceBadgeLabel(plugin)}
                </span>
                <span
                  className={cn(
                    'shell-field-chip px-2.5 py-1 text-[11px]',
                    getPluginRuntimeChipClassName(plugin, runtimeStatus)
                  )}
                >
                  {runtimeLabel}
                </span>
                {plugin.devMode ? (
                  <span className="shell-field-chip border-amber-200/80 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-700">
                    开发模式
                  </span>
                ) : null}
                {plugin.hotReloadEnabled ? (
                  <span className="shell-field-chip border-yellow-200/80 bg-yellow-50 px-2.5 py-1 text-[11px] text-yellow-700">
                    热重载
                  </span>
                ) : null}
              </div>

              <div className="space-y-1">
                <p className="text-xs text-slate-500">
                  作者：{plugin.author} · ID：{plugin.id}
                </p>
                {runtimeSummary ? <p className="text-xs text-slate-500">{runtimeSummary}</p> : null}
                <p className="text-xs text-slate-500">
                  {expanded ? '收起详情' : '查看详情'}，统一管理启停、配置和安装来源
                </p>
              </div>
            </div>
          </button>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-3">
            {plugin.enabled !== false ? (
              <Button
                variant="outline"
                size="sm"
                className={cardActionButtonClassName}
                onClick={() => disablePlugin(plugin.id, plugin.name)}
              >
                <PowerOff className="mr-1.5 h-4 w-4" />
                禁用
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className={cardActionButtonClassName}
                onClick={() => enablePlugin(plugin.id, plugin.name)}
              >
                <Power className="mr-1.5 h-4 w-4 text-blue-600" />
                启用
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              className={cardActionButtonClassName}
              onClick={() => cancelPluginTasks(plugin.id, plugin.name)}
              disabled={!canCancelTasks}
            >
              <Square className="mr-1.5 h-4 w-4 text-orange-600" />
              停止任务
            </Button>

            {plugin.devMode ? (
              <Button
                variant="outline"
                size="sm"
                className={cardActionButtonClassName}
                onClick={() => reloadPlugin(plugin.id, plugin.name)}
              >
                <RefreshCw className="mr-1.5 h-4 w-4 text-emerald-600" />
                重载
              </Button>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              className={cardActionButtonClassName}
              onClick={() => handleConfigClick(plugin)}
            >
              <Settings className="mr-1.5 h-4 w-4" />
              配置
            </Button>

            <Button
              variant="outline"
              size="sm"
              className={cardActionButtonClassName}
              onClick={() => handleUninstallClick(plugin.id, plugin.name)}
            >
              <Trash2 className="mr-1.5 h-4 w-4 text-red-600" />
              卸载
            </Button>

            <SimpleDropdownMenu
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  className={cardActionButtonClassName}
                  title="更多操作"
                >
                  <MoreVertical className="mr-1.5 h-4 w-4" />
                  更多
                </Button>
              }
              content={
                <div className="w-56">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100/80"
                    onClick={() => openPluginDirectory(plugin.path)}
                  >
                    <FolderOpen className="h-4 w-4 text-blue-600" />
                    <span>打开安装目录</span>
                  </button>

                  {plugin.devMode && plugin.sourcePath ? (
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100/80"
                      onClick={() => {
                        if (plugin.sourcePath) {
                          openPluginDirectory(plugin.sourcePath);
                        }
                      }}
                    >
                      <FolderOpen className="h-4 w-4 text-emerald-600" />
                      <span>打开源码目录</span>
                    </button>
                  ) : null}

                  {plugin.devMode ? (
                    <>
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100/80"
                        onClick={() => toggleHotReload(plugin.id, plugin.name)}
                      >
                        {plugin.hotReloadEnabled ? (
                          <>
                            <ZapOff className="h-4 w-4 text-slate-400" />
                            <span>禁用热重载</span>
                          </>
                        ) : (
                          <>
                            <Zap className="h-4 w-4 text-yellow-500" />
                            <span>启用热重载</span>
                          </>
                        )}
                      </button>

                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100/80"
                        onClick={() => repairPlugin(plugin.id, plugin.name)}
                      >
                        <Wrench className="h-4 w-4 text-orange-600" />
                        <span>修复插件</span>
                      </button>
                    </>
                  ) : null}
                </div>
              }
            />
          </div>
        </div>

        {expanded ? (
          <div className="mt-4 space-y-3 border-t border-slate-200/70 pt-4 text-sm">
            {plugin.description ? (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-slate-400">
                  描述
                </p>
                <p className="text-slate-600">{plugin.description}</p>
              </div>
            ) : null}

            <div className="shell-subpanel space-y-3 rounded-[16px] border border-slate-200/70 bg-white/72 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-slate-400">
                    运行状态
                  </p>
                  <p className="text-sm font-medium text-slate-800">{runtimeLabel}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="shell-field-chip shell-field-chip--ghost px-2.5 py-1 text-[11px]">
                    队列 {runtimeStatus?.activeQueues ?? 0}
                  </span>
                  <span className="shell-field-chip shell-field-chip--ghost px-2.5 py-1 text-[11px]">
                    运行 {runtimeStatus?.runningTasks ?? 0}
                  </span>
                  <span className="shell-field-chip shell-field-chip--ghost px-2.5 py-1 text-[11px]">
                    排队 {runtimeStatus?.pendingTasks ?? 0}
                  </span>
                  <span className="shell-field-chip shell-field-chip--ghost px-2.5 py-1 text-[11px]">
                    失败 {runtimeStatus?.failedTasks ?? 0}
                  </span>
                </div>
              </div>

              {runtimeSummary ? <p className="text-sm text-slate-600">{runtimeSummary}</p> : null}

              {typeof runtimeStatus?.progressPercent === 'number' ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                    <span>{runtimeStatus.currentOperation || '当前进度'}</span>
                    <span>{runtimeStatus.progressPercent}%</span>
                  </div>
                  <Progress value={runtimeStatus.progressPercent} className="w-full" />
                </div>
              ) : null}

              {runtimeStatus?.lastError?.message ? (
                <div className="rounded-[14px] border border-red-200/80 bg-red-50/90 p-3 text-sm text-red-700">
                  <p className="font-medium">最近错误</p>
                  <p className="mt-1 break-words leading-6">{runtimeStatus.lastError.message}</p>
                </div>
              ) : null}

              <div className="grid gap-3 text-xs text-slate-500 sm:grid-cols-2">
                <p>最近活动：{lastActivityAt || '暂无'}</p>
                <p>最近更新：{updatedAt || '暂无'}</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-slate-400">
                  安装路径
                </p>
                <p className="break-all font-mono text-xs text-slate-500">{plugin.path}</p>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-slate-400">
                  安装时间
                </p>
                <p className="text-slate-600">
                  {new Date(plugin.installedAt).toLocaleString('zh-CN')}
                </p>
              </div>

              {plugin.sourcePath ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-slate-400">
                    源码路径
                  </p>
                  <p className="break-all font-mono text-xs text-slate-500">{plugin.sourcePath}</p>
                </div>
              ) : null}

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-slate-400">
                  来源信息
                </p>
                <p className="text-slate-600">{getPluginSourceSummary(plugin)}</p>
                {devSummary ? <p className="text-xs text-slate-500">{devSummary}</p> : null}
                {plugin.cloudPluginCode ? (
                  <p className="break-all text-xs text-slate-500">
                    cloudPluginCode: {plugin.cloudPluginCode}
                    {plugin.cloudReleaseVersion ? ` · release ${plugin.cloudReleaseVersion}` : ''}
                  </p>
                ) : null}
                {plugin.policyVersion ? (
                  <p className="break-all text-xs text-slate-500">
                    policyVersion: {plugin.policyVersion}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </article>
    );
  };

  const renderPluginSection = ({
    title,
    description,
    count,
    items,
    emptyMessage,
    icon,
  }: {
    title: string;
    description: string;
    count: number;
    items: JSPlugin[];
    emptyMessage: string;
    icon: ReactNode;
  }) => (
    <section className="shell-subpanel min-h-0 overflow-hidden rounded-[20px] border">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 bg-white/68 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            {icon}
            <span>{title}</span>
          </div>
          <p className="text-xs leading-5 text-slate-500">{description}</p>
        </div>
        <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
          {count} 个
        </span>
      </div>

      <div className="p-3">
        {items.length === 0 ? (
          <div className="shell-soft-card flex min-h-[220px] flex-col items-center justify-center gap-2 border px-6 text-center">
            <p className="text-sm font-medium text-slate-700">{title}暂无匹配项</p>
            <p className="max-w-sm text-sm leading-6 text-slate-500">{emptyMessage}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {items.map(renderInstalledPluginCard)}
          </div>
        )}
      </div>
    </section>
  );

  return (
    <div className="flex h-full flex-col">
      <PageFrameHeader
        title="插件中心"
        className="workspace-page-header"
        actions={
          <div className="page-header-control-group">
            <div className="shell-tab-strip">
              <button
                type="button"
                className={`shell-tab-button ${activeView === 'home' ? 'shell-tab-button--active' : ''}`}
                onClick={() => setActiveView('home')}
              >
                <span className="inline-flex items-center gap-2">
                  <House className="h-4 w-4" />
                  首页
                </span>
              </button>
              {cloudCatalogAvailable ? (
                <button
                  type="button"
                  className={`shell-tab-button ${activeView === 'catalog' ? 'shell-tab-button--active' : ''}`}
                  onClick={() => setActiveView('catalog')}
                >
                  <span className="inline-flex items-center gap-2">
                    <Cloud className="h-4 w-4" />
                    云端目录
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className={`shell-tab-button ${activeView === 'installed' ? 'shell-tab-button--active' : ''}`}
                onClick={() => setActiveView('installed')}
              >
                <span className="inline-flex items-center gap-2">
                  <HardDrive className="h-4 w-4" />
                  已安装
                </span>
              </button>
            </div>
          </div>
        }
      />

      <div className="shell-content-muted flex-1 overflow-auto p-4">
        {activeView === 'home' ? (
          <div className="space-y-3">
            <section className="shell-soft-card overflow-hidden border bg-[linear-gradient(135deg,rgba(14,116,144,0.12),rgba(255,255,255,0.92),rgba(59,130,246,0.08))] p-5">
              <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
                <div className="space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-slate-600">插件运行总览</p>
                    <h2 className="text-xl font-semibold text-slate-900">首页</h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
                      已安装 {totalPlugins}
                    </span>
                    <span className="shell-field-chip border-blue-200/80 bg-blue-50 px-3 py-1.5 text-xs text-blue-700">
                      运行中 {totalRunningPluginCount}
                    </span>
                    <span className="shell-field-chip border-red-200/80 bg-red-50 px-3 py-1.5 text-xs text-red-700">
                      异常 {totalRuntimeErrorPluginCount}
                    </span>
                    <span className="shell-field-chip border-slate-200/80 bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
                      停用 {disabledPluginCount}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className={toolbarButtonClassName}
                    onClick={() => void handleRefreshInstalled()}
                    disabled={pluginsLoading || runtimeLoading || isImporting}
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${pluginsLoading || runtimeLoading ? 'animate-spin' : ''}`}
                    />
                    刷新状态
                  </Button>
                  {cloudCatalogAvailable ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className={toolbarButtonClassName}
                      onClick={() => setActiveView('catalog')}
                    >
                      <Cloud className="mr-2 h-4 w-4" />
                      浏览云端目录
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <article className="shell-subpanel rounded-[18px] border border-white/80 bg-white/82 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-[0.08em] text-slate-400">
                        已安装插件
                      </p>
                      <p className="text-2xl font-semibold text-slate-900">{totalPlugins}</p>
                    </div>
                    <div className="rounded-[14px] bg-slate-100 p-2 text-slate-700">
                      <Package className="h-5 w-5" />
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-500">
                    启用 {enabledPluginCount} · 停用 {disabledPluginCount}
                  </p>
                </article>

                <article className="shell-subpanel rounded-[18px] border border-white/80 bg-white/82 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-[0.08em] text-slate-400">
                        运行中插件
                      </p>
                      <p className="text-2xl font-semibold text-slate-900">
                        {totalRunningPluginCount}
                      </p>
                    </div>
                    <div className="rounded-[14px] bg-blue-50 p-2 text-blue-700">
                      <Activity className="h-5 w-5" />
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-500">
                    运行任务 {totalRunningTasks} · 排队任务 {totalPendingTasks}
                  </p>
                </article>

                <article className="shell-subpanel rounded-[18px] border border-white/80 bg-white/82 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-[0.08em] text-slate-400">待命插件</p>
                      <p className="text-2xl font-semibold text-slate-900">
                        {readyRuntimeRows.length}
                      </p>
                    </div>
                    <div className="rounded-[14px] bg-emerald-50 p-2 text-emerald-700">
                      <Clock3 className="h-5 w-5" />
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-500">已激活且当前空闲，适合立即调度</p>
                </article>

                <article className="shell-subpanel rounded-[18px] border border-white/80 bg-white/82 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-[0.08em] text-slate-400">需要处理</p>
                      <p className="text-2xl font-semibold text-slate-900">
                        {totalRuntimeErrorPluginCount}
                      </p>
                    </div>
                    <div className="rounded-[14px] bg-red-50 p-2 text-red-700">
                      <CircleAlert className="h-5 w-5" />
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-500">
                    异常插件 {totalRuntimeErrorPluginCount} · 失败任务 {totalFailedTasks}
                  </p>
                </article>
              </div>
            </section>

            {pluginsLoading || runtimeLoading ? (
              <div className="shell-soft-card space-y-3 border p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-slate-900">正在刷新插件首页</p>
                  <span className="text-xs text-slate-500">同步安装列表与运行状态</span>
                </div>
                <Progress value={undefined} className="w-full" />
              </div>
            ) : (
              <>
                <div className="grid gap-3 xl:grid-cols-2">
                  {renderHomeRuntimeSection({
                    title: '当前运行',
                    description: '优先处理真正占用队列或正在切换状态的插件。',
                    rows: busyRuntimeRows,
                    emptyMessage: '当前没有插件在运行、排队或切换状态。',
                    icon: <Activity className="h-4 w-4 text-blue-600" />,
                  })}

                  {renderHomeRuntimeSection({
                    title: '需要处理',
                    description: '失败任务或异常状态会集中显示在这里，便于优先排查。',
                    rows: attentionRuntimeRows,
                    emptyMessage: '当前没有异常插件，系统运行正常。',
                    icon: <CircleAlert className="h-4 w-4 text-red-600" />,
                  })}
                </div>

                {renderHomeRuntimeSection({
                  title: '全部运行态',
                  description:
                    '按异常、运行中、空闲、未启动、已禁用排序，方便快速扫一眼所有插件状态。',
                  rows: runtimeRows,
                  emptyMessage: '当前还没有已安装插件，可前往“云端目录”或“已安装”页导入插件。',
                  icon: <House className="h-4 w-4 text-slate-700" />,
                })}
              </>
            )}
          </div>
        ) : null}

        {cloudCatalogAvailable && activeView === 'catalog' ? <CloudPluginCatalogPanel /> : null}

        {activeView === 'installed' ? (
          <div className="space-y-3">
            <section className="shell-soft-card space-y-4 border p-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="rounded-[14px] bg-white/90 p-2 text-slate-700 shadow-sm">
                      <HardDrive className="h-4 w-4" />
                    </div>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-slate-900">已安装插件</h2>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
                      当前 {filteredPluginCount} 个已安装项
                    </span>
                    <span className="shell-field-chip border-emerald-200/80 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700">
                      本地 {filteredLocalPlugins.length}
                    </span>
                    <span className="shell-field-chip shell-field-chip--accent px-3 py-1.5 text-xs">
                      云端 {filteredCloudPlugins.length}
                    </span>
                    <span className="shell-field-chip border-blue-200/80 bg-blue-50 px-3 py-1.5 text-xs text-blue-700">
                      运行中 {filteredRunningPluginCount}
                    </span>
                    <span className="shell-field-chip border-red-200/80 bg-red-50 px-3 py-1.5 text-xs text-red-700">
                      异常 {filteredRuntimeErrorPluginCount}
                    </span>
                    {searchKeyword ? (
                      <span className="shell-field-chip px-3 py-1.5 text-xs">
                        搜索：{searchKeyword}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className={toolbarButtonClassName}
                    onClick={() => void handleRefreshInstalled()}
                    disabled={pluginsLoading || runtimeLoading || isImporting}
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${pluginsLoading || runtimeLoading ? 'animate-spin' : ''}`}
                    />
                    刷新列表
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={toolbarButtonClassName}
                    onClick={() => void handleInstallPlugin(false)}
                    disabled={appInfo.loading || !canImportLocalPlugins || isImporting}
                  >
                    <Package className="mr-2 h-4 w-4" />
                    {installingMode === 'archive' ? '导入中...' : '导入压缩包'}
                  </Button>
                  <Button
                    size="sm"
                    className="h-10 rounded-[10px] px-4"
                    onClick={() => void handleInstallPlugin(true)}
                    disabled={appInfo.loading || !canImportLocalPlugins || isImporting}
                  >
                    <FolderOpen className="mr-2 h-4 w-4" />
                    {installingMode === 'dev' ? '导入中...' : '开发模式导入'}
                  </Button>
                </div>
              </div>

              {!appInfo.loading && !canImportLocalPlugins ? (
                <div className="rounded-[16px] border border-amber-200/80 bg-amber-50/90 p-4 text-sm text-amber-800">
                  <p className="font-medium">当前会话未开启本地插件导入。</p>
                  <p className="mt-1 leading-6">
                    源码运行时可直接使用；打包版请到“设置 &gt; HTTP API”开启“开发模式”后再导入。
                    {appInfo.isPackaged ? ' 打包版重启后需要重新开启一次。' : ''}
                  </p>
                </div>
              ) : null}

              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative min-w-[240px] flex-1 xl:max-w-2xl">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    placeholder="搜索插件名称、ID、作者、描述或分类..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-10 rounded-[12px] border-slate-200/80 bg-white/96 pl-10 shadow-none"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>自动匹配名称、ID、作者、描述和分类</span>
                  {searchKeyword ? (
                    <Button
                      variant="ghost"
                      className="h-10 rounded-[10px] px-4 text-slate-600 hover:bg-white/72 hover:text-slate-900"
                      onClick={() => setSearchQuery('')}
                    >
                      清除搜索
                    </Button>
                  ) : null}
                </div>
              </div>
            </section>

            {pluginsLoading || runtimeLoading ? (
              <div className="shell-soft-card space-y-3 border p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-slate-900">正在刷新本地插件状态</p>
                  <span className="text-xs text-slate-500">同步安装列表与运行状态</span>
                </div>
                <Progress value={undefined} className="w-full" />
              </div>
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {renderPluginSection({
                  title: '本地插件',
                  description: '手动导入目录或压缩包的插件，适合本地私有扩展和开发调试。',
                  count: filteredLocalPlugins.length,
                  items: filteredLocalPlugins,
                  emptyMessage: searchKeyword
                    ? '没有匹配的本地插件。'
                    : '还没有导入本地插件，可使用上方按钮导入目录或压缩包。',
                  icon: <HardDrive className="h-4 w-4 text-emerald-600" />,
                })}

                {renderPluginSection({
                  title: '云插件',
                  description: '通过云端目录安装的插件，适合统一升级和策略下发。',
                  count: filteredCloudPlugins.length,
                  items: filteredCloudPlugins,
                  emptyMessage: searchKeyword
                    ? '没有匹配的云插件。'
                    : '暂无已安装云插件，可前往“云端目录”安装或更新插件。',
                  icon: <Cloud className="h-4 w-4 text-cyan-600" />,
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {selectedPlugin ? (
        <UninstallPluginDialog
          open={uninstallDialogOpen}
          onOpenChange={setUninstallDialogOpen}
          pluginId={selectedPlugin.id}
          pluginName={selectedPlugin.name}
          onConfirm={handleUninstallConfirm}
        />
      ) : null}

      {selectedPluginForConfig ? (
        <PluginConfigDialog
          open={configDialogOpen}
          onOpenChange={setConfigDialogOpen}
          pluginId={selectedPluginForConfig.id}
          pluginName={selectedPluginForConfig.name}
          pluginPath={selectedPluginForConfig.path}
        />
      ) : null}
    </div>
  );
}
