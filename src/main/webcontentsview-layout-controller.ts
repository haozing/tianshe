import type { Rectangle } from 'electron';
import { CLOUD_WORKBENCH_VIEW_ID } from '../constants/cloud';
import { DEFAULT_SPLIT_SIZE } from '../constants/layout';
import { isDevelopmentMode } from '../constants/runtime-config';
import { LayoutCalculator } from './layout-calculator';
import {
  buildPluginLayoutInfo,
  calculateDockedPluginPageBounds,
  calculateMainWindowPluginLayout,
  type PluginLayoutInfo,
} from './plugin-layout';
import type { WindowManager } from './window-manager';
import type { ViewBounds, ViewDisplayMode, WebContentsViewInfo } from './webcontentsview-manager';

const OFFSCREEN_BOUNDS: ViewBounds = {
  x: 10000,
  y: 0,
  width: 1920,
  height: 1080,
};

type MainWorkspaceBounds = {
  windowInfo: { width: number; height: number; activityBarWidth: number };
  fullBounds: ViewBounds;
  pluginBounds: ViewBounds;
  contentTopInset: number;
  rightDockBounds?: ViewBounds;
};

export type RightDockedPoolViewState = {
  viewId: string;
  size: number | string;
  pluginId?: string;
};

type PluginDockLayoutState = {
  viewId: string;
  size: number | string;
};

export interface WebContentsViewLayoutControllerDeps {
  windowManager: WindowManager;
  pool: Map<string, WebContentsViewInfo>;
  getActivityBarWidth(): number;
  getViewType(viewId: string): 'page' | 'temp' | 'pool' | 'unknown';
  attachView(viewId: string, windowId: string, bounds: ViewBounds): void;
  detachView(viewId: string): void;
  updateBounds(viewId: string, bounds: ViewBounds): void;
  scheduleViewportDebug(viewId: string, reason: string): void;
  setActivePluginId(pluginId: string | null): void;
}

export class WebContentsViewLayoutController {
  private rightDockedPoolView: RightDockedPoolViewState | null = null;
  private pluginDockLayouts = new Map<string, PluginDockLayoutState>();

  constructor(private deps: WebContentsViewLayoutControllerDeps) {}

  getRightDockedViewId(): string | undefined {
    return this.rightDockedPoolView?.viewId;
  }

  clearRightDockedViewIfMatches(viewId: string): boolean {
    if (this.rightDockedPoolView?.viewId !== viewId) {
      return false;
    }
    this.rightDockedPoolView = null;
    return true;
  }

  reset(): void {
    this.rightDockedPoolView = null;
    this.pluginDockLayouts.clear();
  }
  removePluginDockLayoutsByView(viewId: string): string[] {
    const removed: string[] = [];
    for (const [pluginId, state] of this.pluginDockLayouts.entries()) {
      if (state.viewId === viewId) {
        this.pluginDockLayouts.delete(pluginId);
        removed.push(pluginId);
      }
    }
    return removed;
  }

