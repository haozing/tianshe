/**
 * 浏览器池工具函数
 */

import { createLogger } from '../logger';
import type { BrowserInterface, ReleaseOptions } from './types';
import type { WebContentsViewManager } from '../../main/webcontentsview-manager';
import type { WindowManager } from '../../main/window-manager';
import { LayoutCalculator } from '../../main/layout-calculator';
import { maybeOpenInternalBrowserDevTools } from '../../main/internal-browser-devtools';
import { MIN_VIEW_SIZE, RENDERER_TOP_INSET } from '../../constants/layout';

const logger = createLogger('BrowserPool');

type Bounds = { x: number; y: number; width: number; height: number };

function applyRendererTopInset(bounds: Bounds): Bounds {
  const inset = Math.max(0, Math.round(RENDERER_TOP_INSET));
  if (inset === 0) return bounds;
  return {
    ...bounds,
    y: bounds.y + inset,
    height: Math.max(bounds.height - inset, MIN_VIEW_SIZE),
  };
}

/**
 * 重置浏览器状态
 *
 * 根据 ReleaseOptions 执行浏览器状态重置操作：
 * - 如果浏览器支持 reset() 方法，调用它
 * - 否则，如果指定了 navigateTo，执行导航
 *
 * @param browser 浏览器实例（实现 BrowserInterface 接口）
 * @param options 重置选项
 * @param logPrefix 日志前缀（用于区分调用来源）
 * @returns 是否重置成功
 */
export async function resetBrowserState(
  browser: BrowserInterface,
  options?: Pick<ReleaseOptions, 'clearStorage' | 'navigateTo'>,
  logPrefix: string = '[BrowserPool]'
): Promise<boolean> {
  if (!options || (!options.clearStorage && !options.navigateTo)) {
    return true; // 无需重置
  }

  try {
    // 优先使用 reset 方法（如果浏览器支持，这是 SimpleBrowser 的扩展）
    if (typeof (browser as any).reset === 'function') {
      await (browser as any).reset({
        navigateTo: options.navigateTo,
        clearStorage: options.clearStorage,
      });
    } else if (options.navigateTo) {
      // 回退到标准导航（使用 BrowserInterface.goto）
      await browser.goto(options.navigateTo);
    }
    return true;
  } catch (err: unknown) {
    logger.warn(`${logPrefix} Failed to reset browser`, err);
    return false;
  }
}

/**
 * 将浏览器视图附加到窗口
 *
 * 计算正确的布局边界并将视图附加到指定窗口。
 * 此函数封装了视图附加的通用逻辑，供 ProfileNamespace 与浏览器池流程共用。
 *
 * @param viewId 视图 ID
 * @param viewManager WebContentsView 管理器
 * @param windowManager 窗口管理器
 * @param windowId 窗口 ID（默认 "main"）
 * @returns 是否成功附加
 */
export function attachBrowserView(
  viewId: string,
  viewManager: WebContentsViewManager,
  windowManager: WindowManager,
  windowId: string = 'main'
): boolean {
  const window = windowManager.getWindowById(windowId);
  if (!window) {
    logger.warn('[attachBrowserView] Window not found', { windowId });
    return false;
  }

  const windowBounds = window.getContentBounds();
  const windowInfo = LayoutCalculator.getWindowInfo(
    windowBounds,
    viewManager.getActivityBarWidth()
  );
  let bounds = LayoutCalculator.calculateFullBounds(windowInfo);
  if (windowId === 'main') {
    bounds = applyRendererTopInset(bounds);
  }
  viewManager.attachView(viewId, windowId, bounds);

  logger.debug('[attachBrowserView] View attached', { viewId, windowId });
  return true;
}

/**
 * 显示浏览器视图（将离屏视图移动到正常位置）
 *
 * 浏览器在创建时默认放在离屏位置（避免闪烁）。
 * 当需要显示浏览器时，调用此函数将其移动到正常可见位置。
 *
 * 🆕 v2 统一管理：
 * - 设置 displayMode 为 'fullscreen'，使其能响应窗口 resize
 * - 设置 source 标记，便于调试和资源追踪
 *
 * 与 attachBrowserView 的区别：
 * - attachBrowserView: 将视图添加到窗口的 contentView（可能导致闪烁）
 * - showBrowserView: 假设视图已附加，只更新位置（无闪烁）
 *
 * @param viewId 视图 ID
 * @param viewManager WebContentsView 管理器
 * @param windowManager 窗口管理器
 * @param windowId 窗口 ID（默认 "main"）
 * @param source 视图来源（可选，用于标记是 mcp/plugin/account）
 * @returns 是否成功显示
 */
