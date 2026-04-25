import type {
  SyncOutboxEvent,
  SyncOutboxEventInput,
  SyncOutboxListPendingOptions,
  SyncOutboxService,
} from '../sync/sync-outbox-service';
import { createIpcHandler, createIpcVoidHandler } from './utils';

export function registerSyncOutboxHandlers(syncOutboxService: SyncOutboxService): void {
  createIpcHandler(
    'sync-outbox:enqueue',
    async (input: SyncOutboxEventInput): Promise<SyncOutboxEvent> => {
      return await syncOutboxService.enqueue(input);
    },
    'Failed to enqueue sync outbox event'
  );

  createIpcHandler(
    'sync-outbox:get',
    async (eventId: string): Promise<SyncOutboxEvent | null> => {
      return await syncOutboxService.get(eventId);
    },
    'Failed to get sync outbox event'
  );

  createIpcHandler(
    'sync-outbox:list-pending',
    async (
      limit?: number,
      nowMs?: number,
      options?: SyncOutboxListPendingOptions
    ): Promise<SyncOutboxEvent[]> => {
      return await syncOutboxService.listPending(limit, nowMs, options);
    },
    'Failed to list pending sync outbox events'
  );

  createIpcHandler(
    'sync-outbox:mark-processing',
    async (eventId: string): Promise<{ marked: boolean }> => {
      const marked = await syncOutboxService.markProcessing(eventId);
      return { marked };
    },
    'Failed to mark sync outbox event as processing'
  );

  createIpcVoidHandler(
    'sync-outbox:ack',
    async (eventId: string): Promise<void> => {
      await syncOutboxService.ack(eventId);
    },
    'Failed to ack sync outbox event'
  );

  createIpcVoidHandler(
    'sync-outbox:fail',
    async (eventId: string, errorMessage: string, retryDelayMs?: number): Promise<void> => {
      await syncOutboxService.fail(eventId, errorMessage, retryDelayMs);
    },
    'Failed to mark sync outbox event failed'
  );

  createIpcHandler(
    'sync-outbox:delete-acked',
    async (beforeUpdatedAtMs: number): Promise<{ deleted: number }> => {
      const deleted = await syncOutboxService.deleteAcked(beforeUpdatedAtMs);
      return { deleted };
    },
    'Failed to delete acked sync outbox events'
  );

  console.log('[SyncOutboxIPC] Sync outbox handlers registered');
}
