/**
 * JS插件IPC处理器
 * 负责处理前端的JS插件相关请求
 */

import { ipcMain, type IpcMainInvokeEvent, dialog, app } from 'electron';
import Store from 'electron-store';
import fs from 'fs-extra';
import { JSPluginManager } from '../../core/js-plugin/manager';
import { readManifest } from '../../core/js-plugin/loader';
import { ButtonExecutor } from '../../core/js-plugin/button-executor';
import { handleIPCError } from '../ipc-utils';
import type { DuckDBService } from '../duckdb/service';
import type { WebContentsViewManager } from '../webcontentsview-manager';
import { windowManager } from '../index';
import { DEFAULT_VIEW_BOUNDS } from '../../constants/layout';
import {
  pluginEventBus,
  PluginEvents,
  type PluginNotificationPayload,
  type PluginReloadedPayload,
} from '../../core/js-plugin/events';
import type { JSPluginRuntimeStatusChangeEvent } from '../../types/js-plugin';
import type {
  CloudRuntimeAuthorizeResult,
  CloudRuntimePluginProvider,
} from '../../edition/types';
import { DEFAULT_HTTP_API_CONFIG, type HttpApiConfig } from '../../constants/http-api';
import { isDevelopmentMode } from '../../constants/runtime-config';

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
    this.registerList();
    this.registerListRuntimeStatuses();
    this.registerGet();
    this.registerGetRuntimeStatus();
    this.registerUninstall();
    this.registerCancelPluginTasks();
    this.registerGetPluginTables(); // 🆕 获取插件创建的表
    this.registerReload();
    this.registerRepair(); // 🆕 修复插件符号链接
    this.registerEnable(); // 🆕 启用插件
    this.registerDisable(); // 🆕 禁用插件

    // 🆕 插件配置相关
    this.registerGetConfig();
    this.registerSetConfig();

    // 🆕 UI 扩展相关
    this.registerExecuteCommand();
    this.registerGetToolbarButtons();
    this.registerExecuteActionColumn();
    this.registerExecuteToolbarButton();

    // 🆕 自定义页面相关
    this.registerGetCustomPages();
    this.registerRenderCustomPage();
    this.registerHandlePageMessage();

    // ✅ Activity Bar 视图和 API 调用
    this.registerCallPluginAPI();
    this.registerShowPluginView();
    this.registerHidePluginView();
    this.registerGetPluginViewInfo();
    this.registerSetPluginViewBounds(); // ✨ 设置插件视图边界
    this.registerGetLayoutInfo(); // ✨ 获取布局信息（修复：之前未注册）
    this.registerEnableHotReload(); // 🆕 启用热重载
    this.registerDisableHotReload(); // 🆕 禁用热重载
    this.registerGetHotReloadStatus(); // 🆕 获取热重载状态

    // 🆕 设置插件事件转发到前端
    this.setupPluginEventForwarding();
  }

  // ========== 插件管理 ==========

  /**
   * 导入插件
   */
  private registerImport(): void {
    ipcMain.handle(
      'js-plugin:import',
      async (event: IpcMainInvokeEvent, sourcePath?: string, options?: { devMode?: boolean }) => {
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

          const importResult = await this.pluginManager.import(pluginPath, options);

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
      }
    );
  }

  /**
   * 安装云端托管插件（安装鉴权 -> 下载 zip -> 本地导入）
   */
  private registerCloudPluginInstall(): void {
    ipcMain.handle(
      'cloud-catalog:plugins:install',
      async (event: IpcMainInvokeEvent, params: { pluginCode: string }) => {
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
      }
    );
  }

  /**
   * 列出所有已安装的插件
   */
  private registerList(): void {
    ipcMain.handle('js-plugin:list', async () => {
      try {
        const plugins = await this.pluginManager.listPlugins();
        return { success: true, plugins };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取插件详细信息
   */
  private registerGet(): void {
    ipcMain.handle('js-plugin:get', async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const plugin = await this.pluginManager.getPluginInfo(pluginId);

        if (!plugin) {
          return { success: false, error: 'Plugin not found' };
        }

        // 读取 manifest 以获取完整信息
        try {
          const manifest = await readManifest(plugin.path);
          return {
            success: true,
            plugin: {
              ...plugin,
              manifest,
            },
          };
        } catch (error) {
          // 如果读取 manifest 失败，仍然返回基本信息
          console.warn(`Failed to read manifest for plugin ${pluginId}:`, error);
          return { success: true, plugin };
        }
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取所有插件运行态
   */
  private registerListRuntimeStatuses(): void {
    ipcMain.handle('js-plugin:list-runtime-statuses', async () => {
      try {
        const statuses = await this.pluginManager.listRuntimeStatuses();
        return { success: true, statuses };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取单个插件运行态
   */
  private registerGetRuntimeStatus(): void {
    ipcMain.handle(
      'js-plugin:get-runtime-status',
      async (_event: IpcMainInvokeEvent, pluginId: string) => {
        try {
          const status = await this.pluginManager.getRuntimeStatus(pluginId);
          if (!status) {
            return { success: false, error: 'Plugin not found' };
          }
          return { success: true, status };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 卸载插件
   * 🆕 支持选择是否同时删除插件创建的数据表
   */
  private registerUninstall(): void {
    ipcMain.handle(
      'js-plugin:uninstall',
      async (event: IpcMainInvokeEvent, pluginId: string, deleteTables: boolean = false) => {
        try {
          await this.pluginManager.uninstall(pluginId, deleteTables);

          // 🆕 发送插件状态变化事件到渲染进程（触发 ActivityBar 刷新）
          event.sender.send('js-plugin:state-changed', {
            pluginId,
            state: 'uninstalled',
          });

          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 取消插件的所有运行中/排队任务
   */
  private registerCancelPluginTasks(): void {
    ipcMain.handle(
      'js-plugin:cancel-plugin-tasks',
      async (_event: IpcMainInvokeEvent, pluginId: string) => {
        try {
          const result = await this.pluginManager.cancelPluginTasks(pluginId);
          return { success: true, ...result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 获取插件创建的数据表列表
   */
  private registerGetPluginTables(): void {
    ipcMain.handle('js-plugin:get-tables', async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const tables = await this.duckdb.executeSQLWithParams(
          `SELECT id, name, row_count, column_count, size_bytes
           FROM datasets
           WHERE created_by_plugin = ?
           ORDER BY name`,
          [pluginId]
        );

        return {
          success: true,
          tables: tables.map((t: any) => ({
            id: t.id,
            name: t.name,
            rowCount: t.row_count,
            columnCount: t.column_count,
            sizeBytes: t.size_bytes,
          })),
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 重新加载插件
   */
  private registerReload(): void {
    ipcMain.handle('js-plugin:reload', async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        await this.pluginManager.reload(pluginId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 修复插件（重新创建符号链接）
   */
  private registerRepair(): void {
    ipcMain.handle('js-plugin:repair', async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        console.log(`[IPC] Repairing plugin: ${pluginId}`);

        const result = await this.pluginManager.repairPlugin(pluginId);

        if (result.success) {
          // 发送插件状态变化事件
          event.sender.send('js-plugin:state-changed', {
            pluginId,
            state: 'repaired',
          });
        }

        return { success: true, result };
      } catch (error: unknown) {
        console.error(`[IPC] Repair failed:`, error);
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 启用插件
   */
  private registerEnable(): void {
    ipcMain.handle('js-plugin:enable', async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        await this.pluginManager.enable(pluginId);

        // 发送插件状态变化事件到渲染进程
        event.sender.send('js-plugin:state-changed', {
          pluginId,
          state: 'enabled',
        });

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 禁用插件
   */
  private registerDisable(): void {
    ipcMain.handle('js-plugin:disable', async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        await this.pluginManager.disable(pluginId);

        // 发送插件状态变化事件到渲染进程
        event.sender.send('js-plugin:state-changed', {
          pluginId,
          state: 'disabled',
        });

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  // ========== 🆕 插件配置相关 ==========

  /**
   * 获取插件配置项
   */
  private registerGetConfig(): void {
    ipcMain.handle(
      'js-plugin:get-config',
      async (event: IpcMainInvokeEvent, pluginId: string, key: string) => {
        try {
          // 验证插件存在
          const info = await this.pluginManager.getPluginInfo(pluginId);
          if (!info) {
            throw new Error(`Plugin "${pluginId}" not found`);
          }

          // 直接从数据库读取配置
          const sql = `
          SELECT value FROM plugin_configurations
          WHERE plugin_id = ? AND key = ?
        `;
          const result = await this.duckdb.executeSQLWithParams(sql, [pluginId, key]);

          if (result.length === 0) {
            // 返回默认值 - 需要读取 manifest
            try {
              const manifest = await readManifest(info.path);
              return manifest.configuration?.properties?.[key]?.default;
            } catch (error) {
              console.warn(`Failed to read manifest for default value:`, error);
              return undefined;
            }
          }

          return JSON.parse(result[0].value);
        } catch (error: unknown) {
          console.error(`Failed to get config "${key}" for plugin "${pluginId}":`, error);
          throw error;
        }
      }
    );
  }

  /**
   * 设置插件配置项
   */
  private registerSetConfig(): void {
    ipcMain.handle(
      'js-plugin:set-config',
      async (event: IpcMainInvokeEvent, pluginId: string, key: string, value: any) => {
        try {
          // 验证插件存在
          const info = await this.pluginManager.getPluginInfo(pluginId);
          if (!info) {
            throw new Error(`Plugin "${pluginId}" not found`);
          }

          // 直接写入数据库
          const sql = `
          INSERT INTO plugin_configurations (plugin_id, key, value, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (plugin_id, key)
          DO UPDATE SET value = ?, updated_at = ?
        `;
          await this.duckdb.executeWithParams(sql, [
            pluginId,
            key,
            JSON.stringify(value),
            Date.now(),
            JSON.stringify(value),
            Date.now(),
          ]);

          return { success: true };
        } catch (error: unknown) {
          console.error(`Failed to set config "${key}" for plugin "${pluginId}":`, error);
          throw error;
        }
      }
    );
  }

  // ========== 🆕 UI 扩展相关 ==========

  /**
   * 执行命令
   * ✅ 不再创建临时 driver，由插件通过 helpers.profile.launch() 管理浏览器
   */
  private registerExecuteCommand(): void {
    ipcMain.handle(
      'js-plugin:execute-command',
      this.withPluginLoaded(async (event, pluginId: string, commandId: string, params: any) => {
        // ✅ 直接执行命令，不传递 driver
        const result = await this.pluginManager.executeCommand(pluginId, commandId, params);
        return { result };
      })
    );
  }

  /**
   * 获取数据集的工具栏按钮（🆕 支持动态绑定）
   */
  private registerGetToolbarButtons(): void {
    ipcMain.handle(
      'js-plugin:get-toolbar-buttons',
      async (event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          // 🆕 首先查询当前数据集的创建者插件
          const datasetInfo = await this.duckdb.executeSQLWithParams(
            `
          SELECT created_by_plugin
          FROM datasets
          WHERE id = ?
        `,
            [datasetId]
          );

          const createdByPlugin = datasetInfo[0]?.created_by_plugin || null;

          // 查询所有工具栏按钮
          const rows = await this.duckdb.executeSQLWithParams(
            `
          SELECT
            id, plugin_id, contribution_id, label, icon, confirm_message,
            command_id, requires_selection, min_selection, max_selection,
            button_order, applies_to
          FROM js_plugin_toolbar_buttons
          ORDER BY button_order, created_at
        `,
            []
          );

          // 🆕 在应用层过滤（因为 DuckDB JSON 函数支持有限）
          const filteredButtons = rows.filter((row: any) => {
            const appliesTo = row.applies_to ? JSON.parse(row.applies_to) : { type: 'all' };

            // 应用到所有表
            if (appliesTo.type === 'all') {
              return true;
            }

            // 动态绑定：应用到插件创建的表
            if (appliesTo.type === 'plugin-tables') {
              return createdByPlugin === row.plugin_id;
            }

            // 绑定到特定表
            if (appliesTo.type === 'specific' && appliesTo.datasetIds) {
              return appliesTo.datasetIds.includes(datasetId);
            }

            return false;
          });

          // 转换为前端格式
          const toolbarButtons = filteredButtons.map((row: any) => ({
            id: row.id,
            pluginId: row.plugin_id,
            contributionId: row.contribution_id,
            label: row.label,
            icon: row.icon,
            confirmMessage: row.confirm_message,
            commandId: row.command_id,
            requiresSelection: row.requires_selection,
            minSelection: row.min_selection,
            maxSelection: row.max_selection,
            order: row.button_order,
          }));

          return { success: true, toolbarButtons };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 执行按钮字段命令（从数据表的 button 字段触发）
   * ✅ 使用 ButtonExecutor 支持参数绑定、返回值绑定、触发链
   */
  private registerExecuteActionColumn(): void {
    ipcMain.handle(
      'js-plugin:execute-action-column',
      async (
        event: IpcMainInvokeEvent,
        pluginId: string,
        commandId: string,
        rowid: number,
        datasetId: string
      ) => {
        try {
          // 确保插件已加载
          await this.ensurePluginLoaded(pluginId);

          console.log(`⚡ Executing button field command: ${pluginId}:${commandId}`);
          console.log(`📦 rowid: ${rowid}, datasetId: ${datasetId}`);

          // 获取行数据
          const queryResult = await this.duckdb.queryDataset(
            datasetId,
            `SELECT * FROM data WHERE _row_id = ${rowid}`
          );
          const rowData = queryResult.rows[0];

          if (!rowData) {
            return { success: false, error: `Row ${rowid} not found` };
          }

          // 获取按钮列的元数据
          const datasetInfo = await this.duckdb.getDatasetInfo(datasetId);
          const buttonColumn = datasetInfo?.schema?.find(
            (col) =>
              col.fieldType === 'button' &&
              col.metadata?.pluginId === pluginId &&
              col.metadata?.methodId === commandId
          );

          // 如果找到按钮列配置，使用 ButtonExecutor
          if (buttonColumn?.metadata) {
            const result = await this.buttonExecutor.execute({
              datasetId,
              rowId: rowid,
              rowData,
              buttonMetadata: buttonColumn.metadata,
            });

            return {
              success: result.success,
              result: result.result,
              error: result.error,
              updatedFields: result.updatedFields,
              triggeredNext: result.triggeredNext,
            };
          }

          // 降级：如果没有按钮配置，使用旧的方式（只传递 rowid 和 datasetId）
          const params = {
            rowid,
            datasetId,
            rowData, // 仍然传递行数据以便插件使用
          };

          const result = await this.pluginManager.executeCommand(pluginId, commandId, params);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 执行工具栏按钮命令
   * ✅ 不再传递 driver，由插件通过 helpers.profile.launch() 管理浏览器
   * ✅ 支持 parameterMapping，传递 datasetId
   */
  private registerExecuteToolbarButton(): void {
    ipcMain.handle(
      'js-plugin:execute-toolbar-button',
      async (
        event: IpcMainInvokeEvent,
        pluginId: string,
        commandId: string,
        selectedRows: any[],
        datasetId?: string, // ✅ 新增 datasetId 参数
        parameterMapping?: any // ✅ 新增 parameterMapping 参数
      ) => {
        try {
          // 🔧 检查插件是否已激活，如果没有则尝试加载
          await this.ensurePluginLoaded(pluginId);

          // ✅ 构建参数对象
          const params: any = {
            selectedRows,
            count: selectedRows.length,
          };

          // ✅ 添加 datasetId（如果提供）
          if (datasetId) {
            params.datasetId = datasetId;
          }

          // ✅ 处理 parameterMapping（如果提供）
          if (parameterMapping) {
            for (const [paramKey, mappingValue] of Object.entries(parameterMapping)) {
              if (mappingValue === '$datasetId' && datasetId) {
                params[paramKey] = datasetId;
              } else if (mappingValue === '$selectedRows') {
                params[paramKey] = selectedRows;
              } else if (mappingValue === '$count') {
                params[paramKey] = selectedRows.length;
              } else if (typeof mappingValue === 'string' && mappingValue.startsWith('$')) {
                // 其他 $ 变量可以在这里扩展
                console.warn(`Unknown parameter mapping variable: ${mappingValue}`);
              } else {
                // 直接值
                params[paramKey] = mappingValue;
              }
            }
          }

          console.log(`⚡ Executing toolbar button command: ${pluginId}:${commandId}`);
          console.log(`📦 Params:`, params);

          // ✅ 直接执行命令，不传递 driver
          const result = await this.pluginManager.executeCommand(pluginId, commandId, params);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 获取插件的自定义页面列表
   */
  private registerGetCustomPages(): void {
    ipcMain.handle(
      'js-plugin:get-custom-pages',
      async (event: IpcMainInvokeEvent, pluginId: string, datasetId?: string) => {
        try {
          const pages = await this.pluginManager.getCustomPages(pluginId, datasetId);
          return { success: true, pages };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 渲染自定义页面内容
   */
  private registerRenderCustomPage(): void {
    ipcMain.handle(
      'js-plugin:render-custom-page',
      async (event: IpcMainInvokeEvent, pluginId: string, pageId: string, datasetId?: string) => {
        try {
          const html = await this.pluginManager.renderCustomPage(pluginId, pageId, datasetId);
          return { success: true, html };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 处理页面消息
   */
  private registerHandlePageMessage(): void {
    ipcMain.handle(
      'js-plugin:page-message',
      this.withPluginLoaded(
        async (event, message: any) => {
          const result = await this.pluginManager.handlePageMessage(message);
          return { result };
        },
        // 自定义 pluginId 提取器：从 message 对象中获取
        (message: any) => message.pluginId
      )
    );
  }

  // ========== ✅ Activity Bar 视图和 API 调用 ==========

  /**
   * 调用插件暴露的 API
   */
  private registerCallPluginAPI(): void {
    ipcMain.handle(
      'js-plugin:call-api',
      this.withPluginLoaded(async (event, pluginId: string, apiName: string, args: any[]) => {
        // 调用插件 API
        const result = await this.pluginManager.callPluginAPI(pluginId, apiName, args);
        return { result };
      })
    );
  }

  /**
   * 显示插件视图
   */
  private registerShowPluginView(): void {
    ipcMain.handle(
      'js-plugin:show-view',
      async (
        event: IpcMainInvokeEvent,
        pluginId: string,
        bounds?: { x: number; y: number; width: number; height: number }
      ) => {
        try {
          const viewInfo = this.viewManager.getPluginViews(pluginId);

          if (!viewInfo.pageViewId) {
            throw new Error(`Plugin ${pluginId} does not have a page view`);
          }

          // 按插件恢复右栏布局（如果该插件有 docked-right 视图，切换时自动恢复）
          this.viewManager.applyPluginDockLayout(pluginId);

          // ✨ 优先使用插件 manifest 中的布局配置
          let viewBounds = bounds;

          if (!viewBounds) {
            // 尝试从插件 manifest 计算布局
            const calculatedBounds = this.viewManager.calculatePluginBounds(pluginId);

            if (calculatedBounds) {
              viewBounds = calculatedBounds;
              console.log(`✅ Using layout from manifest for plugin ${pluginId}:`, viewBounds);
            } else {
              // 降级到默认边界
              viewBounds = DEFAULT_VIEW_BOUNDS;
              console.log(`⚠️ Using default bounds for plugin ${pluginId}:`, viewBounds);
            }
          }

          // 显示插件页面视图（先激活视图，再附加到主窗口）
          await this.viewManager.activateView(viewInfo.pageViewId);
          await this.viewManager.loadPluginPageView(viewInfo.pageViewId, pluginId);
          this.viewManager.attachView(viewInfo.pageViewId, 'main', viewBounds);

          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 隐藏插件视图
   */
  private registerHidePluginView(): void {
    ipcMain.handle('js-plugin:hide-view', async (event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const viewInfo = this.viewManager.getPluginViews(pluginId);

        if (!viewInfo.pageViewId) {
          throw new Error(`Plugin ${pluginId} does not have a page view`);
        }

        // 隐藏插件页面视图（从窗口分离）
        this.viewManager.detachView(viewInfo.pageViewId);

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取插件视图信息
   */
  private registerGetPluginViewInfo(): void {
    ipcMain.handle(
      'js-plugin:get-view-info',
      async (event: IpcMainInvokeEvent, pluginId: string) => {
        try {
          const viewInfo = this.viewManager.getPluginViews(pluginId);

          // ✨ 读取插件 manifest 中的布局配置
          return {
            success: true,
            viewInfo: {
              hasPageView: !!viewInfo.pageViewId,
              pageViewId: viewInfo.pageViewId,
              tempViewCount: viewInfo.tempViewIds.length,
              tempViewIds: viewInfo.tempViewIds,
            },
          };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * ✨ 设置插件视图边界（动态调整位置和大小）
   */
  private registerSetPluginViewBounds(): void {
    ipcMain.handle(
      'js-plugin:set-view-bounds',
      async (
        event: IpcMainInvokeEvent,
        pluginId: string,
        bounds: { x?: number; y?: number; width?: number; height?: number }
      ) => {
        try {
          const viewInfo = this.viewManager.getPluginViews(pluginId);

          if (!viewInfo.pageViewId) {
            throw new Error(`Plugin ${pluginId} does not have a page view`);
          }

          const currentBounds = this.viewManager.getViewBounds(viewInfo.pageViewId);
          const baseBounds =
            currentBounds ??
            this.viewManager.calculatePluginBounds(pluginId) ??
            DEFAULT_VIEW_BOUNDS;

          // 构建完整的边界配置（使用提供的值或当前/计算值作为默认）
          const fullBounds = {
            x: bounds.x ?? baseBounds.x,
            y: bounds.y ?? baseBounds.y,
            width: bounds.width ?? baseBounds.width,
            height: bounds.height ?? baseBounds.height,
          };

          // 更新视图边界
          this.viewManager.updateBounds(viewInfo.pageViewId, fullBounds);

          console.log(`✅ Updated plugin view bounds for ${pluginId}:`, fullBounds);

          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * ✨ 获取布局信息（Activity Bar 宽度、可用空间等）
   */
  private registerGetLayoutInfo(): void {
    ipcMain.handle(
      'js-plugin:get-layout-info',
      async (_event: IpcMainInvokeEvent, _pluginId: string) => {
        try {
          const layoutInfo = this.viewManager.getPluginLayoutInfo();
          if (!layoutInfo) {
            throw new Error('Main window not found');
          }

          return {
            success: true,
            layoutInfo,
          };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
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
   * 高阶函数：自动确保插件已加载
   *
   * 包装 IPC 处理器，自动调用 ensurePluginLoaded()
   *
   * @param handler - IPC 处理器函数
   * @param pluginIdExtractor - 从参数中提取 pluginId 的函数（默认取第一个参数）
   * @returns 包装后的处理器
   *
   * @example
   * ipcMain.handle('js-plugin:execute-command',
   *   this.withPluginLoaded(async (event, pluginId, commandId, params) => {
   *     return await this.pluginManager.executeCommand(pluginId, commandId, params);
   *   })
   * );
   */
  private withPluginLoaded<T extends any[]>(
    handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<any>,
    pluginIdExtractor?: (...args: T) => string
  ) {
    return async (event: IpcMainInvokeEvent, ...args: T) => {
      try {
        // 提取 pluginId（默认取第一个参数）
        const pluginId = pluginIdExtractor ? pluginIdExtractor(...args) : (args[0] as string);

        // 确保插件已加载
        await this.ensurePluginLoaded(pluginId);

        // 执行实际的处理器
        const result = await handler(event, ...args);
        return { success: true, ...result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    };
  }

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
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to activate plugin ${pluginId}: ${errorMessage}. ` +
          `Please check the plugin code or try reinstalling it.`
      );
    }
  }

  /**
   * 🆕 启用插件热重载
   */
  private registerEnableHotReload(): void {
    ipcMain.handle(
      'js-plugin:enable-hot-reload',
      async (event: IpcMainInvokeEvent, pluginId: string) => {
        try {
          const result = await this.pluginManager.enableHotReload(pluginId);
          return { success: result.success, message: result.message };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 禁用插件热重载
   */
  private registerDisableHotReload(): void {
    ipcMain.handle(
      'js-plugin:disable-hot-reload',
      async (event: IpcMainInvokeEvent, pluginId: string) => {
        try {
          const result = await this.pluginManager.disableHotReload(pluginId);
          return { success: result.success, message: result.message };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 获取插件热重载状态
   */
  private registerGetHotReloadStatus(): void {
    ipcMain.handle(
      'js-plugin:get-hot-reload-status',
      async (event: IpcMainInvokeEvent, pluginId: string) => {
        try {
          const isEnabled = this.pluginManager.isHotReloadEnabled(pluginId);
          return { success: true, enabled: isEnabled };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 设置插件事件转发
   * 监听核心层的插件事件，转发到前端渲染进程
   */
  private setupPluginEventForwarding(): void {
    this.pluginManager.onRuntimeStatusChanged((payload: JSPluginRuntimeStatusChangeEvent) => {
      const mainWindow = windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('js-plugin:runtime-status-changed', payload);
      }
    });

    // 监听插件热重载事件
    pluginEventBus.on(PluginEvents.RELOADED, (payload: PluginReloadedPayload) => {
      this.cloudPluginBindingCache.delete(payload.pluginId);
      // v3 API: 使用 getMainWindowV3()
      const mainWindow = windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('js-plugin:reloaded', payload);
        console.log(`[IPC] Plugin reloaded event forwarded: ${payload.pluginId}`);
      }
    });

    pluginEventBus.on(PluginEvents.NOTIFICATION, (payload: PluginNotificationPayload) => {
      const mainWindow = windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('js-plugin:notification', payload);
      }
    });
  }
}
