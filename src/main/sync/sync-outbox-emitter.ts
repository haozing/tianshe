import type { SyncOutboxService } from './sync-outbox-service';
import type { SyncDomain, SyncEntityType } from '../../types/sync-contract';
import { createLogger } from '../../core/logger';
import { getCurrentCloudSyncScopeKey } from '../cloud-sync/context';

const logger = createLogger('SyncOutboxEmitter');

interface EmitSyncOutboxOptions {
  syncOutboxService?: SyncOutboxService | null;
  domain: SyncDomain;
  entityType: SyncEntityType;
  localId: string;
  payload?: Record<string, unknown> | null;
  eventSource?: 'crud';
  idempotencyKey?: string;
  logSource?: string;
}

function normalizeNonEmpty(value: string): string {
  return String(value || '').trim();
}

export async function emitSyncOutboxUpsert(options: EmitSyncOutboxOptions): Promise<void> {
  const service = options.syncOutboxService;
  if (!service) return;

  const localId = normalizeNonEmpty(options.localId);
  if (!localId) return;

  try {
    await service.enqueue({
      scopeKey: getCurrentCloudSyncScopeKey(),
      domain: options.domain,
      entityType: options.entityType,
      localId,
      eventType: 'upsert',
      eventSource: options.eventSource || 'crud',
      payload: options.payload ?? null,
      idempotencyKey: normalizeNonEmpty(options.idempotencyKey || '') || undefined,
    });
  } catch (error) {
    logger.warn('Failed to enqueue sync outbox upsert event', {
      logSource: options.logSource || 'unknown',
      domain: options.domain,
      entityType: options.entityType,
      localId,
      error,
    });
  }
}

export async function emitSyncOutboxDelete(options: EmitSyncOutboxOptions): Promise<void> {
  const service = options.syncOutboxService;
  if (!service) return;

  const localId = normalizeNonEmpty(options.localId);
  if (!localId) return;

  try {
    await service.enqueue({
      scopeKey: getCurrentCloudSyncScopeKey(),
      domain: options.domain,
      entityType: options.entityType,
      localId,
      eventType: 'delete',
      eventSource: options.eventSource || 'crud',
      payload: options.payload ?? null,
      idempotencyKey: normalizeNonEmpty(options.idempotencyKey || '') || undefined,
    });
  } catch (error) {
    logger.warn('Failed to enqueue sync outbox delete event', {
      logSource: options.logSource || 'unknown',
      domain: options.domain,
      entityType: options.entityType,
      localId,
      error,
    });
  }
}
