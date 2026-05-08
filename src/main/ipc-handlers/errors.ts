/**
 * IPC 错误类型
 *
 * 提供结构化的错误处理机制
 */

import {
  createStructuredError,
  type ErrorCode,
  type StructuredError,
} from '../../types/error-codes';

/**
 * IPC 错误码
 *
 * 复用共享 ErrorCode，便于 IPC、HTTP、MCP 错误语义对齐。
 */
export type IpcErrorCode = ErrorCode;

/**
 * 结构化 IPC 错误
 *
 * 提供更详细的错误信息，便于调试和错误处理
 *
 * @example
 * throw new IpcError('NOT_FOUND', 'Profile not found', { profileId: 'xxx' });
 */
export class IpcError extends Error {
  constructor(
    public readonly code: IpcErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'IpcError';
  }

  toStructuredError(): StructuredError {
    return createStructuredError(this.code, this.message, {
      context: this.details,
    });
  }

  /** 资源不存在 */
  static notFound(resource: string, id?: string): IpcError {
    const msg = id ? resource + ' not found: ' + id : resource + ' not found';
    return new IpcError('NOT_FOUND', msg, { resource, id });
  }

  /** 资源被占用 */
  static resourceBusy(resource: string, reason?: string): IpcError {
    const msg = reason ? resource + ' is busy: ' + reason : resource + ' is busy';
    return new IpcError('RESOURCE_BUSY', msg, { resource, reason });
  }

  /** 权限不足 */
  static permissionDenied(action: string): IpcError {
    return new IpcError('PERMISSION_DENIED', 'Permission denied: ' + action, { action });
  }

  /** 输入参数无效 */
  static invalidInput(field: string, reason?: string): IpcError {
    const msg = reason
      ? 'Invalid input: ' + field + ' (' + reason + ')'
      : 'Invalid input: ' + field;
    return new IpcError('INVALID_INPUT', msg, { field, reason });
  }
}

export function isStructuredError(value: unknown): value is StructuredError {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StructuredError>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}
