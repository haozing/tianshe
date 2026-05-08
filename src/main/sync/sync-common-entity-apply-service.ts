import type {
  CreateGroupParams,
  CreateSavedSiteParams,
  CreateTagParams,
  UpdateGroupParams,
  UpdateSavedSiteParams,
  UpdateTagParams,
} from '../../types/profile';
import type { ProfileGroupService } from '../duckdb/profile-group-service';
import type { SavedSiteService } from '../duckdb/saved-site-service';
import type { TagService } from '../duckdb/tag-service';
import type { SyncDomain, SyncPullChange } from '../../types/sync-contract';
import type { SyncLocalApplyResult } from './sync-local-apply-service';
import type { SyncApplyMappingResolver } from './sync-apply-mapping-resolver';
import {
  fallbackName,
  hasOwn,
  toNullableString,
  toOptionalString,
  toPayloadObject,
} from './sync-apply-normalizers';

export interface SyncCommonEntityApplyDeps {
  tagService: TagService;
  savedSiteService: SavedSiteService;
  profileGroupService: ProfileGroupService;
  mappingResolver: SyncApplyMappingResolver;
}

export class SyncCommonEntityApplyService {
  constructor(private readonly deps: SyncCommonEntityApplyDeps) {}

  async applyTag(domain: SyncDomain, change: SyncPullChange): Promise<SyncLocalApplyResult> {
    const mapping = await this.deps.mappingResolver.getByGlobalUid(
      domain,
      change.entityType,
      change.globalUid
    );

    if (change.deletedAt) {
      if (!mapping) {
        return { applied: false, skipped: true, reason: 'mapping_not_found_for_delete' };
      }
      try {
        await this.deps.tagService.delete(mapping.localId);
      } catch {
        // if local missing, still clear mapping
      }
      await this.deps.mappingResolver.delete(domain, change.entityType, mapping.localId);
      return { applied: true, skipped: false, localId: mapping.localId };
    }

    const payload = toPayloadObject(change.payload);
    const hasNameField = hasOwn(payload, 'name');
    const hasColorField = hasOwn(payload, 'color');
    const nameFromPayload = hasNameField ? toOptionalString(payload.name) : undefined;
    const color = hasColorField ? toNullableString(payload.color) : undefined;

    let localId = mapping?.localId;
    if (mapping) {
      const updates: UpdateTagParams = {
        ...(hasNameField && nameFromPayload ? { name: nameFromPayload } : {}),
        ...(color !== undefined ? { color } : {}),
      };
      try {
        const updated = await this.deps.tagService.update(mapping.localId, updates);
        localId = updated.id;
      } catch {
        localId = undefined;
      }
    }

    if (!localId) {
      const name = nameFromPayload || fallbackName('tag', change.globalUid);
      const created = await this.deps.tagService.create({
        name,
        ...(color !== undefined ? { color } : {}),
      } as CreateTagParams);
      localId = created.id;
    }

    await this.deps.mappingResolver.upsert({
      domain,
      entityType: change.entityType,
      localId,
      globalUid: change.globalUid,
      version: change.version,
      contentHash: change.contentHash || null,
      updatedAt: Date.now(),
    });

    return { applied: true, skipped: false, localId };
  }

  async applySavedSite(
    domain: SyncDomain,
    change: SyncPullChange
  ): Promise<SyncLocalApplyResult> {
    const mapping = await this.deps.mappingResolver.getByGlobalUid(
      domain,
      change.entityType,
      change.globalUid
    );

    if (change.deletedAt) {
      if (!mapping) {
        return { applied: false, skipped: true, reason: 'mapping_not_found_for_delete' };
      }
      try {
        await this.deps.savedSiteService.delete(mapping.localId);
      } catch {
        // ignore
      }
      await this.deps.mappingResolver.delete(domain, change.entityType, mapping.localId);
      return { applied: true, skipped: false, localId: mapping.localId };
    }

    const payload = toPayloadObject(change.payload);
    const hasNameField = hasOwn(payload, 'name');
    const hasUrlField = hasOwn(payload, 'url') || hasOwn(payload, 'loginUrl');
    const hasIconField = hasOwn(payload, 'icon');
    const nameFromPayload = hasNameField ? toOptionalString(payload.name) : undefined;
    const urlFromPayload =
      hasUrlField
        ? toOptionalString(payload.url) || toOptionalString(payload.loginUrl)
        : undefined;
    const icon = hasIconField ? toNullableString(payload.icon) : undefined;

    let localId = mapping?.localId;
    if (mapping) {
      const updates: UpdateSavedSiteParams = {
        ...(hasNameField && nameFromPayload ? { name: nameFromPayload } : {}),
        ...(hasUrlField && urlFromPayload ? { url: urlFromPayload } : {}),
        ...(icon !== undefined ? { icon } : {}),
      };
      try {
        const updated = await this.deps.savedSiteService.update(mapping.localId, updates);
        localId = updated.id;
      } catch {
        localId = undefined;
      }
    }

    if (!localId) {
      const name = nameFromPayload || fallbackName('site', change.globalUid);
      const url = urlFromPayload || `https://invalid.local/${change.globalUid}`;
      const created = await this.deps.savedSiteService.create({
        name,
        url,
        ...(icon !== undefined ? { icon } : {}),
      } as CreateSavedSiteParams);
      localId = created.id;
    }

    await this.deps.mappingResolver.upsert({
      domain,
      entityType: change.entityType,
      localId,
      globalUid: change.globalUid,
      version: change.version,
      contentHash: change.contentHash || null,
      updatedAt: Date.now(),
    });

    return { applied: true, skipped: false, localId };
  }

