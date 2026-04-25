/**
 * 主应用组件
 */

import { useEffect, useState } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import { DatasetsPage } from './components/DatasetsPage';
import { WorkbenchPanel } from './components/DatasetsPage/WorkbenchPanel';
import { AccountCenterPage } from './components/AccountCenter';
import { PluginMarketPage } from './components/PluginMarket';
import { SettingsPage } from './components/SettingsPage';
import { ActivityBar } from './components/ActivityBar';
import { useUIStore } from './stores/uiStore';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { UpdateNotification } from './components/UpdateNotification';
import { Toaster } from './components/ui/sonner';
import { AppTitleBar } from './components/layout/AppTitleBar';

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

type AppInfoResult = {
  success?: boolean;
  info?: {
    platform?: string;
    isPackaged?: boolean;
  };
};

function App() {
  const activeView = useUIStore((state) => state.activeView);
  const isActivityBarCollapsed = useUIStore((state) => state.isActivityBarCollapsed);
  const [showUpdateNotification, setShowUpdateNotification] = useState(false);
  const [appPlatform, setAppPlatform] = useState<string>('');

  useEffect(() => {
    let mounted = true;

    window.electronAPI
      .getAppInfo()
      .then((result: AppInfoResult) => {
        if (!mounted) return;
        const isPackaged = result?.success === true && result?.info?.isPackaged === true;
        setShowUpdateNotification(isPackaged);
        setAppPlatform(result?.info?.platform || '');
      })
      .catch(() => {
        if (!mounted) return;
        setShowUpdateNotification(false);
        setAppPlatform('');
      });

    return () => {
      mounted = false;
    };
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

      switch (activeView) {
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
          console.warn(`[App] Unknown activeView: ${activeView}`);
      }
    };

    handleViewSwitch();
  }, [activeView]);

  return (
    <>
      {appPlatform === 'win32' ? <AppTitleBar /> : null}

      <div
        className={`app-shell-frame flex h-full overflow-hidden ${
          appPlatform === 'win32' ? 'app-shell-frame--with-titlebar' : ''
        }`}
      >
        {/* 左侧 Activity Bar */}
        <ActivityBar />

        {/* 主内容区域 */}
        <main className="shell-content-surface flex flex-1 flex-col overflow-hidden">
          {activeView === 'datasets' ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="数据表" />}>
              <DatasetsPage />
            </ErrorBoundary>
          ) : activeView === 'workbench' ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="工作台" />}>
              <WorkbenchPanel />
            </ErrorBoundary>
          ) : activeView === 'accountCenter' ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="账号中心" />}>
              <AccountCenterPage />
            </ErrorBoundary>
          ) : activeView === 'marketplace' ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="插件市场" />}>
              <PluginMarketPage />
            </ErrorBoundary>
          ) : activeView === 'plugin' ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="插件视图" />}>
              {/* 插件视图容器 - 完全空白，WebContentsView 会通过 attachView 显示 */}
              <div className="h-full w-full bg-background" />
            </ErrorBoundary>
          ) : activeView === 'settings' ? (
            <ErrorBoundary fallback={<TabErrorFallback tabName="设置" />}>
              <SettingsPage />
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
