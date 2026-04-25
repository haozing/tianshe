import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceCoordinator } from '../../core/resource-coordinator';
import { SchedulerService } from './scheduler-service';
import type { ScheduledTask, TaskExecution } from '../duckdb/scheduled-task-service';

function createMockTaskService() {
  return {
    getTask: vi.fn(),
    getActiveTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    getTasksByPlugin: vi.fn().mockResolvedValue([]),
    getAllTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    createExecution: vi.fn().mockImplementation(async (params) => ({
      id: params.id,
      taskId: params.taskId,
      status: params.status || 'running',
      startedAt: params.startedAt || Date.now(),
      triggerType: params.triggerType,
    })),
    updateExecution: vi.fn().mockResolvedValue(undefined),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    cleanupOldExecutions: vi.fn().mockResolvedValue(0),
    getStats: vi.fn().mockResolvedValue({
      total: 0,
      active: 0,
      paused: 0,
      disabled: 0,
      todayExecutions: 0,
      todayFailed: 0,
    }),
    deleteTasksByPlugin: vi.fn().mockResolvedValue(0),
  };
}

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    pluginId: 'test-plugin',
    name: 'Test Task',
    description: 'resource test',
    scheduleType: 'interval',
    intervalMs: 60000,
    handlerId: 'handler-1',
    payload: { ok: true },
    status: 'active',
    timeoutMs: 5000,
    retryCount: 0,
    retryDelayMs: 10,
    missedPolicy: 'skip',
    runCount: 0,
    failCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SchedulerService resource serialization', () => {
  let scheduler: SchedulerService;
  let mockTaskService: ReturnType<typeof createMockTaskService>;

  beforeEach(async () => {
    await resourceCoordinator.clear();
    mockTaskService = createMockTaskService();
    scheduler = new SchedulerService(mockTaskService as any);
  });

  afterEach(async () => {
    await scheduler.dispose();
    await resourceCoordinator.clear();
    vi.restoreAllMocks();
  });

  it('serializes tasks that declare the same resource key', async () => {
    const task1 = createTask({
      id: 'task-1',
      handlerId: 'handler-1',
      resourceKeys: ['profile:p1'],
    });
    const task2 = createTask({
      id: 'task-2',
      handlerId: 'handler-2',
      resourceKeys: ['profile:p1'],
    });

    mockTaskService.getTask.mockImplementation(async (taskId: string) => {
      if (taskId === task1.id) return task1;
      if (taskId === task2.id) return task2;
      return null;
    });

    const started: string[] = [];
    let resolveFirst: (() => void) | null = null;

    scheduler.registerHandler(task1.pluginId, task1.handlerId, async () => {
      started.push(task1.id);
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return { id: task1.id };
    });
    scheduler.registerHandler(task2.pluginId, task2.handlerId, async () => {
      started.push(task2.id);
      return { id: task2.id };
    });

    const firstRun = scheduler.triggerTask(task1.id);
    await sleep(20);

    const secondRun = scheduler.triggerTask(task2.id);
    await sleep(20);

    expect(started).toEqual([task1.id]);

    resolveFirst?.();
    await firstRun;
    await sleep(20);

    expect(started).toEqual([task1.id, task2.id]);
    await secondRun;
  });

  it('allows different resource keys to run in parallel', async () => {
    const task1 = createTask({
      id: 'task-1',
      handlerId: 'handler-1',
      resourceKeys: ['profile:p1'],
    });
    const task2 = createTask({
      id: 'task-2',
      handlerId: 'handler-2',
      resourceKeys: ['profile:p2'],
    });

    mockTaskService.getTask.mockImplementation(async (taskId: string) => {
      if (taskId === task1.id) return task1;
      if (taskId === task2.id) return task2;
      return null;
    });

    const started = new Set<string>();
    let resolveFirst: (() => void) | null = null;
    let resolveSecond: (() => void) | null = null;

    scheduler.registerHandler(task1.pluginId, task1.handlerId, async () => {
      started.add(task1.id);
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return { id: task1.id };
    });
    scheduler.registerHandler(task2.pluginId, task2.handlerId, async () => {
      started.add(task2.id);
      await new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      return { id: task2.id };
    });

    const firstRun = scheduler.triggerTask(task1.id);
    const secondRun = scheduler.triggerTask(task2.id);

    await sleep(20);
    expect(Array.from(started).sort()).toEqual([task1.id, task2.id]);

    resolveFirst?.();
    resolveSecond?.();
    await Promise.all([firstRun, secondRun]);
  });

  it('fails with a normalized message when resource wait times out', async () => {
    const task1 = createTask({
      id: 'task-1',
      handlerId: 'handler-1',
      resourceKeys: ['profile:p1'],
    });
    const task2 = createTask({
      id: 'task-2',
      handlerId: 'handler-2',
      resourceKeys: ['profile:p1'],
      resourceWaitTimeoutMs: 50,
    });

    mockTaskService.getTask.mockImplementation(async (taskId: string) => {
      if (taskId === task1.id) return task1;
      if (taskId === task2.id) return task2;
      return null;
    });

    let resolveFirst: (() => void) | null = null;
    const secondHandler = vi.fn().mockResolvedValue({ id: task2.id });

    scheduler.registerHandler(task1.pluginId, task1.handlerId, async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return { id: task1.id };
    });
    scheduler.registerHandler(task2.pluginId, task2.handlerId, secondHandler);

    const firstRun = scheduler.triggerTask(task1.id);
    await sleep(20);

    const secondResult = await scheduler.triggerTask(task2.id);

    expect(secondResult.status).toBe('failed');
    expect(secondResult.error).toBe('Resource wait timeout');
    expect(secondHandler).not.toHaveBeenCalled();

    resolveFirst?.();
    await firstRun;
  });
});
