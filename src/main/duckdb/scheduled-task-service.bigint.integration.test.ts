import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { ScheduledTaskService } from './scheduled-task-service';

describe('ScheduledTaskService BIGINT integration', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let service: ScheduledTaskService;

  beforeEach(async () => {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    service = new ScheduledTaskService(conn);
    await service.initTable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    conn.closeSync();
    db.closeSync();
  });

  it('persists task millisecond timestamps without 32-bit truncation', async () => {
    const createdAt = 1_775_994_400_123;
    const updatedAt = createdAt + 777;
    const nextRunAt = createdAt + 3_600_000;
    const lastRunAt = createdAt + 1_234;

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockImplementationOnce(() => createdAt).mockImplementationOnce(() => updatedAt);

    const task = await service.createTask({
      id: 'task-1',
      pluginId: 'plugin-local-smoke-probe',
      name: 'Task 1',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
      handlerId: 'handler-1',
      nextRunAt,
      retryDelayMs: 5_000,
      timeoutMs: 120_000,
      resourceWaitTimeoutMs: 45_000,
    });

    expect(task.createdAt).toBe(createdAt);
    expect(task.nextRunAt).toBe(nextRunAt);

    await service.updateTask(task.id, {
      lastRunAt,
      nextRunAt: nextRunAt + 1_000,
      timeoutMs: 120_500,
      retryDelayMs: 5_500,
      resourceWaitTimeoutMs: 46_000,
    });

    const fetched = await service.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.createdAt).toBe(createdAt);
    expect(fetched?.updatedAt).toBe(updatedAt);
    expect(fetched?.intervalMs).toBe(3_600_000);
    expect(fetched?.lastRunAt).toBe(lastRunAt);
    expect(fetched?.nextRunAt).toBe(nextRunAt + 1_000);
    expect(fetched?.timeoutMs).toBe(120_500);
    expect(fetched?.retryDelayMs).toBe(5_500);
    expect(fetched?.resourceWaitTimeoutMs).toBe(46_000);
  });

  it('persists execution timestamps without 32-bit truncation', async () => {
    await service.createTask({
      id: 'task-1',
      pluginId: 'plugin-local-smoke-probe',
      name: 'Task 1',
      scheduleType: 'interval',
      intervalMs: 60_000,
      handlerId: 'handler-1',
    });

    const startedAt = 1_775_995_000_001;
    const finishedAt = startedAt + 456;

    await service.createExecution({
      id: 'exec-1',
      taskId: 'task-1',
      triggerType: 'manual',
      startedAt,
    });

    await service.updateExecution('exec-1', {
      status: 'completed',
      finishedAt,
      durationMs: 456,
      result: { ok: true },
    });

    const executions = await service.getExecutions('task-1', 5);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.startedAt).toBe(startedAt);
    expect(executions[0]?.finishedAt).toBe(finishedAt);
    expect(executions[0]?.durationMs).toBe(456);
    expect(executions[0]?.result).toEqual({ ok: true });
  });
});
