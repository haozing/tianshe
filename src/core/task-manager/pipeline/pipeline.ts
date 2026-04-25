/**
 * Pipeline Implementation
 *
 * 数据库驱动的状态流转系统
 * 核心功能：
 * - 多阶段流水线处理
 * - 数据库状态持久化
 * - 自动轮询和并发控制
 * - 重启可恢复
 */

import { v4 as uuidv4 } from 'uuid';
import { createTaskQueue, type TaskQueue } from '../queue';
import { createLogger } from '../../logger';
import type {
  PipelineOptions,
  PipelineStage,
  PipelineStats,
  PipelineStatus,
  StageContext,
  StageResult,
  StageStats,
  IPipeline,
  IPipelineHelpers,
} from './types';

const logger = createLogger('Pipeline');

// ========== 常量配置 ==========

/** 暂停状态检查间隔（毫秒） */
const PAUSE_CHECK_INTERVAL_MS = 500;

/** 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 3000;

/** 默认阶段超时（毫秒） */
const DEFAULT_STAGE_TIMEOUT_MS = 120000;

/** 默认重试延迟（毫秒） */
const DEFAULT_STAGE_RETRY_DELAY_MS = 5000;

/**
 * 阶段工作者 - 负责单个阶段的轮询和处理
 */
class StageWorker<TItem = any> {
  private running = false;
  private paused = false;
  private abortController: AbortController | null = null;
  private queue: TaskQueue | null = null;

  // 统计
  private stats: StageStats = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  constructor(
    private stage: PipelineStage<TItem>,
    private config: {
      tableId: string;
      statusField: string;
      errorField: string;
      helpers: IPipelineHelpers;
      onItemStart?: (item: TItem) => void;
      onItemComplete?: (item: TItem, result: StageResult) => void;
      onItemError?: (item: TItem, error: Error) => void;
      onIdle?: () => void;
    }
  ) {}

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.abortController = new AbortController();

    // 创建 TaskQueue
    this.queue = createTaskQueue({
      concurrency: this.stage.concurrency || 1,
      name: `${this.stage.name}-worker`,
      retry: this.stage.retry || 0,
      retryDelay: this.stage.retryDelay || DEFAULT_STAGE_RETRY_DELAY_MS,
      timeout: this.stage.timeout || DEFAULT_STAGE_TIMEOUT_MS,
    });

    logger.debug(
      `Stage "${this.stage.name}" started (concurrency: ${this.stage.concurrency || 1})`
    );

    // 轮询循环
    await this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();

    if (this.queue) {
      await this.queue.stop();
      this.queue = null;
    }

