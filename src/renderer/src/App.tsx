/**
 * 主应用组件
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import { ActivityBar } from './components/ActivityBar';
import { useUIStore } from './stores/uiStore';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { UpdateNotification } from './components/UpdateNotification';
import { Toaster } from './components/ui/sonner';
import { AppTitleBar } from './components/layout/AppTitleBar';
import { isCloudWorkbenchAvailable } from './lib/edition';
import { toast } from './lib/toast';
import {
  DEFAULT_APP_SHELL_CONFIG,
  normalizeAppShellConfig,
  resolveAppShellActiveView,
  type AppShellConfig,
} from '../../shared/app-shell-config';

const DatasetsPage = lazy(() =>
  import('./components/DatasetsPage').then((module) => ({ default: module.DatasetsPage }))
);
const WorkbenchPanel = lazy(() =>
  import('./components/DatasetsPage/WorkbenchPanel').then((module) => ({
    default: module.WorkbenchPanel,
  }))
);
const AccountCenterPage = lazy(() =>
  import('./components/AccountCenter').then((module) => ({
    default: module.AccountCenterPage,
  }))
);
const PluginMarketPage = lazy(() =>
  import('./components/PluginMarket').then((module) => ({
    default: module.PluginMarketPage,
  }))
);
const SettingsPage = lazy(() =>
  import('./components/SettingsPage').then((module) => ({ default: module.SettingsPage }))
);

// 简化的错误降级 UI（用于单个 tab）
const TabErrorFallback = ({ tabName }: { tabName: string }) => (
  <Card>
    <CardHeader>
      <CardTitle className="text-destructive">该模块加载失败</CardTitle>
      <CardDescription>{tabName} 遇到错误，但您可以继续使用其他功能。</CardDescription>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">
        请尝试切换到其他标签页，或刷新应用。如果问题持续，请查看日志或联系开发者。
      </p>
    </CardContent>
  </Card>
);

const ViewLoadingFallback = () => <div className="h-full w-full bg-background" />;

type AppInfoResult = {
  success?: boolean;
  info?: {
    platform?: string;
    isPackaged?: boolean;
    appShell?: AppShellConfig;
  };
};

function App() {
  const activeView = useUIStore((state) => state.activeView);
  const setActiveView = useUIStore((state) => state.setActiveView);
  const isActivityBarCollapsed = useUIStore((state) => state.isActivityBarCollapsed);
  const [showUpdateNotification, setShowUpdateNotification] = useState(false);
  const [appPlatform, setAppPlatform] = useState<string>('');
  const [appShellConfig, setAppShellConfig] = useState<AppShellConfig>(DEFAULT_APP_SHELL_CONFIG);
  const cloudWorkbenchAvailable = isCloudWorkbenchAvailable();
  const effectiveActiveView = resolveAppShellActiveView(activeView, appShellConfig, {
    workbenchAvailable: cloudWorkbenchAvailable,
  });

  useEffect(() => {
    let mounted = true;

    window.electronAPI
      .getAppInfo()
      .then((result: AppInfoResult) => {
        if (!mounted) return;
        const isPackaged = result?.success === true && result?.info?.isPackaged === true;
        setShowUpdateNotification(isPackaged);
        setAppPlatform(result?.info?.platform || '');
        setAppShellConfig(
          result?.info?.appShell
            ? normalizeAppShellConfig(result.info.appShell)
            : DEFAULT_APP_SHELL_CONFIG
        );
      })
      .catch(() => {
        if (!mounted) return;
        setShowUpdateNotification(false);
        setAppPlatform('');
        setAppShellConfig(DEFAULT_APP_SHELL_CONFIG);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const subscribe = window.electronAPI?.jsPlugin?.onPluginNotification;
    if (typeof subscribe !== 'function') {
      return;
    }

    return subscribe((event) => {
      const message = String(event?.message || '').trim();
      if (!message) {
        return;
      }

      const description = event.pluginId ? `来自插件 ${event.pluginId}` : undefined;
      switch (event.type) {
        case 'success':
          toast.success(message, description);
          break;
        case 'warning':
          toast.warning(message, description);
          break;
        case 'error':
          toast.error(message, description);
          break;
        default:
          toast.info(message, description);
          break;
      }
    });
  }, []);

  // ✅ 兼容：旧版本仅支持同步折叠状态；新版本由 ActivityBar 通过 ResizeObserver 上报真实宽度
  useEffect(() => {
    const setWidth = window.electronAPI?.view?.setActivityBarWidth;
    if (typeof setWidth === 'function') {
      return;
    }

    const setCollapsed = window.electronAPI?.view?.setActivityBarCollapsed;
    if (typeof setCollapsed !== 'function') {
      return;
    }

    setCollapsed(isActivityBarCollapsed).catch((error) => {
      console.error('[App] Failed to sync activity bar collapsed state:', error);
    });
  }, [isActivityBarCollapsed]);

  useEffect(() => {
    if (effectiveActiveView !== activeView) {
      setActiveView(effectiveActiveView);
    }
  }, [activeView, effectiveActiveView, setActiveView]);

  // ✅ 统一管理视图切换时的清理逻辑
  useEffect(() => {
    const handleViewSwitch = async () => {
      const { activePluginView } = useUIStore.getState();

      const hideActivePluginView = async () => {
        if (!activePluginView) return;
        try {
          await window.electronAPI.jsPlugin.hidePluginView(activePluginView);
        } catch (error) {
          console.error('[App] Failed to hide plugin view:', error);
        }
      };

      const detachAutomationViews = async () => {
        try {
          const detachScoped = window.electronAPI?.view?.detachScoped;
          if (typeof detachScoped === 'function') {
            await detachScoped({
              windowId: 'main',
              scope: 'automation',
              preserveDockedRight: true,
            });
            return;
          }

          // 兼容旧主进程版本：降级为 detachAll
          const detachAll = window.electronAPI?.view?.detachAll;
          if (typeof detachAll === 'function') {
            await detachAll({
              windowId: 'main',
              preserveDockedRight: true,
            });
          } else {
            console.warn('[App] View detach API is unavailable in renderer context');
          }
        } catch (error) {
          console.error('[App] Failed to detach views:', error);
        }
      };

      switch (effectiveActiveView) {
        case 'datasets':
        case 'workbench':
          // 切换到数据表：隐藏插件视图，detach 插件市场相关视图
          await hideActivePluginView();
          await detachAutomationViews();
          break;

        case 'marketplace':
          // 切换到插件市场：隐藏其他插件视图，并清理所有临时浏览器窗口
          await hideActivePluginView();
          await detachAutomationViews();
          break;

        case 'plugin':
          // 切换到插件视图：不做清理（ActivityBar 负责显示插件视图）
          break;

        case 'accountCenter':
          // 切换到账号中心：隐藏插件视图，清理临时窗口
          await hideActivePluginView();
          await detachAutomationViews();
          break;

        case 'settings':
          // 切换到设置页面：隐藏插件视图，清理临时窗口
          await hideActivePluginView();
          await detachAutomationViews();
          break;

        default:
          console.warn(`[App] Unknown activeView: ${effectiveActiveView}`);
      }
    };

    handleViewSwitch();
  }, [effectiveActiveView]);

  return (
    <>
      {appPlatform === 'win32' ? <AppTitleBar /> : null}

      <div
        className={`app-shell-frame flex h-full overflow-hidden ${
          appPlatform === 'win32' ? 'app-shell-frame--with-titlebar' : ''
        }`}
      >
        {/* 左侧 Activity Bar */}
        <ActivityBar appShellConfig={appShellConfig} />

        {/* 主内容区域 */}
        <main className="shell-content-surface flex flex-1 flex-col overflow-hidden">
          {effectiveActiveView === 'datasets' && appShellConfig.pages.datasets ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="数据表" />}>
              <Suspense fallback={<ViewLoadingFallback />}>
                <DatasetsPage />
              </Suspense>
            </ErrorBoundary>
          ) : effectiveActiveView === 'workbench' && cloudWorkbenchAvailable ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="工作台" />}>
              <Suspense fallback={<ViewLoadingFallback />}>
                <WorkbenchPanel />
              </Suspense>
            </ErrorBoundary>
          ) : effectiveActiveView === 'accountCenter' && appShellConfig.pages.accountCenter ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="账号中心" />}>
              <Suspense fallback={<ViewLoadingFallback />}>
                <AccountCenterPage />
              </Suspense>
            </ErrorBoundary>
          ) : effectiveActiveView === 'marketplace' && appShellConfig.pages.marketplace ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="插件市场" />}>
              <Suspense fallback={<ViewLoadingFallback />}>
                <PluginMarketPage />
              </Suspense>
            </ErrorBoundary>
          ) : effectiveActiveView === 'plugin' ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="插件视图" />}>
              {/* 插件视图容器 - 完全空白，WebContentsView 会通过 attachView 显示 */}
              <div className="h-full w-full bg-background" />
            </ErrorBoundary>
          ) : effectiveActiveView === 'settings' && appShellConfig.pages.settings ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="设置" />}>
              <Suspense fallback={<ViewLoadingFallback />}>
                <SettingsPage />
              </Suspense>
            </ErrorBoundary>
          ) : null}
        </main>
      </div>

      {/* 软件更新通知（仅生产环境） */}
      {showUpdateNotification && <UpdateNotification />}

      {/* 全局 Toast 通知 */}
      <Toaster />
    </>
  );
}

export default App;
