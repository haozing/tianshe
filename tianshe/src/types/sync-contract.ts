export const SYNC_PROTOCOL_VERSION = '1.0' as const;

export type SyncDomain = 'account' | 'profile' | 'extension';

export type SyncEntityType =
  | 'account'
  | 'savedSite'
  | 'tag'
  | 'profile'
  | 'profileGroup'
  | 'extensionPackage'
  | 'profileExtensionBinding';

export type SyncOperationType = 'upsert' | 'delete';

export type SyncEventSource = 'crud';

export type SyncConflictPolicy = 'error' | 'overwrite';

export type SyncArtifactType = 'extension-package';

export type SyncErrorCode =
  | 'SYNC_AUTH_REQUIRED'
  | 'SYNC_PERMISSION_DENIED'
  | 'SYNC_PROTOCOL_VERSION_UNSUPPORTED'
  | 'SYNC_PAYLOAD_TOO_LARGE'
  | 'SYNC_DOMAIN_CONFLICT'
  | 'SYNC_ENTITY_CONFLICT'
  | 'SYNC_REFERENCE_CONFLICT'
  | 'SYNC_ARTIFACT_NOT_FOUND'
  | 'SYNC_ARTIFACT_HASH_MISMATCH'
  | 'SYNC_SCOPE_INVALID'
  | 'SYNC_SECURITY_POLICY_VIOLATION'
  | 'SYNC_CURSOR_EXPIRED'
  | 'SYNC_INTERNAL_ERROR';

export interface SyncClientInfo {
  clientId: string;
  deviceFingerprint: string;
  appVersion: string;
}

export interface SyncScope {
  scopeType: string;
  scopeId: string | number;
}

export interface SyncEnvelope {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  traceId: string;
  client: SyncClientInfo;
  scope: SyncScope;
}

export interface SyncDomainCapability {
  view: boolean;
  cache: boolean;
  edit: boolean;
  delete: boolean;
}

export interface SyncExtensionCapability extends SyncDomainCapability {
  install: boolean;
}

export interface SyncCapabilities {
  account: SyncDomainCapability;
  profile: SyncDomainCapability;
  extension: SyncExtensionCapability;
}

export interface SyncHandshakeRequest extends SyncEnvelope {}

export interface SyncHandshakeResponse {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  traceId: string;
  serverTime: string;
  capabilities: SyncCapabilities;
  limits: {
    maxPushOps: number;
    maxPayloadBytes: number;
    maxArtifactBytes: number;
  };
  domainVersions: Record<SyncDomain, number>;
}

export interface SyncPushEntity {
  entityType: SyncEntityType;
  localId: string;
  globalUid?: string;
  baseVersion?: number;
  payload?: Record<string, unknown>;
  deletedAt?: string | null;
}

export interface SyncPushOperation {
  domain: SyncDomain;
  opType: SyncOperationType;
  eventSource: SyncEventSource;
  baseDomainVersion?: number;
  entities: SyncPushEntity[];
}

export interface SyncPushRequest extends SyncEnvelope {
  idempotencyKey: string;
  conflictPolicy?: SyncConflictPolicy;
  operations: SyncPushOperation[];
}

export interface SyncConflictPayload {
  serverVersion?: number;
  serverContentHash?: string;
  serverEntity?: Record<string, unknown>;
}

export interface SyncPushEntityResult {
  entityType: SyncEntityType;
  localId: string;
  globalUid?: string;
  newVersion?: number;
  contentHash?: string;
  status: 'ok' | 'conflict' | 'failed';
  conflict?: SyncConflictPayload;
  errorCode?: SyncErrorCode;
  errorMessage?: string;
  message?: string;
  details?: unknown;
}

export interface SyncPushDomainResult {
  domain: SyncDomain;
  newDomainVersion: number;
  successCount: number;
  conflictCount: number;
  failureCount: number;
  entityResults: SyncPushEntityResult[];
}

export interface SyncPushResponse {
  protocolVersion?: typeof SYNC_PROTOCOL_VERSION;
  traceId: string;
  result: 'success' | 'partial_success' | 'failed';
  domainResults: SyncPushDomainResult[];
}

export interface SyncPullRequest extends SyncEnvelope {
  since: Record<SyncDomain, number>;
  includeDeleted?: boolean;
  page?: {
    size: number;
    cursor?: string;
  };
}

export interface SyncPullChange {
  entityType: SyncEntityType;
  globalUid: string;
  version: number;
  contentHash?: string;
  payload?: Record<string, unknown>;
  deletedAt?: string | null;
}

export interface SyncPullDomainResult {
  domain: SyncDomain;
  newDomainVersion: number;
  changes: SyncPullChange[];
}

export interface SyncPullResponse {
  protocolVersion?: typeof SYNC_PROTOCOL_VERSION;
  traceId: string;
  hasMore: boolean;
  nextCursor?: string;
  domains: SyncPullDomainResult[];
}

export interface SyncArtifactUploadUrlRequest extends SyncEnvelope {
  artifactType: SyncArtifactType;
  sha256: string;
  sizeBytes: number;
  fileName: string;
}

export interface SyncArtifactUploadUrlResponse {
  protocolVersion?: typeof SYNC_PROTOCOL_VERSION;
  traceId: string;
  uploadUrl: string;
  artifactRef: string;
  expireAt: string;
}

export interface SyncArtifactDownloadUrlRequest extends SyncEnvelope {
  artifactRef: string;
}

export interface SyncArtifactDownloadUrlResponse {
  protocolVersion?: typeof SYNC_PROTOCOL_VERSION;
  traceId: string;
  downloadUrl: string;
  expireAt: string;
}

export interface SyncErrorResponse {
  protocolVersion?: typeof SYNC_PROTOCOL_VERSION;
  traceId: string;
  error: {
    code: SyncErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type SyncRequest =
  | SyncHandshakeRequest
  | SyncPushRequest
  | SyncPullRequest
  | SyncArtifactUploadUrlRequest
  | SyncArtifactDownloadUrlRequest;

export type SyncResponse =
  | SyncHandshakeResponse
  | SyncPushResponse
  | SyncPullResponse
  | SyncArtifactUploadUrlResponse
  | SyncArtifactDownloadUrlResponse
  | SyncErrorResponse;
