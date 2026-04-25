/**
 * AutomationPersistenceService - 自动化持久化服务
 * 负责：自动化配置的CRUD操作
 * 单一职责：自动化配置的数据库持久化
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';

export class AutomationPersistenceService {
  constructor(private conn: DuckDBConnection) {}

  /**
   * 初始化自动化表
   */
  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS automations (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        description TEXT,
        enabled BOOLEAN DEFAULT true,
        config JSON NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        last_run_at BIGINT,
        run_count INTEGER DEFAULT 0
      )
    `);

    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_automations_enabled ON automations(enabled)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_automations_last_run ON automations(last_run_at)`
    );
  }

  /**
   * 保存自动化配置
   */
  async saveAutomation(automation: any): Promise<void> {
    const now = Date.now();
    const config = JSON.stringify(automation);
    const name = automation.name;
    const description = automation.description || '';

    const stmt = await this.conn.prepare(`
      INSERT INTO automations (id, name, description, enabled, config, created_at, updated_at, run_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        enabled = excluded.enabled,
        config = excluded.config,
        updated_at = excluded.updated_at
    `);

    stmt.bind([
      automation.id,
      name,
      description,
      automation.enabled ? true : false,
      config,
      automation.createdAt || now,
      automation.updatedAt || now,
      automation.runCount || 0,
    ]);

    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 加载自动化配置
   */
  async loadAutomation(automationId: string): Promise<any | null> {
    const stmt = await this.conn.prepare('SELECT * FROM automations WHERE id = ?');
    stmt.bind([automationId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);

    if (rows.length === 0) return null;

    const row: any = rows[0];
    return JSON.parse(String(row.config));
  }

  /**
   * 获取自动化列表
   */
  async listAutomations(): Promise<any[]> {
    const result = await this.conn.runAndReadAll(
      'SELECT * FROM automations ORDER BY created_at DESC'
    );
    const rows = parseRows(result);

    return rows.map((row: any) => JSON.parse(row.config));
  }

  /**
   * 更新自动化配置
   */
  async updateAutomation(automationId: string, updates: any): Promise<void> {
    const automation = await this.loadAutomation(automationId);
    if (!automation) {
      throw new Error(`Automation not found: ${automationId}`);
    }

    // 合并更新
    const updated = { ...automation, ...updates, updatedAt: Date.now() };
    await this.saveAutomation(updated);
  }

  /**
   * 删除自动化
   */
  async deleteAutomation(automationId: string): Promise<void> {
    const stmt = await this.conn.prepare('DELETE FROM automations WHERE id = ?');
    stmt.bind([automationId]);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 执行参数化SQL查询
   * 提供SQL注入防护和特殊字符处理
   *
   * @param sql - SQL语句（带?占位符）
   * @param params - 参数值数组
   * @returns 查询结果
   *
   * @example
   * ```typescript
   * await service.executeSQLWithParams(
   *   "UPDATE data SET status=? WHERE id=?",
   *   ['completed', 123]
   * );
   * ```
   */
  async executeSQLWithParams(sql: string, params: any[]): Promise<any> {
    const stmt = await this.conn.prepare(sql);
    stmt.bind(params);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    return parseRows(result);
  }

  /**
   * 执行参数化SQL（不返回结果）
   *
   * @param sql - SQL语句（带?占位符）
   * @param params - 参数值数组
   */
  async executeWithParams(sql: string, params: any[]): Promise<void> {
    const stmt = await this.conn.prepare(sql);
    stmt.bind(params);
    await stmt.run();
    stmt.destroySync();
  }
}
