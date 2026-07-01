import type { ResourceOwnerMetadata, ResourceOwnerSource } from './resource-owner-view';

export type ResourceHandoffStatus =
  | 'requested'
  | 'approved'
  | 'paused'
  | 'completed'
  | 'canceled'
  | 'expired';

export type ResourceHandoffAutoApproval = 'current-owner-interruptible';

export interface ResourceRequestHandoffOptions {
  requesterToken?: string;
  requesterSource?: ResourceOwnerSource;
  requesterMetadata?: ResourceOwnerMetadata | null;
  reason?: string;
  message?: string;
  expiresInMs?: number;
  autoApproveIf?: ResourceHandoffAutoApproval;
}

export interface ResourceApproveHandoffOptions {
  ownerToken?: string;
  reason?: string;
  pause?: boolean;
  hostAuthorized?: boolean;
}

export interface ResourcePauseHandoffOptions {
  ownerToken?: string;
  reason?: string;
  hostAuthorized?: boolean;
}

export interface ResourceCompleteHandoffOptions {
  actorToken?: string;
  ownerToken?: string;
  ownerSource?: ResourceOwnerSource;
  ownerMetadata?: ResourceOwnerMetadata | null;
}

export interface ResourceCancelHandoffOptions {
  actorToken?: string;
  reason?: string;
  hostAuthorized?: boolean;
}

export interface ResourceHandoffSummary {
  id: string;
  status: ResourceHandoffStatus;
  requesterToken: string;
  requesterSource: ResourceOwnerSource | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface ResourceHandoffRequest {
  id: string;
  keys: string[];
  status: ResourceHandoffStatus;
  requesterToken: string;
  requesterSource: ResourceOwnerSource | null;
  requesterMetadata: ResourceOwnerMetadata | null;
  ownerToken: string | null;
  ownerSource: ResourceOwnerSource | null;
  ownerMetadata: ResourceOwnerMetadata | null;
  ownerAcquiredAt: number | null;
  reason: string | null;
  message: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  approvedAt: number | null;
  pausedAt: number | null;
  completedAt: number | null;
  canceledAt: number | null;
  expiredAt: number | null;
  completedByToken: string | null;
  canceledByToken: string | null;
  statusReason: string | null;
}

export interface ResourceHandoffEvent {
  type:
    | 'handoff:requested'
    | 'handoff:approved'
    | 'handoff:paused'
    | 'handoff:completed'
    | 'handoff:canceled'
    | 'handoff:expired';
  request: ResourceHandoffRequest;
}

export class ResourceHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceHandoffError';
  }
}

export const TERMINAL_HANDOFF_STATUSES = new Set<ResourceHandoffStatus>([
  'completed',
  'canceled',
  'expired',
]);
