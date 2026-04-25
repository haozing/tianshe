import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  SyncArtifactDownloadUrlRequest,
  SyncArtifactDownloadUrlResponse,
  SyncArtifactUploadUrlRequest,
  SyncArtifactUploadUrlResponse,
  SyncDomain,
  SyncEntityType,
  SyncHandshakeRequest,
  SyncHandshakeResponse,
  SyncPullChange,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushEntityResult,
  SyncPushRequest,
  SyncPushResponse,
} from '../../types/sync-contract';
import { SYNC_PROTOCOL_VERSION } from '../../types/sync-contract';
import { validateSyncContractDefinition } from './sync-contract-validator';
import { SyncGatewayRequestError } from './sync-gateway';
import type { SyncGatewayClient } from './sync-engine-service';

interface MockEntityState {
  domain: SyncDomain;
  entityType: SyncEntityType;
  globalUid: string;
  version: number;
  contentHash: string;
  payload: Record<string, unknown>;
  deletedAt?: string | null;
  updatedAt: number;
}

interface MockDomainState {
  domainVersion: number;
  entities: Map<string, MockEntityState>;
}

interface MockHistoryEntry {
  globalSeq: number;
  domain: SyncDomain;
  domainVersion: number;
  change: SyncPullChange;
}

interface MockScopeState {
  domains: Record<SyncDomain, MockDomainState>;
  history: MockHistoryEntry[];
  nextGlobalSeq: number;
  pushResponseByIdempotencyKey: Map<string, SyncPushResponse>;
}

export interface SyncGatewayMockOptions {
  baseUrl?: string;
  token?: string;
  clientVersion?: string;
}

const MOCK_SCOPE_STATES = new Map<string, MockScopeState>();
const MOCK_ARTIFACTS = new Map<string, Uint8Array>();

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function createDomainState(): MockDomainState {
  return {
    domainVersion: 0,
    entities: new Map<string, MockEntityState>(),
  };
}

function createScopeState(): MockScopeState {
  return {
    domains: {
      account: createDomainState(),
      profile: createDomainState(),
      extension: createDomainState(),
    },
    history: [],
    nextGlobalSeq: 1,
    pushResponseByIdempotencyKey: new Map<string, SyncPushResponse>(),
  };
}

