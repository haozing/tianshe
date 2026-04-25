import {
  buildProfileResourceKey,
  resourceCoordinator,
  type ResourceLease,
} from '../resource-coordinator';

export interface AcquireProfileLiveSessionLeaseOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TakeoverProfileLiveSessionLeaseOptions {
  ownerToken?: string;
}

type Releasable = {
  release: (...args: any[]) => Promise<any>;
};

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
    ownerToken: currentContext?.ownerToken,
    timeoutMs: options?.timeoutMs,
    signal: options?.signal,
  });
}

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
  });
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
