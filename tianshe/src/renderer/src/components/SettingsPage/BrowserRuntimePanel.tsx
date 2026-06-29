import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Chrome,
  Download,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { toast } from '../../lib/toast';
import { getUnknownErrorMessage } from '../../../../utils/error-message';
import type { BrowserRuntimeStatus } from '../../../../core/browser-runtime';
import type { BrowserRuntimeSource } from '../../../../types/browser-runtime';

function getRuntimeLabel(status: BrowserRuntimeStatus): string {
  switch (status.runtimeId) {
    case 'electron-webcontents':
      return 'Electron WebContents';
    case 'chromium-extension-relay':
      return 'Chromium Extension Relay';
    case 'firefox-bidi':
      return 'Firefox BiDi';
    case 'chromium-cloak-playwright':
      return 'Cloak Playwright';
  }
}

function getSourceText(source: BrowserRuntimeSource): string {
  switch (source.type) {
    case 'bundled':
      return '随应用打包';
    case 'custom-path':
      return '本机路径';
    case 'managed-download':
      return `按需下载 / ${source.channel}`;
    case 'system-detected':
      return '系统检测';
  }
}

function getInstallStateText(status: BrowserRuntimeStatus): string {
  switch (status.installState) {
    case 'bundled':
      return '内置';
    case 'custom-path':
      return '自定义';
    case 'managed-installed':
      return '已安装';
    case 'missing':
      return '缺失';
    case 'unknown':
      return '未知';
  }
}

function getHealthBadge(status: BrowserRuntimeStatus): {
  variant: 'default' | 'secondary' | 'destructive';
  label: string;
} {
  if (status.healthy) {
    return { variant: 'default', label: '可用' };
  }

  if (status.installed) {
    return { variant: 'secondary', label: '需检查' };
  }

  return { variant: 'destructive', label: '不可用' };
}

function summarizeCapabilities(status: BrowserRuntimeStatus): string {
  const entries = Object.entries(status.capabilities ?? {}).filter(([, enabled]) => enabled);
  if (entries.length === 0) return '未返回运行探测能力';
  return entries
    .slice(0, 6)
    .map(([name]) => name)
    .join(' / ');
}

function sortRuntimeStatuses(statuses: BrowserRuntimeStatus[]): BrowserRuntimeStatus[] {
  const order: Record<BrowserRuntimeStatus['runtimeId'], number> = {
    'electron-webcontents': 0,
    'chromium-extension-relay': 1,
    'firefox-bidi': 2,
    'chromium-cloak-playwright': 3,
  };
  return [...statuses].sort((left, right) => order[left.runtimeId] - order[right.runtimeId]);
}

function RuntimeHealthIcon({ status }: { status: BrowserRuntimeStatus }) {
  if (status.healthy) {
    return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  }

  if (status.installed) {
    return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  }

  return <XCircle className="h-4 w-4 text-destructive" />;
}

function canUseCustomPath(status: BrowserRuntimeStatus): boolean {
  return status.runtimeId !== 'electron-webcontents';
}

function canInstallManaged(status: BrowserRuntimeStatus): boolean {
  return status.runtimeId === 'chromium-cloak-playwright';
}

function canOpenDownloadPage(status: BrowserRuntimeStatus): boolean {
  return status.runtimeId === 'firefox-bidi' || status.runtimeId === 'chromium-cloak-playwright';
}

