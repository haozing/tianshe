/**
 * Activity Bar 组件 - VSCode 风格的左侧活动栏
 * 用于切换主要功能模块（数据表、插件市场等）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  LayoutDashboard,
  Monitor,
  Puzzle,
  Settings,
  Store,
  UserRound,
} from 'lucide-react';
import { useUIStore, type ActiveView } from '../../stores/uiStore';
import { renderStringIcon } from '../../lib/string-icon';
import { cn } from '../../lib/utils';
import type { JSPluginInfo } from '../../../../types/js-plugin';
import { buildPluginMenuTree } from './plugin-menu-tree';
import { CloudAuthDialog } from './CloudAuthDialog';
import { useCloudAuthStore } from '../../stores/cloudAuthStore';
import { isCloudAuthAvailable, isCloudWorkbenchAvailable } from '../../lib/edition';

interface ActivityBarButtonProps {
  icon: React.ReactNode;
  label: string;
  value: ActiveView;
  isActive: boolean;
  onClick: () => void;
  collapsed: boolean;
}

/**
 * 单个 Activity Bar 按钮
 */
function ActivityBarButton({ icon, label, isActive, onClick, collapsed }: ActivityBarButtonProps) {
  const displayLabel = collapsed ? '' : clampMenuTitle(label);
  return (
    <button
      onClick={onClick}
      title={label} // 使用原生 title 作为 tooltip
      className={cn(
        'relative w-full h-12 flex items-center',
        collapsed ? 'justify-center' : 'justify-start gap-2 px-3',
        'transition-colors duration-200',
        'group',
        isActive
          ? 'bg-white/80 text-slate-900 shadow-sm'
          : 'text-slate-600 hover:bg-white/60 hover:text-slate-900'
      )}
      aria-label={label}
      aria-pressed={isActive}
    >
      {/* 左侧激活指示器 */}
      {isActive && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />}

      {/* 图标 */}
      <div className={cn('flex items-center justify-center', collapsed ? '' : 'w-6')}>{icon}</div>

      {/* 文本（最多显示 4 个字） */}
      {!collapsed && (
        <span className="text-sm font-medium truncate max-w-[4em]" title={label}>
          {displayLabel}
        </span>
      )}
    </button>
  );
}

/**
 * Activity Bar 主组件
 */
interface PluginViewInfoSummary {
  hasPageView: boolean;
  pageViewId?: string;
  tempViewCount?: number;
  tempViewIds?: string[];
}

function clampMenuTitle(title: string, maxChars = 4): string {
  const chars = Array.from(title);
  if (chars.length <= maxChars) return title;
  return chars.slice(0, maxChars).join('');
}

function renderActivityPluginIcon(
  plugin: JSPluginInfo,
  size: 'large' | 'normal' = 'normal'
): React.ReactNode {
  const iconValue = plugin.activityBarViewIcon || plugin.icon;
  const isLarge = size === 'large';

  return renderStringIcon(iconValue, {
    size: isLarge ? 24 : 20,
    lucideClassName: isLarge ? 'w-6 h-6' : 'w-5 h-5',
    emojiClassName: isLarge ? 'text-2xl leading-none' : 'text-xl leading-none',
    imageClassName: isLarge ? 'w-6 h-6 object-contain' : 'w-5 h-5 object-contain',
    fallback: isLarge ? <Puzzle className="w-6 h-6" /> : <Puzzle className="w-5 h-5" />,
    alt: plugin.name,
  });
}

