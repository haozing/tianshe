import { isDevelopmentMode } from '../constants/runtime-config';
import { createLogger } from '../core/logger';
import type { WindowManager } from './window-manager';
import type { WebContentsViewLayoutController } from './webcontentsview-layout-controller';
import type { WebContentsViewViewportDebugger } from './webcontentsview-viewport-debugger';
import {
  OFFSCREEN_BOUNDS,
  type DetachScopedViewsOptions,
  type ViewBounds,
  type WebContentsViewInfo,
} from './webcontentsview-types';

const logger = createLogger('WebContentsViewAttachmentController');

function boundsAlmostEqual(
  actual: { x: number; y: number; width: number; height: number },
  desired: { x: number; y: number; width: number; height: number },
  tolerance: number = 1
): boolean {
  return (
    Math.abs(actual.x - desired.x) <= tolerance &&
    Math.abs(actual.y - desired.y) <= tolerance &&
    Math.abs(actual.width - desired.width) <= tolerance &&
    Math.abs(actual.height - desired.height) <= tolerance
  );
}

export interface WebContentsViewAttachmentControllerDeps {
  pool: Map<string, WebContentsViewInfo>;
  windowManager: WindowManager;
  layoutController: WebContentsViewLayoutController;
  viewportDebugger: WebContentsViewViewportDebugger;
  handleWindowResize(): void;
}

export class WebContentsViewAttachmentController {
  constructor(private deps: WebContentsViewAttachmentControllerDeps) {}


