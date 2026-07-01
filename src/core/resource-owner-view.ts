import type { ResourceHandoffSummary } from './resource-handoff-protocol';

export type ResourceOwnerSource = 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin' | 'unknown';
export type ResourceControllerKind = 'agent' | 'human' | 'plugin' | 'system' | 'unknown';
export type ResourceInterruptibility = 'interruptible' | 'checkpoint' | 'non_interruptible';

export interface ResourceOwnerMetadata {
  controllerKind?: ResourceControllerKind | null;
  pluginId?: string | null;
  capability?: string | null;
  traceId?: string | null;
  requestId?: string | null;
  description?: string | null;
  interruptibility?: ResourceInterruptibility | null;
}

export interface ResourceLeaseContext {
  ownerToken: string;
  ownerSource?: ResourceOwnerSource | null;
  ownerMetadata?: ResourceOwnerMetadata | null;
  heldKeys: Set<string>;
  profileLeases: Map<string, unknown>;
}

export interface ResourceAcquireOptions {
  ownerToken?: string;
  ownerSource?: ResourceOwnerSource;
  ownerMetadata?: ResourceOwnerMetadata | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResourceHandoffOptions {
  ownerToken?: string;
  ownerSource?: ResourceOwnerSource;
  ownerMetadata?: ResourceOwnerMetadata | null;
}

export interface ResourceLease {
  ownerToken: string;
  ownerSource?: ResourceOwnerSource | null;
  ownerMetadata?: ResourceOwnerMetadata | null;
  acquiredAt?: number | null;
  keys: string[];
  release: () => Promise<void>;
}

export interface ResourceOwnerSnapshot {
  ownerToken: string | null;
  ownerSource: ResourceOwnerSource | null;
  ownerMetadata: ResourceOwnerMetadata | null;
  controllerKind: ResourceControllerKind | null;
  pluginId: string | null;
  capability: string | null;
  traceId: string | null;
  requestId: string | null;
  acquiredAt: number | null;
  interruptibility: ResourceInterruptibility | null;
  refCount: number;
  waitingCount: number;
  pendingHandoffCount: number;
  latestHandoff: ResourceHandoffSummary | null;
}
