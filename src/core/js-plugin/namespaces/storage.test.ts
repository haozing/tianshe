/**
 * storage.test.ts - 存储命名空间测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock validators
vi.mock('../validators', () => ({
  ParamValidator: {
    validateConfigKey: vi.fn(),
    validateString: vi.fn(),
    validateObject: vi.fn(),
    validateNumber: vi.fn(),
  },
}));

import { StorageNamespace } from './storage';
import type { DuckDBService } from '../../../main/duckdb/service';
import type { JSPluginManifest } from '../../../types/js-plugin';

describe('StorageNamespace', () => {
  let storage: StorageNamespace;
  let mockDuckDB: DuckDBService;
  let mockManifest: JSPluginManifest;

  beforeEach(() => {
    vi.clearAllMocks();

    // 创建 mock DuckDBService
    mockDuckDB = {
      executeSQLWithParams: vi.fn(),
      executeWithParams: vi.fn(),
    } as unknown as DuckDBService;

    // 创建 mock manifest
    mockManifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      main: 'index.js',
      configuration: {
        properties: {
          apiKey: {
            type: 'string',
            default: 'default-key',
          },
          maxRetries: {
            type: 'number',
            default: 3,
          },
        },
      },
    } as unknown as JSPluginManifest;

    storage = new StorageNamespace(mockDuckDB, 'test-plugin', mockManifest);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ========== 配置管理测试 ==========

  describe('getConfig', () => {
    it('应该返回已存储的配置', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([
        { value: JSON.stringify('stored-value') },
      ]);

      const result = await storage.getConfig('apiKey');

      expect(result).toBe('stored-value');
      expect(mockDuckDB.executeSQLWithParams).toHaveBeenCalled();
    });

    it('应该返回默认值当配置不存在', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([]);

      const result = await storage.getConfig('apiKey');

      expect(result).toBe('default-key');
    });

    it('应该返回 undefined 当配置和默认值都不存在', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([]);

      const result = await storage.getConfig('nonExistentKey');

      expect(result).toBeUndefined();
    });

    it('应该在数据库错误时抛出 DatabaseError', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockRejectedValue(new Error('DB Error'));

      await expect(storage.getConfig('apiKey')).rejects.toThrow('Failed to get configuration');
    });
  });

  describe('setConfig', () => {
    it('应该成功设置配置', async () => {
      (mockDuckDB.executeWithParams as any).mockResolvedValue(undefined);

      await storage.setConfig('apiKey', 'new-value');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalled();
      const callArgs = (mockDuckDB.executeWithParams as any).mock.calls[0];
      expect(callArgs[1]).toContain('test-plugin');
      expect(callArgs[1]).toContain('apiKey');
    });

    it('应该序列化复杂对象', async () => {
      (mockDuckDB.executeWithParams as any).mockResolvedValue(undefined);

      await storage.setConfig('settings', { theme: 'dark', lang: 'zh' });

      const callArgs = (mockDuckDB.executeWithParams as any).mock.calls[0];
      expect(callArgs[1]).toContain(JSON.stringify({ theme: 'dark', lang: 'zh' }));
    });

    it('应该在数据库错误时抛出 DatabaseError', async () => {
      (mockDuckDB.executeWithParams as any).mockRejectedValue(new Error('DB Error'));

      await expect(storage.setConfig('apiKey', 'value')).rejects.toThrow(
        'Failed to set configuration'
      );
    });
  });

  describe('getAllConfig', () => {
    it('应该返回所有配置（包含默认值）', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([
        { key: 'apiKey', value: JSON.stringify('stored-key') },
      ]);

      const result = await storage.getAllConfig();

      expect(result.apiKey).toBe('stored-key');
      expect(result.maxRetries).toBe(3); // 默认值
    });

    it('应该返回空对象当没有配置', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([]);

      // 清除默认值
      storage = new StorageNamespace(mockDuckDB, 'test-plugin', {
        ...mockManifest,
        configuration: undefined,
      } as any);

      const result = await storage.getAllConfig();

      expect(result).toEqual({});
    });
  });

  // ========== 数据存储测试 ==========

  describe('setData', () => {
    it('应该成功存储数据', async () => {
      (mockDuckDB.executeWithParams as any).mockResolvedValue(undefined);

      await storage.setData('lastSyncTime', Date.now());

      expect(mockDuckDB.executeWithParams).toHaveBeenCalled();
    });

    it('应该序列化复杂数据', async () => {
      (mockDuckDB.executeWithParams as any).mockResolvedValue(undefined);

      await storage.setData('userData', { name: 'test', items: [1, 2, 3] });

      expect(mockDuckDB.executeWithParams).toHaveBeenCalled();
    });
  });

  describe('getData', () => {
    it('应该返回已存储的数据', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([
        { value: JSON.stringify({ name: 'test' }) },
      ]);

      const result = await storage.getData('userData');

      expect(result).toEqual({ name: 'test' });
    });

    it('应该返回默认值当数据不存在', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([]);

      const result = await storage.getData('nonExistent', 'default');

      expect(result).toBe('default');
    });

    it('应该返回 null 当数据不存在且无默认值', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([]);

      const result = await storage.getData('nonExistent');

      expect(result).toBeNull();
    });
  });

  describe('deleteData', () => {
    it('应该成功删除数据', async () => {
      (mockDuckDB.executeWithParams as any).mockResolvedValue(undefined);

      await storage.deleteData('testKey');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalled();
      const sql = (mockDuckDB.executeWithParams as any).mock.calls[0][0];
      expect(sql).toContain('DELETE');
    });
  });

  describe('getAllData', () => {
    it('应该返回所有数据', async () => {
      (mockDuckDB.executeSQLWithParams as any).mockResolvedValue([
        { key: 'key1', value: JSON.stringify('value1') },
        { key: 'key2', value: JSON.stringify({ nested: true }) },
      ]);

      const result = await storage.getAllData();

      expect(result.key1).toBe('value1');
      expect(result.key2).toEqual({ nested: true });
    });
  });

  describe('clearAllData', () => {
    it('应该清空所有数据', async () => {
      (mockDuckDB.executeWithParams as any).mockResolvedValue(undefined);

      await storage.clearAllData();

      expect(mockDuckDB.executeWithParams).toHaveBeenCalled();
      const sql = (mockDuckDB.executeWithParams as any).mock.calls[0][0];
      expect(sql).toContain('DELETE');
    });
  });
});
