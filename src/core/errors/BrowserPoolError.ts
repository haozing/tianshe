/**
 * Browser Pool 错误类
 *
 * 浏览器池模块的错误分类
 */

import { CoreError } from './BaseError';
import { BrowserPoolErrorCode } from '../../types/error-codes';

/**
 * Browser Pool 错误基类
 */
export class BrowserPoolError extends CoreError {
  constructor(
    code: BrowserPoolErrorCode | string,
    message: string,
    details?: Record<string, unknown>,
    cause?: Error
  ) {
    super(code, message, details, { component: 'BrowserPool' }, cause);
    this.name = 'BrowserPoolError';
    Object.setPrototypeOf(this, BrowserPoolError.prototype);
  }

  override isRetryable(): boolean {
    const retryableCodes: string[] = [
      BrowserPoolErrorCode.ACQUIRE_TIMEOUT,
      BrowserPoolErrorCode.BROWSER_CREATE_FAILED,
      BrowserPoolErrorCode.LOCK_RENEWAL_FAILED,
    ];
    return retryableCodes.includes(this.code);
  }
}

/**
 * 池已停止错误
 */
export class PoolStoppedError extends BrowserPoolError {
  constructor() {
    super(BrowserPoolErrorCode.POOL_STOPPED, 'Browser pool has been stopped');
    this.name = 'PoolStoppedError';
    Object.setPrototypeOf(this, PoolStoppedError.prototype);
  }
}

/**
 * 池未初始化错误
 */
export class PoolNotInitializedError extends BrowserPoolError {
  constructor() {
    super(
      BrowserPoolErrorCode.POOL_NOT_INITIALIZED,
      'Browser pool not initialized. Call initBrowserPoolManager() first.'
    );
    this.name = 'PoolNotInitializedError';
    Object.setPrototypeOf(this, PoolNotInitializedError.prototype);
  }
}

/**
 * Profile 未找到错误
 */
export class ProfileNotFoundError extends BrowserPoolError {
  constructor(profileId: string) {
    super(BrowserPoolErrorCode.PROFILE_NOT_FOUND, `Profile not found: ${profileId}`, {
      profileId,
    });
    this.name = 'ProfileNotFoundError';
    Object.setPrototypeOf(this, ProfileNotFoundError.prototype);
  }
}

/**
 * 获取浏览器失败错误
 */
export class AcquireFailedError extends BrowserPoolError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super(BrowserPoolErrorCode.ACQUIRE_FAILED, `Failed to acquire browser: ${reason}`, details);
    this.name = 'AcquireFailedError';
    Object.setPrototypeOf(this, AcquireFailedError.prototype);
  }
}

/**
 * 获取浏览器超时错误
 */
export class AcquireTimeoutError extends BrowserPoolError {
  constructor(timeoutMs: number, sessionId?: string) {
    super(BrowserPoolErrorCode.ACQUIRE_TIMEOUT, `Acquire browser timeout after ${timeoutMs}ms`, {
      timeoutMs,
      sessionId,
    });
    this.name = 'AcquireTimeoutError';
    Object.setPrototypeOf(this, AcquireTimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * 浏览器未找到错误
 */
export class BrowserNotFoundError extends BrowserPoolError {
  constructor(browserId: string) {
    super(BrowserPoolErrorCode.BROWSER_NOT_FOUND, `Browser not found: ${browserId}`, {
      browserId,
    });
    this.name = 'BrowserNotFoundError';
    Object.setPrototypeOf(this, BrowserNotFoundError.prototype);
  }
}

/**
 * 浏览器工厂未设置错误
 */
export class FactoryNotSetError extends BrowserPoolError {
  constructor() {
    super(BrowserPoolErrorCode.FACTORY_NOT_SET, 'Browser factory not set');
    this.name = 'FactoryNotSetError';
    Object.setPrototypeOf(this, FactoryNotSetError.prototype);
  }
}

/**
 * 会话限制超出错误
 */
export class SessionLimitExceededError extends BrowserPoolError {
  constructor(sessionId: string, limit: number) {
    super(
      BrowserPoolErrorCode.SESSION_LIMIT_EXCEEDED,
      `Session ${sessionId} reached browser limit: ${limit}`,
      { sessionId, limit }
    );
    this.name = 'SessionLimitExceededError';
    Object.setPrototypeOf(this, SessionLimitExceededError.prototype);
  }
}

/**
 * 浏览器创建失败错误
 */
export class BrowserCreateFailedError extends BrowserPoolError {
  constructor(reason: string, sessionId?: string, cause?: Error) {
    super(
      BrowserPoolErrorCode.BROWSER_CREATE_FAILED,
      `Failed to create browser: ${reason}`,
      { sessionId },
      cause
    );
    this.name = 'BrowserCreateFailedError';
    Object.setPrototypeOf(this, BrowserCreateFailedError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * 浏览器工厂超时错误
 */
export class BrowserFactoryTimeoutError extends BrowserPoolError {
  constructor(timeoutMs: number, sessionId?: string) {
    super(
      BrowserPoolErrorCode.BROWSER_CREATE_FAILED,
      `Browser factory timeout after ${timeoutMs}ms`,
      { timeoutMs, sessionId }
    );
    this.name = 'BrowserFactoryTimeoutError';
    Object.setPrototypeOf(this, BrowserFactoryTimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

// ============================================
// 类型检查辅助函数
// ============================================

export function isBrowserPoolError(error: unknown): error is BrowserPoolError {
  return (
    error instanceof BrowserPoolError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: string }).code === 'string' &&
      (error as { code: string }).code.startsWith('BROWSER_POOL_'))
  );
}

export function isPoolStoppedError(error: unknown): error is PoolStoppedError {
  return isBrowserPoolError(error) && error.code === BrowserPoolErrorCode.POOL_STOPPED;
}

export function isAcquireTimeoutError(error: unknown): error is AcquireTimeoutError {
  return isBrowserPoolError(error) && error.code === BrowserPoolErrorCode.ACQUIRE_TIMEOUT;
}

export function isProfileNotFoundError(error: unknown): error is ProfileNotFoundError {
  return isBrowserPoolError(error) && error.code === BrowserPoolErrorCode.PROFILE_NOT_FOUND;
}
