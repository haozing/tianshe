import type {
  TiansheEditionCapabilities,
  TiansheEditionName,
  TiansheEditionPublicInfo,
} from './selection';
import type { DuckDBService } from '../main/duckdb/service';
import type { ProfileService } from '../main/duckdb/profile-service';
import type { AccountService } from '../main/duckdb/account-service';
import type { SavedSiteService } from '../main/duckdb/saved-site-service';
import type { TagService } from '../main/duckdb/tag-service';
import type { SyncOutboxService } from '../main/sync/sync-outbox-service';
import type { ExtensionPackagesManager } from '../main/profile/extension-packages-manager';

export type {
  TiansheEditionCapabilities,
  TiansheEditionName,
  TiansheEditionPublicInfo,
} from './selection';

export interface CloudRuntimeAuthorizeResult {
  allowed: boolean;
  reason?: string;
  clientVersion?: string;
  minClientVersion?: string;
}

export interface CloudRuntimeInstallPackage {
  pluginCode: string;
  releaseVersion?: string;
  policyVersion?: string;
  tempZipPath: string;
}

export interface CloudRuntimeRef {
  profileUid?: string;
  localProfileId?: string;
  cloudUid?: string;
}

export interface CloudRuntimePluginProvider {
  fetchInstallPackage: (params: { pluginCode: string }) => Promise<CloudRuntimeInstallPackage>;
  authorizeAccess: (params: {
    pluginCode: string;
    profileUid: string;
  }) => Promise<CloudRuntimeAuthorizeResult>;
  resolveProfileUidFromCloudMapping: (runtimeRef: CloudRuntimeRef) => string | undefined;
}

export interface BrowserExtensionInstallPackage {
  extensionId: string;
  releaseVersion?: string;
  policyVersion?: string;
  tempZipPath: string;
  fileName?: string;
}

export interface CloudAuthProvider {
  enabled: boolean;
  registerMainHandlers: () => void | Promise<void>;
}

export interface CloudSnapshotMainDependencies {
  duckdbService: DuckDBService;
  profileService: ProfileService;
  accountService: AccountService;
  savedSiteService: SavedSiteService;
  tagService: TagService;
  syncOutboxService?: SyncOutboxService;
  extensionPackages?: ExtensionPackagesManager;
}

export interface CloudSnapshotProvider {
  enabled: boolean;
  markAccountBundleDirty: (dirty: boolean) => void;
  registerMainHandlers: (deps: CloudSnapshotMainDependencies) => void | Promise<void>;
}

export interface CloudCatalogProvider {
  enabled: boolean;
  runtimePlugin?: CloudRuntimePluginProvider;
  fetchBrowserExtensionInstallPackage?: (params: {
    extensionId: string;
  }) => Promise<BrowserExtensionInstallPackage>;
  registerMainHandlers: () => void | Promise<void>;
}

export interface TiansheEdition {
  name: TiansheEditionName;
  capabilities: TiansheEditionCapabilities;
  cloudAuth: CloudAuthProvider;
  cloudSnapshot: CloudSnapshotProvider;
  cloudCatalog: CloudCatalogProvider;
  toPublicInfo: () => TiansheEditionPublicInfo;
}
