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

  return redactStructuredError(
    createStructuredError(ErrorCode.OPERATION_FAILED, getUnknownErrorMessage(error, defaultMessage), {
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
