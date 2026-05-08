/**
 * JS插件IPC处理器
 * 负责处理前端的JS插件相关请求
 */

import { type IpcMainInvokeEvent, dialog, app } from 'electron';
import { ipcRouteRegistry } from '../ipc-route-registry';
import Store from 'electron-store';
import fs from 'fs-extra';
import { JSPluginManager } from '../../core/js-plugin/manager';
import { readManifest } from '../../core/js-plugin/loader';
import { ButtonExecutor } from '../../core/js-plugin/button-executor';
import { handleIPCError } from '../ipc-utils';
import type { DuckDBService } from '../duckdb/service';
import type { WebContentsViewManager } from '../webcontentsview-manager';
import type { WindowManager } from '../window-manager';
import {
  pluginEventBus,
  PluginEvents,
  type PluginNotificationPayload,
  type PluginReloadedPayload,
} from '../../core/js-plugin/events';
import type { JSPluginRuntimeStatusChangeEvent } from '../../types/js-plugin';
import type { CloudRuntimeAuthorizeResult, CloudRuntimePluginProvider } from '../../edition/types';
import { DEFAULT_HTTP_API_CONFIG, type HttpApiConfig } from '../../constants/http-api';
import { isDevelopmentMode } from '../../constants/runtime-config';
import { registerJSPluginConfigRoutes } from './js-plugin-routes/config-routes';
import { registerJSPluginHotReloadRoutes } from './js-plugin-routes/hot-reload-routes';
import { registerJSPluginLifecycleRoutes } from './js-plugin-routes/lifecycle-routes';
import { registerJSPluginUIExtensionRoutes } from './js-plugin-routes/ui-extension-routes';
import { registerJSPluginViewRoutes } from './js-plugin-routes/view-routes';

const store = new Store();

export class JSPluginIPCHandler {
  private buttonExecutor: ButtonExecutor;
  private unregisterCommandExecutionGuard: (() => void) | null = null;
  private cloudPluginBindingCache = new Map<
    string,
    {
      pluginCode: string;
      authRequired: boolean;
    } | null
  >();

  constructor(
    private pluginManager: JSPluginManager,
    private duckdb: DuckDBService,
    private viewManager: WebContentsViewManager,
    private windowManager: WindowManager,
    private cloudRuntimePluginProvider?: CloudRuntimePluginProvider
  ) {
    // 创建按钮执行引擎
    this.buttonExecutor = new ButtonExecutor(pluginManager, duckdb);
  }

  /**
   * 注册所有IPC处理器
   */
  register(): void {
    if (this.cloudRuntimePluginProvider) {
      this.setupCloudRuntimeExecutionGuard();
      this.registerCloudPluginInstall();
    }
    this.registerImport();
    registerJSPluginLifecycleRoutes(this.pluginManager, this.duckdb);
    registerJSPluginConfigRoutes(this.pluginManager, this.duckdb);

    registerJSPluginUIExtensionRoutes({
      pluginManager: this.pluginManager,
      duckdb: this.duckdb,
      buttonExecutor: this.buttonExecutor,
      ensurePluginLoaded: this.ensurePluginLoaded.bind(this),
    });
    registerJSPluginViewRoutes(this.viewManager);
    registerJSPluginHotReloadRoutes(this.pluginManager);

    // 🆕 设置插件事件转发到前端
    this.setupPluginEventForwarding();
  }

  // ========== 插件管理 ==========

