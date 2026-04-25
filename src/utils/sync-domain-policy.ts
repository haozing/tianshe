import type { SyncDomain } from '../types/sync-contract';

export const ACCOUNT_CENTER_BUNDLE_DOMAINS = ['account', 'profile'] as const satisfies readonly SyncDomain[];
export const GENERIC_SYNC_RUNTIME_DOMAINS = ['extension'] as const satisfies readonly SyncDomain[];

const GENERIC_SYNC_RUNTIME_DOMAIN_SET = new Set<SyncDomain>(GENERIC_SYNC_RUNTIME_DOMAINS);

export function filterGenericSyncRuntimeDomains(domains: readonly SyncDomain[]): SyncDomain[] {
  return domains.filter((domain) => GENERIC_SYNC_RUNTIME_DOMAIN_SET.has(domain));
}

export function isBundleManagedSyncDomain(domain: SyncDomain): boolean {
  return (ACCOUNT_CENTER_BUNDLE_DOMAINS as readonly SyncDomain[]).includes(domain);
}

export function describeSyncRuntimeBoundary(managedDomains: readonly SyncDomain[]): string {
  const normalizedManaged = filterGenericSyncRuntimeDomains(managedDomains);
  const managedText = normalizedManaged.length > 0 ? normalizedManaged.join(' / ') : '无';
  const bundleText = ACCOUNT_CENTER_BUNDLE_DOMAINS.join(' / ');
  return `generic sync 仅管理 ${managedText}；${bundleText} 仍走账号 bundle 主链路`;
}
