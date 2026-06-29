/**
 * JS plugin installation and update coordinator.
 *
 * Keeps local/cloud install flows outside JSPluginManager while preserving the manager public API.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import type { IDuckDBService } from '../../types/duckdb';
import type { JSPluginInfo, JSPluginImportResult, JSPluginManifest } from '../../types/js-plugin';
import { extractPlugin, readManifest } from './loader';
import { createLogger } from '../logger';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../observability/observation-context';
import { observationService, summarizeForObservation } from '../observability/observation-service';
import { attachErrorContextArtifact } from '../observability/error-context-artifact';
import { assertTrustedFirstPartyPluginImport } from './trust-policy';
import type { PluginImportOptions, PluginLoader } from './plugin-loader';
import type { PluginLifecycleManager } from './plugin-lifecycle';
import type { PluginTableCreationResult } from './plugin-installer';
import type { PluginInstaller } from './plugin-installer';
import type { UIExtensionManager } from './ui-extension-manager';
import { getUnknownErrorMessage } from '../../utils/error-message';

const logger = createLogger('JSPluginInstallationCoordinator');

export type PreparedPluginSource = {
  manifest: JSPluginManifest;
  extractedPath?: string;
  tempRoot?: string;
  kind: 'directory' | 'archive';
};

function parseVersionParts(version: string): number[] {
  return String(version || '')
    .trim()
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part >= 0);
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

/**
 * JS 插件管理器（门面类）
 */

export interface PluginInstallationCoordinatorDeps {
  duckdb: IDuckDBService;
  loader: PluginLoader;
  lifecycle: PluginLifecycleManager;
  installer: PluginInstaller;
  uiExtManager: UIExtensionManager;
  getPluginInfo: (pluginId: string) => Promise<JSPluginInfo | null>;
  load: (pluginId: string) => Promise<void>;
  reload: (pluginId: string) => Promise<void>;
  deactivate: (pluginId: string, options?: { force?: boolean }) => Promise<void>;
}

export class PluginInstallationCoordinator {
  constructor(private deps: PluginInstallationCoordinatorDeps) {}

  private get duckdb(): IDuckDBService {
    return this.deps.duckdb;
  }

  private get loader(): PluginLoader {
    return this.deps.loader;
  }

  private get lifecycle(): PluginLifecycleManager {
    return this.deps.lifecycle;
  }

  private get installer(): PluginInstaller {
    return this.deps.installer;
  }

  private get uiExtManager(): UIExtensionManager {
    return this.deps.uiExtManager;
  }

  private getPluginInfo(pluginId: string): Promise<JSPluginInfo | null> {
    return this.deps.getPluginInfo(pluginId);
  }

  private load(pluginId: string): Promise<void> {
    return this.deps.load(pluginId);
  }

  private reload(pluginId: string): Promise<void> {
    return this.deps.reload(pluginId);
  }

  private deactivate(pluginId: string, options?: { force?: boolean }): Promise<void> {
    return this.deps.deactivate(pluginId, options);
  }

