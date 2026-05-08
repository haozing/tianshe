/**
 * WebContentsView 管理器
 * 特性：
 * - 最多管理 15 个 WebContentsView
 * - 手动生命周期管理（无自动回收）
 * - 每个 View 独立 partition（会话隔离）
 * - 支持 CDP 调试协议
 */

import { app } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import * as path from 'path';
import { WindowManager } from './window-manager';
import {
  ACTIVITY_BAR_WIDTH,
  ACTIVITY_BAR_WIDTH_EXPANDED,
  DEFAULT_MAX_POOL_SIZE,
  DEFAULT_SPLIT_SIZE,
  MIN_VIEW_SIZE,
} from '../constants/layout';
import type { PluginLayoutInfo } from './plugin-layout';
import type { JSPluginManager } from '../core/js-plugin/manager';
import { createLogger } from '../core/logger';
import type { ActivityBarViewContribution } from '../types/js-plugin';
import { WebContentsViewSecurityController } from './webcontentsview-security-controller';
import { WebContentsViewStealthController } from './webcontentsview-stealth-controller';
import { WebContentsViewPluginPageController } from './webcontentsview-plugin-page-controller';
import {
  WebContentsViewLayoutController,
  type RightDockedPoolViewState,
} from './webcontentsview-layout-controller';
import { WebContentsViewStateController } from './webcontentsview-state-controller';
import { WebContentsViewLifecycleController } from './webcontentsview-lifecycle-controller';
import { WebContentsViewViewportDebugger } from './webcontentsview-viewport-debugger';
import { WebContentsViewAttachmentController } from './webcontentsview-attachment-controller';
import {
  type DetachScopedViewsOptions,
  type ViewBounds,
  type ViewDisplayMode,
  type ViewMetadata,
  type ViewRegistration,
  type ViewSource,
  type WebContentsViewInfo,
} from './webcontentsview-types';

const logger = createLogger('WebContentsViewManager');

export type {
  DetachScopedViewsOptions,
  ViewBounds,
  ViewDetachScope,
  ViewDisplayMode,
  ViewMetadata,
  ViewRegistration,
  ViewSource,
  WebContentsViewInfo,
} from './webcontentsview-types';
export class WebContentsViewManager {
  private registry: Map<string, ViewRegistration> = new Map();
  private pool: Map<string, WebContentsViewInfo> = new Map();
  private viewActivationTasks: Map<string, Promise<WebContentsViewInfo>> = new Map();
  private maxSize: number;
  private pluginPageController: WebContentsViewPluginPageController;
  private layoutController: WebContentsViewLayoutController;
  private stateController: WebContentsViewStateController;
  private lifecycleController: WebContentsViewLifecycleController;
  private viewportDebugger: WebContentsViewViewportDebugger;
  private attachmentController: WebContentsViewAttachmentController;
  private securityController = new WebContentsViewSecurityController();
  private stealthController = new WebContentsViewStealthController();
  private activityBarWidth = ACTIVITY_BAR_WIDTH_EXPANDED;
  private viewClosedCallback?: (viewId: string, metadata?: ViewMetadata) => void;
  private activePluginId: string | null = null;

  private resolveViewPreloadPath(metadata?: ViewMetadata): string | undefined {
    if (metadata?.source !== 'plugin') {
      return undefined;
    }
    return path.join(app.getAppPath(), 'dist', 'preload', 'webcontents-view.js');
  }

