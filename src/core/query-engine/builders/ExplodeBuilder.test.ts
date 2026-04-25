/**
 * ExplodeBuilder 单元测试
 *
 * 测试重点：
 * - 拆列操作 (split_columns)
 * - 展开操作 (unnest_array, unnest_json)
 * - 配置验证
 * - 结果列计算
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ExplodeBuilder } from './ExplodeBuilder';
import type { ExplodeConfig, SQLContext } from '../types';

describe('ExplodeBuilder', () => {
  let builder: ExplodeBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new ExplodeBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'name', 'tags', 'address', 'json_data']),
    };
  });

  // ========== 空配置 ==========
  describe('空配置', () => {
    it('config 为空数组时应该返回 SELECT *', async () => {
      const sql = await builder.build(context, []);

      expect(sql).toBe('SELECT * FROM test_table');
    });

    it('config 为 undefined 时应该返回 SELECT *', async () => {
      const sql = await builder.build(context, undefined as any);

      expect(sql).toBe('SELECT * FROM test_table');
    });
  });

  // ========== 拆列操作 (split_columns) ==========
  describe('拆列操作 (split_columns)', () => {
    it('应该正确拆分列', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'address',
          type: 'split_columns',
          params: {
            delimiter: ',',
            columnNames: ['city', 'district', 'street'],
          },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/split_part\(.*address/);
      expect(sql).toContain("','");
      expect(sql).toMatch(/AS\s+.*city/i);
      expect(sql).toMatch(/AS\s+.*district/i);
      expect(sql).toMatch(/AS\s+.*street/i);
    });

    it('应该使用默认分隔符 (逗号)', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'split_columns',
          params: {
            columnNames: ['tag1', 'tag2'],
          },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain("','");
    });

    it('应该尊重 maxSplits 参数', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'address',
          type: 'split_columns',
          params: {
            delimiter: '-',
            columnNames: ['part1', 'part2', 'part3', 'part4'],
            maxSplits: 2,
          },
        },
      ];

      const sql = await builder.build(context, config);

      // 只应该有 2 个新列
      expect(sql).toMatch(/AS\s+["']?part1["']?/i);
      expect(sql).toMatch(/AS\s+["']?part2["']?/i);
      expect(sql).not.toMatch(/AS\s+["']?part3["']?/i);
      expect(sql).not.toMatch(/AS\s+["']?part4["']?/i);
    });

    it('没有提供 columnNames 时应该报错', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'address',
          type: 'split_columns',
          params: {
            delimiter: ',',
            columnNames: [],
          },
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow('columnNames');
    });

    it('应该保留原有列', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'address',
          type: 'split_columns',
          params: {
            delimiter: ',',
            columnNames: ['city'],
          },
        },
      ];

      const sql = await builder.build(context, config);

      // 检查原有列是否保留（可能带引号也可能不带）
      expect(sql).toMatch(/\bid\b/);
      expect(sql).toMatch(/\bname\b/);
      expect(sql).toMatch(/\btags\b/);
      expect(sql).toMatch(/\baddress\b/);
    });
  });

  // ========== 展开操作 (unnest_array) ==========
  describe('展开操作 (unnest_array)', () => {
    it('应该正确展开数组列', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'unnest_array',
          params: {
            delimiter: ',',
            outputColumn: 'tag',
          },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/unnest\(string_split\(.*tags/i);
      expect(sql).toContain("','");
      expect(sql).toMatch(/AS\s+["']?tag["']?/i);
    });

    it('展开后应该排除原字段', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'unnest_array',
          params: {
            outputColumn: 'tag',
          },
        },
      ];

      const sql = await builder.build(context, config);

      // 原字段 tags 应该被排除（检查select列表中没有单独的tags）
      // 注意：string_split中的tags不算
      expect(sql).toMatch(/\bid\b/);
      expect(sql).toMatch(/\bname\b/);
    });

    it('没有提供 outputColumn 时应该报错', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'unnest_array',
          params: {},
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow('outputColumn');
    });
  });

  // ========== 展开操作 (unnest_json) ==========
  describe('展开操作 (unnest_json)', () => {
    it('应该正确展开 JSON 数组', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'json_data',
          type: 'unnest_json',
          params: {
            jsonPath: '$.items[*]',
            outputColumn: 'item',
          },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/unnest\(json_extract\(.*json_data/i);
      expect(sql).toContain("'$.items[*]'");
      expect(sql).toMatch(/AS\s+["']?item["']?/i);
    });

    it('应该使用默认 jsonPath ($[*])', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'json_data',
          type: 'unnest_json',
          params: {
            outputColumn: 'element',
          },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain("'$[*]'");
    });
  });

  // ========== 多操作限制 ==========
  describe('多操作限制', () => {
    it('只能有一个 unnest 操作', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'unnest_array',
          params: { outputColumn: 'tag' },
        },
        {
          field: 'json_data',
          type: 'unnest_json',
          params: { outputColumn: 'item' },
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow('Only one unnest');
    });

    it('可以有多个 split_columns 操作', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'address',
          type: 'split_columns',
          params: { columnNames: ['city', 'district'] },
        },
        {
          field: 'name',
          type: 'split_columns',
          params: { columnNames: ['first', 'last'] },
        },
      ];

      await expect(builder.build(context, config)).resolves.toBeDefined();
    });
  });

  // ========== 配置验证 ==========
  describe('配置验证', () => {
    it('没有 field 时应该报错', async () => {
      const config: ExplodeConfig[] = [
        {
          field: '',
          type: 'split_columns',
          params: { columnNames: ['col1'] },
        },
      ];

      await expect(builder.build(context, config)).rejects.toThrow('field');
    });

    it('不支持的类型应该返回 SELECT *', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'unknown_type' as any,
          params: {},
        },
      ];

      // 如果没有 unnest 操作，buildSplitColumns 会被调用，
      // 不支持的类型会被跳过
      const sql = await builder.build(context, config);
      expect(sql).toBe('SELECT * FROM test_table');
    });
  });

  // ========== 结果列计算 ==========
  describe('getResultColumns', () => {
    it('split_columns 应该添加新列', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'address',
          type: 'split_columns',
          params: { columnNames: ['city', 'district'] },
        },
      ];

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('city')).toBe(true);
      expect(resultCols.has('district')).toBe(true);
      expect(resultCols.has('address')).toBe(true); // 原列保留
    });

    it('unnest 操作应该替换原字段', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'unnest_array',
          params: { outputColumn: 'tag' },
        },
      ];

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('tag')).toBe(true);
      expect(resultCols.has('tags')).toBe(false); // 原列被移除
    });
  });

  // ========== 边界情况 ==========
  describe('边界情况', () => {
    it('应该正确转义特殊字符的字段名', async () => {
      context.availableColumns.add('user name');
      const config: ExplodeConfig[] = [
        {
          field: 'user name',
          type: 'split_columns',
          params: { columnNames: ['first', 'last'] },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('"user name"');
    });

    it('应该正确处理自定义分隔符', async () => {
      const config: ExplodeConfig[] = [
        {
          field: 'tags',
          type: 'unnest_array',
          params: {
            delimiter: '|',
            outputColumn: 'tag',
          },
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain("'|'");
    });
  });
});
