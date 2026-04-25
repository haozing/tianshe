/**
 * ScheduledTaskService - 定时任务持久化服务
 * 负责：定时任务和执行历史的CRUD操作
 * 单一职责：定时任务持久化和状态管理
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import type {
  ScheduledTask,
  TaskExecution,
  CreateScheduledTaskParams,
  TaskStats,
} from '../../types/scheduler';

// 重新导出类型供其他模块使用
export type { ScheduledTask, TaskExecution, CreateScheduledTaskParams, TaskStats };

function toDuckDbBigInt(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`Expected a finite BIGINT-compatible number, received: ${value}`);
  }

  return BigInt(Math.trunc(value));
}

function toNullableDuckDbBigInt(value: number | null | undefined): bigint | null {
  return value == null ? null : toDuckDbBigInt(value);
}

export class ScheduledTaskService {
  constructor(private conn: DuckDBConnection) {}

  /**
   * 初始化定时任务相关表
   */
  async initTable(): Promise<void> {
    // 创建定时任务表
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id VARCHAR PRIMARY KEY,
        plugin_id VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        description TEXT,

        schedule_type VARCHAR NOT NULL,
        cron_expression VARCHAR,
        interval_ms BIGINT,
        run_at BIGINT,

        handler_id VARCHAR NOT NULL,
        payload JSON,
        timeout_ms BIGINT DEFAULT 120000,
        retry_count INTEGER DEFAULT 0,
        retry_delay_ms BIGINT DEFAULT 5000,
        missed_policy VARCHAR DEFAULT 'skip',
        resource_keys JSON,
        resource_wait_timeout_ms BIGINT,

        status VARCHAR DEFAULT 'active',
        last_run_at BIGINT,
        last_run_status VARCHAR,
        next_run_at BIGINT,
        run_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,

        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);

    await this.conn.run(
      `ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS resource_keys JSON`
    );
    await this.conn.run(
      `ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS resource_wait_timeout_ms BIGINT`
    );

    // 创建执行历史表
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS task_executions (
        id VARCHAR PRIMARY KEY,
        task_id VARCHAR NOT NULL,

        status VARCHAR NOT NULL,
        started_at BIGINT NOT NULL,
        finished_at BIGINT,
        duration_ms BIGINT,

        result JSON,
        error TEXT,

        trigger_type VARCHAR
      )
    `);

    // 创建索引
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_plugin ON scheduled_tasks(plugin_id)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_task_executions_started ON task_executions(started_at)`
    );

    console.log('[ScheduledTaskService] Tables initialized');
  }

  // ========== 定时任务 CRUD ==========

  /**
   * 创建定时任务
   */
  async createTask(params: CreateScheduledTaskParams): Promise<ScheduledTask> {
    const now = Date.now();
    const task: ScheduledTask = {
      id: params.id!, // id 由调用方（SchedulerService.createTask）保证提供
      pluginId: params.pluginId,
      name: params.name,
      description: params.description,
      scheduleType: params.scheduleType,
      cronExpression: params.cronExpression,
      intervalMs: params.intervalMs,
      runAt: params.runAt,
      handlerId: params.handlerId,
      payload: params.payload,
      timeoutMs: params.timeoutMs ?? 120000,
      retryCount: params.retryCount ?? 0,
      retryDelayMs: params.retryDelayMs ?? 5000,
      missedPolicy: params.missedPolicy ?? 'skip',
      resourceKeys: Array.isArray(params.resourceKeys) ? params.resourceKeys : undefined,
      resourceWaitTimeoutMs:
        typeof params.resourceWaitTimeoutMs === 'number'
          ? params.resourceWaitTimeoutMs
          : undefined,
      status: 'active',
      nextRunAt: params.nextRunAt,
      runCount: 0,
      failCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = await this.conn.prepare(`
      INSERT INTO scheduled_tasks (
        id, plugin_id, name, description,
        schedule_type, cron_expression, interval_ms, run_at,
        handler_id, payload, timeout_ms, retry_count, retry_delay_ms, missed_policy,
        resource_keys, resource_wait_timeout_ms,
        status, next_run_at, run_count, fail_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
      task.id,
      task.pluginId,
      task.name,
      task.description || null,
      task.scheduleType,
      task.cronExpression || null,
      toNullableDuckDbBigInt(task.intervalMs),
      toNullableDuckDbBigInt(task.runAt),
      task.handlerId,
      task.payload ? JSON.stringify(task.payload) : null,
      toDuckDbBigInt(task.timeoutMs),
      task.retryCount,
      toDuckDbBigInt(task.retryDelayMs),
      task.missedPolicy,
      task.resourceKeys ? JSON.stringify(task.resourceKeys) : null,
      toNullableDuckDbBigInt(task.resourceWaitTimeoutMs),
      task.status,
      toNullableDuckDbBigInt(task.nextRunAt),
      task.runCount,
      task.failCount,
      toDuckDbBigInt(task.createdAt),
      toDuckDbBigInt(task.updatedAt),
    ]);

    await stmt.run();
    stmt.destroySync();

    return task;
  }

  /**
   * 获取单个任务
   */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    const stmt = await this.conn.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`);
    stmt.bind([taskId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.rowToTask(rows[0]);
  }

  /**
   * 获取所有活跃任务（用于恢复）
   */
  async getActiveTasks(): Promise<ScheduledTask[]> {
    const result = await this.conn.runAndReadAll(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' ORDER BY next_run_at ASC`
    );
    const rows = parseRows(result);
    return rows.map((row: any) => this.rowToTask(row));
  }

  /**
   * 获取插件的所有任务
   */
  async getTasksByPlugin(pluginId: string): Promise<ScheduledTask[]> {
    const stmt = await this.conn.prepare(
      `SELECT * FROM scheduled_tasks WHERE plugin_id = ? ORDER BY created_at DESC`
    );
    stmt.bind([pluginId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return rows.map((row: any) => this.rowToTask(row));
  }

  /**
   * 获取所有任务（带分页）
   */
  async getAllTasks(options?: {
    status?: string;
    pluginId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: ScheduledTask[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options?.pluginId) {
      conditions.push('plugin_id = ?');
      params.push(options.pluginId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    // 获取总数
    const countSql = `SELECT COUNT(*) as count FROM scheduled_tasks ${whereClause}`;
    const countStmt = await this.conn.prepare(countSql);
    if (params.length > 0) countStmt.bind(params);
    const countResult = await countStmt.runAndReadAll();
    countStmt.destroySync();
    const total = Number(parseRows(countResult)[0]?.count || 0);

    // 获取数据
    const dataSql = `
      SELECT * FROM scheduled_tasks
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const dataStmt = await this.conn.prepare(dataSql);
    if (params.length > 0) dataStmt.bind(params);
    const dataResult = await dataStmt.runAndReadAll();
    dataStmt.destroySync();

    const rows = parseRows(dataResult);
    const tasks = rows.map((row: any) => this.rowToTask(row));

    return { tasks, total };
  }

  /**
   * 更新任务
   */
  async updateTask(
    taskId: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        | 'name'
        | 'description'
        | 'status'
        | 'lastRunAt'
        | 'lastRunStatus'
        | 'nextRunAt'
        | 'runCount'
        | 'failCount'
        | 'payload'
        | 'timeoutMs'
        | 'retryCount'
        | 'retryDelayMs'
        | 'resourceKeys'
        | 'resourceWaitTimeoutMs'
      >
    >
  ): Promise<void> {
    const now = Date.now();
    const setFields: string[] = ['updated_at = ?'];
    const values: any[] = [toDuckDbBigInt(now)];

    if (updates.name !== undefined) {
      setFields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setFields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.status !== undefined) {
      setFields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.lastRunAt !== undefined) {
      setFields.push('last_run_at = ?');
      values.push(toNullableDuckDbBigInt(updates.lastRunAt));
    }
    if (updates.lastRunStatus !== undefined) {
      setFields.push('last_run_status = ?');
      values.push(updates.lastRunStatus);
    }
    if (updates.nextRunAt !== undefined) {
      setFields.push('next_run_at = ?');
      values.push(toNullableDuckDbBigInt(updates.nextRunAt));
    }
    if (updates.runCount !== undefined) {
      setFields.push('run_count = ?');
      values.push(updates.runCount);
    }
    if (updates.failCount !== undefined) {
      setFields.push('fail_count = ?');
      values.push(updates.failCount);
    }
    if (updates.payload !== undefined) {
      setFields.push('payload = ?');
      values.push(JSON.stringify(updates.payload));
    }
    if (updates.timeoutMs !== undefined) {
      setFields.push('timeout_ms = ?');
      values.push(toDuckDbBigInt(updates.timeoutMs));
    }
    if (updates.retryCount !== undefined) {
      setFields.push('retry_count = ?');
      values.push(updates.retryCount);
    }
    if (updates.retryDelayMs !== undefined) {
      setFields.push('retry_delay_ms = ?');
      values.push(toDuckDbBigInt(updates.retryDelayMs));
    }
    if (updates.resourceKeys !== undefined) {
      setFields.push('resource_keys = ?');
      values.push(JSON.stringify(updates.resourceKeys));
    }
    if (updates.resourceWaitTimeoutMs !== undefined) {
      setFields.push('resource_wait_timeout_ms = ?');
      values.push(toNullableDuckDbBigInt(updates.resourceWaitTimeoutMs));
    }

    values.push(taskId);

    const stmt = await this.conn.prepare(
      `UPDATE scheduled_tasks SET ${setFields.join(', ')} WHERE id = ?`
    );
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<void> {
    // 先删除执行历史
    const deleteExecStmt = await this.conn.prepare(`DELETE FROM task_executions WHERE task_id = ?`);
    deleteExecStmt.bind([taskId]);
    await deleteExecStmt.run();
    deleteExecStmt.destroySync();

    // 再删除任务
    const deleteTaskStmt = await this.conn.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`);
    deleteTaskStmt.bind([taskId]);
    await deleteTaskStmt.run();
    deleteTaskStmt.destroySync();
  }

  /**
   * 删除插件的所有任务
   */
  async deleteTasksByPlugin(pluginId: string): Promise<number> {
    // 获取插件的所有任务ID
    const stmt = await this.conn.prepare(`SELECT id FROM scheduled_tasks WHERE plugin_id = ?`);
    stmt.bind([pluginId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    const taskIds = rows.map((row: any) => row.id);

    // 删除每个任务（包括执行历史）
    for (const taskId of taskIds) {
      await this.deleteTask(taskId);
    }

    return taskIds.length;
  }

  // ========== 执行历史 CRUD ==========

  /**
   * 创建执行记录
   */
  async createExecution(params: {
    id: string;
    taskId: string;
    triggerType: 'scheduled' | 'manual' | 'recovery';
    status?: TaskExecution['status'];
    startedAt?: number;
  }): Promise<TaskExecution> {
    const execution: TaskExecution = {
      id: params.id,
      taskId: params.taskId,
      status: params.status || 'running',
      startedAt: params.startedAt ?? Date.now(),
      triggerType: params.triggerType,
    };

    const stmt = await this.conn.prepare(`
      INSERT INTO task_executions (id, task_id, status, started_at, trigger_type)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.bind([
      execution.id,
      execution.taskId,
      execution.status,
      toDuckDbBigInt(execution.startedAt),
      execution.triggerType,
    ]);

    await stmt.run();
    stmt.destroySync();

    return execution;
  }

  /**
   * 更新执行记录
   */
  async updateExecution(
    executionId: string,
    updates: Partial<
      Pick<TaskExecution, 'status' | 'startedAt' | 'finishedAt' | 'durationMs' | 'result' | 'error'>
    >
  ): Promise<void> {
    const setFields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      setFields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.startedAt !== undefined) {
      setFields.push('started_at = ?');
      values.push(toDuckDbBigInt(updates.startedAt));
    }
    if (updates.finishedAt !== undefined) {
      setFields.push('finished_at = ?');
      values.push(toNullableDuckDbBigInt(updates.finishedAt));
    }
    if (updates.durationMs !== undefined) {
      setFields.push('duration_ms = ?');
      values.push(toDuckDbBigInt(updates.durationMs));
    }
    if (updates.result !== undefined) {
      setFields.push('result = ?');
      values.push(JSON.stringify(updates.result));
    }
    if (updates.error !== undefined) {
      setFields.push('error = ?');
      values.push(updates.error);
    }

    if (setFields.length === 0) return;

    values.push(executionId);

    const stmt = await this.conn.prepare(
      `UPDATE task_executions SET ${setFields.join(', ')} WHERE id = ?`
    );
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 获取任务的执行历史
   */
  async getExecutions(taskId: string, limit: number = 50): Promise<TaskExecution[]> {
    const stmt = await this.conn.prepare(`
      SELECT * FROM task_executions
      WHERE task_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
    stmt.bind([taskId, limit]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return rows.map((row: any) => this.rowToExecution(row));
  }

  /**
   * 获取最近的执行记录（全局）
   */
  async getRecentExecutions(limit: number = 20): Promise<TaskExecution[]> {
    const stmt = await this.conn.prepare(`
      SELECT * FROM task_executions
      ORDER BY started_at DESC
      LIMIT ?
    `);
    stmt.bind([limit]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return rows.map((row: any) => this.rowToExecution(row));
  }

  /**
   * 清理旧的执行记录
   */
  async cleanupOldExecutions(daysToKeep: number = 30): Promise<number> {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const countStmt = await this.conn.prepare(
      `SELECT COUNT(*) as count FROM task_executions WHERE started_at < ?`
    );
    countStmt.bind([toDuckDbBigInt(cutoff)]);
    const countResult = await countStmt.runAndReadAll();
    countStmt.destroySync();

    const count = Number(parseRows(countResult)[0]?.count || 0);

    const deleteStmt = await this.conn.prepare(`DELETE FROM task_executions WHERE started_at < ?`);
    deleteStmt.bind([toDuckDbBigInt(cutoff)]);
    await deleteStmt.run();
    deleteStmt.destroySync();

    return count;
  }

  // ========== 统计 ==========

  /**
   * 获取任务统计
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    paused: number;
    disabled: number;
    todayExecutions: number;
    todayFailed: number;
  }> {
    // 任务状态统计
    const statusResult = await this.conn.runAndReadAll(`
      SELECT status, COUNT(*) as count
      FROM scheduled_tasks
      GROUP BY status
    `);
    const statusRows = parseRows(statusResult);

    const stats = {
      total: 0,
      active: 0,
      paused: 0,
      disabled: 0,
      todayExecutions: 0,
      todayFailed: 0,
    };

    for (const row of statusRows) {
      const count = Number(row.count);
      stats.total += count;
      if (row.status === 'active') stats.active = count;
      else if (row.status === 'paused') stats.paused = count;
      else if (row.status === 'disabled') stats.disabled = count;
    }

    // 今日执行统计
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();

    const execResult = await this.conn.runAndReadAll(`
      SELECT status, COUNT(*) as count
      FROM task_executions
      WHERE started_at >= ${todayStartMs}
      GROUP BY status
    `);
    const execRows = parseRows(execResult);

    for (const row of execRows) {
      const count = Number(row.count);
      stats.todayExecutions += count;
      if (row.status === 'failed') stats.todayFailed = count;
    }

    return stats;
  }

  // ========== 私有方法 ==========

  private rowToTask(row: any): ScheduledTask {
    return {
      id: row.id,
      pluginId: row.plugin_id,
      name: row.name,
      description: row.description || undefined,
      scheduleType: row.schedule_type,
      cronExpression: row.cron_expression || undefined,
      intervalMs: row.interval_ms == null ? undefined : Number(row.interval_ms),
      runAt: row.run_at == null ? undefined : Number(row.run_at),
      handlerId: row.handler_id,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
      timeoutMs: Number(row.timeout_ms),
      retryCount: Number(row.retry_count),
      retryDelayMs: Number(row.retry_delay_ms),
      missedPolicy: row.missed_policy || 'skip',
      resourceKeys: row.resource_keys ? JSON.parse(row.resource_keys) : undefined,
      resourceWaitTimeoutMs:
        row.resource_wait_timeout_ms == null ? undefined : Number(row.resource_wait_timeout_ms),
      status: row.status,
      lastRunAt: row.last_run_at == null ? undefined : Number(row.last_run_at),
      lastRunStatus: row.last_run_status || undefined,
      nextRunAt: row.next_run_at == null ? undefined : Number(row.next_run_at),
      runCount: Number(row.run_count),
      failCount: Number(row.fail_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToExecution(row: any): TaskExecution {
    return {
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
      durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error || undefined,
      triggerType: row.trigger_type || 'scheduled',
    };
  }
}