export function showBrowserView(
  viewId: string,
  viewManager: WebContentsViewManager,
  windowManager: WindowManager,
  windowIdOrOptions:
    | string
    | {
        windowId?: string;
        source?: 'mcp' | 'pool' | 'account';
        layout?: 'fullscreen' | 'docked-right';
        rightDockSize?: number | string;
        pluginId?: string;
      } = 'main',
  source?: 'mcp' | 'pool' | 'account'
): boolean {
  let resolvedWindowId = 'main';
  let resolvedSource = source;
  let layoutMode: 'fullscreen' | 'docked-right' = 'fullscreen';
  let rightDockSize: number | string | undefined;
  let resolvedPluginId: string | undefined;

  if (typeof windowIdOrOptions === 'string') {
    resolvedWindowId = windowIdOrOptions;
  } else {
    resolvedWindowId = windowIdOrOptions.windowId ?? 'main';
    resolvedSource = windowIdOrOptions.source;
    layoutMode = windowIdOrOptions.layout ?? 'fullscreen';
    rightDockSize = windowIdOrOptions.rightDockSize;
    resolvedPluginId = windowIdOrOptions.pluginId;
  }

  const window = windowManager.getWindowById(resolvedWindowId);
  if (!window) {
    logger.warn('[showBrowserView] Window not found', { windowId: resolvedWindowId });
    return false;
  }

  const viewInfo = viewManager.getView(viewId);
  if (!viewInfo) {
    logger.warn('[showBrowserView] View not found', { viewId });
    return false;
  }

  const windowBounds = window.getContentBounds();
  const windowInfo = LayoutCalculator.getWindowInfo(
    windowBounds,
    viewManager.getActivityBarWidth()
  );
  let fullscreenBounds = LayoutCalculator.calculateFullBounds(windowInfo);
  if (resolvedWindowId === 'main') {
    fullscreenBounds = applyRendererTopInset(fullscreenBounds);
  }

  const needsAttach =
    viewInfo.attachedTo === undefined || viewInfo.attachedTo !== resolvedWindowId;

  try {
    if (needsAttach) {
      if (viewInfo.attachedTo && viewInfo.attachedTo !== resolvedWindowId) {
        viewManager.detachView(viewId);
      }
      viewManager.attachView(viewId, resolvedWindowId, fullscreenBounds);
    }
  } catch (err: unknown) {
    logger.warn('[showBrowserView] Failed to attach view', err);
    return false;
  }

  let bounds: Bounds | undefined;
  if (layoutMode === 'docked-right' && resolvedWindowId === 'main') {
    const docked = viewManager.setRightDockedPoolView(viewId, rightDockSize, resolvedPluginId);
    if (!docked) {
      logger.warn('[showBrowserView] Failed to set docked-right mode', { viewId });
      return false;
    }
  } else {
    bounds = fullscreenBounds;
    if (!needsAttach) {
      // 已附加时仅更新 bounds；重新附加时 attachView 已设置好边界
      viewManager.updateBounds(viewId, bounds);
    }

    // 🆕 设置 displayMode 为 fullscreen，使其能响应窗口 resize
    viewManager.setViewDisplayMode(viewId, 'fullscreen');
  }

  // 🆕 设置来源标记（如果提供）
  if (resolvedSource) {
    viewManager.setViewSource(viewId, resolvedSource);
  }

  logger.debug('[showBrowserView] View shown', {
    viewId,
    windowId: resolvedWindowId,
    layoutMode,
    bounds,
    source: resolvedSource,
    needsAttach,
  });
  return true;
}

/**
 * 离屏坐标常量
 *
 * 使用窗口相对坐标，x: 10000 足够让视图在任何窗口外不可见。
 */
const OFFSCREEN_BOUNDS = {
  x: 10000,
  y: 0,
  width: 1920,
  height: 1080,
};

/**
 * 隐藏浏览器视图（将视图移动到离屏位置）
 *
 * 当需要隐藏浏览器时（visible: false），调用此函数将视图移到离屏位置。
 * 浏览器仍然保持渲染状态，可以正常执行自动化操作。
 *
 * 🆕 v2 统一管理：
 * - 设置 displayMode 为 'offscreen'，使其不响应窗口 resize（保持固定大小）
 *
 * @param viewId 视图 ID
 * @param viewManager WebContentsView 管理器
 * @returns 是否成功隐藏
 */
export function hideBrowserView(viewId: string, viewManager: WebContentsViewManager): boolean {
  try {
    // 如果当前是右栏停靠视图，先清理停靠状态（并移除插件布局映射）
    viewManager.clearRightDockedPoolView(viewId);

    // 更新视图边界到离屏位置
    viewManager.updateBounds(viewId, OFFSCREEN_BOUNDS);

    // 🆕 设置 displayMode 为 offscreen，使其不响应窗口 resize
    viewManager.setViewDisplayMode(viewId, 'offscreen');

    logger.debug('[hideBrowserView] View hidden with displayMode=offscreen', { viewId });
    return true;
  } catch (err: unknown) {
    logger.warn('[hideBrowserView] Failed to hide view', err);
    return false;
  }
}

/**
 * 弹窗显示配置
 */
