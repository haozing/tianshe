import { TypedEventEmitter } from '../typed-event-emitter';
import type {
  JSPluginLifecyclePhase,
  JSPluginRuntimeStatus,
  JSPluginRuntimeStatusChangeEvent,
  JSPluginWorkState,
} from '../../types/js-plugin';
import type { ITaskQueue, TaskEvent, TaskInfo, TaskProgress } from '../task-manager/types';

interface RuntimeRegistryEvents {
  'status-changed': JSPluginRuntimeStatusChangeEvent;
}

interface QueueBinding {
  queueId: string;
  queue: ITaskQueue;
  listeners: Array<{
    event:
      | 'task:added'
      | 'task:started'
      | 'task:progress'
      | 'task:completed'
      | 'task:failed'
      | 'task:cancelled'
      | 'queue:idle';
    listener: ((event: TaskEvent) => void) | (() => void);
  }>;
}

type QueueTaskEventName = Exclude<QueueBinding['listeners'][number]['event'], 'queue:idle'>;

const DEFAULT_LIFECYCLE_PHASE: JSPluginLifecyclePhase = 'inactive';
const DEFAULT_WORK_STATE: JSPluginWorkState = 'idle';

function shallowEqualStatus(left: JSPluginRuntimeStatus, right: JSPluginRuntimeStatus): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.pluginName === right.pluginName &&
    left.lifecyclePhase === right.lifecyclePhase &&
    left.workState === right.workState &&
    left.activeQueues === right.activeQueues &&
    left.runningTasks === right.runningTasks &&
    left.pendingTasks === right.pendingTasks &&
    left.failedTasks === right.failedTasks &&
    left.cancelledTasks === right.cancelledTasks &&
    left.currentSummary === right.currentSummary &&
    left.currentOperation === right.currentOperation &&
    left.progressPercent === right.progressPercent &&
    left.lastActivityAt === right.lastActivityAt &&
    left.updatedAt === right.updatedAt &&
    left.lastError?.message === right.lastError?.message &&
    left.lastError?.at === right.lastError?.at
  );
}

function normalizeProgressPercent(progress?: TaskProgress): number | undefined {
  if (!progress) return undefined;

  if (typeof progress.percent === 'number' && Number.isFinite(progress.percent)) {
    return Math.max(0, Math.min(100, Math.round(progress.percent)));
  }

  if (
    typeof progress.current === 'number' &&
    Number.isFinite(progress.current) &&
    typeof progress.total === 'number' &&
    Number.isFinite(progress.total) &&
    progress.total > 0
  ) {
    return Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
  }

  return undefined;
}

function buildCurrentSummary(task?: TaskInfo): {
  currentSummary?: string;
  currentOperation?: string;
  progressPercent?: number;
} {
  if (!task) {
    return {};
  }

  const progress = task.progress;
  const progressPercent = normalizeProgressPercent(progress);
  const progressMessage = String(progress?.message || '').trim();
  const taskName = String(task.name || '').trim();

  if (progressMessage) {
    return {
      currentSummary: taskName ? `${taskName} · ${progressMessage}` : progressMessage,
      currentOperation: taskName || undefined,
      progressPercent,
    };
  }

  if (taskName) {
    return {
      currentSummary: taskName,
      currentOperation: taskName,
      progressPercent,
    };
  }

  return {
    progressPercent,
  };
}

export class PluginRuntimeRegistry extends TypedEventEmitter<RuntimeRegistryEvents> {
  private statuses = new Map<string, JSPluginRuntimeStatus>();
  private queues = new Map<string, Map<string, QueueBinding>>();

  private buildDefaultStatus(pluginId: string): JSPluginRuntimeStatus {
    const now = Date.now();
    return {
      pluginId,
      lifecyclePhase: DEFAULT_LIFECYCLE_PHASE,
      workState: DEFAULT_WORK_STATE,
      activeQueues: 0,
      runningTasks: 0,
      pendingTasks: 0,
      failedTasks: 0,
      cancelledTasks: 0,
      updatedAt: now,
    };
  }

