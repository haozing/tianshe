/**
 * 转换上下文管理器
 *
 * 管理坐标转换所需的上下文信息，
 * 支持从浏览器自动获取视口信息并保持同步。
 *
 * 采用组合模式：内部持有 CoordinateTransformer 实例，
 * 上下文变化时自动同步到内部的转换器。
 */

import type { TransformContext, ViewportConfig, Point } from './types';
import { createDefaultTransformContext, createViewportConfig } from './types';
import { CoordinateTransformer } from './transformer';

/**
 * 浏览器接口（用于获取视口信息）
 * 避免直接依赖 SimpleBrowser，使用接口解耦
 */
export interface BrowserLike {
  evaluate<T>(script: string): Promise<T>;
  getWebContents?(): { getBounds?: () => { x: number; y: number; width: number; height: number } };
}

/**
 * 视口信息（从浏览器获取）
 */
interface BrowserViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

/**
 * 窗口信息（从 Electron 获取）
 */
interface _WindowInfo {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 转换上下文管理器
 *
 * @example
 * ```typescript
 * const manager = new TransformContextManager();
 *
 * // 从浏览器初始化
 * await manager.initializeFromBrowser(browser);
 *
 * // 获取上下文
 * const context = manager.getContext();
 *
 * // 开启自动刷新
 * manager.startAutoRefresh(browser, 1000);
 * ```
 */
export class TransformContextManager {
  private context: TransformContext;
  private transformer: CoordinateTransformer;
  private refreshInterval?: ReturnType<typeof setInterval>;
  private lastRefreshTime: number = 0;

  constructor(initialContext?: TransformContext) {
    this.context = initialContext ?? createDefaultTransformContext();
    this.transformer = new CoordinateTransformer(this.context);
  }

  /**
   * 获取内部的坐标转换器
   *
   * 转换器会自动与上下文保持同步，无需手动同步。
   */
  getTransformer(): CoordinateTransformer {
    return this.transformer;
  }

  /**
   * 获取当前转换上下文
   */
  getContext(): TransformContext {
    return { ...this.context };
  }

  /**
   * 手动设置转换上下文
   */
  setContext(context: TransformContext): void {
    this.context = { ...context };
    this.syncTransformer();
  }

  /**
   * 部分更新上下文
   */
  updateContext(partial: Partial<TransformContext>): void {
    this.context = { ...this.context, ...partial };
    this.syncTransformer();
  }

  /**
   * 设置视口配置
   */
  setViewport(viewport: ViewportConfig): void {
    this.context.viewport = { ...viewport };
    this.syncTransformer();
  }

  /**
   * 设置窗口位置
   */
  setWindowPosition(position: Point): void {
    this.context.windowPosition = { ...position };
    this.syncTransformer();
  }

  /**
   * 设置视口偏移
   */
  setViewportOffset(offset: Point): void {
    this.context.viewportOffset = { ...offset };
    this.syncTransformer();
  }

  /**
   * 设置滚动偏移
   */
  setScrollOffset(offset: Point): void {
    this.context.scrollOffset = { ...offset };
    this.syncTransformer();
  }

  /**
   * 同步内部转换器的上下文
   */
  private syncTransformer(): void {
    this.transformer.setContext(this.context);
    this.lastRefreshTime = Date.now();
  }

  /**
   * 从浏览器初始化上下文
   *
   * @param browser 浏览器实例（需要支持 evaluate 方法）
   * @param viewportOffset 视口在窗口中的偏移（如侧边栏宽度）
   */
  async initializeFromBrowser(browser: BrowserLike, viewportOffset?: Point): Promise<void> {
    await this.refresh(browser, viewportOffset);
  }

  /**
   * 刷新上下文（从浏览器重新获取信息）
   *
   * @param browser 浏览器实例
   * @param viewportOffset 视口偏移（可选，不传则保持原值）
   */
  async refresh(browser: BrowserLike, viewportOffset?: Point): Promise<void> {
    try {
      // 获取视口信息
      const viewportInfo = await this.getViewportInfoFromBrowser(browser);

      // 更新视口配置
      this.context.viewport = createViewportConfig(
        viewportInfo.width,
        viewportInfo.height,
        viewportInfo.devicePixelRatio
      );

      // 更新滚动偏移
      this.context.scrollOffset = {
        x: viewportInfo.scrollX,
        y: viewportInfo.scrollY,
      };

      // 尝试获取窗口位置（需要 Electron 支持）
      if (browser.getWebContents?.()?.getBounds) {
        const bounds = browser.getWebContents().getBounds!();
        this.context.windowPosition = { x: bounds.x, y: bounds.y };
      }

      // 更新视口偏移
      if (viewportOffset) {
        this.context.viewportOffset = { ...viewportOffset };
      }

      // 同步到内部转换器
      this.syncTransformer();
    } catch (error) {
      // 刷新失败时保持原有上下文
      console.warn('Failed to refresh transform context:', error);
    }
  }

  /**
   * 仅刷新滚动偏移（轻量级刷新）
   */
  async refreshScrollOffset(browser: BrowserLike): Promise<void> {
    try {
      const scrollInfo = await browser.evaluate<{ scrollX: number; scrollY: number }>(`
        ({ scrollX: window.scrollX, scrollY: window.scrollY })
      `);

      this.context.scrollOffset = {
        x: scrollInfo.scrollX,
        y: scrollInfo.scrollY,
      };

      // 同步到内部转换器
      this.syncTransformer();
    } catch {
      // 忽略刷新失败
    }
  }

  /**
   * 开启自动刷新
   *
   * @param browser 浏览器实例
   * @param intervalMs 刷新间隔（毫秒），默认 1000ms
   */
  startAutoRefresh(browser: BrowserLike, intervalMs: number = 1000): void {
    this.stopAutoRefresh();

    this.refreshInterval = setInterval(async () => {
      await this.refreshScrollOffset(browser);
    }, intervalMs);
  }

  /**
   * 停止自动刷新
   */
  stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  /**
   * 获取上次刷新时间
   */
  getLastRefreshTime(): number {
    return this.lastRefreshTime;
  }

  /**
   * 检查上下文是否过期
   *
   * @param maxAgeMs 最大有效期（毫秒）
   */
  isStale(maxAgeMs: number = 5000): boolean {
    return Date.now() - this.lastRefreshTime > maxAgeMs;
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    this.stopAutoRefresh();
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 从浏览器获取视口信息
   */
  private async getViewportInfoFromBrowser(browser: BrowserLike): Promise<BrowserViewportInfo> {
    return await browser.evaluate<BrowserViewportInfo>(`
      (function() {
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          scrollX: window.scrollX || window.pageXOffset || 0,
          scrollY: window.scrollY || window.pageYOffset || 0
        };
      })()
    `);
  }

  // ============================================================================
  // 静态工厂方法
  // ============================================================================

  /**
   * 创建默认的上下文管理器（1920x1080）
   */
  static createDefault(): TransformContextManager {
    return new TransformContextManager();
  }

  /**
   * 从视口尺寸创建上下文管理器
   */
  static fromViewport(width: number, height: number): TransformContextManager {
    return new TransformContextManager({
      viewport: createViewportConfig(width, height),
      windowPosition: { x: 0, y: 0 },
      viewportOffset: { x: 0, y: 0 },
      scrollOffset: { x: 0, y: 0 },
    });
  }
}