export function BrowserRuntimePanel() {
  const [statuses, setStatuses] = useState<BrowserRuntimeStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyRuntimeId, setBusyRuntimeId] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const sortedStatuses = useMemo(() => sortRuntimeStatuses(statuses), [statuses]);
  const healthyCount = useMemo(
    () => statuses.filter((status) => status.healthy).length,
    [statuses]
  );

  const loadStatuses = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.browserRuntime.listStatuses();
      if (!result.success || !result.data) {
        toast.error('加载浏览器运行时状态失败', result.error || '状态返回值不完整');
        return;
      }

      setStatuses(result.data);
      setLastUpdatedAt(new Date());
    } catch (error: unknown) {
      toast.error('加载浏览器运行时状态失败', getUnknownErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const replaceStatus = (nextStatus: BrowserRuntimeStatus) => {
    setStatuses((prev) => {
      const exists = prev.some((status) => status.runtimeId === nextStatus.runtimeId);
      if (!exists) return [...prev, nextStatus];
      return prev.map((status) =>
        status.runtimeId === nextStatus.runtimeId ? nextStatus : status
      );
    });
    setLastUpdatedAt(new Date());
  };

  const runRuntimeAction = async (
    runtimeId: BrowserRuntimeStatus['runtimeId'],
    action: () => Promise<{ success: boolean; data?: BrowserRuntimeStatus; error?: string }>,
    messages: { success: string; error: string }
  ) => {
    setBusyRuntimeId(runtimeId);
    try {
      const result = await action();
      if (!result.success || !result.data) {
        toast.error(messages.error, result.error || '运行时返回值不完整');
        return;
      }
      replaceStatus(result.data);
      toast.success(messages.success);
    } catch (error: unknown) {
      toast.error(messages.error, getUnknownErrorMessage(error));
    } finally {
      setBusyRuntimeId(null);
    }
  };

  const selectCustomPath = async (status: BrowserRuntimeStatus) => {
    setBusyRuntimeId(status.runtimeId);
    try {
      const selected = await window.electronAPI.browserRuntime.selectExecutable(status.runtimeId);
      if (!selected.success || !selected.data) {
        toast.error('选择浏览器路径失败', selected.error || '路径返回值不完整');
        return;
      }
      if (selected.data.canceled || !selected.data.path) {
        return;
      }

      const result = await window.electronAPI.browserRuntime.setCustomPath(
        status.runtimeId,
        selected.data.path
      );
      if (!result.success || !result.data) {
        toast.error('保存浏览器路径失败', result.error || '状态返回值不完整');
        return;
      }

      replaceStatus(result.data);
      toast.success('浏览器路径已保存');
    } catch (error: unknown) {
      toast.error('选择浏览器路径失败', getUnknownErrorMessage(error));
    } finally {
      setBusyRuntimeId(null);
    }
  };

  const restoreDefaultSource = (status: BrowserRuntimeStatus) =>
    runRuntimeAction(
      status.runtimeId,
      () => window.electronAPI.browserRuntime.setDefaultSource(status.runtimeId),
      {
        success: '已恢复默认来源',
        error: '恢复默认来源失败',
      }
    );

  const installManaged = (status: BrowserRuntimeStatus) =>
    runRuntimeAction(
      status.runtimeId,
      () => window.electronAPI.browserRuntime.installManaged(status.runtimeId),
      {
        success: '运行时安装完成',
        error: '安装运行时失败',
      }
    );

  const openDownloadPage = async (status: BrowserRuntimeStatus) => {
    setBusyRuntimeId(status.runtimeId);
    try {
      const result = await window.electronAPI.browserRuntime.openDownloadPage(status.runtimeId);
      if (!result.success) {
        toast.error('打开下载页面失败', result.error || '未知错误');
      }
    } catch (error: unknown) {
      toast.error('打开下载页面失败', getUnknownErrorMessage(error));
    } finally {
      setBusyRuntimeId(null);
    }
  };

  useEffect(() => {
    void loadStatuses();
  }, []);

  return (
    <div className="space-y-3">
      <Card className="settings-page-panel">
        <CardHeader className="settings-card-header">
          <CardTitle className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Chrome className="h-5 w-5" />
              浏览器运行时
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadStatuses()}
              disabled={loading}
              title="刷新运行时状态"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="settings-card-content space-y-3">
          <div className="grid gap-2.5 md:grid-cols-3">
            <div className="settings-section settings-section--muted p-3">
              <div className="text-sm font-semibold">已注册</div>
              <div className="mt-1 text-2xl font-semibold leading-none">{statuses.length}</div>
            </div>
            <div className="settings-section settings-section--muted p-3">
              <div className="text-sm font-semibold">可用</div>
              <div className="mt-1 text-2xl font-semibold leading-none">{healthyCount}</div>
            </div>
            <div className="settings-section settings-section--muted p-3">
              <div className="text-sm font-semibold">更新时间</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString() : '等待刷新'}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {sortedStatuses.map((status) => {
              const healthBadge = getHealthBadge(status);
              const runtimeBusy = busyRuntimeId === status.runtimeId;
              return (
                <div
                  key={status.runtimeId}
                  className="settings-section p-3"
                  data-testid={`browser-runtime-${status.runtimeId}`}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <RuntimeHealthIcon status={status} />
                        <div className="font-semibold">{getRuntimeLabel(status)}</div>
                        <Badge variant={healthBadge.variant}>{healthBadge.label}</Badge>
                        <Badge variant="secondary">{getInstallStateText(status)}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">{status.runtimeId}</div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{status.descriptor.browserFamily}</span>
                      <span>/</span>
                      <span>{status.descriptor.controlProtocol}</span>
                      <span>/</span>
                      <span>{status.descriptor.profileMode}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {canUseCustomPath(status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void selectCustomPath(status)}
                        disabled={runtimeBusy}
                        title="选择本机浏览器可执行文件"
                      >
                        <FolderOpen className="mr-2 h-4 w-4" />
                        选择路径
                      </Button>
                    ) : null}
                    {status.configuredSourceOverride ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void restoreDefaultSource(status)}
                        disabled={runtimeBusy}
                        title="恢复默认运行时来源"
                      >
                        <RotateCcw className="mr-2 h-4 w-4" />
                        恢复默认
                      </Button>
                    ) : null}
                    {canInstallManaged(status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void installManaged(status)}
                        disabled={runtimeBusy}
                        title="安装 CloakBrowser runtime"
                      >
                        <Download className="mr-2 h-4 w-4" />
                        安装
                      </Button>
                    ) : null}
                    {canOpenDownloadPage(status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void openDownloadPage(status)}
                        disabled={runtimeBusy}
                        title="打开官方下载页面"
                      >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        下载页
                      </Button>
                    ) : null}
                  </div>

                  <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                    <div className="settings-section settings-section--muted min-w-0 p-2.5">
                      <div className="font-medium text-foreground">来源</div>
                      <div className="mt-1 truncate text-muted-foreground">
                        {getSourceText(status.source)}
                        {status.configuredSourceOverride ? ' / 已覆盖' : ''}
                      </div>
                    </div>
                    <div className="settings-section settings-section--muted min-w-0 p-2.5">
                      <div className="font-medium text-foreground">版本</div>
                      <div className="mt-1 truncate text-muted-foreground">
                        {status.version || '未检测到'}
                      </div>
                    </div>
                    <div className="settings-section settings-section--muted min-w-0 p-2.5 md:col-span-2">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <ExternalLink className="h-3.5 w-3.5" />
                        路径
                      </div>
                      <div className="mt-1 truncate text-muted-foreground" title={status.executablePath || ''}>
                        {status.executablePath || '未解析'}
                      </div>
                    </div>
                    <div className="settings-section settings-section--muted min-w-0 p-2.5 md:col-span-2">
                      <div className="font-medium text-foreground">探测能力</div>
                      <div className="mt-1 truncate text-muted-foreground">
                        {summarizeCapabilities(status)}
                      </div>
                    </div>
                  </div>

                  {[...status.errors, ...status.warnings].length > 0 ? (
                    <div className="mt-3 space-y-1.5">
                      {status.errors.map((message, index) => (
                        <div
                          key={`error-${index}`}
                          className="settings-section border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
                        >
                          {message}
                        </div>
                      ))}
                      {status.warnings.map((message, index) => (
                        <div
                          key={`warning-${index}`}
                          className="settings-section border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-100"
                        >
                          {message}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {!loading && sortedStatuses.length === 0 ? (
              <div className="settings-section settings-section--muted p-4 text-sm text-muted-foreground">
                暂无运行时状态
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default BrowserRuntimePanel;
