import type { ResourceOwnerMetadata, ResourceOwnerSource } from './resource-owner-view';

export const DEFAULT_RESOURCE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export interface QueuedWaiter {
  ownerToken: string;
  ownerSource: ResourceOwnerSource | null;
  ownerMetadata: ResourceOwnerMetadata | null;
  enqueuedAt: number;
  resolved: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export interface ResourceState {
  ownerToken: string | null;
  ownerSource: ResourceOwnerSource | null;
  ownerMetadata: ResourceOwnerMetadata | null;
  acquiredAt: number | null;
  refCount: number;
  queue: QueuedWaiter[];
}

export interface CurrentOwnerInfo {
  ownerToken: string | null;
  ownerSource: ResourceOwnerSource | null;
  ownerMetadata: ResourceOwnerMetadata | null;
  acquiredAt: number | null;
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