  /**
   * 🆕 按插件恢复右栏布局
   *
   * 规则：
   * - 切换插件时，先隐藏旧插件的 docked-right 视图（保留映射，便于切回恢复）。
   * - 如果目标插件有记录的右栏视图，则恢复该视图。
   * - 如果没有记录，则插件页使用全宽布局。
   */
  applyPluginDockLayout(pluginId: string): void {
    const normalizedPluginId = pluginId.trim();
    if (!normalizedPluginId) {
      return;
    }

    this.deps.setActivePluginId(normalizedPluginId);

    const currentDock = this.rightDockedPoolView;
    const desiredDock = this.pluginDockLayouts.get(normalizedPluginId);

    if (currentDock && currentDock.pluginId !== normalizedPluginId) {
      const currentDockView = this.deps.pool.get(currentDock.viewId);
      if (currentDockView) {
        if (!currentDockView.metadata) currentDockView.metadata = {};
        currentDockView.metadata.displayMode = 'offscreen';
        if (currentDockView.attachedTo === 'main') {
          try {
            this.deps.updateBounds(currentDock.viewId, OFFSCREEN_BOUNDS);
          } catch (error) {
            console.warn(
              `[applyPluginDockLayout] Failed to hide previous dock view ${currentDock.viewId}:`,
              error
            );
          }
        }
      }
      this.rightDockedPoolView = null;
    }

    if (!desiredDock) {
      this.handleWindowResize();
      return;
    }

    const desiredViewInfo = this.deps.pool.get(desiredDock.viewId);
    if (!desiredViewInfo) {
      this.pluginDockLayouts.delete(normalizedPluginId);
      if (this.rightDockedPoolView?.pluginId === normalizedPluginId) {
        this.rightDockedPoolView = null;
      }
      this.handleWindowResize();
      return;
    }

    if (this.deps.getViewType(desiredDock.viewId) !== 'pool') {
      this.pluginDockLayouts.delete(normalizedPluginId);
      if (this.rightDockedPoolView?.pluginId === normalizedPluginId) {
        this.rightDockedPoolView = null;
      }
      this.handleWindowResize();
      return;
    }

    if (desiredViewInfo.attachedTo && desiredViewInfo.attachedTo !== 'main') {
      this.deps.detachView(desiredDock.viewId);
    }

    if (desiredViewInfo.attachedTo !== 'main') {
      const workspace = this.calculateMainWorkspaceBounds();
      if (!workspace) {
        return;
      }
      try {
        this.deps.attachView(desiredDock.viewId, 'main', workspace.fullBounds);
      } catch (error) {
        console.warn(
          `[applyPluginDockLayout] Failed to attach dock view ${desiredDock.viewId} to main window:`,
          error
        );
        return;
      }
    }

    const restored = this.setRightDockedPoolView(
      desiredDock.viewId,
      desiredDock.size,
      normalizedPluginId
    );
    if (!restored) {
      this.pluginDockLayouts.delete(normalizedPluginId);
      if (this.rightDockedPoolView?.pluginId === normalizedPluginId) {
        this.rightDockedPoolView = null;
      }
      this.handleWindowResize();
    }
  }

  private calculateMainWorkspaceBounds(windowBounds?: Rectangle): MainWorkspaceBounds | null {
    const mainWindow = this.deps.windowManager.getMainWindowV3();
    if (!mainWindow) return null;

    const contentBounds = windowBounds ?? mainWindow.getContentBounds();
    const baseLayout = calculateMainWindowPluginLayout(contentBounds, this.deps.getActivityBarWidth());
    const { windowInfo, fullBounds, pluginBounds: fullscreenPluginBounds } = baseLayout;

    if (!this.rightDockedPoolView) {
      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: fullscreenPluginBounds,
        contentTopInset: baseLayout.contentTopInset,
      };
    }

