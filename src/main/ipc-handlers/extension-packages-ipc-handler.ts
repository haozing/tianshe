import fs from 'fs-extra';
import { BrowserWindow, dialog } from 'electron';
import { getBrowserPoolManager } from '../../core/browser-pool';
import type { ExtensionPackage } from '../../types/profile';
import type { ProfileService } from '../duckdb/profile-service';
import { createIpcHandler } from './utils';
import type { ExtensionPackagesManager } from '../profile/extension-packages-manager';
import type { SyncOutboxService } from '../sync/sync-outbox-service';
import type { BrowserExtensionInstallPackage } from '../../edition/types';

interface RestartRunningBrowsersResult {
  affectedProfiles: string[];
  destroyedBrowsers: number;
  restartFailures: Array<{
    profileId: string;
    error: string;
  }>;
}

async function restartRunningProfileBrowsers(
  profileIds: string[]
): Promise<RestartRunningBrowsersResult> {
  const uniqueProfileIds = Array.from(
    new Set(profileIds.map((id) => String(id || '').trim()).filter((id) => id.length > 0))
  );
  if (uniqueProfileIds.length === 0) {
    return {
      affectedProfiles: [],
      destroyedBrowsers: 0,
      restartFailures: [],
    };
  }

  let poolManager: ReturnType<typeof getBrowserPoolManager>;
  try {
    poolManager = getBrowserPoolManager();
  } catch {
    return {
      affectedProfiles: [],
      destroyedBrowsers: 0,
      restartFailures: [],
    };
  }

  const affectedProfiles: string[] = [];
  let destroyedBrowsers = 0;
  const restartFailures: RestartRunningBrowsersResult['restartFailures'] = [];
  for (const profileId of uniqueProfileIds) {
    try {
      const destroyedCount = await poolManager.destroyProfileBrowsers(profileId);
      if (destroyedCount > 0) {
        affectedProfiles.push(profileId);
        destroyedBrowsers += destroyedCount;
      }
    } catch (error) {
      console.warn(
        `[ExtensionPackagesManagerIPC] Failed to destroy running browsers for profile ${profileId}:`,
        error
      );
      restartFailures.push({
        profileId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
  }

  return {
    affectedProfiles,
    destroyedBrowsers,
    restartFailures,
  };
}

async function assertExtensionProfileTargets(
  profileService: ProfileService,
  profileIds: string[]
): Promise<void> {
  const normalizedProfileIds = Array.from(
    new Set(profileIds.map((id) => String(id || '').trim()).filter((id) => id.length > 0))
  );

  for (const profileId of normalizedProfileIds) {
    const profile = await profileService.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }
    if (profile.engine !== 'extension') {
      throw new Error(`Profile does not support extension packages: ${profile.name}`);
    }
  }
}

export function registerExtensionPackagesManagerHandlers(
  manager: ExtensionPackagesManager,
  profileService: ProfileService,
  options?: {
    syncOutboxService?: SyncOutboxService;
    fetchBrowserExtensionInstallPackage?: (params: {
      extensionId: string;
    }) => Promise<BrowserExtensionInstallPackage>;
  }
): void {
  const syncOutboxService = options?.syncOutboxService;
  const emitExtensionPackageUpsertEvent = async (
    item: ExtensionPackage,
    logSource: string
  ) => {
    void syncOutboxService;
    void item;
    void logSource;
  };

  const emitExtensionPackageDeleteEvent = async (
    item: Pick<ExtensionPackage, 'id' | 'extensionId' | 'version' | 'archiveSha256'>,
    logSource: string
  ) => {
    void syncOutboxService;
    void item;
    void logSource;
  };

  createIpcHandler(
    'extension-packages:select-local-directories',
    async () => {
      const owner = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: '选择扩展目录（支持多选）',
            properties: ['openDirectory', 'multiSelections'],
          })
        : await dialog.showOpenDialog({
            title: '选择扩展目录（支持多选）',
            properties: ['openDirectory', 'multiSelections'],
          });

      return {
        canceled: result.canceled,
        paths: result.canceled ? [] : result.filePaths,
      };
    },
    '选择本地扩展目录失败'
  );

  createIpcHandler(
    'extension-packages:select-local-archives',
    async () => {
      const owner = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: '选择扩展 ZIP 文件（支持多选）',
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: 'ZIP Files', extensions: ['zip'] },
              { name: 'All Files', extensions: ['*'] },
            ],
          })
        : await dialog.showOpenDialog({
            title: '选择扩展 ZIP 文件（支持多选）',
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: 'ZIP Files', extensions: ['zip'] },
              { name: 'All Files', extensions: ['*'] },
            ],
          });

      return {
        canceled: result.canceled,
        paths: result.canceled ? [] : result.filePaths,
      };
    },
    '选择本地扩展压缩包失败'
  );

  createIpcHandler(
    'extension-packages:list-packages',
    () => manager.listPackages(),
    '获取扩展仓库列表失败'
  );

  createIpcHandler(
    'extension-packages:import-local-packages',
    async (inputs: Array<{ path: string; extensionIdHint?: string }>) => {
      const result = await manager.importLocalPackagesDetailed(inputs);
      for (const item of result.succeeded) {
        await emitExtensionPackageUpsertEvent(
          item,
          'extension-packages:import-local-packages'
        );
      }
      return result;
    },
    '导入本地扩展失败'
  );

  createIpcHandler(
    'extension-packages:download-cloud-packages',
    async (
      inputs: Array<{
        extensionId: string;
        version?: string;
        downloadUrl: string;
        archiveSha256?: string;
        name?: string;
      }>
    ) => {
      const result = await manager.downloadCloudPackagesDetailed(inputs);
      for (const item of result.succeeded) {
        await emitExtensionPackageUpsertEvent(
          item,
          'extension-packages:download-cloud-packages'
        );
      }
      return result;
    },
    '下载云端扩展失败'
  );

  const fetchBrowserExtensionInstallPackage = options?.fetchBrowserExtensionInstallPackage;
  if (fetchBrowserExtensionInstallPackage) {
    createIpcHandler(
      'extension-packages:download-cloud-catalog-packages',
      async (
        inputs: Array<{
          extensionId: string;
          name?: string;
        }>
      ) => {
        const normalized = Array.isArray(inputs) ? inputs : [];
        const succeeded: ExtensionPackage[] = [];
        const failed: Array<{ extensionId: string; name?: string; error: string }> = [];

        for (const item of normalized) {
          const extensionId = String(item?.extensionId || '').trim();
          if (!extensionId) continue;

          let tempZipPath = '';
          try {
            const pkg = await fetchBrowserExtensionInstallPackage({
              extensionId,
            });
            tempZipPath = pkg.tempZipPath;
            const sourceUrl = `airpa://browser-extension/${encodeURIComponent(
              pkg.extensionId
            )}/${encodeURIComponent(pkg.releaseVersion || 'latest')}`;
            const installed = await manager.importCloudArchiveFromPath({
              archivePath: pkg.tempZipPath,
              version: pkg.releaseVersion,
              name: String(item?.name || '').trim() || undefined,
              sourceUrl,
            });
            succeeded.push(installed);
            await emitExtensionPackageUpsertEvent(
              installed,
              'extension-packages:download-cloud-catalog-packages'
            );
          } catch (error) {
            failed.push({
              extensionId,
              name: String(item?.name || '').trim() || undefined,
              error: error instanceof Error ? error.message : '未知错误',
            });
          } finally {
            if (tempZipPath) {
              try {
                await fs.remove(tempZipPath);
              } catch {
                // ignore cleanup failures for temporary files
              }
            }
          }
        }

        return {
          succeeded,
          failed,
        };
      },
      '下载云端扩展失败'
    );
  }

  createIpcHandler(
    'extension-packages:list-profile-bindings',
    async (profileId: string) => {
      const normalizedProfileId = String(profileId || '').trim();
      if (!normalizedProfileId) {
        throw new Error('profileId is required');
      }
      await assertExtensionProfileTargets(profileService, [normalizedProfileId]);
      return manager.listProfileBindings(normalizedProfileId);
    },
    '获取环境扩展绑定失败'
  );

  createIpcHandler(
    'extension-packages:batch-bind',
    async (input: {
      profileIds: string[];
      packages: Array<{
        extensionId: string;
        version?: string | null;
        installMode?: 'required' | 'optional';
        sortOrder?: number;
        enabled?: boolean;
      }>;
    }) => {
      await assertExtensionProfileTargets(profileService, input.profileIds || []);
      await manager.bindPackagesToProfiles(input);
      const restartResult = await restartRunningProfileBrowsers(input.profileIds);
      return {
        success: true,
        affectedProfiles: restartResult.affectedProfiles,
        destroyedBrowsers: restartResult.destroyedBrowsers,
        restartFailures: restartResult.restartFailures,
      };
    },
    '批量绑定扩展失败'
  );

  createIpcHandler(
    'extension-packages:batch-unbind',
    async (input: {
      profileIds: string[];
      extensionIds: string[];
      removePackageWhenUnused?: boolean;
    }) => {
      await assertExtensionProfileTargets(profileService, input.profileIds || []);
      const result = await manager.unbindExtensionsFromProfiles(input);
      const restartResult = await restartRunningProfileBrowsers(input.profileIds);
      for (const item of result.removedPackages) {
        await emitExtensionPackageDeleteEvent(
          item,
          'extension-packages:batch-unbind'
        );
      }
      return {
        removedBindings: result.removedBindings,
        removedPackages: result.removedPackages.map(
          (item) => `${item.extensionId}@@${item.version}`
        ),
        affectedProfiles: restartResult.affectedProfiles,
        destroyedBrowsers: restartResult.destroyedBrowsers,
        restartFailures: restartResult.restartFailures,
      };
    },
    '批量解绑扩展失败'
  );
}