  constructor(
    private windowManager: WindowManager,
    maxSize: number = DEFAULT_MAX_POOL_SIZE
  ) {
    this.maxSize = maxSize;
    this.pluginPageController = new WebContentsViewPluginPageController({
      registry: this.registry,
      pool: this.pool,
      registerView: (registration) => this.registerView(registration),
      activateView: (viewId) => this.activateView(viewId),
      closeView: (viewId) => this.closeView(viewId),
      detachView: (viewId) => this.detachView(viewId),
      getActivePluginId: () => this.activePluginId,
      setActivePluginId: (pluginId) => {
        this.activePluginId = pluginId;
      },
    });
    this.layoutController = new WebContentsViewLayoutController({
      windowManager: this.windowManager,
      pool: this.pool,
      getActivityBarWidth: () => this.activityBarWidth,
      getViewType: (viewId) => this.getViewType(viewId),
      attachView: (viewId, windowId, bounds) => this.attachView(viewId, windowId, bounds),
      detachView: (viewId) => this.detachView(viewId),
      updateBounds: (viewId, bounds) => this.updateBounds(viewId, bounds),
      scheduleViewportDebug: (viewId, reason) => this.scheduleViewportDebug(viewId, reason),
      setActivePluginId: (pluginId) => {
        this.activePluginId = pluginId;
      },
    });
    this.stateController = new WebContentsViewStateController({
      pool: this.pool,
      registry: this.registry,
      getMaxSize: () => this.maxSize,
      listRegisteredViews: () => this.listRegisteredViews(),
      activateView: (viewId) => this.activateView(viewId),
      closeView: (viewId) => this.closeView(viewId),
    });
    this.viewportDebugger = new WebContentsViewViewportDebugger({
      pool: this.pool,
      windowManager: this.windowManager,
      getViewType: (viewId) => this.getViewType(viewId),
      getActivityBarWidth: () => this.activityBarWidth,
    });
    this.attachmentController = new WebContentsViewAttachmentController({
      pool: this.pool,
      windowManager: this.windowManager,
      layoutController: this.layoutController,
      viewportDebugger: this.viewportDebugger,
      handleWindowResize: () => this.handleWindowResize(),
    });
    this.lifecycleController = new WebContentsViewLifecycleController({
      pool: this.pool,
      getMaxSize: () => this.maxSize,
      resolveViewPreloadPath: (metadata) => this.resolveViewPreloadPath(metadata),
      securityController: this.securityController,
      stealthController: this.stealthController,
      stateController: this.stateController,
      pluginPageController: this.pluginPageController,
      layoutController: this.layoutController,
      removePluginDockLayoutsByView: (viewId) => this.removePluginDockLayoutsByView(viewId),
      detachView: (viewId) => this.detachView(viewId),
      notifyViewCreated: (viewId, registration) => this.notifyViewCreated(viewId, registration),
      notifyViewClosed: (viewId) => this.notifyViewClosed(viewId),
      getViewClosedCallback: () => this.viewClosedCallback,
      clearViewportDebug: (viewId) => this.clearViewportDebug(viewId),
      getActivePluginId: () => this.activePluginId,
      setActivePluginId: (pluginId) => {
        this.activePluginId = pluginId;
      },
    });
  }

  setPluginManager(pluginManager: JSPluginManager): void {
    this.pluginPageController.setPluginManager(pluginManager);
  }

  setViewClosedCallback(callback: (viewId: string, metadata?: ViewMetadata) => void): void {
    this.viewClosedCallback = callback;
  }

  setActivityBarCollapsed(isCollapsed: boolean): void {
    const width = isCollapsed ? ACTIVITY_BAR_WIDTH : ACTIVITY_BAR_WIDTH_EXPANDED;
    this.setActivityBarWidth(width);
  }

  setActivityBarWidth(widthPx: number): void {
    const raw = Number(widthPx);
    if (!Number.isFinite(raw)) {
      return;
    }

    const mainWindow = this.windowManager.getMainWindowV3();
    const contentBounds = mainWindow?.getContentBounds();
    const maxWidth = contentBounds ? Math.max(contentBounds.width - MIN_VIEW_SIZE, 1) : undefined;

    const normalized = Math.max(1, Math.round(raw));
    const clamped = maxWidth !== undefined ? Math.min(normalized, maxWidth) : normalized;

    if (clamped === this.activityBarWidth) {
      return;
    }

    this.activityBarWidth = clamped;
    this.handleWindowResize(contentBounds);
  }

  getActivityBarWidth(): number {
    return this.activityBarWidth;
  }

