/**
 * FFI 错误类
 *
 * FFI 操作相关的错误类型
 */

import { CoreError } from '../errors/BaseError';

/** FFI 错误码 */
export enum FFIErrorCode {
  /** 库加载失败 */
  LIBRARY_LOAD_FAILED = 'FFI_LIBRARY_LOAD_FAILED',
  /** 函数定义失败 */
  FUNCTION_DEFINE_FAILED = 'FFI_FUNCTION_DEFINE_FAILED',
  /** 函数调用失败 */
  FUNCTION_CALL_FAILED = 'FFI_FUNCTION_CALL_FAILED',
  /** 回调创建失败 */
  CALLBACK_CREATE_FAILED = 'FFI_CALLBACK_CREATE_FAILED',
  /** 库未找到 */
  LIBRARY_NOT_FOUND = 'FFI_LIBRARY_NOT_FOUND',
  /** 函数未找到 */
  FUNCTION_NOT_FOUND = 'FFI_FUNCTION_NOT_FOUND',
  /** 资源限制超出 */
  RESOURCE_LIMIT_EXCEEDED = 'FFI_RESOURCE_LIMIT_EXCEEDED',
  /** 无效路径 */
  INVALID_PATH = 'FFI_INVALID_PATH',
  /** 操作失败 */
  OPERATION_FAILED = 'FFI_OPERATION_FAILED',
}

/**
 * FFI 错误
 *
 * 库加载、函数调用、回调创建等操作的错误
 */
export class FFIError extends CoreError {
  constructor(
    message: string,
    code: FFIErrorCode | string = FFIErrorCode.OPERATION_FAILED,
    cause?: Error
  ) {
    super(code, message, undefined, { component: 'FFI' }, cause);
    this.name = 'FFIError';
    Object.setPrototypeOf(this, FFIError.prototype);
  }

  override isRetryable(): boolean {
    // 库加载失败可能是临时的（如文件被占用）
    return this.code === FFIErrorCode.LIBRARY_LOAD_FAILED;
  }
}