  async applyProfileGroup(
    domain: SyncDomain,
    change: SyncPullChange
  ): Promise<SyncLocalApplyResult> {
    const mapping = await this.deps.mappingResolver.getByGlobalUid(
      domain,
      change.entityType,
      change.globalUid
    );

    if (change.deletedAt) {
      if (!mapping) {
        return { applied: false, skipped: true, reason: 'mapping_not_found_for_delete' };
      }
      try {
        await this.deps.profileGroupService.delete(mapping.localId, { recursive: true });
      } catch {
        // ignore
      }
      await this.deps.mappingResolver.delete(domain, change.entityType, mapping.localId);
      return { applied: true, skipped: false, localId: mapping.localId };
    }

    const payload = toPayloadObject(change.payload);
    const hasNameField = hasOwn(payload, 'name');
    const hasParentField =
      hasOwn(payload, 'parentId') ||
      hasOwn(payload, 'parentGlobalUid') ||
      hasOwn(payload, 'parentGroupUid');
    const hasColorField = hasOwn(payload, 'color');
    const hasIconField = hasOwn(payload, 'icon');
    const hasDescriptionField = hasOwn(payload, 'description');
    const nameFromPayload = hasNameField ? toOptionalString(payload.name) : undefined;
    const parentId = hasParentField
      ? await this.resolveProfileGroupParentLocalId(payload)
      : undefined;
    const color = hasColorField ? toNullableString(payload.color) : undefined;
    const icon = hasIconField ? toNullableString(payload.icon) : undefined;
    const description = hasDescriptionField ? toNullableString(payload.description) : undefined;

    let localId = mapping?.localId;
    if (mapping) {
      const updates: UpdateGroupParams = {
        ...(hasNameField && nameFromPayload ? { name: nameFromPayload } : {}),
        ...(hasParentField && parentId !== undefined ? { parentId } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(description !== undefined ? { description } : {}),
      };
      try {
        const updated = await this.deps.profileGroupService.update(mapping.localId, updates);
        localId = updated.id;
      } catch {
        localId = undefined;
      }
    }

    if (!localId) {
      const name = nameFromPayload || fallbackName('group', change.globalUid);
      const created = await this.deps.profileGroupService.create({
        name,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(description !== undefined ? { description } : {}),
      } as CreateGroupParams);
      localId = created.id;
    }

    await this.deps.mappingResolver.upsert({
      domain,
      entityType: change.entityType,
      localId,
      globalUid: change.globalUid,
      version: change.version,
      contentHash: change.contentHash || null,
      updatedAt: Date.now(),
    });

    return { applied: true, skipped: false, localId };
  }

  private async resolveProfileGroupParentLocalId(
    payload: Record<string, unknown>
  ): Promise<string | null | undefined> {
    const direct = toNullableString(payload.parentId);
    if (direct !== undefined) return direct;

    const possibleGlobalUid =
      toOptionalString(payload.parentGlobalUid) || toOptionalString(payload.parentGroupUid);
    if (!possibleGlobalUid) return undefined;

    const mapping = await this.deps.mappingResolver.getByGlobalUid(
      'profile',
      'profileGroup',
      possibleGlobalUid
    );
    return mapping?.localId ?? null;
  }
}