  getViewBounds(viewId: string): ViewBounds | undefined {
    return this.pool.get(viewId)?.bounds;
  }

  registerView(registration: ViewRegistration): void {
    const existing = this.registry.get(registration.id);
    if (existing) {
      if (existing.metadata?.temporary || registration.metadata?.temporary) {
        logger.info('Updating temporary view registration', { viewId: registration.id });
        this.registry.set(registration.id, registration);
      } else {
        logger.warn('View already registered, skipping update', { viewId: registration.id });
      }
    } else {
      this.registry.set(registration.id, registration);
      logger.info('View registered', { viewId: registration.id, registrySize: this.registry.size });
    }
  }

  async activateView(viewId: string): Promise<WebContentsViewInfo> {
    const perfStart = Date.now();
    const cachedView = this.pool.get(viewId);
    if (cachedView) {
      cachedView.lastAccessedAt = Date.now();
      logger.info('View reused from pool', { viewId });
      this.ensurePluginPageViewLoaded(viewId, cachedView).catch((error) => {
        logger.error('Failed to ensure plugin page view loaded', { viewId, error });
      });
      return cachedView;
    }

    const registration = this.registry.get(viewId);
    if (!registration) {
      throw new Error(`View not registered: ${viewId}`);
    }

    const pendingActivation = this.viewActivationTasks.get(viewId);
    if (pendingActivation) {
      logger.info('View activation already in progress', { viewId });
      const viewInfo = await pendingActivation;
      viewInfo.lastAccessedAt = Date.now();
      return viewInfo;
    }

    logger.info('Activating new view', { viewId });
    const activationTask = this.lifecycleController.createViewFromRegistration(registration);
    this.viewActivationTasks.set(viewId, activationTask);

    try {
      const result = await activationTask;
      const duration = Date.now() - perfStart;
      logger.info('View activation completed', { viewId, durationMs: duration });
      this.ensurePluginPageViewLoaded(viewId, result).catch((error) => {
        logger.error('Failed to ensure plugin page view loaded', { viewId, error });
      });
      return result;
    } finally {
      if (this.viewActivationTasks.get(viewId) === activationTask) {
        this.viewActivationTasks.delete(viewId);
      }
    }
  }

  private async ensurePluginPageViewLoaded(
    viewId: string,
    viewInfo: WebContentsViewInfo
  ): Promise<void> {
    await this.pluginPageController.ensurePluginPageViewLoaded(viewId, viewInfo);
  }

  async loadPluginPageView(viewId: string, pluginId: string): Promise<void> {
    await this.pluginPageController.loadPluginPageView(viewId, pluginId);
  }

  async applyStealthToWebContents(
    viewId: string,
    webContents: WebContents,
    partition: string,
    metadata?: ViewMetadata
  ): Promise<void> {
    await this.stealthController.applyToWebContents(viewId, webContents, partition, metadata);
  }

  detachStealthFromWebContents(viewId: string, webContents: WebContents): void {
    this.stealthController.detachFromWebContents(viewId, webContents);
  }


  /**
   * 根据 pluginId 查找第一个可用的视图
   * @param pluginId 插件ID
   * @returns 视图ID，如果找不到则返回 null
   */
  findViewByPlugin(pluginId: string): string | null {
    // 1. 先在池中查找（优先使用已创建的视图）
    for (const [viewId, viewInfo] of this.pool.entries()) {
      if (viewInfo.metadata?.pluginId === pluginId) {
        return viewId;
      }
    }

    // 2. 在注册表中查找（返回第一个匹配的注册ID）
    for (const [viewId, registration] of this.registry.entries()) {
      if (registration.metadata?.pluginId === pluginId) {
        return viewId;
      }
    }

    return null;
  }
  attachView(viewId: string, windowId: string, bounds: ViewBounds): void {
    this.attachmentController.attachView(viewId, windowId, bounds);
  }

  detachView(viewId: string): void {
    this.attachmentController.detachView(viewId);
  }

