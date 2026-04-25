/**
 * 定时任务调度器类型定义
 * 统一供主进程、渲染进程、插件命名空间使用
 */

/**
 * 调度类型
 */
export type ScheduleType = 'cron' | 'interval' | 'once';

/**
 * 任务状态
 */
export type TaskStatus = 'active' | 'paused' | 'disabled';

/**
 * 执行状态
 */
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 错过执行策略
 */
export type MissedPolicy = 'skip' | 'run_once';

/**
 * 触发类型
 */
export type TriggerType = 'scheduled' | 'manual' | 'recovery';

/**
 * 最后一次运行状态
 * - success: 成功完成
 * - failed: 执行失败（错误/异常）
 * - cancelled: 被取消（用户主动取消、暂停、或超时）
 */
export type LastRunStatus = 'success' | 'failed' | 'cancelled';

/**
 * 定时任务
 */
export interface ScheduledTask {
  id: string;
  pluginId: string;
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  cronExpression?: string;
  intervalMs?: number;
  runAt?: number;
  handlerId: string;
  payload?: Record<string, unknown>;
  status: TaskStatus;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  missedPolicy: MissedPolicy;
  resourceKeys?: string[];
  resourceWaitTimeoutMs?: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunStatus?: LastRunStatus;
  runCount: number;
  failCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 任务执行记录
 */
export interface TaskExecution {
  id: string;
  taskId: string;
  triggerType: TriggerType;
  status: ExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
}

/**
 * 创建任务参数
 */
export interface CreateScheduledTaskParams {
  id?: string;
  pluginId: string;
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  cronExpression?: string;
  intervalMs?: number;
  runAt?: number;
  handlerId: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  missedPolicy?: MissedPolicy;
  resourceKeys?: string[];
  resourceWaitTimeoutMs?: number;
  nextRunAt?: number;
}

/**
 * 任务统计信息
 */
export interface TaskStats {
  total: number;
  active: number;
  paused: number;
  disabled: number;
  todayExecutions: number;
  todayFailed: number;
}

/**
 * 任务信息（插件 API 返回格式）
 */
export interface TaskInfo {
  id: string;
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  scheduleDescription: string;
  status: TaskStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunStatus?: LastRunStatus;
  runCount: number;
  failCount: number;
  createdAt: number;
}

/**
 * 格式化工具函数类型
 */
export interface SchedulerFormatUtils {
  /**
   * 格式化间隔时间为人类可读字符串
   */
  formatInterval: (ms: number) => string;

  /**
   * 格式化持续时间（简短格式）
   */
  formatDuration: (ms: number) => string;

  /**
   * 获取调度描述
   */
  getScheduleDescription: (task: ScheduledTask) => string;
}
