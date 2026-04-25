/**
 * 统一日志系统 - 基于 pino 实现
 * 提供分级日志记录，支持开发环境美化输出和生产环境 JSON 格式
 */

import pino from 'pino';
import { isDevelopmentMode } from '../constants/runtime-config';

/**
 * 日志级别枚举
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/**
 * 日志级别到 pino 级别的映射
 */
const LOG_LEVEL_TO_PINO: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.SILENT]: 'silent',
};

/**
 * 日志配置接口
 */
export interface LoggerConfig {
  /** 最小日志级别 */
  minLevel?: LogLevel;
  /** 是否在生产环境启用 */
  enableInProduction?: boolean;
  /** 是否显示时间戳 */
  showTimestamp?: boolean;
  /** 是否启用美化输出（开发环境） */
  prettyPrint?: boolean;
}

/**
 * 全局配置
 */
let globalConfig: LoggerConfig = {
  minLevel: LogLevel.INFO,
  enableInProduction: false,
  showTimestamp: true,
  prettyPrint: isDevelopmentMode(),
};

/**
 * 创建基础 pino 实例
 */
function createBasePinoLogger(): pino.Logger {
  const isDev = isDevelopmentMode();
  const level = LOG_LEVEL_TO_PINO[globalConfig.minLevel ?? LogLevel.INFO];

  // 生产环境检查：如果未启用生产环境日志，则只记录 warn 及以上
  const effectiveLevel = !isDev && !globalConfig.enableInProduction ? 'warn' : level;

  const options: pino.LoggerOptions = {
    level: effectiveLevel,
    base: undefined, // 不添加 pid 和 hostname
    timestamp: globalConfig.showTimestamp ? pino.stdTimeFunctions.isoTime : false,
  };

  // 开发环境使用 pino-pretty 美化输出
  if (isDev && globalConfig.prettyPrint) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(options);
}

/**
 * 基础 pino 实例（懒初始化）
 */
let baseLogger: pino.Logger | null = null;

function getBaseLogger(): pino.Logger {
  if (!baseLogger) {
    baseLogger = createBasePinoLogger();
  }
  return baseLogger;
}

/**
 * 重新创建基础 logger（配置变更后调用）
 */
function recreateBaseLogger(): void {
  baseLogger = createBasePinoLogger();
}

/**
 * Logger类 - 提供结构化日志记录
 * 兼容原有 API，内部使用 pino 实现
 */
export class Logger {
  private context: string;
  private pinoLogger: pino.Logger;

  private static globalLevel: LogLevel = LogLevel.INFO;
  private static config: LoggerConfig = globalConfig;

  /** 所有 Logger 实例的弱引用集合（用于级别更新） */
  private static instances = new Set<WeakRef<Logger>>();

  /** FinalizationRegistry 用于清理已被 GC 的实例 */
  private static finalizationRegistry = new FinalizationRegistry<WeakRef<Logger>>((ref) => {
    Logger.instances.delete(ref);
  });

  /**
   * 创建Logger实例
   * @param context - 日志上下文标识（通常是类名或模块名）
   */
  constructor(context: string) {
    this.context = context;
    this.pinoLogger = getBaseLogger().child({ context });

    // 注册实例以便后续更新
    const weakRef = new WeakRef(this);
    Logger.instances.add(weakRef);
    Logger.finalizationRegistry.register(this, weakRef);
  }

  /**
   * 更新内部 pino logger（配置变更后调用）
   * @internal
   */
  private updatePinoLogger(): void {
    this.pinoLogger = getBaseLogger().child({ context: this.context });
  }

  /**
   * 更新所有已存在的 Logger 实例
   * @internal
   */
  private static updateAllInstances(): void {
    for (const ref of Logger.instances) {
      const instance = ref.deref();
      if (instance) {
        instance.updatePinoLogger();
      } else {
        // 清理已被 GC 的引用
        Logger.instances.delete(ref);
      }
    }
  }

  /**
   * 设置全局日志级别
   * @param level - 日志级别
   */
  static setLevel(level: LogLevel): void {
    Logger.globalLevel = level;
    globalConfig.minLevel = level;
    recreateBaseLogger();
    // 更新所有已存在的 Logger 实例
    Logger.updateAllInstances();
  }

  /**
   * 获取当前全局日志级别
   */
  static getLevel(): LogLevel {
    return Logger.globalLevel;
  }

  /**
   * 配置日志系统
   * @param config - 日志配置
   */
  static configure(config: Partial<LoggerConfig>): void {
    Logger.config = { ...Logger.config, ...config };
    globalConfig = { ...globalConfig, ...config };
    if (config.minLevel !== undefined) {
      Logger.globalLevel = config.minLevel;
    }
    recreateBaseLogger();
    // 更新所有已存在的 Logger 实例
    Logger.updateAllInstances();
  }

  /**
   * 获取当前配置
   */
  static getConfig(): LoggerConfig {
    return { ...Logger.config };
  }

  /**
   * 记录调试信息
   * @param message - 日志消息
   * @param data - 附加数据
   */
  debug(message: string, data?: unknown): void {
    if (data !== undefined) {
      if (data instanceof Error) {
        this.pinoLogger.debug({ err: data }, message);
      } else {
        this.pinoLogger.debug({ data }, message);
      }
    } else {
      this.pinoLogger.debug(message);
    }
  }

  /**
   * 记录一般信息
   * @param message - 日志消息
   * @param data - 附加数据
   */
  info(message: string, data?: unknown): void {
    if (data !== undefined) {
      if (data instanceof Error) {
        this.pinoLogger.info({ err: data }, message);
      } else {
        this.pinoLogger.info({ data }, message);
      }
    } else {
      this.pinoLogger.info(message);
    }
  }

  /**
   * 记录警告信息
   * @param message - 日志消息
   * @param data - 附加数据
   */
  warn(message: string, data?: unknown): void {
    if (data !== undefined) {
      if (data instanceof Error) {
        this.pinoLogger.warn({ err: data }, message);
      } else {
        this.pinoLogger.warn({ data }, message);
      }
    } else {
      this.pinoLogger.warn(message);
    }
  }

  /**
   * 记录错误信息
   * @param message - 日志消息
   * @param error - 错误对象或附加数据
   */
  error(message: string, error?: unknown): void {
    if (error !== undefined) {
      if (error instanceof Error) {
        this.pinoLogger.error({ err: error }, message);
      } else {
        this.pinoLogger.error({ data: error }, message);
      }
    } else {
      this.pinoLogger.error(message);
    }
  }

  /**
   * 创建子logger（继承当前上下文）
   * @param subContext - 子上下文
   * @returns 新的Logger实例
   */
  createChild(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`);
  }

  /**
   * 获取内部 pino logger（高级用法）
   */
  getPinoLogger(): pino.Logger {
    return this.pinoLogger;
  }
}

/**
 * 创建Logger实例的便捷函数
 * @param context - 日志上下文
 * @returns Logger实例
 */
export function createLogger(context: string): Logger {
  return new Logger(context);
}

/**
 * 获取原始 pino logger（高级用法）
 * @param context - 可选的上下文
 * @returns pino Logger 实例
 */
export function getPinoLogger(context?: string): pino.Logger {
  const base = getBaseLogger();
  return context ? base.child({ context }) : base;
}

/**
 * 导出 pino 类型以供外部使用
 */
export type PinoLogger = pino.Logger;
