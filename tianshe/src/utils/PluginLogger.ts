/**
 * Plugin Logger - 插件日志工具
 *
 * 基于 core/logger (pino) 实现，提供插件专用的领域方法
 * 保留结构化、易于调试的日志输出
 */

import { createLogger, type Logger } from '../core/logger';

/**
 * 插件日志记录器
 *
 * 基于统一的 pino 日志系统，提供插件特定的便捷方法
 */
export class PluginLogger {
  private logger: Logger;
  private pluginId: string;
  private pluginName: string;

  constructor(pluginId: string, pluginName: string = pluginId) {
    this.pluginId = pluginId;
    this.pluginName = pluginName;
    this.logger = createLogger(`Plugin:${pluginName}`);
  }

  /**
   * DEBUG 级别日志
   */
  debug(message: string, data?: unknown): void {
    this.logger.debug(message, data);
  }

  /**
   * INFO 级别日志
   */
  info(message: string, data?: unknown): void {
    this.logger.info(message, data);
  }

  /**
   * WARN 级别日志
   */
  warn(message: string, data?: unknown): void {
    this.logger.warn(message, data);
  }

  /**
   * ERROR 级别日志
   */
  error(message: string, error?: Error | unknown): void {
    this.logger.error(message, error);
  }

  /**
   * 记录插件生命周期事件
   */
  lifecycle(
    event: 'loading' | 'loaded' | 'activating' | 'activated' | 'deactivating' | 'deactivated',
    details?: unknown
  ): void {
    const icons: Record<string, string> = {
      loading: '[Loading]',
      loaded: '[Loaded]',
      activating: '[Activating]',
      activated: '[Activated]',
      deactivating: '[Deactivating]',
      deactivated: '[Deactivated]',
    };

    const icon = icons[event];
    this.logger.info(`${icon} Plugin ${event}`, details);
  }

  /**
   * 记录命令执行
   */
  command(commandId: string, phase: 'start' | 'success' | 'error', details?: unknown): void {
    const icons: Record<string, string> = {
      start: '[Start]',
      success: '[Success]',
      error: '[Error]',
    };

    const icon = icons[phase];
    const message = `${icon} Command: ${commandId} (${phase})`;

    if (phase === 'error') {
      this.logger.error(message, details);
    } else {
      this.logger.info(message, details);
    }
  }

  /**
   * 记录数据表操作
   */
  dataTable(
    operation: 'create' | 'query' | 'insert' | 'update' | 'delete',
    tableCode: string,
    details?: unknown
  ): void {
    const icons: Record<string, string> = {
      create: '[Create]',
      query: '[Query]',
      insert: '[Insert]',
      update: '[Update]',
      delete: '[Delete]',
    };

    const icon = icons[operation];
    this.logger.info(`${icon} DataTable [${tableCode}]: ${operation}`, details);
  }

  /**
   * 记录网络请求
   */
  network(method: string, url: string, status?: number, details?: unknown): void {
    const statusIcon = status ? (status < 400 ? '[OK]' : '[Fail]') : '[Request]';
    const statusText = status ? ` (${status})` : '';
    this.logger.info(`${statusIcon} ${method} ${url}${statusText}`, details);
  }

  /**
   * 记录性能指标
   */
  performance(operation: string, durationMs: number, details?: unknown): void {
    const icon = durationMs > 1000 ? '[Slow]' : durationMs > 100 ? '[Normal]' : '[Fast]';
    this.logger.info(`${icon} Performance: ${operation} took ${durationMs}ms`, details);
  }

  /**
   * 创建计时器
   */
  timer(label: string): () => void {
    const startTime = Date.now();
    return () => {
      const duration = Date.now() - startTime;
      this.performance(label, duration);
    };
  }

  /**
   * 记录分隔线（用于视觉分组）
   * 注意：pino 模式下简化为普通日志
   */
  separator(title?: string): void {
    if (title) {
      this.logger.info(`--- ${title} ---`);
    } else {
      this.logger.debug('---');
    }
  }

  /**
   * 获取插件ID
   */
  getPluginId(): string {
    return this.pluginId;
  }

  /**
   * 获取插件名称
   */
  getPluginName(): string {
    return this.pluginName;
  }

  /**
   * 获取内部 Logger 实例（高级用法）
   */
  getLogger(): Logger {
    return this.logger;
  }
}

/**
 * 创建插件日志记录器
 */
export function createPluginLogger(pluginId: string, pluginName?: string): PluginLogger {
  return new PluginLogger(pluginId, pluginName);
}
