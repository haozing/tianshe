/**
 * Pipeline Types
 *
 * 数据库驱动的状态流转系统类型定义
 */

/**
 * Pipeline 数据库操作接口
 * 定义 Pipeline 所需的最小数据库操作集
 */
export interface IPipelineDatabase {
  /**
   * 查询数据
   * @param tableId 表 ID
   * @param sql SQL 查询语句
   */
  query(tableId: string, sql: string): Promise<any[]>;

  /**
   * 按行 ID 更新数据
   * @param tableId 表 ID
   * @param rowId 行 ID
   * @param updates 要更新的字段
   */
  updateById(tableId: string, rowId: number | string, updates: Record<string, any>): Promise<void>;
}

/**
 * Pipeline Helpers 接口
 * 定义 Pipeline 运行所需的外部依赖
 */
export interface IPipelineHelpers {
  /** 数据库操作 */
  database: IPipelineDatabase;
}

/**
 * 阶段处理上下文
 */
export interface StageContext<THelpers = IPipelineHelpers> {
  /** 取消信号 */
  signal: AbortSignal;
  /** 当前重试次数（从 0 开始） */
  retryCount: number;
  /** 更新进度回调 */
  updateProgress?: (progress: { message?: string; percent?: number }) => void;
  /** helpers 引用 */
  helpers: THelpers;
}

/**
 * 阶段处理结果
 */
export interface StageResult<T = Record<string, any>> {
  /** 是否成功 */
  success: boolean;
  /** 成功时：要更新的字段（合并到数据行） */
  updates?: Partial<T>;
  /** 失败时：错误信息 */
  error?: string;
  /** 是否跳过此项（不算失败，不改状态） */
  skip?: boolean;
  /** 跳过原因 */
  skipReason?: string;
}

/**
 * 阶段定义
 */
export interface PipelineStage<TItem = any> {
  /** 阶段名称 */
  name: string;

  /** 输入状态 */
  fromStatus: string | string[];

  /** 成功后状态 */
  toStatus: string;

  /** 失败后状态 */
  errorStatus: string;

  /** 处理函数 */
  handler: (item: TItem, ctx: StageContext) => Promise<StageResult<TItem>>;

  // ===== 并发与批处理 =====

  /** 并发数，默认 1 */
  concurrency?: number;

  /** 每批查询数量，默认 1 */
  batchSize?: number;

  // ===== 时间控制 =====

  /** 处理间隔（毫秒），每个 item 处理完后等待，默认 0 */
  interval?: number;

  /** 轮询间隔（毫秒），无数据时等待，默认 3000 */
  pollInterval?: number;

  /** 超时时间（毫秒），默认 120000 */
  timeout?: number;

  // ===== 重试 =====

  /** 重试次数，默认 0 */
  retry?: number;

  /** 重试延迟（毫秒），默认 5000 */
  retryDelay?: number;

  // ===== 查询控制 =====

  /** 额外的 SQL WHERE 条件 */
  filter?: string;

  /** 排序方式，默认 '_row_id ASC' */
  orderBy?: string;
}

/**
 * Pipeline 配置
 */
export interface PipelineOptions<TItem = any> {
  /** 名称 */
  name: string;

  /** 数据表 ID */
  tableId: string;

  /** 状态字段名，默认 '状态' */
  statusField?: string;

  /** 错误信息字段名，默认 '错误信息' */
  errorField?: string;

  /** 阶段定义列表 */
  stages: PipelineStage<TItem>[];

  /**
   * 阶段执行模式
   * - 'parallel': 所有阶段并行运行（默认，生产者-消费者模式）
   *
   * 注：sequential 模式已移除，因为每个阶段的 pollLoop 是无限循环，
   * await 会阻塞后续阶段启动。如需串行处理，建议使用单阶段配合多个 fromStatus。
   */
  mode?: 'parallel';

  // ===== 事件回调 =====

  /** 开始处理 item */
  onItemStart?: (stageName: string, item: TItem) => void;

  /** 完成处理 item */
  onItemComplete?: (stageName: string, item: TItem, result: StageResult) => void;

  /** 处理 item 出错 */
  onItemError?: (stageName: string, item: TItem, error: Error) => void;

  /** 阶段空闲（无数据） */
  onStageIdle?: (stageName: string) => void;

  /** Pipeline 出错 */
  onError?: (error: Error) => void;
}

/**
 * Pipeline 运行状态
 */
export type PipelineStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped';

/**
 * 阶段统计
 */
export interface StageStats {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Pipeline 统计
 */
export interface PipelineStats {
  /** 运行状态 */
  status: PipelineStatus;
  /** 各状态数量 */
  statusCounts: Record<string, number>;
  /** 各阶段统计 */
  stageStats: Record<string, StageStats>;
  /** 开始时间 */
  startedAt?: number;
  /** 运行时长（毫秒） */
  duration?: number;
}

/**
 * Pipeline 接口
 */
export interface IPipeline {
  /** ID */
  readonly id: string;
  /** 名称 */
  readonly name: string;
  /** 状态 */
  readonly status: PipelineStatus;

  /** 启动 */
  start(): Promise<void>;
  /** 暂停 */
  pause(): void;
  /** 恢复 */
  resume(): void;
  /** 停止 */
  stop(): Promise<void>;

  /** 获取统计 */
  getStats(): Promise<PipelineStats>;

  /** 暂停指定阶段 */
  pauseStage(stageName: string): void;
  /** 恢复指定阶段 */
  resumeStage(stageName: string): void;
}
