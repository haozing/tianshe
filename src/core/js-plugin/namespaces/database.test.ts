/**
 * DatabaseNamespace 单元测试
 *
 * 测试重点：
 * - 查询操作 (query)
 * - 插入操作 (insert, batchInsert)
 * - 更新操作 (update, updateById)
 * - 删除操作 (delete, deleteById)
 * - Schema 和数据集信息
 * - 参数验证和错误处理
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DatabaseNamespace } from './database';

// Mock logger
vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock errors
vi.mock('../errors', () => ({
  DatabaseError: class DatabaseError extends Error {
    constructor(
      message: string,
      public details?: any
    ) {
      super(message);
      this.name = 'DatabaseError';
    }
  },
  ValidationError: class ValidationError extends Error {
    constructor(
      message: string,
      public details?: any
    ) {
      super(message);
      this.name = 'ValidationError';
    }
  },
  DatasetNotFoundError: class DatasetNotFoundError extends Error {
    constructor(datasetId: string) {
      super(`Dataset not found: ${datasetId}`);
      this.name = 'DatasetNotFoundError';
    }
  },
}));

// Mock validators
vi.mock('../validators', () => ({
  ParamValidator: {
    validateDatasetId: vi.fn().mockImplementation((id: any) => {
      if (!id || typeof id !== 'string') {
        throw new Error('Invalid datasetId');
      }
    }),
    validateString: vi.fn().mockImplementation((val: any, name: string, opts?: any) => {
      if (typeof val !== 'string') {
        throw new Error(`${name} must be a string`);
      }
      if (!opts?.allowEmpty && val.length === 0) {
        throw new Error(`${name} cannot be empty`);
      }
    }),
    validateObject: vi.fn().mockImplementation((val: any, name: string) => {
      if (!val || typeof val !== 'object') {
        throw new Error(`${name} must be an object`);
      }
    }),
    validateArray: vi.fn().mockImplementation((val: any, name: string, _opts?: any) => {
      if (!Array.isArray(val)) {
        throw new Error(`${name} must be an array`);
      }
    }),
    validateNotNullOrUndefined: vi.fn().mockImplementation((val: any, name: string) => {
      if (val === null || val === undefined) {
        throw new Error(`${name} cannot be null or undefined`);
      }
    }),
  },
}));

// 创建 mock DuckDBService
const createMockDuckDB = () => ({
  queryDataset: vi.fn().mockResolvedValue({ rows: [] }),
  insertRecord: vi.fn().mockResolvedValue(undefined),
  batchInsertRecords: vi.fn().mockResolvedValue(undefined),
  updateRecord: vi.fn().mockResolvedValue(undefined),
  batchUpdateRecords: vi.fn().mockResolvedValue(undefined),
  hardDeleteRows: vi.fn().mockResolvedValue(1),
  withDatasetAttached: vi.fn().mockImplementation(async (_datasetId: string, fn: () => Promise<any>) => await fn()),
  execute: vi.fn().mockResolvedValue(undefined),
  executeWithParams: vi.fn().mockResolvedValue(undefined),
  executeSQLWithParams: vi.fn().mockResolvedValue([]),
  query: vi.fn().mockResolvedValue([]),
  getDatasetInfo: vi.fn().mockResolvedValue({
    id: 'test-dataset',
    name: 'Test Dataset',
    schema: [],
  }),
  listDatasets: vi.fn().mockResolvedValue([]),
});

describe('DatabaseNamespace', () => {
  let database: DatabaseNamespace;
  let mockDuckDB: ReturnType<typeof createMockDuckDB>;

  beforeEach(() => {
    mockDuckDB = createMockDuckDB();
    database = new DatabaseNamespace(mockDuckDB as any, 'test-plugin');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ========== query ==========
  describe('query', () => {
    it('应该查询所有记录', async () => {
      mockDuckDB.queryDataset.mockResolvedValue({
        rows: [{ id: 1, name: 'Test' }],
      });

      const result = await database.query('dataset-123');

      expect(mockDuckDB.queryDataset).toHaveBeenCalledWith('dataset-123', 'SELECT * FROM data');
      expect(result).toEqual([{ id: 1, name: 'Test' }]);
    });

    it('应该支持自定义 SQL', async () => {
      mockDuckDB.queryDataset.mockResolvedValue({
        rows: [{ id: 1 }],
      });

      await database.query('dataset-123', 'SELECT id FROM data WHERE price > 100');

      expect(mockDuckDB.queryDataset).toHaveBeenCalledWith(
        'dataset-123',
        'SELECT id FROM data WHERE price > 100'
      );
    });

    it('应该拒绝通过 query 执行变更 SQL', async () => {
      await expect(
        database.query('dataset-123', 'UPDATE data SET status = "unsafe" WHERE id = 1')
      ).rejects.toThrow(/read-only|UPDATE/i);

      expect(mockDuckDB.queryDataset).not.toHaveBeenCalled();
    });

    it('数据集不存在时应该抛出 DatasetNotFoundError', async () => {
      mockDuckDB.queryDataset.mockRejectedValue(new Error('Dataset not found'));

      await expect(database.query('non-existent')).rejects.toThrow('not found');
    });

    it('查询失败时应该抛出 DatabaseError', async () => {
      mockDuckDB.queryDataset.mockRejectedValue(new Error('SQL syntax error'));

      await expect(database.query('dataset-123', 'INVALID SQL')).rejects.toThrow();
    });
  });

  // ========== insert ==========
  describe('insert', () => {
    it('应该插入单条记录', async () => {
      const record = { name: 'Product', price: 99.9 };

      await database.insert('dataset-123', record);

      expect(mockDuckDB.insertRecord).toHaveBeenCalledWith('dataset-123', record);
    });

    it('数据集不存在时应该抛出错误', async () => {
      mockDuckDB.insertRecord.mockRejectedValue(new Error('Dataset does not exist'));

      await expect(database.insert('non-existent', { name: 'Test' })).rejects.toThrow();
    });
  });

  // ========== batchInsert ==========
  describe('batchInsert', () => {
    it('空数组应该直接返回', async () => {
      await database.batchInsert('dataset-123', []);

      expect(mockDuckDB.insertRecord).not.toHaveBeenCalled();
      expect(mockDuckDB.executeWithParams).not.toHaveBeenCalled();
    });

    it('单条记录应该使用 insertRecord', async () => {
      const records = [{ name: 'Test' }];

      await database.batchInsert('dataset-123', records);

      expect(mockDuckDB.batchInsertRecords).toHaveBeenCalledWith('dataset-123', records);
    });

    it('多条记录应该使用批量插入', async () => {
      const records = [
        { name: 'Product 1', price: 100 },
        { name: 'Product 2', price: 200 },
      ];

      await database.batchInsert('dataset-123', records);

      expect(mockDuckDB.batchInsertRecords).toHaveBeenCalledWith('dataset-123', records);
    });
  });

  // ========== update ==========
  describe('update', () => {
    it('应该拒绝遗留 where 字符串接口', async () => {
      await expect(
        database.update('dataset-123', { status: 'active' }, "name = 'Test'")
      ).rejects.toThrow(/raw SQL WHERE strings are unsafe/);

      expect(mockDuckDB.executeSQLWithParams).not.toHaveBeenCalled();
      expect(mockDuckDB.batchUpdateRecords).not.toHaveBeenCalled();
    });
  });

  // ========== updateById ==========
  describe('updateById', () => {
    it('应该按行ID更新记录', async () => {
      await database.updateById('dataset-123', 5, { status: 'published' });

      expect(mockDuckDB.updateRecord).toHaveBeenCalledWith('dataset-123', 5, {
        status: 'published',
      });
    });
  });

  // ========== delete ==========
  describe('delete', () => {
    it('应该拒绝遗留 where 字符串接口', async () => {
      await expect(database.delete('dataset-123', "status = 'deleted'")).rejects.toThrow(
        /raw SQL WHERE strings are unsafe/
      );

      expect(mockDuckDB.executeSQLWithParams).not.toHaveBeenCalled();
      expect(mockDuckDB.hardDeleteRows).not.toHaveBeenCalled();
    });
  });

  // ========== deleteById ==========
  describe('deleteById', () => {
    it('应该按行ID删除记录', async () => {
      await database.deleteById('dataset-123', 10);

      expect(mockDuckDB.hardDeleteRows).toHaveBeenCalledWith('dataset-123', [10]);
    });
  });

  // ========== getSchema ==========
  describe('getSchema', () => {
    it('应该返回数据集 Schema', async () => {
      const mockSchema = [
        { name: 'id', duckdbType: 'INTEGER' },
        { name: 'name', duckdbType: 'VARCHAR' },
      ];

      mockDuckDB.getDatasetInfo.mockResolvedValue({
        id: 'dataset-123',
        schema: mockSchema,
      });

      const schema = await database.getSchema('dataset-123');

      expect(schema).toEqual(mockSchema);
    });

    it('数据集不存在时应该抛出错误', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValue(null);

      await expect(database.getSchema('non-existent')).rejects.toThrow();
    });
  });

  // ========== getDatasetInfo ==========
  describe('getDatasetInfo', () => {
    it('应该返回数据集信息', async () => {
      const mockInfo = {
        id: 'dataset-123',
        name: 'Test Dataset',
        rowCount: 100,
      };

      mockDuckDB.getDatasetInfo.mockResolvedValue(mockInfo);

      const info = await database.getDatasetInfo('dataset-123');

      expect(info).toEqual(mockInfo);
    });
  });

  // ========== listDatasets ==========
  describe('listDatasets', () => {
    it('应该列出所有数据集', async () => {
      const mockList = [
        { id: 'ds-1', name: 'Dataset 1' },
        { id: 'ds-2', name: 'Dataset 2' },
      ];

      mockDuckDB.listDatasets.mockResolvedValue(mockList);

      const result = await database.listDatasets();

      expect(result).toEqual(mockList);
    });
  });

  // ========== executeSQL ==========
  describe('executeSQL', () => {
    it('应该执行自定义 SQL', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([{ count: 10 }]);

      const result = await database.executeSQL('SELECT COUNT(*) as count FROM ds_test.data');

      expect(mockDuckDB.executeSQLWithParams).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM ds_test.data',
        []
      );
      expect(result).toEqual([{ count: 10 }]);
    });

    it('应该支持参数化查询（旧 API）', async () => {
      mockDuckDB.executeSQLWithParams.mockResolvedValue([{ id: 1 }]);

      await database.executeSQL('SELECT * FROM data WHERE id = ?', [1]);

      expect(mockDuckDB.executeSQLWithParams).toHaveBeenCalledWith(
        'SELECT * FROM data WHERE id = ?',
        [1]
      );
    });

    it('应该支持新 API 格式', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValue({ id: 'dataset-123' });
      mockDuckDB.executeSQLWithParams.mockResolvedValue([{ id: 1 }]);

      await database.executeSQL('SELECT * FROM data WHERE price > ?', {
        params: [100],
        datasetId: 'dataset-123',
      });

      expect(mockDuckDB.withDatasetAttached).toHaveBeenCalledWith(
        'dataset-123',
        expect.any(Function)
      );
      expect(mockDuckDB.executeSQLWithParams).toHaveBeenCalledWith(
        'SELECT * FROM "ds_dataset-123".data WHERE price > ?',
        [100]
      );
    });

    it('提供 datasetId 时应该替换表名', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValue({ id: 'dataset-123' });
      mockDuckDB.executeSQLWithParams.mockResolvedValue([]);

      await database.executeSQL('SELECT * FROM data', { datasetId: 'dataset-123' });

      expect(mockDuckDB.executeSQLWithParams).toHaveBeenCalledWith(
        'SELECT * FROM "ds_dataset-123".data',
        []
      );
    });

    it('在 datasetId 模式下应拒绝变更 SQL', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValue({ id: 'dataset-123' });

      await expect(
        database.executeSQL('DELETE FROM data WHERE id = 1', { datasetId: 'dataset-123' })
      ).rejects.toThrow(/read-only|DELETE/i);

      expect(mockDuckDB.executeSQLWithParams).not.toHaveBeenCalled();
    });

    it('在 datasetId 模式下应拒绝多语句 SQL', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValue({ id: 'dataset-123' });

      await expect(
        database.executeSQL('SELECT * FROM data; DELETE FROM data WHERE id = 1', {
          datasetId: 'dataset-123',
        })
      ).rejects.toThrow(/single/);

      expect(mockDuckDB.executeSQLWithParams).not.toHaveBeenCalled();
    });
  });
});
