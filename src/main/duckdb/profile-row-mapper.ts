import type {
  BrowserProfile,
  FingerprintConfig,
  FingerprintCoreConfig,
  FingerprintSourceConfig,
  ProfileStatus,
  ProxyConfig,
  BrowserRuntimeSource,
} from '../../types/profile';
import { normalizeBrowserRuntimeId } from '../../types/profile';
import { DEFAULT_BROWSER_POOL_CONFIG } from '../../constants/browser-pool';
import {
  extractFingerprintCoreConfig,
  materializeFingerprintConfigForRuntime,
} from '../../constants/fingerprint-defaults';

export function mapProfileRowToProfile(row: any): BrowserProfile {
  const runtimeId = normalizeBrowserRuntimeId(row.runtime_id);
  const fingerprint = materializeFingerprintConfigForRuntime(
    parseProfileJson<FingerprintConfig>(row.fingerprint),
    runtimeId
  );
  const fingerprintCore =
    parseProfileJson<FingerprintCoreConfig | null>(row.fingerprint_core) ||
    extractFingerprintCoreConfig(fingerprint);
  const fingerprintSource =
    parseProfileJson<FingerprintSourceConfig | null>(row.fingerprint_source) ||
    fingerprint.source;

  return {
    id: String(row.id),
    name: String(row.name),
    runtimeId,
    runtimeSourceOverride: row.runtime_source_override
      ? parseProfileJson<BrowserRuntimeSource>(row.runtime_source_override)
      : null,
    groupId: row.group_id ? String(row.group_id) : null,
    partition: String(row.partition),
    proxy: row.proxy_config ? parseProfileJson<ProxyConfig>(row.proxy_config) : null,
    fingerprint,
    fingerprintCore,
    fingerprintSource,
    notes: row.notes ? String(row.notes) : null,
    tags: parseProfileJson<string[]>(row.tags) || [],
    color: row.color ? String(row.color) : null,
    status: (row.status as ProfileStatus) || 'idle',
    lastError: row.last_error ? String(row.last_error) : null,
    lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
    totalUses: Number(row.total_uses) || 0,
    quota: Number(row.quota) || 1,
    idleTimeoutMs: Number(row.idle_timeout_ms) || DEFAULT_BROWSER_POOL_CONFIG.defaultIdleTimeoutMs,
    lockTimeoutMs: Number(row.lock_timeout_ms) || DEFAULT_BROWSER_POOL_CONFIG.defaultLockTimeoutMs,
    loginStateRevision: Number(row.login_state_revision) || 0,
    isSystem: row.is_system === true || row.is_system === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function parseProfileJson<T>(value: any): T {
  if (!value) return value;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value));
  } catch {
    return value as T;
  }
}
