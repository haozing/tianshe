/**
 * JS 插件管理器
 *
 * 负责 JS 插件的导入、加载、执行、卸载等生命周期管理
 * 作为门面类，委托给专门的模块处理具体职责
 */

import type { IDuckDBService } from '../../types/duckdb';
import type { IWebContentsViewManager, IWindowManager } from '../browser-pool/ports';
import type { IWebhookSender } from '../../types/service-interfaces';
import type {
  LoadedJSPlugin,
  JSPluginInfo,
  JSPluginImportResult,
  JSPluginManifest,
} from '../../types/js-plugin';
import { readManifest } from './loader';
import { PluginContext } from './context';
import { createLogger } from '../logger';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../observability/observation-context';
import { observationService, summarizeForObservation } from '../observability/observation-service';
import { attachErrorContextArtifact } from '../observability/error-context-artifact';

const logger = createLogger('JSPluginManager');

// 拆分后的模块
import { PluginLoader } from './plugin-loader';
import type { PluginImportOptions } from './plugin-loader';
import { PluginLifecycleManager } from './plugin-lifecycle';
import type { InternalDevToolsOpener } from './namespaces/window';
import { PluginInstaller } from './plugin-installer';
import { UIExtensionManager } from './ui-extension-manager';
import { PluginRuntimeRegistry } from './runtime-registry';
import { getUnknownErrorMessage } from '../../utils/error-message';
import {
  PluginInstallationCoordinator,
  type PreparedPluginSource,
} from './plugin-installation-coordinator';
import {
  PluginExecutionCoordinator,
  type CommandExecutionGuard,
} from './plugin-execution-coordinator';