    const dockedViewInfo = this.deps.pool.get(this.rightDockedPoolView.viewId);
    if (
      !dockedViewInfo ||
      dockedViewInfo.attachedTo !== 'main' ||
      dockedViewInfo.metadata?.displayMode !== 'docked-right'
    ) {
      this.rightDockedPoolView = null;
      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: fullscreenPluginBounds,
        contentTopInset: baseLayout.contentTopInset,
      };
    }

    try {
      const splitResult = LayoutCalculator.calculateSplitLayout(
        {
          mode: 'split-right',
          size: this.rightDockedPoolView.size,
        },
        fullBounds
      );

      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: calculateDockedPluginPageBounds(
          splitResult.primary,
          baseLayout.rendererTopInset,
          baseLayout.contentTopInset
        ),
        contentTopInset: baseLayout.contentTopInset,
        rightDockBounds: splitResult.secondary,
      };
    } catch (error) {
      console.warn('⚠️ Failed to calculate right dock bounds, fallback to full layout:', error);
      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: fullscreenPluginBounds,
        contentTopInset: baseLayout.contentTopInset,
      };
    }
  }


  /**
   * ✨ 设置窗口尺寸变化监听器（通过 window-manager 的回调机制）
   * @public 必须在主窗口创建完成后调用此方法
   * @returns 清理函数（取消注册回调），失败时返回 null
   */
  setupWindowResizeListener(): (() => void) | null {
    // 通过 window-manager 的回调机制注册监听器
    // 这样可以自动受益于防抖和全屏事件支持
    try {
      const unregister = this.deps.windowManager.registerMainWindowResizeCallback((bounds) => {
        console.log(`📐 [WebContentsViewManager] Received size change notification:`, bounds);
        this.handleWindowResize(bounds);
      });

      console.log('✅ Window size change listener registered via window-manager');
      return unregister;
    } catch (error) {
      console.error('❌ Failed to register window size change listener:', error);
      return null;
    }
  }

  /**
   * ✨ 处理窗口 resize 事件
   *
   * 统一管理所有视图的 resize 响应：
   * - pageView: 插件主页面，始终占用插件可用区域
   * - temp: 临时视图，全屏显示
   * - pool: 浏览器池视图，根据 displayMode 决定是否更新
   */
  handleWindowResize(windowBounds?: Rectangle): void {
    const workspace = this.calculateMainWorkspaceBounds(windowBounds);
    if (!workspace) return;

    const { windowInfo, fullBounds, pluginBounds, rightDockBounds } = workspace;

    console.log(`📐 Window content resized to: ${windowInfo.width}x${windowInfo.height}`);

    // 遍历所有已附加的视图
    this.deps.pool.forEach((viewInfo, viewId) => {
      // 必须已附加到窗口
      if (!viewInfo.attachedTo) return;

      // 判断视图类型
      const viewType = this.deps.getViewType(viewId);

      if (viewType === 'page') {
        // pageView：需要 pluginId
        if (!viewInfo.metadata?.pluginId) return;
        const pluginId = viewInfo.metadata.pluginId;

        // 插件页面始终使用主工作区（如果存在 docked-right 视图，则是 left 区域）
        this.deps.updateBounds(viewId, pluginBounds);
        this.deps.scheduleViewportDebug(viewId, 'window-resize');
        if (isDevelopmentMode()) {
          console.log(`✅ Updated pageView layout for plugin ${pluginId}:`, pluginBounds);
        } else {
          console.log(`✅ Updated pageView layout for plugin ${pluginId}`);
        }
      } else if (viewType === 'temp') {
        // 临时视图：直接更新为全屏
        this.deps.updateBounds(viewId, fullBounds);
        this.deps.scheduleViewportDebug(viewId, 'window-resize(temp)');
        console.log(`✅ Updated temporary view: ${viewId}`);
      } else if (viewType === 'pool') {
        // 🆕 浏览器池视图：根据 displayMode 决定是否更新
        const displayMode = viewInfo.metadata?.displayMode;

        switch (displayMode) {
          case 'fullscreen':
            // 工作台需要避开 Windows 标题栏按钮区域，其余 fullscreen 视图保持原布局
            this.deps.updateBounds(
              viewId,
              viewId === CLOUD_WORKBENCH_VIEW_ID ? pluginBounds : fullBounds
            );
            console.log(`✅ Updated pool view (fullscreen): ${viewId}`);
            break;

          case 'offscreen':
            // 离屏模式：不需要更新，保持在离屏位置
            break;

          case 'popup':
            // 弹窗模式：由弹窗自己的 resize 监听器处理
            break;

          case 'docked-right':
            if (this.rightDockedPoolView?.viewId !== viewId) {
              console.warn(
                `⚠️ Pool view ${viewId} is marked as docked-right but not tracked as active dock view`
              );
              break;
            }

            if (!rightDockBounds) {
              console.warn(
                `⚠️ Right dock bounds not available for docked view ${viewId}, fallback to full bounds`
              );
              this.deps.updateBounds(viewId, fullBounds);
              break;
            }

            this.deps.updateBounds(viewId, rightDockBounds);
            console.log(`✅ Updated pool view (docked-right): ${viewId}`);
            break;

          default:
            // 🆕 displayMode 未设置：打印警告，默认不处理
            // 这通常表示旧代码创建的视图或状态不一致
            if (displayMode === undefined) {
              console.warn(`⚠️ Pool view ${viewId} has no displayMode set, skipping resize`);
            }
            break;
        }
      }
    });
  }

  /**
   * ✨ 计算插件主视图的边界（永远占满可用区域）
   */
  calculatePluginBounds(pluginId: string): ViewBounds | null {
    const workspace = this.calculateMainWorkspaceBounds();
    if (!workspace) {
      console.warn('⚠️ Main window not found');
      return null;
    }

    console.log(`✅ Calculated plugin bounds for plugin ${pluginId}:`, workspace.pluginBounds);
    return workspace.pluginBounds;
  }

  getPluginLayoutInfo(windowBounds?: Rectangle): PluginLayoutInfo | null {
    const workspace = this.calculateMainWorkspaceBounds(windowBounds);
    if (!workspace) {
      return null;
    }

    return buildPluginLayoutInfo({
      windowInfo: workspace.windowInfo,
      pluginBounds: workspace.pluginBounds,
      contentTopInset: workspace.contentTopInset,
    });
  }

  // ============================================
  // 🆕 统一视图管理 API（用于 MCP/插件/账户浏览器）
  // ============================================

  setRightDockedPoolView(
    viewId: string,
    size: number | string = DEFAULT_SPLIT_SIZE,
    pluginId?: string
  ): boolean {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`[setRightDockedPoolView] View not found: ${viewId}`);
      return false;
    }

    if (this.deps.getViewType(viewId) !== 'pool') {
      console.warn(`[setRightDockedPoolView] Only pool views can be docked-right: ${viewId}`);
      return false;
    }

    const normalizedPluginId =
      typeof pluginId === 'string' && pluginId.trim().length > 0 ? pluginId.trim() : undefined;

    const previousDockedViewId = this.rightDockedPoolView?.viewId;
    if (previousDockedViewId && previousDockedViewId !== viewId) {
      const previousDockedView = this.deps.pool.get(previousDockedViewId);
      if (previousDockedView) {
        if (!previousDockedView.metadata) previousDockedView.metadata = {};
        previousDockedView.metadata.displayMode = 'offscreen';
        if (previousDockedView.attachedTo === 'main') {
          this.deps.updateBounds(previousDockedViewId, OFFSCREEN_BOUNDS);
        }
      }
    }

    this.rightDockedPoolView = { viewId, size, pluginId: normalizedPluginId };
    if (normalizedPluginId) {
      this.pluginDockLayouts.set(normalizedPluginId, { viewId, size });
    }

    if (!viewInfo.metadata) {
      viewInfo.metadata = {};
    }
    viewInfo.metadata.displayMode = 'docked-right';

    if (viewInfo.attachedTo === 'main') {
      this.handleWindowResize();
    }

    console.log(
      `✅ [setRightDockedPoolView] Docked right view set: ${viewId} (size=${String(size)}, plugin=${normalizedPluginId ?? 'none'})`
    );
    return true;
  }

  clearRightDockedPoolView(viewId?: string): boolean {
    if (!this.rightDockedPoolView) {
      return false;
    }

    if (viewId && this.rightDockedPoolView.viewId !== viewId) {
      return false;
    }

    const dockedState = this.rightDockedPoolView;
    const dockedViewId = dockedState.viewId;
    const dockedViewInfo = this.deps.pool.get(dockedViewId);
    this.rightDockedPoolView = null;
    if (dockedState.pluginId) {
      this.pluginDockLayouts.delete(dockedState.pluginId);
    }

    if (
      dockedViewInfo &&
      dockedViewInfo.metadata?.displayMode === 'docked-right' &&
      dockedViewInfo.attachedTo === 'main'
    ) {
      dockedViewInfo.metadata.displayMode = 'offscreen';
      this.deps.updateBounds(dockedViewId, OFFSCREEN_BOUNDS);
    }

    this.handleWindowResize();
    console.log(`✅ [clearRightDockedPoolView] Cleared docked right view: ${dockedViewId}`);
    return true;
  }

  getRightDockedPoolView(): RightDockedPoolViewState | null {
    if (!this.rightDockedPoolView) return null;
    return { ...this.rightDockedPoolView };
  }

  /**
   * 🆕 设置视图的显示模式
   *
   * 当浏览器池视图需要从离屏切换到全屏显示（或反之）时调用。
   * 这会更新视图的 displayMode 元数据，使其能够正确响应窗口 resize。
   *
   * @param viewId 视图 ID
   * @param displayMode 显示模式
   * @returns 是否成功设置
   */
  setViewDisplayMode(viewId: string, displayMode: ViewDisplayMode): boolean {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`[setViewDisplayMode] View not found: ${viewId}`);
      return false;
    }

    const beforeDockedViewId = this.rightDockedPoolView?.viewId;

    if (displayMode === 'docked-right') {
      const currentDockedPluginId =
        this.rightDockedPoolView?.viewId === viewId ? this.rightDockedPoolView.pluginId : undefined;
      this.rightDockedPoolView = {
        viewId,
        size: this.rightDockedPoolView?.size ?? DEFAULT_SPLIT_SIZE,
        pluginId: currentDockedPluginId,
      };
    } else if (this.rightDockedPoolView?.viewId === viewId) {
      this.rightDockedPoolView = null;
    }

    // 更新元数据
    if (!viewInfo.metadata) {
      viewInfo.metadata = {};
    }
    viewInfo.metadata.displayMode = displayMode;

    const afterDockedViewId = this.rightDockedPoolView?.viewId;
    const dockStateChanged = beforeDockedViewId !== afterDockedViewId;
    if (dockStateChanged && viewInfo.attachedTo === 'main') {
      this.handleWindowResize();
    }

    console.log(`✅ [setViewDisplayMode] Set displayMode=${displayMode} for view: ${viewId}`);
    return true;
  }

}