  attachViewOffscreen(viewId: string, windowId: string = 'main'): boolean {
    return this.attachmentController.attachViewOffscreen(viewId, windowId);
  }

  detachAllViews(windowId?: string, options?: { preserveDockedRight?: boolean }): void {
    this.attachmentController.detachAllViews(windowId, options);
  }

  detachScopedViews(options?: DetachScopedViewsOptions): void {
    this.attachmentController.detachScopedViews(options);
  }

  switchView(viewId: string, windowId: string, bounds: ViewBounds): void {
    this.attachmentController.switchView(viewId, windowId, bounds);
  }

  updateBounds(viewId: string, bounds: ViewBounds): void {
    this.attachmentController.updateBounds(viewId, bounds);
  }

  private scheduleViewportDebug(viewId: string, reason: string): void {
    this.viewportDebugger.schedule(viewId, reason);
  }

  private clearViewportDebug(viewId: string): void {
    this.viewportDebugger.clear(viewId);
  }

  async navigateView(viewId: string, url: string): Promise<void> {
    await this.lifecycleController.navigateView(viewId, url);
  }

  async closeView(viewId: string): Promise<void> {
    await this.lifecycleController.closeView(viewId);
  }

  /**
   * 完全删除 View（从注册表和池中都移除）
   */
  async deleteView(viewId: string): Promise<void> {
    // 先关闭池中的 View（若未激活则跳过，避免重复 close 产生噪音日志）
    if (this.pool.has(viewId)) {
      await this.closeView(viewId);
    }

    // 再从注册表中移除
    this.registry.delete(viewId);

    logger.info('View deleted', { viewId, registrySize: this.registry.size });
  }

  /**
   * 获取 View 信息
   */
  getView(viewId: string): WebContentsViewInfo | undefined {
    const info = this.pool.get(viewId);
    if (info) {
      info.lastAccessedAt = Date.now();
    }
    return info;
  }

  /**
   * 列出所有已注册的 View（包括未激活的）
   */
  listRegisteredViews(): Array<{
    id: string;
    partition: string;
    metadata?: ViewMetadata;
    isActive: boolean;
  }> {
    return Array.from(this.registry.values()).map((reg) => ({
      id: reg.id,
      partition: reg.partition,
      metadata: reg.metadata,
      isActive: this.pool.has(reg.id),
    }));
  }

  /**
   * 列出池中的活跃 View
   */
  listActiveViews(): Array<{
    id: string;
    partition: string;
    attachedTo?: string;
    createdAt: number;
    lastAccessedAt: number;
    metadata?: ViewMetadata;
  }> {
    return Array.from(this.pool.values()).map((v) => ({
      id: v.id,
      partition: v.partition,
      attachedTo: v.attachedTo,
      createdAt: v.createdAt,
      lastAccessedAt: v.lastAccessedAt,
      metadata: v.metadata,
    }));
  }
  getPoolStatus(): {
    size: number;
    maxSize: number;
    isFull: boolean;
    views: string[];
  } {
    return this.stateController.getPoolStatus();
  }

  async closeMultipleViews(viewIds: string[]): Promise<{
    closed: string[];
    failed: Array<{ id: string; error: string }>;
  }> {
    return this.stateController.closeMultipleViews(viewIds);
  }

  async closeOldestViews(count: number): Promise<string[]> {
    return this.stateController.closeOldestViews(count);
  }

  getMemoryUsage(): {
    estimatedMB: number;
    perViewMB: number;
    activeViews: number;
    maxViews: number;
    utilizationPercent: number;
  } {
    return this.stateController.getMemoryUsage();
  }

  getDetailedPoolStatus(): {
    size: number;
    maxSize: number;
    available: number;
    isFull: boolean;
    utilizationPercent: number;
    views: Array<{
      id: string;
      partition: string;
      attachedTo?: string;
      createdAt: number;
      lastAccessedAt: number;
      ageSeconds: number;
    }>;
  } {
    return this.stateController.getDetailedPoolStatus();
  }

  async activatePluginViews(pluginId: string): Promise<void> {
    await this.stateController.activatePluginViews(pluginId);
  }

