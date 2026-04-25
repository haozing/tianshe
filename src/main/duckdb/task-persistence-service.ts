/**
 * TaskPersistenceService - 任务持久化服务
 * 负责：任务状态的CRUD操作
 * 单一职责：任务持久化和状态管理
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';

export class TaskPersistenceService {
  constructor(private conn: DuckDBConnection) {}

  /**
   * 初始化任务表
   */
  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR PRIMARY KEY,
        workflow JSON NOT NULL,
        partition VARCHAR NOT NULL,
        priority INTEGER DEFAULT 0,
        status VARCHAR NOT NULL,
        start_time BIGINT,
        end_time BIGINT,
        result JSON,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);

    await this.conn.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
    await this.conn.run(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)`);
  }

  /**
   * 保存任务
   */
  async saveTask(task: any): Promise<void> {
    const now = Date.now();
    const workflow = JSON.stringify(task.workflow);
    const result = task.result ? JSON.stringify(task.result) : null;

    const stmt = await this.conn.prepare(`
      INSERT INTO tasks (id, workflow, partition, priority, status, start_time, end_time, result, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        result = excluded.result,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);

    stmt.bind([
      task.id,
      workflow,
      task.partition,
      task.priority || 0,
      task.status,
      task.startTime || null,
      task.endTime || null,
      result,
      task.error ? task.error.message || String(task.error) : null,
      task.createdAt || now,
      now,
    ]);

    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(taskId: string, status: string, updates?: any): Promise<void> {
    const now = Date.now();
    const setFields = ['status = ?', 'updated_at = ?'];
    const values: any[] = [status, now];

    if (updates?.startTime !== undefined) {
      setFields.push('start_time = ?');
      values.push(updates.startTime);
    }
    if (updates?.endTime !== undefined) {
      setFields.push('end_time = ?');
      values.push(updates.endTime);
    }
    if (updates?.result !== undefined) {
      setFields.push('result = ?');
      values.push(JSON.stringify(updates.result));
    }
    if (updates?.error !== undefined) {
      setFields.push('error = ?');
      values.push(updates.error.message || String(updates.error));
    }

    values.push(taskId);

    const stmt = await this.conn.prepare(`UPDATE tasks SET ${setFields.join(', ')} WHERE id = ?`);
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 加载未完成的任务（用于恢复）
   */
  async loadUnfinishedTasks(): Promise<any[]> {
    const result = await this.conn.runAndReadAll(
      `SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY created_at ASC`
    );
    const rows = parseRows(result);

    return rows.map((row: any) => ({
      id: row.id,
      workflow: JSON.parse(row.workflow),
      partition: row.partition,
      priority: row.priority || 0,
      status: row.status,
      startTime: row.start_time ? Number(row.start_time) : undefined,
      endTime: row.end_time ? Number(row.end_time) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ? new Error(row.error) : undefined,
    }));
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<void> {
    const stmt = await this.conn.prepare('DELETE FROM tasks WHERE id = ?');
    stmt.bind([taskId]);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 清理旧任务（保留最近N天）
   */
  async cleanupOldTasks(daysToKeep: number = 7): Promise<number> {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const countStmt = await this.conn.prepare(
      `SELECT COUNT(*) as count FROM tasks WHERE status IN ('completed', 'failed') AND end_time < ?`
    );
    countStmt.bind([cutoff]);
    const countResult = await countStmt.runAndReadAll();
    countStmt.destroySync();

    const rows = parseRows(countResult);
    const count = Number(rows[0]?.count || 0);

    const deleteStmt = await this.conn.prepare(
      `DELETE FROM tasks WHERE status IN ('completed', 'failed') AND end_time < ?`
    );
    deleteStmt.bind([cutoff]);
    await deleteStmt.run();
    deleteStmt.destroySync();

    return count;
  }
}
