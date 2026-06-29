export interface SyncLegacyCloudMappingMigrationResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

export interface SyncLegacyCloudMappingMigrationRunInfo
  extends SyncLegacyCloudMappingMigrationResult {
  startedAt: string;
  finishedAt?: string;
}

export async function migrateLegacyCloudMappings(): Promise<SyncLegacyCloudMappingMigrationResult> {
  return { migrated: 0, skipped: 0, errors: [] };
}

export function getLegacyCloudMappingMigrationStatus(): SyncLegacyCloudMappingMigrationRunInfo | null {
  return null;
}
