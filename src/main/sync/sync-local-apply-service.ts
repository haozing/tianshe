import { UNBOUND_PROFILE_ID } from '../../types/profile';
import type {
  CreateAccountParams,
  CreateProfileParams,
  UpdateAccountParams,
  UpdateProfileParams,
} from '../../types/profile';
import type { AccountService } from '../duckdb/account-service';
import type { ProfileGroupService } from '../duckdb/profile-group-service';
import type { ProfileService } from '../duckdb/profile-service';
import type { SavedSiteService } from '../duckdb/saved-site-service';
import type { TagService } from '../duckdb/tag-service';
import type { ExtensionPackagesManager } from '../profile/extension-packages-manager';
import type { SyncEntityMapping, SyncMetadataService } from './sync-metadata-service';
import type { SyncDomain, SyncPullChange } from '../../types/sync-contract';
import {
  DEFAULT_SCOPE_KEY,
  fallbackName,
  hasOwn,
  normalizeProfileEngine,
  normalizeScopeKey,
  toNullableString,
  toOptionalBoolean,
  toOptionalNumber,
  toOptionalString,
  toPayloadObject,
  toStringArray,
} from './sync-apply-normalizers';
import { SyncApplyMappingResolver } from './sync-apply-mapping-resolver';
import { SyncCommonEntityApplyService } from './sync-common-entity-apply-service';

interface SyncLocalApplyDeps {
  metadataService: SyncMetadataService;
  accountService: AccountService;
  savedSiteService: SavedSiteService;
  tagService: TagService;
  profileService: ProfileService;
  profileGroupService: ProfileGroupService;
  extensionManager?: ExtensionPackagesManager;
}

export interface SyncLocalApplyResult {
  applied: boolean;
  skipped: boolean;
  localId?: string;
  reason?: string;
}

interface SyncLocalApplyOptions {
  scopeKey?: string;
}

export class SyncLocalApplyService {
  private activeScopeKey = DEFAULT_SCOPE_KEY;
  private readonly mappingResolver: SyncApplyMappingResolver;
  private readonly commonEntityApply: SyncCommonEntityApplyService;

  constructor(private readonly deps: SyncLocalApplyDeps) {
    this.mappingResolver = new SyncApplyMappingResolver({
      metadataService: deps.metadataService,
      getScopeKey: () => this.activeScopeKey,
    });
    this.commonEntityApply = new SyncCommonEntityApplyService({
      tagService: deps.tagService,
      savedSiteService: deps.savedSiteService,
      profileGroupService: deps.profileGroupService,
      mappingResolver: this.mappingResolver,
    });
  }

  async applyChange(
    domain: SyncDomain,
    change: SyncPullChange,
    options?: SyncLocalApplyOptions
  ): Promise<SyncLocalApplyResult> {
    return this.withScope(options?.scopeKey, async () => {
      switch (domain) {
        case 'account':
          switch (change.entityType) {
            case 'account':
              return this.applyAccount(domain, change);
            case 'savedSite':
              return this.commonEntityApply.applySavedSite(domain, change);
            case 'tag':
              return this.commonEntityApply.applyTag(domain, change);
            default:
              return {
                applied: false,
                skipped: true,
                reason: `unsupported_entity_type:${domain}:${change.entityType}`,
              };
          }
        case 'profile':
          switch (change.entityType) {
            case 'profile':
              return this.applyProfile(domain, change);
            case 'profileGroup':
              return this.commonEntityApply.applyProfileGroup(domain, change);
            default:
              return {
                applied: false,
                skipped: true,
                reason: `unsupported_entity_type:${domain}:${change.entityType}`,
              };
          }
        case 'extension':
          switch (change.entityType) {
            case 'extensionPackage':
              return this.applyExtensionPackage(domain, change);
            case 'profileExtensionBinding':
              return this.applyProfileExtensionBinding(domain, change);
            default:
              return {
                applied: false,
                skipped: true,
                reason: `unsupported_entity_type:${domain}:${change.entityType}`,
              };
          }
        default:
          return {
            applied: false,
            skipped: true,
            reason: `unsupported_domain:${domain}`,
          };
      }
    });
  }

