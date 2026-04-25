/**
 * Plugin Lifecycle Manager
 *
 * 负责插件的激活、停用、重载、热重载等生命周期管理
 * 从 manager.ts 拆分出来，专注于生命周期职责
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import type { DuckDBService } from '../../main/duckdb/service';
import type { WebContentsViewManager } from '../../main/webcontentsview-manager';
import type { WindowManager } from '../../main/window-manager';
import type { JSPluginManifest, LoadedJSPlugin, JSPluginInfo } from '../../types/js-plugin';
import { readManifest } from './loader';
import { createPluginLogger, PluginLogger } from '../../utils/PluginLogger';
import { PluginHelpers } from './helpers';
import { PluginContext, DataTableInfo } from './context';
import { PluginFileWatcherManager } from './file-watcher';
import { pluginEventBus, PluginEvents, type PluginReloadedPayload } from './events';
import { getPluginRegistry } from './registry';
import type { PluginRuntimeRegistry } from './runtime-registry';
import { createLogger } from '../logger';

/** 模块级 logger */
const logger = createLogger('PluginLifecycle');

function normalizeCanDeactivateResult(result: unknown): { allow: boolean; reason: string } {
  if (result === false) {
    return { allow: false, reason: '' };
  }
  if (result && typeof result === 'object') {
    const safe = result as { allow?: unknown; reason?: unknown };
    if (safe.allow === false) {
      return {
        allow: false,
        reason: typeof safe.reason === 'string' ? safe.reason.trim() : '',
      };
    }
  }
  return { allow: true, reason: '' };
}

/**
 * 插件生命周期管理器
 * 处理插件的激活、停用、重载等
 */
export class PluginLifecycleManager {
  /** 已加载的插件实例 */
  private plugins = new Map<string, LoadedJSPlugin>();

  /** 插件上下文实例 */
  private contexts = new Map<string, PluginContext>();

  /** 插件 Helpers 实例 */
  private helpers = new Map<string, PluginHelpers>();

  /** 插件日志记录器 */
  private loggers = new Map<string, PluginLogger>();

  /** 插件文件监听管理器 */
  private fileWatcherManager: PluginFileWatcherManager;

  constructor(
    private duckdb: DuckDBService,
    private viewManager: WebContentsViewManager,
    private windowManager: WindowManager,
    private hookBus: import('../hookbus').HookBus,
    private webhookSender: import('../../main/webhook/sender').WebhookSender,
    private runtimeRegistry?: PluginRuntimeRegistry
  ) {
    this.fileWatcherManager = new PluginFileWatcherManager();
  }

  // ========== 访问器 ==========

