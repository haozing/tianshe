/**
 * Task Manager Module
 *
 * 独立的任务管理模块，提供并发任务队列和定时调度能力
 * 从 js-plugin/namespaces 提取，遵循高内聚低耦合原则
 *
 * 使用方式：
 * 1. 直接使用：import { TaskQueue, Scheduler } from '@core/task-manager'
 * 2. 通过 js-plugin：helpers.taskQueue.* 和 helpers.scheduler.*
 */

// === 任务队列 ===
export { TaskQueue, createTaskQueue } from './queue';
export type {
  TaskQueueOptions,
  TaskOptions,
  TaskContext,
  TaskInfo,
  TaskEvent,
  TaskStatus,
  TaskProgress,
  QueueStats,
  TaskQueueEvents,
  ITaskQueue,
} from './types';

// === 定时调度器 ===
export { Scheduler, setSchedulerService, getSchedulerService } from './scheduler';
export type {
  SchedulerConfig,
  ScheduleOptions,
  ScheduledTaskInfo,
  ExecutionInfo,
  ScheduleType,
  SchedulerTaskContext,
  MissedPolicy,
} from './scheduler';

// === 错误类型 ===
export {
  TaskManagerError,
  SchedulerError,
  TaskCancelledError,
  isTaskCancelledError,
} from './errors';

// === Pipeline ===
export { Pipeline, createPipeline } from './pipeline';
export type {
  PipelineOptions,
  PipelineStage,
  PipelineStats,
  PipelineStatus,
  StageContext,
  StageResult,
  StageStats,
  IPipeline,
  IPipelineHelpers,
  IPipelineDatabase,
} from './pipeline';
