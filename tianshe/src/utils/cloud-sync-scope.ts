export type CloudSyncScopeId = string | number;

export interface CloudSyncScope {
  scopeType: string;
  scopeId: CloudSyncScopeId;
}

export interface CloudSyncScopeOptions {
  defaultScopeType?: string;
  defaultScopeId?: CloudSyncScopeId;
}

export const DEFAULT_CLOUD_SYNC_SCOPE_TYPE = 'company';
export const DEFAULT_CLOUD_SYNC_SCOPE_ID = 0;

function resolveDefaultScopeType(options?: CloudSyncScopeOptions): string {
  const scopeType = String(options?.defaultScopeType || '').trim().toLowerCase();
  return scopeType || DEFAULT_CLOUD_SYNC_SCOPE_TYPE;
}

function resolveDefaultScopeId(options?: CloudSyncScopeOptions): CloudSyncScopeId {
  const fallback = options?.defaultScopeId ?? DEFAULT_CLOUD_SYNC_SCOPE_ID;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return Math.trunc(fallback);
  }
  const text = String(fallback ?? '').trim();
  if (!text) return DEFAULT_CLOUD_SYNC_SCOPE_ID;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : text;
}

function hasScopeValue(rawScopeType: unknown, rawScopeId: unknown): boolean {
  if (typeof rawScopeType === 'string' && rawScopeType.trim().length > 0) {
    return true;
  }
  if (typeof rawScopeId === 'number' && Number.isFinite(rawScopeId)) {
    return true;
  }
  if (typeof rawScopeId === 'string' && rawScopeId.trim().length > 0) {
    return true;
  }
  return false;
}

export function getDefaultCloudSyncScope(options?: CloudSyncScopeOptions): CloudSyncScope {
  return {
    scopeType: resolveDefaultScopeType(options),
    scopeId: resolveDefaultScopeId(options),
  };
}

export function normalizeCloudScope(
  rawScopeType: unknown,
  rawScopeId: unknown,
  options?: CloudSyncScopeOptions
): CloudSyncScope {
  const scopeType =
    String(rawScopeType || '').trim().toLowerCase() || resolveDefaultScopeType(options);

  if (typeof rawScopeId === 'number' && Number.isFinite(rawScopeId)) {
    return {
      scopeType,
      scopeId: Math.trunc(rawScopeId),
    };
  }

  const scopeIdText = String(rawScopeId ?? '').trim();
  if (!scopeIdText) {
    return {
      scopeType,
      scopeId: resolveDefaultScopeId(options),
    };
  }

  const numericScopeId = Number(scopeIdText);
  return {
    scopeType,
    scopeId: Number.isFinite(numericScopeId) ? Math.trunc(numericScopeId) : scopeIdText,
  };
}

export function buildCloudScopeKey(scope: Pick<CloudSyncScope, 'scopeType' | 'scopeId'>): string {
  const normalized = normalizeCloudScope(scope.scopeType, scope.scopeId);
  return `${normalized.scopeType}:${String(normalized.scopeId)}`;
}

export function parseCloudScopeKey(
  value: unknown,
  options?: CloudSyncScopeOptions
): CloudSyncScope | null {
  const text = String(value || '').trim();
  if (!text) return null;

  const separatorIndex = text.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= text.length - 1) {
    return null;
  }

  const scopeType = text.slice(0, separatorIndex).trim();
  const scopeId = text.slice(separatorIndex + 1).trim();
  if (!scopeType || !scopeId) {
    return null;
  }

  return normalizeCloudScope(scopeType, scopeId, options);
}

export function isSameCloudScope(
  left: Pick<CloudSyncScope, 'scopeType' | 'scopeId'> | null | undefined,
  right: Pick<CloudSyncScope, 'scopeType' | 'scopeId'> | null | undefined
): boolean {
  if (!left || !right) return false;
  return buildCloudScopeKey(left) === buildCloudScopeKey(right);
}

export function normalizeCloudScopeList(
  raw: unknown,
  options?: CloudSyncScopeOptions
): CloudSyncScope[] {
  if (!Array.isArray(raw)) return [];

  const normalized: CloudSyncScope[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (!hasScopeValue(row.scopeType, row.scopeId)) {
      continue;
    }
    const scope = normalizeCloudScope(row.scopeType, row.scopeId, options);
    const key = buildCloudScopeKey(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(scope);
  }
  return normalized;
}

export function buildCloudSessionMetaKey(params: {
  authSessionId: unknown;
}): string | null {
  const authSessionId = String(params.authSessionId || '').trim();
  return authSessionId || null;
}

export function buildCloudScopeMetaKey(params: {
  sessionMetaKey: string | null | undefined;
  scope: Pick<CloudSyncScope, 'scopeType' | 'scopeId'>;
}): string | null {
  const sessionMetaKey = String(params.sessionMetaKey || '').trim();
  if (!sessionMetaKey) return null;
  return `${buildCloudScopeKey(params.scope)}@${sessionMetaKey}`;
}
