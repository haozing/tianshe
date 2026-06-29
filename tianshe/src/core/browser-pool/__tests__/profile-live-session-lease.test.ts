import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
  takeoverProfileLiveSessionLease,
} from '../profile-live-session-lease';
import { buildProfileResourceKey, resourceCoordinator } from '../../resource-coordinator';

describe('profile live session lease helpers', () => {
  beforeEach(async () => {
    await resourceCoordinator.clear();
  });

  afterEach(async () => {
    await resourceCoordinator.clear();
    vi.restoreAllMocks();
  });

  it('skips duplicate profile lease acquires inside the same resource context', async () => {
    await resourceCoordinator.runExclusive(buildProfileResourceKey('p1'), { ownerToken: 'owner-1' }, async () => {
      const nestedLease = await acquireProfileLiveSessionLease('p1', { timeoutMs: 25 });
      expect(nestedLease).toBeNull();
    });
  });

  it('releases the attached lease even when handle.release throws', async () => {
    const lease = await acquireProfileLiveSessionLease('p1');
    expect(lease).not.toBeNull();

    let contenderResolved = false;
    const contenderPromise = resourceCoordinator
      .acquire(buildProfileResourceKey('p1'), { ownerToken: 'owner-2' })
      .then((nextLease) => {
        contenderResolved = true;
        return nextLease;
      });

    await Promise.resolve();
    expect(contenderResolved).toBe(false);

    const wrappedHandle = attachProfileLiveSessionLease(
      {
        release: vi.fn().mockRejectedValue(new Error('release failed')),
      },
      lease
    );
    const releaseSpy = vi.spyOn(lease!, 'release');

    await expect(wrappedHandle.release()).rejects.toThrow('release failed');
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    const contenderLease = await contenderPromise;
    expect(contenderResolved).toBe(true);
    await contenderLease.release();
  });

  it('can take over an existing profile live-session lease', async () => {
    const originalLease = await acquireProfileLiveSessionLease('p1');
    expect(originalLease).not.toBeNull();

    let contenderResolved = false;
    const contenderPromise = resourceCoordinator
      .acquire(buildProfileResourceKey('p1'), { ownerToken: 'owner-2' })
      .then((lease) => {
        contenderResolved = true;
        return lease;
      });

    const takeoverLease = await takeoverProfileLiveSessionLease('p1', {
      ownerToken: 'owner-3',
    });
    expect(takeoverLease).not.toBeNull();

    await originalLease!.release();
    await Promise.resolve();
    expect(contenderResolved).toBe(false);

    await takeoverLease!.release();
    const contenderLease = await contenderPromise;
    expect(contenderResolved).toBe(true);
    await contenderLease.release();
  });
});
