/**
 * SampleBuilder 单元测试
 *
 * 测试重点：
 * - 百分比采样
 * - 固定行数采样
 * - 分层采样
 * - 配置验证
 * - 随机种子
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SampleBuilder } from './SampleBuilder';
import type { SampleConfig, SQLContext } from '../types';

// Mock console.warn 来验证警告
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('SampleBuilder', () => {
  let builder: SampleBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new SampleBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['_row_id', 'id', 'name', 'category', 'region', 'amount']),
    };
    consoleWarnSpy.mockClear();
  });

  // ========== 百分比采样 ==========
  describe('百分比采样', () => {
    it('应该构建百分比采样 SQL', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 10,
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('SELECT * FROM test_table');
      expect(sql).toContain('USING SAMPLE 10%');
    });

    it('应该支持随机种子', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 25,
        seed: 42,
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('hash(_row_id, 42)');
      expect(sql).toContain('WHERE');
      expect(sql).not.toContain('USING SAMPLE');
    });

    it('百分比过小应该报错', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 0.0001, // 小于最小值 0.001%
      };

      await expect(builder.build(context, config)).rejects.toThrow('太小');
    });

    it('百分比过大应该报错', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 100, // 超过最大值 99.9%
      };

      await expect(builder.build(context, config)).rejects.toThrow('过高');
    });

    it('百分比超过80%应该警告', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 85,
      };

      await builder.build(context, config);

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('采样百分比较高'));
    });

    it('没有 value 时应该报错', async () => {
      const config: SampleConfig = {
        type: 'percentage',
      } as any;

      await expect(builder.build(context, config)).rejects.toThrow('value');
    });
  });

  // ========== 固定行数采样 ==========
  describe('固定行数采样', () => {
    it('应该构建行数采样 SQL', async () => {
      const config: SampleConfig = {
        type: 'rows',
        value: 1000,
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('SELECT * FROM test_table');
      expect(sql).toContain('USING SAMPLE 1000 ROWS');
    });

    it('应该支持随机种子', async () => {
      const config: SampleConfig = {
        type: 'rows',
        value: 500,
        seed: 123,
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('ORDER BY hash(_row_id, 123)');
      expect(sql).toContain('LIMIT 500');
      expect(sql).not.toContain('USING SAMPLE');
    });

    it('行数为0或负数应该报错', async () => {
      const config: SampleConfig = {
        type: 'rows',
        value: 0,
      };

      await expect(builder.build(context, config)).rejects.toThrow('positive');
    });

    it('行数必须是整数', async () => {
      const config: SampleConfig = {
        type: 'rows',
        value: 100.5,
      };

      await expect(builder.build(context, config)).rejects.toThrow('integer');
    });

    it('行数超过上限应该报错', async () => {
      const config: SampleConfig = {
        type: 'rows',
        value: 20_000_000, // 超过 10_000_000 上限
      };

      await expect(builder.build(context, config)).rejects.toThrow('超过上限');
    });

    it('行数较大应该警告', async () => {
      const config: SampleConfig = {
        type: 'rows',
        value: 2_000_000,
      };

      await builder.build(context, config);

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('采样行数较大'));
    });
  });

  // ========== 分层采样 ==========
  describe('分层采样', () => {
    it('应该构建分层采样 SQL', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category'],
        value: 100,
      };

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s+\(PARTITION BY.*category/i);
      expect(sql).toContain('ORDER BY RANDOM()');
      expect(sql).toContain('_sample_rn <= 100');
    });

    it('应该支持多个分层字段', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category', 'region'],
        value: 50,
      };

      const sql = await builder.build(context, config);

      expect(sql).toMatch(/PARTITION BY.*category.*,.*region/i);
      expect(sql).toContain('_sample_rn <= 50');
    });

    it('分层采样应该支持随机种子', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category'],
        value: 20,
        seed: 42,
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('hash(_row_id, 42)');
      expect(sql).not.toContain('ORDER BY RANDOM()');
    });

    it('没有 stratifyBy 时应该报错', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        value: 100,
      } as any;

      await expect(builder.build(context, config)).rejects.toThrow('stratifyBy');
    });

    it('stratifyBy 为空数组时应该报错', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: [],
        value: 100,
      };

      await expect(builder.build(context, config)).rejects.toThrow('stratifyBy');
    });

    it('分层字段不存在时应该报错', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['missing_field'],
        value: 100,
      };

      await expect(builder.build(context, config)).rejects.toThrow('missing_field');
    });

    it('value 为负数时应该报错', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category'],
        value: -10,
      };

      await expect(builder.build(context, config)).rejects.toThrow('positive');
    });

    it('每组行数较大应该警告', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category'],
        value: 150_000,
      };

      await builder.build(context, config);

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('每组行数较大'));
    });

    it('分层字段过多应该警告', async () => {
      context.availableColumns = new Set([
        ...Array.from(context.availableColumns),
        'f1',
        'f2',
        'f3',
        'f4',
        'f5',
        'f6',
      ]);

      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
        value: 100,
      };

      await builder.build(context, config);

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('分层字段过多'));
    });

    it('默认每组 100 行', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('_sample_rn <= 100');
    });
  });

  // ========== 随机种子验证 ==========
  describe('随机种子验证', () => {
    it('seed 为负数应该报错', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 10,
        seed: -1,
      };

      await expect(builder.build(context, config)).rejects.toThrow('non-negative');
    });

    it('seed 必须是整数', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 10,
        seed: 1.5,
      };

      await expect(builder.build(context, config)).rejects.toThrow('integer');
    });
  });

  // ========== 不支持的类型 ==========
  describe('不支持的类型', () => {
    it('不支持的采样类型应该报错', async () => {
      const config: SampleConfig = {
        type: 'unknown' as any,
        value: 10,
      };

      await expect(builder.build(context, config)).rejects.toThrow('Invalid sample type');
    });
  });

  // ========== 结果列计算 ==========
  describe('getResultColumns', () => {
    it('采样不应该改变列结构', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 10,
      };

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      expect(resultCols).toEqual(context.availableColumns);
    });

    it('分层采样不应该在结果中包含技术列', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category'],
        value: 100,
      };

      await builder.build(context, config);
      const resultCols = await builder.getResultColumns(context, config);

      // _sample_rn 不应该在结果列中
      expect(resultCols.has('_sample_rn')).toBe(false);
    });
  });

  // ========== 边界情况 ==========
  describe('边界情况', () => {
    it('应该正确转义特殊字符的字段名', async () => {
      context.availableColumns.add('user category');
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['user category'],
        value: 50,
      };

      const sql = await builder.build(context, config);

      // 特殊字符字段名应该带引号
      expect(sql).toMatch(/["']user category["']/);
    });

    it('分层采样应该选择所有可用列', async () => {
      const config: SampleConfig = {
        type: 'stratified',
        stratifyBy: ['category'],
        value: 100,
      };

      const sql = await builder.build(context, config);

      // 应该包含所有列（可能带引号也可能不带）
      expect(sql).toMatch(/\bid\b/);
      expect(sql).toMatch(/\bname\b/);
      expect(sql).toMatch(/\bcategory\b/);
      expect(sql).toMatch(/\bregion\b/);
      expect(sql).toMatch(/\bamount\b/);
    });

    it('最小有效百分比应该工作', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 0.001,
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('USING SAMPLE 0.001%');
    });

    it('最大有效百分比应该工作', async () => {
      const config: SampleConfig = {
        type: 'percentage',
        value: 99.9,
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('USING SAMPLE 99.9%');
    });
  });
});
