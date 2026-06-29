/**
 * Plugin Namespace - 插件自省API
 * 提供插件获取自身信息的能力
 */

import type { PluginContext, DataTableInfo, PluginInfo } from '../context';
import path from 'path';
import { app } from 'electron';

/**
 * 插件命名空间
 * 提供插件自身信息查询和访问能力
 */
export class PluginNamespace {
  constructor(
    private pluginId: string,
    private context: PluginContext
  ) {}

  /**
   * 获取插件基本信息
   *
   * @returns 插件信息对象
   *
   * @example
   * const info = helpers.plugin.getInfo();
   * console.log('插件ID:', info.id);
   * console.log('插件名称:', info.name);
   * console.log('插件版本:', info.version);
   */
  getInfo(): PluginInfo {
    return this.context.plugin;
  }

  /**
   * 获取插件创建的所有数据表
   *
   * @returns 数据表信息数组
   *
   * @example
   * const tables = helpers.plugin.getDataTables();
   * console.log('插件创建了', tables.length, '个数据表');
   * tables.forEach(table => {
   *   console.log(`- ${table.name} (${table.code})`);
   * });
   */
  getDataTables(): DataTableInfo[] {
    return this.context.dataTables;
  }

  /**
   * 根据 code 获取数据表信息
   *
   * @param code - 数据表代码（在 manifest.json 中定义）
   * @returns 数据表信息，如果不存在则返回 null
   *
   * @example
   * const table = helpers.plugin.getDataTable('doudian_products');
   * if (table) {
   *   console.log('数据表ID:', table.id);
   *   console.log('数据表名称:', table.name);
   *   console.log('列定义:', table.columns);
   * }
   */
  getDataTable(code: string): DataTableInfo | null {
    return this.context.getDataTable(code);
  }

  /**
   * 根据 code 获取数据表ID
   * 这是一个便捷方法，等价于 getDataTable(code)?.id
   *
   * @param code - 数据表代码
   * @returns 数据表ID，如果不存在则返回 null
   *
   * @example
   * const datasetId = helpers.plugin.getDataTableId('doudian_products');
   * if (datasetId) {
   *   await helpers.database.updateRow(datasetId, rowId, { status: '已完成' });
   * }
   */
  getDataTableId(code: string): string | null {
    const table = this.getDataTable(code);
    return table ? table.id : null;
  }

  /**
   * 获取插件的存储目录路径
   * 用于存储插件的配置文件、缓存文件等
   *
   * @returns 插件存储目录的绝对路径
   *
   * @example
   * const storagePath = helpers.plugin.getStoragePath();
   * const configPath = path.join(storagePath, 'config.json');
   */
  getStoragePath(): string {
    const userDataPath = app.getPath('userData');
    const pluginStoragePath = path.join(userDataPath, 'plugins', this.pluginId);
    return pluginStoragePath;
  }

  /**
   * 获取插件的临时目录路径
   * 用于存储临时文件，应用退出时可能被清理
   *
   * @returns 插件临时目录的绝对路径
   *
   * @example
   * const tempPath = helpers.plugin.getTempPath();
   * const tempFile = path.join(tempPath, 'temp-download.jpg');
   */
  getTempPath(): string {
    const tempPath = app.getPath('temp');
    const pluginTempPath = path.join(tempPath, 'airpa-plugins', this.pluginId);
    return pluginTempPath;
  }

  /**
   * 获取插件配置
   * 读取 manifest.json 中 configuration.properties 定义的配置项
   *
   * @param key - 配置键
   * @returns 配置值的 Promise
   *
   * @example
   * const apiKey = await helpers.plugin.getConfig('apiKey');
   * const waitTime = await helpers.plugin.getConfig('wait_time');
   */
  async getConfig(key: string): Promise<any> {
    return this.context.getConfiguration(key);
  }

  /**
   * 设置插件配置
   *
   * @param key - 配置键
   * @param value - 配置值
   *
   * @example
   * await helpers.plugin.setConfig('apiKey', 'your-new-api-key');
   */
  async setConfig(key: string, value: any): Promise<void> {
    return this.context.setConfiguration(key, value);
  }

  /**
   * 获取插件ID
   *
   * @returns 插件ID字符串
   *
   * @example
   * const pluginId = helpers.plugin.getId();
   * console.log('当前插件ID:', pluginId);
   */
  getId(): string {
    return this.pluginId;
  }

  /**
   * 获取插件版本
   *
   * @returns 插件版本字符串
   *
   * @example
   * const version = helpers.plugin.getVersion();
   * console.log('插件版本:', version);
   */
  getVersion(): string {
    return this.context.plugin.version;
  }

  /**
   * 获取插件名称
   *
   * @returns 插件名称字符串
   *
   * @example
   * const name = helpers.plugin.getName();
   * console.log('插件名称:', name);
   */
  getName(): string {
    return this.context.plugin.name;
  }

  /**
   * 获取完整的 manifest 配置
   *
   * @returns Manifest 对象
   *
   * @example
   * const manifest = helpers.plugin.getManifest();
   * console.log('插件描述:', manifest.description);
   * console.log('插件作者:', manifest.author);
   */
  getManifest(): any {
    return this.context.plugin.manifest;
  }
}
