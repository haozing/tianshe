/**
 * LogService - 日志管理服务
 * 负责：日志写入、查询、清理
 * 单一职责：所有与日志相关的数据库操作
 */

import { DuckDBConnection } from '@duckdb/node-api';
import type { LogEntry } from './types';
import { parseRows } from './utils';

export class LogService {
  private lastIdTimestamp = 0;
  private lastIdSeq = 0;

  constructor(private conn: DuckDBConnection) {}

  private nextId(): number {
    const now = Date.now();
    if (now === this.lastIdTimestamp) {
      this.lastIdSeq = (this.lastIdSeq + 1) % 1000;
    } else {
      this.lastIdTimestamp = now;
      this.lastIdSeq = 0;
    }

    // 1ms * 1000 slots => up to 1000 unique IDs per millisecond, within JS safe integer range.
    return now * 1000 + this.lastIdSeq;
  }

  /**
   * 初始化日志表
   */
  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT PRIMARY KEY,
        task_id VARCHAR NOT NULL,
        timestamp BIGINT NOT NULL,
        level VARCHAR NOT NULL,
        step_index INTEGER,
        message TEXT,
        data JSON
      )
    `);

    // Best-effort schema fix for older installs where logs.id was INTEGER.
    // DuckDB may not support ALTER COLUMN type in all versions; fall back to table copy if needed.
    try {
      await this.conn.run(`ALTER TABLE logs ALTER COLUMN id SET DATA TYPE BIGINT`);
    } catch (error: any) {
      const msg = String(error?.message || error);
      // Only attempt migration when type change isn't supported or fails due to current type.
      if (
        msg.includes('Parser Error') ||
        msg.includes('Not implemented') ||
        msg.includes('not supported') ||
        msg.includes('Conversion') ||
        msg.includes('Binder')
      ) {
        try {
          await this.conn.run(`
            CREATE TABLE IF NOT EXISTS logs__migrate (
              id BIGINT PRIMARY KEY,
              task_id VARCHAR NOT NULL,
              timestamp BIGINT NOT NULL,
              level VARCHAR NOT NULL,
              step_index INTEGER,
              message TEXT,
              data JSON
            )
          `);

          // Copy existing rows (if any). If the old table already has BIGINT, this is still safe.
          await this.conn.run(`
            INSERT OR IGNORE INTO logs__migrate (id, task_id, timestamp, level, step_index, message, data)
            SELECT CAST(id AS BIGINT), task_id, timestamp, level, step_index, message, data
            FROM logs
          `);

          await this.conn.run(`DROP TABLE logs`);
          await this.conn.run(`ALTER TABLE logs__migrate RENAME TO logs`);
        } catch (migrateError) {
          console.warn('[WARN] Failed to migrate logs.id to BIGINT (non-critical):', migrateError);
        }
      }
    }

    await this.conn.run(`CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id)`);
    await this.conn.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
  }

  /**
   * 写入日志条目
   */
  async log(entry: Omit<LogEntry, 'id' | 'timestamp'>): Promise<void> {
    try {
      const id = this.nextId();

      const stmt = await this.conn.prepare(`
        INSERT INTO logs (id, task_id, timestamp, level, step_index, message, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const message = entry.message || null;
      const data = entry.data ? JSON.stringify(entry.data) : null;

      stmt.bind([
        id,
        entry.taskId,
        Date.now(),
        entry.level,
        entry.stepIndex ?? null,
        message,
        data,
      ]);

      await stmt.run();
      stmt.destroySync();
    } catch (error) {
      console.error('Failed to log:', error);
    }
  }

  /**
   * 获取任务的所有日志
   */
  async getTaskLogs(taskId: string, level?: string): Promise<LogEntry[]> {
    let query = 'SELECT * FROM logs WHERE task_id = ?';
    const params: any[] = [taskId];

    if (level) {
      query += ' AND level = ?';
      params.push(level);
    }
    query += ' ORDER BY timestamp ASC';

    const stmt = await this.conn.prepare(query);
    stmt.bind(params);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);

    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: Number(row.timestamp),
      level: row.level,
      stepIndex: row.step_index,
      message: row.message,
      data: row.data ? JSON.parse(row.data) : undefined,
    }));
  }

  /**
   * 获取最近的日志
   */
  async getRecentLogs(limit: number = 100, level?: string): Promise<LogEntry[]> {
    let query = 'SELECT * FROM logs';
    const params: any[] = [];

    if (level) {
      query += ' WHERE level = ?';
      params.push(level);
    }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const stmt = await this.conn.prepare(query);
    stmt.bind(params);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);

    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: Number(row.timestamp),
      level: row.level,
      stepIndex: row.step_index,
      message: row.message,
      data: row.data ? JSON.parse(row.data) : undefined,
    }));
  }

  /**
   * 清理旧日志
   */
  async cleanupLogs(daysToKeep: number = 7): Promise<number> {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const countStmt = await this.conn.prepare(
      'SELECT COUNT(*) as count FROM logs WHERE timestamp < ?'
    );
    countStmt.bind([cutoff]);
    const countResult = await countStmt.runAndReadAll();
    countStmt.destroySync();

    const rows = parseRows(countResult);
    const count = Number(rows[0]?.count || 0);

    const deleteStmt = await this.conn.prepare('DELETE FROM logs WHERE timestamp < ?');
    deleteStmt.bind([cutoff]);
    await deleteStmt.run();
    deleteStmt.destroySync();

    return count;
  }

  /**
   * 清空所有日志
   */
  async clearLogs(): Promise<void> {
    await this.conn.run('DELETE FROM logs');
  }
}
