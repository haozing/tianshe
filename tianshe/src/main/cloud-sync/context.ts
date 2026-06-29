export function getCurrentCloudSyncScopeKey(): string {
  return 'company:0';
}

export function getCurrentCloudMappingScopeKey(): string {
  return getCurrentCloudSyncScopeKey();
}

export function setCurrentAccountBundleDirty(_dirty: boolean): void {}