function buildScopeKey(scopeType: unknown, scopeId: unknown): string {
  return `${normalizeText(scopeType) || 'company'}:${normalizeText(scopeId) || '0'}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return cloneJson(value as Record<string, unknown>);
  }
  return {};
}

function encodeCursorOffset(offset: number): string {
  return Buffer.from(String(Math.max(0, Math.trunc(offset))), 'utf8').toString('base64');
}

function decodeCursorOffset(cursor: string | undefined): number {
  const normalized = normalizeText(cursor);
  if (!normalized) return 0;
  try {
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    const offset = Number.parseInt(text, 10);
    if (!Number.isFinite(offset) || offset < 0) return 0;
    return Math.trunc(offset);
  } catch {
    return 0;
  }
}

function computeContentHash(payload: Record<string, unknown>, deletedAt?: string | null): string {
  const raw = JSON.stringify({
    payload,
    deletedAt: deletedAt || null,
  });
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function resolveProfileGlobalUidFromAccountPayload(payload: Record<string, unknown>): string | undefined {
  const profileGlobalUid = normalizeText(
    payload.profileGlobalUid || payload.profileUid || payload.profileCloudUid
  );
  return profileGlobalUid || undefined;
}

function validateRequest<T>(definition: Parameters<typeof validateSyncContractDefinition>[0], payload: T): void {
  const validation = validateSyncContractDefinition(definition, payload);
  if (validation.valid) return;
  throw new SyncGatewayRequestError(
    `SyncGatewayMock request validation failed: ${definition}; ${validation.errors.join('; ')}`
  );
}

export class SyncGatewayMock implements SyncGatewayClient {
  private baseUrl: string;
  private token?: string;
  private clientVersion?: string;

  constructor(options: SyncGatewayMockOptions = {}) {
    this.baseUrl = normalizeText(options.baseUrl) || 'mock://sync';
    this.token = normalizeText(options.token) || undefined;
    this.clientVersion = normalizeText(options.clientVersion) || undefined;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeText(baseUrl) || 'mock://sync';
  }

  setToken(token?: string): void {
    this.token = normalizeText(token) || undefined;
  }

  async handshake(payload: SyncHandshakeRequest): Promise<SyncHandshakeResponse> {
    validateRequest('HandshakeRequest', payload);
    const scopeState = this.getScopeState(payload.scope.scopeType, payload.scope.scopeId);

    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      traceId: payload.traceId,
      serverTime: new Date().toISOString(),
      capabilities: {
        account: { view: true, cache: true, edit: true, delete: true },
        profile: { view: true, cache: true, edit: true, delete: true },
        extension: { view: true, cache: true, edit: true, delete: true, install: true },
      },
      limits: {
        maxPushOps: 500,
        maxPayloadBytes: 4 * 1024 * 1024,
        maxArtifactBytes: 100 * 1024 * 1024,
      },
      domainVersions: {
        account: scopeState.domains.account.domainVersion,
        profile: scopeState.domains.profile.domainVersion,
        extension: scopeState.domains.extension.domainVersion,
      },
    };
  }

  async push(payload: SyncPushRequest): Promise<SyncPushResponse> {
    validateRequest('PushRequest', payload);
    const scopeState = this.getScopeState(payload.scope.scopeType, payload.scope.scopeId);

    const idempotencyKey = normalizeText(payload.idempotencyKey);
    if (idempotencyKey) {
      const cached = scopeState.pushResponseByIdempotencyKey.get(idempotencyKey);
      if (cached) {
        return cloneJson(cached);
      }
    }

    const domainResults: SyncPushResponse['domainResults'] = [];

    for (const operation of payload.operations) {
      const domainState = scopeState.domains[operation.domain];
      const entityResults: SyncPushEntityResult[] = [];
      let successCount = 0;
      let conflictCount = 0;
      let failureCount = 0;

      for (const entity of operation.entities) {
        const globalUidInput = normalizeText(entity.globalUid);
        const globalUid = globalUidInput || uuidv4();
        const existing = domainState.entities.get(globalUid);
        const payloadBodyForCheck = normalizePayload(entity.payload);
        const referenceConflict = this.checkReferenceConflict(
          scopeState,
          operation.domain,
          entity.entityType,
          payloadBodyForCheck
        );
        if (referenceConflict) {
          failureCount += 1;
          entityResults.push({
            entityType: entity.entityType,
            localId: entity.localId,
            ...(globalUidInput ? { globalUid: globalUidInput } : {}),
            status: 'failed',
            errorCode: 'SYNC_REFERENCE_CONFLICT',
            errorMessage: referenceConflict,
          });
          continue;
        }

        const baseVersion =
          typeof entity.baseVersion === 'number' && Number.isFinite(entity.baseVersion)
            ? Math.trunc(entity.baseVersion)
            : undefined;

        if (baseVersion !== undefined && baseVersion >= 0 && (existing?.version || 0) !== baseVersion) {
          conflictCount += 1;
          entityResults.push({
            entityType: entity.entityType,
            localId: entity.localId,
            globalUid,
            status: 'conflict',
            conflict: {
              serverVersion: existing?.version ?? 0,
              serverContentHash: existing?.contentHash || undefined,
              serverEntity: existing?.deletedAt
                ? {
                    deletedAt: existing.deletedAt,
                  }
                : cloneJson(existing?.payload || {}),
            },
            errorCode: 'SYNC_ENTITY_CONFLICT',
            errorMessage: 'Entity version conflict in mock gateway',
          });
          continue;
        }

        const now = Date.now();
        const isDelete = operation.opType === 'delete' || Boolean(entity.deletedAt);
        const nextVersion = Math.max((existing?.version || 0) + 1, 1);
        const deletedAt = isDelete ? normalizeText(entity.deletedAt) || new Date(now).toISOString() : null;
        const payloadBody = isDelete ? {} : payloadBodyForCheck;
        const contentHash = computeContentHash(payloadBody, deletedAt);

        const nextState: MockEntityState = {
          domain: operation.domain,
          entityType: entity.entityType,
          globalUid,
          version: nextVersion,
          contentHash,
          payload: payloadBody,
          deletedAt,
          updatedAt: now,
        };
        domainState.entities.set(globalUid, nextState);

        domainState.domainVersion += 1;
        scopeState.history.push({
          globalSeq: scopeState.nextGlobalSeq,
          domain: operation.domain,
          domainVersion: domainState.domainVersion,
          change: {
            entityType: entity.entityType,
            globalUid,
            version: nextVersion,
            contentHash,
            ...(isDelete
              ? { deletedAt }
              : {
                  payload: cloneJson(payloadBody),
                }),
          },
        });
        scopeState.nextGlobalSeq += 1;

        successCount += 1;
        entityResults.push({
          entityType: entity.entityType,
          localId: entity.localId,
          globalUid,
          newVersion: nextVersion,
          contentHash,
          status: 'ok',
        });
      }

      domainResults.push({
        domain: operation.domain,
        newDomainVersion: domainState.domainVersion,
        successCount,
        conflictCount,
        failureCount,
        entityResults,
      });
    }

    const totalConflict = domainResults.reduce((sum, item) => sum + item.conflictCount, 0);
    const totalFailure = domainResults.reduce((sum, item) => sum + item.failureCount, 0);
    const totalSuccess = domainResults.reduce((sum, item) => sum + item.successCount, 0);

    const response: SyncPushResponse = {
      traceId: payload.traceId,
      result:
        totalFailure > 0
          ? totalSuccess > 0 || totalConflict > 0
            ? 'partial_success'
            : 'failed'
          : totalConflict > 0
            ? totalSuccess > 0
              ? 'partial_success'
              : 'failed'
            : 'success',
      domainResults,
    };

    if (idempotencyKey) {
      scopeState.pushResponseByIdempotencyKey.set(idempotencyKey, cloneJson(response));
    }

    return response;
  }

  async pull(payload: SyncPullRequest): Promise<SyncPullResponse> {
    validateRequest('PullRequest', payload);
    const scopeState = this.getScopeState(payload.scope.scopeType, payload.scope.scopeId);
    const pageSize = Math.max(1, Math.min(1000, Math.trunc(Number(payload.page?.size || 200))));
    const includeDeleted = payload.includeDeleted !== false;
    const cursorOffset = decodeCursorOffset(payload.page?.cursor);

    const filtered = scopeState.history
      .filter((entry) => entry.domainVersion > (payload.since[entry.domain] || 0))
      .filter((entry) => includeDeleted || !entry.change.deletedAt)
      .sort((a, b) => a.globalSeq - b.globalSeq);

    const pageEntries = filtered.slice(cursorOffset, cursorOffset + pageSize);
    const grouped = new Map<SyncDomain, SyncPullChange[]>();

    for (const entry of pageEntries) {
      const existing = grouped.get(entry.domain) || [];
      existing.push(cloneJson(entry.change));
      grouped.set(entry.domain, existing);
    }

    const domains: SyncPullResponse['domains'] = [];
    for (const [domain, changes] of grouped) {
      domains.push({
        domain,
        newDomainVersion: scopeState.domains[domain].domainVersion,
        changes,
      });
    }

    const hasMore = cursorOffset + pageEntries.length < filtered.length;
    return {
      traceId: payload.traceId,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursorOffset(cursorOffset + pageEntries.length) } : {}),
      domains,
    };
  }

  async artifactUploadUrl(
    payload: SyncArtifactUploadUrlRequest
  ): Promise<SyncArtifactUploadUrlResponse> {
    validateRequest('ArtifactUploadUrlRequest', payload);
    const artifactRef = `mock-artifact:${payload.sha256}:${Date.now()}`;
    return {
      traceId: payload.traceId,
      uploadUrl: `${this.baseUrl.replace(/\/+$/, '')}/artifact/upload/${encodeURIComponent(artifactRef)}`,
      artifactRef,
      expireAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  async artifactDownloadUrl(
    payload: SyncArtifactDownloadUrlRequest
  ): Promise<SyncArtifactDownloadUrlResponse> {
    validateRequest('ArtifactDownloadUrlRequest', payload);
    if (!MOCK_ARTIFACTS.has(payload.artifactRef)) {
      throw new SyncGatewayRequestError(
        `Artifact not found in mock gateway: ${payload.artifactRef}`,
        404,
        undefined,
        'SYNC_ARTIFACT_NOT_FOUND'
      );
    }
    return {
      traceId: payload.traceId,
      downloadUrl: `${this.baseUrl.replace(/\/+$/, '')}/artifact/download/${encodeURIComponent(payload.artifactRef)}`,
      expireAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  async uploadArtifactFile(
    uploadUrl: string,
    fileName: string,
    bytes: Uint8Array | ArrayBuffer
  ): Promise<Record<string, unknown>> {
    void fileName;
    const artifactRef = this.extractArtifactRefFromUrl(uploadUrl, '/artifact/upload/');
    const binary = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    MOCK_ARTIFACTS.set(artifactRef, new Uint8Array(binary));
    return {
      traceId: uuidv4(),
      artifactRef,
      status: 'ready',
    };
  }

  async downloadArtifactFile(downloadUrl: string): Promise<Uint8Array> {
    const artifactRef = this.extractArtifactRefFromUrl(downloadUrl, '/artifact/download/');
    const artifact = MOCK_ARTIFACTS.get(artifactRef);
    if (!artifact) {
      throw new SyncGatewayRequestError(
        `Artifact not found in mock gateway: ${artifactRef}`,
        404,
        undefined,
        'SYNC_ARTIFACT_NOT_FOUND'
      );
    }
    return new Uint8Array(artifact);
  }

  private getScopeState(scopeType: unknown, scopeId: unknown): MockScopeState {
    const key = buildScopeKey(scopeType, scopeId);
    const existing = MOCK_SCOPE_STATES.get(key);
    if (existing) return existing;

    const created = createScopeState();
    MOCK_SCOPE_STATES.set(key, created);
    return created;
  }

  private checkReferenceConflict(
    scopeState: MockScopeState,
    domain: SyncDomain,
    entityType: SyncEntityType,
    payload: Record<string, unknown>
  ): string | null {
    if (domain === 'account' && entityType === 'account') {
      const profileGlobalUid = resolveProfileGlobalUidFromAccountPayload(payload);
      if (!profileGlobalUid) return null;

      const profileState = scopeState.domains.profile.entities.get(profileGlobalUid);
      if (!profileState || profileState.deletedAt) {
        return `Referenced profile not found: ${profileGlobalUid}`;
      }
      return null;
    }

    return null;
  }

  private extractArtifactRefFromUrl(rawUrl: string, marker: string): string {
    const normalized = String(rawUrl || '').trim();
    if (!normalized) {
      throw new SyncGatewayRequestError('Mock artifact URL is required');
    }
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex < 0) {
      throw new SyncGatewayRequestError(`Mock artifact URL is invalid: ${normalized}`);
    }
    const start = markerIndex + marker.length;
    const remainder = normalized.slice(start);
    const end = remainder.indexOf('?');
    const encoded = end >= 0 ? remainder.slice(0, end) : remainder;
    const artifactRef = decodeURIComponent(encoded || '').trim();
    if (!artifactRef) {
      throw new SyncGatewayRequestError(`Mock artifactRef is missing in URL: ${normalized}`);
    }
    return artifactRef;
  }
}