  reserveViews(viewIds: string[], datasetId: string): boolean {
    return this.stateController.reserveViews(viewIds, datasetId);
  }

  releaseViews(datasetId: string): void {
    this.stateController.releaseViews(datasetId);
  }

  getAvailableViews(pluginId: string): Array<{
    id: string;
    label: string;
    status: 'idle' | 'reserved' | 'busy' | 'error';
    reservedBy?: string;
    errorMessage?: string;
  }> {
    return this.stateController.getAvailableViews(pluginId);
  }

  markViewBusy(viewId: string): void {
    this.stateController.markViewBusy(viewId);
  }

  markViewIdle(viewId: string): void {
    this.stateController.markViewIdle(viewId);
  }

  markViewError(viewId: string, errorMessage: string): void {
    this.stateController.markViewError(viewId, errorMessage);
  }

  getViewStatus(viewId: string): {
    status: 'idle' | 'reserved' | 'busy' | 'error';
    reservedBy?: string;
    reservedAt?: number;
    errorMessage?: string;
  } | null {
    return this.stateController.getViewStatus(viewId);
  }

  /**
   * 清理所有 View
   */
  async cleanup(): Promise<void> {
    const viewIds = Array.from(this.pool.keys());
    for (const viewId of viewIds) {
      await this.closeView(viewId);
    }
    this.registry.clear();
    this.stateController.clearViewStates();
    this.activePluginId = null;
    this.layoutController.reset();
    this.pluginPageController.reset();
    logger.info('All WebContentsViews cleaned up');
  }
  getStats(): {
    registered: number;
    active: number;
    maxSize: number;
    poolUtilization: string;
  } {
    return this.stateController.getStats();
  }

  getActiveViewCount(): number {
    return this.stateController.getActiveViewCount();
  }

  getResourceStats(): {
    created: number;
    destroyed: number;
    failed: number;
    active: number;
    leakRisk: number;
  } {
    return this.stateController.getResourceStats();
  }

  async forceGarbageCollection(): Promise<void> {
    await this.stateController.forceGarbageCollection();
  }

