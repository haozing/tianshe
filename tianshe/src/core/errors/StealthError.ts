/**
 * Stealth 模块错误类
 *
 * 反检测/指纹模块的错误分类
 */

import { CoreError } from './BaseError';
import { StealthErrorCode } from '../../types/error-codes';

/**
 * Stealth 错误基类
 */
export class StealthError extends CoreError {
  constructor(
    code: StealthErrorCode | string,
    message: string,
    details?: Record<string, unknown>,
    cause?: Error
  ) {
    super(code, message, details, { component: 'Stealth' }, cause);
    this.name = 'StealthError';
    Object.setPrototypeOf(this, StealthError.prototype);
  }

  override isRetryable(): boolean {
    const retryableCodes: string[] = [
      StealthErrorCode.CDP_COMMAND_FAILED,
      StealthErrorCode.SCRIPT_INJECTION_FAILED,
    ];
    return retryableCodes.includes(this.code);
  }
}

/**
 * CDP 模拟失败错误
 */
export class CDPEmulationFailedError extends StealthError {
  constructor(operation: string, reason?: string, cause?: Error) {
    const message = reason
      ? `CDP emulation failed for ${operation}: ${reason}`
      : `CDP emulation failed for ${operation}`;
    super(StealthErrorCode.CDP_EMULATION_FAILED, message, { operation }, cause);
    this.name = 'CDPEmulationFailedError';
    Object.setPrototypeOf(this, CDPEmulationFailedError.prototype);
  }
}

/**
 * CDP 命令执行失败错误
 */
export class CDPCommandFailedError extends StealthError {
  constructor(command: string, cause?: Error) {
    super(
      StealthErrorCode.CDP_COMMAND_FAILED,
      `CDP command failed: ${command}`,
      { command },
      cause
    );
    this.name = 'CDPCommandFailedError';
    Object.setPrototypeOf(this, CDPCommandFailedError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * CDP 不可用错误
 */
export class CDPNotAvailableError extends StealthError {
  constructor() {
    super(StealthErrorCode.CDP_NOT_AVAILABLE, 'CDP (Chrome DevTools Protocol) is not available');
    this.name = 'CDPNotAvailableError';
    Object.setPrototypeOf(this, CDPNotAvailableError.prototype);
  }
}

/**
 * 指纹生成失败错误
 */
export class FingerprintGenerationFailedError extends StealthError {
  constructor(reason: string, cause?: Error) {
    super(
      StealthErrorCode.FINGERPRINT_GENERATION_FAILED,
      `Failed to generate fingerprint: ${reason}`,
      undefined,
      cause
    );
    this.name = 'FingerprintGenerationFailedError';
    Object.setPrototypeOf(this, FingerprintGenerationFailedError.prototype);
  }
}

/**
 * 无效指纹错误
 */
export class InvalidFingerprintError extends StealthError {
  constructor(field: string, reason?: string) {
    const message = reason
      ? `Invalid fingerprint field '${field}': ${reason}`
      : `Invalid fingerprint field: ${field}`;
    super(StealthErrorCode.FINGERPRINT_INVALID, message, { field });
    this.name = 'InvalidFingerprintError';
    Object.setPrototypeOf(this, InvalidFingerprintError.prototype);
  }
}

/**
 * 指纹配置文件未找到错误
 */
export class FingerprintProfileNotFoundError extends StealthError {
  constructor(profileId: string) {
    super(
      StealthErrorCode.FINGERPRINT_PROFILE_NOT_FOUND,
      `Fingerprint profile not found: ${profileId}`,
      { profileId }
    );
    this.name = 'FingerprintProfileNotFoundError';
    Object.setPrototypeOf(this, FingerprintProfileNotFoundError.prototype);
  }
}

/**
 * 脚本生成失败错误
 */
export class ScriptGenerationFailedError extends StealthError {
  constructor(scriptType: string, reason?: string, cause?: Error) {
    const message = reason
      ? `Failed to generate ${scriptType} script: ${reason}`
      : `Failed to generate ${scriptType} script`;
    super(StealthErrorCode.SCRIPT_GENERATION_FAILED, message, { scriptType }, cause);
    this.name = 'ScriptGenerationFailedError';
    Object.setPrototypeOf(this, ScriptGenerationFailedError.prototype);
  }
}

/**
 * 脚本注入失败错误
 */
export class ScriptInjectionFailedError extends StealthError {
  constructor(reason?: string, cause?: Error) {
    const message = reason
      ? `Failed to inject stealth script: ${reason}`
      : 'Failed to inject stealth script';
    super(StealthErrorCode.SCRIPT_INJECTION_FAILED, message, undefined, cause);
    this.name = 'ScriptInjectionFailedError';
    Object.setPrototypeOf(this, ScriptInjectionFailedError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}

/**
 * 无效配置错误
 */
export class InvalidStealthConfigError extends StealthError {
  constructor(field: string, reason: string) {
    super(StealthErrorCode.INVALID_CONFIG, `Invalid stealth config '${field}': ${reason}`, {
      field,
    });
    this.name = 'InvalidStealthConfigError';
    Object.setPrototypeOf(this, InvalidStealthConfigError.prototype);
  }
}

/**
 * 不支持的平台错误
 */
export class UnsupportedPlatformError extends StealthError {
  constructor(platform: string) {
    super(StealthErrorCode.UNSUPPORTED_PLATFORM, `Unsupported platform: ${platform}`, {
      platform,
    });
    this.name = 'UnsupportedPlatformError';
    Object.setPrototypeOf(this, UnsupportedPlatformError.prototype);
  }
}

// ============================================
// 类型检查辅助函数
// ============================================

export function isStealthError(error: unknown): error is StealthError {
  return (
    error instanceof StealthError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: string }).code === 'string' &&
      (error as { code: string }).code.startsWith('STEALTH_'))
  );
}

export function isCDPError(error: unknown): boolean {
  if (!isStealthError(error)) return false;
  const cdpCodes: string[] = [
    StealthErrorCode.CDP_EMULATION_FAILED,
    StealthErrorCode.CDP_COMMAND_FAILED,
    StealthErrorCode.CDP_NOT_AVAILABLE,
  ];
  return cdpCodes.includes(error.code);
}

export function isFingerprintError(error: unknown): boolean {
  if (!isStealthError(error)) return false;
  const fingerprintCodes: string[] = [
    StealthErrorCode.FINGERPRINT_GENERATION_FAILED,
    StealthErrorCode.FINGERPRINT_INVALID,
    StealthErrorCode.FINGERPRINT_PROFILE_NOT_FOUND,
  ];
  return fingerprintCodes.includes(error.code);
}