  private async applyAccount(
    domain: SyncDomain,
    change: SyncPullChange
  ): Promise<SyncLocalApplyResult> {
    const mapping = await this.mappingResolver.getByGlobalUid(
      domain,
      change.entityType,
      change.globalUid
    );

    if (change.deletedAt) {
      if (!mapping) {
        return { applied: false, skipped: true, reason: 'mapping_not_found_for_delete' };
      }
      try {
        await this.deps.accountService.delete(mapping.localId, { allowSharedMutation: true });
      } catch {
        // ignore
      }
      await this.mappingResolver.delete(domain, change.entityType, mapping.localId);
      return { applied: true, skipped: false, localId: mapping.localId };
    }

    const payload = toPayloadObject(change.payload);
    const hasNameField = hasOwn(payload, 'name');
    const hasDisplayNameField = hasOwn(payload, 'displayName');
    const hasLoginUrlField = hasOwn(payload, 'loginUrl') || hasOwn(payload, 'url');
    const hasSiteNameField = hasOwn(payload, 'siteName');
    const hasShopIdField = hasOwn(payload, 'shopId');
    const hasShopNameField = hasOwn(payload, 'shopName');
    const hasPasswordField = hasOwn(payload, 'password');
    const hasNotesField = hasOwn(payload, 'notes');
    const hasTagsField = hasOwn(payload, 'tags');
    const hasProfileField =
      hasOwn(payload, 'profileId') ||
      hasOwn(payload, 'profileGlobalUid') ||
      hasOwn(payload, 'profileUid') ||
      hasOwn(payload, 'profileCloudUid');
    const hasPlatformField =
      hasOwn(payload, 'platformId') ||
      hasOwn(payload, 'platformGlobalUid') ||
      hasOwn(payload, 'platformUid') ||
      hasOwn(payload, 'savedSiteGlobalUid');

    const nameFromPayload = hasNameField ? toOptionalString(payload.name) : undefined;
    const displayName = hasDisplayNameField ? toNullableString(payload.displayName) : undefined;
    const loginUrlFromPayload =
      hasLoginUrlField
        ? toOptionalString(payload.loginUrl) || toOptionalString(payload.url)
        : undefined;
    const legacySiteName = hasSiteNameField ? toNullableString(payload.siteName) : undefined;
    const shopId = hasShopIdField ? toNullableString(payload.shopId) : undefined;
    const shopName = hasShopNameField ? toNullableString(payload.shopName) : undefined;
    const password = hasPasswordField ? toNullableString(payload.password) : undefined;
    const notes = hasNotesField ? toNullableString(payload.notes) : undefined;
    const tags = hasTagsField ? toStringArray(payload.tags) : undefined;
    const profileId = hasProfileField
      ? await this.resolveProfileLocalIdFromPayload(payload)
      : undefined;
    const platformId =
      hasPlatformField || legacySiteName !== undefined
        ? await this.resolveSavedSiteLocalIdFromPayload(payload, legacySiteName)
        : undefined;

    let localId = mapping?.localId;
    if (mapping) {
      const updates: UpdateAccountParams = {
        ...(hasNameField && nameFromPayload ? { name: nameFromPayload } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(hasLoginUrlField && loginUrlFromPayload ? { loginUrl: loginUrlFromPayload } : {}),
        ...(hasProfileField && profileId ? { profileId } : {}),
        ...(platformId !== undefined ? { platformId } : {}),
        ...(shopId !== undefined ? { shopId } : {}),
        ...(shopName !== undefined ? { shopName } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(tags ? { tags } : {}),
      };
      try {
        const updated = await this.deps.accountService.update(mapping.localId, updates, {
          allowSharedMutation: true,
        });
        localId = updated.id;
      } catch {
        localId = undefined;
      }
    }

    if (!localId) {
      const name = nameFromPayload || fallbackName('account', change.globalUid);
      const loginUrl = loginUrlFromPayload || 'about:blank';
      const created = await this.deps.accountService.create({
        name,
        ...(displayName !== undefined ? { displayName } : {}),
        loginUrl,
        profileId: profileId || UNBOUND_PROFILE_ID,
        ...(platformId !== undefined ? { platformId } : {}),
        ...(shopId !== undefined ? { shopId } : {}),
        ...(shopName !== undefined ? { shopName } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(tags ? { tags } : {}),
      } as CreateAccountParams);
      localId = created.id;
    }

    await this.mappingResolver.upsert({
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

  private async applyProfile(
    domain: SyncDomain,
    change: SyncPullChange
  ): Promise<SyncLocalApplyResult> {
    const mapping = await this.mappingResolver.getByGlobalUid(
      domain,
      change.entityType,
      change.globalUid
    );

    if (change.deletedAt) {
      if (!mapping) {
        return { applied: false, skipped: true, reason: 'mapping_not_found_for_delete' };
      }
      try {
        await this.deps.profileService.deleteWithCascade(mapping.localId);
      } catch {
        // ignore
      }
      await this.mappingResolver.delete(domain, change.entityType, mapping.localId);
      return { applied: true, skipped: false, localId: mapping.localId };
    }

    const payload = toPayloadObject(change.payload);
    const hasNameField = hasOwn(payload, 'name');
    const hasEngineField = hasOwn(payload, 'engine');
    const hasGroupField =
      hasOwn(payload, 'groupId') || hasOwn(payload, 'groupGlobalUid') || hasOwn(payload, 'groupUid');
    const hasNotesField = hasOwn(payload, 'notes');
    const hasTagsField = hasOwn(payload, 'tags');
    const hasColorField = hasOwn(payload, 'color');
    const hasQuotaField = hasOwn(payload, 'quota');
    const hasIdleTimeoutField = hasOwn(payload, 'idleTimeoutMs');
    const hasLockTimeoutField = hasOwn(payload, 'lockTimeoutMs');

    const nameFromPayload = hasNameField ? toOptionalString(payload.name) : undefined;
    const engineRaw = hasEngineField ? toOptionalString(payload.engine) : undefined;
    const engine = normalizeProfileEngine(engineRaw);
    const groupId = hasGroupField
      ? await this.resolveProfileGroupLocalIdFromPayload(payload)
      : undefined;
    const notes = hasNotesField ? toNullableString(payload.notes) : undefined;
    const tags = hasTagsField ? toStringArray(payload.tags) : undefined;
    const color = hasColorField ? toNullableString(payload.color) : undefined;
    const quota = hasQuotaField ? toOptionalNumber(payload.quota) : undefined;
    const idleTimeoutMs = hasIdleTimeoutField ? toOptionalNumber(payload.idleTimeoutMs) : undefined;
    const lockTimeoutMs = hasLockTimeoutField ? toOptionalNumber(payload.lockTimeoutMs) : undefined;

    let localId = mapping?.localId;
    if (mapping) {
      const updates: UpdateProfileParams = {
        ...(hasNameField && nameFromPayload ? { name: nameFromPayload } : {}),
        ...(hasEngineField && engine ? { engine } : {}),
        ...(hasGroupField && groupId !== undefined ? { groupId } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(tags ? { tags } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(quota !== undefined ? { quota } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
      };
      try {
        const updated = await this.deps.profileService.update(mapping.localId, updates);
        localId = updated.id;
      } catch {
        localId = undefined;
      }
    }

    if (!localId) {
      const name = nameFromPayload || fallbackName('profile', change.globalUid);
      const created = await this.deps.profileService.create({
        name,
        ...(engine ? { engine } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(tags ? { tags } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(quota !== undefined ? { quota } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
      } as CreateProfileParams);
      localId = created.id;
    }

    await this.mappingResolver.upsert({
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

  private async applyExtensionPackage(
    domain: SyncDomain,
    change: SyncPullChange
  ): Promise<SyncLocalApplyResult> {
    const extensionManager = this.deps.extensionManager;
    if (!extensionManager) {
      return {
        applied: false,
        skipped: true,
        reason: 'extension_manager_missing',
      };
    }

    const mapping = await this.mappingResolver.getByGlobalUid(
      domain,
      change.entityType,
      change.globalUid
    );

    if (change.deletedAt) {
      const payload = toPayloadObject(change.payload);
      const extensionId = await this.resolveExtensionIdForExtensionPackageDelete(
        payload,
        mapping,
        extensionManager
      );

      if (extensionId) {
        const profiles = await this.deps.profileService.list();
        const profileIds = Array.from(
          new Set(
            profiles
              .map((profile) => String(profile.id || '').trim())
              .filter((profileId) => profileId.length > 0)
          )
        );

        if (profileIds.length > 0) {
          await extensionManager.unbindExtensionsFromProfiles({
            profileIds,
            extensionIds: [extensionId],
            removePackageWhenUnused: true,
          });
        }
        await extensionManager.pruneUnusedPackagesByExtensionIds([extensionId]);

        const bindingMappings = await this.mappingResolver.listAll({
          domain,
          entityType: 'profileExtensionBinding',
        });
        for (const binding of bindingMappings) {
          const bindingExtensionId = this.resolveExtensionIdFromBindingLocalId(binding.localId);
          if (bindingExtensionId !== extensionId) continue;
          await this.mappingResolver.delete(
            domain,
            'profileExtensionBinding',
            binding.localId
          );
        }
      }

      if (mapping) {
        await this.mappingResolver.delete(domain, change.entityType, mapping.localId);
      }
      return {
        applied: true,
        skipped: false,
        localId: mapping?.localId,
        ...(extensionId ? {} : { reason: 'extension_id_missing_for_delete_cleanup_partial' }),
      };
    }

    const payload = toPayloadObject(change.payload);
    const extensionId =
      toOptionalString(payload.extensionId) ||
      toOptionalString(payload.pluginCode) ||
      toOptionalString(payload.id);
    if (!extensionId) {
      return {
        applied: false,
        skipped: true,
        reason: 'extension_id_missing',
      };
    }

    const version = toOptionalString(payload.version);
    const downloadUrl = toOptionalString(payload.downloadUrl) || toOptionalString(payload.sourceUrl);
    const archiveBase64 = toOptionalString(payload.archiveBase64);
    const archiveSha256 = toOptionalString(payload.archiveSha256);
    const name = toOptionalString(payload.name) || fallbackName('extension', change.globalUid);

    let localId = mapping?.localId;
    if (downloadUrl) {
      const downloaded = await extensionManager.downloadCloudPackages([
        {
          extensionId,
          ...(version ? { version } : {}),
          downloadUrl,
          ...(archiveSha256 ? { archiveSha256 } : {}),
          ...(name ? { name } : {}),
        },
      ]);
      localId = downloaded[0]?.id || localId;
    } else if (archiveBase64) {
      const installed = await extensionManager.installCloudPackageFromInlineArchive({
        extensionId,
        ...(version ? { version } : {}),
        archiveBase64,
        ...(archiveSha256 ? { archiveSha256 } : {}),
        ...(name ? { name } : {}),
      });
      localId = installed.id || localId;
    } else if (!localId) {
      const packages = await extensionManager.listPackages();
      const matched = packages.find((item) => {
        if (item.extensionId !== extensionId) return false;
        if (!version) return true;
        return item.version === version;
      });
      localId = matched?.id || localId;
      if (!localId) {
        return {
          applied: false,
          skipped: true,
          reason: 'extension_package_source_missing',
        };
      }
    }
    const resolvedLocalId = localId || mapping?.localId;
    if (!resolvedLocalId) {
      return {
        applied: false,
        skipped: true,
        reason: 'extension_package_local_id_missing',
      };
    }

    await this.mappingResolver.upsert({
      domain,
      entityType: change.entityType,
      localId: resolvedLocalId,
      globalUid: change.globalUid,
      version: change.version,
      contentHash: change.contentHash || null,
      updatedAt: Date.now(),
    });

    return { applied: true, skipped: false, localId: resolvedLocalId };
  }

  private async applyProfileExtensionBinding(
    domain: SyncDomain,
    change: SyncPullChange
  ): Promise<SyncLocalApplyResult> {
    const extensionManager = this.deps.extensionManager;
    if (!extensionManager) {
      return {
        applied: false,
        skipped: true,
        reason: 'extension_manager_missing',
      };
    }

    const mapping = await this.mappingResolver.getByGlobalUid(
      domain,
      change.entityType,
      change.globalUid
    );
    const payload = toPayloadObject(change.payload);

    const profileLocalId =
      (await this.resolveProfileLocalIdFromPayload(payload)) || this.resolveProfileIdFromBindingLocalId(mapping?.localId);
    const extensionId =
      toOptionalString(payload.extensionId) ||
      toOptionalString(payload.pluginCode) ||
      this.resolveExtensionIdFromBindingLocalId(mapping?.localId);
    const localBindingId =
      profileLocalId && extensionId ? `${profileLocalId}:${extensionId}` : mapping?.localId;

    if (change.deletedAt) {
      if (profileLocalId && extensionId) {
        await extensionManager.unbindExtensionsFromProfiles({
          profileIds: [profileLocalId],
          extensionIds: [extensionId],
          removePackageWhenUnused: false,
        });
      }
      if (localBindingId) {
        await this.mappingResolver.delete(domain, change.entityType, localBindingId);
      }
      return { applied: true, skipped: false, localId: localBindingId };
    }

    if (!profileLocalId || !extensionId) {
      return {
        applied: false,
        skipped: true,
        reason: 'binding_profile_or_extension_missing',
      };
    }

    const existingBinding = await this.findProfileExtensionBinding(
      profileLocalId,
      extensionId,
      extensionManager
    );

    const hasVersionField = hasOwn(payload, 'version');
    const hasInstallModeField = hasOwn(payload, 'installMode');
    const hasSortOrderField = hasOwn(payload, 'sortOrder');
    const hasEnabledField = hasOwn(payload, 'enabled');

    const versionFromPayload = hasVersionField ? toNullableString(payload.version) : undefined;
    const installModeFromPayload =
      toOptionalString(payload.installMode) === 'optional' ? 'optional' : 'required';
    const sortOrderFromPayload = hasSortOrderField ? toOptionalNumber(payload.sortOrder) : undefined;
    const enabledFromPayload = hasEnabledField ? toOptionalBoolean(payload.enabled) : undefined;

    const version =
      hasVersionField
        ? versionFromPayload !== undefined
          ? versionFromPayload
          : existingBinding?.version
        : existingBinding?.version;
    const installMode = hasInstallModeField
      ? installModeFromPayload
      : existingBinding?.installMode || 'required';
    const sortOrder = hasSortOrderField
      ? sortOrderFromPayload ?? existingBinding?.sortOrder ?? 0
      : existingBinding?.sortOrder ?? 0;
    const enabled = hasEnabledField
      ? enabledFromPayload ?? existingBinding?.enabled
      : existingBinding?.enabled;

    const downloadUrl = toOptionalString(payload.downloadUrl) || toOptionalString(payload.sourceUrl);
    const archiveBase64 = toOptionalString(payload.archiveBase64);
    const archiveSha256 = toOptionalString(payload.archiveSha256);
    const name = toOptionalString(payload.name);

    if (downloadUrl) {
      await extensionManager.downloadCloudPackages([
        {
          extensionId,
          ...(version ? { version } : {}),
          downloadUrl,
          ...(archiveSha256 ? { archiveSha256 } : {}),
          ...(name ? { name } : {}),
        },
      ]);
    } else if (archiveBase64) {
      await extensionManager.installCloudPackageFromInlineArchive({
        extensionId,
        ...(version ? { version } : {}),
        archiveBase64,
        ...(archiveSha256 ? { archiveSha256 } : {}),
        ...(name ? { name } : {}),
      });
    }

    await extensionManager.bindPackagesToProfiles({
      profileIds: [profileLocalId],
      packages: [
        {
          extensionId,
          ...(version !== undefined ? { version } : {}),
          installMode,
          sortOrder,
          ...(enabled !== undefined ? { enabled } : {}),
        },
      ],
    });
    const resolvedLocalBindingId = localBindingId || `${profileLocalId}:${extensionId}`;

    await this.mappingResolver.upsert({
      domain,
      entityType: change.entityType,
      localId: resolvedLocalBindingId,
      globalUid: change.globalUid,
      version: change.version,
      contentHash: change.contentHash || null,
      updatedAt: Date.now(),
    });

    return { applied: true, skipped: false, localId: resolvedLocalBindingId };
  }

  private resolveProfileIdFromBindingLocalId(localId: string | undefined): string | undefined {
    const normalized = toOptionalString(localId);
    if (!normalized) return undefined;
    const index = normalized.indexOf(':');
    if (index <= 0) return undefined;
    return normalized.slice(0, index);
  }

  private resolveExtensionIdFromBindingLocalId(localId: string | undefined): string | undefined {
    const normalized = toOptionalString(localId);
    if (!normalized) return undefined;
    const index = normalized.indexOf(':');
    if (index <= 0 || index >= normalized.length - 1) return undefined;
    return normalized.slice(index + 1);
  }

  private isLikelyExtensionId(value: string): boolean {
    return /^[a-z]{32}$/.test(value);
  }

  private async resolveExtensionIdForExtensionPackageDelete(
    payload: Record<string, unknown>,
    mapping: SyncEntityMapping | null,
    extensionManager: ExtensionPackagesManager
  ): Promise<string | undefined> {
    const fromPayload =
      toOptionalString(payload.extensionId) ||
      toOptionalString(payload.pluginCode) ||
      toOptionalString(payload.id);
    if (fromPayload) return fromPayload;

    const mappingLocalId = toOptionalString(mapping?.localId);
    if (!mappingLocalId) return undefined;

    const packages = await extensionManager.listPackages();
    const fromPackageId = packages.find((pkg) => pkg.id === mappingLocalId);
    if (fromPackageId?.extensionId) return fromPackageId.extensionId;

    const fromExtensionId = packages.find((pkg) => pkg.extensionId === mappingLocalId);
    if (fromExtensionId?.extensionId) return fromExtensionId.extensionId;

    return this.isLikelyExtensionId(mappingLocalId) ? mappingLocalId : undefined;
  }

  private async withScope<T>(scopeKey: string | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = this.activeScopeKey;
    this.activeScopeKey = normalizeScopeKey(scopeKey);
    try {
      return await fn();
    } finally {
      this.activeScopeKey = previous;
    }
  }

  private async findProfileExtensionBinding(
    profileLocalId: string,
    extensionId: string,
    extensionManager: ExtensionPackagesManager
  ): Promise<{
    version?: string | null;
    installMode: 'required' | 'optional';
    sortOrder: number;
    enabled: boolean;
  } | null> {
    try {
      const bindings = await extensionManager.listProfileBindings(profileLocalId);
      const matched = bindings.find((binding) => {
        const currentExtensionId = toOptionalString(binding.extensionId);
        return currentExtensionId === extensionId;
      });
      if (!matched) return null;
      return {
        version: matched.version ?? null,
        installMode: matched.installMode === 'optional' ? 'optional' : 'required',
        sortOrder: Number.isFinite(matched.sortOrder) ? Math.trunc(matched.sortOrder) : 0,
        enabled: matched.enabled !== false,
      };
    } catch {
      return null;
    }
  }

  private async resolveProfileLocalIdFromPayload(
    payload: Record<string, unknown>
  ): Promise<string | undefined> {
    const direct = toOptionalString(payload.profileId);
    if (direct && direct !== UNBOUND_PROFILE_ID) return direct;

    const profileCloudUid =
      toOptionalString(payload.profileCloudUid) || toOptionalString(payload.profileGlobalUid);
    if (profileCloudUid) {
      const scopedMapping = await this.mappingResolver.getByGlobalUid(
        'profile',
        'profile',
        profileCloudUid
      );
      if (scopedMapping?.localId) {
        return scopedMapping.localId;
      }

      const anyScopeMapping = await this.mappingResolver.getByGlobalUidAnyScope(
        'profile',
        'profile',
        profileCloudUid
      );
      if (anyScopeMapping?.localId) {
        return anyScopeMapping.localId;
      }
    }

    const profileUid = toOptionalString(payload.profileUid);
    if (!profileUid) return undefined;

    const anyScopeByProfileUid = await this.mappingResolver.getByRemoteUidAnyScope(
      'profile',
      'profile',
      profileUid
    );
    return anyScopeByProfileUid?.localId;
  }

  private async resolveSavedSiteLocalIdFromPayload(
    payload: Record<string, unknown>,
    legacySiteName?: string | null
  ): Promise<string | null | undefined> {
    const direct = toNullableString(payload.platformId);
    if (direct !== undefined) return direct;

    const possibleGlobalUid =
      toOptionalString(payload.platformGlobalUid) ||
      toOptionalString(payload.platformUid) ||
      toOptionalString(payload.savedSiteGlobalUid);
    if (!possibleGlobalUid) return undefined;

    const mapping = await this.mappingResolver.getByGlobalUid(
      'account',
      'savedSite',
      possibleGlobalUid
    );
    if (mapping) {
      return mapping.localId;
    }

    if (possibleGlobalUid) {
      return null;
    }

    const normalizedLegacySiteName = String(legacySiteName || '').trim();
    if (normalizedLegacySiteName) {
      const site = await this.deps.savedSiteService.getByName(normalizedLegacySiteName);
      return site?.id ?? null;
    }

    if (legacySiteName === null) {
      return null;
    }

    return undefined;
  }

  private async resolveProfileGroupLocalIdFromPayload(
    payload: Record<string, unknown>
  ): Promise<string | null | undefined> {
    const direct = toNullableString(payload.groupId);
    if (direct !== undefined) return direct;

    const possibleGlobalUid =
      toOptionalString(payload.groupGlobalUid) || toOptionalString(payload.groupUid);
    if (!possibleGlobalUid) return undefined;

    const mapping = await this.mappingResolver.getByGlobalUid(
      'profile',
      'profileGroup',
      possibleGlobalUid
    );
    return mapping?.localId ?? null;
  }

}
