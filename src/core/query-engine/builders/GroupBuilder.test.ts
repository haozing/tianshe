/**
 * GroupBuilder 单元测试
 *
 * 测试重点：
 * - 分组 SQL 生成
 * - 窗口函数统计
 * - 排序方向
 * - 字段验证
 * - 结果列计算
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GroupBuilder } from './GroupBuilder';
import type { GroupConfig, SQLContext } from '../types';

describe('GroupBuilder', () => {
  let builder: GroupBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new GroupBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'category', 'name', 'amount', 'price', 'quantity']),
    };
  });

  // ========== 基本分组 ==========
  describe('基本分组', () => {
    it('应该按字段分组并排序', async () => {
      const config: GroupConfig = {
        field: 'category',
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('FROM test_table');
      expect(sql).toMatch(/ORDER BY.*category/i);
    });

    it('默认应该升序排序', async () => {
      const config: GroupConfig = {
        field: 'category',
      };

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/ORDER BY.*category.*ASC/i);
    });

    it('应该支持降序排序', async () => {
      const config: GroupConfig = {
        field: 'category',
        order: 'desc',
      };

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/ORDER BY.*category.*DESC/i);
    });
  });

  // ========== 窗口函数统计 ==========
  describe('窗口函数统计', () => {
    it('默认应该添加行号和计数统计', async () => {
      const config: GroupConfig = {
        field: 'category',
      };

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s+\(PARTITION BY.*category/i);
      expect(sql).toContain('AS __group_row_num');
      expect(sql).toMatch(/COUNT\(\*\)\s+OVER\s+\(PARTITION BY.*category/i);
      expect(sql).toContain('AS __group_count');
    });

    it('showStats=false 时不应该添加统计列', async () => {
      const config: GroupConfig = {
        field: 'category',
        showStats: false,
      };

      const sql = await builder.build(context, config);

      expect(sql).not.toContain('__group_row_num');
      expect(sql).not.toContain('__group_count');
      expect(sql).not.toContain('ROW_NUMBER()');
    });

    it('应该为指定的 statsFields 添加聚合统计', async () => {
      const config: GroupConfig = {
        field: 'category',
        statsFields: ['amount', 'price'],
      };

      const sql = await builder.build(context, config);

      // amount 统计
      expect(sql).toMatch(/SUM\(.*amount.*\)\s+OVER\s+\(PARTITION BY.*category/i);
      expect(sql).toContain('AS __group_sum_amount');
      expect(sql).toMatch(/AVG\(.*amount.*\)\s+OVER\s+\(PARTITION BY.*category/i);
      expect(sql).toContain('AS __group_avg_amount');

      // price 统计
      expect(sql).toMatch(/SUM\(.*price.*\)\s+OVER\s+\(PARTITION BY.*category/i);
      expect(sql).toContain('AS __group_sum_price');
      expect(sql).toMatch(/AVG\(.*price.*\)\s+OVER\s+\(PARTITION BY.*category/i);
      expect(sql).toContain('AS __group_avg_price');
    });

    it('statsFields 中不存在的字段应该被忽略', async () => {
      const config: GroupConfig = {
        field: 'category',
        statsFields: ['amount', 'nonexistent_field'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('__group_sum_amount');
      expect(sql).not.toContain('__group_sum_nonexistent_field');
    });
  });

  // ========== 字段验证 ==========
  describe('字段验证', () => {
    it('字段不存在时应该抛出错误', async () => {
      const config: GroupConfig = {
        field: 'nonexistent_field',
      };

      await expect(builder.build(context, config)).rejects.toThrow();
    });

    it('错误消息应该包含字段名', async () => {
      const config: GroupConfig = {
        field: 'nonexistent_field',
      };

      try {
        await builder.build(context, config);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('nonexistent_field');
      }
    });
  });

  // ========== 结果列计算 ==========
  describe('getResultColumns', () => {
    it('应该包含原有列', async () => {
      const config: GroupConfig = {
        field: 'category',
      };

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('id')).toBe(true);
      expect(resultCols.has('category')).toBe(true);
      expect(resultCols.has('name')).toBe(true);
    });

    it('showStats=true 时应该添加统计列', async () => {
      const config: GroupConfig = {
        field: 'category',
        showStats: true,
      };

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('__group_row_num')).toBe(true);
      expect(resultCols.has('__group_count')).toBe(true);
    });

    it('有 statsFields 时应该添加聚合统计列', async () => {
      const config: GroupConfig = {
        field: 'category',
        statsFields: ['amount'],
      };

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('__group_sum_amount')).toBe(true);
      expect(resultCols.has('__group_avg_amount')).toBe(true);
    });

    it('showStats=false 时不应该有统计列', async () => {
      const config: GroupConfig = {
        field: 'category',
        showStats: false,
        statsFields: ['amount'],
      };

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols.has('__group_row_num')).toBe(false);
      expect(resultCols.has('__group_count')).toBe(false);
      expect(resultCols.has('__group_sum_amount')).toBe(false);
    });
  });

  // ========== 边界情况 ==========
  describe('边界情况', () => {
    it('应该正确转义特殊字符的字段名', async () => {
      context.availableColumns.add('user category');
      const config: GroupConfig = {
        field: 'user category',
      };

      const sql = await builder.build(context, config);

      // 特殊字符字段名应该带引号
      expect(sql).toMatch(/["']user category["']/);
    });

    it('空 statsFields 数组应该正常处理', async () => {
      const config: GroupConfig = {
        field: 'category',
        statsFields: [],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('__group_row_num');
      expect(sql).toContain('__group_count');
      expect(sql).not.toContain('__group_sum');
      expect(sql).not.toContain('__group_avg');
    });

    it('SELECT 应该包含所有原始列', async () => {
      const config: GroupConfig = {
        field: 'category',
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('SELECT *');
    });
  });
});
