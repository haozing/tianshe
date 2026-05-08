import { IpcMainInvokeEvent } from 'electron';
import type { IpcErrorCode } from './errors';
import type { IpcRouteDefinition, IpcRoutePermission, IpcRouteSchema } from '../ipc-route-registry';
import { ipcRouteRegistry } from '../ipc-route-registry';
import { createIPCErrorResult } from '../ipc-utils';
import { createLogger } from '../../core/logger';
import type { StructuredError } from '../../types/error-codes';

export { IpcError, type IpcErrorCode } from './errors';

const logger = createLogger('IPCHandler');

export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: IpcErrorCode;
  errorDetails?: StructuredError;
}

export type IpcSenderGuard = (event: IpcMainInvokeEvent, channel: string) => void;

export interface IpcHandlerOptions {
  errorMessage?: string;
  senderGuard?: IpcSenderGuard;
  permission?: IpcRoutePermission;
  schema?: IpcRouteSchema;
}

function normalizeIpcHandlerOptions(
  errorMessageOrOptions?: string | IpcHandlerOptions,
  fallbackErrorMessage = '操作失败'
): Required<Pick<IpcHandlerOptions, 'errorMessage' | 'permission'>> &
  Pick<IpcHandlerOptions, 'senderGuard' | 'schema'> {
  if (typeof errorMessageOrOptions === 'string') {
    return { errorMessage: errorMessageOrOptions, permission: 'trusted-renderer' };
  }

  return {
    errorMessage: errorMessageOrOptions?.errorMessage || fallbackErrorMessage,
    senderGuard: errorMessageOrOptions?.senderGuard,
    permission: errorMessageOrOptions?.permission || 'trusted-renderer',
    schema: errorMessageOrOptions?.schema,
  };
}

function createErrorResponse(error: unknown, defaultMessage: string): IPCResponse<never> {
  const result = createIPCErrorResult(error, defaultMessage);
  return {
    success: false,
    error: result.userError,
    code: result.code,
    errorDetails: result.errorDetails,
  };
}

function createLoggedErrorResponse(
  channel: string,
  error: unknown,
  defaultMessage: string
): IPCResponse<never> {
  const result = createIPCErrorResult(error, defaultMessage);
  logger.error('IPC handler failed', {
    channel,
    code: result.code,
    error: result.logContext,
  });
  return {
    success: false,
    error: result.userError,
    code: result.code,
    errorDetails: result.errorDetails,
  };
}

export function createIpcHandler<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult>,
  errorMessageOrOptions: string | IpcHandlerOptions = '操作失败'
): IpcRouteDefinition {
  const options = normalizeIpcHandlerOptions(errorMessageOrOptions);
  const route: IpcRouteDefinition = {
    channel,
    kind: 'handle',
    permission: options.permission,
    ...(options.schema ? { schema: options.schema } : {}),
    handler: async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<IPCResponse<TResult>> => {
      try {
        options.senderGuard?.(event, channel);
        const result = await handler(...args);
        return { success: true, data: result };
      } catch (error) {
        return createLoggedErrorResponse(channel, error, options.errorMessage);
      }
    },
  };
  ipcRouteRegistry.register(route);
  return route;
}

export function createIpcVoidHandler<TArgs extends unknown[]>(
  channel: string,
  handler: (...args: TArgs) => Promise<void>,
  errorMessageOrOptions: string | IpcHandlerOptions = '操作失败'
): IpcRouteDefinition {
  const options = normalizeIpcHandlerOptions(errorMessageOrOptions);
  const route: IpcRouteDefinition = {
    channel,
    kind: 'handle',
    permission: options.permission,
    ...(options.schema ? { schema: options.schema } : {}),
    handler: async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<IPCResponse<void>> => {
      try {
        options.senderGuard?.(event, channel);
        await handler(...args);
        return { success: true };
      } catch (error) {
        return createLoggedErrorResponse(channel, error, options.errorMessage);
      }
    },
  };
  ipcRouteRegistry.register(route);
  return route;
}

export function registerIpcHandlers(
  handlers: Array<{
    channel: string;
    handler: (...args: any[]) => Promise<any>;
    errorMsg?: string;
    isVoid?: boolean;
    senderGuard?: IpcSenderGuard;
    permission?: IpcRoutePermission;
    schema?: IpcRouteSchema;
  }>
): void {
  const routes: IpcRouteDefinition[] = [];
  for (const { channel, handler, errorMsg, isVoid, senderGuard, permission, schema } of handlers) {
    const options = { errorMessage: errorMsg, senderGuard, permission, schema };
    if (isVoid) {
      routes.push(createIpcVoidHandler(channel, handler, options));
    } else {
      routes.push(createIpcHandler(channel, handler, options));
    }
  }
}

export function handleIPCError(
  error: unknown,
  defaultMessage: string = '操作失败'
): IPCResponse<never> {
  return createErrorResponse(error, defaultMessage);
}