  /**
   * 导入插件
   */
  private registerImport(): void {
    ipcRouteRegistry.register({
      channel: 'js-plugin:import',
      kind: 'handle',
      permission: 'privileged',
      schema: {
        description: 'Import a local plugin package or development directory.',
        args: [
          { name: 'sourcePath', type: 'string', required: false },
          { name: 'options', type: 'object', required: false },
        ],
        result: { success: 'boolean', pluginId: 'string?', error: 'string?' },
      },
      handler: async (
        event: IpcMainInvokeEvent,
        sourcePath?: string,
        options?: { devMode?: boolean }
      ) => {
        console.log(`[IPC] js-plugin:import called`);
        console.log(`[IPC] sourcePath provided: ${sourcePath ? 'YES' : 'NO'}`);
        console.log(`[IPC] devMode: ${options?.devMode}`);

        try {
          const httpApiConfig = store.get(
            'httpApiConfig',
            DEFAULT_HTTP_API_CONFIG
          ) as HttpApiConfig;
          const shouldShowDevOptions =
            (!app.isPackaged && isDevelopmentMode()) || (httpApiConfig.enableDevMode ?? false);
          if (!shouldShowDevOptions) {
            return {
              success: false,
              error: 'Local plugin import is only available in developer mode',
            };
          }

          let pluginPath = sourcePath;

          // 如果没有提供路径，打开文件选择对话框
          if (!pluginPath) {
            console.log(`[IPC] Opening file dialog...`);

            let dialogConfig: any;
            if (options?.devMode) {
              // 开发模式导入固定要求选择目录，打包版也允许本地目录调试。
              console.log(`[IPC] Development mode import: allowing directory selection`);
              dialogConfig = {
                title: '选择插件目录',
                properties: ['openDirectory'],
                // 注意：Windows 上 openDirectory 不支持 filters
              };
            } else {
              console.log(`[IPC] Archive import: allowing file selection`);
              dialogConfig = {
                title: '选择插件压缩包',
                properties: ['openFile'],
                filters: [
                  { name: '插件压缩包', extensions: ['tsai', 'zip'] },
                  { name: '所有文件', extensions: ['*'] },
                ],
              };
            }

            const result = await dialog.showOpenDialog(dialogConfig);

            console.log(`[IPC] Dialog closed. Canceled: ${result.canceled}`);

            if (result.canceled || result.filePaths.length === 0) {
              console.log(`[IPC] User canceled or no selection`);
              return { success: false, error: 'User canceled' };
            }

            console.log(`[IPC] Selected paths count: ${result.filePaths.length}`);
            console.log(`[IPC] First path: ${result.filePaths[0]}`);

            pluginPath = result.filePaths[0];

            console.log(`[IPC] Waiting 150ms for file handles to release...`);
            // 🆕 添加短暂延迟，确保文件系统句柄完全释放（Windows 特有问题）
            // 这可以防止在文件选择对话框关闭后立即访问文件时发生崩溃
            await new Promise((resolve) => setTimeout(resolve, 150));
            console.log(`[IPC] Delay completed`);
          }

          console.log(`[IPC] About to import plugin from: ${pluginPath}`);
          if (options?.devMode) {
            console.log(`[IPC] Development mode requested`);
          }

          const importResult = await this.pluginManager.import(pluginPath, {
            ...options,
            trustedFirstParty: true,
          });

          // 🆕 如果安装成功，发送插件状态变化事件
          if (importResult.success && importResult.pluginId) {
            event.sender.send('js-plugin:state-changed', {
              pluginId: importResult.pluginId,
              state: 'installed',
            });
          }

          return importResult;
        } catch (error: unknown) {
          console.error(`[IPC] Import failed:`, error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 安装云端托管插件（安装鉴权 -> 下载 zip -> 本地导入）
   */
  private registerCloudPluginInstall(): void {
    ipcRouteRegistry.register({
      channel: 'cloud-catalog:plugins:install',
      kind: 'handle',
      permission: 'privileged',
      schema: {
        description: 'Download and install a managed cloud plugin package.',
        args: [{ name: 'params', type: 'object', required: true }],
        result: { success: 'boolean', data: 'object?', error: 'string?' },
      },
      handler: async (event: IpcMainInvokeEvent, params: { pluginCode: string }) => {
        let tempZipPath = '';
        try {
          const pluginCode = String(params?.pluginCode || '').trim();
          if (!pluginCode) {
            throw new Error('pluginCode 不能为空');
          }

          const cloudRuntimePluginProvider = this.requireCloudRuntimePluginProvider();
          const pkg = await cloudRuntimePluginProvider.fetchInstallPackage({
            pluginCode,
          });
          tempZipPath = pkg.tempZipPath;

          const importResult = await this.pluginManager.installOrUpdateCloudPlugin(
            pkg.tempZipPath,
            {
              devMode: false,
              sourceType: 'cloud_managed',
              installChannel: 'cloud_download',
              cloudPluginCode: pkg.pluginCode,
              cloudReleaseVersion: pkg.releaseVersion,
              managedByPolicy: true,
              policyVersion: pkg.policyVersion,
              lastPolicySyncAt: Date.now(),
            }
          );
          if (!importResult.success || !importResult.pluginId) {
            throw new Error(importResult.error || '安装云端插件失败');
          }

          event.sender.send('js-plugin:state-changed', {
            pluginId: importResult.pluginId,
            state: 'installed',
          });

          return {
            success: true,
            data: {
              pluginId: importResult.pluginId,
              pluginCode: pkg.pluginCode,
              releaseVersion: pkg.releaseVersion,
              policyVersion: pkg.policyVersion,
              operation: importResult.operation || 'installed',
              warnings: importResult.warnings || [],
            },
          };
        } catch (error: unknown) {
          return handleIPCError(error);
        } finally {
          if (tempZipPath) {
            try {
              await fs.remove(tempZipPath);
            } catch (cleanupError) {
              console.warn('[CloudPluginInstall] Failed to cleanup temp zip:', cleanupError);
            }
          }
        }
      },
    });
  }

  /**
   * 为插件命令执行注册云端授权守卫（cloud_managed 或声明 cloud 授权的插件生效）
   */
  private setupCloudRuntimeExecutionGuard(): void {
    if (this.unregisterCommandExecutionGuard) {
      return;
    }

    this.unregisterCommandExecutionGuard = this.pluginManager.registerCommandExecutionGuard(
      async ({ pluginId, params }) => {
        const binding = await this.resolveCloudPluginBinding(pluginId);
        const runtimeRef = this.extractCloudRuntimeRef(params);
        const runtimePluginCode = String(runtimeRef.pluginCode || '').trim();
        const authRequired = binding?.authRequired === true || runtimePluginCode.length > 0;
        if (!authRequired) {
          return;
        }

        if (!runtimeRef.present) {
          throw new Error(
            `[CLOUD_RUNTIME_REQUIRED] Plugin "${pluginId}" requires __cloudRuntime. ` +
              `Please pass __cloudRuntime.pluginCode and a profile reference in command params.`
          );
        }

        const cloudPluginCode = runtimePluginCode || String(binding?.pluginCode || '').trim();
        if (!cloudPluginCode) {
          throw new Error(
            `[CLOUD_RUNTIME_REQUIRED] Plugin "${pluginId}" requires __cloudRuntime.pluginCode.`
          );
        }

        const cloudRuntimePluginProvider = this.requireCloudRuntimePluginProvider();
        const profileUid = cloudRuntimePluginProvider.resolveProfileUidFromCloudMapping(runtimeRef);
        if (!profileUid) {
          throw new Error(
            `[PROFILE_UID_REQUIRED] Cloud plugin "${cloudPluginCode}" requires profileUid. ` +
              `Please pass __cloudRuntime.profileUid/localProfileId/cloudUid and ensure mapping is synced.`
          );
        }

        const auth = await cloudRuntimePluginProvider.authorizeAccess({
          pluginCode: cloudPluginCode,
          profileUid,
        });
        if (!auth.allowed) {
          throw new Error(this.formatCloudAuthorizeDeniedMessage(auth));
        }
      }
    );
  }

  private formatCloudAuthorizeDeniedMessage(auth: CloudRuntimeAuthorizeResult): string {
    const reason = String(auth.reason || 'DENIED').trim() || 'DENIED';
    if (reason === 'CLIENT_VERSION_TOO_LOW') {
      const currentVersion = String(auth.clientVersion || '').trim() || 'unknown';
      const minVersion = String(auth.minClientVersion || '').trim() || 'unknown';
      return `[${reason}] Client version ${currentVersion} is lower than minimum ${minVersion}`;
    }

    return `[${reason}] Cloud plugin authorization denied`;
  }

  private requireCloudRuntimePluginProvider(): CloudRuntimePluginProvider {
    if (!this.cloudRuntimePluginProvider) {
      throw new Error('cloud runtime plugin provider is not available in this edition');
    }
    return this.cloudRuntimePluginProvider;
  }

  private extractCloudRuntimeRef(params: any): {
    present: boolean;
    pluginCode?: string;
    profileUid?: string;
    localProfileId?: string;
    cloudUid?: string;
  } {
    const runtime = params?.__cloudRuntime;
    if (!runtime || typeof runtime !== 'object') {
      return { present: false };
    }

    return {
      present: true,
      pluginCode: String((runtime as any).pluginCode || '').trim() || undefined,
      profileUid: String((runtime as any).profileUid || '').trim() || undefined,
      localProfileId: String((runtime as any).localProfileId || '').trim() || undefined,
      cloudUid: String((runtime as any).cloudUid || '').trim() || undefined,
    };
  }

  private async resolveCloudPluginBinding(pluginId: string): Promise<
    | {
        pluginCode: string;
        authRequired: boolean;
      }
    | undefined
  > {
    if (this.cloudPluginBindingCache.has(pluginId)) {
      const cached = this.cloudPluginBindingCache.get(pluginId);
      return cached || undefined;
    }

    const pluginInfo = await this.pluginManager.getPluginInfo(pluginId);
    if (!pluginInfo) {
      this.cloudPluginBindingCache.set(pluginId, null);
      return undefined;
    }

    const dbPluginCode = String(pluginInfo.cloudPluginCode || '').trim();
    const isCloudManaged = pluginInfo.sourceType === 'cloud_managed';

    let manifestPluginCode = '';
    let manifestAuthRequired = false;
    try {
      const manifest = await readManifest(pluginInfo.path);
      const manifestAny = manifest as any;

      manifestPluginCode =
        (typeof manifestAny?.cloudPluginCode === 'string' && manifestAny.cloudPluginCode.trim()) ||
        (typeof manifestAny?.cloudRuntime?.pluginCode === 'string' &&
          manifestAny.cloudRuntime.pluginCode.trim()) ||
        (typeof manifestAny?.cloud?.pluginCode === 'string' &&
          manifestAny.cloud.pluginCode.trim()) ||
        '';

      manifestAuthRequired =
        manifestAny?.cloudAuthRequired === true ||
        manifestAny?.cloudRuntime?.authRequired === true ||
        manifestAny?.cloud?.authRequired === true;
    } catch (error) {
      console.warn(`[CloudPluginGuard] Failed to read manifest for ${pluginId}:`, error);
    }

    const authRequired =
      manifestAuthRequired ||
      isCloudManaged ||
      Boolean(manifestPluginCode) ||
      Boolean(dbPluginCode);
    const resolvedPluginCode = manifestPluginCode || dbPluginCode || (authRequired ? pluginId : '');
    const binding =
      authRequired && resolvedPluginCode
        ? {
            pluginCode: resolvedPluginCode,
            authRequired: true,
          }
        : null;

    this.cloudPluginBindingCache.set(pluginId, binding);
    return binding || undefined;
  }

  // ========== 辅助方法 ==========

  /**
   * 确保插件已加载和激活
   * 如果插件未激活，尝试加载它
   *
   * @param pluginId - 插件ID
   */
  private async ensurePluginLoaded(pluginId: string): Promise<void> {
    // 检查插件是否已经有 Context（已激活）
    const context = this.pluginManager.getContext(pluginId);
    if (context) {
      return; // 已激活，直接返回
    }

    console.log(`⚠️  Plugin ${pluginId} is not activated, attempting to load...`);

    // 检查插件是否在数据库中
    const pluginInfo = await this.pluginManager.getPluginInfo(pluginId);
    if (!pluginInfo) {
      throw new Error(`Plugin ${pluginId} is not installed. Please install it first.`);
    }

    // 尝试加载插件（会自动调用 activate）
    try {
      await this.pluginManager.load(pluginId);
      console.log(`✅ Plugin ${pluginId} loaded successfully`);
    } catch (error: unknown) {
      console.error(`❌ Failed to load plugin ${pluginId}:`, error);
      const errorMessage = handleIPCError(error).error;
      throw new Error(
        `Failed to activate plugin ${pluginId}: ${errorMessage}. ` +
          `Please check the plugin code or try reinstalling it.`
      );
    }
  }

  /**
   * 设置插件事件转发
   * 监听核心层的插件事件，转发到前端渲染进程
   */
  private setupPluginEventForwarding(): void {
    this.pluginManager.onRuntimeStatusChanged((payload: JSPluginRuntimeStatusChangeEvent) => {
      const mainWindow = this.windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('js-plugin:runtime-status-changed', payload);
      }
    });

    // 监听插件热重载事件
    pluginEventBus.on(PluginEvents.RELOADED, (payload: PluginReloadedPayload) => {
      this.cloudPluginBindingCache.delete(payload.pluginId);
      // v3 API: 使用 getMainWindowV3()
      const mainWindow = this.windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('js-plugin:reloaded', payload);
        console.log(`[IPC] Plugin reloaded event forwarded: ${payload.pluginId}`);
      }
    });

    pluginEventBus.on(PluginEvents.NOTIFICATION, (payload: PluginNotificationPayload) => {
      const mainWindow = this.windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('js-plugin:notification', payload);
      }
    });
  }
}
