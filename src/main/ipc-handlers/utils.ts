import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IpcError, type IpcErrorCode } from './errors';

export { IpcError, type IpcErrorCode } from './errors';

export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: IpcErrorCode;
}

export type IpcSenderGuard = (event: IpcMainInvokeEvent, channel: string) => void;

export interface IpcHandlerOptions {
  errorMessage?: string;
  senderGuard?: IpcSenderGuard;
}

function normalizeIpcHandlerOptions(
  errorMessageOrOptions?: string | IpcHandlerOptions,
  fallbackErrorMessage = '操作失败'
): Required<Pick<IpcHandlerOptions, 'errorMessage'>> & Pick<IpcHandlerOptions, 'senderGuard'> {
  if (typeof errorMessageOrOptions === 'string') {
    return { errorMessage: errorMessageOrOptions };
  }

  return {
    errorMessage: errorMessageOrOptions?.errorMessage || fallbackErrorMessage,
    senderGuard: errorMessageOrOptions?.senderGuard,
  };
}

export function createIpcHandler<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult>,
  errorMessageOrOptions: string | IpcHandlerOptions = '操作失败'
): void {
  const options = normalizeIpcHandlerOptions(errorMessageOrOptions);
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<IPCResponse<TResult>> => {
      try {
        options.senderGuard?.(event, channel);
        const result = await handler(...args);
        return { success: true, data: result };
      } catch (error) {
        console.error(`[IPC] ${channel} error:`, error);
        if (error instanceof IpcError) {
          return {
            success: false,
            error: error.message,
            code: error.code,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : options.errorMessage,
        };
      }
    }
  );
}

export function createIpcVoidHandler<TArgs extends unknown[]>(
  channel: string,
  handler: (...args: TArgs) => Promise<void>,
  errorMessageOrOptions: string | IpcHandlerOptions = '操作失败'
): void {
  const options = normalizeIpcHandlerOptions(errorMessageOrOptions);
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<IPCResponse<void>> => {
      try {
        options.senderGuard?.(event, channel);
        await handler(...args);
        return { success: true };
      } catch (error) {
        console.error(`[IPC] ${channel} error:`, error);
        if (error instanceof IpcError) {
          return {
            success: false,
            error: error.message,
            code: error.code,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : options.errorMessage,
        };
      }
    }
  );
}

export function registerIpcHandlers(
  handlers: Array<{
    channel: string;
    handler: (...args: any[]) => Promise<any>;
    errorMsg?: string;
    isVoid?: boolean;
    senderGuard?: IpcSenderGuard;
  }>
): void {
  for (const { channel, handler, errorMsg, isVoid, senderGuard } of handlers) {
    const options = { errorMessage: errorMsg, senderGuard };
    if (isVoid) {
      createIpcVoidHandler(channel, handler, options);
    } else {
      createIpcHandler(channel, handler, options);
    }
  }
}

export function handleIPCError(
  error: unknown,
  defaultMessage: string = '操作失败'
): IPCResponse<never> {
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
