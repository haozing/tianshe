import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceAcquireCancelledError,
  ResourceAcquireTimeoutError,
  buildProfileResourceKey,
  resourceCoordinator,
} from './resource-coordinator';

describe('resourceCoordinator', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await resourceCoordinator.clear();
  });

  afterEach(async () => {
    await resourceCoordinator.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('serves waiting owners in FIFO order for the same key', async () => {
    const first = await resourceCoordinator.acquire(buildProfileResourceKey('p1'), {
      ownerToken: 'owner-1',
    });

    const order: string[] = [];
    const secondPromise = resourceCoordinator
      .acquire(buildProfileResourceKey('p1'), { ownerToken: 'owner-2' })
      .then((lease) => {
        order.push('owner-2');
        return lease;
      });
    const thirdPromise = resourceCoordinator
      .acquire(buildProfileResourceKey('p1'), { ownerToken: 'owner-3' })
      .then((lease) => {
        order.push('owner-3');
        return lease;
      });

    await Promise.resolve();
    expect(order).toEqual([]);

    await first.release();
    const second = await secondPromise;
    expect(order).toEqual(['owner-2']);

    await second.release();
    const third = await thirdPromise;
    expect(order).toEqual(['owner-2', 'owner-3']);

    await third.release();
  });

  it('times out while waiting for a held key', async () => {
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'holder',
    });

    const pending = resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'waiter',
      timeoutMs: 100,
    });
    const expectation = expect(pending).rejects.toBeInstanceOf(ResourceAcquireTimeoutError);

    await vi.advanceTimersByTimeAsync(100);

    await expectation;
    await first.release();
  });

  it('cancels a waiting acquire when the signal aborts', async () => {
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'holder',
    });
    const controller = new AbortController();

    const pending = resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'waiter',
      signal: controller.signal,
    });
    const expectation = expect(pending).rejects.toThrow('aborted by test');

    controller.abort(new ResourceAcquireCancelledError('aborted by test'));
    await expectation;

    await first.release();
  });

  it('supports reentrant acquires for the same owner token', async () => {
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'owner-1',
    });
    const nested = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'owner-1',
    });

    let otherResolved = false;
    const otherPromise = resourceCoordinator
      .acquire('profile:p1', {
        ownerToken: 'owner-2',
      })
      .then((lease) => {
        otherResolved = true;
        return lease;
      });

    await Promise.resolve();
    expect(otherResolved).toBe(false);

    await first.release();
    await Promise.resolve();
    expect(otherResolved).toBe(false);

    await nested.release();
    const other = await otherPromise;
    expect(otherResolved).toBe(true);

    await other.release();
  });

  it('can hand off a held key to a new owner token', async () => {
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'owner-1',
    });

    let waiterResolved = false;
    const waiterPromise = resourceCoordinator
      .acquire('profile:p1', {
        ownerToken: 'owner-2',
      })
      .then((lease) => {
        waiterResolved = true;
        return lease;
      });

    await Promise.resolve();
    expect(waiterResolved).toBe(false);

    const takeover = await resourceCoordinator.handoff('profile:p1', {
      ownerToken: 'owner-3',
    });

    await first.release();
    await Promise.resolve();
    expect(waiterResolved).toBe(false);

    await takeover.release();
    const waiterLease = await waiterPromise;
    expect(waiterResolved).toBe(true);

    await waiterLease.release();
  });
});
