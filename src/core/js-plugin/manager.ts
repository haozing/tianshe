/**
 * JS 插件管理器
 *
 * 负责 JS 插件的导入、加载、执行、卸载等生命周期管理
 * 作为门面类，委托给专门的模块处理具体职责
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import type { DuckDBService } from '../../main/duckdb/service';
import type { WebContentsViewManager } from '../../main/webcontentsview-manager';
import type { WindowManager } from '../../main/window-manager';
import type {
  LoadedJSPlugin,
  JSPluginInfo,
  JSPluginImportResult,
  JSPluginManifest,
} from '../../types/js-plugin';
import { extractPlugin, readManifest } from './loader';
import { PluginContext } from './context';
import { createLogger } from '../logger';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../observability/observation-context';
import { observationService, summarizeForObservation } from '../observability/observation-service';
import { attachErrorContextArtifact } from '../observability/error-context-artifact';
import { assertTrustedFirstPartyPluginImport } from './trust-policy';

const logger = createLogger('JSPluginManager');

// 拆分后的模块
import { PluginLoader } from './plugin-loader';
import type { PluginImportOptions } from './plugin-loader';
import { PluginLifecycleManager } from './plugin-lifecycle';
import { PluginInstaller } from './plugin-installer';
import { UIExtensionManager } from './ui-extension-manager';
import { PluginRuntimeRegistry } from './runtime-registry';

export interface CommandExecutionGuardContext {
  pluginId: string;
  commandId: string;
  params: any;
}

export type CommandExecutionGuard = (context: CommandExecutionGuardContext) => Promise<void> | void;

type PreparedPluginSource = {
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
export class JSPluginManager {
  /** 插件加载器 */
  private loader: PluginLoader;

  /** 生命周期管理器 */
  private lifecycle: PluginLifecycleManager;

  /** 插件安装器 */
  private installer: PluginInstaller;

  /** UI 扩展管理器 */
  private uiExtManager: UIExtensionManager;
  /** 插件运行态注册表 */
  private runtimeRegistry: PluginRuntimeRegistry;
  /** 命令执行前置守卫（可用于鉴权、审计、限流） */
  private commandExecutionGuards: CommandExecutionGuard[] = [];

  constructor(
    private duckdb: DuckDBService,
    private viewManager: WebContentsViewManager,
    private windowManager: WindowManager,
    private hookBus: import('../hookbus').HookBus,
    private webhookSender: import('../../main/webhook/sender').WebhookSender
  ) {
    this.loader = new PluginLoader(duckdb);
    this.runtimeRegistry = new PluginRuntimeRegistry();
    this.lifecycle = new PluginLifecycleManager(
      duckdb,
      viewManager,
      windowManager,
      hookBus,
      webhookSender,
      this.runtimeRegistry
    );
    this.installer = new PluginInstaller(duckdb);
    this.uiExtManager = new UIExtensionManager({ duckdb, viewManager });
  }

  /**
   * 初始化管理器
   */
  async init(): Promise<void> {
    try {
      await this.loader.ensurePluginsDir();
    } catch (error: any) {
      logger.error('[INIT] Failed to ensure plugins directory, plugins disabled:', error);
      return;
    }

    try {
      await this.loadInstalledPlugins();
    } catch (error: any) {
      logger.error('[INIT] Failed to load installed plugins, continuing without plugins:', error);
    }

    try {
      await this.importExternalPluginSources();
    } catch (error: any) {
      logger.error('[INIT] Failed to import external plugins, continuing:', error);
    }

    // 运行数据完整性检查
    try {
      logger.info('[IntegrityCheck] Running data integrity check...');
      const { DataIntegrityChecker } = await import('./data-integrity-checker');
      const { getImportsDir } = await import('../../main/duckdb/utils');
      const checker = new DataIntegrityChecker(this.duckdb, getImportsDir());
      const { checkResult, repairResult } = await checker.checkAndRepair();

      if (checkResult.totalIssues > 0) {
        logger.info(`[IntegrityCheck] Found ${checkResult.totalIssues} issues`);
        logger.info(`[IntegrityCheck] Auto-repaired: ${repairResult.repaired}`);
        if (repairResult.failed > 0) {
          logger.warn(`[IntegrityCheck] Failed to repair: ${repairResult.failed}`);
        }
        repairResult.details.forEach((detail) => logger.info(`  ${detail}`));
      } else {
        logger.info('[IntegrityCheck] No data integrity issues found');
      }
    } catch (error: any) {
      logger.error('[IntegrityCheck] Failed to run integrity check:', error);
    }

    logger.info('[OK] JS Plugin Manager initialized');
  }

  /**
   * 导入插件
   */
  async import(sourcePath: string, options?: PluginImportOptions): Promise<JSPluginImportResult> {
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
              // 创建插件专属文件夹
              const folderService = this.duckdb.getFolderService();
              const folderId = await folderService.createFolder(manifest.name, null, manifest.id, {
                icon: manifest.icon || '🔌',
                description: manifest.description || '',
              });
              logger.info(`  ✓ Created plugin folder: ${manifest.name} (${folderId})`);

              // 创建数据表
              let tableNameToDatasetId: Map<string, string> | null = null;
              if (manifest.dataTables && manifest.dataTables.length > 0) {
                tableNameToDatasetId = await this.installer.createTables(manifest, folderId);
              }

              return { folderId, tableNameToDatasetId };
            },
            saveUIContributions: (manifest, tableNameToDatasetId) =>
              this.uiExtManager.saveUIContributions(manifest, tableNameToDatasetId),
            unregisterUIContributions: (id) => this.uiExtManager.unregisterUIContributions(id),
            loadPlugin: (id) => this.load(id),
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
        if (error instanceof Error && error.message === 'Plugin install failed') {
          return {
            success: false,
            error: error.message,
          };
        }
        if (error instanceof Error && String(error.message || '').trim()) {
          return {
            success: false,
            error: error.message,
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
        const result = await this.import(sourcePath, importOptions);
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
        } catch (error: any) {
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
            error: error?.message || String(error),
          };
        }
      });
    } catch (error: any) {
      logger.error('[CloudPlugin] install/update failed', error);
      return {
        success: false,
        error: error?.message || String(error),
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
    } catch (error: any) {
      logger.error('[CloudPlugin] failed to replace installed plugin', {
        pluginId: existing.id,
        error: error?.message || String(error),
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
        error: error?.message || String(error),
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
    } catch (error: any) {
      logger.error('[LocalPlugin] failed to replace installed plugin', {
        pluginId: existing.id,
        error: error?.message || String(error),
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
        error: error?.message || String(error),
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

  private async preparePluginSource(
    sourcePath: string,
    tempPrefix: string
  ): Promise<PreparedPluginSource> {
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

  private async cleanupPreparedPluginSource(
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

  async load(pluginId: string): Promise<void> {
    await this.loadWithDependencies(pluginId, new Set());
  }

  private async loadWithDependencies(pluginId: string, loading: Set<string>): Promise<void> {
    if (loading.has(pluginId)) {
      logger.warn(`[LOAD] Circular dependency detected, skipping nested load: ${pluginId}`, {
        chain: Array.from(loading),
      });
      return;
    }

    loading.add(pluginId);
    try {
      // 如果已经加载，先卸载
      if (this.lifecycle.hasPlugin(pluginId)) {
        await this.deactivate(pluginId, { force: true });
        const plugin = this.lifecycle.getPlugin(pluginId);
        if (plugin) {
          this.loader.unloadModule(plugin.path, pluginId);
        }
        this.lifecycle.deletePlugin(pluginId);
      }

      // 从数据库获取插件信息
      const info = await this.getPluginInfo(pluginId);
      if (!info) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }

      // 读取清单
      const manifest = await readManifest(info.path);

      // Ensure cross-plugin dependencies are loaded first
      await this.ensureCrossPluginDependenciesLoaded(pluginId, manifest, loading);

      // 加载模块
      const module = this.loader.loadModule(info.path, manifest);

      // 保存到内存
      this.lifecycle.setPlugin(pluginId, {
        manifest,
        module,
        path: info.path,
      });

      logger.info(`[OK] Plugin loaded: ${pluginId}`);

      // 激活插件
      await this.activate(pluginId);
    } finally {
      loading.delete(pluginId);
    }
  }

  private async ensureCrossPluginDependenciesLoaded(
    pluginId: string,
    manifest: JSPluginManifest,
    loading: Set<string>
  ): Promise<void> {
    const canCall = manifest?.crossPlugin?.canCall;
    if (!Array.isArray(canCall) || canCall.length === 0) return;

    // Load dependencies sequentially to keep startup deterministic.
    for (const depIdRaw of canCall) {
      const depId = typeof depIdRaw === 'string' ? depIdRaw.trim() : '';
      if (!depId || depId === pluginId) continue;

      // Already activated -> OK
      if (this.lifecycle.getContext(depId)) continue;

      // Not installed or disabled -> skip (plugin can decide how to handle missing deps at runtime)
      const depInfo = await this.getPluginInfo(depId).catch(() => null);
      if (!depInfo) {
        logger.warn(`[LOAD] Dependency plugin not installed: ${pluginId} -> ${depId}`);
        continue;
      }
      if (depInfo.enabled === false) {
        logger.warn(`[LOAD] Dependency plugin is disabled: ${pluginId} -> ${depId}`);
        continue;
      }

      try {
        await this.loadWithDependencies(depId, loading);
      } catch (error: any) {
        logger.warn(`[LOAD] Failed to load dependency plugin: ${pluginId} -> ${depId}`, {
          error: error?.message || String(error),
        });
      }
    }
  }

  /**
   * 卸载插件
   */
  async uninstall(pluginId: string, deleteTables: boolean = false): Promise<void> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      pluginId,
      source: currentTraceContext?.source ?? 'plugin-manager',
      attributes: {
        deleteTables,
      },
    });

    await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'plugin-manager',
        event: 'plugin.lifecycle.uninstall',
        attrs: {
          pluginId,
          deleteTables,
          callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
        },
      });

      try {
        logger.info(`[UNINSTALL] Uninstalling plugin: ${pluginId}, deleteTables: ${deleteTables}`);

        // 1. 停用插件
        await this.deactivate(pluginId, { force: true });

        // 2. 从内存卸载
        const plugin = this.lifecycle.getPlugin(pluginId);
        if (plugin) {
          this.loader.unloadModule(plugin.path, pluginId);
          this.lifecycle.deletePlugin(pluginId);
        }

        // 3. 获取插件路径
        const info = await this.getPluginInfo(pluginId);
        if (!info) {
          throw new Error(`Plugin not found: ${pluginId}`);
        }

        // 4. 处理数据表
        if (deleteTables) {
          await this.installer.deletePluginTables(pluginId);
        } else {
          await this.installer.orphanPluginTables(pluginId);
        }

        // 5. 安全删除插件目录
        await this.loader.safeRemovePluginPath(info.path, info.isSymlink ?? false);

        // 6. 删除数据库记录
        await this.duckdb.executeWithParams(
          `DELETE FROM js_plugin_custom_pages WHERE plugin_id = ?`,
          [pluginId]
        );
        logger.info(`  ✓ Deleted custom pages for plugin: ${pluginId}`);

        await this.duckdb.executeWithParams(`DELETE FROM js_plugins WHERE id = ?`, [pluginId]);
        this.runtimeRegistry.removePlugin(pluginId);

        logger.info(`[OK] Plugin uninstalled: ${pluginId}`);
        await span.succeed({
          attrs: {
            pluginId,
            deleteTables,
          },
        });
      } catch (error) {
        const runtimeStatus = await this.getRuntimeStatus(pluginId).catch(() => null);
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'plugin-manager',
          label: 'plugin uninstall failure context',
          data: {
            pluginId,
            deleteTables,
            runtimeStatus: summarizeForObservation(runtimeStatus, 2),
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            pluginId,
            deleteTables,
          },
        });
        throw error;
      }
    });
  }

  /**
   * 列出所有已安装的插件
   */
  async listPlugins(): Promise<JSPluginInfo[]> {
    const result = await this.duckdb.executeSQLWithParams(
      `SELECT id, name, version, author, description, icon, category, path, installed_at, enabled,
       dev_mode, source_path, is_symlink, hot_reload_enabled,
       source_type, install_channel, cloud_plugin_code, cloud_release_version, managed_by_policy, policy_version, last_policy_sync_at
       FROM js_plugins
       ORDER BY installed_at DESC`,
      []
    );

    return Promise.all(
      result.map(async (row: any) => {
        const activityBarViewMeta = await this.getActivityBarViewMeta(row.id, row.path);

        return {
          id: row.id,
          name: row.name,
          version: row.version,
          author: row.author,
          description: row.description,
          icon: row.icon,
          category: row.category,
          installedAt: row.installed_at,
          path: row.path,
          hasActivityBarView: this.checkHasActivityBarView(row.id),
          activityBarViewOrder: activityBarViewMeta.order,
          activityBarViewIcon: activityBarViewMeta.icon,
          enabled: row.enabled !== false,
          devMode: row.dev_mode ?? false,
          sourcePath: row.source_path ?? undefined,
          isSymlink: row.is_symlink ?? false,
          hotReloadEnabled: row.hot_reload_enabled ?? false,
          sourceType: row.source_type ?? undefined,
          installChannel: row.install_channel ?? undefined,
          cloudPluginCode: row.cloud_plugin_code ?? undefined,
          cloudReleaseVersion: row.cloud_release_version ?? undefined,
          managedByPolicy: row.managed_by_policy ?? false,
          policyVersion: row.policy_version ?? undefined,
          lastPolicySyncAt: row.last_policy_sync_at ?? undefined,
        };
      })
    );
  }

  /**
   * 获取插件信息
   */
  async getPluginInfo(pluginId: string): Promise<JSPluginInfo | null> {
    logger.info(`    [getPluginInfo] Querying plugin: ${pluginId}`);
    const result = await this.duckdb.executeSQLWithParams(
      `SELECT id, name, version, author, description, icon, category, path, installed_at, enabled,
       dev_mode, source_path, is_symlink, hot_reload_enabled,
       source_type, install_channel, cloud_plugin_code, cloud_release_version, managed_by_policy, policy_version, last_policy_sync_at
       FROM js_plugins WHERE id = ?`,
      [pluginId]
    );

    if (result.length === 0) return null;

    const row = result[0];

    // 查询命令列表
    const commandsResult = await this.duckdb.executeSQLWithParams(
      `SELECT command_id, title, category, description FROM js_plugin_commands WHERE plugin_id = ? ORDER BY title`,
      [pluginId]
    );

    const commands = commandsResult.map((cmd: any) => ({
      id: cmd.command_id,
      title: cmd.title,
      category: cmd.category,
      description: cmd.description,
    }));

    const activityBarViewMeta = await this.getActivityBarViewMeta(pluginId, row.path);

    return {
      id: row.id,
      name: row.name,
      version: row.version,
      author: row.author,
      description: row.description,
      icon: row.icon,
      category: row.category,
      installedAt: row.installed_at,
      path: row.path,
      commands,
      hasActivityBarView: this.checkHasActivityBarView(pluginId),
      activityBarViewOrder: activityBarViewMeta.order,
      activityBarViewIcon: activityBarViewMeta.icon,
      enabled: row.enabled !== false,
      devMode: row.dev_mode ?? false,
      sourcePath: row.source_path ?? undefined,
      isSymlink: row.is_symlink ?? false,
      hotReloadEnabled: row.hot_reload_enabled ?? false,
      sourceType: row.source_type ?? undefined,
      installChannel: row.install_channel ?? undefined,
      cloudPluginCode: row.cloud_plugin_code ?? undefined,
      cloudReleaseVersion: row.cloud_release_version ?? undefined,
      managedByPolicy: row.managed_by_policy ?? false,
      policyVersion: row.policy_version ?? undefined,
      lastPolicySyncAt: row.last_policy_sync_at ?? undefined,
    };
  }

  /**
   * 获取已加载的插件清单
   */
  getLoadedPlugin(pluginId: string): LoadedJSPlugin | null {
    return this.lifecycle.getPlugin(pluginId) || null;
  }

  /**
   * 重新加载插件
   */
  async reload(pluginId: string): Promise<void> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      pluginId,
      source: currentTraceContext?.source ?? 'plugin-manager',
    });

    await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'plugin-manager',
        event: 'plugin.lifecycle.reload',
        attrs: {
          pluginId,
          callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
        },
      });

      try {
        await this.lifecycle.reload(pluginId, {
          load: (id) => this.load(id),
          getPluginInfo: (id) => this.getPluginInfo(id),
        });
        await span.succeed({
          attrs: {
            pluginId,
          },
        });
      } catch (error) {
        const runtimeStatus = await this.getRuntimeStatus(pluginId).catch(() => null);
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'plugin-manager',
          label: 'plugin reload failure context',
          data: {
            pluginId,
            runtimeStatus: summarizeForObservation(runtimeStatus, 2),
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            pluginId,
          },
        });
        throw error;
      }
    });
  }

  /**
   * 启用插件
   */
  async enable(pluginId: string): Promise<void> {
    const info = await this.getPluginInfo(pluginId);
    if (!info) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    await this.lifecycle.enable(pluginId);

    if (this.lifecycle.getContext(pluginId)) {
      return;
    }

    if (this.lifecycle.hasPlugin(pluginId)) {
      await this.activate(pluginId);
      return;
    }

    await this.load(pluginId);
  }

  /**
   * 禁用插件
   */
  async disable(pluginId: string): Promise<void> {
    const info = await this.getPluginInfo(pluginId);
    if (!info) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    await this.deactivate(pluginId, { force: true });
    await this.lifecycle.disable(pluginId);
  }

  async listRuntimeStatuses(): Promise<import('../../types/js-plugin').JSPluginRuntimeStatus[]> {
    const plugins = await this.listPlugins();
    const runtimeMap = new Map(
      this.runtimeRegistry.listStatuses().map((status) => [status.pluginId, status])
    );

    return plugins.map((plugin) => {
      const runtime = runtimeMap.get(plugin.id);
      if (!runtime) {
        return this.buildDefaultRuntimeStatus(plugin);
      }

      return {
        ...runtime,
        pluginName: runtime.pluginName || plugin.name,
        lifecyclePhase: plugin.enabled === false ? 'disabled' : runtime.lifecyclePhase,
      };
    });
  }

  async getRuntimeStatus(
    pluginId: string
  ): Promise<import('../../types/js-plugin').JSPluginRuntimeStatus | null> {
    const plugin = await this.getPluginInfo(pluginId);
    if (!plugin) {
      return null;
    }

    const runtime = this.runtimeRegistry.getStatus(pluginId);
    if (!runtime) {
      return this.buildDefaultRuntimeStatus(plugin);
    }

    return {
      ...runtime,
      pluginName: runtime.pluginName || plugin.name,
      lifecyclePhase: plugin.enabled === false ? 'disabled' : runtime.lifecyclePhase,
    };
  }

  async cancelPluginTasks(pluginId: string): Promise<{ cancelled: number }> {
    const helpers = this.lifecycle.getHelpers(pluginId) as
      | {
          taskQueue?: {
            cancelAll?: () => Promise<number>;
          };
        }
      | undefined;

    const cancelled = await helpers?.taskQueue?.cancelAll?.();
    return {
      cancelled: typeof cancelled === 'number' ? cancelled : 0,
    };
  }

  onRuntimeStatusChanged(
    listener: (event: import('../../types/js-plugin').JSPluginRuntimeStatusChangeEvent) => void
  ): () => void {
    this.runtimeRegistry.on('status-changed', listener);
    return () => {
      this.runtimeRegistry.off('status-changed', listener);
    };
  }

  /**
   * 激活插件
   */
  private async activate(pluginId: string): Promise<void> {
    await this.lifecycle.activate(pluginId, {
      getPluginInfo: (id) => this.getPluginInfo(id),
      registerUIContributions: (id, manifest) =>
        this.uiExtManager.registerUIContributions(id, manifest),
      unregisterUIContributions: (id) => this.uiExtManager.unregisterUIContributions(id),
      createPluginViews: (id, config) => this.uiExtManager.createPluginViews(id, config),
      reloadPlugin: (id) => this.reload(id),
    });
  }

  /**
   * 停用插件
   */
  async deactivate(
    pluginId: string,
    options: {
      force?: boolean;
    } = {}
  ): Promise<boolean> {
    return await this.lifecycle.deactivate(
      pluginId,
      {
        unregisterUIContributions: (id) => this.uiExtManager.unregisterUIContributions(id),
      },
      options
    );
  }

  /**
   * 执行命令
   */
  async executeCommand(pluginId: string, commandId: string, params: any): Promise<any> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      pluginId,
      source: currentTraceContext?.source ?? 'plugin-manager',
      attributes: {
        commandId,
      },
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'plugin-manager',
        event: 'plugin.invoke',
        attrs: {
          pluginId,
          apiName: commandId,
          invocationType: 'command',
          source: 'command',
          callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
          params: summarizeForObservation(params, 2),
        },
      });

      for (const guard of this.commandExecutionGuards) {
        await guard({ pluginId, commandId, params });
      }

      const info = await this.getPluginInfo(pluginId);
      if (!info) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }
      if (info.enabled === false) {
        throw new Error(`Plugin ${pluginId} is disabled`);
      }

      const context = this.lifecycle.getContext(pluginId);
      if (!context) {
        throw new Error(`Plugin ${pluginId} is not activated`);
      }

      const handler = context.getCommand(commandId);
      if (!handler) {
        throw new Error(`Command ${commandId} not found in plugin ${pluginId}`);
      }

      const pluginLogger = this.lifecycle.getLogger(pluginId);
      const endTimer = pluginLogger?.timer(`Command: ${commandId}`);

      pluginLogger?.command(commandId, 'start', { params });

      try {
        const helpers = this.lifecycle.getHelpers(pluginId);
        if (!helpers) {
          throw new Error(`Helpers not found for plugin ${pluginId}`);
        }

        const result = await handler(params, helpers);

        endTimer?.();
        pluginLogger?.command(commandId, 'success', { result });
        await span.succeed({
          attrs: {
            pluginId,
            apiName: commandId,
            invocationType: 'command',
            source: 'command',
            callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
            result: summarizeForObservation(result, 2),
          },
        });

        return result;
      } catch (error: any) {
        endTimer?.();
        pluginLogger?.command(commandId, 'error', error);
        const runtimeStatus = await this.getRuntimeStatus(pluginId).catch(() => null);
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'plugin-manager',
          label: 'plugin command failure context',
          data: {
            pluginId,
            apiName: commandId,
            invocationType: 'command',
            runtimeStatus: summarizeForObservation(runtimeStatus, 2),
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            pluginId,
            apiName: commandId,
            invocationType: 'command',
            source: 'command',
            callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
          },
        });
        throw error;
      }
    });
  }

  registerCommandExecutionGuard(guard: CommandExecutionGuard): () => void {
    this.commandExecutionGuards.push(guard);
    return () => {
      const index = this.commandExecutionGuards.indexOf(guard);
      if (index >= 0) {
        this.commandExecutionGuards.splice(index, 1);
      }
    };
  }

  /**
   * 获取插件的 Context
   */
  getContext(pluginId: string): PluginContext | null {
    return this.lifecycle.getContext(pluginId) || null;
  }

  /**
   * 调用插件暴露的 API
   */
  async callPluginAPI(pluginId: string, apiName: string, args: any[]): Promise<any> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      pluginId,
      source: currentTraceContext?.source ?? 'plugin-manager',
      attributes: {
        apiName,
      },
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'plugin-manager',
        event: 'plugin.invoke',
        attrs: {
          pluginId,
          apiName,
          invocationType: 'api',
          source: 'api',
          callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
          args: summarizeForObservation(args, 2),
        },
      });

      try {
        const context = this.lifecycle.getContext(pluginId);
        if (!context) {
          throw new Error(`Plugin ${pluginId} is not activated`);
        }

        const result = await context.callExposedAPI(apiName, args);
        await span.succeed({
          attrs: {
            pluginId,
            apiName,
            invocationType: 'api',
            source: 'api',
            callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
            result: summarizeForObservation(result, 2),
          },
        });
        return result;
      } catch (error) {
        const runtimeStatus = await this.getRuntimeStatus(pluginId).catch(() => null);
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'plugin-manager',
          label: 'plugin api failure context',
          data: {
            pluginId,
            apiName,
            invocationType: 'api',
            runtimeStatus: summarizeForObservation(runtimeStatus, 2),
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            pluginId,
            apiName,
            invocationType: 'api',
            source: 'api',
            callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
          },
        });
        throw error;
      }
    });
  }

  /**
   * 获取插件暴露的 API 列表
   */
  getExposedAPIs(pluginId: string): string[] {
    const context = this.lifecycle.getContext(pluginId);
    if (!context) {
      throw new Error(`Plugin context not found: ${pluginId}`);
    }
    return Array.from((context as any).exposedAPIs.keys());
  }

  // ========== 热重载相关 ==========

  async enableHotReload(pluginId: string): Promise<{ success: boolean; message: string }> {
    return this.lifecycle.enableHotReload(
      pluginId,
      (id) => this.getPluginInfo(id),
      (id) => this.reload(id)
    );
  }

  async disableHotReload(pluginId: string): Promise<{ success: boolean; message: string }> {
    return this.lifecycle.disableHotReload(pluginId);
  }

  isHotReloadEnabled(pluginId: string): boolean {
    return this.lifecycle.isHotReloadEnabled(pluginId);
  }

  getHotReloadEnabledPlugins(): string[] {
    return this.lifecycle.getHotReloadEnabledPlugins();
  }

  /**
   * 修复失效的符号链接
   */
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
    } else {
      return { success: false, message: '无法创建符号链接' };
    }
  }

  // ========== 自定义页面相关 ==========

  /**
   * 获取插件的自定义页面列表
   */
  async getCustomPages(pluginId: string, datasetId?: string): Promise<any[]> {
    return this.uiExtManager.getCustomPages(pluginId, datasetId);
  }

  /**
   * 渲染自定义页面内容
   */
  async renderCustomPage(pluginId: string, pageId: string, datasetId?: string): Promise<string> {
    const pluginInfo = await this.getPluginInfo(pluginId);
    if (!pluginInfo) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    return this.uiExtManager.renderCustomPage(pluginId, pageId, pluginInfo.path, datasetId);
  }

  /**
   * 处理页面消息
   */
  async handlePageMessage(message: any): Promise<any> {
    // 获取所有 contexts 和 helpers 的映射
    const contexts = new Map<string, PluginContext>();
    const helpers = new Map<string, import('./helpers').PluginHelpers>();

    // 从 lifecycle 获取当前插件的 context 和 helpers
    const pluginId = message.pluginId;
    const context = this.lifecycle.getContext(pluginId);
    const helper = this.lifecycle.getHelpers(pluginId);

    if (context) {
      contexts.set(pluginId, context);
    }
    if (helper) {
      helpers.set(pluginId, helper);
    }

    return this.uiExtManager.handlePageMessage(
      message,
      contexts,
      helpers,
      (pid, commandId, params) => this.executeCommand(pid, commandId, params)
    );
  }

  // ========== 私有辅助方法 ==========

  /**
   * 检查插件是否有 ActivityBar 视图配置
   */
  private checkHasActivityBarView(pluginId: string): boolean {
    try {
      const plugin = this.lifecycle.getPlugin(pluginId);
      return Boolean(plugin?.manifest?.contributes?.activityBarView);
    } catch {
      return false;
    }
  }

  private async getActivityBarViewMeta(
    pluginId: string,
    pluginPath: string
  ): Promise<{ order?: number; icon?: string }> {
    try {
      const plugin = this.lifecycle.getPlugin(pluginId);
      const activityBarView = plugin?.manifest?.contributes?.activityBarView;
      if (activityBarView) {
        return {
          order: Number.isFinite(activityBarView.order) ? activityBarView.order : undefined,
          icon:
            typeof activityBarView.icon === 'string' && activityBarView.icon.trim()
              ? activityBarView.icon
              : undefined,
        };
      }
    } catch {
      // ignore
    }

    try {
      const manifest = await readManifest(pluginPath);
      const activityBarView = manifest?.contributes?.activityBarView;
      if (activityBarView) {
        return {
          order: Number.isFinite(activityBarView.order) ? activityBarView.order : undefined,
          icon:
            typeof activityBarView.icon === 'string' && activityBarView.icon.trim()
              ? activityBarView.icon
              : undefined,
        };
      }
    } catch {
      // ignore
    }

    return {};
  }

  private async loadInstalledPlugins(): Promise<void> {
    const plugins = await this.listPlugins();
    const enabledPlugins = plugins.filter((p) => p.enabled !== false);
    const disabledPlugins = plugins.filter((p) => p.enabled === false);

    logger.info(
      `[LOAD] Loading ${enabledPlugins.length} enabled JS plugin(s) (${disabledPlugins.length} disabled)...`
    );

    for (const plugin of enabledPlugins) {
      try {
        // Might have been loaded as a dependency of another plugin.
        if (this.lifecycle.getContext(plugin.id)) {
          continue;
        }
        await this.load(plugin.id);
      } catch (error: any) {
        logger.error(`[ERROR] Failed to load plugin ${plugin.id}:`, error.message);
      }
    }

    if (disabledPlugins.length > 0) {
      logger.info(
        `[SKIP] Skipped ${disabledPlugins.length} disabled plugin(s): ${disabledPlugins.map((p) => p.id).join(', ')}`
      );
    }
  }

  private async importExternalPluginSources(): Promise<void> {
    const sources = await this.loader.discoverExternalPluginSources();
    if (sources.length === 0) {
      return;
    }

    logger.info(`[ExternalPlugins] Found ${sources.length} external plugin source(s)`);

    for (const sourcePath of sources) {
      let prepared: PreparedPluginSource | null = null;
      try {
        prepared = await this.preparePluginSource(sourcePath, '_temp_external_plugin_probe');
        const existing = await this.getPluginInfo(prepared.manifest.id);
        if (existing) {
          logger.info(
            `[ExternalPlugins] Plugin already installed, skipping auto import: ${prepared.manifest.id}`
          );
          continue;
        }

        const result = await this.import(sourcePath, {
          devMode: prepared.kind === 'directory',
          sourceType: 'local_private',
          installChannel: 'manual_import',
          trustedFirstParty: true,
        });

        if (!result.success) {
          logger.warn(
            `[ExternalPlugins] Failed to auto import ${sourcePath}: ${result.error || 'unknown error'}`
          );
        }
      } catch (error: any) {
        logger.error(
          `[ExternalPlugins] Failed to inspect external plugin source: ${sourcePath}`,
          error?.message || String(error)
        );
      } finally {
        if (prepared) {
          await this.cleanupPreparedPluginSource(prepared);
        }
      }
    }
  }

  private buildDefaultRuntimeStatus(
    plugin: JSPluginInfo
  ): import('../../types/js-plugin').JSPluginRuntimeStatus {
    return {
      pluginId: plugin.id,
      pluginName: plugin.name,
      lifecyclePhase: plugin.enabled === false ? 'disabled' : 'inactive',
      workState: 'idle',
      activeQueues: 0,
      runningTasks: 0,
      pendingTasks: 0,
      failedTasks: 0,
      cancelledTasks: 0,
      updatedAt: Date.now(),
    };
  }
}