  getPlugin(pluginId: string): LoadedJSPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  hasPlugin(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  setPlugin(pluginId: string, plugin: LoadedJSPlugin): void {
    this.plugins.set(pluginId, plugin);
  }

  deletePlugin(pluginId: string): void {
    this.plugins.delete(pluginId);
  }

  getContext(pluginId: string): PluginContext | undefined {
    return this.contexts.get(pluginId);
  }

  getHelpers(pluginId: string): PluginHelpers | undefined {
    return this.helpers.get(pluginId);
  }

  getLogger(pluginId: string): PluginLogger | undefined {
    return this.loggers.get(pluginId);
  }

  // ========== 生命周期方法 ==========

  /**
   * 激活插件
   */
  async activate(
    pluginId: string,
    callbacks: {
      getPluginInfo: (pluginId: string) => Promise<JSPluginInfo | null>;
      registerUIContributions: (pluginId: string, manifest: JSPluginManifest) => Promise<void>;
      unregisterUIContributions: (pluginId: string) => Promise<void>;
      createPluginViews: (pluginId: string, viewConfig: any) => Promise<void>;
      reloadPlugin: (pluginId: string) => Promise<void>;
    }
  ): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    // 如果插件没有 activate 钩子和 contributes，跳过
    if (!plugin.module.activate && !plugin.manifest.contributes) {
      this.runtimeRegistry?.setLifecyclePhase(pluginId, 'active', plugin.manifest.name);
      return;
    }

    // 创建插件日志记录器
    const pluginLogger = createPluginLogger(pluginId, plugin.manifest.name);
    this.loggers.set(pluginId, pluginLogger);
    pluginLogger.lifecycle('activating');
    this.runtimeRegistry?.setLifecyclePhase(pluginId, 'starting', plugin.manifest.name);

    try {
      // 1. 设置插件基础设施
      const helpers = this.setupPluginHelpers(pluginId, plugin);
      const dataTables = await this.loadPluginDataTables(pluginId, pluginLogger);
      const context = this.createPluginContext(pluginId, plugin, helpers, dataTables);

      // 1.5. 注册插件到 Registry
      const registry = getPluginRegistry();
      registry.registerPlugin(pluginId, plugin.manifest, helpers);

      // 2. 调用插件的 activate 钩子
      await this.invokePluginActivateHook(plugin, context);

      // 2.5. 同步 API 和命令到 Registry
      this.syncToRegistry(pluginId, context, helpers);

      // 3. 设置插件 UI
      await this.setupPluginUI(pluginId, plugin, pluginLogger, callbacks);

      pluginLogger.lifecycle('activated', {
        commands: context.getCommands().size,
        apis: context.getAllExposedAPIs().size,
        dataTables: dataTables.length,
      });

      // 5. 设置热重载
      await this.setupHotReloadIfEnabled(
        pluginId,
        pluginLogger,
        callbacks.getPluginInfo,
        callbacks.reloadPlugin
      );
      this.runtimeRegistry?.setLifecyclePhase(pluginId, 'active', plugin.manifest.name);
    } catch (error: any) {
      pluginLogger.error('Plugin activation failed', error);
      this.runtimeRegistry?.recordError(pluginId, error, 'error', plugin.manifest.name);

      // 清理 Registry
      const registry = getPluginRegistry();
      registry.unregisterPlugin(pluginId);

      // 清理上下文
      this.contexts.delete(pluginId);
      this.helpers.delete(pluginId);
      this.loggers.delete(pluginId);

      // 清理插件实例（防止状态残留）
      this.plugins.delete(pluginId);

      throw new Error(`Plugin activation failed: ${error.message}`);
    }
  }

  /**
   * 停用插件
   */
  async deactivate(
    pluginId: string,
    callbacks: {
      unregisterUIContributions: (pluginId: string) => Promise<void>;
    },
    options: {
      force?: boolean;
    } = {}
  ): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    const context = this.contexts.get(pluginId);
    const helpers = this.helpers.get(pluginId);
    const force = options?.force === true;

    if (!plugin && !context && !helpers) {
      return true;
    }

    if (!force && plugin?.module && typeof plugin.module.canDeactivate === 'function') {
      try {
        const guard = normalizeCanDeactivateResult(
          await plugin.module.canDeactivate({
            force,
            pluginId,
            helpers,
          })
        );
        if (!guard.allow) {
          logger.info('Plugin deactivation skipped by guard', {
            pluginId,
            reason: guard.reason || undefined,
          });
          this.runtimeRegistry?.setLifecyclePhase(pluginId, 'active', plugin?.manifest?.name);
          return false;
        }
      } catch (guardError: any) {
        logger.error('Plugin canDeactivate hook failed', { pluginId, error: guardError });
      }
    }

    logger.info('Deactivating plugin', { pluginId });
    this.runtimeRegistry?.setLifecyclePhase(pluginId, 'stopping');