  /**
   * 导入插件
   */
  async importPlugin(
    sourcePath: string,
    options?: PluginImportOptions
  ): Promise<JSPluginImportResult> {
    const importOptions: PluginImportOptions = {
      ...options,
      trustedFirstParty: options?.trustedFirstParty !== false,
    };
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      source: currentTraceContext?.source ?? 'plugin-manager',
      attributes: {
        sourcePath,
        sourceType:
          importOptions.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private',
      },
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'plugin-manager',
        event: 'plugin.lifecycle.install',
        attrs: {
          sourcePath: summarizeForObservation(sourcePath, 1),
          sourceType:
            importOptions.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private',
          devMode: importOptions.devMode === true,
        },
      });

      const prepared = await this.preparePluginSource(sourcePath, '_temp_local_import');
      try {
        assertTrustedFirstPartyPluginImport(prepared.manifest, importOptions);
        const existing = await this.getPluginInfo(prepared.manifest.id);
        const sourceType =
          importOptions.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private';

        let result: JSPluginImportResult;
        if (!existing) {
          result = await this.loader.import(sourcePath, importOptions, {
            getPluginInfo: (id) => this.getPluginInfo(id),
            createFolderAndTables: async (manifest) => {
              const tableResults: PluginTableCreationResult[] = [];
              let folderId: string | null = null;
              // 创建插件专属文件夹
              const folderService = this.duckdb.getFolderService();
              folderId = await folderService.createFolder(manifest.name, null, manifest.id, {
                icon: manifest.icon || '🔌',
                description: manifest.description || '',
              });
              logger.info(`  ✓ Created plugin folder: ${manifest.name} (${folderId})`);

              try {
                // 创建数据表
                let tableNameToDatasetId: Map<string, string> | null = null;
                if (manifest.dataTables && manifest.dataTables.length > 0) {
                  tableNameToDatasetId = await this.installer.createTables(
                    manifest,
                    folderId,
                    undefined,
                    {
                      onTableResult: (result) => tableResults.push(result),
                    }
                  );
                }

                return { folderId, tableNameToDatasetId, tableResults };
              } catch (error: unknown) {
                await this.cleanupFirstInstallFolder(manifest.id, folderId).catch(
                  (cleanupError) => {
                    logger.error('Failed to cleanup plugin folder after table creation failure', {
                      pluginId: manifest.id,
                      error: getUnknownErrorMessage(cleanupError) || String(cleanupError),
                    });
                  }
                );
                throw error;
              }
            },
            saveUIContributions: (manifest, tableNameToDatasetId) =>
              this.uiExtManager.saveUIContributions(manifest, tableNameToDatasetId),
            unregisterUIContributions: (id) => this.uiExtManager.unregisterUIContributions(id),
            loadPlugin: (id) => this.load(id),
            rollbackTables: (results) => this.installer.rollbackTableCreationResults(results),
            cleanupFolder: (id, folderId) => this.cleanupFirstInstallFolder(id, folderId),
            cleanupMetadata: (id) => this.cleanupFirstInstallMetadata(id),
          });
        } else if (sourceType !== 'cloud_managed' && existing.sourceType === 'cloud_managed') {
          result = {
            success: false,
            error:
              `Plugin ${prepared.manifest.id} is cloud-managed. ` +
              `Please update it from the plugin market or uninstall it first.`,
          };
        } else {
          result = await this.replaceInstalledLocalPlugin(
            existing,
            prepared,
            sourcePath,
            importOptions
          );
        }

        if (result.success && !result.operation) {
          result.operation = 'installed';
        }

        if (!result.success) {
          throw new Error(result.error || 'Plugin install failed');
        }

        await span.succeed({
          attrs: {
            pluginId: result.pluginId,
            sourceType,
            operation: result.operation || 'installed',
            ...(result.warnings?.length ? { warnings: result.warnings } : {}),
          },
        });
        return result;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'plugin-manager',
          label: 'plugin install failure context',
          data: {
            sourcePath: summarizeForObservation(sourcePath, 1),
            sourceType:
              importOptions.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private',
            devMode: importOptions.devMode === true,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            sourcePath: summarizeForObservation(sourcePath, 1),
            sourceType:
              importOptions.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private',
            devMode: importOptions.devMode === true,
          },
        });
        if (error instanceof Error && getUnknownErrorMessage(error) === 'Plugin install failed') {
          return {
            success: false,
            error: getUnknownErrorMessage(error),
          };
        }
        if (error instanceof Error && String(getUnknownErrorMessage(error) || '').trim()) {
          return {
            success: false,
            error: getUnknownErrorMessage(error),
          };
        }
        return {
          success: false,
          error: String(error),
        };
      } finally {
        await this.cleanupPreparedPluginSource(prepared);
      }
    });
  }

  /**
   * 加载插件模块
   */
  async installOrUpdateCloudPlugin(
    sourcePath: string,
    options?: PluginImportOptions
  ): Promise<JSPluginImportResult> {
    const importOptions: PluginImportOptions = {
      ...options,
      trustedFirstParty: true,
    };
    const cloudPluginCode = String(options?.cloudPluginCode || '').trim();
    if (!cloudPluginCode) {
      return {
        success: false,
        error: 'cloudPluginCode is required for cloud-managed install',
      };
    }

    const tempRoot = path.join(this.loader.getPluginsDir(), `_temp_cloud_install_${Date.now()}`);
    try {
      const extractedPath = await extractPlugin(sourcePath, tempRoot);
      const manifest = await readManifest(extractedPath);
      assertTrustedFirstPartyPluginImport(manifest, importOptions);
      const existing = await this.findPluginForCloudUpdate(cloudPluginCode, manifest.id);

      if (!existing) {
        const result = await this.importPlugin(sourcePath, importOptions);
        if (result.success) {
          result.operation = 'installed';
        }
        return result;
      }

      const currentTraceContext = getCurrentTraceContext();
      const traceContext = createChildTraceContext({
        pluginId: existing.id,
        source: currentTraceContext?.source ?? 'plugin-manager',
        attributes: {
          sourceType: 'cloud_managed',
          cloudPluginCode,
        },
      });

      return await withTraceContext(traceContext, async () => {
        const span = await observationService.startSpan({
          context: traceContext,
          component: 'plugin-manager',
          event: 'plugin.lifecycle.install',
          attrs: {
            pluginId: existing.id,
            sourceType: 'cloud_managed',
            cloudPluginCode,
            sourcePath: summarizeForObservation(sourcePath, 1),
          },
        });

        try {
          if (existing.id !== manifest.id) {
            throw new Error(
              `[MANIFEST_ID_MISMATCH] Installed plugin ${existing.id} does not match package manifest ${manifest.id}`
            );
          }

          const nextVersion = String(options?.cloudReleaseVersion || manifest.version || '').trim();
          const currentVersion = String(
            existing.cloudReleaseVersion || existing.version || ''
          ).trim();
          if (currentVersion && nextVersion) {
            const compareResult = compareVersionStrings(currentVersion, nextVersion);
            if (compareResult === 0) {
              throw new Error(
                `[ALREADY_LATEST] Installed release ${currentVersion} is already latest`
              );
            }
            if (compareResult > 0) {
              throw new Error(
                `[LOCAL_VERSION_NEWER] Installed release ${currentVersion} is newer than cloud release ${nextVersion}`
              );
            }
          }

          const result = await this.replaceInstalledCloudPlugin(
            existing,
            manifest,
            extractedPath,
            importOptions
          );
          if (!result.success) {
            throw new Error(result.error || 'Cloud plugin install failed');
          }

          await span.succeed({
            attrs: {
              pluginId: existing.id,
              sourceType: 'cloud_managed',
              cloudPluginCode,
              operation: result.operation || 'updated',
            },
          });
          return result;
        } catch (error: unknown) {
          const artifact = await attachErrorContextArtifact({
            span,
            component: 'plugin-manager',
            label: 'cloud plugin install failure context',
            data: {
              pluginId: existing.id,
              sourceType: 'cloud_managed',
              cloudPluginCode,
            },
          });
          await span.fail(error, {
            artifactRefs: [artifact.artifactId],
            attrs: {
              pluginId: existing.id,
              sourceType: 'cloud_managed',
              cloudPluginCode,
            },
          });
          return {
            success: false,
            error: getUnknownErrorMessage(error) || String(error),
          };
        }
      });
    } catch (error: unknown) {
      logger.error('[CloudPlugin] install/update failed', error);
      return {
        success: false,
        error: getUnknownErrorMessage(error) || String(error),
      };
    } finally {
      if (tempRoot && (await fs.pathExists(tempRoot))) {
        await fs.remove(tempRoot).catch(() => {});
      }
    }
  }

  private async findPluginForCloudUpdate(
    cloudPluginCode: string,
    manifestId: string
  ): Promise<JSPluginInfo | null> {
    const normalizedCloudPluginCode = String(cloudPluginCode || '').trim();
    if (normalizedCloudPluginCode) {
      const rows = await this.duckdb.executeSQLWithParams(
        `SELECT id FROM js_plugins
         WHERE cloud_plugin_code = ?
         ORDER BY installed_at DESC
         LIMIT 1`,
        [normalizedCloudPluginCode]
      );
      const pluginId = String(rows?.[0]?.id || '').trim();
      if (pluginId) {
        return this.getPluginInfo(pluginId);
      }
    }

    const normalizedManifestId = String(manifestId || '').trim();
    if (!normalizedManifestId) {
      return null;
    }
    return this.getPluginInfo(normalizedManifestId);
  }

  private async cleanupFirstInstallFolder(
    pluginId: string,
    folderId?: string | null
  ): Promise<void> {
    if (folderId) {
      await this.duckdb.executeWithParams(`DELETE FROM dataset_folders WHERE id = ?`, [folderId]);
      return;
    }

    await this.duckdb.executeWithParams(`DELETE FROM dataset_folders WHERE plugin_id = ?`, [
      pluginId,
    ]);
  }

  private async cleanupFirstInstallMetadata(pluginId: string): Promise<void> {
    await this.uiExtManager.unregisterUIContributions(pluginId).catch(() => {});

    const loadedPlugin = this.lifecycle.getPlugin(pluginId);
    if (loadedPlugin) {
      await this.deactivate(pluginId, { force: true }).catch((deactivateError) => {
        logger.error('Failed to deactivate plugin during first-install cleanup', {
          pluginId,
          error: getUnknownErrorMessage(deactivateError) || String(deactivateError),
        });
      });
      this.loader.unloadModule(loadedPlugin.path, pluginId);
    }
    this.lifecycle.deletePlugin(pluginId);

    await this.duckdb.executeWithParams(`DELETE FROM js_plugins WHERE id = ?`, [pluginId]);
  }

  private async replaceInstalledCloudPlugin(
    existing: JSPluginInfo,
    manifest: JSPluginManifest,
    extractedPath: string,
    options?: PluginImportOptions
  ): Promise<JSPluginImportResult> {
    const installPath = existing.path;
    const backupPath = `${installPath}.__backup__.${Date.now()}`;
    const hadInstallPath = await fs.pathExists(installPath);
    const previousManifest = hadInstallPath
      ? await readManifest(installPath).catch(() => null)
      : null;
    const shouldReload = existing.enabled !== false;
    let metadataUpdated = false;

    try {
      if (this.lifecycle.hasPlugin(existing.id)) {
        const loadedPlugin = this.lifecycle.getPlugin(existing.id);
        await this.deactivate(existing.id, { force: true });
        if (loadedPlugin) {
          this.loader.unloadModule(loadedPlugin.path, existing.id);
        }
        this.lifecycle.deletePlugin(existing.id);
      }

      if (hadInstallPath) {
        await fs.move(installPath, backupPath, { overwrite: true });
      }
      await fs.ensureDir(path.dirname(installPath));
      await fs.move(extractedPath, installPath, { overwrite: true });

      await this.updateInstalledPluginMetadata(existing, manifest, installPath, options);
      metadataUpdated = true;

      const folderId = await this.ensurePluginFolder(existing.id, manifest);
      const tableNameToDatasetId =
        manifest.dataTables && manifest.dataTables.length > 0
          ? await this.installer.createTables(manifest, folderId)
          : new Map<string, string>();

      await this.uiExtManager.unregisterUIContributions(existing.id);
      if (manifest.contributes) {
        await this.uiExtManager.saveUIContributions(manifest, tableNameToDatasetId);
      }

      if (shouldReload) {
        await this.load(existing.id);
      }

      if (await fs.pathExists(backupPath)) {
        await fs.remove(backupPath);
      }

      return {
        success: true,
        pluginId: existing.id,
        operation: 'updated',
      };
    } catch (error: unknown) {
      logger.error('[CloudPlugin] failed to replace installed plugin', {
        pluginId: existing.id,
        error: getUnknownErrorMessage(error) || String(error),
      });

      if (await fs.pathExists(installPath)) {
        await fs.remove(installPath).catch(() => {});
      }
      if (await fs.pathExists(backupPath)) {
        await fs.move(backupPath, installPath, { overwrite: true }).catch(() => {});
      }
      if (metadataUpdated && previousManifest) {
        await this.restoreInstalledPluginMetadata(existing, previousManifest, installPath).catch(
          (restoreError) => {
            logger.error('[CloudPlugin] failed to restore plugin metadata', restoreError);
          }
        );
      }
      if (shouldReload && (await fs.pathExists(installPath))) {
        await this.load(existing.id).catch((reloadError) => {
          logger.error('[CloudPlugin] failed to reload restored plugin', reloadError);
        });
      }

      return {
        success: false,
        error: getUnknownErrorMessage(error) || String(error),
      };
    }
  }

  private async replaceInstalledLocalPlugin(
    existing: JSPluginInfo,
    prepared: PreparedPluginSource,
    sourcePath: string,
    options?: PluginImportOptions
  ): Promise<JSPluginImportResult> {
    const installPath = existing.path;
    const backupPath = `${installPath}.__backup__.${Date.now()}`;
    const hadInstallPath = await fs.pathExists(installPath);
    const previousManifest = hadInstallPath
      ? await readManifest(installPath).catch(() => null)
      : null;
    const shouldReload = existing.enabled !== false;
    let metadataUpdated = false;
    let stagedTempRoot: string | null = null;

    try {
      if (this.lifecycle.hasPlugin(existing.id)) {
        const loadedPlugin = this.lifecycle.getPlugin(existing.id);
        await this.deactivate(existing.id, { force: true });
        if (loadedPlugin) {
          this.loader.unloadModule(loadedPlugin.path, existing.id);
        }
        this.lifecycle.deletePlugin(existing.id);
      }

      if (hadInstallPath) {
        await fs.move(installPath, backupPath, { overwrite: true });
      }
      await fs.ensureDir(path.dirname(installPath));

      const installResult = await this.installLocalPluginAtPath(
        installPath,
        sourcePath,
        prepared,
        options
      );
      stagedTempRoot = installResult.cleanupRoot || null;

      await this.updateInstalledPluginMetadata(existing, prepared.manifest, installPath, {
        ...options,
        sourceType: 'local_private',
        installChannel: 'manual_import',
        cloudPluginCode: undefined,
        cloudReleaseVersion: undefined,
        managedByPolicy: false,
        policyVersion: undefined,
        lastPolicySyncAt: undefined,
        devMode: installResult.devMode,
        sourcePath: installResult.sourcePath,
        isSymlink: installResult.isSymlink,
        hotReloadEnabled: installResult.hotReloadEnabled,
      });
      metadataUpdated = true;

      const folderId = await this.ensurePluginFolder(existing.id, prepared.manifest);
      const tableNameToDatasetId =
        prepared.manifest.dataTables && prepared.manifest.dataTables.length > 0
          ? await this.installer.createTables(prepared.manifest, folderId)
          : new Map<string, string>();

      await this.uiExtManager.unregisterUIContributions(existing.id);
      if (prepared.manifest.contributes) {
        await this.uiExtManager.saveUIContributions(prepared.manifest, tableNameToDatasetId);
      }

      if (shouldReload) {
        await this.load(existing.id);
      }

      if (await fs.pathExists(backupPath)) {
        await fs.remove(backupPath);
      }
      if (stagedTempRoot && (await fs.pathExists(stagedTempRoot))) {
        await fs.remove(stagedTempRoot);
      }

      return {
        success: true,
        pluginId: existing.id,
        operation: 'updated',
        warnings: installResult.warnings.length > 0 ? installResult.warnings : undefined,
      };
    } catch (error: unknown) {
      logger.error('[LocalPlugin] failed to replace installed plugin', {
        pluginId: existing.id,
        error: getUnknownErrorMessage(error) || String(error),
      });

      if (stagedTempRoot && (await fs.pathExists(stagedTempRoot))) {
        await fs.remove(stagedTempRoot).catch(() => {});
      }
      if (await fs.pathExists(installPath)) {
        await fs.remove(installPath).catch(() => {});
      }
      if (await fs.pathExists(backupPath)) {
        await fs.move(backupPath, installPath, { overwrite: true }).catch(() => {});
      }
      if (metadataUpdated && previousManifest) {
        await this.restoreInstalledPluginMetadata(existing, previousManifest, installPath).catch(
          (restoreError) => {
            logger.error('[LocalPlugin] failed to restore plugin metadata', restoreError);
          }
        );
      }
      if (shouldReload && (await fs.pathExists(installPath))) {
        await this.load(existing.id).catch((reloadError) => {
          logger.error('[LocalPlugin] failed to reload restored plugin', reloadError);
        });
      }

      return {
        success: false,
        error: getUnknownErrorMessage(error) || String(error),
      };
    }
  }

  private async ensurePluginFolder(pluginId: string, manifest: JSPluginManifest): Promise<string> {
    const folderService = this.duckdb.getFolderService();
    const rows = await this.duckdb.executeSQLWithParams(
      `SELECT id FROM dataset_folders
       WHERE plugin_id = ?
       ORDER BY created_at ASC
       LIMIT 1`,
      [pluginId]
    );
    const folderId = String(rows?.[0]?.id || '').trim();
    if (folderId) {
      await folderService.updateFolder(folderId, {
        name: manifest.name,
        icon: manifest.icon || 'package',
        description: manifest.description || '',
      });
      return folderId;
    }

    return folderService.createFolder(manifest.name, null, pluginId, {
      icon: manifest.icon || 'package',
      description: manifest.description || '',
    });
  }

  private async updateInstalledPluginMetadata(
    existing: JSPluginInfo,
    manifest: JSPluginManifest,
    pluginPath: string,
    options?: PluginImportOptions & {
      devMode?: boolean;
      sourcePath?: string | null;
      isSymlink?: boolean;
      hotReloadEnabled?: boolean;
    }
  ): Promise<void> {
    const sourceType = options?.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private';
    const installChannel =
      options?.installChannel === 'cloud_download' ? 'cloud_download' : 'manual_import';
    const cloudPluginCode = String(
      options?.cloudPluginCode || existing.cloudPluginCode || ''
    ).trim();
    const cloudReleaseVersion = String(
      options?.cloudReleaseVersion || existing.cloudReleaseVersion || manifest.version || ''
    ).trim();
    const managedByPolicy =
      options?.managedByPolicy === true || existing.managedByPolicy === true ? 1 : 0;
    const policyVersion = String(options?.policyVersion || existing.policyVersion || '').trim();
    const lastPolicySyncAt =
      typeof options?.lastPolicySyncAt === 'number' && Number.isFinite(options.lastPolicySyncAt)
        ? Math.trunc(options.lastPolicySyncAt)
        : typeof existing.lastPolicySyncAt === 'number' &&
            Number.isFinite(existing.lastPolicySyncAt)
          ? Math.trunc(existing.lastPolicySyncAt)
          : null;

    await this.duckdb.executeWithParams(
      `UPDATE js_plugins
       SET name = ?, version = ?, author = ?, description = ?, icon = ?, category = ?, main = ?, path = ?,
           enabled = ?, dev_mode = ?, source_path = ?, is_symlink = ?, hot_reload_enabled = ?,
           source_type = ?, install_channel = ?, cloud_plugin_code = ?, cloud_release_version = ?,
           managed_by_policy = ?, policy_version = ?, last_policy_sync_at = ?
       WHERE id = ?`,
      [
        manifest.name,
        manifest.version,
        manifest.author,
        manifest.description || null,
        manifest.icon || null,
        manifest.category || null,
        manifest.main,
        pluginPath,
        existing.enabled !== false,
        options?.devMode === true,
        options?.sourcePath ?? null,
        options?.isSymlink === true,
        options?.hotReloadEnabled === true,
        sourceType,
        installChannel,
        cloudPluginCode || null,
        cloudReleaseVersion || null,
        managedByPolicy,
        policyVersion || null,
        lastPolicySyncAt,
        existing.id,
      ]
    );
  }

  private async restoreInstalledPluginMetadata(
    existing: JSPluginInfo,
    manifest: JSPluginManifest,
    pluginPath: string
  ): Promise<void> {
    await this.duckdb.executeWithParams(
      `UPDATE js_plugins
       SET name = ?, version = ?, author = ?, description = ?, icon = ?, category = ?, main = ?, path = ?,
           enabled = ?, dev_mode = ?, source_path = ?, is_symlink = ?, hot_reload_enabled = ?,
           source_type = ?, install_channel = ?, cloud_plugin_code = ?, cloud_release_version = ?,
           managed_by_policy = ?, policy_version = ?, last_policy_sync_at = ?
       WHERE id = ?`,
      [
        existing.name,
        existing.version,
        existing.author,
        existing.description || null,
        existing.icon || null,
        existing.category || null,
        manifest.main,
        pluginPath,
        existing.enabled !== false,
        existing.devMode === true,
        existing.sourcePath || null,
        existing.isSymlink === true,
        existing.hotReloadEnabled === true,
        existing.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private',
        existing.installChannel === 'cloud_download' ? 'cloud_download' : 'manual_import',
        existing.cloudPluginCode || null,
        existing.cloudReleaseVersion || null,
        existing.managedByPolicy === true ? 1 : 0,
        existing.policyVersion || null,
        typeof existing.lastPolicySyncAt === 'number' ? existing.lastPolicySyncAt : null,
        existing.id,
      ]
    );
  }

  async preparePluginSource(sourcePath: string, tempPrefix: string): Promise<PreparedPluginSource> {
    const stats = await fs.stat(sourcePath);
    if (stats.isDirectory()) {
      return {
        manifest: await readManifest(sourcePath),
        kind: 'directory',
      };
    }

    const ext = path.extname(sourcePath).toLowerCase();
    if (ext !== '.zip' && ext !== '.tsai') {
      throw new Error(`不支持的文件格式: ${ext}。请使用 .zip 或 .tsai 文件，或选择插件目录。`);
    }

    const tempRoot = path.join(this.loader.getPluginsDir(), `${tempPrefix}_${Date.now()}`);
    await fs.ensureDir(tempRoot);
    const extractedPath = await extractPlugin(sourcePath, tempRoot);

    return {
      manifest: await readManifest(extractedPath),
      extractedPath,
      tempRoot,
      kind: 'archive',
    };
  }

  async cleanupPreparedPluginSource(
    prepared: PreparedPluginSource | null | undefined
  ): Promise<void> {
    if (!prepared?.tempRoot) {
      return;
    }

    if (await fs.pathExists(prepared.tempRoot)) {
      await fs.remove(prepared.tempRoot).catch(() => {});
    }
  }

  private async installLocalPluginAtPath(
    installPath: string,
    sourcePath: string,
    prepared: PreparedPluginSource,
    options?: PluginImportOptions
  ): Promise<{
    devMode: boolean;
    sourcePath: string | null;
    isSymlink: boolean;
    hotReloadEnabled: boolean;
    warnings: string[];
    cleanupRoot?: string;
  }> {
    const warnings: string[] = [];

    if (options?.devMode && prepared.kind === 'directory') {
      const linkCreated = await this.loader.createSymbolicLink(sourcePath, installPath);
      if (linkCreated) {
        return {
          devMode: true,
          sourcePath,
          isSymlink: true,
          hotReloadEnabled: true,
          warnings,
        };
      }

      warnings.push(
        '无法创建符号链接（可能是源目录和安装目录在不同驱动器），已自动降级为复制模式。\n' +
          '在此模式下，修改源代码后需要重新导入插件才能生效。'
      );
    } else if (options?.devMode && prepared.kind === 'archive') {
      warnings.push('压缩文件不支持开发模式（无法创建符号链接），已自动切换为生产模式。');
    }

    let stagedPath = prepared.extractedPath;
    let cleanupRoot: string | undefined;

    if (!stagedPath) {
      cleanupRoot = path.join(this.loader.getPluginsDir(), `_temp_local_replace_${Date.now()}`);
      await fs.ensureDir(cleanupRoot);
      stagedPath = await extractPlugin(sourcePath, cleanupRoot);
    }

    await fs.move(stagedPath, installPath, { overwrite: true });

    return {
      devMode: false,
      sourcePath: null,
      isSymlink: false,
      hotReloadEnabled: false,
      warnings,
      cleanupRoot,
    };
  }

  async repairPlugin(pluginId: string): Promise<{ success: boolean; message: string }> {
    logger.info(`[REPAIR] Repairing plugin: ${pluginId}`);

    const info = await this.getPluginInfo(pluginId);
    if (!info) {
      return { success: false, message: '插件不存在' };
    }

    if (!info.devMode || !info.sourcePath) {
      return { success: false, message: '不是开发模式插件，无需修复' };
    }

    if (!(await fs.pathExists(info.sourcePath))) {
      return { success: false, message: `源目录不存在: ${info.sourcePath}` };
    }

    const installPathExists = await fs.pathExists(info.path);
    if (installPathExists) {
      await this.loader.safeRemovePluginPath(info.path, true);
    }

    const linkCreated = await this.loader.createSymbolicLink(info.sourcePath, info.path);

    if (linkCreated) {
      await this.reload(pluginId);
      return { success: true, message: '修复成功，插件已重新加载' };
    }

    return { success: false, message: '无法创建符号链接' };
  }
}