  private getOrCreateStatus(pluginId: string): JSPluginRuntimeStatus {
    const existing = this.statuses.get(pluginId);
    if (existing) {
      return existing;
    }

    const created = this.buildDefaultStatus(pluginId);
    this.statuses.set(pluginId, created);
    return created;
  }

  private setStatus(pluginId: string, nextStatus: JSPluginRuntimeStatus): JSPluginRuntimeStatus {
    const previous = this.statuses.get(pluginId);
    if (previous && shallowEqualStatus(previous, nextStatus)) {
      return previous;
    }

    this.statuses.set(pluginId, nextStatus);
    this.emit('status-changed', {
      pluginId,
      status: nextStatus,
    });
    return nextStatus;
  }

  private deriveWorkState(
    lifecyclePhase: JSPluginLifecyclePhase,
    counts: Pick<
      JSPluginRuntimeStatus,
      'runningTasks' | 'pendingTasks' | 'failedTasks' | 'cancelledTasks'
    >
  ): JSPluginWorkState {
    if (lifecyclePhase === 'error' || counts.failedTasks > 0) {
      return 'error';
    }

    if (counts.runningTasks > 0 || counts.pendingTasks > 0) {
      return 'busy';
    }

    return 'idle';
  }

  setPluginMetadata(pluginId: string, pluginName?: string): JSPluginRuntimeStatus {
    const current = this.getOrCreateStatus(pluginId);
    const next = {
      ...current,
      pluginName: pluginName || current.pluginName,
      updatedAt: Date.now(),
    };
    return this.setStatus(pluginId, next);
  }

  setLifecyclePhase(
    pluginId: string,
    lifecyclePhase: JSPluginLifecyclePhase,
    pluginName?: string
  ): JSPluginRuntimeStatus {
    const current = this.getOrCreateStatus(pluginId);
    const next = {
      ...current,
      pluginName: pluginName || current.pluginName,
      lifecyclePhase,
      workState: this.deriveWorkState(lifecyclePhase, current),
      updatedAt: Date.now(),
      ...(lifecyclePhase === 'starting'
        ? {
            lastError: undefined,
          }
        : {}),
    };
    return this.setStatus(pluginId, next);
  }

  recordError(
    pluginId: string,
    error: unknown,
    lifecyclePhase: JSPluginLifecyclePhase = 'error',
    pluginName?: string
  ): JSPluginRuntimeStatus {
    const current = this.getOrCreateStatus(pluginId);
    const next = {
      ...current,
      pluginName: pluginName || current.pluginName,
      lifecyclePhase,
      workState: 'error' as const,
      lastError: {
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      },
      updatedAt: Date.now(),
    };
    return this.setStatus(pluginId, next);
  }

  registerQueue(pluginId: string, queueId: string, queue: ITaskQueue, pluginName?: string): void {
    const queueMap = this.queues.get(pluginId) ?? new Map<string, QueueBinding>();
    const existing = queueMap.get(queueId);
    if (existing) {
      this.unregisterQueue(pluginId, queueId);
    }

    const listeners: QueueBinding['listeners'] = [];
    const handleTaskEvent = (event: TaskEvent) => {
      this.refreshPluginStatusFromQueues(pluginId, event, pluginName);
    };
    const handleIdle = () => {
      this.refreshPluginStatusFromQueues(pluginId, undefined, pluginName);
    };

    const registerTaskListener = (eventName: QueueTaskEventName) => {
      switch (eventName) {
        case 'task:added':
          queue.on('task:added', handleTaskEvent);
          break;
        case 'task:started':
          queue.on('task:started', handleTaskEvent);
          break;
        case 'task:progress':
          queue.on('task:progress', handleTaskEvent);
          break;
        case 'task:completed':
          queue.on('task:completed', handleTaskEvent);
          break;
        case 'task:failed':
          queue.on('task:failed', handleTaskEvent);
          break;
        case 'task:cancelled':
          queue.on('task:cancelled', handleTaskEvent);
          break;
      }

      listeners.push({
        event: eventName,
        listener: handleTaskEvent,
      });
    };

    registerTaskListener('task:added');
    registerTaskListener('task:started');
    registerTaskListener('task:progress');
    registerTaskListener('task:completed');
    registerTaskListener('task:failed');
    registerTaskListener('task:cancelled');

    queue.on('queue:idle', handleIdle);
    listeners.push({
      event: 'queue:idle',
      listener: handleIdle,
    });

    queueMap.set(queueId, {
      queueId,
      queue,
      listeners,
    });
    this.queues.set(pluginId, queueMap);
    this.refreshPluginStatusFromQueues(pluginId, undefined, pluginName);
  }

