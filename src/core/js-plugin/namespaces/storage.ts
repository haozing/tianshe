/**
 * Storage Namespace
 *
 * 提供插件数据存储的命名空间接口
 * 包括配置管理、持久化数据存储等
 */

import type { DuckDBService } from '../../../main/duckdb/service';
import type { JSPluginManifest } from '../../../types/js-plugin';
import { DatabaseError } from '../errors';
import { ParamValidator } from '../validators';

/**
 * 存储命名空间
 *
 * 提供插件配置和数据的持久化存储
 *
 * @example
 * // 获取配置
 * const apiKey = await helpers.storage.getConfig('apiKey');
 *
 * @example
 * // 保存数据
 * await helpers.storage.setData('lastSyncTime', Date.now());
 */
export class StorageNamespace {
  constructor(
    private duckdb: DuckDBService,
    private pluginId: string,
    private manifest: JSPluginManifest
  ) {}

  // ========== 配置管理 ==========

  /**
   * 获取插件配置
   *
   * @param key - 配置键（对应 manifest.json 的 configuration.properties）
   * @returns 配置值（如果不存在则返回默认值）
   *
   * @example
   * const apiKey = await helpers.storage.getConfig('apiKey');
   */
  async getConfig(key: string): Promise<any> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateConfigKey(key);

    try {
      const sql = `
        SELECT value FROM plugin_configurations
        WHERE plugin_id = ? AND key = ?
      `;
      const result = await this.duckdb.executeSQLWithParams(sql, [this.pluginId, key]);

      if (result.length === 0) {
        // 返回默认值
        return this.manifest.configuration?.properties[key]?.default;
      }

      return JSON.parse(result[0].value);
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to get configuration "${key}" for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          key,
          operation: 'getConfig',
        },
        error
      );
    }
  }

  /**
   * 设置插件配置
   *
   * @param key - 配置键
   * @param value - 配置值（会自动 JSON 序列化）
   *
   * @example
   * await helpers.storage.setConfig('apiKey', 'your-api-key');
   */
  async setConfig(key: string, value: any): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateConfigKey(key);

    try {
      const sql = `
        INSERT INTO plugin_configurations (plugin_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (plugin_id, key)
        DO UPDATE SET value = ?, updated_at = ?
      `;
      await this.duckdb.executeWithParams(sql, [
        this.pluginId,
        key,
        JSON.stringify(value),
        Date.now(),
        JSON.stringify(value),
        Date.now(),
      ]);
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to set configuration "${key}" for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          key,
          value,
          operation: 'setConfig',
        },
        error
      );
    }
  }

  /**
   * 获取所有配置
   *
   * @returns 配置对象（键值对）
   *
   * @example
   * const allConfig = await helpers.storage.getAllConfig();
   * console.log('API Key:', allConfig.apiKey);
   */
  async getAllConfig(): Promise<Record<string, any>> {
    try {
      const sql = `
        SELECT key, value FROM plugin_configurations
        WHERE plugin_id = ?
      `;
      const result = await this.duckdb.executeSQLWithParams(sql, [this.pluginId]);

      const config: Record<string, any> = {};
      for (const row of result) {
        config[row.key] = JSON.parse(row.value);
      }

      // 补充默认值
      const properties = this.manifest.configuration?.properties || {};
      for (const [key, prop] of Object.entries(properties)) {
        if (!(key in config) && 'default' in prop) {
          config[key] = prop.default;
        }
      }

      return config;
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to get all configurations for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          operation: 'getAllConfig',
        },
        error
      );
    }
  }

  // ========== 数据存储 ==========

  /**
   * 存储插件数据（持久化）
   *
   * @param key - 数据键
   * @param value - 数据值（会自动 JSON 序列化）
   *
   * @example
   * await helpers.storage.setData('lastSyncTime', Date.now());
   * await helpers.storage.setData('userPreferences', { theme: 'dark' });
   */
  async setData(key: string, value: any): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateString(key, 'key');

    try {
      const sql = `
        INSERT INTO plugin_data (plugin_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (plugin_id, key)
        DO UPDATE SET value = ?, updated_at = ?
      `;
      await this.duckdb.executeWithParams(sql, [
        this.pluginId,
        key,
        JSON.stringify(value),
        Date.now(),
        JSON.stringify(value),
        Date.now(),
      ]);
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to set data "${key}" for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          key,
          value,
          operation: 'setData',
        },
        error
      );
    }
  }

  /**
   * 获取插件数据
   *
   * @param key - 数据键
   * @param defaultValue - 默认值（当数据不存在时返回）
   * @returns 数据值
   *
   * @example
   * const lastSync = await helpers.storage.getData('lastSyncTime');
   * const theme = await helpers.storage.getData('theme', 'light');
   */
  async getData(key: string, defaultValue: any = null): Promise<any> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateString(key, 'key');

    try {
      const sql = `
        SELECT value FROM plugin_data
        WHERE plugin_id = ? AND key = ?
      `;
      const result = await this.duckdb.executeSQLWithParams(sql, [this.pluginId, key]);

      if (result.length === 0) {
        return defaultValue;
      }

      return JSON.parse(result[0].value);
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to get data "${key}" for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          key,
          operation: 'getData',
        },
        error
      );
    }
  }

  /**
   * 删除插件数据
   *
   * @param key - 数据键
   *
   * @example
   * await helpers.storage.deleteData('lastSyncTime');
   */
  async deleteData(key: string): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateString(key, 'key');

    try {
      const sql = `DELETE FROM plugin_data WHERE plugin_id = ? AND key = ?`;
      await this.duckdb.executeWithParams(sql, [this.pluginId, key]);
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to delete data "${key}" for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          key,
          operation: 'deleteData',
        },
        error
      );
    }
  }

  /**
   * 获取所有插件数据
   *
   * @returns 数据对象（键值对）
   *
   * @example
   * const allData = await helpers.storage.getAllData();
   * console.log('Last sync:', allData.lastSyncTime);
   */
  async getAllData(): Promise<Record<string, any>> {
    try {
      const sql = `
        SELECT key, value FROM plugin_data
        WHERE plugin_id = ?
      `;
      const result = await this.duckdb.executeSQLWithParams(sql, [this.pluginId]);

      const data: Record<string, any> = {};
      for (const row of result) {
        data[row.key] = JSON.parse(row.value);
      }

      return data;
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to get all data for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          operation: 'getAllData',
        },
        error
      );
    }
  }

  /**
   * 清空所有插件数据（不包括配置）
   *
   * @example
   * await helpers.storage.clearAllData();
   */
  async clearAllData(): Promise<void> {
    try {
      const sql = `DELETE FROM plugin_data WHERE plugin_id = ?`;
      await this.duckdb.executeWithParams(sql, [this.pluginId]);
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to clear all data for plugin "${this.pluginId}"`,
        {
          pluginId: this.pluginId,
          operation: 'clearAllData',
        },
        error
      );
    }
  }
}