    logger.debug(`Stage "${this.stage.name}" stopped`);
  }

  pause(): void {
    this.paused = true;
    logger.debug(`Stage "${this.stage.name}" paused`);
  }

  resume(): void {
    this.paused = false;
    logger.debug(`Stage "${this.stage.name}" resumed`);
  }

  getStats(): StageStats {
    return { ...this.stats };
  }

  isRunning(): boolean {
    return this.running;
  }

  // ===== 私有方法 =====

  private async pollLoop(): Promise<void> {
    const { batchSize = 1, pollInterval = DEFAULT_POLL_INTERVAL_MS, interval = 0 } = this.stage;

    while (this.running) {
      // 检查暂停
      if (this.paused) {
        await this.sleep(PAUSE_CHECK_INTERVAL_MS);
        continue;
      }

      // 检查取消
      if (this.abortController?.signal.aborted) break;

      try {
        // 查询待处理数据
        const items = await this.queryItems(batchSize);

        if (items.length === 0) {
          this.config.onIdle?.();
          await this.sleep(pollInterval);
          continue;
        }

        // 处理这批数据
        await this.processBatch(items);

        // 处理间隔
        if (interval > 0) {
          await this.sleep(interval);
        }
      } catch (error) {
        logger.error(`Stage "${this.stage.name}" poll error:`, error);
        await this.sleep(pollInterval);
      }
    }
  }

  private async queryItems(limit: number): Promise<TItem[]> {
    const { fromStatus, filter, orderBy = '_row_id ASC' } = this.stage;
    const { tableId, statusField, helpers } = this.config;

    // 验证字段名（防止 SQL 注入）
    if (!this.isValidFieldName(statusField)) {
      logger.error(`Invalid status field name: ${statusField}`);
      return [];
    }

    // 验证 orderBy（只允许安全的排序表达式）
    if (!this.isValidOrderBy(orderBy)) {
      logger.error(`Invalid orderBy expression: ${orderBy}`);
      return [];
    }

    // 构建状态条件（使用安全的转义）
    const statusList = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
    const escapedStatuses = statusList.map((s) => this.escapeString(s));
    const statusCondition = escapedStatuses.map((s) => `"${statusField}" = '${s}'`).join(' OR ');

    // 构建 SQL
    let sql = `SELECT * FROM data WHERE (${statusCondition})`;

    // filter 参数：仅允许内部定义的安全过滤条件
    // 注意：filter 应该只包含字段名和安全的值，不应包含用户输入
    if (filter) {
      // 记录警告，提醒开发者注意 filter 的安全性
      logger.debug(`Using filter condition: ${filter}`);
      sql += ` AND (${filter})`;
    }

    sql += ` ORDER BY ${orderBy} LIMIT ${limit}`;

    try {
      return (await helpers.database.query(tableId, sql)) || [];
    } catch (error) {
      logger.error(`Stage "${this.stage.name}" query error:`, error);
      return [];
    }
  }

  /**
   * 验证字段名是否合法（防止 SQL 注入）
   * 只允许字母、数字、下划线和中文字符
   */
  private isValidFieldName(name: string): boolean {
    return /^[\w\u4e00-\u9fa5]+$/.test(name);
  }

  /**
   * 验证 ORDER BY 表达式是否安全
   * 只允许：字段名 + ASC/DESC
   */
  private isValidOrderBy(orderBy: string): boolean {
    // 匹配模式：字段名（可能带引号）+ 可选的 ASC/DESC
    const pattern = /^["']?[\w\u4e00-\u9fa5]+["']?\s*(ASC|DESC)?$/i;
    return pattern.test(orderBy.trim());
  }

  /**
   * 转义字符串中的特殊字符（防止 SQL 注入）
   */
  private escapeString(str: string): string {
    return str.replace(/'/g, "''");
  }

  private async processBatch(items: TItem[]): Promise<void> {
    if (!this.queue) return;

    const { handler, toStatus, errorStatus } = this.stage;

    const { tableId, statusField, errorField, helpers } = this.config;

    // 并发处理
    const tasks = items.map((item) => {
      const rowId = (item as any)._row_id;

      return this.queue!.add(
        async (taskCtx) => {
          this.config.onItemStart?.(item);

          const stageCtx: StageContext = {
            signal: taskCtx.signal,
            retryCount: 0,
            helpers,
            updateProgress: taskCtx.updateProgress,
          };

          // 执行 handler
          const result = await handler(item, stageCtx);

          // 更新数据库
          await this.applyResult(rowId, result, toStatus, errorStatus);

          // 更新统计
          this.stats.processed++;
          if (result.skip) {
            this.stats.skipped++;
          } else if (result.success) {
            this.stats.succeeded++;
          } else {
            this.stats.failed++;
          }

          this.config.onItemComplete?.(item, result);
          return result;
        },
        {
          taskId: `${this.stage.name}-${rowId}`,
        }
      ).catch((error) => {
        // 处理异常
        this.stats.processed++;
        this.stats.failed++;

        helpers.database
          .updateById(tableId, rowId, {
            [statusField]: errorStatus,
            [errorField]: error.message,
          })
          .catch((e: Error) => logger.error('Update error status failed:', e));

        this.config.onItemError?.(item, error);
      });
    });

    await Promise.allSettled(tasks);
  }

  private async applyResult(
    rowId: number,
    result: StageResult,
    toStatus: string,
    errorStatus: string
  ): Promise<void> {
    const { tableId, statusField, errorField, helpers } = this.config;

    try {
      if (result.skip) {
        // 跳过：只更新 updates（如果有）
        if (result.updates) {
          await helpers.database.updateById(tableId, rowId, result.updates);
        }
      } else if (result.success) {
        // 成功：更新状态 + updates
        await helpers.database.updateById(tableId, rowId, {
          [statusField]: toStatus,
          ...result.updates,
        });
      } else {
        // 失败：更新错误状态（使用可配置的错误字段名）
        await helpers.database.updateById(tableId, rowId, {
          [statusField]: errorStatus,
          [errorField]: result.error || '处理失败',
          ...result.updates,
        });
      }
    } catch (error) {
      logger.error(`Failed to apply result for row ${rowId}:`, error);
    }
  }

  /**
   * 可取消的睡眠
   *
   * 修复：确保 abort listener 在 resolve 后被移除，避免内存泄漏
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const signal = this.abortController?.signal;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        resolve();
      };

      const timer = setTimeout(cleanup, ms);

      const abortHandler = cleanup;
      signal?.addEventListener('abort', abortHandler);
    });
  }
}

/**
 * Pipeline 主类
 */
export class Pipeline<TItem = any> implements IPipeline {
  readonly id: string;
  readonly name: string;

  private _status: PipelineStatus = 'idle';
  private workers = new Map<string, StageWorker<TItem>>();
  private startedAt?: number;

  constructor(
    private options: PipelineOptions<TItem>,
    private helpers: IPipelineHelpers
  ) {
    this.id = uuidv4();
    this.name = options.name;
  }

  get status(): PipelineStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this._status === 'running') {
      logger.warn(`Pipeline "${this.name}" is already running`);
      return;
    }

    this._status = 'running';
    this.startedAt = Date.now();

    const { stages, statusField = '状态', errorField = '错误信息' } = this.options;

    // 创建 Workers
    for (const stage of stages) {
      const worker = new StageWorker<TItem>(stage, {
        tableId: this.options.tableId,
        statusField,
        errorField,
        helpers: this.helpers,
        onItemStart: (item) => this.options.onItemStart?.(stage.name, item),
        onItemComplete: (item, result) => this.options.onItemComplete?.(stage.name, item, result),
        onItemError: (item, error) => this.options.onItemError?.(stage.name, item, error),
        onIdle: () => this.options.onStageIdle?.(stage.name),
      });

      this.workers.set(stage.name, worker);
    }

    logger.info(`Pipeline "${this.name}" starting (${stages.length} stages)`);

    // 所有阶段并行运行
    Promise.all(Array.from(this.workers.values()).map((w) => w.start())).catch((error) => {
      logger.error(`Pipeline "${this.name}" worker error:`, error);
      this.options.onError?.(error);
    });
  }

  pause(): void {
    if (this._status !== 'running') return;
    this._status = 'paused';
    for (const worker of this.workers.values()) {
      worker.pause();
    }
    logger.info(`Pipeline "${this.name}" paused`);
  }

  resume(): void {
    if (this._status !== 'paused') return;
    this._status = 'running';
    for (const worker of this.workers.values()) {
      worker.resume();
    }
    logger.info(`Pipeline "${this.name}" resumed`);
  }

  async stop(): Promise<void> {
    if (this._status === 'stopped' || this._status === 'idle') return;

    this._status = 'stopping';

    // 停止所有 workers
    await Promise.all(Array.from(this.workers.values()).map((w) => w.stop()));

    this._status = 'stopped';
    this.workers.clear();

    logger.info(`Pipeline "${this.name}" stopped (duration: ${this.getDuration()}ms)`);
  }

  /**
   * 获取 Pipeline 统计信息
   *
   * 修复：使用 DB 聚合查询替代全表扫描，提升大数据量下的性能
   */
  async getStats(): Promise<PipelineStats> {
    const { tableId, statusField = '状态' } = this.options;

    // 使用聚合查询获取各状态数量（避免全表扫描）
    let statusCounts: Record<string, number> = {};
    try {
      const sql = `SELECT "${statusField}" as status, COUNT(*) as count FROM data GROUP BY "${statusField}"`;
      const rows = (await this.helpers.database.query(tableId, sql)) || [];
      for (const row of rows) {
        const status = row.status ?? 'unknown';
        statusCounts[status] = Number(row.count) || 0;
      }
    } catch (error) {
      logger.error('Failed to get status counts:', error);
    }

    // 收集阶段统计
    const stageStats: Record<string, StageStats> = {};
    for (const [name, worker] of this.workers) {
      stageStats[name] = worker.getStats();
    }

    return {
      status: this._status,
      statusCounts,
      stageStats,
      startedAt: this.startedAt,
      duration: this.getDuration(),
    };
  }

  pauseStage(stageName: string): void {
    const worker = this.workers.get(stageName);
    if (worker) {
      worker.pause();
    } else {
      logger.warn(`Stage "${stageName}" not found in pipeline "${this.name}"`);
    }
  }

  resumeStage(stageName: string): void {
    const worker = this.workers.get(stageName);
    if (worker) {
      worker.resume();
    } else {
      logger.warn(`Stage "${stageName}" not found in pipeline "${this.name}"`);
    }
  }

  private getDuration(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }
}

/**
 * 创建 Pipeline
 */
export function createPipeline<TItem = any>(
  options: PipelineOptions<TItem>,
  helpers: IPipelineHelpers
): Pipeline<TItem> {
  return new Pipeline(options, helpers);
}