  /**
   * 附加 View 到窗口
   * @param viewId View ID
   * @param windowId 窗口 ID (e.g., "main", "popup-xxx")
   * @param bounds 视图边界
   */
  attachView(viewId: string, windowId: string, bounds: ViewBounds): void {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found: ${viewId}`);
    }

    const window = this.deps.windowManager.getWindowById(windowId);
    if (!window) {
      throw new Error(`Window not found: ${windowId}`);
    }

    logger.info('Attaching view with bounds', { viewId, windowId, bounds });
    // 添加到窗口
    window.contentView.addChildView(viewInfo.view);

    // 先更新状态（避免 setBounds 同步触发 bounds-changed 时读到旧的 desired bounds）
    viewInfo.attachedTo = windowId;
    viewInfo.bounds = bounds;
    viewInfo.lastAccessedAt = Date.now();

    // 设置边界和可见性
    viewInfo.view.setBounds(bounds);
    viewInfo.view.setVisible(true);

    logger.info('View attached', { viewId, windowId });

    this.deps.viewportDebugger.schedule(viewId, 'attach');
  }

  /**
   * 分离 View
   */
  detachView(viewId: string): void {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo || !viewInfo.attachedTo) {
      return;
    }

    const wasMainWindow = viewInfo.attachedTo === 'main';
    const wasRightDocked = this.deps.layoutController.getRightDockedViewId() === viewId;

    // 先将视图移到离屏位置，确保不可见（双重保险）
    viewInfo.view.setBounds(OFFSCREEN_BOUNDS);

    const window = this.deps.windowManager.getWindowById(viewInfo.attachedTo);
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(viewInfo.view);
    }

    viewInfo.attachedTo = undefined;
    viewInfo.bounds = undefined;

    if (wasRightDocked) {
      this.deps.layoutController.clearRightDockedViewIfMatches(viewId);
      if (wasMainWindow) {
        this.deps.handleWindowResize();
      }
    }
  }

  /**
   * 🆕 将视图附加到窗口的离屏位置
   *
   * 用于弹窗关闭后将视图移回主窗口但保持不可见的场景。
   * 与 attachView 的区别：
   * - attachView: 视图可见，bounds 由调用者指定
   * - attachViewOffscreen: 视图不可见，使用固定的离屏 bounds
   *
   * @param viewId 视图 ID
   * @param windowId 窗口 ID (默认 "main")
   */
  attachViewOffscreen(viewId: string, windowId: string = 'main'): boolean {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo) {
      logger.warn('View not found while attaching offscreen', { viewId, windowId });
      return false;
    }

    const window = this.deps.windowManager.getWindowById(windowId);
    if (!window || window.isDestroyed()) {
      logger.warn('Window not found or destroyed while attaching offscreen', { viewId, windowId });
      return false;
    }

    const offscreenBounds = { x: 10000, y: 0, width: 1920, height: 1080 };

    // 添加到窗口（如果还没有添加）
    // 注意：如果视图已经在该窗口中，addChildView 会自动忽略
    window.contentView.addChildView(viewInfo.view);

    // 设置离屏边界
    viewInfo.view.setBounds(offscreenBounds);
    viewInfo.view.setVisible(true); // 虽然在离屏位置，但保持 visible=true 以便渲染

    // 更新状态
    viewInfo.attachedTo = windowId;
    viewInfo.bounds = offscreenBounds;
    viewInfo.lastAccessedAt = Date.now();

    logger.info('View attached offscreen', { viewId, windowId });
    return true;
  }

  /**
   * 分离所有 View
   * @param windowId 可选，指定窗口 ID 只分离该窗口的 View
   */
  detachAllViews(windowId?: string, options?: { preserveDockedRight?: boolean }): void {
    const preserveDockedRight = options?.preserveDockedRight === true;
    const dockedRightViewId = preserveDockedRight ? this.deps.layoutController.getRightDockedViewId() : undefined;

    let count = 0;
    for (const [id, info] of this.deps.pool.entries()) {
      // 如果指定了 windowId，只分离该窗口的 View
      if (windowId === undefined || info.attachedTo === windowId) {
        if (dockedRightViewId && id === dockedRightViewId) {
          continue;
        }
        this.detachView(id);
        count++;
      }
    }
    logger.info('Detached views', { count, windowId, preserveDockedRight });
  }

  /**
   * 按作用域分离 View
   *
   * 主要用于前端页面切换时的“精准清理”：
   * - automation: 清理自动化临时视图，不影响插件页面/插件分栏视图
   * - plugin: 清理插件视图
   * - all: 等同于 detachAllViews
   */
  detachScopedViews(options?: DetachScopedViewsOptions): void {
    const windowId = options?.windowId;
    const scope = options?.scope ?? 'automation';
    const preserveDockedRight = options?.preserveDockedRight === true;
    const dockedRightViewId = preserveDockedRight ? this.deps.layoutController.getRightDockedViewId() : undefined;

    if (scope === 'all') {
      this.detachAllViews(windowId, { preserveDockedRight });
      return;
    }

    let count = 0;
    for (const [id, info] of this.deps.pool.entries()) {
      if (windowId !== undefined && info.attachedTo !== windowId) {
        continue;
      }
      if (dockedRightViewId && id === dockedRightViewId) {
        continue;
      }

      const isPluginOwned = this.isPluginOwnedView(id, info);
      if (scope === 'automation' && isPluginOwned) {
        continue;
      }
      if (scope === 'plugin' && !isPluginOwned) {
        continue;
      }

      this.detachView(id);
      count++;
    }

    logger.info('Detached scoped views', { count, scope, windowId, preserveDockedRight });
  }

  private isPluginOwnedView(viewId: string, viewInfo: WebContentsViewInfo): boolean {
    if (viewId.startsWith('plugin-page:') || viewId.startsWith('plugin-temp:')) {
      return true;
    }

    const source = viewInfo.metadata?.source;
    if (source === 'plugin') {
      return true;
    }

    return Boolean(viewInfo.metadata?.pluginId);
  }

  /**
   * 切换 View（分离旧的，附加新的）
   * @param viewId View ID
   * @param windowId 窗口 ID
   * @param bounds 视图边界
   */
  switchView(viewId: string, windowId: string, bounds: ViewBounds): void {
    // 找到当前附加到该窗口的所有 View 并分离
    for (const [id, info] of this.deps.pool.entries()) {
      if (info.attachedTo === windowId) {
        this.detachView(id);
      }
    }

    // 附加新 View
    this.attachView(viewId, windowId, bounds);
  }

  /**
   * 更新 View 边界
   */
  updateBounds(viewId: string, bounds: ViewBounds): void {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found: ${viewId}`);
    }

    // 先记录“期望 bounds”，避免 setBounds 同步触发 bounds-changed 时读到旧值
    viewInfo.bounds = bounds;

    viewInfo.view.setBounds(bounds);

    // 某些平台/窗口动画场景下，setBounds 可能在同一帧被系统布局覆盖。
    // 开发模式下做一次轻量校验并补偿重试，便于定位“日志变了但界面不变”的问题。
    if (isDevelopmentMode()) {
      try {
        const actual = viewInfo.view.getBounds();
        if (!boundsAlmostEqual(actual, bounds)) {
          logger.warn('View bounds mismatch after setBounds', {
            viewId,
            requested: bounds,
            actual,
          });

          setImmediate(() => {
            const latest = this.deps.pool.get(viewId);
            if (!latest || latest.view.webContents.isDestroyed()) return;
            latest.view.setBounds(bounds);
          });
        }
      } catch (error) {
        logger.warn('Failed to verify view bounds', { viewId, error });
      }
    }

    viewInfo.lastAccessedAt = Date.now();
  }


}
