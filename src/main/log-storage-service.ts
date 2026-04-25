/**
 * 日志存储服务（基于 DuckDB）
 *
 * 负责：
 * - 日志记录到 DuckDB 数据库
 * - 日志查询
 * - 自动清理旧日志
 *
 * 注意：这是日志持久化存储服务，不是日志输出系统
 * 日志输出请使用 @core/logger
 */

import type { DuckDBService } from './duckdb/service';
import type { LogEntry } from './duckdb/types';

export type { LogEntry };

/**
 * 日志存储服务
 *
 * 将日志持久化到 DuckDB 数据库，支持查询和清理
 */
export class LogStorageService {
  constructor(private duckdbService: DuckDBService) {}

  /**
   * 记录日志
   */
  log(entry: Omit<LogEntry, 'id' | 'timestamp'>): void {
    this.duckdbService.log(entry).catch((error) => {
      console.error('Failed to log:', error);
    });
  }

  /**
   * 便捷方法：info
   */
  info(taskId: string, message: string, data?: unknown, stepIndex?: number): void {
    this.log({ taskId, level: 'info', message, data, stepIndex });
  }

  /**
   * 便捷方法：warn
   */
  warn(taskId: string, message: string, data?: unknown, stepIndex?: number): void {
    this.log({ taskId, level: 'warn', message, data, stepIndex });
  }

  /**
   * 便捷方法：error
   */
  error(taskId: string, message: string, data?: unknown, stepIndex?: number): void {
    this.log({ taskId, level: 'error', message, data, stepIndex });
  }

  /**
   * 便捷方法：debug
   */
  debug(taskId: string, message: string, data?: unknown, stepIndex?: number): void {
    this.log({ taskId, level: 'debug', message, data, stepIndex });
  }

  /**
   * 查询任务日志
   */
  async getTaskLogs(taskId: string, level?: string): Promise<LogEntry[]> {
    return this.duckdbService.getTaskLogs(taskId, level);
  }

  /**
   * 查询最近的日志
   */
  async getRecentLogs(limit: number = 100, level?: string): Promise<LogEntry[]> {
    return this.duckdbService.getRecentLogs(limit, level);
  }

  /**
   * 统计日志
   */
  async getStats(taskId?: string): Promise<{
    total: number;
    byLevel: { [key: string]: number };
  }> {
    const logs = taskId
      ? await this.duckdbService.getTaskLogs(taskId)
      : await this.duckdbService.getRecentLogs(10000);

    const byLevel: { [key: string]: number } = {};
    let total = 0;

    logs.forEach((log) => {
      byLevel[log.level] = (byLevel[log.level] || 0) + 1;
      total++;
    });

    return { total, byLevel };
  }

  /**
   * 清理旧日志（保留最近 N 天）
   */
  async cleanup(daysToKeep: number = 7): Promise<number> {
    return this.duckdbService.cleanupLogs(daysToKeep);
  }

  /**
   * 清空所有日志
   */
  async clear(): Promise<void> {
    return this.duckdbService.clearLogs();
  }

  /**
   * 导出日志（JSON格式）
   */
  async exportLogs(taskId?: string): Promise<string> {
    const logs = taskId
      ? await this.duckdbService.getTaskLogs(taskId)
      : await this.duckdbService.getRecentLogs(10000);
    return JSON.stringify(logs, null, 2);
  }

  /**
   * 关闭（委托给 DuckDBService）
   */
  close(): void {
    // DuckDBService 会统一关闭所有资源
  }
}
