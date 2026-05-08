/**
 * IPC 工具函数
 * 提供类型安全的错误处理和公共辅助函数
 */

import { redactSensitiveText } from '../utils/redaction';
import { getUnknownErrorMessage } from '../utils/error-message';

export { getUnknownErrorMessage } from '../utils/error-message';

/**
 * 类型安全的 IPC 错误处理辅助函数。
 * 返回脱敏后的用户可见错误消息。
 */
export function handleIPCError(error: unknown): { success: false; error: string } {
  const message = getUnknownErrorMessage(error);
  return { success: false, error: redactSensitiveText(message) };
}

/**
 * 创建 IPC 错误结果，同时返回用户可见消息和内部日志上下文。
 * 用于需要区分"给用户看什么"和"给日志记什么"的场景。
 */
export function createIPCErrorResult(error: unknown): {
  success: false;
  userError: string;
  logContext: Record<string, unknown>;
} {
  const message = getUnknownErrorMessage(error);
  return {
    success: false,
    userError: redactSensitiveText(message),
    logContext:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { raw: String(error) },
  };
}
