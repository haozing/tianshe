/**
 * PluginInstaller 单元测试
 *
 * 测试重点：
 * - 数据表创建逻辑
 * - 表名到 datasetId 的映射
 * - Schema 比较
 * - 表删除和孤立化
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PluginInstaller, PluginTableCleanupError } from './plugin-installer';
import type { JSPluginManifest, DataTableDefinition } from '../../types/js-plugin';

// Mock logger
vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fs-extra
vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn().mockResolvedValue(false),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  pathExists: vi.fn().mockResolvedValue(false),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}));

// Mock duckdb utils
vi.mock('../../main/duckdb/utils', () => ({
  getImportsDir: vi.fn().mockReturnValue('/mock/imports'),
  getFileSize: vi.fn().mockResolvedValue(1024),
}));

// Mock DuckDBService
const createMockDuckDBService = () => ({
  execute: vi.fn().mockResolvedValue(undefined),
  executeWithParams: vi.fn().mockResolvedValue(undefined),
  executeSQLWithParams: vi.fn().mockResolvedValue([]),
  query: vi.fn().mockResolvedValue([]),
  deleteDataset: vi.fn().mockResolvedValue(undefined),
  getFolderService: vi.fn().mockReturnValue({
    createFolder: vi.fn().mockResolvedValue('folder-id'),
  }),
});

// 测试用的 manifest
const createTestManifest = (overrides: Partial<JSPluginManifest> = {}): JSPluginManifest => ({
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  author: 'Test Author',
  main: 'index.js',
  ...overrides,
});

// 测试用的表定义
const createTestTableDefinition = (
  overrides: Partial<DataTableDefinition> = {}
): DataTableDefinition => ({
  name: 'Test Table',
  code: 'test_table',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'name', type: 'VARCHAR' },
    { name: 'created', type: 'TIMESTAMP' },
  ],
  ...overrides,
});

describe('PluginInstaller', () => {
  let installer: PluginInstaller;
  let mockDuckDB: ReturnType<typeof createMockDuckDBService>;

  beforeEach(() => {
    mockDuckDB = createMockDuckDBService();
    installer = new PluginInstaller(mockDuckDB as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ========== createTables ==========
  describe('createTables', () => {
    it('没有 dataTables 时应该返回空 Map', async () => {
      const manifest = createTestManifest({ dataTables: undefined });

      const result = await installer.createTables(manifest, 'folder-1');

      expect(result.size).toBe(0);
    });

    it('dataTables 为空数组时应该返回空 Map', async () => {
      const manifest = createTestManifest({ dataTables: [] });

      const result = await installer.createTables(manifest, 'folder-1');

      expect(result.size).toBe(0);
    });

    it('应该创建表并返回正确的映射', async () => {
      const manifest = createTestManifest({
        dataTables: [createTestTableDefinition()],
      });

      // Mock 无冲突的表
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      const result = await installer.createTables(manifest, 'folder-1');

      expect(result.size).toBe(1);
      expect(result.get('Test Table')).toBe('plugin__test-plugin__test_table');
    });

    it('应该在完成后执行 CHECKPOINT', async () => {
      const manifest = createTestManifest({
        dataTables: [createTestTableDefinition()],
      });

      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await installer.createTables(manifest, 'folder-1');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith('CHECKPOINT', []);
    });

    it('多表创建中途失败时应该回滚之前已创建的表', async () => {
      const manifest = createTestManifest({
        dataTables: [
          createTestTableDefinition({ name: 'First', code: 'first_table' }),
          createTestTableDefinition({ name: 'Bad', code: 'bad-table' }),
        ],
      });
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await expect(installer.createTables(manifest, 'folder-1')).rejects.toThrow(
        'Invalid table code'
      );

      expect(mockDuckDB.deleteDataset).toHaveBeenCalledWith('plugin__test-plugin__first_table');
    });

    it('多表创建中途失败时应该撤销已恢复的孤儿表关联', async () => {
      const manifest = createTestManifest({
        dataTables: [
          createTestTableDefinition({
            name: 'Orphan',
            code: 'orphan_table',
            columns: [{ name: 'name', type: 'VARCHAR' }],
          }),
          createTestTableDefinition({ name: 'Bad', code: 'bad-table' }),
        ],
      });
      const fsModule = await import('fs-extra');
      vi.mocked(fsModule.default.pathExists).mockResolvedValue(true);
      vi.mocked(fsModule.pathExists).mockResolvedValue(true);
      mockDuckDB.executeSQLWithParams.mockResolvedValueOnce([
        {
          id: 'plugin__test-plugin__orphan_table',
          name: 'Orphan',
          file_path: '/mock/path.db',
          created_by_plugin: null,
          folder_id: 'old-folder',
          schema: JSON.stringify([{ name: 'name', duckdbType: 'VARCHAR' }]),
        },
      ]);

      await expect(installer.createTables(manifest, 'folder-1')).rejects.toThrow(
        'Invalid table code'
      );

      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE datasets SET created_by_plugin = NULL'),
        ['old-folder', 'plugin__test-plugin__orphan_table']
      );
    });
  });

  // ========== createSingleTable ==========
  describe('createSingleTable', () => {
    it('没有 code 字段时应该报错', async () => {
      const tableDef = createTestTableDefinition({ code: '' });

      await expect(
        installer.createSingleTable('test-plugin', tableDef as any, 'folder-1')
      ).rejects.toThrow('code');
    });

    it('code 包含非法字符时应该报错', async () => {
      const tableDef = createTestTableDefinition({ code: 'test-table!' });

      await expect(
        installer.createSingleTable('test-plugin', tableDef, 'folder-1')
      ).rejects.toThrow('Invalid table code');
    });

    it('code 包含中划线时应该报错', async () => {
      const tableDef = createTestTableDefinition({ code: 'test-table' });

      await expect(
        installer.createSingleTable('test-plugin', tableDef, 'folder-1')
      ).rejects.toThrow('Invalid table code');
    });

    it('有效的 code 应该通过验证', async () => {
      const tableDef = createTestTableDefinition({ code: 'test_table_123' });
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      const result = await installer.createSingleTable('test-plugin', tableDef, 'folder-1');

      expect(result.datasetId).toBe('plugin__test-plugin__test_table_123');
    });

    it('表 ID 冲突时应该报错（属于其他插件）', async () => {
      const tableDef = createTestTableDefinition();
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        {
          id: 'plugin__test-plugin__test_table',
          name: 'Existing Table',
          created_by_plugin: 'other-plugin',
        },
      ]);

      await expect(
        installer.createSingleTable('test-plugin', tableDef, 'folder-1')
      ).rejects.toThrow('数据表ID冲突');
    });

    it('应该生成正确的 datasetId 格式', async () => {
      const tableDef = createTestTableDefinition({ code: 'my_table' });
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      const result = await installer.createSingleTable('my-plugin', tableDef, 'folder-1');

      expect(result.datasetId).toBe('plugin__my-plugin__my_table');
    });

    it('metadata 保存失败时应该清理刚创建的物理数据库文件', async () => {
      const tableDef = createTestTableDefinition({ code: 'cleanup_table' });
      const fsModule = await import('fs-extra');
      vi.mocked(fsModule.default.pathExists).mockImplementation(async (targetPath: string) =>
        String(targetPath).includes('cleanup_table.db')
      );
      vi.mocked(fsModule.pathExists).mockImplementation(async (targetPath: string) =>
        String(targetPath).includes('cleanup_table.db')
      );
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);
      mockDuckDB.executeWithParams.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO datasets')) {
          throw new Error('metadata failed');
        }
      });

      await expect(
        installer.createSingleTable('test-plugin', tableDef, 'folder-1')
      ).rejects.toThrow('metadata failed');

      expect(fsModule.remove).toHaveBeenCalledWith(
        expect.stringContaining('plugin__test-plugin__cleanup_table.db')
      );
    });
  });

  // ========== deletePluginTables ==========
  describe('deletePluginTables', () => {
    it('没有表时应该正常完成', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await expect(installer.deletePluginTables('test-plugin')).resolves.not.toThrow();
    });

    it('应该删除所有插件的表', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1' },
        { id: 'table-2', name: 'Table 2' },
      ]);

      await installer.deletePluginTables('test-plugin');

      expect(mockDuckDB.deleteDataset).toHaveBeenCalledTimes(2);
      expect(mockDuckDB.deleteDataset).toHaveBeenCalledWith('table-1');
      expect(mockDuckDB.deleteDataset).toHaveBeenCalledWith('table-2');
    });

    it('应该删除插件文件夹', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await installer.deletePluginTables('test-plugin');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM dataset_folders'),
        ['test-plugin']
      );
    });

    it('应该在删除插件表流程中清理插件状态 namespace', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await installer.deletePluginTables('test-plugin');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_data'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_configurations'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_secure_data'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_relational_state'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_state_migrations'),
        ['test-plugin']
      );
    });

    it('单表删除失败时应该抛出结构化错误并保留插件文件夹 metadata', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1' },
        { id: 'table-2', name: 'Table 2' },
      ]);
      mockDuckDB.deleteDataset.mockImplementation(async (datasetId: string) => {
        if (datasetId === 'table-1') {
          throw new Error('locked');
        }
      });

      await expect(installer.deletePluginTables('test-plugin')).rejects.toMatchObject({
        name: 'PluginTableCleanupError',
        pluginId: 'test-plugin',
        operation: 'delete',
        failures: [
          expect.objectContaining({
            datasetId: 'table-1',
            stage: 'delete_table',
            error: 'locked',
          }),
        ],
      } satisfies Partial<PluginTableCleanupError>);

      expect(mockDuckDB.deleteDataset).toHaveBeenCalledWith('table-2');
      expect(mockDuckDB.executeWithParams).not.toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM dataset_folders'),
        ['test-plugin']
      );
    });

    it('插件文件夹删除失败时应该抛出结构化错误', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);
      mockDuckDB.executeWithParams.mockRejectedValueOnce(new Error('folder db failed'));

      await expect(installer.deletePluginTables('test-plugin')).rejects.toMatchObject({
        name: 'PluginTableCleanupError',
        pluginId: 'test-plugin',
        operation: 'delete',
        failures: [
          expect.objectContaining({
            stage: 'delete_folder',
            error: 'folder db failed',
          }),
        ],
      } satisfies Partial<PluginTableCleanupError>);
    });

    it('插件状态清理失败时应该抛出结构化错误', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);
      mockDuckDB.executeWithParams
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('state cleanup failed'));

      await expect(installer.deletePluginTables('test-plugin')).rejects.toMatchObject({
        name: 'PluginTableCleanupError',
        pluginId: 'test-plugin',
        operation: 'delete',
        failures: [
          expect.objectContaining({
            stage: 'delete_state',
            error: 'state cleanup failed',
          }),
        ],
      } satisfies Partial<PluginTableCleanupError>);
    });
  });

  // ========== orphanPluginTables ==========
  describe('orphanPluginTables', () => {
    it('没有表时应该正常完成', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await expect(installer.orphanPluginTables('test-plugin')).resolves.not.toThrow();
    });

    it('应该将表的 created_by_plugin 设为 NULL', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1', folder_id: 'folder-1' },
      ]);

      await installer.orphanPluginTables('test-plugin');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE datasets SET created_by_plugin = NULL'),
        ['test-plugin']
      );
    });

    it('应该将插件文件夹转为普通文件夹', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1', folder_id: 'folder-1' },
      ]);

      await installer.orphanPluginTables('test-plugin');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE dataset_folders SET plugin_id = NULL'),
        ['test-plugin']
      );
    });

    it('应该在孤立插件表流程中清理插件状态 namespace', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1', folder_id: 'folder-1' },
      ]);

      await installer.orphanPluginTables('test-plugin');

      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_data'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_configurations'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_secure_data'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_relational_state'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM plugin_state_migrations'),
        ['test-plugin']
      );
    });

    it('表解绑失败时应该抛出结构化错误', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1', folder_id: 'folder-1' },
      ]);
      mockDuckDB.executeWithParams.mockRejectedValueOnce(new Error('unlink failed'));

      await expect(installer.orphanPluginTables('test-plugin')).rejects.toMatchObject({
        name: 'PluginTableCleanupError',
        pluginId: 'test-plugin',
        operation: 'orphan',
        failures: [
          expect.objectContaining({
            stage: 'orphan_tables',
            error: 'unlink failed',
          }),
        ],
      } satisfies Partial<PluginTableCleanupError>);
    });

    it('插件文件夹转换失败时应该抛出结构化错误', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1', folder_id: 'folder-1' },
      ]);
      mockDuckDB.executeWithParams
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('folder update failed'));

      await expect(installer.orphanPluginTables('test-plugin')).rejects.toMatchObject({
        name: 'PluginTableCleanupError',
        pluginId: 'test-plugin',
        operation: 'orphan',
        failures: [
          expect.objectContaining({
            stage: 'orphan_folder',
            error: 'folder update failed',
          }),
        ],
      } satisfies Partial<PluginTableCleanupError>);
    });

    it('插件状态清理失败时应该抛出结构化错误', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([
        { id: 'table-1', name: 'Table 1', folder_id: 'folder-1' },
      ]);
      mockDuckDB.executeWithParams
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('state cleanup failed'));

      await expect(installer.orphanPluginTables('test-plugin')).rejects.toMatchObject({
        name: 'PluginTableCleanupError',
        pluginId: 'test-plugin',
        operation: 'orphan',
        failures: [
          expect.objectContaining({
            stage: 'orphan_state',
            error: 'state cleanup failed',
          }),
        ],
      } satisfies Partial<PluginTableCleanupError>);
    });
  });

  // ========== 表已存在场景 ==========
  describe('表已存在场景', () => {
    it('表属于当前插件且文件存在时应该复用', async () => {
      const tableDef = createTestTableDefinition();

      // 动态 import 并设置 mock
      const fsModule = await import('fs-extra');
      vi.mocked(fsModule.default.pathExists).mockImplementation(async () => true);
      vi.mocked(fsModule.pathExists).mockImplementation(async () => true);

      mockDuckDB.executeSQLWithParams.mockResolvedValueOnce([
        {
          id: 'plugin__test-plugin__test_table',
          name: 'Existing Table',
          file_path: '/mock/path.db',
          created_by_plugin: 'test-plugin', // 同一插件
          schema: '[]',
        },
      ]);

      const result = await installer.createSingleTable('test-plugin', tableDef, 'folder-1');

      expect(result.datasetId).toBe('plugin__test-plugin__test_table');
      expect(result.tableName).toBe('Existing Table');
    });

    it('表属于当前插件但文件缺失时应该报错', async () => {
      const tableDef = createTestTableDefinition();

      const fsModule = await import('fs-extra');
      vi.mocked(fsModule.default.pathExists).mockImplementation(async () => false);
      vi.mocked(fsModule.pathExists).mockImplementation(async () => false);

      mockDuckDB.executeSQLWithParams.mockResolvedValueOnce([
        {
          id: 'plugin__test-plugin__test_table',
          name: 'Existing Table',
          file_path: '/mock/path.db',
          created_by_plugin: 'test-plugin',
          schema: '[]',
        },
      ]);

      await expect(
        installer.createSingleTable('test-plugin', tableDef, 'folder-1')
      ).rejects.toThrow('文件缺失');
    });
  });

  // ========== 系统列 ==========
  describe('系统列生成', () => {
    it('应该自动添加系统列到 schema', async () => {
      const tableDef = createTestTableDefinition({
        columns: [{ name: 'user_col', type: 'VARCHAR' }],
      });

      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await installer.createSingleTable('test-plugin', tableDef, 'folder-1');

      // 检查 INSERT 调用中的 schema 参数
      const insertCall = mockDuckDB.executeWithParams.mock.calls.find((call: any) =>
        call[0].includes('INSERT INTO datasets')
      );

      expect(insertCall).toBeDefined();
      const schemaParam = insertCall[1][7]; // schema 是第 8 个参数
      const schema = JSON.parse(schemaParam);

      // 应该包含用户列和 4 个系统列
      expect(schema.length).toBe(5);
      expect(schema.find((col: any) => col.name === 'user_col')).toBeDefined();
      expect(schema.find((col: any) => col.name === '_row_id')).toBeDefined();
      expect(schema.find((col: any) => col.name === 'deleted_at')).toBeDefined();
      expect(schema.find((col: any) => col.name === 'created_at')).toBeDefined();
      expect(schema.find((col: any) => col.name === 'updated_at')).toBeDefined();
    });
  });
});
