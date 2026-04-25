/**
 * 插件 UI 扩展管理器
 *
 * 负责管理插件的 UI 扩展，包括：
 * - 工具栏按钮
 * - 命令注册
 * - 自定义页面
 * - 视图创建
 * - 页面通信
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import type { DuckDBService } from '../../main/duckdb/service';
import type { WebContentsViewManager } from '../../main/webcontentsview-manager';
import type { JSPluginManifest } from '../../types/js-plugin';
import type { PluginContext } from './context';
import type { PluginHelpers } from './helpers';
import { createLogger } from '../logger';

const logger = createLogger('UIExtensionManager');

/**
 * UI 扩展管理器配置
 */
export interface UIExtensionManagerConfig {
  duckdb: DuckDBService;
  viewManager: WebContentsViewManager;
}

/**
 * appliesTo 配置
 */
export interface AppliesToConfig {
  type: 'all' | 'plugin-tables' | 'specific';
  datasetIds?: string[];
  datasetNames?: string[];
}

/**
 * UI 扩展管理器
 */
export class UIExtensionManager {
  private duckdb: DuckDBService;
  private viewManager: WebContentsViewManager;

  constructor(config: UIExtensionManagerConfig) {
    this.duckdb = config.duckdb;
    this.viewManager = config.viewManager;
  }

  // ========== UI 扩展注册和清理 ==========

  /**
   * 注册插件的 UI 扩展到数据库
   *
   * 统一使用 saveUIContributions 的完整逻辑，确保所有字段一致写入
   * 包括 applies_to, customPages 等元数据
   */
  async registerUIContributions(
    pluginId: string,
    manifest: JSPluginManifest,
    tableNameToDatasetId?: Map<string, string> | null
  ): Promise<void> {
    // 复用 saveUIContributions 的完整逻辑，确保字段一致
    await this.saveUIContributions(manifest, tableNameToDatasetId ?? null);
  }

  /**
   * 清理数据库中的 UI 扩展
   */
  async unregisterUIContributions(pluginId: string): Promise<void> {
    try {
      await this.duckdb.executeWithParams(
        `DELETE FROM js_plugin_toolbar_buttons WHERE plugin_id = ?`,
        [pluginId]
      );
      await this.duckdb.executeWithParams(`DELETE FROM js_plugin_commands WHERE plugin_id = ?`, [
        pluginId,
      ]);
      await this.duckdb.executeWithParams(
        `DELETE FROM js_plugin_custom_pages WHERE plugin_id = ?`,
        [pluginId]
      );
    } catch (error: any) {
      logger.warn(`[WARN] Failed to clean UI contributions for ${pluginId}:`, error.message);
    }
  }

  // ========== UI 扩展保存 ==========

  /**
   * 保存 UI 扩展（工具栏按钮、操作列等）
   */
  async saveUIContributions(
    manifest: JSPluginManifest,
    tableNameToDatasetId: Map<string, string> | null
  ): Promise<void> {
    const contributes = manifest.contributes;
    if (!contributes) return;

    logger.info(`[DB] Saving UI contributions for plugin: ${manifest.id}`);

    // 保存命令
    if (contributes.commands) {
      for (const command of contributes.commands) {
        await this.saveCommandMetadata(manifest.id, command);
      }
    }

    // 保存工具栏按钮
    if (contributes.toolbarButtons) {
      for (const button of contributes.toolbarButtons) {
        await this.saveToolbarButtonMetadata(manifest.id, button, tableNameToDatasetId);
      }
    }

    // 保存自定义页面
    if (contributes.customPages) {
      for (const customPage of contributes.customPages) {
        await this.saveCustomPageMetadata(manifest.id, customPage, tableNameToDatasetId);
      }
    }

    logger.info(`  ✓ UI contributions saved`);
  }

  /**
   * 保存命令元数据（UPSERT）
   */
  private async saveCommandMetadata(pluginId: string, command: any): Promise<void> {
    const commandId = `${pluginId}:${command.id}`;

    const sql = `
      INSERT INTO js_plugin_commands (
        id, plugin_id, command_id, title, category, description, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        description = EXCLUDED.description
    `;

    await this.duckdb.executeWithParams(sql, [
      commandId,
      pluginId,
      command.id,
      command.title,
      command.category || null,
      command.description || null,
      Date.now(),
    ]);

    logger.info(`  ✓ Saved command: ${command.id}`);
  }