export interface PopupDisplayConfig {
  /** 弹窗标题 */
  title?: string;
  /** 弹窗宽度，默认 1200 */
  width?: number;
  /** 弹窗高度，默认 800 */
  height?: number;
  /** 是否自动打开当前浏览器视图的 DevTools；未设置时跟随全局开关 */
  openDevTools?: boolean;
  /** 关闭弹窗时的回调（用于释放浏览器等清理操作） */
  onClose?: () => void;
}

/**
 * 在弹窗中显示浏览器视图
 *
 * 创建一个新的弹窗窗口，并将浏览器视图附加到弹窗中显示。
 * 这是用于登录等需要用户交互场景的主要方法。
 *
 * 🆕 v2 统一管理：
 * - 设置 displayMode 为 'popup'，表示由弹窗自己管理 resize
 * - 弹窗关闭时设置 displayMode 为 'offscreen'
 *
 * @param viewId 视图 ID
 * @param viewManager WebContentsView 管理器
 * @param windowManager 窗口管理器
 * @param config 弹窗配置
 * @returns 弹窗 ID，失败返回 null
 */
export function showBrowserViewInPopup(
  viewId: string,
  viewManager: WebContentsViewManager,
  windowManager: WindowManager,
  config?: PopupDisplayConfig
): string | null {
  try {
    // 生成唯一的弹窗 ID
    const popupId = `popup-${viewId}-${Date.now()}`;
    const popupWindowId = `popup-${popupId}`;

    // 获取视图信息
    const viewInfo = viewManager.getView(viewId);
    if (!viewInfo) {
      logger.warn('[showBrowserViewInPopup] View not found', { viewId });
      return null;
    }

    // 创建弹窗窗口
    const popupWindow = windowManager.createPopupWindow(popupId, {
      title: config?.title || 'Browser',
      width: config?.width || 1200,
      height: config?.height || 800,
      openDevTools: config?.openDevTools,
      onClose: () => {
        // 弹窗关闭时，将视图移回主窗口的离屏位置
        try {
          // 🆕 使用 attachViewOffscreen 确保状态一致性
          // 1. 先从弹窗分离（清除旧的 attachedTo）
          viewManager.detachView(viewId);
          // 2. 重新附加到主窗口离屏位置（正确设置 attachedTo='main'）
          viewManager.attachViewOffscreen(viewId, 'main');
          // 3. 设置 displayMode 为 offscreen
          viewManager.setViewDisplayMode(viewId, 'offscreen');
        } catch (err) {
          logger.warn('[showBrowserViewInPopup] Failed to reattach view on close', err);
        }

        // 调用用户的关闭回调
        if (config?.onClose) {
          try {
            config.onClose();
          } catch (err) {
            logger.error('[showBrowserViewInPopup] Error in user onClose callback', err);
          }
        }
      },
    });

    // 先从当前窗口分离视图（如果已附加）
    if (viewInfo.attachedTo) {
      viewManager.detachView(viewId);
    }

    // 将视图附加到弹窗
    const popupBounds = popupWindow.getContentBounds();
    const viewBounds = {
      x: 0,
      y: 0,
      width: popupBounds.width,
      height: popupBounds.height,
    };

    popupWindow.contentView.addChildView(viewInfo.view);
    viewInfo.view.setBounds(viewBounds);
    viewInfo.view.setVisible(true);
    maybeOpenInternalBrowserDevTools(viewInfo.view.webContents, {
      override: config?.openDevTools,
      mode: 'detach',
    });

    // ✅ 记录 attachedTo，保证 viewManager.detachView/closeView 在弹窗场景可正确分离视图
    viewInfo.attachedTo = popupWindowId;
    viewInfo.bounds = viewBounds;
    viewInfo.lastAccessedAt = Date.now();

    // 记录关联关系
    windowManager.setPopupViewId(popupId, viewId);

    // 监听弹窗 resize，同步调整视图大小
    popupWindow.on('resize', () => {
      if (!popupWindow.isDestroyed()) {
        const newBounds = popupWindow.getContentBounds();
        const resized = {
          x: 0,
          y: 0,
          width: newBounds.width,
          height: newBounds.height,
        };
        viewInfo.view.setBounds(resized);
        viewInfo.bounds = resized;
      }
    });

    // 🆕 设置 displayMode 为 popup，表示由弹窗自己管理 resize
    viewManager.setViewDisplayMode(viewId, 'popup');
    viewManager.setViewSource(viewId, 'account');

    logger.info('[showBrowserViewInPopup] View shown in popup with displayMode=popup', {
      viewId,
      popupId,
      bounds: viewBounds,
    });

    return popupId;
  } catch (err: unknown) {
    logger.error('[showBrowserViewInPopup] Failed to show view in popup', err);
    return null;
  }
}

/**
 * 关闭弹窗并将视图移回离屏
 *
 * @param popupId 弹窗 ID
 * @param windowManager 窗口管理器
 */
export function closeBrowserPopup(popupId: string, windowManager: WindowManager): void {
  windowManager.closeWindowById(`popup-${popupId}`);
}
