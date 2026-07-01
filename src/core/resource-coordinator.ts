import { AsyncLocalStorage } from 'node:async_hooks';
import { v4 as uuidv4 } from 'uuid';
import { Mutex } from 'async-mutex';
import {
  DEFAULT_RESOURCE_WAIT_TIMEOUT_MS,
  ResourceAcquireCancelledError,
  ResourceAcquireTimeoutError,
  type CurrentOwnerInfo,
  type QueuedWaiter,
  type ResourceState,
} from './resource-lock-core';
import {
  ResourceHandoffError,
  TERMINAL_HANDOFF_STATUSES,
  type ResourceApproveHandoffOptions,
  type ResourceCancelHandoffOptions,
  type ResourceCompleteHandoffOptions,
  type ResourceHandoffEvent,
  type ResourceHandoffRequest,
  type ResourceHandoffSummary,
  type ResourcePauseHandoffOptions,
  type ResourceRequestHandoffOptions,
} from './resource-handoff-protocol';
import type {
  ResourceAcquireOptions,
  ResourceControllerKind,
  ResourceHandoffOptions,
  ResourceInterruptibility,
  ResourceLease,
  ResourceLeaseContext,
  ResourceOwnerMetadata,
  ResourceOwnerSnapshot,
  ResourceOwnerSource,
} from './resource-owner-view';

export {
  ResourceAcquireCancelledError,
  ResourceAcquireTimeoutError,
} from './resource-lock-core';
export {
  ResourceHandoffError,
  type ResourceApproveHandoffOptions,
  type ResourceCancelHandoffOptions,
  type ResourceCompleteHandoffOptions,
  type ResourceHandoffAutoApproval,
  type ResourceHandoffEvent,
  type ResourceHandoffRequest,
  type ResourceHandoffStatus,
  type ResourceHandoffSummary,
  type ResourcePauseHandoffOptions,
  type ResourceRequestHandoffOptions,
} from './resource-handoff-protocol';
export type {
  ResourceAcquireOptions,
  ResourceControllerKind,
  ResourceHandoffOptions,
  ResourceInterruptibility,
  ResourceLease,
  ResourceLeaseContext,
  ResourceOwnerMetadata,
  ResourceOwnerSnapshot,
  ResourceOwnerSource,
} from './resource-owner-view';

class ResourceCoordinator {
  private readonly mutex = new Mutex();
  private readonly contextStorage = new AsyncLocalStorage<ResourceLeaseContext>();
  private readonly resources = new Map<string, ResourceState>();
  private readonly handoffRequests = new Map<string, ResourceHandoffRequest>();
  private readonly handoffEventListeners = new Set<(event: ResourceHandoffEvent) => void>();

  getCurrentContext(): ResourceLeaseContext | undefined {
    return this.contextStorage.getStore();
  }

  runWithContext<T>(context: ResourceLeaseContext, fn: () => Promise<T>): Promise<T> {
    return this.contextStorage.run(context, fn);
  }

  onHandoffEvent(listener: (event: ResourceHandoffEvent) => void): () => void {
    this.handoffEventListeners.add(listener);
    return () => {
      this.handoffEventListeners.delete(listener);
    };
  }

  async runExclusive<T>(
    keys: string[] | string,
    options: ResourceAcquireOptions | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const normalizedKeys = this.normalizeKeys(keys);
    if (normalizedKeys.length === 0) {
      return await fn();
    }

    const parentContext = this.getCurrentContext();
    const ownerToken = options?.ownerToken || parentContext?.ownerToken || uuidv4();
    const ownerSource = options?.ownerSource || parentContext?.ownerSource || null;
    const ownerMetadata = options?.ownerMetadata || parentContext?.ownerMetadata || null;
    const lease = await this.acquire(normalizedKeys, {
      ownerToken,
      ...(ownerSource ? { ownerSource } : {}),
      ownerMetadata,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });

    const nextContext: ResourceLeaseContext = {
      ownerToken,
      ownerSource,
      ownerMetadata: lease.ownerMetadata,
      heldKeys: new Set([...(parentContext?.heldKeys || []), ...normalizedKeys]),
      profileLeases: parentContext?.profileLeases || new Map(),
    };

    try {
      return await this.runWithContext(nextContext, fn);
    } finally {
      await lease.release();
    }
  }