export type {
  CommandExecutionGuardContext,
  CommandExecutionGuard,
} from './plugin-execution-coordinator';

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
  private installationCoordinator: PluginInstallationCoordinator;
  private executionCoordinator: PluginExecutionCoordinator;

  constructor(
    private duckdb: IDuckDBService,
    private viewManager: IWebContentsViewManager,
    private windowManager: IWindowManager,
    private hookBus: import('../hookbus').HookBus,
    private webhookSender: IWebhookSender,
    private devToolsOpener?: InternalDevToolsOpener
  ) {
    this.loader = new PluginLoader(duckdb);
    this.runtimeRegistry = new PluginRuntimeRegistry();
    this.lifecycle = new PluginLifecycleManager(
      duckdb,
      viewManager,
      windowManager,
      hookBus,
      webhookSender,
      this.runtimeRegistry,
      devToolsOpener
    );
    this.installer = new PluginInstaller(duckdb);
    this.uiExtManager = new UIExtensionManager({ duckdb, viewManager });
    this.installationCoordinator = new PluginInstallationCoordinator({
      duckdb,
      loader: this.loader,
      lifecycle: this.lifecycle,
      installer: this.installer,
      uiExtManager: this.uiExtManager,
      getPluginInfo: (pluginId) => this.getPluginInfo(pluginId),
      load: (pluginId) => this.load(pluginId),
      reload: (pluginId) => this.reload(pluginId),
      deactivate: async (pluginId, options) => {
        await this.deactivate(pluginId, options);
      },
    });
    this.executionCoordinator = new PluginExecutionCoordinator({
      lifecycle: this.lifecycle,
      uiExtManager: this.uiExtManager,
      getPluginInfo: (pluginId) => this.getPluginInfo(pluginId),
      getRuntimeStatus: (pluginId) => this.getRuntimeStatus(pluginId),
    });
    this.uiExtManager.setPluginAPICaller?.((pluginId, apiName, args) =>
      this.executionCoordinator.callPluginAPI(pluginId, apiName, args)
    );
  }

  /**
   * 初始化管理器
   */
  async init(): Promise<void> {
    try {
      await this.loader.ensurePluginsDir();
    } catch (error: unknown) {
      logger.error('[INIT] Failed to ensure plugins directory, plugins disabled:', error);
      return;
    }

    try {
      await this.loadInstalledPlugins();
    } catch (error: unknown) {
      logger.error('[INIT] Failed to load installed plugins, continuing without plugins:', error);
    }

    try {
      await this.importExternalPluginSources();
    } catch (error: unknown) {
      logger.error('[INIT] Failed to import external plugins, continuing:', error);
    }

    // 运行数据完整性检查
    try {
      logger.info('[IntegrityCheck] Running data integrity check...');
      const { DataIntegrityChecker } = await import('./data-integrity-checker');
      const { getImportsDir } = await import('../../utils/data-paths');
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
    } catch (error: unknown) {
      logger.error('[IntegrityCheck] Failed to run integrity check:', error);
    }

    logger.info('[OK] JS Plugin Manager initialized');
  }

  /**
   * Import a local or cloud-managed plugin package.
   */
  async import(sourcePath: string, options?: PluginImportOptions): Promise<JSPluginImportResult> {
    return await this.installationCoordinator.importPlugin(sourcePath, options);
  }

  /**
   * Install or update a cloud-managed plugin package.
   */
  async installOrUpdateCloudPlugin(
    sourcePath: string,
    options?: PluginImportOptions
  ): Promise<JSPluginImportResult> {
    return await this.installationCoordinator.installOrUpdateCloudPlugin(sourcePath, options);
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
        const plugin = this.lifecycle.getPlugin(pluginId);
        await this.deactivate(pluginId, { force: true });
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
      } catch (error: unknown) {
        logger.warn(`[LOAD] Failed to load dependency plugin: ${pluginId} -> ${depId}`, {
          error: getUnknownErrorMessage(error) || String(error),
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

        const info = await this.getPluginInfo(pluginId);
        if (!info) {
          throw new Error(`Plugin not found: ${pluginId}`);
        }
        this.runtimeRegistry.setLifecyclePhase(pluginId, 'stopping', info.name);

        // 1. 停用插件
        const plugin = this.lifecycle.getPlugin(pluginId);
        await this.deactivate(pluginId, { force: true });

        // 2. 从内存卸载
        if (plugin) {
          this.loader.unloadModule(plugin.path, pluginId);
          this.lifecycle.deletePlugin(pluginId);
        }

        // 3. 处理数据表
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
        const failedInfo = await this.getPluginInfo(pluginId).catch(() => null);
        this.runtimeRegistry.recordError(
          pluginId,
          error,
          failedInfo?.enabled === false ? 'disabled' : 'error',
          failedInfo?.name
        );
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
        this.executionCoordinator.assertNoRunningCommands(pluginId, 'reload');
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
    if (options.force === true) {
      await this.executionCoordinator.waitForRunningCommands(pluginId);
    } else {
      this.executionCoordinator.assertNoRunningCommands(pluginId, 'deactivate');
    }

    return await this.lifecycle.deactivate(
      pluginId,
      {
        unregisterUIContributions: (id) => this.uiExtManager.unregisterUIContributions(id),
      },
      options
    );
  }

  /**
   * ????
   */
  async executeCommand(pluginId: string, commandId: string, params: any): Promise<any> {
    return await this.executionCoordinator.executeCommand(pluginId, commandId, params);
  }

  registerCommandExecutionGuard(guard: CommandExecutionGuard): () => void {
    return this.executionCoordinator.registerCommandExecutionGuard(guard);
  }

  /**
   * ????? Context
   */
  getContext(pluginId: string): PluginContext | null {
    return this.executionCoordinator.getContext(pluginId);
  }

  /**
   * ??????? API
   */
  async callPluginAPI(pluginId: string, apiName: string, args: any[]): Promise<any> {
    return await this.executionCoordinator.callPluginAPI(pluginId, apiName, args);
  }

  /**
   * ??????? API ??
   */
  getExposedAPIs(pluginId: string): string[] {
    return this.executionCoordinator.getExposedAPIs(pluginId);
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
    return this.lifecycle.disableHotReload(
      pluginId,
      (id) => this.getPluginInfo(id),
      (id) => this.reload(id)
    );
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
    return await this.installationCoordinator.repairPlugin(pluginId);
  }

  // ========== ??????? ==========

  /**
   * ????????????
   */
  async getCustomPages(pluginId: string, datasetId?: string): Promise<any[]> {
    return this.executionCoordinator.getCustomPages(pluginId, datasetId);
  }

  /**
   * ?????????
   */
  async renderCustomPage(pluginId: string, pageId: string, datasetId?: string): Promise<string> {
    return await this.executionCoordinator.renderCustomPage(pluginId, pageId, datasetId);
  }

  /**
   * ??????
   */
  async handlePageMessage(message: any): Promise<any> {
    return await this.executionCoordinator.handlePageMessage(message);
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
      } catch (error: unknown) {
        logger.error(`[ERROR] Failed to load plugin ${plugin.id}:`, getUnknownErrorMessage(error));
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
        prepared = await this.installationCoordinator.preparePluginSource(
          sourcePath,
          '_temp_external_plugin_probe'
        );
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
      } catch (error: unknown) {
        logger.error(
          `[ExternalPlugins] Failed to inspect external plugin source: ${sourcePath}`,
          getUnknownErrorMessage(error) || String(error)
        );
      } finally {
        if (prepared) {
          await this.installationCoordinator.cleanupPreparedPluginSource(prepared);
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
