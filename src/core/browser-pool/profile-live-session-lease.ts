import {
  buildProfileResourceKey,
  resourceCoordinator,
  type ResourceHandoffRequest,
  type ResourceHandoffStatus,
  type ResourceOwnerSnapshot,
  type ResourceOwnerSource,
  type ResourceLease,
  type ResourceOwnerMetadata,
} from '../resource-coordinator';

export interface AcquireProfileLiveSessionLeaseOptions {
  ownerToken?: string;
  source?: ResourceOwnerSource;
  ownerMetadata?: ResourceOwnerMetadata | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TakeoverProfileLiveSessionLeaseOptions {
  ownerToken?: string;
  source?: ResourceOwnerSource;
  ownerMetadata?: ResourceOwnerMetadata | null;
}

export interface RequestProfileLiveSessionHandoffOptions {
  requesterToken?: string;
  source?: ResourceOwnerSource;
  requesterMetadata?: ResourceOwnerMetadata | null;
  reason?: string;
  message?: string;
  expiresInMs?: number;
  autoApproveIfCurrentOwnerInterruptible?: boolean;
}

export interface CompleteProfileLiveSessionHandoffOptions {
  actorToken?: string;
  ownerToken?: string;
  source?: ResourceOwnerSource;
  ownerMetadata?: ResourceOwnerMetadata | null;
}

export interface ApproveProfileLiveSessionHandoffOptions {
  ownerToken?: string;
  reason?: string;
  pause?: boolean;
  hostAuthorized?: boolean;
}

export interface PauseProfileLiveSessionHandoffOptions {
  ownerToken?: string;
  reason?: string;
  hostAuthorized?: boolean;
}

export interface CancelProfileLiveSessionHandoffOptions {
  actorToken?: string;
  reason?: string;
  hostAuthorized?: boolean;
}

type Releasable = {
  release: (...args: any[]) => Promise<any>;
};

export type ProfileLiveSessionHandoffStatus = ResourceHandoffStatus;
export type ProfileLiveSessionHandoffRequest = ResourceHandoffRequest;

export async function acquireProfileLiveSessionLease(
  profileId: string,
  options?: AcquireProfileLiveSessionLeaseOptions
): Promise<ResourceLease | null> {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return null;
  }

  const resourceKey = buildProfileResourceKey(normalizedProfileId);
  const currentContext = resourceCoordinator.getCurrentContext();
  if (currentContext?.heldKeys.has(resourceKey)) {
    return null;
  }

  return await resourceCoordinator.acquire(resourceKey, {
    ownerToken: options?.ownerToken || currentContext?.ownerToken,
    ownerSource: options?.source || currentContext?.ownerSource || undefined,
    ownerMetadata: options?.ownerMetadata || currentContext?.ownerMetadata || undefined,
    timeoutMs: options?.timeoutMs,
    signal: options?.signal,
  });
}

/**
 * Low-level primitive for already approved internal transfers.
 * Product-level callers should use request/complete/cancel handoff helpers.
 */
export async function takeoverProfileLiveSessionLease(
  profileId: string,
  options?: TakeoverProfileLiveSessionLeaseOptions
): Promise<ResourceLease | null> {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return null;
  }

  const resourceKey = buildProfileResourceKey(normalizedProfileId);
  const currentContext = resourceCoordinator.getCurrentContext();
  if (currentContext?.heldKeys.has(resourceKey)) {
    return null;
  }

  return await resourceCoordinator.handoff(resourceKey, {
    ownerToken: options?.ownerToken || currentContext?.ownerToken,
    ownerSource: options?.source || currentContext?.ownerSource || undefined,
    ownerMetadata: options?.ownerMetadata || currentContext?.ownerMetadata || undefined,
  });
}

export async function requestProfileLiveSessionHandoff(
  profileId: string,
  options?: RequestProfileLiveSessionHandoffOptions
): Promise<ProfileLiveSessionHandoffRequest | null> {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return null;
  }

  const resourceKey = buildProfileResourceKey(normalizedProfileId);
  const currentContext = resourceCoordinator.getCurrentContext();
  return await resourceCoordinator.requestHandoff(resourceKey, {
    requesterToken: options?.requesterToken || currentContext?.ownerToken,
    requesterSource: options?.source || currentContext?.ownerSource || undefined,
    requesterMetadata:
      options?.requesterMetadata || currentContext?.ownerMetadata || undefined,
    reason: options?.reason,
    message: options?.message,
    expiresInMs: options?.expiresInMs,
    autoApproveIf: options?.autoApproveIfCurrentOwnerInterruptible
      ? 'current-owner-interruptible'
      : undefined,
  });
}

