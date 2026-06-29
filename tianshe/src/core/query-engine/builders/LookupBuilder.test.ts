/**
 * LookupBuilder 单元测试
 *
 * 测试重点：
 * - JOIN 类型关联
 * - MAP 类型码值映射
 * - 配置验证
 * - 结果列计算
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LookupBuilder } from './LookupBuilder';
import type { LookupConfig, SQLContext } from '../types';
import type { IDatasetResolver } from '../interfaces/IDatasetResolver';

// Mock DatasetResolver
const createMockDatasetResolver = (): IDatasetResolver => ({
  getDatasetInfo: vi.fn().mockResolvedValue({
    id: 'users_dataset',
    name: 'users_dataset',
    filePath: '/tmp/users_dataset.duckdb',
    rowCount: 0,
    columnCount: 0,
    sizeBytes: 0,
    createdAt: Date.now(),
    schema: [
      { name: 'id', duckdbType: 'INTEGER' },
      { name: 'name', duckdbType: 'VARCHAR' },
      { name: 'email', duckdbType: 'VARCHAR' },
      { name: '_row_id', duckdbType: 'INTEGER' }, // system column (should be excluded)
      { name: 'created_at', duckdbType: 'TIMESTAMP' }, // system column (should be excluded)
    ],
  } as any),
  getDatasetTableName: vi.fn().mockResolvedValue('ds_lookup_dataset.data'),
  datasetExists: vi.fn().mockResolvedValue(true),
});

describe('LookupBuilder', () => {
  let builder: LookupBuilder;
  let mockResolver: IDatasetResolver;
  let context: SQLContext;

  beforeEach(() => {
    mockResolver = createMockDatasetResolver();
    builder = new LookupBuilder(mockResolver);
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'user_id', 'product_id', 'status', 'code']),
    };
  });

  // ========== JOIN 类型关联 ==========
  describe('JOIN 类型关联', () => {
    it('应该构建基本的 INNER JOIN', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table',
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('INNER JOIN');
      expect(sql).toContain('users_table AS lookup_table');
      // 检查 join 条件（格式可能是 "user_id" 或不带引号）
      expect(sql).toMatch(/user_id.*=.*id/);
    });

    it('应该构建 LEFT JOIN', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table',
          leftJoin: true,
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('LEFT JOIN');
    });

    it('应该选择指定的列', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table',
          selectColumns: ['name', 'email'],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('main_table.*');
      // 检查是否选择了lookup表的列
      expect(sql).toMatch(/lookup_table\.\S*name/);
      expect(sql).toMatch(/lookup_table\.\S*email/);
    });

    it('selectColumns 引用了不存在的维表列时应该报错', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupDatasetId: 'users_dataset',
          selectColumns: ['missing_column'],
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow('Columns not found');
    });

    it('没有 selectColumns 时只选择主表列', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table',
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('main_table.*');
      // 没有selectColumns时，不应该有 lookup_table.xxx 列
      expect(sql).not.toMatch(/lookup_table\.\w+\s*,/);
    });

    it('应该使用 lookupDatasetId 通过 resolver 获取表名', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupDatasetId: 'users_dataset',
        },
      ];

      await builder.build(context, config);

      expect(mockResolver.getDatasetTableName).toHaveBeenCalledWith('users_dataset');
    });

    it('lookupDatasetId 且未设置 selectColumns 时默认带回维表所有列', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupDatasetId: 'users_dataset',
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('lookup_table');
      expect(sql).toMatch(/lookup_table\.\S*name/);
      expect(sql).toMatch(/lookup_table\.\S*email/);
    });

    it('没有 lookupTable 和 lookupDatasetId 时应该报错', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow(
        'lookupTable or lookupDatasetId'
      );
    });

    it('lookupTable 非法时应该报错', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table; DROP TABLE users_table',
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow('Invalid table reference');
    });
  });

  // ========== MAP 类型码值映射 ==========
  describe('MAP 类型码值映射', () => {
    it('应该构建 CASE WHEN 语句', async () => {
      const config: LookupConfig[] = [
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status_name',
          codeMapping: {
            '1': '待处理',
            '2': '处理中',
            '3': '已完成',
          },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('CASE');
      // 检查 WHEN 子句（不同实现可能有不同的引号格式）
      expect(sql).toMatch(/WHEN.*status.*=.*'1'.*THEN.*'待处理'/);
      expect(sql).toMatch(/WHEN.*status.*=.*'2'.*THEN.*'处理中'/);
      expect(sql).toMatch(/WHEN.*status.*=.*'3'.*THEN.*'已完成'/);
      expect(sql).toContain('END');
      expect(sql).toMatch(/AS.*status_name/);
    });

    it('应该有默认值 (ELSE 原值)', async () => {
      const config: LookupConfig[] = [
        {
          type: 'map',
          joinKey: 'code',
          lookupKey: 'code_label',
          codeMapping: {
            A: 'Alpha',
            B: 'Beta',
          },
        },
      ];

      const sql = await builder.build(context, config);

      // ELSE 后面是原字段名
      expect(sql).toMatch(/ELSE.*code/);
    });

    it('没有 codeMapping 时应该报错', async () => {
      const config: LookupConfig[] = [
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status_name',
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow('codeMapping');
    });

    it('MAP 类型应该保留所有原始列', async () => {
      const config: LookupConfig[] = [
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status_name',
          codeMapping: { '1': 'Active' },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('SELECT *');
    });

    it('MAP 输出列与现有列冲突时应该报错', async () => {
      const config: LookupConfig[] = [
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status',
          codeMapping: { '1': 'Active' },
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow(
        'conflicts with an existing column'
      );
    });
  });

  // ========== 多次关联 ==========
  describe('多次关联', () => {
    it('应该支持链式关联', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table',
          selectColumns: ['name'],
        },
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status_label',
          codeMapping: { '1': 'Active' },
        },
      ];

      const sql = await builder.build(context, config);

      // 多次关联应生成内部 CTE 链
      expect(sql).toContain('WITH _lookup_0 AS');
      expect(sql).toContain('_lookup_1 AS');
    });
  });

  // ========== 不支持的类型 ==========
  describe('不支持的类型', () => {
    it('不支持的 lookup 类型应该报错', async () => {
      const config: LookupConfig[] = [
        {
          type: 'unknown' as any,
          joinKey: 'user_id',
          lookupKey: 'id',
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow(
        'Unsupported lookup operation: unknown'
      );
    });
  });

  // ========== 结果列计算 ==========
  describe('getResultColumns', () => {
    it('JOIN 类型应该添加 selectColumns 到结果列', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table',
          selectColumns: ['name', 'email'],
        },
      ];

      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('name')).toBe(true);
      expect(resultCols.has('email')).toBe(true);
      // 原有列也应该保留
      expect(resultCols.has('id')).toBe(true);
      expect(resultCols.has('user_id')).toBe(true);
    });

    it('MAP 类型应该添加输出列到结果列', async () => {
      const config: LookupConfig[] = [
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status_name',
          codeMapping: { '1': 'Active' },
        },
      ];

      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('status_name')).toBe(true);
      expect(resultCols.has('status')).toBe(true); // 原列保留
    });

    it('没有 selectColumns 的 JOIN 不应该添加额外列', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupTable: 'users_table',
        },
      ];

      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.size).toBe(context.availableColumns.size);
    });

    it('lookupDatasetId 且未设置 selectColumns 时应加入维表所有列（排除系统列）', async () => {
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user_id',
          lookupKey: 'id',
          lookupDatasetId: 'users_dataset',
        },
      ];

      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('name')).toBe(true);
      expect(resultCols.has('email')).toBe(true);
      // id 在主表中已存在，应自动改名为 lookup_id
      expect(resultCols.has('lookup_id')).toBe(true);
      // 系统列应被排除
      expect(resultCols.has('_row_id')).toBe(false);
      expect(resultCols.has('created_at')).toBe(false);
    });
  });

  // ========== 边界情况 ==========
  describe('边界情况', () => {
    it('空配置数组应该返回空字符串', async () => {
      const sql = await builder.build(context, []);

      expect(sql).toBe('');
    });

    it('应该正确转义特殊字符的字段名', async () => {
      context.availableColumns.add('user id');
      const config: LookupConfig[] = [
        {
          type: 'join',
          joinKey: 'user id',
          lookupKey: 'id',
          lookupTable: 'users_table',
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('"user id"');
    });

    it('应该正确转义 codeMapping 中的特殊字符', async () => {
      const config: LookupConfig[] = [
        {
          type: 'map',
          joinKey: 'code',
          lookupKey: 'label',
          codeMapping: {
            "test'value": "结果'值",
          },
        },
      ];

      const sql = await builder.build(context, config);

      // 单引号应该被转义
      expect(sql).toContain("test''value");
      expect(sql).toContain("结果''值");
    });
  });
});