  /**
   * 保存工具栏按钮元数据（UPSERT）
   *
   * 当 tableNameToDatasetId 为 null 时，不更新 applies_to 字段，保留已有值
   */
  private async saveToolbarButtonMetadata(
    pluginId: string,
    button: any,
    tableNameToDatasetId: Map<string, string> | null
  ): Promise<void> {
    const buttonId = `${pluginId}:${button.id}`;

    // 处理 appliesTo（仅在有映射时解析）
    const appliesTo = this.resolveAppliesTo(button.appliesTo, tableNameToDatasetId, button.id);
    const hasMapping = tableNameToDatasetId !== null;

    // 保存到数据库（UPSERT）
    // 当没有映射时，不更新 applies_to，保留导入时的值
    const sql = hasMapping
      ? `
      INSERT INTO js_plugin_toolbar_buttons (
        id, plugin_id, contribution_id, label, icon, confirm_message,
        command_id, requires_selection, min_selection, max_selection,
        button_order, applies_to, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label,
        icon = EXCLUDED.icon,
        confirm_message = EXCLUDED.confirm_message,
        command_id = EXCLUDED.command_id,
        requires_selection = EXCLUDED.requires_selection,
        min_selection = EXCLUDED.min_selection,
        max_selection = EXCLUDED.max_selection,
        button_order = EXCLUDED.button_order,
        applies_to = EXCLUDED.applies_to
    `
      : `
      INSERT INTO js_plugin_toolbar_buttons (
        id, plugin_id, contribution_id, label, icon, confirm_message,
        command_id, requires_selection, min_selection, max_selection,
        button_order, applies_to, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label,
        icon = EXCLUDED.icon,
        confirm_message = EXCLUDED.confirm_message,
        command_id = EXCLUDED.command_id,
        requires_selection = EXCLUDED.requires_selection,
        min_selection = EXCLUDED.min_selection,
        max_selection = EXCLUDED.max_selection,
        button_order = EXCLUDED.button_order
    `;

    await this.duckdb.executeWithParams(sql, [
      buttonId,
      pluginId,
      button.id,
      button.label,
      button.icon,
      button.confirmMessage || null,
      button.command,
      button.requiresSelection || false,
      button.minSelection || 0,
      button.maxSelection || null,
      button.order || 0,
      JSON.stringify(appliesTo),
      Date.now(),
    ]);

    logger.info(`  ✓ Saved toolbar button: ${button.id} (applies to: ${appliesTo.type})`);
  }

  /**
   * 保存自定义页面元数据（UPSERT）
   *
   * 当 tableNameToDatasetId 为 null 时，不更新 applies_to 字段，保留已有值
   */
  private async saveCustomPageMetadata(
    pluginId: string,
    customPage: any,
    tableNameToDatasetId: Map<string, string> | null
  ): Promise<void> {
    const pageId = `${pluginId}:${customPage.id}`;

    // 处理 appliesTo
    const appliesTo = this.resolveAppliesTo(
      customPage.appliesTo,
      tableNameToDatasetId,
      customPage.id
    );
    const hasMapping = tableNameToDatasetId !== null;

    // 序列化配置对象
    const popupConfig = customPage.popupConfig ? JSON.stringify(customPage.popupConfig) : null;
    const securityConfig = customPage.security ? JSON.stringify(customPage.security) : null;
    const communicationConfig = customPage.communication
      ? JSON.stringify(customPage.communication)
      : null;

    // 当没有映射时，不更新 applies_to，保留导入时的值
    const sql = hasMapping
      ? `
      INSERT INTO js_plugin_custom_pages (
        id, plugin_id, page_id, title, icon, description,
        display_mode, source_type, source_path, source_url,
        applies_to, popup_config, security_config, communication_config,
        order_index, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        icon = EXCLUDED.icon,
        description = EXCLUDED.description,
        display_mode = EXCLUDED.display_mode,
        source_type = EXCLUDED.source_type,
        source_path = EXCLUDED.source_path,
        source_url = EXCLUDED.source_url,
        applies_to = EXCLUDED.applies_to,
        popup_config = EXCLUDED.popup_config,
        security_config = EXCLUDED.security_config,
        communication_config = EXCLUDED.communication_config,
        order_index = EXCLUDED.order_index
    `
      : `
      INSERT INTO js_plugin_custom_pages (
        id, plugin_id, page_id, title, icon, description,
        display_mode, source_type, source_path, source_url,
        applies_to, popup_config, security_config, communication_config,
        order_index, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        icon = EXCLUDED.icon,
        description = EXCLUDED.description,
        display_mode = EXCLUDED.display_mode,
        source_type = EXCLUDED.source_type,
        source_path = EXCLUDED.source_path,
        source_url = EXCLUDED.source_url,
        popup_config = EXCLUDED.popup_config,
        security_config = EXCLUDED.security_config,
        communication_config = EXCLUDED.communication_config,
        order_index = EXCLUDED.order_index
    `;

    await this.duckdb.executeWithParams(sql, [
      pageId,
      pluginId,
      customPage.id,
      customPage.title,
      customPage.icon || null,
      customPage.description || null,
      customPage.displayMode,
      customPage.source.type,
      customPage.source.path || null,
      customPage.source.url || null,
      JSON.stringify(appliesTo),
      popupConfig,
      securityConfig,
      communicationConfig,
      customPage.order || 0,
      Date.now(),
    ]);

    logger.info(
      `  ✓ Saved custom page: ${customPage.id} (mode: ${customPage.displayMode}, applies to: ${appliesTo.type})`
    );
  }

