/**
 * IPC 工具函数
 * 提供类型安全的错误处理和公共辅助函数
 */

/**
 * 类型安全的错误处理辅助函数
 * 替代 catch (error: any) 的方式
 */
export function handleIPCError(error: unknown): { success: false; error: string } {
  if (error instanceof Error) {
    return { success: false, error: error.message };
  }

  if (typeof error === 'string') {
    return { success: false, error };
  }

  // 处理其他类型的错误对象
  if (error && typeof error === 'object' && 'message' in error) {
    return { success: false, error: String((error as any).message) };
  }

  // 未知错误类型
  return { success: false, error: 'Unknown error occurred' };
}
