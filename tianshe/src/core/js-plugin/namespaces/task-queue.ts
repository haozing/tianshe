/**
 * 任务队列命名空间
 *
 * 基于 core/task-manager 的插件层封装
 * 提供并发任务调度能力
 *
 * 设计原则：
 * - 单一职责：只负责任务调度，不管理资源
 * - 标准化：使用 AbortController/AbortSignal
 * - 简洁 API：降低学习成本
 */

import { TaskQueue, createTaskQueue } from '../../task-manager';
import type { TaskQueueOptions } from '../../task-manager';
import { createLogger } from '../../logger';
import type { PluginRuntimeRegistry } from '../runtime-registry';

const logger = createLogger('TaskQueueNamespace');

// Re-export types for plugin developers
export type {
  TaskQueueOptions,
  TaskOptions,
  TaskContext,
  TaskInfo,
  TaskEvent,
  TaskStatus,
  TaskProgress,
  QueueStats,
  ITaskQueue,
} from '../../task-manager';

// Re-export TaskQueue as the interface type
export type { TaskQueue };

/**
 * TaskQueue 命名空间
 *
 * 提供并发任务调度能力
 *
 * @example
 * // 场景1：多账号并行操作（带取消）
 * const queue = await helpers.taskQueue.create({
 *   concurrency: 3,
 *   timeout: 120000,
 *   retry: 2
 * });
 *
 * for (const store of stores) {
 *   queue.add(async (ctx) => {
 *     // 创建浏览器句柄
 *     const handle = await helpers.profile.launch(store.profileId, {
 *       visible: true
 *     });
 *     const browser = handle.browser;
 *
 *     try {
 *       // 执行发布
 *       for (let i = 0; i < 10; i++) {
 *         // 检查取消信号
 *         if (ctx.signal.aborted) {
 *           throw new Error('Task cancelled');
 *         }
 *
 *         await publishProduct(browser, i);
 *
 *         // 更新进度
 *         ctx.updateProgress?.({ current: i + 1, total: 10 });
 *       }
 *     } finally {
 *       // 释放回池
 *       await handle.release();
 *     }
 *   }, {
 *     taskId: store.profileId,
 *     name: store.storeName,
 *     meta: { storeName: store.storeName }
 *   });
 * }
 *
 * // 监听进度
 * queue.on('task:progress', (event) => {
 *   console.log(`${event.name}: ${event.progress.message}`);
 * });
 *
 * // 取消单个任务
 * await queue.cancelTask(store.profileId);
 *
 * @example
 * // 场景2：批量网络请求
 * const queue = await helpers.taskQueue.create({
 *   concurrency: 10,
 *   rateLimit: { interval: 1000, intervalCap: 5 }
 * });
 *
 * const results = await queue.addAll(
 *   urls.map(url => ({
 *     task: async (ctx) => await helpers.network.get(url),
 *     options: { name: url }
 *   }))
 * );
 */
export class TaskQueueNamespace {
  private activeQueues: TaskQueue[] = [];
  private maxQueuesPerPlugin = 10; // 每个插件最多 10 个队列
  private queueIds = new Map<TaskQueue, string>();
  private queueIdCounter = 0;

  constructor(
    private pluginId: string,
    private runtimeRegistry?: PluginRuntimeRegistry
  ) {}

  /**
   * 创建任务队列
   *
   * @param options - 队列配置
   * @returns 任务队列实例
   *
   * @throws 如果队列数量超过限制
   *
   * @example
   * const queue = await helpers.taskQueue.create({
   *   concurrency: 3,
   *   timeout: 120000,
   *   retry: 2,
   *   name: '批量发布任务'
   * });
   *
   * // 使用完毕后显式释放
   * await queue.stop();
   * // 或 helpers.taskQueue.release(queue);
   */
  async create(options?: TaskQueueOptions): Promise<TaskQueue> {
    // 检查队列数量限制
    if (this.activeQueues.length >= this.maxQueuesPerPlugin) {
      throw new Error(
        `[TaskQueue] 插件 ${this.pluginId} 已达到最大队列数量限制 (${this.maxQueuesPerPlugin})`
      );
    }

    // 使用 core/task-manager 的 TaskQueue
    const queue = createTaskQueue(options);
    this.activeQueues.push(queue);
    const queueId = `${this.pluginId}:queue:${Date.now()}:${this.queueIdCounter++}`;
    this.queueIds.set(queue, queueId);
    this.runtimeRegistry?.registerQueue(this.pluginId, queueId, queue);

    logger.debug(
      `创建队列: ${options?.name || 'TaskQueue'} (插件: ${this.pluginId}, 并发数: ${options?.concurrency ?? 3})`
    );

    // 不再自动在 idle 时移除队列
    // 原因：如果插件把 queue 当成长期 dispatcher（idle 后再 add），
    // 自动移除会导致队列不受 stopAll 管控，maxQueuesPerPlugin 限制也会被绕过
    // 现在改为：只在 stop() 或显式 release() 时移除

    return queue;
  }

  /**
   * 显式释放队列
   *
   * 使用此方法释放不再需要的队列，以释放资源并允许创建新队列
   *
   * @param queue - 要释放的队列
   */
  async release(queue: TaskQueue): Promise<void> {
    const index = this.activeQueues.indexOf(queue);
    if (index > -1) {
      await queue.stop();
      this.activeQueues.splice(index, 1);
      const queueId = this.queueIds.get(queue);
      if (queueId) {
        this.runtimeRegistry?.unregisterQueue(this.pluginId, queueId);
        this.queueIds.delete(queue);
      }
      logger.debug(`队列已释放 (插件: ${this.pluginId})`);
    }
  }

  /**
   * 获取所有活跃队列
   *
   * @returns 活跃队列列表
   */
  getActiveQueues(): TaskQueue[] {
    return [...this.activeQueues];
  }

  /**
   * 取消当前插件命名空间下的所有任务
   *
   * 注意：
   * - 只取消任务，不销毁队列实例
   * - 适合作为“停止当前插件任务”的统一入口
   */
  async cancelAll(): Promise<number> {
    const counts = await Promise.all(this.activeQueues.map((queue) => queue.cancelAll()));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /**
   * 停止所有队列
   *
   * 在插件停止时自动调用
   */
  async stopAll(): Promise<void> {
    logger.info(`停止插件 ${this.pluginId} 的所有队列 (${this.activeQueues.length} 个)`);

    const queues = [...this.activeQueues];
    await Promise.all(queues.map((q) => q.stop()));
    queues.forEach((queue) => {
      const queueId = this.queueIds.get(queue);
      if (queueId) {
        this.runtimeRegistry?.unregisterQueue(this.pluginId, queueId);
        this.queueIds.delete(queue);
      }
    });
    this.activeQueues = [];
  }
}