export async function completeProfileLiveSessionHandoff(
  handoffRequestId: string,
  options?: CompleteProfileLiveSessionHandoffOptions
): Promise<ResourceLease> {
  const currentContext = resourceCoordinator.getCurrentContext();
  return await resourceCoordinator.completeHandoff(handoffRequestId, {
    actorToken: options?.actorToken || currentContext?.ownerToken,
    ownerToken: options?.ownerToken,
    ownerSource: options?.source || currentContext?.ownerSource || undefined,
    ownerMetadata: options?.ownerMetadata || currentContext?.ownerMetadata || undefined,
  });
}

export async function approveProfileLiveSessionHandoff(
  handoffRequestId: string,
  options?: ApproveProfileLiveSessionHandoffOptions
): Promise<ProfileLiveSessionHandoffRequest> {
  const currentContext = resourceCoordinator.getCurrentContext();
  return await resourceCoordinator.approveHandoff(handoffRequestId, {
    ownerToken: options?.ownerToken || currentContext?.ownerToken,
    reason: options?.reason,
    pause: options?.pause,
    hostAuthorized: options?.hostAuthorized,
  });
}

export async function pauseProfileLiveSessionHandoff(
  handoffRequestId: string,
  options?: PauseProfileLiveSessionHandoffOptions
): Promise<ProfileLiveSessionHandoffRequest> {
  const currentContext = resourceCoordinator.getCurrentContext();
  return await resourceCoordinator.pauseHandoff(handoffRequestId, {
    ownerToken: options?.ownerToken || currentContext?.ownerToken,
    reason: options?.reason,
    hostAuthorized: options?.hostAuthorized,
  });
}

export async function cancelProfileLiveSessionHandoff(
  handoffRequestId: string,
  options?: CancelProfileLiveSessionHandoffOptions
): Promise<ProfileLiveSessionHandoffRequest> {
  const currentContext = resourceCoordinator.getCurrentContext();
  return await resourceCoordinator.cancelHandoff(handoffRequestId, {
    actorToken: options?.actorToken || currentContext?.ownerToken,
    reason: options?.reason,
    hostAuthorized: options?.hostAuthorized,
  });
}

export async function getProfileLiveSessionHandoff(
  handoffRequestId: string
): Promise<ProfileLiveSessionHandoffRequest | null> {
  return await resourceCoordinator.getHandoffRequest(handoffRequestId);
}

export async function listProfileLiveSessionHandoffs(
  profileId?: string
): Promise<ProfileLiveSessionHandoffRequest[]> {
  const normalizedProfileId = String(profileId || '').trim();
  return await resourceCoordinator.listHandoffRequests(
    normalizedProfileId ? buildProfileResourceKey(normalizedProfileId) : undefined
  );
}

export async function getProfileLiveSessionLeaseOwner(
  profileId: string
): Promise<ResourceOwnerSnapshot | null> {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return null;
  }

  return await resourceCoordinator.getOwner(buildProfileResourceKey(normalizedProfileId));
}

export async function showProfileLiveSessionLeaseOwner(
  profileId: string
): Promise<ResourceOwnerSnapshot | null> {
  return await getProfileLiveSessionLeaseOwner(profileId);
}

export function attachProfileLiveSessionLease<T extends Releasable>(
  handle: T,
  lease: ResourceLease | null
): T {
  if (!lease) {
    return handle;
  }

  const originalRelease = handle.release.bind(handle);
  let leaseReleased = false;

  handle.release = (async (...args: Parameters<T['release']>) => {
    try {
      return await originalRelease(...args);
    } finally {
      if (!leaseReleased) {
        leaseReleased = true;
        await lease.release().catch(() => undefined);
      }
    }
  }) as T['release'];

  return handle;
}