    try {
      // 0. 从 Registry 注销插件
      try {
        const registry = getPluginRegistry();
        registry.unregisterPlugin(pluginId);
        logger.debug('Plugin unregistered from Registry', { pluginId });
      } catch (registryError: any) {
        logger.error('Failed to unregister from Registry', registryError);
      }

      // 1. 调用插件的 deactivate 钩子
      if (plugin?.module.onStop && helpers) {
        try {
          await plugin.module.onStop(helpers);
          logger.debug('Plugin onStop hook completed', { pluginId });
        } catch (hookError: any) {
          logger.error('Plugin onStop hook failed', hookError);
        }
      }

      if (plugin?.module.deactivate) {
        try {
          await plugin.module.deactivate();
          logger.debug('Plugin deactivate hook completed', { pluginId });
        } catch (hookError: any) {
          logger.error('Plugin deactivate hook failed', hookError);
        }
      }

      // 2. 清理 Context
      if (context) {
        try {
          context.dispose();
          this.contexts.delete(pluginId);
          logger.debug('Context disposed', { pluginId });
        } catch (contextError: any) {
          logger.error('Context dispose failed', contextError);
        }
      }

      // 3. 清理 Helpers
      if (helpers) {
        try {
          await helpers.dispose();
          this.helpers.delete(pluginId);
          logger.debug('Helpers disposed', { pluginId });
        } catch (helpersError: any) {
          logger.error('Helpers dispose failed', helpersError);
          this.helpers.delete(pluginId);
        }
      }

      // 3.2. 停止文件监听
      if (this.fileWatcherManager.isWatching(pluginId)) {
        try {
          await this.fileWatcherManager.stopWatching(pluginId);
          logger.debug('Stopped file watcher', { pluginId });
        } catch (watcherError: any) {
          logger.error('Failed to stop file watcher', watcherError);
        }
      }

      // 3.5. 清理插件视图
      try {
        await this.viewManager.cleanupPluginViews(pluginId);
        logger.debug('Cleaned up remaining plugin views', { pluginId });
      } catch (viewError: any) {
        logger.error('Failed to cleanup plugin views', viewError);
      }

      // 4. 清理数据库中的 UI 扩展
      try {
        await callbacks.unregisterUIContributions(pluginId);
        logger.debug('Unregistered UI contributions', { pluginId });
      } catch (uiError: any) {
        logger.error('Failed to unregister UI contributions', uiError);
      }

      logger.info('Plugin deactivated', { pluginId });
      this.runtimeRegistry?.setLifecyclePhase(pluginId, 'inactive');
      return true;
    } catch (error: any) {
      logger.error('Failed to deactivate plugin', { pluginId, error });
      this.runtimeRegistry?.recordError(pluginId, error, 'error');
      throw error;
    }
  }

  /**
   * 重新加载插件
   */
  async reload(
    pluginId: string,
    callbacks: {
      load: (pluginId: string) => Promise<void>;
      getPluginInfo: (pluginId: string) => Promise<JSPluginInfo | null>;
    }
  ): Promise<void> {
    logger.info('Reloading plugin', { pluginId });

    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      const mainPath = path.join(plugin.path, plugin.manifest.main);

      let realPath: string | undefined;
      try {
        realPath = fs.realpathSync(mainPath);
        if (realPath === mainPath) {
          realPath = undefined;
        }
      } catch (error) {
        logger.warn('Cannot resolve real path', error);
      }

      logger.debug('Plugin reload info', {
        pluginPath: plugin.path,
        mainFile: plugin.manifest.main,
        fullPath: mainPath,
        realPath,
      });

      // 检查缓存状态
      const cachedKeys = Object.keys(require.cache).filter(
        (key) => key.includes(plugin.manifest.id) || key.includes(plugin.manifest.name)
      );

      logger.debug('Cached entries before reload', {
        count: cachedKeys.length,
        keys: cachedKeys.slice(0, 5),
      });
    }

    await callbacks.load(pluginId);

    // 热重载时同步更新插件元数据
    try {
      const pluginInfo = await callbacks.getPluginInfo(pluginId);
      if (pluginInfo?.devMode && pluginInfo?.sourcePath) {
        logger.debug('Updating plugin metadata from manifest');

        const latestManifest = await readManifest(pluginInfo.sourcePath);

        await this.duckdb.executeWithParams(
          `UPDATE js_plugins
           SET name = ?, description = ?, version = ?, icon = ?, category = ?, author = ?
           WHERE id = ?`,
          [
            latestManifest.name,
            latestManifest.description || null,
            latestManifest.version,
            latestManifest.icon || null,
            latestManifest.category || null,
            latestManifest.author,
            pluginId,
          ]
        );

        logger.info('Plugin metadata updated', {
          name: latestManifest.name,
          version: latestManifest.version,
        });
      }
    } catch (metadataError: any) {
      logger.warn('Failed to update metadata', { error: metadataError.message });
    }

    logger.info('Reload completed', { pluginId });

    // 发射热重载完成事件
    await pluginEventBus.emit(PluginEvents.RELOADED, {
      pluginId,
      success: true,
    } as PluginReloadedPayload);
  }

  /**
   * 启用插件
   */
  async enable(pluginId: string): Promise<void> {
    logger.info('Enabling plugin', { pluginId });

    await this.duckdb.executeWithParams(`UPDATE js_plugins SET enabled = ? WHERE id = ?`, [
      true,
      pluginId,
    ]);

    logger.info('Plugin enabled', { pluginId });
    this.runtimeRegistry?.setLifecyclePhase(pluginId, 'inactive');
  }

  /**
   * 禁用插件
   */
  async disable(pluginId: string): Promise<void> {
    logger.info('Disabling plugin', { pluginId });

    await this.duckdb.executeWithParams(`UPDATE js_plugins SET enabled = ? WHERE id = ?`, [
      false,
      pluginId,
    ]);

    logger.info('Plugin disabled', { pluginId });
    this.runtimeRegistry?.setLifecyclePhase(pluginId, 'disabled');
  }

  // ========== 热重载相关 ==========

  /**
   * 启用热重载
   */
  async enableHotReload(
    pluginId: string,
    getPluginInfo: (pluginId: string) => Promise<JSPluginInfo | null>,
    reloadPlugin: (pluginId: string) => Promise<void>
  ): Promise<{ success: boolean; message: string }> {
    const info = await getPluginInfo(pluginId);

    if (!info) {
      return { success: false, message: '插件不存在' };
    }

    if (!info.devMode || !info.sourcePath) {
      return { success: false, message: '只有开发模式插件支持热重载' };
    }

    if (this.fileWatcherManager.isWatching(pluginId)) {
      return { success: false, message: '热重载已经启用' };
    }

    try {
      const pluginLogger = this.loggers.get(pluginId);
      await this.fileWatcherManager.startWatching(pluginId, info.sourcePath, async () => {
        pluginLogger?.info('File change detected, triggering hot reload...');
        await reloadPlugin(pluginId);
      });

      await this.duckdb.executeWithParams(
        `UPDATE js_plugins SET hot_reload_enabled = ? WHERE id = ?`,
        [true, pluginId]
      );

      return { success: true, message: '热重载已启用' };
    } catch (error: any) {
      return { success: false, message: `启用热重载失败: ${error.message}` };
    }
  }

  /**
   * 禁用热重载
   */
  async disableHotReload(pluginId: string): Promise<{ success: boolean; message: string }> {
    if (!this.fileWatcherManager.isWatching(pluginId)) {
      return { success: false, message: '热重载未启用' };
    }

    try {
      await this.fileWatcherManager.stopWatching(pluginId);

      await this.duckdb.executeWithParams(
        `UPDATE js_plugins SET hot_reload_enabled = ? WHERE id = ?`,
        [false, pluginId]
      );

      return { success: true, message: '热重载已禁用' };
    } catch (error: any) {
      return { success: false, message: `禁用热重载失败: ${error.message}` };
    }
  }

  /**
   * 检查热重载是否启用
   */
  isHotReloadEnabled(pluginId: string): boolean {
    return this.fileWatcherManager.isWatching(pluginId);
  }

  /**
   * 获取启用热重载的插件列表
   */
  getHotReloadEnabledPlugins(): string[] {
    return this.fileWatcherManager.getWatchingPlugins();
  }

  // ========== 私有辅助方法 ==========

  /**
   * 设置插件的 Helpers 实例
   */
  private setupPluginHelpers(pluginId: string, plugin: LoadedJSPlugin): PluginHelpers {
    const helpers = new PluginHelpers(
      this.duckdb,
      pluginId,
      plugin.manifest,
      this.viewManager,
      this.windowManager,
      this.hookBus,
      this.webhookSender,
      this.runtimeRegistry
    );
    this.helpers.set(pluginId, helpers);
    return helpers;
  }

  /**
   * 加载插件创建的数据表
   */
  private async loadPluginDataTables(
    pluginId: string,
    pluginLogger: PluginLogger
  ): Promise<DataTableInfo[]> {
    const dataTablesResult = await this.duckdb.executeSQLWithParams(
      `SELECT id, name, schema FROM datasets WHERE created_by_plugin = ?`,
      [pluginId]
    );

    const dataTables = dataTablesResult.map((row: any) => {
      const idParts = row.id.split('__');
      const code = idParts.length === 3 ? idParts[2] : '';

      const tableInfo: any = {
        id: row.id,
        name: row.name,
        code,
      };

      // 延迟解析 schema
      if (row.schema) {
        let cachedColumns: any[] | null = null;
        Object.defineProperty(tableInfo, 'columns', {
          get() {
            if (cachedColumns === null) {
              try {
                cachedColumns = JSON.parse(row.schema);
              } catch (error) {
                pluginLogger.warn(`Failed to parse schema for table ${row.id}`, { error });
                cachedColumns = [];
              }
            }
            return cachedColumns;
          },
          enumerable: true,
          configurable: true,
        });
      }

      return tableInfo as DataTableInfo;
    });

    pluginLogger.info(`Found ${dataTables.length} data table(s)`, {
      tables: dataTables.map((t: DataTableInfo) => ({ code: t.code, id: t.id, name: t.name })),
    });

    return dataTables;
  }

  /**
   * 创建插件 Context
   */
  private createPluginContext(
    pluginId: string,
    plugin: LoadedJSPlugin,
    helpers: PluginHelpers,
    dataTables: DataTableInfo[]
  ): PluginContext {
    const context = new PluginContext(plugin.manifest, helpers, this.duckdb, pluginId, dataTables);
    this.contexts.set(pluginId, context);
    helpers.setContext(context);
    return context;
  }

  /**
   * 调用插件的 activate 钩子
   *
   * 同时支持 activate 和 commands：
   * 1. 如果有 commands，先注册所有命令
   * 2. 如果有 activate，调用 activate（可在其中覆盖或添加命令）
   *
   * 这允许插件既使用声明式 commands，又通过 activate 进行动态注册
   */
  private async invokePluginActivateHook(
    plugin: LoadedJSPlugin,
    context: PluginContext
  ): Promise<void> {
    // 1. 先注册 commands 对象中声明的命令
    if (plugin.module.commands) {
      for (const [commandId, handler] of Object.entries(plugin.module.commands)) {
        context.registerCommand(commandId, handler);
      }
    }

    // 2. 再调用 activate 钩子（可覆盖或添加命令）
    if (plugin.module.activate) {
      await plugin.module.activate(context);
    }
  }

  /**
   * 设置插件 UI
   */
  private async setupPluginUI(
    pluginId: string,
    plugin: LoadedJSPlugin,
    pluginLogger: PluginLogger,
    callbacks: {
      registerUIContributions: (pluginId: string, manifest: JSPluginManifest) => Promise<void>;
      unregisterUIContributions: (pluginId: string) => Promise<void>;
      createPluginViews: (pluginId: string, viewConfig: any) => Promise<void>;
    }
  ): Promise<void> {
    if (plugin.manifest.contributes?.activityBarView) {
      await callbacks.createPluginViews(pluginId, plugin.manifest.contributes.activityBarView);
      pluginLogger.info('Created plugin views', { pageView: true });
    }

    if (plugin.manifest.contributes) {
      // 直接使用 UPSERT 更新 UI 贡献，无需先删除
      // 这样可以保留 applies_to 等在导入时解析的字段
      await callbacks.registerUIContributions(pluginId, plugin.manifest);
    }
  }

  /**
   * 设置热重载
   */
  private async setupHotReloadIfEnabled(
    pluginId: string,
    pluginLogger: PluginLogger,
    getPluginInfo: (pluginId: string) => Promise<JSPluginInfo | null>,
    reloadPlugin: (pluginId: string) => Promise<void>
  ): Promise<void> {
    const pluginInfo = await getPluginInfo(pluginId);
    if (pluginInfo?.devMode && pluginInfo?.sourcePath && pluginInfo?.hotReloadEnabled !== false) {
      try {
        await this.fileWatcherManager.startWatching(pluginId, pluginInfo.sourcePath, async () => {
          pluginLogger.info('File change detected, triggering hot reload...');
          await reloadPlugin(pluginId);
        });
        pluginLogger.info('File watcher started (hot reload enabled)', {
          sourcePath: pluginInfo.sourcePath,
        });
      } catch (watchError: any) {
        pluginLogger.warn('Failed to start file watcher', {
          error: watchError.message,
          note: 'Hot reload will not be available, but plugin is still active',
        });
      }
    }
  }

  /**
   * 同步 API 和命令到 Registry
   */
  private syncToRegistry(pluginId: string, context: PluginContext, helpers: PluginHelpers): void {
    const registry = getPluginRegistry();

    // 同步暴露的 API
    const exposedAPIs = context.getAllExposedAPIs();
    for (const [apiName, handler] of Array.from(exposedAPIs.entries())) {
      registry.registerAPI(pluginId, apiName, {
        handler: async (...args: unknown[]) => handler(...args),
        description: `API exposed by plugin ${pluginId}`,
      });
    }

    // 同步注册的命令
    const commands = context.getCommands();
    for (const [commandId, handler] of Array.from(commands.entries())) {
      registry.registerCommand(pluginId, commandId, {
        handler,
        description: `Command registered by plugin ${pluginId}`,
      });
    }

    // 设置 helpers 引用
    registry.setPluginHelpers(pluginId, helpers);
  }
}
