/**
 * Core 统一错误基类
 *
 * 所有 core 模块错误类的基类，提供：
 * - 统一的错误码系统
 * - 链式错误（cause）支持
 * - JSON 序列化（用于 IPC 传输）
 * - 错误上下文信息
 *
 * 设计原则：
 * - 所有错误必须有错误码（code）
 * - 所有错误必须可序列化
 * - 支持错误链追踪
 */

import type { ErrorCode } from '../../types/error-codes';

/**
 * 错误上下文接口
 */
export interface ErrorContext {
  /** 操作名称 */
  operation?: string;
  /** 相关字段 */
  field?: string;
  /** 组件/模块名称 */
  component?: string;
  /** 其他上下文 */
  [key: string]: unknown;
}

/**
 * 序列化后的错误对象接口
 */
export interface SerializedError {
  name: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  context?: ErrorContext;
  timestamp: number;
  stack?: string;
  cause?: SerializedError;
}

/**
 * Core 统一错误基类
 *
 * @example
 * ```typescript
 * // 直接使用
 * throw new CoreError('OPERATION_FAILED', '操作失败', { operation: 'save' });
 *
 * // 作为基类
 * class MyModuleError extends CoreError {
 *   constructor(message: string, details?: Record<string, unknown>) {
 *     super('MY_MODULE_ERROR', message, details);
 *     this.name = 'MyModuleError';
 *   }
 * }
 * ```
 */
export class CoreError extends Error {
  /**
   * 错误码（用于程序判断）
   */
  public readonly code: string;

  /**
   * 详细信息（用于调试）
   */
  public readonly details?: Record<string, unknown>;

  /**
   * 错误上下文
   */
  public readonly context?: ErrorContext;

  /**
   * 错误时间戳
   */
  public readonly timestamp: number;

  /**
   * 原始错误
   */
  public readonly cause?: Error;

  constructor(
    code: string | ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
    this.context = context;
    this.timestamp = Date.now();
    this.cause = cause;

    // 保留原始错误栈
    if (cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }

    // 确保正确的原型链（ES5 兼容）
    Object.setPrototypeOf(this, new.target.prototype);

    // 捕获堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  /**
   * 转换为 JSON（用于 IPC 传输和日志）
   */
  toJSON(): SerializedError {
    const result: SerializedError = {
      name: this.name,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
    };

    if (this.details) {
      result.details = this.details;
    }

    if (this.context) {
      result.context = this.context;
    }

    if (this.stack) {
      result.stack = this.stack;
    }

    if (this.cause) {
      result.cause =
        this.cause instanceof CoreError
          ? this.cause.toJSON()
          : {
              name: this.cause.name,
              code: 'UNKNOWN_ERROR',
              message: this.cause.message,
              timestamp: this.timestamp,
              stack: this.cause.stack,
            };
    }

    return result;
  }

  /**
   * 获取用户友好的错误消息
   * 子类可重写此方法提供更友好的消息
   */
  getUserMessage(): string {
    return this.message;
  }

  /**
   * 判断是否是用户输入错误（非系统错误）
   * 子类可重写此方法
   */
  isUserError(): boolean {
    const userErrorCodes = [
      'INVALID_PARAMETER',
      'MISSING_PARAMETER',
      'VALIDATION_ERROR',
      'PERMISSION_DENIED',
      'NOT_FOUND',
    ];
    return userErrorCodes.includes(this.code);
  }

  /**
   * 判断是否可重试
   * 子类可重写此方法
   */
  isRetryable(): boolean {
    const retryableCodes = ['TIMEOUT', 'NETWORK_ERROR', 'REQUEST_FAILED'];
    return retryableCodes.includes(this.code);
  }

  /**
   * 从普通 Error 创建 CoreError
   */
  static fromError(error: Error, code = 'UNKNOWN_ERROR'): CoreError {
    if (error instanceof CoreError) {
      return error;
    }

    return new CoreError(code, error.message, undefined, undefined, error);
  }

  /**
   * 创建带上下文的错误
   */
  static withContext(
    code: string,
    message: string,
    context: ErrorContext,
    cause?: Error
  ): CoreError {
    return new CoreError(code, message, undefined, context, cause);
  }
}

/**
 * 检查是否是 CoreError 实例
 */
export function isCoreError(error: unknown): error is CoreError {
  return (
    error instanceof CoreError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      'message' in error &&
      'timestamp' in error)
  );
}

/**
 * 安全地获取错误消息
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/**
 * 安全地获取错误码
 */
export function getErrorCode(error: unknown): string {
  if (isCoreError(error)) {
    return error.code;
  }
  return 'UNKNOWN_ERROR';
}
