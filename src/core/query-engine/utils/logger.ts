/**
 * 查询引擎日志系统
 * 基于 pino 实现，提供结构化、分级的日志记录
 */

import { createLogger as createCoreLogger, type Logger as CoreLogger } from '../../logger';
import { AIRPA_RUNTIME_CONFIG } from '../../../constants/runtime-config';

/**
 * 日志级别枚举
 */
export enum LogLevel {
  DEBUG = 0, // 调试信息（开发环境）
  INFO = 1, // 一般信息
  WARN = 2, // 警告信息
  ERROR = 3, // 错误信息
  NONE = 4, // 不输出任何日志
}

/**
 * 日志接口
 */
export interface ILogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, error?: Error, meta?: unknown): void;
}

/**
 * Pino 日志实现
 * 使用核心 pino logger，提供统一的日志格式
 */
export class PinoLogger implements ILogger {
  private logger: CoreLogger;

  constructor(context: string = 'QueryEngine') {
    this.logger = createCoreLogger(context);
  }

  debug(message: string, meta?: unknown): void {
    this.logger.debug(message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.logger.info(message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.logger.warn(message, meta);
  }

  error(message: string, error?: Error, meta?: unknown): void {
    if (error) {
      this.logger.error(message, { error, ...((meta as object) || {}) });
    } else {
      this.logger.error(message, meta);
    }
  }
}

/**
 * 静默日志实现
 * 适用于测试环境，不输出任何日志
 */
export class SilentLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/**
 * 日志工厂
 * 根据环境创建合适的Logger
 */
export class LoggerFactory {
  /**
   * 创建Logger实例
   *
   * @param context - 日志上下文（如 'QueryEngine', 'FilterBuilder' 等）
   * @param options - 配置选项
   */
  static create(
    context: string = 'QueryEngine',
    options?: {
      level?: LogLevel;
      type?: 'silent' | 'pino';
      env?: 'development' | 'production' | 'test';
    }
  ): ILogger {
    const env = options?.env || AIRPA_RUNTIME_CONFIG.logger.env;
    const type = options?.type || (env === 'test' ? 'silent' : 'pino');

    if (type === 'silent') {
      return new SilentLogger();
    }
    return new PinoLogger(context);
  }

  /**
   * 创建开发环境Logger
   */
  static development(context: string = 'QueryEngine'): ILogger {
    return new PinoLogger(context);
  }

  /**
   * 创建生产环境Logger
   */
  static production(context: string = 'QueryEngine'): ILogger {
    return new PinoLogger(context);
  }

  /**
   * 创建测试环境Logger
   */
  static test(_context: string = 'QueryEngine'): ILogger {
    return new SilentLogger();
  }
}
