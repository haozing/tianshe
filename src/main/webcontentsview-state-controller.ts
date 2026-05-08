import type { ViewMetadata, WebContentsViewInfo } from './webcontentsview-manager';
import { createLogger } from '../core/logger';

const logger = createLogger('WebContentsViewStateController');

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type WebContentsViewExecutionStatus = 'idle' | 'reserved' | 'busy' | 'error';

export interface WebContentsViewStateControllerDeps {
  pool: Map<string, WebContentsViewInfo>;
  registry: Map<string, unknown>;
  getMaxSize(): number;
  listRegisteredViews(): Array<{
    id: string;
    partition: string;
    metadata?: ViewMetadata;
    isActive: boolean;
  }>;
  activateView(viewId: string): Promise<WebContentsViewInfo>;
  closeView(viewId: string): Promise<void>;
}

export class WebContentsViewStateController {
  private stats = {
    created: 0,
    destroyed: 0,
    failed: 0,
  };

  private viewStates = new Map<
    string,
    {
      status: WebContentsViewExecutionStatus;
      reservedBy?: string;
      reservedAt?: number;
      errorMessage?: string;
    }
  >();

  constructor(private deps: WebContentsViewStateControllerDeps) {}

  markCreated(): number {
    this.stats.created++;
    return this.stats.created;
  }

  markDestroyed(): number {
    this.stats.destroyed++;
    return this.stats.destroyed;
  }

  markFailed(): number {
    this.stats.failed++;
    return this.stats.failed;
  }

  deleteViewState(viewId: string): void {
    this.viewStates.delete(viewId);
  }

  clearViewStates(): void {
    this.viewStates.clear();
  }

  /**
   * 获取池状态
   */
  getPoolStatus(): {
    size: number;
    maxSize: number;
    isFull: boolean;
    views: string[];
  } {
    return {
      size: this.deps.pool.size,
      maxSize: this.deps.getMaxSize(),
      isFull: this.deps.pool.size >= this.deps.getMaxSize(),
      views: Array.from(this.deps.pool.keys()),
    };
  }

  /**
   * 🆕 批量关闭多个 View
   */
  async closeMultipleViews(viewIds: string[]): Promise<{
    closed: string[];
    failed: Array<{ id: string; error: string }>;
  }> {
    const closed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of viewIds) {
      try {
        await this.deps.closeView(id);
        closed.push(id);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        failed.push({ id, error: message });
        logger.error('Failed to close view during batch close', { viewId: id, error });
      }
    }

