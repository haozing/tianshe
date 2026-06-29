import type {
  BrowserProfile,
  CreateProfileParams,
  ProfileGroup,
  ProfileListParams,
  UpdateProfileParams,
} from '../../../types/profile';
import type { IProfileGroupService, IProfileService } from '../../../types/service-interfaces';
import { getBrowserPoolManager } from '../../browser-pool';
import { createLogger } from '../../logger';
import { fingerprintManager } from '../../stealth';

const logger = createLogger('ProfileCrudNamespace');

export interface ProfileCrudNamespaceDeps {
  pluginId: string;
  profileService: IProfileService;
  groupService: IProfileGroupService;
}

export class ProfileCrudNamespace {
  constructor(private readonly deps: ProfileCrudNamespaceDeps) {}

  async list(params?: ProfileListParams): Promise<BrowserProfile[]> {
    return this.deps.profileService.list(params);
  }

  async get(id: string): Promise<BrowserProfile | null> {
    return this.deps.profileService.get(id);
  }

  async create(params: CreateProfileParams): Promise<BrowserProfile> {
    logger.info('Creating profile from plugin helper', {
      pluginId: this.deps.pluginId,
      profileName: params.name,
    });
    const profile = await this.deps.profileService.create(params);
    logger.info('Profile created from plugin helper', {
      pluginId: this.deps.pluginId,
      profileId: profile.id,
      profileName: profile.name,
    });
    return profile;
  }

  async update(id: string, params: UpdateProfileParams): Promise<BrowserProfile> {
    logger.info('Updating profile from plugin helper', {
      pluginId: this.deps.pluginId,
      profileId: id,
    });
    const profile = await this.deps.profileService.update(id, params);

    const runtimeChanged =
      params.fingerprint !== undefined ||
      params.runtimeId !== undefined ||
      params.runtimeSourceOverride !== undefined;
    if (runtimeChanged) {
      await this.clearRuntimeState(id, profile);
    }

    logger.info('Profile updated from plugin helper', {
      pluginId: this.deps.pluginId,
      profileId: profile.id,
    });
    return profile;
  }

  async delete(id: string): Promise<void> {
    logger.info('Deleting profile from plugin helper', {
      pluginId: this.deps.pluginId,
      profileId: id,
    });
    await this.deps.profileService.deleteWithCascade(id);
    logger.info('Profile deleted from plugin helper', {
      pluginId: this.deps.pluginId,
      profileId: id,
    });
  }

  async isAvailable(id: string): Promise<boolean> {
    try {
      const poolManager = getBrowserPoolManager();
      const stats = await poolManager.getProfileStats(id);
      if (!stats) return false;

      return stats.browserCount === 0;
    } catch {
      return this.deps.profileService.isAvailable(id);
    }
  }

  async getStats(): Promise<{
    total: number;
    idle: number;
    active: number;
    error: number;
  }> {
    return this.deps.profileService.getStats();
  }

  async listGroups(): Promise<ProfileGroup[]> {
    return this.deps.groupService.listTree();
  }

  private async clearRuntimeState(id: string, profile: BrowserProfile): Promise<void> {
    try {
      fingerprintManager.clearCache(profile.id);
    } catch {
      // keep update behavior best-effort
    }

    try {
      fingerprintManager.clearCache(profile.partition);
    } catch {
      // keep update behavior best-effort
    }

    try {
      const poolManager = getBrowserPoolManager();
      const destroyedCount = await poolManager.destroyProfileBrowsers(id);
      if (destroyedCount > 0) {
        logger.info('Destroyed browsers after runtime profile fields changed', {
          pluginId: this.deps.pluginId,
          profileId: id,
          destroyedCount,
        });
      }
    } catch {
      // keep update behavior best-effort
    }
  }
}