  /**
   * 解析 appliesTo 配置
   */
  private resolveAppliesTo(
    appliesTo: any,
    tableNameToDatasetId: Map<string, string> | null,
    itemId: string
  ): AppliesToConfig {
    if (!appliesTo) {
      return { type: 'all' };
    }

    if (appliesTo.type === 'plugin-tables') {
      return { type: 'plugin-tables' };
    }

    if (appliesTo.type === 'specific' && appliesTo.datasetNames) {
      if (!tableNameToDatasetId) {
        logger.warn(`  [WARN] Item "${itemId}" specifies datasetNames but plugin has no tables`);
        return { type: 'specific', datasetIds: [] };
      }

      const datasetIds = appliesTo.datasetNames
        .map((name: string) => tableNameToDatasetId.get(name))
        .filter((id: string | undefined) => id !== undefined) as string[];

      if (datasetIds.length === 0) {
        logger.warn(
          `  [WARN] Item "${itemId}" datasetNames not found: ${appliesTo.datasetNames.join(', ')}`
        );
      }

      return { type: 'specific', datasetIds };
    }

    return appliesTo;
  }

  // ========== 视图创建 ==========

  /**
   * 创建插件视图（仅 Activity Bar 页面视图）
   */
  async createPluginViews(pluginId: string, viewConfig: any): Promise<void> {
    // 注册插件页面视图（✨ 性能优化：延迟创建，首次打开时才真正加载页面）
    const pageViewId = this.viewManager.registerPluginPageView(pluginId, viewConfig);
    logger.info(`  ✓ Registered plugin page view (lazy): ${pageViewId}`);
  }

  // ========== 自定义页面 ==========

  /**
   * 获取插件的自定义页面列表
   */
  async getCustomPages(pluginId: string, datasetId?: string): Promise<any[]> {
    const sql = `
      SELECT * FROM js_plugin_custom_pages
      WHERE plugin_id = ?
      ORDER BY order_index ASC
    `;

    const pages = await this.duckdb.executeSQLWithParams(sql, [pluginId]);

    // 如果指定了datasetId，过滤appliesTo
    if (datasetId) {
      const datasetInfo = await this.duckdb.executeSQLWithParams(
        `SELECT created_by_plugin FROM datasets WHERE id = ?`,
        [datasetId]
      );

      const createdByPlugin = datasetInfo[0]?.created_by_plugin || null;

      return pages.filter((page: any) => {
        const appliesTo = JSON.parse(page.applies_to || '{}');
        return this.matchesAppliesTo(appliesTo, datasetId, createdByPlugin, pluginId);
      });
    }

    return pages;
  }

  /**
   * 渲染自定义页面内容
   */
  async renderCustomPage(
    pluginId: string,
    pageId: string,
    pluginPath: string,
    datasetId?: string
  ): Promise<string> {
    const sql = `
      SELECT * FROM js_plugin_custom_pages
      WHERE plugin_id = ? AND page_id = ?
    `;

    const rows = await this.duckdb.executeSQLWithParams(sql, [pluginId, pageId]);
    if (rows.length === 0) {
      throw new Error(`Custom page not found: ${pageId}`);
    }

    const page = rows[0];

    if (page.source_type === 'local') {
      const htmlPath = path.join(pluginPath, page.source_path);

      if (!(await fs.pathExists(htmlPath))) {
        throw new Error(`HTML file not found: ${page.source_path}`);
      }

      let html = await fs.readFile(htmlPath, 'utf-8');
      html = this.injectCommunicationScript(html, pluginId, pageId, page, datasetId);
      return html;
    } else {
      return this.createRemoteIframe(page);
    }
  }