  async acquire(
    keys: string[] | string,
    options: ResourceAcquireOptions = {}
  ): Promise<ResourceLease> {
    const normalizedKeys = this.normalizeKeys(keys);
    const ownerToken = options.ownerToken || uuidv4();
    const ownerSource = options.ownerSource || null;
    const ownerMetadata = this.normalizeOwnerMetadata(ownerSource, options.ownerMetadata);
    if (normalizedKeys.length === 0) {
      return {
        ownerToken,
        ownerSource,
        ownerMetadata,
        acquiredAt: null,
        keys: [],
        release: async () => undefined,
      };
    }

    const acquiredKeys: string[] = [];

    try {
      for (const key of normalizedKeys) {
        await this.acquireOne(
          key,
          ownerToken,
          ownerSource,
          ownerMetadata,
          options.timeoutMs,
          options.signal
        );
        acquiredKeys.push(key);
      }
    } catch (error) {
      await this.releaseKeys(acquiredKeys.slice().reverse(), ownerToken);
      throw error;
    }

    let released = false;
    return {
      ownerToken,
      ownerSource,
      ownerMetadata,
      acquiredAt: Date.now(),
      keys: normalizedKeys,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseKeys(normalizedKeys.slice().reverse(), ownerToken);
      },
    };
  }

  /**
   * Low-level owner replacement primitive. Product-level handoff must use
   * requestHandoff/approveHandoff/pauseHandoff/completeHandoff/cancelHandoff.
   */
  async handoff(
    keys: string[] | string,
    options: ResourceHandoffOptions = {}
  ): Promise<ResourceLease> {
    const normalizedKeys = this.normalizeKeys(keys);
    const ownerToken = options.ownerToken || uuidv4();
    const ownerSource = options.ownerSource || null;
    const ownerMetadata = this.normalizeOwnerMetadata(ownerSource, options.ownerMetadata);
    if (normalizedKeys.length === 0) {
      return {
        ownerToken,
        ownerSource,
        ownerMetadata,
        acquiredAt: null,
        keys: [],
        release: async () => undefined,
      };
    }

    const events: ResourceHandoffEvent[] = [];
    const now = Date.now();
    const release = await this.mutex.acquire();
    try {
      for (const key of normalizedKeys) {
        this.handoffOneLocked(key, ownerToken, ownerSource, ownerMetadata, now);
      }
      this.expirePendingHandoffsForKeys(
        normalizedKeys,
        now,
        'owner_replaced_by_low_level_handoff',
        null,
        events
      );
    } finally {
      release();
    }
    this.notifyHandoffEvents(events);

    let released = false;
    return {
      ownerToken,
      ownerSource,
      ownerMetadata,
      acquiredAt: now,
      keys: normalizedKeys,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseKeys(normalizedKeys.slice().reverse(), ownerToken);
      },
    };
  }

  async requestHandoff(
    keys: string[] | string,
    options: ResourceRequestHandoffOptions = {}
  ): Promise<ResourceHandoffRequest> {
    const normalizedKeys = this.normalizeKeys(keys);
    if (normalizedKeys.length === 0) {
      throw new ResourceHandoffError('Resource handoff requires at least one resource key');
    }

    const context = this.getCurrentContext();
    const requesterToken = options.requesterToken || context?.ownerToken || uuidv4();
    const requesterSource = options.requesterSource || context?.ownerSource || null;
    const requesterMetadata = this.normalizeOwnerMetadata(
      requesterSource,
      options.requesterMetadata,
      context?.ownerMetadata || null
    );
    const now = Date.now();
    const expiresAt =
      typeof options.expiresInMs === 'number' && options.expiresInMs > 0
        ? now + Math.floor(options.expiresInMs)
        : null;
    const events: ResourceHandoffEvent[] = [];
    let result: ResourceHandoffRequest;

    const release = await this.mutex.acquire();
    try {
      const owner = this.resolveSharedOwner(normalizedKeys);
      const request: ResourceHandoffRequest = {
        id: uuidv4(),
        keys: normalizedKeys,
        status: 'requested',
        requesterToken,
        requesterSource,
        requesterMetadata,
        ownerToken: owner.ownerToken,
        ownerSource: owner.ownerSource,
        ownerMetadata: owner.ownerMetadata,
        ownerAcquiredAt: owner.acquiredAt,
        reason: this.cleanText(options.reason),
        message: this.cleanText(options.message),
        createdAt: now,
        updatedAt: now,
        expiresAt,
        approvedAt: null,
        pausedAt: null,
        completedAt: null,
        canceledAt: null,
        expiredAt: null,
        completedByToken: null,
        canceledByToken: null,
        statusReason: null,
      };
      this.handoffRequests.set(request.id, request);
      events.push({ type: 'handoff:requested', request: this.snapshotHandoff(request) });

      if (!owner.ownerToken) {
        this.markHandoffApproved(request, now, 'resource_available');
        events.push({ type: 'handoff:approved', request: this.snapshotHandoff(request) });
      } else if (
        options.autoApproveIf === 'current-owner-interruptible' &&
        this.canAutoApproveHandoff(owner)
      ) {
        this.markHandoffApproved(request, now, 'current_owner_interruptible');
        events.push({ type: 'handoff:approved', request: this.snapshotHandoff(request) });
        this.markHandoffPaused(request, now, 'current_owner_paused_for_handoff');
        events.push({ type: 'handoff:paused', request: this.snapshotHandoff(request) });
      }

      result = this.snapshotHandoff(request);
    } finally {
      release();
    }

    this.notifyHandoffEvents(events);
    return result;
  }

  async approveHandoff(
    requestId: string,
    options: ResourceApproveHandoffOptions = {}
  ): Promise<ResourceHandoffRequest> {
    const events: ResourceHandoffEvent[] = [];
    let result: ResourceHandoffRequest;
    const release = await this.mutex.acquire();
    try {
      const request = this.getMutableHandoff(requestId);
      this.assertHandoffNotExpired(request, Date.now(), events);
      if (request.status !== 'requested') {
        throw new ResourceHandoffError(`Cannot approve handoff in ${request.status} state`);
      }
      this.assertOwnerCanManageHandoff(request, options.ownerToken, options.hostAuthorized);
      const now = Date.now();
      this.markHandoffApproved(request, now, options.reason || 'approved_by_owner');
      events.push({ type: 'handoff:approved', request: this.snapshotHandoff(request) });
      if (options.pause === true) {
        this.markHandoffPaused(request, now, 'owner_paused_for_handoff');
        events.push({ type: 'handoff:paused', request: this.snapshotHandoff(request) });
      }
      result = this.snapshotHandoff(request);
    } finally {
      release();
    }
    this.notifyHandoffEvents(events);
    return result;
  }

  async pauseHandoff(
    requestId: string,
    options: ResourcePauseHandoffOptions = {}
  ): Promise<ResourceHandoffRequest> {
    const events: ResourceHandoffEvent[] = [];
    let result: ResourceHandoffRequest;
    const release = await this.mutex.acquire();
    try {
      const request = this.getMutableHandoff(requestId);
      this.assertHandoffNotExpired(request, Date.now(), events);
      if (request.status !== 'requested' && request.status !== 'approved') {
        throw new ResourceHandoffError(`Cannot pause handoff in ${request.status} state`);
      }
      this.assertOwnerCanManageHandoff(request, options.ownerToken, options.hostAuthorized);
      const now = Date.now();
      if (request.status === 'requested') {
        this.markHandoffApproved(request, now, options.reason || 'approved_by_owner');
        events.push({ type: 'handoff:approved', request: this.snapshotHandoff(request) });
      }
      this.markHandoffPaused(request, now, options.reason || 'owner_paused_for_handoff');
      events.push({ type: 'handoff:paused', request: this.snapshotHandoff(request) });
      result = this.snapshotHandoff(request);
    } finally {
      release();
    }
    this.notifyHandoffEvents(events);
    return result;
  }

  async completeHandoff(
    requestId: string,
    options: ResourceCompleteHandoffOptions = {}
  ): Promise<ResourceLease> {
    const events: ResourceHandoffEvent[] = [];
    let lease: ResourceLease;
    const release = await this.mutex.acquire();
    try {
      const request = this.getMutableHandoff(requestId);
      this.assertHandoffNotExpired(request, Date.now(), events);
      if (request.status !== 'approved' && request.status !== 'paused') {
        throw new ResourceHandoffError(`Cannot complete handoff in ${request.status} state`);
      }
      const actorToken = options.actorToken || this.getCurrentContext()?.ownerToken || null;
      this.assertRequesterCanCompleteHandoff(request, actorToken);
      const ownerToken = options.ownerToken || request.requesterToken;
      if (ownerToken !== request.requesterToken) {
        throw new ResourceHandoffError('Completed handoff owner must match the requester');
      }
      const ownerSource = options.ownerSource || request.requesterSource || null;
      const ownerMetadata = this.normalizeOwnerMetadata(
        ownerSource,
        options.ownerMetadata,
        request.requesterMetadata
      );
      const now = Date.now();
      this.assertHandoffOwnerStillCurrent(request);
      for (const key of request.keys) {
        this.handoffOneLocked(key, ownerToken, ownerSource, ownerMetadata, now);
      }
      request.status = 'completed';
      request.completedAt = now;
      request.completedByToken = actorToken;
      request.updatedAt = now;
      request.statusReason = 'handoff_completed';
      this.expirePendingHandoffsForKeys(
        request.keys,
        now,
        'superseded_by_completed_handoff',
        request.id,
        events
      );
      events.push({ type: 'handoff:completed', request: this.snapshotHandoff(request) });
      lease = this.createLease(request.keys, ownerToken, ownerSource, ownerMetadata, now);
    } finally {
      release();
    }
    this.notifyHandoffEvents(events);
    return lease;
  }

  async cancelHandoff(
    requestId: string,
    options: ResourceCancelHandoffOptions = {}
  ): Promise<ResourceHandoffRequest> {
    const events: ResourceHandoffEvent[] = [];
    let result: ResourceHandoffRequest;
    const release = await this.mutex.acquire();
    try {
      const request = this.getMutableHandoff(requestId);
      if (TERMINAL_HANDOFF_STATUSES.has(request.status)) {
        result = this.snapshotHandoff(request);
      } else {
        const actorToken = options.actorToken || this.getCurrentContext()?.ownerToken || null;
        this.assertActorCanCancelHandoff(request, actorToken, options.hostAuthorized);
        const now = Date.now();
        request.status = 'canceled';
        request.canceledAt = now;
        request.canceledByToken = actorToken;
        request.updatedAt = now;
        request.statusReason = this.cleanText(options.reason) || 'handoff_canceled';
        events.push({ type: 'handoff:canceled', request: this.snapshotHandoff(request) });
        result = this.snapshotHandoff(request);
      }
    } finally {
      release();
    }
    this.notifyHandoffEvents(events);
    return result;
  }

  async expireHandoffRequests(now = Date.now()): Promise<ResourceHandoffRequest[]> {
    const events: ResourceHandoffEvent[] = [];
    const expired: ResourceHandoffRequest[] = [];
    const release = await this.mutex.acquire();
    try {
      for (const request of this.handoffRequests.values()) {
        if (this.isHandoffExpired(request, now)) {
          this.markHandoffExpired(request, now, 'handoff_request_expired');
          const snapshot = this.snapshotHandoff(request);
          events.push({ type: 'handoff:expired', request: snapshot });
          expired.push(snapshot);
        }
      }
    } finally {
      release();
    }
    this.notifyHandoffEvents(events);
    return expired;
  }

  async getHandoffRequest(requestId: string): Promise<ResourceHandoffRequest | null> {
    const release = await this.mutex.acquire();
    try {
      const request = this.handoffRequests.get(String(requestId || '').trim());
      return request ? this.snapshotHandoff(request) : null;
    } finally {
      release();
    }
  }

  async listHandoffRequests(key?: string): Promise<ResourceHandoffRequest[]> {
    const normalizedKey = key ? this.normalizeKeys(key)[0] : null;
    const release = await this.mutex.acquire();
    try {
      return Array.from(this.handoffRequests.values())
        .filter((request) => !normalizedKey || request.keys.includes(normalizedKey))
        .map((request) => this.snapshotHandoff(request));
    } finally {
      release();
    }
  }

  async clear(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      for (const state of this.resources.values()) {
        for (const waiter of state.queue) {
          if (waiter.timeoutId) {
            clearTimeout(waiter.timeoutId);
          }
          waiter.resolved = true;
          waiter.reject(new ResourceAcquireCancelledError('Resource coordinator cleared'));
        }
      }
      this.resources.clear();
      this.handoffRequests.clear();
    } finally {
      release();
    }
  }

  async getOwner(key: string): Promise<ResourceOwnerSnapshot | null> {
    const normalizedKeys = this.normalizeKeys(key);
    const normalizedKey = normalizedKeys[0];
    if (!normalizedKey) return null;

    const release = await this.mutex.acquire();
    try {
      const state = this.resources.get(normalizedKey);
      if (!state) return null;
      return this.snapshotOwner(normalizedKey, state);
    } finally {
      release();
    }
  }

  async showOwner(key: string): Promise<ResourceOwnerSnapshot | null> {
    return await this.getOwner(key);
  }

  private normalizeKeys(keys: string[] | string): string[] {
    const values = Array.isArray(keys) ? keys : [keys];
    return Array.from(
      new Set(
        values
          .map((key) => String(key || '').trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
      )
    );
  }

  private async acquireOne(
    key: string,
    ownerToken: string,
    ownerSource: ResourceOwnerSource | null,
    ownerMetadata: ResourceOwnerMetadata | null,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<void> {
    const waiter = await this.tryAcquireImmediately(key, ownerToken, ownerSource, ownerMetadata);
    if (!waiter) {
      return;
    }

    const effectiveTimeout = Math.max(1, timeoutMs || DEFAULT_RESOURCE_WAIT_TIMEOUT_MS);
    if (signal?.aborted) {
      await this.cancelWaiter(key, waiter, 'Resource acquire cancelled');
      throw this.toAbortError(signal, `Resource acquire cancelled for ${key}`);
    }

    let abortListener: (() => void) | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        waiter.resolve = resolve;
        waiter.reject = reject;
        waiter.timeoutId = setTimeout(() => {
          void this.cancelWaiter(
            key,
            waiter,
            `Resource wait timeout after ${effectiveTimeout}ms for ${key}`
          ).then(() => {
            reject(
              new ResourceAcquireTimeoutError(
                `Resource wait timeout after ${effectiveTimeout}ms for ${key}`
              )
            );
          });
        }, effectiveTimeout);

        abortListener = () => {
          void this.cancelWaiter(key, waiter, 'Resource acquire cancelled').then(() => {
            reject(this.toAbortError(signal, `Resource acquire cancelled for ${key}`));
          });
        };

        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', abortListener, { once: true });
        }
      });
    } finally {
      if (abortListener && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  private async tryAcquireImmediately(
    key: string,
    ownerToken: string,
    ownerSource: ResourceOwnerSource | null,
    ownerMetadata: ResourceOwnerMetadata | null
  ): Promise<QueuedWaiter | null> {
    const release = await this.mutex.acquire();
    try {
      const state = this.getOrCreateState(key);
      if (!state.ownerToken || state.ownerToken === ownerToken) {
        const now = Date.now();
        if (!state.ownerToken) {
          state.acquiredAt = now;
        }
        state.ownerToken = ownerToken;
        state.ownerSource = state.ownerSource || ownerSource;
        state.ownerMetadata = this.mergeOwnerMetadata(state.ownerMetadata, ownerMetadata);
        state.refCount += 1;
        return null;
      }

      const waiter: QueuedWaiter = {
        ownerToken,
        ownerSource,
        ownerMetadata,
        enqueuedAt: Date.now(),
        resolved: false,
        resolve: () => undefined,
        reject: () => undefined,
      };
      state.queue.push(waiter);
      return waiter;
    } finally {
      release();
    }
  }

  private async cancelWaiter(key: string, waiter: QueuedWaiter, _message: string): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      if (waiter.resolved) return;
      const state = this.resources.get(key);
      if (!state) {
        waiter.resolved = true;
        return;
      }
      const index = state.queue.indexOf(waiter);
      if (index >= 0) {
        state.queue.splice(index, 1);
      }
      if (state.ownerToken === null && state.queue.length === 0 && state.refCount === 0) {
        this.resources.delete(key);
      }
      waiter.resolved = true;
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }
    } finally {
      release();
    }
  }

  private handoffOneLocked(
    key: string,
    ownerToken: string,
    ownerSource: ResourceOwnerSource | null,
    ownerMetadata: ResourceOwnerMetadata | null,
    now: number
  ): void {
    const state = this.getOrCreateState(key);
    if (state.ownerToken === ownerToken) {
      state.ownerSource = state.ownerSource || ownerSource;
      state.ownerMetadata = this.mergeOwnerMetadata(state.ownerMetadata, ownerMetadata);
      state.refCount += 1;
      return;
    }
    state.ownerToken = ownerToken;
    state.ownerSource = ownerSource;
    state.ownerMetadata = ownerMetadata ? { ...ownerMetadata } : null;
    state.acquiredAt = now;
    state.refCount = 1;
  }

  private async releaseKeys(keys: string[], ownerToken: string): Promise<void> {
    for (const key of keys) {
      await this.releaseOne(key, ownerToken);
    }
  }

  private async releaseOne(key: string, ownerToken: string): Promise<void> {
    let nextWaiter: QueuedWaiter | null = null;
    const events: ResourceHandoffEvent[] = [];
    const release = await this.mutex.acquire();
    try {
      const state = this.resources.get(key);
      if (!state) return;
      if (state.ownerToken !== ownerToken) return;

      state.refCount -= 1;
      if (state.refCount > 0) {
        return;
      }

      const now = Date.now();
      this.expirePendingHandoffsForKeys([key], now, 'owner_released', null, events);
      while (state.queue.length > 0) {
        const candidate = state.queue.shift() || null;
        if (!candidate || candidate.resolved) continue;
        candidate.resolved = true;
        nextWaiter = candidate;
        break;
      }

      if (nextWaiter) {
        state.ownerToken = nextWaiter.ownerToken;
        state.ownerSource = nextWaiter.ownerSource;
        state.ownerMetadata = nextWaiter.ownerMetadata;
        state.acquiredAt = now;
        state.refCount = 1;
      } else {
        state.ownerToken = null;
        state.ownerSource = null;
        state.ownerMetadata = null;
        state.acquiredAt = null;
        state.refCount = 0;
        if (state.queue.length === 0) {
          this.resources.delete(key);
        }
      }
    } finally {
      release();
    }

    if (nextWaiter) {
      if (nextWaiter.timeoutId) {
        clearTimeout(nextWaiter.timeoutId);
      }
      nextWaiter.resolve();
    }
    this.notifyHandoffEvents(events);
  }

  private getOrCreateState(key: string): ResourceState {
    let state = this.resources.get(key);
    if (!state) {
      state = {
        ownerToken: null,
        ownerSource: null,
        ownerMetadata: null,
        acquiredAt: null,
        refCount: 0,
        queue: [],
      };
      this.resources.set(key, state);
    }
    return state;
  }

  private createLease(
    keys: string[],
    ownerToken: string,
    ownerSource: ResourceOwnerSource | null,
    ownerMetadata: ResourceOwnerMetadata | null,
    acquiredAt: number | null
  ): ResourceLease {
    let released = false;
    return {
      ownerToken,
      ownerSource,
      ownerMetadata,
      acquiredAt,
      keys,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseKeys(keys.slice().reverse(), ownerToken);
      },
    };
  }

  private resolveSharedOwner(keys: string[]): CurrentOwnerInfo {
    let owner: CurrentOwnerInfo | null = null;
    for (const key of keys) {
      const state = this.resources.get(key);
      const current: CurrentOwnerInfo = {
        ownerToken: state?.ownerToken || null,
        ownerSource: state?.ownerSource || null,
        ownerMetadata: state?.ownerMetadata ? { ...state.ownerMetadata } : null,
        acquiredAt: state?.acquiredAt || null,
      };
      if (!owner) {
        owner = current;
        continue;
      }
      if (current.ownerToken && owner.ownerToken && current.ownerToken !== owner.ownerToken) {
        throw new ResourceHandoffError('Cannot request handoff across multiple current owners');
      }
      if (!owner.ownerToken && current.ownerToken) {
        owner = current;
      }
    }
    return owner || {
      ownerToken: null,
      ownerSource: null,
      ownerMetadata: null,
      acquiredAt: null,
    };
  }

  private canAutoApproveHandoff(owner: CurrentOwnerInfo): boolean {
    if (!owner.ownerToken) return true;
    const metadata =
      owner.ownerMetadata || this.normalizeOwnerMetadata(owner.ownerSource, owner.ownerMetadata);
    const controllerKind = metadata.controllerKind || this.inferControllerKind(owner.ownerSource);
    const interruptibility =
      metadata.interruptibility || this.inferInterruptibility(controllerKind);
    if (owner.ownerSource === 'ipc' || controllerKind === 'human') {
      return false;
    }
    return interruptibility !== 'non_interruptible';
  }

  private getMutableHandoff(requestId: string): ResourceHandoffRequest {
    const request = this.handoffRequests.get(String(requestId || '').trim());
    if (!request) {
      throw new ResourceHandoffError(`Handoff request not found: ${requestId}`);
    }
    return request;
  }

  private assertOwnerCanManageHandoff(
    request: ResourceHandoffRequest,
    ownerToken: string | undefined,
    hostAuthorized = false
  ): void {
    if (!request.ownerToken) {
      return;
    }
    if (hostAuthorized && this.isHostManageableHandoff(request)) {
      return;
    }
    const resolvedToken = ownerToken || this.getCurrentContext()?.ownerToken || null;
    if (resolvedToken !== request.ownerToken) {
      throw new ResourceHandoffError('Only the current owner can approve or pause handoff');
    }
  }

  private assertRequesterCanCompleteHandoff(
    request: ResourceHandoffRequest,
    actorToken: string | null
  ): asserts actorToken is string {
    if (actorToken !== request.requesterToken) {
      throw new ResourceHandoffError('Only the handoff requester can complete handoff');
    }
  }

  private assertActorCanCancelHandoff(
    request: ResourceHandoffRequest,
    actorToken: string | null,
    hostAuthorized = false
  ): void {
    if (hostAuthorized && this.isHostManageableHandoff(request)) {
      return;
    }
    if (!actorToken || (actorToken !== request.requesterToken && actorToken !== request.ownerToken)) {
      throw new ResourceHandoffError('Only the requester or current owner can cancel handoff');
    }
  }

  private isHostManageableHandoff(request: ResourceHandoffRequest): boolean {
    if (!request.ownerToken) {
      return true;
    }
    const ownerMetadata = request.ownerMetadata || this.normalizeOwnerMetadata(request.ownerSource);
    const controllerKind = ownerMetadata.controllerKind || this.inferControllerKind(request.ownerSource);
    return request.ownerSource === 'ipc' || controllerKind === 'human';
  }

  private assertHandoffOwnerStillCurrent(request: ResourceHandoffRequest): void {
    for (const key of request.keys) {
      const state = this.resources.get(key);
      const currentOwnerToken = state?.ownerToken || null;
      if (currentOwnerToken === request.requesterToken) {
        continue;
      }
      if (currentOwnerToken !== request.ownerToken) {
        throw new ResourceHandoffError('Cannot complete handoff after the resource owner changed');
      }
    }
  }

  private assertHandoffNotExpired(
    request: ResourceHandoffRequest,
    now: number,
    events: ResourceHandoffEvent[]
  ): void {
    if (!this.isHandoffExpired(request, now)) {
      return;
    }
    this.markHandoffExpired(request, now, 'handoff_request_expired');
    events.push({ type: 'handoff:expired', request: this.snapshotHandoff(request) });
    throw new ResourceHandoffError('Cannot use an expired handoff request');
  }

  private isHandoffExpired(request: ResourceHandoffRequest, now: number): boolean {
    return (
      !TERMINAL_HANDOFF_STATUSES.has(request.status) &&
      typeof request.expiresAt === 'number' &&
      request.expiresAt <= now
    );
  }

  private markHandoffApproved(
    request: ResourceHandoffRequest,
    now: number,
    reason: string
  ): void {
    request.status = 'approved';
    request.approvedAt = request.approvedAt || now;
    request.updatedAt = now;
    request.statusReason = reason;
  }

  private markHandoffPaused(
    request: ResourceHandoffRequest,
    now: number,
    reason: string
  ): void {
    request.status = 'paused';
    request.pausedAt = request.pausedAt || now;
    request.updatedAt = now;
    request.statusReason = reason;
  }

  private markHandoffExpired(
    request: ResourceHandoffRequest,
    now: number,
    reason: string
  ): void {
    request.status = 'expired';
    request.expiredAt = now;
    request.updatedAt = now;
    request.statusReason = reason;
  }

  private expirePendingHandoffsForKeys(
    keys: string[],
    now: number,
    reason: string,
    exceptRequestId: string | null,
    events: ResourceHandoffEvent[]
  ): void {
    for (const request of this.handoffRequests.values()) {
      if (exceptRequestId && request.id === exceptRequestId) continue;
      if (TERMINAL_HANDOFF_STATUSES.has(request.status)) continue;
      if (!request.keys.some((key) => keys.includes(key))) continue;
      this.markHandoffExpired(request, now, reason);
      events.push({ type: 'handoff:expired', request: this.snapshotHandoff(request) });
    }
  }

  private snapshotOwner(key: string, state: ResourceState): ResourceOwnerSnapshot {
    const metadata = state.ownerMetadata ? { ...state.ownerMetadata } : null;
    const pendingHandoffs = this.getPendingHandoffsForKey(key);
    const latestHandoff = pendingHandoffs[0] || null;
    return {
      ownerToken: state.ownerToken,
      ownerSource: state.ownerSource,
      ownerMetadata: metadata,
      controllerKind: metadata?.controllerKind || null,
      pluginId: metadata?.pluginId || null,
      capability: metadata?.capability || null,
      traceId: metadata?.traceId || null,
      requestId: metadata?.requestId || null,
      acquiredAt: state.acquiredAt,
      interruptibility: metadata?.interruptibility || null,
      refCount: state.refCount,
      waitingCount: state.queue.filter((waiter) => !waiter.resolved).length,
      pendingHandoffCount: pendingHandoffs.length,
      latestHandoff,
    };
  }

  private getPendingHandoffsForKey(key: string): ResourceHandoffSummary[] {
    return Array.from(this.handoffRequests.values())
      .filter((request) => !TERMINAL_HANDOFF_STATUSES.has(request.status))
      .filter((request) => request.keys.includes(key))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((request) => ({
        id: request.id,
        status: request.status,
        requesterToken: request.requesterToken,
        requesterSource: request.requesterSource,
        reason: request.reason,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        expiresAt: request.expiresAt,
      }));
  }

  private snapshotHandoff(request: ResourceHandoffRequest): ResourceHandoffRequest {
    return {
      ...request,
      keys: [...request.keys],
      requesterMetadata: request.requesterMetadata ? { ...request.requesterMetadata } : null,
      ownerMetadata: request.ownerMetadata ? { ...request.ownerMetadata } : null,
    };
  }

  private notifyHandoffEvents(events: ResourceHandoffEvent[]): void {
    if (events.length === 0 || this.handoffEventListeners.size === 0) return;
    for (const event of events) {
      for (const listener of this.handoffEventListeners) {
        try {
          listener(event);
        } catch {
          // Ignore observer failures; resource ownership state has already changed.
        }
      }
    }
  }

  private normalizeOwnerMetadata(
    ownerSource: ResourceOwnerSource | null,
    metadata?: ResourceOwnerMetadata | null,
    fallback?: ResourceOwnerMetadata | null
  ): ResourceOwnerMetadata {
    const base = fallback || {};
    const input = metadata || {};
    const controllerKind =
      input.controllerKind || base.controllerKind || this.inferControllerKind(ownerSource);
    const interruptibility =
      input.interruptibility ||
      base.interruptibility ||
      this.inferInterruptibility(controllerKind);
    return {
      controllerKind,
      pluginId: this.cleanText(input.pluginId ?? base.pluginId),
      capability: this.cleanText(input.capability ?? base.capability),
      traceId: this.cleanText(input.traceId ?? base.traceId),
      requestId: this.cleanText(input.requestId ?? base.requestId),
      description: this.cleanText(input.description ?? base.description),
      interruptibility,
    };
  }

  private mergeOwnerMetadata(
    current: ResourceOwnerMetadata | null,
    next: ResourceOwnerMetadata | null
  ): ResourceOwnerMetadata | null {
    if (!current) return next ? { ...next } : null;
    if (!next) return { ...current };
    return {
      controllerKind: next.controllerKind || current.controllerKind || null,
      pluginId: next.pluginId || current.pluginId || null,
      capability: next.capability || current.capability || null,
      traceId: next.traceId || current.traceId || null,
      requestId: next.requestId || current.requestId || null,
      description: next.description || current.description || null,
      interruptibility: next.interruptibility || current.interruptibility || null,
    };
  }

  private inferControllerKind(ownerSource: ResourceOwnerSource | null): ResourceControllerKind {
    switch (ownerSource) {
      case 'ipc':
        return 'human';
      case 'mcp':
      case 'http':
        return 'agent';
      case 'plugin':
        return 'plugin';
      case 'internal':
        return 'system';
      default:
        return 'unknown';
    }
  }

  private inferInterruptibility(
    controllerKind: ResourceControllerKind | null
  ): ResourceInterruptibility {
    return controllerKind === 'human' ? 'non_interruptible' : 'checkpoint';
  }

  private cleanText(value: unknown): string | null {
    const text = String(value == null ? '' : value).trim();
    return text || null;
  }

  private toAbortError(signal: AbortSignal | undefined, fallback: string): Error {
    const reason = signal?.reason;
    if (reason instanceof Error) {
      return reason;
    }
    return new ResourceAcquireCancelledError(String(reason || fallback));
  }
}

export const resourceCoordinator = new ResourceCoordinator();

export function buildProfileResourceKey(profileId: string): string {
  return `profile:${String(profileId || '').trim()}`;
}
