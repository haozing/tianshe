/**
 * IPC 工具函数
 * 提供类型安全的错误处理和公共辅助函数
 */

import { redactSensitiveText, redactSensitiveValue } from '../utils/redaction';
import { getUnknownErrorMessage } from '../utils/error-message';
import {
  createStructuredError,
  ErrorCode,
  type ErrorCode as SharedErrorCode,
  type StructuredError,
} from '../types/error-codes';
import { IpcError, isStructuredError } from './ipc-handlers/errors';

export { getUnknownErrorMessage } from '../utils/error-message';

export interface IPCErrorResponse {
  success: false;
  error: string;
  code: SharedErrorCode;
  errorDetails: StructuredError;
}

export interface IPCDetailedErrorResult {
  success: false;
  userError: string;
  code: SharedErrorCode;
  errorDetails: StructuredError;
  logContext: Record<string, unknown>;
}

function redactStructuredError(error: StructuredError): StructuredError {
  return {
    ...error,
    code: String(error.code || '').trim() || ErrorCode.OPERATION_FAILED,
    message: redactSensitiveText(String(error.message || '').trim() || 'Operation failed'),
    ...(typeof error.details === 'string'
      ? { details: redactSensitiveText(error.details) }
      : {}),
    ...(typeof error.suggestion === 'string'
      ? { suggestion: redactSensitiveText(error.suggestion) }
      : {}),
    ...(error.context
      ? { context: redactSensitiveValue(error.context) as Record<string, unknown> }
      : {}),
  };
}

function createLogContext(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { raw: String(error) };
}

export function inferErrorCodeFromMessage(message: string): SharedErrorCode {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) {
    return ErrorCode.OPERATION_FAILED;
  }

  if (/\b(timeout|timed out)\b|超时/.test(normalized)) {
    return ErrorCode.TIMEOUT;
  }
  if (/\b(permission denied|unauthorized|forbidden|access denied)\b|权限|未授权|无权限|拒绝/.test(normalized)) {
    return ErrorCode.PERMISSION_DENIED;
  }
  if (/\b(not found|missing)\b|未找到|找不到|不存在/.test(normalized)) {
    return ErrorCode.NOT_FOUND;
  }
  if (/\b(already exists|duplicate|conflict)\b|已存在|重复|冲突/.test(normalized)) {
    return ErrorCode.ALREADY_EXISTS;
  }
  if (/\b(busy|locked|in use)\b|占用|繁忙|锁定/.test(normalized)) {
    return ErrorCode.RESOURCE_BUSY;
  }
  if (/\b(invalid input|invalid parameter|validation|required)\b|参数|无效|非法|不能为空|校验|验证|格式/.test(normalized)) {
    return ErrorCode.INVALID_INPUT;
  }

  return ErrorCode.OPERATION_FAILED;
}

export function createIPCErrorEnvelope(
  error: unknown,
  defaultMessage = 'Unknown error occurred'
): StructuredError {
  if (error instanceof IpcError) {
    return redactStructuredError(error.toStructuredError());
  }

  if (isStructuredError(error)) {
    return redactStructuredError(error);
  }

  const message = getUnknownErrorMessage(error, defaultMessage);
  return redactStructuredError(
    createStructuredError(inferErrorCodeFromMessage(message), message, {
      context: error instanceof Error ? { name: error.name } : undefined,
    })
  );
}

/**
 * 类型安全的 IPC 错误处理辅助函数。
 * 返回脱敏后的用户可见错误消息。
 */
export function handleIPCError(error: unknown): IPCErrorResponse {
  const errorDetails = createIPCErrorEnvelope(error);
  return {
    success: false,
    error: errorDetails.message,
    code: errorDetails.code as SharedErrorCode,
    errorDetails,
  };
}

/**
 * 创建 IPC 错误结果，同时返回用户可见消息和内部日志上下文。
 * 用于需要区分"给用户看什么"和"给日志记什么"的场景。
 */
export function createIPCErrorResult(
  error: unknown,
  defaultMessage = 'Unknown error occurred'
): IPCDetailedErrorResult {
  const errorDetails = createIPCErrorEnvelope(error, defaultMessage);
  return {
    success: false,
    userError: errorDetails.message,
    code: errorDetails.code as SharedErrorCode,
    errorDetails,
    logContext: createLogContext(error),
  };
}
