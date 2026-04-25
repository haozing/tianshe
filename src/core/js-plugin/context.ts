/**
 * 插件上下文 API
 *
 * 提供给插件的 API 访问能力
 *
 * 职责分层设计：
 * - PluginContext: 插件实例的生命周期管理、核心 API（命令、API暴露、消息传递）
 * - PluginHelpers: 通过命名空间提供各类功能（database, network, storage, ui, etc.）
 *
 * 便捷方法说明：
 * context.getConfiguration/setConfiguration - 委托给 helpers.storage.getConfig/setConfig
 * context.setData/getData/deleteData - 委托给 helpers.storage.*
 *
 * 这些便捷方法保留的原因：
 * 1. 提供更简洁的 API 表面，适合常见用例
 * 2. 与旧版 API 保持兼容
 * 3. 语义更清晰（"获取配置" vs "访问存储命名空间然后获取配置"）
 *
 * 对于高级用例，建议直接使用 helpers.storage.* 获得更完整的功能
 */

import type {
  JSPluginManifest,
  CommandHandler,
  ExposedAPIMap,
  APIFunction,
} from '../../types/js-plugin';
import type { PluginHelpers } from './helpers';
import type { DuckDBService } from '../../main/duckdb/service';
import type { EnhancedColumnSchema } from '../../main/duckdb/types';
import { BytecodeRunner, BytecodeConfig } from './bytecode-runner';
import {
  getPluginRegistry,
  type PluginMessage,
  type PluginAPIInfo,
  type PluginCommandInfo,
  type CallResult,
} from './registry';
import { createLogger } from '../logger';

const logger = createLogger('PluginContext');

/**
 * 数据表信息
 */
export interface DataTableInfo {
  /** 数据表ID (格式: plugin:插件id:code) */
  id: string;
  /** 数据表名称 */
  name: string;
  /** 数据表代码（唯一标识） */
  code: string;
  /** 列定义 */
  columns?: EnhancedColumnSchema[];
}

/**
 * 插件信息
 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  manifest: JSPluginManifest;
}

/**
 * 跨插件调用的插件信息
 */
export interface CrossPluginInfo {
  /** 插件 ID */
  id: string;
  /** 插件名称 */
  name: string;
  /** 插件版本 */
  version: string;
  /** 已暴露的 API 数量 */
  apiCount: number;
  /** 已注册的命令数量 */
  commandCount: number;
  /** 是否允许 MCP 调用 */
  mcpCallable: boolean;
}

/**
 * 消息处理函数类型
 */
export type MessageHandler = (message: PluginMessage) => void;

/**
 * 自定义模块加载器
 */
export type ModuleLoader = (modulePath: string, context: PluginContext) => Promise<any> | any;

/**
 * 插件上下文
 * 在插件的 activate() 钩子中传递给插件
 */
export class PluginContext {
  private commands = new Map<string, CommandHandler>();
  private exposedAPIs = new Map<string, APIFunction>();
  private disposables: Array<() => void> = [];
  private customModuleLoaders = new Map<string, ModuleLoader>();

  /** 消息订阅清理函数列表 */
  private messageUnsubscribers: Array<() => void> = [];

  /** ✅ 插件基本信息 */
  public readonly plugin: PluginInfo;

  /** ✅ 插件创建的数据表列表 */
  public readonly dataTables: DataTableInfo[];

  /** 字节码运行器 */
  private bytecodeRunner: BytecodeRunner;

  constructor(
    public readonly manifest: JSPluginManifest,
    private readonly helpers: PluginHelpers,
    private readonly duckdb: DuckDBService,
    private readonly pluginId: string,
    dataTables: DataTableInfo[] = [] // ✅ 新增参数
  ) {
    // ✅ 初始化插件信息
    this.plugin = {
      id: pluginId,
      name: manifest.name,
      version: manifest.version,
      manifest,
    };

    // ✅ 初始化数据表列表
    this.dataTables = dataTables;

    // 初始化字节码运行器
    this.bytecodeRunner = new BytecodeRunner();
  }

