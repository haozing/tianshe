/**
 * IPC Handler 工具函数
 *
 * 提供统一的 IPC 处理器创建和错误处理机制，减少重复代码
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IpcError, type IpcErrorCode } from './errors';

// 重新导出 IpcError 供其他模块使用
export { IpcError, type IpcErrorCode } from './errors';

/**
 * IPC 响应结构
 */
export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** 错误码（如果使用 IpcError） */
  code?: IpcErrorCode;
}

/**
 * 创建标准的 IPC Handler
 *
 * 自动处理：
 * - try-catch 错误捕获
 * - 统一的日志输出
 * - 统一的响应格式
 *
 * @param channel IPC 通道名称
 * @param handler 处理函数
 * @param errorMessage 错误时的默认消息
 *
 * @example
 * ```ts
 * createIpcHandler(
 *   'profile:create',
 *   async (params: CreateProfileParams) => profileService.create(params),
 *   '创建浏览器配置失败'
 * );
 * ```
 */
export function createIpcHandler<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult>,
  errorMessage: string = '操作失败'
): void {
  ipcMain.handle(
    channel,
    async (_event: IpcMainInvokeEvent, ...args: TArgs): Promise<IPCResponse<TResult>> => {
      try {
        const result = await handler(...args);
        return { success: true, data: result };
      } catch (error) {
        console.error(`[IPC] ${channel} error:`, error);
        // 支持结构化错误
        if (error instanceof IpcError) {
          return {
            success: false,
            error: error.message,
            code: error.code,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : errorMessage,
        };
      }
    }
  );
}

/**
 * 创建无返回值的 IPC Handler
 *
 * @param channel IPC 通道名称
 * @param handler 处理函数
 * @param errorMessage 错误时的默认消息
 */
export function createIpcVoidHandler<TArgs extends unknown[]>(
  channel: string,
  handler: (...args: TArgs) => Promise<void>,
  errorMessage: string = '操作失败'
): void {
  ipcMain.handle(
    channel,
    async (_event: IpcMainInvokeEvent, ...args: TArgs): Promise<IPCResponse<void>> => {
      try {
        await handler(...args);
        return { success: true };
      } catch (error) {
        console.error(`[IPC] ${channel} error:`, error);
        // 支持结构化错误
        if (error instanceof IpcError) {
          return {
            success: false,
            error: error.message,
            code: error.code,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : errorMessage,
        };
      }
    }
  );
}

/**
 * 批量注册 IPC Handlers
 *
 * @param handlers Handler 配置数组
 *
 * @example
 * ```ts
 * registerIpcHandlers([
 *   { channel: 'profile:create', handler: async (params) => service.create(params), errorMsg: '创建失败' },
 *   { channel: 'profile:delete', handler: async (id) => service.delete(id), errorMsg: '删除失败', isVoid: true },
 * ]);
 * ```
 */
export function registerIpcHandlers(
  handlers: Array<{
    channel: string;
    handler: (...args: any[]) => Promise<any>;
    errorMsg?: string;
    isVoid?: boolean;
  }>
): void {
  for (const { channel, handler, errorMsg, isVoid } of handlers) {
    if (isVoid) {
      createIpcVoidHandler(channel, handler, errorMsg);
    } else {
      createIpcHandler(channel, handler, errorMsg);
    }
  }
}

/**
 * 统一的 IPC 错误处理函数
 *
 * 用于手动编写的 handler 中统一处理错误
 *
 * @param error 捕获的错误
 * @param defaultMessage 默认错误消息
 * @returns 标准化的错误响应
 *
 * @example
 * ```ts
 * ipcMain.handle('profile:delete', async (_, id: string) => {
 *   try {
 *     await profileService.delete(id);
 *     return { success: true };
 *   } catch (error) {
 *     return handleIPCError(error, '删除失败');
 *   }
 * });
 * ```
 */
export function handleIPCError(
  error: unknown,
  defaultMessage: string = '操作失败'
): IPCResponse<never> {
  // 支持结构化错误
  if (error instanceof IpcError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
    };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : defaultMessage,
  };
}
