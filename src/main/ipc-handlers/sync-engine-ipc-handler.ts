import type { SyncEngineService } from '../sync/sync-engine-service';
import type {
  SyncLegacyCloudMappingMigrationResult,
  SyncLegacyCloudMappingMigrationRunInfo,
} from '../sync/sync-legacy-cloud-mapping-migrator';
import { createIpcHandler } from './utils';

interface SyncEngineIpcExtras {
  migrateLegacyCloudMappings?: () => Promise<SyncLegacyCloudMappingMigrationResult>;
  getLegacyCloudMappingMigrationStatus?: () =>
    | SyncLegacyCloudMappingMigrationRunInfo
    | null
    | Promise<SyncLegacyCloudMappingMigrationRunInfo | null>;
}

export function registerSyncEngineHandlers(
  syncEngineService: SyncEngineService,
  extras: SyncEngineIpcExtras = {}
): void {
  createIpcHandler(
    'sync-engine:get-status',
    async () => {
      return syncEngineService.getStatus();
    },
    '获取同步引擎状态失败'
  );

  createIpcHandler(
    'sync-engine:push-once',
    async (limit?: number) => {
      return await syncEngineService.pushOnce(limit);
    },
    '执行同步推送失败'
  );

  createIpcHandler(
    'sync-engine:pull-once',
    async (pageSize?: number) => {
      return await syncEngineService.pullOnce(pageSize);
    },
    '执行同步拉取失败'
  );

  createIpcHandler(
    'sync-engine:get-auto-sync-config',
    async () => {
      return syncEngineService.getAutoSyncConfig();
    },
    '获取同步自动调度配置失败'
  );

  createIpcHandler(
    'sync-engine:set-auto-sync-config',
    async (config: { enabled?: boolean; intervalMinutes?: number }) => {
      return syncEngineService.setAutoSyncConfig(config || {});
    },
    '设置同步自动调度配置失败'
  );

  createIpcHandler(
    'sync-engine:run-once',
    async () => {
      return await syncEngineService.runOnce();
    },
    '执行同步流程失败'
  );

  createIpcHandler(
    'sync-engine:migrate-legacy-cloud-mappings',
    async () => {
      if (!extras.migrateLegacyCloudMappings) {
        throw new Error('legacy cloud mapping migrator is not available');
      }
      return extras.migrateLegacyCloudMappings();
    },
    '执行旧 cloud-sync 映射迁移失败'
  );

  createIpcHandler(
    'sync-engine:get-legacy-cloud-mapping-migration-status',
    async () => {
      if (!extras.getLegacyCloudMappingMigrationStatus) return null;
      return extras.getLegacyCloudMappingMigrationStatus();
    },
    '获取旧 cloud-sync 映射迁移状态失败'
  );

  console.log('[SyncEngineIPC] Sync engine handlers registered');
}