  /**
   * 处理页面消息
   */
  async handlePageMessage(
    message: any,
    contexts: Map<string, PluginContext>,
    helpers: Map<string, PluginHelpers>,
    executeCommand: (pluginId: string, commandId: string, params: any) => Promise<any>
  ): Promise<any> {
    const { pluginId, pageId, command, params } = message;

    // 验证页面存在
    const sql = `
      SELECT * FROM js_plugin_custom_pages
      WHERE plugin_id = ? AND page_id = ?
    `;

    const rows = await this.duckdb.executeSQLWithParams(sql, [pluginId, pageId]);
    if (rows.length === 0) {
      throw new Error('Page not found');
    }

    const page = rows[0];
    const communicationConfig = page.communication_config
      ? JSON.parse(page.communication_config)
      : { exposeApi: false, allowedCommands: [] };

    // 获取 API 列表不需要权限验证
    if (command === 'getExposedAPIs') {
      const context = contexts.get(pluginId);
      if (!context) {
        throw new Error(`Plugin context not found: ${pluginId}`);
      }
      return Array.from((context as any).exposedAPIs.keys());
    }

    // 调用插件暴露的 API
    if (command === 'callAPI') {
      if (!communicationConfig.exposeApi) {
        throw new Error('API access not enabled for this page');
      }

      const { apiName, args = [] } = params;
      const context = contexts.get(pluginId);
      if (!context) {
        throw new Error('Plugin context not found');
      }

      const apiFunc = (context as any).exposedAPIs.get(apiName);
      if (!apiFunc) {
        throw new Error(`API method not found: ${apiName}`);
      }

      return await apiFunc(...args);
    }

    // 验证权限
    if (!communicationConfig.exposeApi) {
      throw new Error('API access not enabled for this page');
    }

    const allowedCommands = communicationConfig.allowedCommands || [];
    if (!allowedCommands.includes(command)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    // 执行命令
    switch (command) {
      case 'executeCommand':
        return await executeCommand(pluginId, params.commandId, params.params);

      case 'getData': {
        const pluginHelpers = helpers.get(pluginId);
        if (!pluginHelpers) {
          throw new Error('Plugin helpers not found');
        }
        return await pluginHelpers.database.query(params.datasetId, params.query);
      }

      case 'updateData': {
        const pluginHelpers = helpers.get(pluginId);
        if (!pluginHelpers) {
          throw new Error('Plugin helpers not found');
        }
        return await pluginHelpers.database.update(params.datasetId, params.updates, params.where);
      }

      case 'getConfig': {
        const context = contexts.get(pluginId);
        if (!context) {
          throw new Error('Plugin context not found');
        }
        return await context.getConfiguration(params.key);
      }

      case 'setConfig': {
        const context = contexts.get(pluginId);
        if (!context) {
          throw new Error('Plugin context not found');
        }
        return await context.setConfiguration(params.key, params.value);
      }

      case 'notify': {
        const pluginHelpers = helpers.get(pluginId);
        if (!pluginHelpers) {
          throw new Error('Plugin helpers not found');
        }
        return pluginHelpers.ui.notify(params.message, params.type);
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  // ========== 私有辅助方法 ==========

  /**
   * 检查页面是否匹配appliesTo条件
   */
  private matchesAppliesTo(
    appliesTo: AppliesToConfig,
    datasetId: string,
    createdByPlugin: string | null,
    pluginId: string
  ): boolean {
    if (appliesTo.type === 'all') {
      return true;
    }

    if (appliesTo.type === 'plugin-tables') {
      return createdByPlugin === pluginId;
    }

    if (appliesTo.type === 'specific' && appliesTo.datasetIds) {
      return appliesTo.datasetIds.includes(datasetId);
    }

    return false;
  }

  /**
   * 注入通信脚本到HTML页面
   */
  private injectCommunicationScript(
    html: string,
    pluginId: string,
    pageId: string,
    page: any,
    datasetId?: string
  ): string {
    const script = `
      <script>
        (function() {
          'use strict';

          // ===== 消息通信基础设施 =====
          const pendingMessages = new Map();
          let messageIdCounter = 0;

          // 发送消息到主进程
          function sendMessage(command, params) {
            return new Promise((resolve, reject) => {
              const messageId = ++messageIdCounter;

              // 注册回调
              pendingMessages.set(messageId, { resolve, reject });

              // 发送消息
              window.parent.postMessage({
                type: 'plugin-page-message',
                pluginId: '${pluginId}',
                pageId: '${pageId}',
                messageId,
                command,
                params
              }, '*');

              // 超时处理（30秒）
              setTimeout(() => {
                if (pendingMessages.has(messageId)) {
                  pendingMessages.delete(messageId);
                  reject(new Error(\`Request timeout: \${command}\`));
                }
              }, 30000);
            });
          }

          // 监听来自主进程的响应
          window.addEventListener('message', function(event) {
            const { messageId, error, result } = event.data;

            if (!pendingMessages.has(messageId)) {
              return;
            }

            const { resolve, reject } = pendingMessages.get(messageId);
            pendingMessages.delete(messageId);

            if (error) {
              reject(new Error(error));
            } else {
              resolve(result);
            }
          });

          // ===== 插件 API 对象 =====
          window.pluginAPI = {
            // 当前数据集 ID
            datasetId: ${datasetId ? `'${datasetId}'` : 'null'},

            // ===== 通用方法 =====
            executeCommand: (commandId, params) => {
              return sendMessage('executeCommand', { commandId, params });
            },

            getData: (datasetId, query) => {
              return sendMessage('getData', { datasetId, query });
            },

            updateData: (datasetId, updates, where) => {
              return sendMessage('updateData', { datasetId, updates, where });
            },

            getConfig: (key) => {
              return sendMessage('getConfig', { key });
            },

            setConfig: (key, value) => {
              return sendMessage('setConfig', { key, value });
            },

            notify: (message, type) => {
              return sendMessage('notify', { message, type });
            }
          };

          // ===== 页面加载完成后初始化插件 API =====
          window.addEventListener('DOMContentLoaded', async () => {
            logger.info('🚀 [Plugin Page] Initializing plugin API for: ${pluginId}');

            try {
              // 1. 获取插件暴露的 API 列表
              const apiList = await sendMessage('getExposedAPIs', {});
              logger.info('[Plugin Page] Available APIs:', apiList);

              // 2. 为插件创建命名空间
              window.pluginAPI['${pluginId}'] = {};

              // 3. 动态创建 API 方法包装器
              for (const apiName of apiList) {
                window.pluginAPI['${pluginId}'][apiName] = function(...args) {
                  return sendMessage('callAPI', { apiName, args });
                };
              }

              logger.info('[OK] [Plugin Page] Plugin API initialized successfully');
              logger.info('[Plugin Page] API namespace:', window.pluginAPI['${pluginId}']);

              // 4. 通知父窗口页面已准备就绪
              window.parent.postMessage({
                type: 'plugin-page-ready',
                pluginId: '${pluginId}',
                pageId: '${pageId}'
              }, '*');

            } catch (error) {
              console.error('[ERROR] [Plugin Page] Failed to initialize plugin API:', error);

              // 显示错误提示
              document.body.insertAdjacentHTML('afterbegin', \`
                <div style="position: fixed; top: 0; left: 0; right: 0; background: #f44336; color: white; padding: 12px; text-align: center; z-index: 9999;">
                  <strong>插件 API 初始化失败</strong>: \${error.message}
                </div>
              \`);
            }
          });
        })();
      </script>
    `;

    // 在</head>之前插入，如果没有</head>则在<body>之前插入
    if (html.includes('</head>')) {
      return html.replace('</head>', `${script}\n</head>`);
    } else if (html.includes('<body>')) {
      return html.replace('<body>', `${script}\n<body>`);
    } else {
      return script + '\n' + html;
    }
  }

  /**
   * 创建远程iframe包装
   */
  private createRemoteIframe(page: any): string {
    const securityConfig = page.security_config ? JSON.parse(page.security_config) : {};

    const sandbox = securityConfig.sandbox || 'allow-scripts';
    const csp =
      securityConfig.csp || "default-src 'self'; script-src 'unsafe-inline' 'unsafe-eval';";

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <style>
          body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
          iframe { width: 100%; height: 100%; border: none; }
        </style>
      </head>
      <body>
        <iframe src="${page.source_url}" sandbox="${sandbox}"></iframe>
      </body>
      </html>
    `;
  }
}