  /**
   * 注册命令
   *
   * @param commandId - 命令ID（对应 manifest.json 中的 command）
   * @param handler - 命令处理函数
   *
   * @example
   * context.registerCommand('publish', async (params, driver, helpers) => {
   *   await publishProduct(params);
   * });
   */
  registerCommand(commandId: string, handler: CommandHandler): void {
    if (this.commands.has(commandId)) {
      throw new Error(
        `❌ Command registration failed: Command "${commandId}" is already registered in plugin "${this.pluginId}".\n` +
          `Tip: Each command ID must be unique within a plugin. Please use a different command ID.`
      );
    }

    this.commands.set(commandId, handler);
    logger.debug('Command registered: ' + this.pluginId + ':' + commandId);

    // 添加到 disposables，在插件卸载时自动清理
    this.disposables.push(() => {
      this.commands.delete(commandId);
    });
  }

  /**
   * 获取已注册的命令
   */
  getCommand(commandId: string): CommandHandler | undefined {
    return this.commands.get(commandId);
  }

  /**
   * 获取所有已注册的命令
   */
  getCommands(): Map<string, CommandHandler> {
    return this.commands;
  }

  /**
   * ✅ 根据 code 获取数据表
   *
   * @param code - 数据表代码（在 manifest.json 中定义）
   * @returns 数据表信息，如果不存在则返回 null
   *
   * @example
   * const table = context.getDataTable('doudian_products');
   * if (table) {
   *   console.log('数据表ID:', table.id);
   * }
   */
  getDataTable(code: string): DataTableInfo | null {
    const table = this.dataTables.find((t) => t.code === code);
    return table || null;
  }

  /**
   * ✅ 暴露自定义 API 给插件页面
   *
   * @param apis - API 函数映射对象
   *
   * @example
   * context.exposeAPI({
   *   async getUserInfo(userId: string) {
   *     return await fetchUserFromDB(userId);
   *   },
   *   async saveProduct(productData: any) {
   *     return await saveToDatabase(productData);
   *   }
   * });
   *
   * // 在插件页面中调用：
   * const userInfo = await window.pluginAPI.my_plugin.getUserInfo('user123');
   */
  exposeAPI(apis: ExposedAPIMap): void {
    for (const [name, func] of Object.entries(apis)) {
      if (typeof func !== 'function') {
        throw new Error(
          `❌ API exposure failed: API "${name}" must be a function, but got ${typeof func}.\n` +
            `Plugin: ${this.pluginId}\n` +
            `Tip: Make sure you pass a function, not the result of calling it.`
        );
      }

      if (this.exposedAPIs.has(name)) {
        throw new Error(
          `❌ API exposure failed: API "${name}" is already exposed in plugin "${this.pluginId}".\n` +
            `Tip: Each API name must be unique within a plugin. Please use a different API name.`
        );
      }

      this.exposedAPIs.set(name, func);
      logger.debug('[' + this.plugin.name + '] API exposed: ' + name);
    }

    // 添加汇总日志
    logger.debug('[' + this.plugin.name + '] Total APIs exposed: ' + this.exposedAPIs.size);

    // 添加到 disposables，在插件卸载时自动清理
    this.disposables.push(() => {
      for (const name of Object.keys(apis)) {
        this.exposedAPIs.delete(name);
      }
    });
  }

  /**
   * ✅ 获取暴露的 API 函数
   *
   * @param name - API 名称
   * @returns API 函数，如果不存在则返回 undefined
   */
  getExposedAPI(name: string): APIFunction | undefined {
    return this.exposedAPIs.get(name);
  }

  /**
   * ✅ 获取所有暴露的 API
   *
   * @returns 所有 API 的映射
   */
  getAllExposedAPIs(): Map<string, APIFunction> {
    return this.exposedAPIs;
  }

