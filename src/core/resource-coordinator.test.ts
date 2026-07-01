import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceAcquireCancelledError,
  ResourceAcquireTimeoutError,
  ResourceHandoffError,
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

  it('exposes product owner metadata in owner snapshots', async () => {
    const lease = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'plugin-owner',
      ownerSource: 'plugin',
      ownerMetadata: {
        controllerKind: 'plugin',
        pluginId: 'plugin-a',
        capability: 'books.sync',
        traceId: 'trace-1',
        requestId: 'request-1',
        interruptibility: 'checkpoint',
      },
    });

    const owner = await resourceCoordinator.getOwner('profile:p1');
    expect(owner).toMatchObject({
      ownerToken: 'plugin-owner',
      ownerSource: 'plugin',
      controllerKind: 'plugin',
      pluginId: 'plugin-a',
      capability: 'books.sync',
      traceId: 'trace-1',
      requestId: 'request-1',
      interruptibility: 'checkpoint',
      refCount: 1,
      waitingCount: 0,
      pendingHandoffCount: 0,
    });
    expect(owner?.acquiredAt).toEqual(expect.any(Number));

    await lease.release();
  });

  it('requires request approval before completing product handoff', async () => {
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'owner-1',
      ownerSource: 'plugin',
      ownerMetadata: {
        controllerKind: 'plugin',
        pluginId: 'plugin-a',
        interruptibility: 'checkpoint',
      },
    });

    const request = await resourceCoordinator.requestHandoff('profile:p1', {
      requesterToken: 'owner-2',
      requesterSource: 'mcp',
      requesterMetadata: {
        controllerKind: 'agent',
        interruptibility: 'checkpoint',
      },
      reason: 'manual test handoff',
    });
    expect(request.status).toBe('requested');

    await expect(
      resourceCoordinator.completeHandoff(request.id, {
        actorToken: 'owner-2',
        ownerToken: 'owner-2',
        ownerSource: 'mcp',
      })
    ).rejects.toBeInstanceOf(ResourceHandoffError);

    await resourceCoordinator.approveHandoff(request.id, {
      ownerToken: 'owner-1',
      pause: true,
    });
    await expect(
      resourceCoordinator.completeHandoff(request.id, {
        actorToken: 'owner-3',
        ownerToken: 'owner-2',
        ownerSource: 'mcp',
      })
    ).rejects.toThrow('Only the handoff requester can complete handoff');

    const lease = await resourceCoordinator.completeHandoff(request.id, {
      actorToken: 'owner-2',
      ownerToken: 'owner-2',
      ownerSource: 'mcp',
      ownerMetadata: {
        controllerKind: 'agent',
        interruptibility: 'checkpoint',
      },
    });

    const owner = await resourceCoordinator.getOwner('profile:p1');
    expect(owner).toMatchObject({
      ownerToken: 'owner-2',
      ownerSource: 'mcp',
      controllerKind: 'agent',
      interruptibility: 'checkpoint',
    });

    await first.release();
    expect(await resourceCoordinator.getOwner('profile:p1')).toMatchObject({
      ownerToken: 'owner-2',
    });

    await lease.release();
  });

  it('auto-approves interruptible owners and records handoff events', async () => {
    const events: string[] = [];
    const unsubscribe = resourceCoordinator.onHandoffEvent((event) => {
      events.push(`${event.type}:${event.request.status}`);
    });
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'plugin-owner',
      ownerSource: 'plugin',
      ownerMetadata: {
        controllerKind: 'plugin',
        interruptibility: 'checkpoint',
      },
    });

    const request = await resourceCoordinator.requestHandoff('profile:p1', {
      requesterToken: 'agent-owner',
      requesterSource: 'mcp',
      requesterMetadata: {
        controllerKind: 'agent',
        interruptibility: 'checkpoint',
      },
      autoApproveIf: 'current-owner-interruptible',
    });

    expect(request.status).toBe('paused');
    expect(events).toEqual([
      'handoff:requested:requested',
      'handoff:approved:approved',
      'handoff:paused:paused',
    ]);

    await first.release();
    unsubscribe();
  });

  it('keeps human owners from auto-approval', async () => {
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'human-owner',
      ownerSource: 'ipc',
    });

    const request = await resourceCoordinator.requestHandoff('profile:p1', {
      requesterToken: 'agent-owner',
      requesterSource: 'mcp',
      autoApproveIf: 'current-owner-interruptible',
    });

    expect(request.status).toBe('requested');
    const owner = await resourceCoordinator.getOwner('profile:p1');
    expect(owner).toMatchObject({
      pendingHandoffCount: 1,
      latestHandoff: expect.objectContaining({
        id: request.id,
        status: 'requested',
      }),
    });

    await first.release();
  });

  it('can cancel and expire handoff requests', async () => {
    const first = await resourceCoordinator.acquire('profile:p1', {
      ownerToken: 'owner-1',
      ownerSource: 'plugin',
    });
    const cancelRequest = await resourceCoordinator.requestHandoff('profile:p1', {
      requesterToken: 'owner-2',
      requesterSource: 'mcp',
    });
    const canceled = await resourceCoordinator.cancelHandoff(cancelRequest.id, {
      actorToken: 'owner-2',
      reason: 'user canceled',
    });
    expect(canceled).toMatchObject({
      status: 'canceled',
      canceledByToken: 'owner-2',
      statusReason: 'user canceled',
    });

    const expiring = await resourceCoordinator.requestHandoff('profile:p1', {
      requesterToken: 'owner-3',
      requesterSource: 'mcp',
      expiresInMs: 10,
    });
    await vi.advanceTimersByTimeAsync(11);
    const expired = await resourceCoordinator.expireHandoffRequests(Date.now() + 11);
    expect(expired).toEqual([
      expect.objectContaining({
        id: expiring.id,
        status: 'expired',
      }),
    ]);

    await first.release();
  });
});
