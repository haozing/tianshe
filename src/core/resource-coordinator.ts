import { AsyncLocalStorage } from 'node:async_hooks';
import { v4 as uuidv4 } from 'uuid';
import { Mutex } from 'async-mutex';

export interface ResourceLeaseContext {
  ownerToken: string;
  heldKeys: Set<string>;
  profileLeases: Map<string, unknown>;
}

export interface ResourceAcquireOptions {
  ownerToken?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResourceHandoffOptions {
  ownerToken?: string;
}

export interface ResourceLease {
  ownerToken: string;
  keys: string[];
  release: () => Promise<void>;
}

interface QueuedWaiter {
  ownerToken: string;
  enqueuedAt: number;
  resolved: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface ResourceState {
  ownerToken: string | null;
  refCount: number;
  queue: QueuedWaiter[];
}

export class ResourceAcquireTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceAcquireTimeoutError';
  }
}

export class ResourceAcquireCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceAcquireCancelledError';
  }
}

const DEFAULT_RESOURCE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

class ResourceCoordinator {
  private readonly mutex = new Mutex();
  private readonly contextStorage = new AsyncLocalStorage<ResourceLeaseContext>();
  private readonly resources = new Map<string, ResourceState>();

  getCurrentContext(): ResourceLeaseContext | undefined {
    return this.contextStorage.getStore();
  }

  runWithContext<T>(context: ResourceLeaseContext, fn: () => Promise<T>): Promise<T> {
    return this.contextStorage.run(context, fn);
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
    const lease = await this.acquire(normalizedKeys, {
      ownerToken,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });

    const nextContext: ResourceLeaseContext = {
      ownerToken,
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
    if (normalizedKeys.length === 0) {
      return {
        ownerToken: options.ownerToken || uuidv4(),
        keys: [],
        release: async () => undefined,
      };
    }

    const ownerToken = options.ownerToken || uuidv4();
    const acquiredKeys: string[] = [];

    try {
      for (const key of normalizedKeys) {
        await this.acquireOne(key, ownerToken, options.timeoutMs, options.signal);
        acquiredKeys.push(key);
      }
    } catch (error) {
      await this.releaseKeys(acquiredKeys.slice().reverse(), ownerToken);
      throw error;
    }

    let released = false;
    return {
      ownerToken,
      keys: normalizedKeys,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseKeys(normalizedKeys.slice().reverse(), ownerToken);
      },
    };
  }

  async handoff(
    keys: string[] | string,
    options: ResourceHandoffOptions = {}
  ): Promise<ResourceLease> {
    const normalizedKeys = this.normalizeKeys(keys);
    if (normalizedKeys.length === 0) {
      return {
        ownerToken: options.ownerToken || uuidv4(),
        keys: [],
        release: async () => undefined,
      };
    }

    const ownerToken = options.ownerToken || uuidv4();
    for (const key of normalizedKeys) {
      await this.handoffOne(key, ownerToken);
    }

    let released = false;
    return {
      ownerToken,
      keys: normalizedKeys,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseKeys(normalizedKeys.slice().reverse(), ownerToken);
      },
    };
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
    } finally {
      release();
    }
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
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<void> {
    const waiter = await this.tryAcquireImmediately(key, ownerToken);
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
    ownerToken: string
  ): Promise<QueuedWaiter | null> {
    const release = await this.mutex.acquire();
    try {
      const state = this.getOrCreateState(key);
      if (!state.ownerToken || state.ownerToken === ownerToken) {
        state.ownerToken = ownerToken;
        state.refCount += 1;
        return null;
      }

      const waiter: QueuedWaiter = {
        ownerToken,
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

  private async cancelWaiter(key: string, waiter: QueuedWaiter, message: string): Promise<void> {
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

  private async handoffOne(key: string, ownerToken: string): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      const state = this.getOrCreateState(key);
      if (state.ownerToken === ownerToken) {
        state.refCount += 1;
        return;
      }
      state.ownerToken = ownerToken;
      state.refCount = 1;
    } finally {
      release();
    }
  }

  private async releaseKeys(keys: string[], ownerToken: string): Promise<void> {
    for (const key of keys) {
      await this.releaseOne(key, ownerToken);
    }
  }

  private async releaseOne(key: string, ownerToken: string): Promise<void> {
    let nextWaiter: QueuedWaiter | null = null;
    const release = await this.mutex.acquire();
    try {
      const state = this.resources.get(key);
      if (!state) return;
      if (state.ownerToken !== ownerToken) return;

      state.refCount -= 1;
      if (state.refCount > 0) {
        return;
      }

      while (state.queue.length > 0) {
        const candidate = state.queue.shift() || null;
        if (!candidate || candidate.resolved) continue;
        candidate.resolved = true;
        nextWaiter = candidate;
        break;
      }

      if (nextWaiter) {
        state.ownerToken = nextWaiter.ownerToken;
        state.refCount = 1;
      } else {
        state.ownerToken = null;
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
  }

  private getOrCreateState(key: string): ResourceState {
    let state = this.resources.get(key);
    if (!state) {
      state = { ownerToken: null, refCount: 0, queue: [] };
      this.resources.set(key, state);
    }
    return state;
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