  /**
   * ✅ 调用暴露的 API（内部使用）
   *
   * @param name - API 名称
   * @param args - 参数数组
   * @returns API 执行结果
   *
   * @internal
   */
  async callExposedAPI(name: string, args: any[]): Promise<any> {
    const apiFunc = this.exposedAPIs.get(name);

    if (!apiFunc) {
      const availableAPIs = Array.from(this.exposedAPIs.keys());
      throw new Error(
        `❌ API call failed: API "${name}" is not exposed by plugin "${this.pluginId}".\n` +
          `Available APIs: ${availableAPIs.length > 0 ? availableAPIs.join(', ') : '(none)'}\n` +
          `Tip: Make sure the plugin has called context.exposeAPI() to register this API.`
      );
    }

    try {
      return await apiFunc(...args);
    } catch (error) {
      logger.error('Error calling API "' + this.pluginId + ':' + name + '"', error);
      throw error;
    }
  }

  /**
   * 获取插件配置
   *
   * @param key - 配置键（对应 manifest.json 的 configuration.properties）
   * @returns 配置值
   *
   * @example
   * const apiKey = await context.getConfiguration('apiKey');
   */
  async getConfiguration(key: string): Promise<any> {
    // 委托给 StorageNamespace 统一处理
    return this.helpers.storage.getConfig(key);
  }

  /**
   * 设置插件配置
   *
   * @param key - 配置键
   * @param value - 配置值
   *
   * @example
   * await context.setConfiguration('apiKey', 'your-api-key');
   */
  async setConfiguration(key: string, value: any): Promise<void> {
    // 委托给 StorageNamespace 统一处理
    return this.helpers.storage.setConfig(key, value);
  }

  /**
   * 存储插件数据（持久化）
   *
   * @param key - 数据键
   * @param value - 数据值（会自动 JSON 序列化）
   *
   * @example
   * await context.setData('lastSyncTime', Date.now());
   */
  async setData(key: string, value: any): Promise<void> {
    // 委托给 StorageNamespace 统一处理
    return this.helpers.storage.setData(key, value);
  }

  /**
   * 获取插件数据
   *
   * @param key - 数据键
   * @returns 数据值
   *
   * @example
   * const lastSync = await context.getData('lastSyncTime');
   */
  async getData(key: string): Promise<any> {
    // 委托给 StorageNamespace 统一处理
    return this.helpers.storage.getData(key);
  }

  /**
   * 删除插件数据
   *
   * @param key - 数据键
   *
   * @example
   * await context.deleteData('lastSyncTime');
   */
  async deleteData(key: string): Promise<void> {
    // 委托给 StorageNamespace 统一处理
    return this.helpers.storage.deleteData(key);
  }

  /**
   * 运行字节码模块
   *
   * 执行V8字节码(.jsc文件)
   *
   * @param config - 字节码配置
   * @returns 模块导出对象
   *
   * @example
   * // 从文件运行字节码
   * const module = await context.runBytecode({
   *   source: '/path/to/compiled.jsc'
   * });
   *
   * @example
   * // 从远程下载字节码并运行
   * const bytecodeBuffer = await helpers.network.get({
   *   url: 'https://my-server.com/protected.jsc',
   *   responseType: 'arraybuffer'
   * });
   * const module = await context.runBytecode({
   *   source: Buffer.from(bytecodeBuffer),
   *   filename: 'protected.jsc',
   *   isTemporary: true
   * });
   */
  async runBytecode(config: BytecodeConfig): Promise<any> {
    return await this.bytecodeRunner.runBytecode(config);
  }