    logger.info('Batch close completed', {
      closedCount: closed.length,
      failedCount: failed.length,
    });
    return { closed, failed };
  }

  /**
   * 🆕 关闭最旧的 N 个 View（基于 lastAccessedAt）
   */
  async closeOldestViews(count: number): Promise<string[]> {
    if (count <= 0) {
      return [];
    }

    // 按 lastAccessedAt 排序，最旧的在前
    const sorted = Array.from(this.deps.pool.values()).sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt
    );

    const toClose = sorted.slice(0, Math.min(count, sorted.length));
    const closed: string[] = [];

    for (const viewInfo of toClose) {
      try {
        await this.deps.closeView(viewInfo.id);
        closed.push(viewInfo.id);
      } catch (error) {
        logger.error('Failed to close oldest view', { viewId: viewInfo.id, error });
      }
    }

    logger.info('Closed oldest views', { closedCount: closed.length, viewIds: closed });
    return closed;
  }

  /**
   * 🆕 获取内存使用估算
   */
  getMemoryUsage(): {
    estimatedMB: number;
    perViewMB: number;
    activeViews: number;
    maxViews: number;
    utilizationPercent: number;
  } {
    const perViewMB = 50; // 估算每个 View 约占用 50MB
    const estimatedMB = this.deps.pool.size * perViewMB;
    const utilizationPercent = Math.round((this.deps.pool.size / this.deps.getMaxSize()) * 100);

    return {
      estimatedMB,
      perViewMB,
      activeViews: this.deps.pool.size,
      maxViews: this.deps.getMaxSize(),
      utilizationPercent,
    };
  }

  /**
   * 🆕 获取池的详细状态（增强版）
   */
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
    const now = Date.now();
    const views = Array.from(this.deps.pool.values()).map((v) => ({
      id: v.id,
      partition: v.partition,
      attachedTo: v.attachedTo,
      createdAt: v.createdAt,
      lastAccessedAt: v.lastAccessedAt,
      ageSeconds: Math.round((now - v.createdAt) / 1000),
    }));

    return {
      size: this.deps.pool.size,
      maxSize: this.deps.getMaxSize(),
      available: this.deps.getMaxSize() - this.deps.pool.size,
      isFull: this.deps.pool.size >= this.deps.getMaxSize(),
      utilizationPercent: Math.round((this.deps.pool.size / this.deps.getMaxSize()) * 100),
      views,
    };
  }

  /**
   * 🆕 激活插件的所有视图（用于插件安装后启动永久浏览器）
   * @param pluginId 插件ID
   */
  async activatePluginViews(pluginId: string): Promise<void> {
    logger.info('Activating all views for plugin', { pluginId });

    const views = this.deps.listRegisteredViews().filter((v) => v.metadata?.pluginId === pluginId);

    if (views.length === 0) {
      logger.warn('No views found for plugin', { pluginId });
      return;
    }

    logger.info('Found plugin views to activate', { pluginId, viewCount: views.length });

    for (const view of views) {
      try {
        await this.deps.activateView(view.id);
        // 初始化视图状态为 idle
        this.viewStates.set(view.id, { status: 'idle' });
        logger.info('Plugin view activated and marked idle', { pluginId, viewId: view.id });
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.error('Failed to activate plugin view', {
          pluginId,
          viewId: view.id,
          message,
          error,
        });
        // 标记为错误状态
        this.viewStates.set(view.id, {
          status: 'error',
          errorMessage: message,
        });
      }
    }

    logger.info('Plugin views activation completed', { pluginId });
  }

  /**
   * 🆕 保留视图（锁定视图给特定数据集使用）
   * @param viewIds 要保留的视图ID列表
   * @param datasetId 数据集ID
   * @returns 是否成功保留所有视图
   */
  reserveViews(viewIds: string[], datasetId: string): boolean {
    logger.info('Attempting to reserve views for dataset', {
      datasetId,
      viewCount: viewIds.length,
    });

    // 第一步：检查所有视图是否可用
    for (const viewId of viewIds) {
      const state = this.viewStates.get(viewId);

      if (!state) {
        logger.warn('View has no state while reserving', { datasetId, viewId });
        return false;
      }

      if (state.status !== 'idle') {
        logger.warn('View is not idle while reserving', {
          datasetId,
          viewId,
          status: state.status,
          reservedBy: state.reservedBy,
        });
        return false;
      }
    }

    // 第二步：保留所有视图
    const now = Date.now();
    for (const viewId of viewIds) {
      this.viewStates.set(viewId, {
        status: 'reserved',
        reservedBy: datasetId,
        reservedAt: now,
      });
      logger.info('View reserved for dataset', { datasetId, viewId });
    }

    logger.info('Successfully reserved views for dataset', {
      datasetId,
      viewCount: viewIds.length,
    });
    return true;
  }

  /**
   * 🆕 释放视图（解除锁定）
   * @param datasetId 数据集ID
   */
  releaseViews(datasetId: string): void {
    logger.info('Releasing views for dataset', { datasetId });

    let releasedCount = 0;
    for (const [viewId, state] of this.viewStates) {
      if (state.reservedBy === datasetId) {
        this.viewStates.set(viewId, { status: 'idle' });
        logger.info('View released for dataset', { datasetId, viewId });
        releasedCount++;
      }
    }

    logger.info('Released views for dataset', { datasetId, releasedCount });
  }

  /**
   * 🆕 获取插件的可用视图列表（用于UI选择）
   * @param pluginId 插件ID
   * @returns 视图列表及其状态
   */
  getAvailableViews(pluginId: string): Array<{
    id: string;
    label: string;
    status: 'idle' | 'reserved' | 'busy' | 'error';
    reservedBy?: string;
    errorMessage?: string;
  }> {
    const views = this.deps.listRegisteredViews().filter((v) => v.metadata?.pluginId === pluginId);

    return views.map((v) => {
      const state = this.viewStates.get(v.id) || { status: 'idle' };
      return {
        id: v.id,
        label: v.metadata?.label || v.id,
        status: state.status,
        reservedBy: state.reservedBy,
        errorMessage: state.errorMessage,
      };
    });
  }

  /**
   * 🆕 标记视图为忙碌状态
   * @param viewId 视图ID
   */
  markViewBusy(viewId: string): void {
    const state = this.viewStates.get(viewId);
    if (!state) {
      logger.warn('Cannot mark view busy because it has no state', { viewId });
      return;
    }

    this.viewStates.set(viewId, {
      ...state,
      status: 'busy',
    });
    logger.info('View marked as busy', { viewId });
  }

  /**
   * 🆕 标记视图为空闲状态
   * @param viewId 视图ID
   */
  markViewIdle(viewId: string): void {
    const state = this.viewStates.get(viewId);
    if (!state) {
      logger.warn('Cannot mark view idle because it has no state', { viewId });
      return;
    }

    // 保持 reservedBy，只改变状态
    this.viewStates.set(viewId, {
      ...state,
      status: state.reservedBy ? 'reserved' : 'idle',
      errorMessage: undefined, // 清除错误信息
    });
    logger.info('View marked as idle or reserved', {
      viewId,
      status: state.reservedBy ? 'reserved' : 'idle',
    });
  }

  /**
   * 🆕 标记视图为错误状态
   * @param viewId 视图ID
   * @param errorMessage 错误信息
   */
  markViewError(viewId: string, errorMessage: string): void {
    const state = this.viewStates.get(viewId);
    if (!state) {
      logger.warn('Cannot mark view error because it has no state', { viewId, errorMessage });
      return;
    }

    this.viewStates.set(viewId, {
      ...state,
      status: 'error',
      errorMessage,
    });
    logger.error('View marked as error', { viewId, errorMessage });
  }

  /**
   * 🆕 获取视图状态
   * @param viewId 视图ID
   * @returns 视图状态，如果不存在则返回 null
   */
  getViewStatus(viewId: string): {
    status: 'idle' | 'reserved' | 'busy' | 'error';
    reservedBy?: string;
    reservedAt?: number;
    errorMessage?: string;
  } | null {
    return this.viewStates.get(viewId) || null;
  }


  /**
   * 获取统计信息
   */
  getStats(): {
    registered: number;
    active: number;
    maxSize: number;
    poolUtilization: string;
  } {
    return {
      registered: this.deps.registry.size,
      active: this.deps.pool.size,
      maxSize: this.deps.getMaxSize(),
      poolUtilization: `${this.deps.pool.size}/${this.deps.getMaxSize()} (${Math.round((this.deps.pool.size / this.deps.getMaxSize()) * 100)}%)`,
    };
  }

  /**
   * 获取当前活跃的 View 数量
   */
  getActiveViewCount(): number {
    return this.deps.pool.size;
  }

  /**
   * 🆕 获取资源统计（包含泄漏风险检测）
   */
  getResourceStats(): {
    created: number;
    destroyed: number;
    failed: number;
    active: number;
    leakRisk: number; // 创建 - 销毁 - 活跃 = 可能泄漏的数量
  } {
    const leakRisk = this.stats.created - this.stats.destroyed - this.deps.pool.size;
    return {
      ...this.stats,
      active: this.deps.pool.size,
      leakRisk: Math.max(0, leakRisk),
    };
  }

  /**
   * 🆕 强制垃圾回收（仅用于调试和性能优化）
   * 注意：需要启动时使用 --expose-gc 标志
   */
  async forceGarbageCollection(): Promise<void> {
    if (global.gc) {
      logger.info('Forcing garbage collection');
      global.gc();
      logger.info('Garbage collection completed');
    } else {
      logger.warn('Garbage collection not available');
    }
  }

}
