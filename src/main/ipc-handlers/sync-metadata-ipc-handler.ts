import type {
  ListSyncEntityMappingsOptions,
  SetSyncDomainStateInput,
  SyncScopeContext,
  SyncMetadataService,
  UpsertSyncEntityMappingInput,
} from '../sync/sync-metadata-service';
import type { SyncDomain, SyncEntityType } from '../../types/sync-contract';
import { createIpcHandler, createIpcVoidHandler } from './utils';

export function registerSyncMetadataHandlers(syncMetadataService: SyncMetadataService): void {
  createIpcHandler(
    'sync-metadata:upsert-entity-mapping',
    async (input: UpsertSyncEntityMappingInput, context?: SyncScopeContext) => {
      return await syncMetadataService.upsertEntityMapping(input, context);
    },
    'Failed to upsert sync entity mapping'
  );

  createIpcHandler(
    'sync-metadata:get-entity-mapping',
    async (domain: SyncDomain, entityType: SyncEntityType, localId: string, context?: SyncScopeContext) => {
      return await syncMetadataService.getEntityMapping(domain, entityType, localId, context);
    },
    'Failed to get sync entity mapping'
  );

  createIpcHandler(
    'sync-metadata:get-entity-mapping-by-global-uid',
    async (
      domain: SyncDomain,
      entityType: SyncEntityType,
      globalUid: string,
      context?: SyncScopeContext
    ) => {
      return await syncMetadataService.getEntityMappingByGlobalUid(domain, entityType, globalUid, context);
    },
    'Failed to get sync entity mapping by global UID'
  );

  createIpcHandler(
    'sync-metadata:list-entity-mappings',
    async (options?: ListSyncEntityMappingsOptions) => {
      return await syncMetadataService.listEntityMappings(options);
    },
    'Failed to list sync entity mappings'
  );

  createIpcVoidHandler(
    'sync-metadata:delete-entity-mapping',
    async (domain: SyncDomain, entityType: SyncEntityType, localId: string, context?: SyncScopeContext) => {
      await syncMetadataService.deleteEntityMapping(domain, entityType, localId, context);
    },
    'Failed to delete sync entity mapping'
  );

  createIpcHandler(
    'sync-metadata:set-domain-state',
    async (input: SetSyncDomainStateInput, context?: SyncScopeContext) => {
      return await syncMetadataService.setDomainState(input, context);
    },
    'Failed to set sync domain state'
  );

  createIpcHandler(
    'sync-metadata:get-domain-state',
    async (domain: SyncDomain, context?: SyncScopeContext) => {
      return await syncMetadataService.getDomainState(domain, context);
    },
    'Failed to get sync domain state'
  );

  createIpcHandler(
    'sync-metadata:list-domain-states',
    async (context?: SyncScopeContext) => {
      return await syncMetadataService.listDomainStates(context);
    },
    'Failed to list sync domain states'
  );

  createIpcVoidHandler(
    'sync-metadata:delete-domain-state',
    async (domain: SyncDomain, context?: SyncScopeContext) => {
      await syncMetadataService.deleteDomainState(domain, context);
    },
    'Failed to delete sync domain state'
  );

  console.log('[SyncMetadataIPC] Sync metadata handlers registered');
}