  /**
   * 注册自定义模块加载器
   *
   * 允许插件自定义模块加载逻辑（例如从特定协议加载）
   *
   * @param protocol - 协议前缀（如 'encrypted:', 'plugin:'）
   * @param loader - 模块加载函数
   *
   * @example
   * // 注册加密模块加载器
   * context.registerModuleLoader('encrypted:', async (modulePath, context) => {
   *   const encryptedCode = await helpers.storage.getData(modulePath);
   *   const key = await helpers.storage.getConfig('moduleKey');
   *   const decrypted = await decryptFromBackend(encryptedCode, key);
   *
   *   const module = { exports: {} };
   *   const func = new Function('module', 'exports', 'helpers', decrypted);
   *   func(module, module.exports, context.helpers);
   *   return module.exports;
   * });
   *
   * // 使用自定义加载器
   * const module = await context.loadModule('encrypted:my-feature');
   *
   * @example
   * // 注册数据库模块加载器
   * context.registerModuleLoader('db:', async (modulePath) => {
   *   const code = await helpers.storage.getData(modulePath);
   *   return eval(code);
   * });
   */
  registerModuleLoader(protocol: string, loader: ModuleLoader): void {
    if (this.customModuleLoaders.has(protocol)) {
      throw new Error(
        `Module loader for protocol "${protocol}" is already registered in plugin "${this.pluginId}"`
      );
    }

    this.customModuleLoaders.set(protocol, loader);
    logger.debug('Module loader registered: ' + protocol);

    // 添加到 disposables
    this.disposables.push(() => {
      this.customModuleLoaders.delete(protocol);
    });
  }

  /**
   * 加载模块（支持自定义协议）
   *
   * 根据模块路径的协议前缀使用相应的加载器
   *
   * ⚠️ 安全警告：标准 require 加载没有沙箱隔离，模块将获得完整 Node.js 权限。
   * 建议使用自定义协议加载器实现必要的安全检查。
   *
   * @param modulePath - 模块路径（可包含协议前缀）
   * @returns 模块导出对象
   *
   * @example
   * // 使用自定义协议加载（推荐）
   * const module = await context.loadModule('encrypted:premium-feature');
   * const module2 = await context.loadModule('db:stored-module');
   *
   * @example
   * // 使用标准require加载（无隔离，需谨慎）
   * const module = await context.loadModule('./local-module.js');
   */
  async loadModule(modulePath: string): Promise<any> {
    // 检查是否有自定义协议
    for (const [protocol, loader] of this.customModuleLoaders.entries()) {
      if (modulePath.startsWith(protocol)) {
        const actualPath = modulePath.substring(protocol.length);
        return await loader(actualPath, this);
      }
    }

    // 使用标准require（无沙箱隔离）
    logger.debug(`Loading module without isolation: ${modulePath}`, { pluginId: this.pluginId });
    return require(modulePath);
  }

  // ==================== 跨插件调用 API ====================

  /**
   * 调用其他插件暴露的 API
   *
   * 需要目标插件在 manifest.crossPlugin 中声明：
   * - exposedAPIs: 暴露的 API 列表
   * - allowedCallers: 允许调用的插件列表
   *
   * 本插件需要在 manifest.crossPlugin.canCall 中声明可调用的插件列表
   *
   * @param pluginId - 目标插件 ID
   * @param apiName - API 名称
   * @param params - 参数（单个值或数组）
   * @returns API 调用结果
   *
   * @example
   * // 调用 plugin-a 的 getProducts API
   * const result = await context.callPlugin('plugin-a', 'getProducts', { status: 'active' });
   * if (result.success) {
   *   console.log('Products:', result.data);
   * } else {
   *   console.error('Error:', result.error?.message);
   * }
   */
  async callPlugin<T = unknown>(
    pluginId: string,
    apiName: string,
    params?: unknown
  ): Promise<CallResult<T>> {
    const registry = getPluginRegistry();
    const paramsArray = params !== undefined ? [params] : [];
    return registry.callPluginAPI(this.pluginId, pluginId, apiName, paramsArray) as Promise<
      CallResult<T>
    >;
  }

  /**
   * 执行其他插件注册的命令
   *
   * @param pluginId - 目标插件 ID
   * @param commandId - 命令 ID
   * @param params - 命令参数
   * @returns 命令执行结果
   *
   * @example
   * const result = await context.executePluginCommand('plugin-a', 'sync-data', { force: true });
   */
  async executePluginCommand<T = unknown>(
    pluginId: string,
    commandId: string,
    params?: unknown
  ): Promise<CallResult<T>> {
    const registry = getPluginRegistry();
    return registry.executePluginCommand(this.pluginId, pluginId, commandId, params) as Promise<
      CallResult<T>
    >;
  }

