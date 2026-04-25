import { describe, expect, it, vi } from 'vitest';
import { SyncLocalApplyService } from './sync-local-apply-service';
import type { SyncPullChange } from '../../types/sync-contract';

function createBaseDeps() {
  return {
    metadataService: {
      getEntityMappingByGlobalUid: vi.fn(),
      getEntityMappingByGlobalUidAnyScope: vi.fn(),
      getEntityMappingByRemoteUidAnyScope: vi.fn(),
      upsertEntityMapping: vi.fn().mockResolvedValue(undefined),
      deleteEntityMapping: vi.fn().mockResolvedValue(undefined),
      listEntityMappings: vi.fn().mockResolvedValue([]),
    },
    accountService: {
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    savedSiteService: {
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      getByName: vi.fn(),
    },
    tagService: {
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    profileService: {
      update: vi.fn(),
      create: vi.fn(),
      deleteWithCascade: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
    },
    profileGroupService: {
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    extensionManager: {
      listProfileBindings: vi.fn().mockResolvedValue([]),
      bindPackagesToProfiles: vi.fn().mockResolvedValue(undefined),
      unbindExtensionsFromProfiles: vi.fn().mockResolvedValue({
        removedBindings: 0,
        removedPackages: [],
      }),
      downloadCloudPackages: vi.fn().mockResolvedValue([]),
      installCloudPackageFromInlineArchive: vi.fn(),
      listPackages: vi.fn().mockResolvedValue([]),
      pruneUnusedPackagesByExtensionIds: vi.fn().mockResolvedValue([]),
    },
  };
}

function createChange(entityType: SyncPullChange['entityType'], payload: Record<string, unknown>) {
  return {
    entityType,
    globalUid: `global-${entityType}-1`,
    version: 3,
    payload,
  } as SyncPullChange;
}

describe('SyncLocalApplyService domain routing', () => {
  it('applies account-domain tag changes locally', async () => {
    const deps = createBaseDeps();
    deps.tagService.create.mockResolvedValue({ id: 'tag-local-1' });
    const service = new SyncLocalApplyService(deps as any);

    const result = await service.applyChange(
      'account',
      createChange('tag', { name: '主号', color: '#1677ff' })
    );

    expect(result).toEqual({
      applied: true,
      skipped: false,
      localId: 'tag-local-1',
    });
    expect(deps.tagService.create).toHaveBeenCalledWith({
      name: '主号',
      color: '#1677ff',
    });
  });

  it('applies profile-domain profile changes locally', async () => {
    const deps = createBaseDeps();
    deps.profileService.create.mockResolvedValue({ id: 'profile-local-1' });
    const service = new SyncLocalApplyService(deps as any);

    const result = await service.applyChange(
      'profile',
      createChange('profile', { name: '环境一', engine: 'extension' })
    );

    expect(result).toEqual({
      applied: true,
      skipped: false,
      localId: 'profile-local-1',
    });
    expect(deps.profileService.create).toHaveBeenCalledWith({
      name: '环境一',
      engine: 'extension',
    });
  });

  it('skips mismatched entity types under a supported domain', async () => {
    const deps = createBaseDeps();
    const service = new SyncLocalApplyService(deps as any);

    const result = await service.applyChange(
      'account',
      createChange('profile', { name: 'wrong-domain' })
    );

    expect(result).toEqual({
      applied: false,
      skipped: true,
      reason: 'unsupported_entity_type:account:profile',
    });
  });

  it('preserves existing binding fields when profileExtensionBinding payload is partial', async () => {
    const deps = createBaseDeps();
    deps.metadataService.getEntityMappingByGlobalUid.mockResolvedValue({
      localId: 'profile-local-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      globalUid: 'global-profileExtensionBinding-1',
      version: 2,
    });
    deps.extensionManager.listProfileBindings.mockResolvedValue([
      {
        id: 'binding-1',
        profileId: 'profile-local-1',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        version: '1.2.3',
        installMode: 'optional',
        sortOrder: 7,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const service = new SyncLocalApplyService(deps as any);
    await service.applyChange(
      'extension',
      createChange('profileExtensionBinding', {
        enabled: false,
      })
    );

    expect(deps.extensionManager.bindPackagesToProfiles).toHaveBeenCalledTimes(1);
    expect(deps.extensionManager.bindPackagesToProfiles).toHaveBeenCalledWith({
      profileIds: ['profile-local-1'],
      packages: [
        {
          extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          version: '1.2.3',
          installMode: 'optional',
          sortOrder: 7,
          enabled: false,
        },
      ],
    });
  });
});