export function ActivityBar() {
  const {
    activeView,
    setActiveView,
    openAccountCenterTab,
    activePluginView,
    setActivePluginView,
    isActivityBarCollapsed,
    toggleActivityBar,
    isCloudAuthDialogOpen,
    setCloudAuthDialogOpen,
  } = useUIStore();

  // ✅ 加载插件列表
  const [plugins, setPlugins] = useState<JSPluginInfo[]>([]);
  const [pluginViewInfo, setPluginViewInfo] = useState<Record<string, PluginViewInfoSummary>>({});
  const [openPluginCategory, setOpenPluginCategory] = useState<Record<string, boolean>>({});
  const [openPluginSubCategory, setOpenPluginSubCategory] = useState<Record<string, boolean>>({});
  const cloudAuthState = useCloudAuthStore((state) => state.authState);
  const cloudSession = useCloudAuthStore((state) => state.session);
  const loadCloudSession = useCloudAuthStore((state) => state.loadSession);
  const cloudAuthAvailable = isCloudAuthAvailable();
  const cloudWorkbenchAvailable = isCloudWorkbenchAvailable();
  const hiddenPluginViewForCloudAuthRef = useRef<string | null>(null);

  const asideRef = useRef<HTMLElement | null>(null);

  // ✅ 同步侧边栏真实宽度到主进程（用于正确计算 WebContentsView 的 x 偏移，避免遮挡侧边栏）
  useEffect(() => {
    const setWidth = window.electronAPI?.view?.setActivityBarWidth;
    if (typeof setWidth !== 'function') {
      return;
    }

    const target = asideRef.current;
    if (!target) {
      return;
    }

    let rafId = 0;

    const syncWidth = () => {
      rafId = 0;
      const width = Math.round(target.getBoundingClientRect().width);
      if (!Number.isFinite(width) || width <= 0) {
        return;
      }

      setWidth(width).catch((error) => {
        console.error('[ActivityBar] Failed to sync activity bar width:', error);
      });
    };

    // 初次同步一次，确保插件视图初始布局正确
    syncWidth();

    const resizeObserver = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(syncWidth);
    });

    resizeObserver.observe(target);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, []);

  // 加载有 activityBarView 的插件
  useEffect(() => {
    async function loadPlugins() {
      try {
        const result = await window.electronAPI.jsPlugin.list();
        if (result.success && result.plugins) {
          // 🆕 过滤出已启用且有 activityBarView 配置的插件
          const pluginList = Array.isArray(result.plugins)
            ? (result.plugins as JSPluginInfo[])
            : [];
          const pluginsWithViews = pluginList.filter(
            (plugin) => plugin.hasActivityBarView && plugin.enabled !== false
          );
          setPlugins(pluginsWithViews);

          // 预加载插件视图信息
          for (const plugin of pluginsWithViews) {
            const viewInfo = await window.electronAPI.jsPlugin.getPluginViewInfo(plugin.id);
            if (viewInfo.success && viewInfo.viewInfo) {
              const normalized: PluginViewInfoSummary = {
                hasPageView: Boolean(viewInfo.viewInfo.hasPageView),
                pageViewId:
                  typeof viewInfo.viewInfo.pageViewId === 'string'
                    ? viewInfo.viewInfo.pageViewId
                    : undefined,
                tempViewCount: Number(viewInfo.viewInfo.tempViewCount ?? 0),
                tempViewIds: Array.isArray(viewInfo.viewInfo.tempViewIds)
                  ? viewInfo.viewInfo.tempViewIds.filter(
                      (id: unknown): id is string => typeof id === 'string'
                    )
                  : [],
              };
              setPluginViewInfo((prev) => ({
                ...prev,
                [plugin.id]: normalized,
              }));
            }
          }
        }
      } catch (error) {
        console.error('[ActivityBar] Failed to load plugins:', error);
      }
    }

    loadPlugins();

    // 监听插件状态变化，重新加载列表
    const unsubscribe = window.electronAPI.jsPlugin.onPluginStateChanged(() => {
      loadPlugins();
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // 处理插件按钮点击
  const handlePluginClick = async (pluginId: string) => {
    try {
      // 1. 先隐藏之前的插件视图（如果有）
      if (activePluginView && activePluginView !== pluginId) {
        await window.electronAPI.jsPlugin.hidePluginView(activePluginView);
      }

      // 2. 清理所有临时浏览器窗口（避免遗留之前插件创建的临时窗口）
      try {
        const detachScoped = window.electronAPI?.view?.detachScoped;
        if (typeof detachScoped === 'function') {
          await detachScoped({
            windowId: 'main',
            scope: 'automation',
            preserveDockedRight: true,
          });
        } else {
          const detachAll = window.electronAPI?.view?.detachAll;
          if (typeof detachAll === 'function') {
            await detachAll({
              windowId: 'main',
              preserveDockedRight: true,
            });
          } else {
            console.warn('[ActivityBar] View detach API is unavailable in renderer context');
          }
        }
      } catch (error) {
        console.error('[ActivityBar] Failed to detach views:', error);
      }

      // 3. 设置活动插件视图
      setActivePluginView(pluginId);

      // 4. 显示插件视图（布局自动从 manifest 计算）
      await window.electronAPI.jsPlugin.showPluginView(pluginId);
    } catch (error) {
      console.error(`[ActivityBar] Failed to show plugin view ${pluginId}:`, error);
    }
  };

  const activities: Array<{
    value: ActiveView;
    icon: React.ReactNode;
    label: string;
  }> = useMemo(
    () => [
      ...(cloudWorkbenchAvailable
        ? [
            {
              value: 'workbench' as const,
              icon: <LayoutDashboard className="w-6 h-6" />,
              label: '工作台',
            },
          ]
        : []),
      {
        value: 'datasets',
        icon: <Database className="w-6 h-6" />,
        label: '数据表',
      },
      {
        value: 'marketplace',
        icon: <Store className="w-6 h-6" />,
        label: '插件市场',
      },
      {
        value: 'accountCenter',
        icon: <Monitor className="w-6 h-6" />,
        label: '账号中心',
      },
    ],
    [cloudWorkbenchAvailable]
  );

  const pluginTree = useMemo(() => buildPluginMenuTree(plugins), [plugins]);
  const cloudLabel = useMemo(() => {
    if (!cloudSession.loggedIn) return '云端登录';
    if (cloudAuthState !== 'ready') return '云端恢复中';
    return cloudSession.user?.name || cloudSession.user?.userName || '云端用户';
  }, [cloudAuthState, cloudSession.loggedIn, cloudSession.user?.name, cloudSession.user?.userName]);

  useEffect(() => {
    if (!cloudAuthAvailable) return;
    void loadCloudSession();
  }, [cloudAuthAvailable, loadCloudSession]);

  useEffect(() => {
    let disposed = false;

    const syncCloudAuthDialogVisibility = async () => {
      if (!cloudAuthAvailable) return;
      if (isCloudAuthDialogOpen) {
        if (
          activeView !== 'plugin' ||
          !activePluginView ||
          hiddenPluginViewForCloudAuthRef.current
        ) {
          return;
        }

        try {
          await window.electronAPI.jsPlugin.hidePluginView(activePluginView);
          if (!disposed) {
            hiddenPluginViewForCloudAuthRef.current = activePluginView;
          }
        } catch (error) {
          console.error(
            `[ActivityBar] Failed to hide plugin view ${activePluginView} for cloud auth dialog:`,
            error
          );
        }
        return;
      }

      const hiddenPluginId = hiddenPluginViewForCloudAuthRef.current;
      if (!hiddenPluginId) {
        return;
      }

      hiddenPluginViewForCloudAuthRef.current = null;
      try {
        await window.electronAPI.jsPlugin.showPluginView(hiddenPluginId);
      } catch (error) {
        console.error(
          `[ActivityBar] Failed to restore plugin view ${hiddenPluginId} after cloud auth dialog:`,
          error
        );
      }
    };

    void syncCloudAuthDialogVisibility();

    return () => {
      disposed = true;
    };
  }, [activePluginView, activeView, cloudAuthAvailable, isCloudAuthDialogOpen]);

  return (
    <>
      <aside
        ref={asideRef}
        className={cn(
          'flex-shrink-0 h-full',
          isActivityBarCollapsed ? 'w-12' : 'w-40',
          'shell-sidebar-surface border-r flex flex-col',
          'transition-[width] duration-200 ease-out'
        )}
        role="navigation"
        aria-label="主导航"
      >
        {/* 主导航顶部：云端登录 + 展开/收起 */}
        <div
          className={cn(
            'h-12 flex items-center',
            isActivityBarCollapsed ? 'justify-center px-0' : 'justify-between px-2'
          )}
        >
          {!isActivityBarCollapsed && cloudAuthAvailable && (
            <button
              type="button"
              title={cloudSession.loggedIn ? `云端账号：${cloudLabel}` : '云端登录'}
              aria-label={cloudSession.loggedIn ? '云端账号' : '云端登录'}
              onClick={() => setCloudAuthDialogOpen(true)}
              className={cn(
                'relative rounded-md flex items-center justify-center h-8 w-8',
                'text-slate-600 hover:bg-white/70 hover:text-slate-900',
                'transition-colors'
              )}
            >
              <UserRound className="h-4 w-4" />
              {cloudAuthState === 'ready' && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={toggleActivityBar}
            title={isActivityBarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-label={isActivityBarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            className={cn(
              'rounded-md flex items-center justify-center',
              isActivityBarCollapsed ? 'h-6 w-6' : 'h-8 w-8',
              'text-slate-600 hover:bg-white/70 hover:text-slate-900',
              'transition-colors'
            )}
          >
            {isActivityBarCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Activity Bar 按钮列表 */}
        <div className="flex flex-col">
          {activities.map((activity) => (
            <ActivityBarButton
              key={activity.value}
              icon={activity.icon}
              label={activity.label}
              value={activity.value}
              isActive={activeView === activity.value}
              onClick={() => {
                if (activity.value === 'accountCenter') {
                  openAccountCenterTab('accounts');
                  return;
                }
                setActiveView(activity.value);
              }}
              collapsed={isActivityBarCollapsed}
            />
          ))}

          {/* ✅ 插件按钮 */}
          {plugins.length > 0 && (
            <>
              {/* 分隔线 */}
              <div className="h-px bg-border my-1 mx-2" />

              {/* 插件列表（支持二级分类） */}
              {isActivityBarCollapsed ? (
                pluginTree.flatPlugins.map((plugin) => (
                  <button
                    key={plugin.id}
                    onClick={() => handlePluginClick(plugin.id)}
                    title={plugin.name}
                    className={cn(
                      'relative w-full h-12 flex items-center justify-center',
                      'transition-colors duration-200',
                      'group',
                      activeView === 'plugin' && activePluginView === plugin.id
                        ? 'bg-white/80 text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:bg-white/60 hover:text-slate-900'
                    )}
                    aria-label={plugin.name}
                    aria-pressed={activeView === 'plugin' && activePluginView === plugin.id}
                  >
                    {/* 左侧激活指示器 */}
                    {activeView === 'plugin' && activePluginView === plugin.id && (
                      <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />
                    )}

                    {/* 图标 */}
                    <div className="flex items-center justify-center">
                      {renderActivityPluginIcon(plugin, 'large')}
                    </div>

                    {/* 视图状态指示器（如果有视图） */}
                    {pluginViewInfo[plugin.id]?.hasPageView && (
                      <div className="absolute bottom-1 right-1 w-1.5 h-1.5 bg-green-500 rounded-full" />
                    )}
                  </button>
                ))
              ) : (
                <div className="flex flex-col">
                  {pluginTree.level1Order.map((level1) => {
                    const isOpen = openPluginCategory[level1] ?? true;
                    const level1Label = clampMenuTitle(level1);

                    return (
                      <div key={level1} className="flex flex-col">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenPluginCategory((prev) => ({
                              ...prev,
                              [level1]: !(prev[level1] ?? true),
                            }))
                          }
                          title={level1}
                          className={cn(
                            'w-full h-9 flex items-center justify-start gap-2 px-3',
                            'text-xs font-medium text-slate-500',
                            'hover:bg-white/60 hover:text-slate-900',
                            'transition-colors'
                          )}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 opacity-70" />
                          )}
                          <span className="truncate max-w-[4em]">{level1Label}</span>
                        </button>

                        {isOpen && (
                          <div className="flex flex-col">
                            {pluginTree.level2Order.get(level1)?.map((level2) => {
                              const level2Map = pluginTree.byLevel1.get(level1);
                              const pluginList = level2Map?.get(level2) ?? [];

                              // level2 为空：表示只有一级分类，直接列插件
                              if (!level2) {
                                return pluginList.map((plugin) => {
                                  const isSelected =
                                    activeView === 'plugin' && activePluginView === plugin.id;

                                  return (
                                    <button
                                      key={plugin.id}
                                      onClick={() => handlePluginClick(plugin.id)}
                                      title={plugin.name}
                                      className={cn(
                                        'relative w-full h-10 flex items-center justify-start gap-2 px-6',
                                        'transition-colors duration-200',
                                        isSelected
                                          ? 'bg-white/80 text-slate-900 shadow-sm'
                                          : 'text-slate-600 hover:bg-white/60 hover:text-slate-900'
                                      )}
                                      aria-label={plugin.name}
                                      aria-pressed={isSelected}
                                    >
                                      {isSelected && (
                                        <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />
                                      )}
                                      <div className="flex items-center justify-center w-6">
                                        {renderActivityPluginIcon(plugin, 'normal')}
                                      </div>
                                      <span
                                        className="text-sm font-medium truncate max-w-[4em]"
                                        title={plugin.name}
                                      >
                                        {clampMenuTitle(plugin.name)}
                                      </span>
                                      {pluginViewInfo[plugin.id]?.hasPageView && (
                                        <div className="absolute right-2 w-1.5 h-1.5 bg-green-500 rounded-full" />
                                      )}
                                    </button>
                                  );
                                });
                              }

                              const subKey = `${level1}::${level2}`;
                              const subOpen = openPluginSubCategory[subKey] ?? true;
                              const level2Label = clampMenuTitle(level2);

                              return (
                                <div key={subKey} className="flex flex-col">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setOpenPluginSubCategory((prev) => ({
                                        ...prev,
                                        [subKey]: !(prev[subKey] ?? true),
                                      }))
                                    }
                                    title={level2}
                                    className={cn(
                                      'w-full h-8 flex items-center justify-start gap-2 pl-8 pr-3',
                                      'text-xs text-slate-500',
                                      'hover:bg-white/60 hover:text-slate-900',
                                      'transition-colors'
                                    )}
                                  >
                                    {subOpen ? (
                                      <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5 opacity-70" />
                                    )}
                                    <span className="truncate max-w-[4em]">{level2Label}</span>
                                  </button>

                                  {subOpen &&
                                    pluginList.map((plugin) => {
                                      const isSelected =
                                        activeView === 'plugin' && activePluginView === plugin.id;

                                      return (
                                        <button
                                          key={plugin.id}
                                          onClick={() => handlePluginClick(plugin.id)}
                                          title={plugin.name}
                                          className={cn(
                                            'relative w-full h-10 flex items-center justify-start gap-2 pl-12 pr-3',
                                            'transition-colors duration-200',
                                            isSelected
                                              ? 'bg-white/80 text-slate-900 shadow-sm'
                                              : 'text-slate-600 hover:bg-white/60 hover:text-slate-900'
                                          )}
                                          aria-label={plugin.name}
                                          aria-pressed={isSelected}
                                        >
                                          {isSelected && (
                                            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />
                                          )}
                                          <div className="flex items-center justify-center w-6">
                                            {renderActivityPluginIcon(plugin, 'normal')}
                                          </div>
                                          <span
                                            className="text-sm font-medium truncate max-w-[4em]"
                                            title={plugin.name}
                                          >
                                            {clampMenuTitle(plugin.name)}
                                          </span>
                                          {pluginViewInfo[plugin.id]?.hasPageView && (
                                            <div className="absolute right-2 w-1.5 h-1.5 bg-green-500 rounded-full" />
                                          )}
                                        </button>
                                      );
                                    })}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部空间 */}
        <div className="flex-1" />

        {/* 底部功能按钮 */}
        <div className="flex flex-col">
          <ActivityBarButton
            icon={<Settings className="w-6 h-6" />}
            label="设置"
            value="settings"
            isActive={activeView === 'settings'}
            onClick={() => setActiveView('settings')}
            collapsed={isActivityBarCollapsed}
          />
        </div>
      </aside>

      {cloudAuthAvailable ? (
        <CloudAuthDialog open={isCloudAuthDialogOpen} onOpenChange={setCloudAuthDialogOpen} />
      ) : null}
    </>
  );
}

export default ActivityBar;