  /**
   * 订阅其他插件的消息
   *
   * @param pluginId - 要监听的插件 ID，'*' 表示监听所有插件
   * @param handler - 消息处理函数
   * @returns 取消订阅函数
   *
   * @example
   * // 监听特定插件的消息
   * const unsubscribe = context.onPluginMessage('plugin-a', (message) => {
   *   if (message.type === 'order:created') {
   *     console.log('New order:', message.data);
   *   }
   * });
   *
   * // 监听所有插件的消息
   * context.onPluginMessage('*', (message) => {
   *   console.log(`Message from ${message.source}:`, message.type);
   * });
   */
  onPluginMessage(pluginId: string | '*', handler: MessageHandler): () => void {
    const registry = getPluginRegistry();
    const unsubscribe = registry.subscribeMessage(this.pluginId, pluginId, handler);

    // 保存取消订阅函数，以便在 dispose 时清理
    this.messageUnsubscribers.push(unsubscribe);

    return unsubscribe;
  }

  /**
   * 发送消息给其他插件
   *
   * @param targetPluginId - 目标插件 ID，'*' 表示广播给所有插件
   * @param type - 消息类型
   * @param data - 消息数据
   *
   * @example
   * // 发送给特定插件
   * context.sendPluginMessage('plugin-b', 'order:created', { orderId: 123 });
   *
   * // 广播给所有插件
   * context.sendPluginMessage('*', 'system:update', { version: '2.0.0' });
   */
  sendPluginMessage(targetPluginId: string | '*', type: string, data?: unknown): void {
    const registry = getPluginRegistry();
    registry.sendMessage(this.pluginId, targetPluginId, { type, data });
  }

  /**
   * 获取其他插件的信息
   *
   * @param pluginId - 目标插件 ID
   * @returns 插件信息，如果不存在则返回 undefined
   *
   * @example
   * const info = context.getPluginInfo('plugin-a');
   * if (info) {
   *   console.log(`Plugin: ${info.name} v${info.version}`);
   *   console.log(`APIs: ${info.apiCount}, Commands: ${info.commandCount}`);
   * }
   */
  getPluginInfo(pluginId: string): CrossPluginInfo | undefined {
    const registry = getPluginRegistry();
    const plugins = registry.listPlugins();
    return plugins.find((p) => p.id === pluginId);
  }

  /**
   * 列出所有已注册的插件
   *
   * @returns 插件信息列表
   *
   * @example
   * const plugins = context.listPlugins();
   * for (const plugin of plugins) {
   *   console.log(`${plugin.name}: ${plugin.apiCount} APIs, ${plugin.commandCount} commands`);
   * }
   */
  listPlugins(): CrossPluginInfo[] {
    const registry = getPluginRegistry();
    return registry.listPlugins();
  }

  /**
   * 列出可调用的 API
   *
   * 返回本插件有权限调用的所有 API
   *
   * @returns 可调用的 API 列表
   */
  listCallableAPIs(): PluginAPIInfo[] {
    const registry = getPluginRegistry();
    return registry.listCallableAPIs(this.pluginId);
  }

  /**
   * 列出可执行的命令
   *
   * 返回本插件有权限执行的所有命令
   *
   * @returns 可执行的命令列表
   */
  listCallableCommands(): PluginCommandInfo[] {
    const registry = getPluginRegistry();
    return registry.listCallableCommands(this.pluginId);
  }

  /**
   * 清理所有资源（在插件卸载时调用）
   * @internal
   */
  dispose(): void {
    // 清理消息订阅
    for (const unsubscribe of this.messageUnsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        logger.error('Error unsubscribing message listener', error);
      }
    }
    this.messageUnsubscribers = [];

    // 清理其他 disposables
    for (const disposable of this.disposables) {
      try {
        disposable();
      } catch (error) {
        logger.error('Error disposing resource', error);
      }
    }
    this.disposables = [];
    this.commands.clear();
    this.exposedAPIs.clear();
    this.customModuleLoaders.clear();

    // 清理字节码临时文件
    this.bytecodeRunner.cleanupAll().catch((err) => {
      logger.error('Error cleaning up bytecode runner', err);
    });
  }
}