  unregisterQueue(pluginId: string, queueId: string): void {
    const queueMap = this.queues.get(pluginId);
    if (!queueMap) {
      return;
    }

    const binding = queueMap.get(queueId);
    if (!binding) {
      return;
    }

    binding.listeners.forEach(({ event, listener }) => {
      if (event === 'queue:idle') {
        binding.queue.off(event, listener as () => void);
        return;
      }

      binding.queue.off(
        event,
        listener as (event: import('../task-manager/types').TaskEvent) => void
      );
    });

    queueMap.delete(queueId);
    if (queueMap.size === 0) {
      this.queues.delete(pluginId);
    }

    this.refreshPluginStatusFromQueues(pluginId);
  }

  removePlugin(pluginId: string): void {
    const queueMap = this.queues.get(pluginId);
    if (queueMap) {
      Array.from(queueMap.keys()).forEach((queueId) => this.unregisterQueue(pluginId, queueId));
    }

    this.queues.delete(pluginId);
    this.statuses.delete(pluginId);
    this.emit('status-changed', {
      pluginId,
      status: null,
      removed: true,
    });
  }

  listStatuses(): JSPluginRuntimeStatus[] {
    return Array.from(this.statuses.values()).map((status) => ({ ...status }));
  }

  getStatus(pluginId: string): JSPluginRuntimeStatus | null {
    const status = this.statuses.get(pluginId);
    return status ? { ...status } : null;
  }

  private refreshPluginStatusFromQueues(
    pluginId: string,
    taskEvent?: TaskEvent,
    pluginName?: string
  ): JSPluginRuntimeStatus {
    const current = this.getOrCreateStatus(pluginId);
    const queueMap = this.queues.get(pluginId);
    const queues = queueMap ? Array.from(queueMap.values()) : [];

    let runningTasks = 0;
    let pendingTasks = 0;
    let failedTasks = 0;
    let cancelledTasks = 0;
    let firstRunningTask: TaskInfo | undefined;

    queues.forEach(({ queue }) => {
      const stats = queue.getStats();
      runningTasks += stats.running;
      pendingTasks += stats.pending;
      failedTasks += stats.failed;
      cancelledTasks += stats.cancelled;

      if (!firstRunningTask) {
        const running = queue.getAllTasks({ status: 'running' })[0];
        if (running) {
          firstRunningTask = running;
        }
      }
    });

    const summary = buildCurrentSummary(firstRunningTask);
    const fallbackSummary =
      !summary.currentSummary && pendingTasks > 0 ? `排队中：${pendingTasks} 个任务` : undefined;
    const lifecyclePhase = current.lifecyclePhase || DEFAULT_LIFECYCLE_PHASE;
    const workState = this.deriveWorkState(lifecyclePhase, {
      runningTasks,
      pendingTasks,
      failedTasks,
      cancelledTasks,
    });

    const next: JSPluginRuntimeStatus = {
      ...current,
      pluginName: pluginName || current.pluginName,
      activeQueues: queues.length,
      runningTasks,
      pendingTasks,
      failedTasks,
      cancelledTasks,
      currentSummary: summary.currentSummary || fallbackSummary,
      currentOperation: summary.currentOperation,
      progressPercent: summary.progressPercent,
      workState,
      updatedAt: Date.now(),
      lastActivityAt: taskEvent ? Date.now() : current.lastActivityAt,
      lastError:
        taskEvent?.status === 'failed' && taskEvent.error
          ? {
              message: taskEvent.error.message,
              at: Date.now(),
            }
          : current.lastError,
    };

    return this.setStatus(pluginId, next);
  }
}
