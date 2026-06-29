/**
 * 服务层接口（用于消除 core→main 的 C 类类型导入）
 *
 * 这些接口定义了 core/ 层所需的 main/ 服务能力的最小子集。
 * 实现类位于 main/ 层，core/ 层仅通过接口进行类型依赖。
 */

import type {
  Account,
  CreateAccountParams,
  UpdateAccountParams,
  BrowserProfile,
  CreateProfileParams,
  UpdateProfileParams,
  ProfileListParams,
  ProfileStatus,
  ProfileGroup,
  CreateGroupParams,
  UpdateGroupParams,
  SavedSite,
  CreateSavedSiteParams,
  UpdateSavedSiteParams,
} from './profile';

// =====================================================
// AccountService
// =====================================================

export interface IAccountService {
  listAll(): Promise<Account[]>;
  listByProfile(profileId: string): Promise<Account[]>;
  listByPlatform(platformId: string): Promise<Account[]>;
  get(id: string): Promise<Account | null>;
  create(params: CreateAccountParams): Promise<Account>;
  update(id: string, params: UpdateAccountParams): Promise<Account>;
  delete(id: string): Promise<void>;
  deleteByProfile(profileId: string): Promise<void>;
  updateLastLogin(id: string): Promise<void>;
}

// =====================================================
// SavedSiteService
// =====================================================

export interface ISavedSiteService {
  listAll(): Promise<SavedSite[]>;
  get(id: string): Promise<SavedSite | null>;
  getByName(name: string): Promise<SavedSite | null>;
  create(params: CreateSavedSiteParams): Promise<SavedSite>;
  update(id: string, params: UpdateSavedSiteParams): Promise<SavedSite>;
  delete(id: string): Promise<void>;
}

// =====================================================
// ProfileService
// =====================================================

export interface IProfileService {
  list(params?: ProfileListParams): Promise<BrowserProfile[]>;
  get(id: string): Promise<BrowserProfile | null>;
  create(params: CreateProfileParams): Promise<BrowserProfile>;
  update(id: string, params: UpdateProfileParams): Promise<BrowserProfile>;
  deleteWithCascade(id: string): Promise<void>;
  updateStatus(id: string, status: ProfileStatus, error?: string): Promise<void>;
  isAvailable(id: string): Promise<boolean>;
  resetAllActiveStatus(): Promise<number>;
  getStats(): Promise<{ total: number; idle: number; active: number; error: number }>;
}

// =====================================================
// ProfileGroupService
// =====================================================

export interface IProfileGroupService {
  listTree(): Promise<ProfileGroup[]>;
  create(params: CreateGroupParams): Promise<ProfileGroup>;
  update(id: string, params: UpdateGroupParams): Promise<ProfileGroup>;
  delete(id: string): Promise<void>;
}

// =====================================================
// DatasetFolderService
// =====================================================

export interface IDatasetFolderService {
  createFolder(
    name: string,
    parentId?: string | null,
    pluginId?: string | null,
    options?: { icon?: string; description?: string }
  ): Promise<string>;
  updateFolder(id: string, updates: { name?: string; icon?: string; description?: string }): Promise<void>;
}

// =====================================================
// WebhookSender
// =====================================================

export interface IWebhookSender {
  registerPluginEvent(pluginId: string, eventId: string): void;
  unregisterAllPluginEvents(pluginId: string): void;
}