  /**
   * 🆕 通知前端 View 已创建
   * 触发前端标签栏立即更新
   */
  private notifyViewCreated(viewId: string, registration: ViewRegistration): void {
    try {
      const mainWindow = this.windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        const viewData = {
          id: viewId,
          partition: registration.partition,
          metadata: registration.metadata,
        };
        mainWindow.webContents.send('plugin:view-created', viewData);
        logger.info('Notified frontend that plugin view was created', { viewId });
      }
    } catch (error) {
      logger.error('Failed to notify view created', { viewId, error });
    }
  }

  /**
   * 🆕 通知前端 View 已关闭
   * 触发前端标签栏立即更新
   */
  private notifyViewClosed(viewId: string): void {
    try {
      const mainWindow = this.windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('plugin:view-closed', { viewId });
        logger.info('Notified frontend that plugin view was closed', { viewId });
      }
    } catch (error) {
      logger.error('Failed to notify view closed', { viewId, error });
    }
  }
  // ========== Plugin Activity Bar view management ==========

  async createPluginPageView(
    pluginId: string,
    viewConfig: ActivityBarViewContribution
  ): Promise<string> {
    return this.pluginPageController.createPluginPageView(pluginId, viewConfig);
  }

  registerPluginPageView(pluginId: string, viewConfig: ActivityBarViewContribution): string {
    return this.pluginPageController.registerPluginPageView(pluginId, viewConfig);
  }

  getPluginViews(pluginId: string): {
    pageViewId: string | null;
    tempViewIds: string[];
  } {
    return this.pluginPageController.getPluginViews(pluginId);
  }

  /**
   * ✨ 获取视图类型
   * @param viewId 视图ID
   * @returns 视图类型：'page' | 'temp' | 'pool' | 'unknown'
   *
   * 类型说明：
   * - page: 插件主页面视图 (plugin-page:xxx)
   * - temp: 插件临时视图 (plugin-temp:xxx)
   * - pool: 浏览器池创建的视图 (pool:xxx) - MCP/插件/账户登录
   * - unknown: 未知类型
   */
  private getViewType(viewId: string): 'page' | 'temp' | 'pool' | 'unknown' {
    if (viewId.startsWith('plugin-page:')) return 'page';
    if (viewId.startsWith('plugin-temp:')) return 'temp';
    if (viewId.startsWith('pool:')) return 'pool';
    return 'unknown';
  }

  private removePluginDockLayoutsByView(viewId: string): string[] {
    return this.layoutController.removePluginDockLayoutsByView(viewId);
  }

  applyPluginDockLayout(pluginId: string): void {
    this.layoutController.applyPluginDockLayout(pluginId);
  }

  async cleanupPluginViews(pluginId: string): Promise<void> {
    await this.pluginPageController.cleanupPluginViews(pluginId);
  }
  setupWindowResizeListener(): (() => void) | null {
    return this.layoutController.setupWindowResizeListener();
  }

  private handleWindowResize(windowBounds?: Rectangle): void {
    this.layoutController.handleWindowResize(windowBounds);
  }

  calculatePluginBounds(pluginId: string): ViewBounds | null {
    return this.layoutController.calculatePluginBounds(pluginId);
  }

  getPluginLayoutInfo(windowBounds?: Rectangle): PluginLayoutInfo | null {
    return this.layoutController.getPluginLayoutInfo(windowBounds);
  }

  setRightDockedPoolView(
    viewId: string,
    size: number | string = DEFAULT_SPLIT_SIZE,
    pluginId?: string
  ): boolean {
    return this.layoutController.setRightDockedPoolView(viewId, size, pluginId);
  }

  clearRightDockedPoolView(viewId?: string): boolean {
    return this.layoutController.clearRightDockedPoolView(viewId);
  }

  getRightDockedPoolView(): RightDockedPoolViewState | null {
    return this.layoutController.getRightDockedPoolView();
  }

  setViewDisplayMode(viewId: string, displayMode: ViewDisplayMode): boolean {
    return this.layoutController.setViewDisplayMode(viewId, displayMode);
  }

  /**
   * 🆕 设置视图的来源标记
   *
   * 标记视图是由哪个模块创建的，便于调试和资源追踪。
   *
   * @param viewId 视图 ID
   * @param source 视图来源
   * @returns 是否成功设置
   */
  setViewSource(viewId: string, source: ViewSource): boolean {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      logger.warn('View not found while setting source', { viewId, source });
      return false;
    }

    // 更新元数据
    if (!viewInfo.metadata) {
      viewInfo.metadata = {};
    }
    viewInfo.metadata.source = source;

    logger.info('View source set', { viewId, source });
    return true;
  }

  /**
   * 🆕 获取视图的显示模式
   *
   * @param viewId 视图 ID
   * @returns 显示模式，如果视图不存在则返回 undefined
   */
  getViewDisplayMode(viewId: string): ViewDisplayMode | undefined {
    const viewInfo = this.pool.get(viewId);
    return viewInfo?.metadata?.displayMode;
  }

  /**
   * 🆕 获取所有指定显示模式的视图
   *
   * @param displayMode 显示模式
   * @returns 匹配的视图 ID 列表
   */
  getViewsByDisplayMode(displayMode: ViewDisplayMode): string[] {
    const result: string[] = [];
    this.pool.forEach((viewInfo, viewId) => {
      if (viewInfo.metadata?.displayMode === displayMode) {
        result.push(viewId);
      }
    });
    return result;
  }

  /**
   * 🆕 获取所有指定来源的视图
   *
   * @param source 视图来源
   * @returns 匹配的视图 ID 列表
   */
  getViewsBySource(source: ViewSource): string[] {
    const result: string[] = [];
    this.pool.forEach((viewInfo, viewId) => {
      if (viewInfo.metadata?.source === source) {
        result.push(viewId);
      }
    });
    return result;
  }

}
