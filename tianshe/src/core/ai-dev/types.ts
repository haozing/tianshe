/**
 * AI 浏览器控制系统 - 类型定义
 */

// 重新导出 browser-core 中的类型
export type {
  PageSnapshot,
  SnapshotElement,
  NetworkEntry,
  ConsoleMessage,
  SnapshotOptions,
  NetworkCaptureOptions,
  Cookie,
} from '../browser-core/types';

// 重新导出 browser-interface 中的类型
export type {
  NormalizedPoint,
  NormalizedBounds,
  Bounds,
  NativeClickOptions,
  NativeTypeOptions,
} from '../../types/browser-interface';

// ============================================
// 日志相关
// ============================================

/**
 * 日志接口
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * 默认日志（静默）
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

type ConsoleLogLevel = 'debug' | 'info' | 'warn' | 'error';

function writeToRuntimeConsole(level: ConsoleLogLevel, message: string, args: unknown[]): void {
  const runtimeConsole = globalThis['console'];
  const writer = runtimeConsole?.[level] ?? runtimeConsole?.log;
  if (typeof writer !== 'function') {
    return;
  }
  writer.call(runtimeConsole, message, ...args);
}

function createConsoleLogger(prefix: string): Logger {
  return {
    debug: (msg, ...args) => writeToRuntimeConsole('debug', `[${prefix}] ${msg}`, args),
    info: (msg, ...args) => writeToRuntimeConsole('info', `[${prefix}] ${msg}`, args),
    warn: (msg, ...args) => writeToRuntimeConsole('warn', `[${prefix}] ${msg}`, args),
    error: (msg, ...args) => writeToRuntimeConsole('error', `[${prefix}] ${msg}`, args),
  };
}

/**
 * 控制台日志
 */
export const consoleLogger: Logger = createConsoleLogger('AI-Dev');

/**
 * 创建带自定义前缀的控制台日志
 */
export function createLogger(prefix: string): Logger {
  return createConsoleLogger(prefix);
}

// ============================================
// 错误处理相关
// ============================================

// 重新导出统一的错误码和结构化错误
export {
  ErrorCode,
  CommonErrorCode,
  BrowserErrorCode,
  PluginErrorCode,
  createStructuredError,
} from '../../types/error-codes';

export type { StructuredError } from '../../types/error-codes';
