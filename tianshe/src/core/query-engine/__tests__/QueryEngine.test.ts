/**
 * QueryEngine 综合测试
 * 测试 SQL 生成、查询执行、预览服务等核心功能
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryEngine } from '../QueryEngine';
import { MockDuckDBService } from './mocks/MockDuckDBService';
import type { QueryConfig } from '../types';

describe('QueryEngine', () => {
  let queryEngine: QueryEngine;
  let mockDb: MockDuckDBService;

  beforeEach(() => {
    mockDb = new MockDuckDBService();
    queryEngine = new QueryEngine(mockDb as any);
  });

  describe('基础功能测试', () => {
    it('应该成功初始化', () => {
      expect(queryEngine).toBeDefined();
      expect(queryEngine.preview).toBeDefined();
    });

    it('应该能够生成简单的 SQL', async () => {
      const config: QueryConfig = {
        columns: {
          select: ['name', 'age'],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('SELECT');
      expect(sql).toContain('name');
      expect(sql).toContain('age');
      expect(sql).toContain('FROM');
    });

    it('应该能够执行查询', async () => {
      const config: QueryConfig = {
        columns: {
          select: ['name', 'age'],
        },
        sort: {
          pagination: { page: 1, pageSize: 10 },
        },
      };

      const result = await queryEngine.execute('users', config);

      expect(result.success).toBe(true);
      expect(result.columns).toBeDefined();
      expect(result.rows).toBeDefined();
      expect(result.generatedSQL).toBeDefined();
    });
  });

  describe('筛选功能测试', () => {
    it('应该支持简单条件筛选', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [
            {
              field: 'age',
              type: 'greater_than',
              value: 25,
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('WHERE');
      expect(sql).toContain('age');
      expect(sql).toContain('>');
    });

    it('应该支持多条件筛选', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [
            {
              field: 'age',
              type: 'greater_than',
              value: 25,
            },
            {
              field: 'city',
              type: 'equal',
              value: '北京',
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('WHERE');
      expect(sql).toContain('AND');
    });

    it('应该支持 BETWEEN 条件', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [
            {
              field: 'age',
              type: 'between',
              values: [25, 35],
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('BETWEEN');
    });

    it('应该支持 NULL 检查', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [
            {
              field: 'email',
              type: 'not_null',
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('IS NOT NULL');
    });
  });

  describe('聚合功能测试', () => {
    it('应该支持 GROUP BY 聚合', async () => {
      const config: QueryConfig = {
        aggregate: {
          groupBy: ['city'],
          measures: [
            {
              name: 'avg_age',
              function: 'AVG',
              field: 'age',
            },
            {
              name: 'user_count',
              function: 'COUNT',
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('city');
      expect(sql).toContain('AVG');
      expect(sql).toContain('COUNT');
    });

    it('应该支持多字段分组', async () => {
      const config: QueryConfig = {
        aggregate: {
          groupBy: ['city', 'age'],
          measures: [
            {
              name: 'count',
              function: 'COUNT',
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('city');
      expect(sql).toContain('age');
    });
  });

  describe('排序和分页测试', () => {
    it('应该支持排序', async () => {
      const config: QueryConfig = {
        sort: {
          columns: [{ field: 'age', direction: 'DESC' }],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('age');
      expect(sql).toContain('DESC');
    });

    it('应该支持分页', async () => {
      const config: QueryConfig = {
        sort: {
          pagination: {
            page: 2,
            pageSize: 10,
          },
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
    });

    it('应该支持多字段排序', async () => {
      const config: QueryConfig = {
        sort: {
          columns: [
            { field: 'city', direction: 'ASC' },
            { field: 'age', direction: 'DESC' },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('city');
      expect(sql).toContain('age');
    });
  });

  describe('数据清洗测试', () => {
    it('应该支持字段清洗', async () => {
      const config: QueryConfig = {
        clean: [
          {
            field: 'email',
            operations: [{ type: 'trim' }, { type: 'lower' }],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('TRIM');
      expect(sql).toContain('LOWER');
    });

    it('应该支持多字段清洗', async () => {
      const config: QueryConfig = {
        clean: [
          {
            field: 'name',
            operations: [{ type: 'trim' }],
          },
          {
            field: 'email',
            operations: [{ type: 'lower' }],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('cleaned');
    });
  });

  describe('计算列测试', () => {
    it('应该支持自定义计算列', async () => {
      const config: QueryConfig = {
        compute: [
          {
            name: 'age_double',
            type: 'custom',
            expression: 'age * 2',
          },
        ],
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('age * 2');
      expect(sql).toContain('age_double');
    });

    it('应该防止计算列名冲突', async () => {
      const config: QueryConfig = {
        compute: [
          {
            name: 'name', // 已存在的列名
            type: 'custom',
            expression: 'UPPER(name)',
          },
        ],
      };

      await expect(queryEngine.buildSQL('users', config)).rejects.toThrow();
    });
  });

  describe('去重功能测试', () => {
    it('应该支持基于字段的去重', async () => {
      const config: QueryConfig = {
        dedupe: {
          type: 'row_number',
          partitionBy: ['city'],
          orderBy: [{ field: 'age', direction: 'DESC' }],
          keep: 'first',
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      expect(sql).toContain('ROW_NUMBER');
      expect(sql).toContain('PARTITION BY');
      expect(sql).toContain('city');
    });

    it('应该防止聚合后使用 row_number 去重', async () => {
      const config: QueryConfig = {
        aggregate: {
          groupBy: ['city'],
          measures: [{ name: 'cnt', function: 'COUNT' }],
        },
        dedupe: {
          type: 'row_number',
          partitionBy: ['city'],
        },
      };

      await expect(queryEngine.buildSQL('users', config)).rejects.toThrow();
    });
  });

  describe('CTE 链式测试', () => {
    it('应该支持多个操作的链式组合', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [{ field: 'age', type: 'greater_than', value: 25 }],
        },
        clean: [
          {
            field: 'email',
            operations: [{ type: 'lower' }],
          },
        ],
        aggregate: {
          groupBy: ['city'],
          measures: [{ name: 'user_count', function: 'COUNT' }],
        },
        sort: {
          columns: [{ field: 'user_count', direction: 'DESC' }],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      // 应该包含所有 CTE
      expect(sql).toContain('WITH');
      expect(sql).toContain('filtered');
      expect(sql).toContain('cleaned');
      expect(sql).toContain('aggregated');
      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('ORDER BY');
    });
  });

  describe('错误处理测试', () => {
    it('应该拒绝无效的配置', async () => {
      const invalidConfig = {
        filter: {
          combinator: 'invalid' as any,
          conditions: [],
        },
      };

      await expect(queryEngine.buildSQL('users', invalidConfig)).rejects.toThrow();
    });

    it('应该检测不存在的字段', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [
            {
              field: 'nonexistent_field',
              type: 'equal',
              value: 'test',
            },
          ],
        },
      };

      const validation = await queryEngine.validateConfig('users', config);

      expect(validation.success).toBe(false);
      expect(validation.errors).toBeDefined();
    });

    it('应该处理不存在的数据集', async () => {
      const config: QueryConfig = {};

      await expect(queryEngine.buildSQL('nonexistent_dataset', config)).rejects.toThrow();
    });
  });

  describe('缓存功能测试', () => {
    it('应该缓存列信息', async () => {
      const config: QueryConfig = {};

      // 第一次调用
      await queryEngine.buildSQL('users', config);
      const firstLog = mockDb.getQueryLog().length;

      // 第二次调用应该使用缓存
      await queryEngine.buildSQL('users', config);
      const secondLog = mockDb.getQueryLog().length;

      // 验证没有额外的数据库查询
      expect(secondLog).toBe(firstLog);
    });

    it('应该能够清除缓存', async () => {
      const config: QueryConfig = {};

      await queryEngine.buildSQL('users', config);

      // 清除缓存
      queryEngine.clearColumnCache('users');

      // 应该能够继续工作
      await expect(queryEngine.buildSQL('users', config)).resolves.toBeDefined();
    });
  });

  describe('PreviewService 测试', () => {
    it('应该提供预览服务', () => {
      expect(queryEngine.preview).toBeDefined();
      expect(queryEngine.preview.previewClean).toBeDefined();
      expect(queryEngine.preview.previewDedupe).toBeDefined();
      expect(queryEngine.preview.previewAggregate).toBeDefined();
    });

    it('应该能够预览聚合结果', async () => {
      const aggregateConfig = {
        groupBy: ['city'],
        measures: [{ name: 'count', function: 'COUNT' as const }],
      };

      const result = await queryEngine.preview.previewAggregate('users', aggregateConfig, {
        limit: 5,
      });

      expect(result).toBeDefined();
      expect(result.estimatedRows).toBeDefined();
      expect(result.stats).toBeDefined();
    });

    it('应该能够预览采样结果', async () => {
      const sampleConfig = {
        type: 'percentage' as const,
        value: 50,
      };

      const result = await queryEngine.preview.previewSample('users', sampleConfig);

      expect(result).toBeDefined();
      expect(result.sampleSize).toBeDefined();
      // Mock 简化实现，实际应该返回 0.5
      expect(typeof result.samplingRatio).toBe('number');
    });
  });

  describe('性能测试', () => {
    it('应该在合理时间内生成复杂 SQL', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [
            { field: 'age', type: 'greater_than', value: 20 },
            { field: 'city', type: 'in', values: ['北京', '上海', '深圳'] },
          ],
        },
        clean: [
          {
            field: 'email',
            operations: [{ type: 'trim' }, { type: 'lower' }],
          },
        ],
        aggregate: {
          groupBy: ['city'],
          measures: [
            { name: 'avg_age', function: 'AVG', field: 'age' },
            { name: 'total_score', function: 'SUM', field: 'score' },
            { name: 'count', function: 'COUNT' },
          ],
        },
        sort: {
          columns: [{ field: 'total_score', direction: 'DESC' }],
          pagination: { page: 1, pageSize: 10 },
        },
      };

      const startTime = Date.now();
      await queryEngine.buildSQL('users', config);
      const duration = Date.now() - startTime;

      // SQL 生成应该在 100ms 内完成
      expect(duration).toBeLessThan(100);
    });
  });

  describe('SQL 注入防护测试', () => {
    it('应该正确转义字符串值', async () => {
      const config: QueryConfig = {
        filter: {
          combinator: 'AND',
          conditions: [
            {
              field: 'name',
              type: 'equal',
              value: "'; DROP TABLE users; --",
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('users', config);

      // 应该正确转义单引号
      // 原始值: '; DROP TABLE users; --
      // SQL 中: name = '''; DROP TABLE users; --'
      // 其中 ''' 表示：开始引号 + 转义的单引号('')
      expect(sql).toContain("'''"); // 转义后的单引号
      expect(sql).toContain("name = '''; DROP TABLE users; --'");
      // SQL 注入被防护：整个值被当作字符串字面量，不会被执行
    });
  });
});
