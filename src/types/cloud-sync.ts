import type { CloudSyncScopeId } from '../utils/cloud-sync-scope';

export interface CloudAuthUser {
  userId: number;
  userName: string;
  name?: string;
  deptId?: number;
  avatar?: string;
  roles?: string[];
}

export interface CloudAuthSession {
  authSessionId: string;
  authRevision: number;
  token?: string;
  expire?: string;
  user?: CloudAuthUser;
}

export interface PersistedCloudAuthSession extends CloudAuthSession {
  updatedAt?: number;
}

export interface CloudAuthPublicSession {
  loggedIn: boolean;
  authRevision: number;
  expire?: string;
  user?: CloudAuthUser;
}

export type CloudAuthChangeReason =
  | 'login'
  | 'logout'
  | 'expired'
  | 'remote_unauthorized'
  | 'workbench_sync_failed';

export interface CloudAuthSessionChangedEvent {
  session: CloudAuthPublicSession;
  reason: CloudAuthChangeReason;
}

export interface CloudAuthStoreSchema<TSession = CloudAuthSession> {
  session?: TSession;
}

export type CloudSyncCapabilityDomain = 'profile' | 'account';
export type CloudSyncCapabilityAction = 'view' | 'cache' | 'edit' | 'delete';

export interface CloudSyncDomainCapability {
  view: boolean;
  cache: boolean;
  edit: boolean;
  delete: boolean;
}

export interface CloudSyncCapabilities {
  profile: CloudSyncDomainCapability;
  account: CloudSyncDomainCapability;
  scopes?: Array<{
    scopeType?: string;
    scopeId?: number;
  }>;
}

export interface CloudSyncCapabilityCache {
  value: CloudSyncCapabilities;
  updatedAt: number;
}

export interface CloudSyncActiveScopeEntry {
  scopeType?: string;
  scopeId?: CloudSyncScopeId;
  updatedAt?: number;
}

export interface CloudAccountBundleDirtyEntry {
  dirty: boolean;
  updatedAt: number;
}

export interface CloudSyncStoreSchema<
  TMappingBucket = unknown,
  TAccountSnapshot = unknown,
  TCapabilityCache = CloudSyncCapabilityCache,
> {
  mappingBucketsByScope?: Record<string, TMappingBucket>;
  activeScopeBySession?: Record<string, CloudSyncActiveScopeEntry>;
  capabilitiesByScope?: Record<string, TCapabilityCache>;
  accountSnapshotsByScope?: Record<string, TAccountSnapshot>;
  accountBundleDirtyByScope?: Record<string, CloudAccountBundleDirtyEntry>;
  mappingsByLocalId?: Record<string, unknown>;
  localByCloudUid?: Record<string, string>;
  localByProfileUid?: Record<string, string>;
  accountSnapshot?: TAccountSnapshot;
  accountSnapshotsByUser?: Record<string, TAccountSnapshot>;
}
