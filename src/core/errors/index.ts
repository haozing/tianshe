/**
 * Core 错误模块统一导出
 *
 * 提供所有 core 模块的错误类和工具函数
 */

// 基础错误类
export {
  CoreError,
  isCoreError,
  getErrorMessage,
  getErrorCode,
  type ErrorContext,
  type SerializedError,
} from './BaseError';

// 错误码从统一的 error-codes 导出
export { BrowserPoolErrorCode, StealthErrorCode } from '../../types/error-codes';

// Browser Pool 错误
export {
  BrowserPoolError,
  PoolStoppedError,
  PoolNotInitializedError,
  ProfileNotFoundError,
  AcquireFailedError,
  AcquireTimeoutError,
  BrowserNotFoundError,
  FactoryNotSetError,
  SessionLimitExceededError,
  BrowserCreateFailedError,
  isBrowserPoolError,
  isPoolStoppedError,
  isAcquireTimeoutError,
  isProfileNotFoundError,
} from './BrowserPoolError';

// Stealth 错误
export {
  StealthError,
  CDPEmulationFailedError,
  CDPCommandFailedError,
  CDPNotAvailableError,
  FingerprintGenerationFailedError,
  InvalidFingerprintError,
  FingerprintProfileNotFoundError,
  ScriptGenerationFailedError,
  ScriptInjectionFailedError,
  InvalidStealthConfigError,
  UnsupportedPlatformError,
  isStealthError,
  isCDPError,
  isFingerprintError,
} from './StealthError';
