import type { SyncDomain, SyncEntityType } from '../../types/sync-contract';
import type {
  ListSyncEntityMappingsOptions,
  SyncEntityMapping,
  SyncMetadataService,
  SyncScopeContext,
} from './sync-metadata-service';

export interface SyncApplyMappingResolverDeps {
  metadataService: SyncMetadataService;
  getScopeKey: () => string;
}

export class SyncApplyMappingResolver {
  constructor(private readonly deps: SyncApplyMappingResolverDeps) {}

  getScopeContext(): SyncScopeContext {
    return {
      scopeKey: this.deps.getScopeKey(),
    };
  }

  async getByGlobalUid(
    domain: SyncDomain,
    entityType: SyncEntityType,
    globalUid: string
  ): Promise<SyncEntityMapping | null> {
    return this.deps.metadataService.getEntityMappingByGlobalUid(
      domain,
      entityType,
      globalUid,
      this.getScopeContext()
    );
  }

  async getByGlobalUidAnyScope(
    domain: SyncDomain,
    entityType: SyncEntityType,
    globalUid: string
  ): Promise<SyncEntityMapping | null> {
    return this.deps.metadataService.getEntityMappingByGlobalUidAnyScope(
      domain,
      entityType,
      globalUid
    );
  }

  async getByRemoteUidAnyScope(
    domain: SyncDomain,
    entityType: SyncEntityType,
    remoteUid: string
  ): Promise<SyncEntityMapping | null> {
    return this.deps.metadataService.getEntityMappingByRemoteUidAnyScope(
      domain,
      entityType,
      remoteUid
    );
  }

  async get(
    domain: SyncDomain,
    entityType: SyncEntityType,
    localId: string
  ): Promise<SyncEntityMapping | null> {
    return this.deps.metadataService.getEntityMapping(
      domain,
      entityType,
      localId,
      this.getScopeContext()
    );
  }

  async delete(domain: SyncDomain, entityType: SyncEntityType, localId: string): Promise<void> {
    await this.deps.metadataService.deleteEntityMapping(
      domain,
      entityType,
      localId,
      this.getScopeContext()
    );
  }

  async upsert(
    input: Parameters<SyncMetadataService['upsertEntityMapping']>[0]
  ): Promise<SyncEntityMapping> {
    return this.deps.metadataService.upsertEntityMapping(input, this.getScopeContext());
  }

  async list(options: ListSyncEntityMappingsOptions): Promise<SyncEntityMapping[]> {
    return this.deps.metadataService.listEntityMappings({
      ...options,
      scopeKey: this.deps.getScopeKey(),
    });
  }

  async listAll(options: {
    domain: SyncDomain;
    entityType: SyncEntityType;
  }): Promise<SyncEntityMapping[]> {
    const pageSize = 500;
    let offset = 0;
    const out: SyncEntityMapping[] = [];

    while (true) {
      const page = await this.list({
        ...options,
        limit: pageSize,
        offset,
      });
      if (page.length === 0) {
        break;
      }
      out.push(...page);
      if (page.length < pageSize) {
        break;
      }
      offset += page.length;
    }

    return out;
  }
}
