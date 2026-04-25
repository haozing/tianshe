/**
 * Task Queue Type Definitions
 *
 * 并发任务队列的类型定义
 * 从 js-plugin/namespaces/task-queue-types.ts 提取
 */

/**
 * 任务进度信息
 */
export interface TaskProgress {
  /** 当前进度值 */
  current?: number;
  /** 总进度值 */
  total?: number;
  /** 进度百分比（0-100） */
  percent?: number;
  /** 进度描述 */
  message?: string;
  /** 自定义数据 */
  data?: any;
}

/**
 * 任务执行上下文
 *
 * @template TMeta - 任务元数据类型
 */
export interface TaskContext<TMeta = any> {
  /**
   * 取消信号（标准 AbortSignal）
   */
  signal: AbortSignal;

  /**
   * 任务唯一标识
   */
  taskId: string;

  /**
   * 任务元数据（创建时传入）
   */
  meta?: TMeta;

  /**
   * 更新任务进度（可选）
   */
  updateProgress?(data: TaskProgress): void;
}

/**
 * 任务队列配置
 */
export interface TaskQueueOptions {
  /**
   * 最大并发数（默认：3）
   */
  concurrency?: number;

  /**
   * 单个任务超时时间（毫秒，默认：120000 = 2分钟）
   */
  timeout?: number;

  /**
   * 失败自动重试次数（默认：0，不重试）
   */
  retry?: number;

  /**
   * 重试延迟时间（毫秒，默认：5000 = 5秒）
   */
  retryDelay?: number;

  /**
   * 速率限制（可选）
   */
  rateLimit?: {
    /** 时间间隔（毫秒） */
    interval: number;
    /** 每个间隔最多执行任务数 */
    intervalCap: number;
  };

  /**
   * 队列名称（可选，用于调试）
   */
  name?: string;
}

/**
 * 任务配置
 *
 * @template TMeta - 任务元数据类型
 */
export interface TaskOptions<TMeta = any> {
  /**
   * 任务唯一标识（可选，自动生成）
   */
  taskId?: string;

  /**
   * 任务名称（用于日志和监控）
   */
  name?: string;

  /**
   * 任务优先级（数字越大优先级越高，默认：0）
   */
  priority?: number;

  /**
   * 自定义超时时间（覆盖队列配置）
   */
  timeout?: number;

  /**
   * 自定义重试次数（覆盖队列配置）
   */
  retry?: number;

  /**
   * 任务元数据（传递给任务函数）
   */
  meta?: TMeta;

  /**
   * 外部取消信号（可选）
   */
  signal?: AbortSignal;
}

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 任务信息
 *
 * @template TMeta - 任务元数据类型
 */
export interface TaskInfo<TMeta = any> {
  /** 任务ID */
  taskId: string;

  /** 任务名称 */
  name?: string;

  /** 任务状态 */
  status: TaskStatus;

  /** 创建时间（时间戳） */
  createdAt: number;

  /** 开始时间（时间戳） */
  startedAt?: number;

  /** 结束时间（时间戳） */
  finishedAt?: number;

  /** 执行时长（毫秒） */
  duration?: number;

  /** 重试次数 */
  retryCount: number;

  /** 错误信息 */
  error?: Error;

  /** 任务进度 */
  progress?: TaskProgress;

  /** 任务元数据 */
  meta?: TMeta;
}

/**
 * 任务事件
 *
 * @template TMeta - 任务元数据类型
 */
export interface TaskEvent<TMeta = any> {
  /** 任务ID */
  taskId: string;

  /** 任务名称 */
  name?: string;

  /** 任务状态 */
  status: TaskStatus;

  /** 任务元数据 */
  meta?: TMeta;

  /** 错误信息（仅 failed 状态） */
  error?: Error;

  /** 任务进度（仅 progress 事件） */
  progress?: TaskProgress;

  /** 执行时长（毫秒，仅 completed/failed/cancelled 状态） */
  duration?: number;
}

/**
 * 队列统计信息
 */
export interface QueueStats {
  /** 总任务数 */
  total: number;

  /** 运行中的任务数 */
  running: number;

  /** 排队中的任务数 */
  pending: number;

  /** 已完成的任务数 */
  completed: number;

  /** 失败的任务数 */
  failed: number;

  /** 已取消的任务数 */
  cancelled: number;

  /** 队列是否暂停 */
  isPaused: boolean;
}

/**
 * 任务队列事件映射
 */
export interface TaskQueueEvents {
  'task:added': TaskEvent;
  'task:started': TaskEvent;
  'task:progress': TaskEvent;
  'task:completed': TaskEvent;
  'task:failed': TaskEvent;
  'task:cancelled': TaskEvent;
  'queue:idle': void;
  'queue:drained': void;
}

/**
 * 任务队列接口
 */
export interface ITaskQueue {
  /**
   * 添加单个任务
   */
  add<T, TMeta = any>(
    task: (ctx: TaskContext<TMeta>) => T | Promise<T>,
    options?: TaskOptions<TMeta>
  ): Promise<T>;

  /**
   * 批量添加任务
   */
  addAll<T, TMeta = any>(
    tasks: Array<{
      task: (ctx: TaskContext<TMeta>) => T | Promise<T>;
      options?: TaskOptions<TMeta>;
    }>
  ): Promise<T[]>;

  /**
   * 取消单个任务
   */
  cancelTask(taskId: string): Promise<boolean>;

  /**
   * 批量取消任务
   */
  cancelTasks(taskIds: string[]): Promise<number>;

  /**
   * 取消所有任务
   */
  cancelAll(): Promise<number>;

  /**
   * 查询任务信息
   */
  getTask(taskId: string): TaskInfo | null;

  /**
   * 获取所有任务信息
   */
  getAllTasks(filter?: { status?: TaskStatus | TaskStatus[]; name?: string }): TaskInfo[];

  /**
   * 暂停队列
   */
  pause(): void;

  /**
   * 恢复队列
   */
  resume(): void;

  /**
   * 清空待执行任务
   */
  clear(): void;

  /**
   * 停止队列并清理所有资源
   */
  stop(): Promise<void>;

  /**
   * 等待队列空闲
   */
  onIdle(): Promise<void>;

  /**
   * 获取队列统计信息
   */
  getStats(): QueueStats;

  /**
   * 监听事件
   */
  on(event: 'task:added', listener: (event: TaskEvent) => void): void;
  on(event: 'task:started', listener: (event: TaskEvent) => void): void;
  on(event: 'task:progress', listener: (event: TaskEvent) => void): void;
  on(event: 'task:completed', listener: (event: TaskEvent) => void): void;
  on(event: 'task:failed', listener: (event: TaskEvent) => void): void;
  on(event: 'task:cancelled', listener: (event: TaskEvent) => void): void;
  on(event: 'queue:idle', listener: () => void): void;
  on(event: 'queue:drained', listener: () => void): void;

  /**
   * 移除事件监听器
   */
  off(event: string, listener: (...args: any[]) => void): void;
}
