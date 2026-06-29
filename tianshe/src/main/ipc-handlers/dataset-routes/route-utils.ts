import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import { handleIPCError } from '../../ipc-utils';
import { logDatasetRouteError } from './dataset-route-logger';

const DATASET_SCHEMA_UPDATED_CHANNEL = 'dataset:schema-updated';

export type DatasetRouteHandler = (
  event: IpcMainInvokeEvent,
  ...args: any[]
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function notifyDatasetSchemaUpdated(event: IpcMainInvokeEvent, datasetId: string): void {
  event.sender.send(DATASET_SCHEMA_UPDATED_CHANNEL, datasetId);
}

export function registerDatasetRoute(options: {
  channel: string;
  handler: DatasetRouteHandler;
  logError?: string;
}): void {
  ipcRouteRegistry.register({
    channel: options.channel,
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (event: IpcMainInvokeEvent, ...args: any[]) => {
      try {
        return await options.handler(event, ...args);
      } catch (error: unknown) {
        if (options.logError) {
          logDatasetRouteError(options.logError, error, { channel: options.channel });
        }
        return handleIPCError(error);
      }
    },
  });
}

export function registerSchemaMutationRoute(options: {
  channel: string;
  getDatasetId: (...args: any[]) => string;
  handler: DatasetRouteHandler;
  logError?: string;
}): void {
  registerDatasetRoute({
    channel: options.channel,
    logError: options.logError,
    handler: async (event, ...args) => {
      const result = await options.handler(event, ...args);
      notifyDatasetSchemaUpdated(event, options.getDatasetId(...args));
      return result;
    },
  });
}
