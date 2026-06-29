/**
 * AggregateBuilder 单元测试
 * 测试重点：GROUP BY、聚合函数、HAVING子句
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AggregateBuilder } from './AggregateBuilder';
import type { AggregateConfig, SQLContext } from '../types';

describe('AggregateBuilder', () => {
  let builder: AggregateBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new AggregateBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'category', 'price', 'quantity', 'name', 'created_at']),
    };
  });

  describe('COUNT Aggregation', () => {
    it('should build COUNT(*) aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'total_count',
            function: 'COUNT',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('SELECT category, COUNT(*) AS total_count');
      expect(sql).toContain('FROM test_table');
      expect(sql).toContain('GROUP BY category');
    });

    it('should build COUNT(field) aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'id_count',
            function: 'COUNT',
            field: 'id',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('COUNT(id) AS id_count');
    });

    it('should build COUNT(DISTINCT field) aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'unique_names',
            function: 'COUNT',
            field: 'name',
            params: { distinct: true },
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('COUNT(DISTINCT name) AS unique_names');
    });

    it('should build COUNT_DISTINCT aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'unique_products',
            function: 'COUNT_DISTINCT',
            field: 'id',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('COUNT(DISTINCT id) AS unique_products');
    });

    it('should throw error for COUNT_DISTINCT without field', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'count',
            function: 'COUNT_DISTINCT',
          },
        ],
      };

      try {
        await Promise.resolve(builder.build(context, config));
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toMatch(/requires field/i);
      }
    });
  });

  describe('Numeric Aggregations', () => {
    it('should build SUM aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'total_price',
            function: 'SUM',
            field: 'price',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('SUM(price) AS total_price');
    });

    it('should build AVG aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'avg_price',
            function: 'AVG',
            field: 'price',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('AVG(price) AS avg_price');
    });

    it('should build MAX and MIN aggregations', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'max_price',
            function: 'MAX',
            field: 'price',
          },
          {
            name: 'min_price',
            function: 'MIN',
            field: 'price',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('MAX(price) AS max_price');
      expect(sql).toContain('MIN(price) AS min_price');
    });

    it('should build STDDEV aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'price_stddev',
            function: 'STDDEV',
            field: 'price',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('STDDEV(price) AS price_stddev');
    });

    it('should build VARIANCE aggregation', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'price_var',
            function: 'VARIANCE',
            field: 'price',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('VARIANCE(price) AS price_var');
    });
  });

  describe('String Aggregations', () => {
    it('should build STRING_AGG with default separator', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'all_names',
            function: 'STRING_AGG',
            field: 'name',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain("STRING_AGG(name, ', ') AS all_names");
    });

    it('should build STRING_AGG with custom separator', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'all_names',
            function: 'STRING_AGG',
            field: 'name',
            params: { separator: ' | ' },
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain("STRING_AGG(name, ' | ') AS all_names");
    });

    it('should build ARRAY_AGG', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'name_array',
            function: 'ARRAY_AGG',
            field: 'name',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('ARRAY_AGG(name) AS name_array');
    });

    it('should build ARRAY_AGG with ORDER BY', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'sorted_names',
            function: 'ARRAY_AGG',
            field: 'name',
            params: { orderBy: 'name' },
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('ARRAY_AGG(name ORDER BY name) AS sorted_names');
    });
  });

  describe('Multiple Group By Columns', () => {
    it('should group by multiple columns', async () => {
      const config: AggregateConfig = {
        groupBy: ['category', 'created_at'],
        measures: [
          {
            name: 'count',
            function: 'COUNT',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('SELECT category, created_at, COUNT(*) AS count');
      expect(sql).toContain('GROUP BY category, created_at');
    });
  });

  describe('Multiple Measures', () => {
    it('should build multiple aggregate measures', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'count',
            function: 'COUNT',
          },
          {
            name: 'total_price',
            function: 'SUM',
            field: 'price',
          },
          {
            name: 'avg_price',
            function: 'AVG',
            field: 'price',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('COUNT(*) AS count');
      expect(sql).toContain('SUM(price) AS total_price');
      expect(sql).toContain('AVG(price) AS avg_price');
    });
  });

  describe('HAVING Clause', () => {
    it('should build HAVING clause', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'count',
            function: 'COUNT',
          },
        ],
        having: {
          conditions: [
            {
              type: 'greater_than',
              field: 'count',
              value: 10,
            },
          ],
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('HAVING');
      expect(sql).toContain('count > 10');
    });

    it('should build HAVING with multiple conditions', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'total',
            function: 'SUM',
            field: 'price',
          },
        ],
        having: {
          conditions: [
            {
              type: 'greater_than',
              field: 'total',
              value: 1000,
            },
            {
              type: 'less_than',
              field: 'total',
              value: 10000,
            },
          ],
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('HAVING');
      expect(sql).toContain('total > 1000');
      expect(sql).toContain('total < 10000');
    });
  });

  describe('getResultColumns', () => {
    it('should return groupBy and measure columns', async () => {
      const config: AggregateConfig = {
        groupBy: ['category', 'created_at'],
        measures: [
          {
            name: 'count',
            function: 'COUNT',
          },
          {
            name: 'total_price',
            function: 'SUM',
            field: 'price',
          },
        ],
      };

      const resultColumns = await builder.getResultColumns(context, config);

      expect(resultColumns.size).toBe(4);
      expect(resultColumns.has('category')).toBe(true);
      expect(resultColumns.has('created_at')).toBe(true);
      expect(resultColumns.has('count')).toBe(true);
      expect(resultColumns.has('total_price')).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should throw error if groupBy is empty', async () => {
      const config: AggregateConfig = {
        groupBy: [],
        measures: [
          {
            name: 'count',
            function: 'COUNT',
          },
        ],
      };

      try {
        await Promise.resolve(builder.build(context, config));
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toMatch(/at least one groupBy field/i);
      }
    });

    it('should throw error if measures is empty', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [],
      };

      try {
        await Promise.resolve(builder.build(context, config));
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toMatch(/at least one measure/i);
      }
    });

    it('should throw error if measure name is missing', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: '',
            function: 'COUNT',
          } as any,
        ],
      };

      try {
        await Promise.resolve(builder.build(context, config));
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toMatch(/name is required/i);
      }
    });

    it('should throw error if measure function is missing', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'count',
          } as any,
        ],
      };

      try {
        await Promise.resolve(builder.build(context, config));
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toMatch(/function is required/i);
      }
    });

    it('should throw error for SUM without field', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'total',
            function: 'SUM',
          },
        ],
      };

      try {
        await Promise.resolve(builder.build(context, config));
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toMatch(/requires field/i);
      }
    });

    it('should throw error for unsupported function', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'result',
            function: 'UNKNOWN_FUNC' as any,
            field: 'price',
          },
        ],
      };

      try {
        await Promise.resolve(builder.build(context, config));
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toMatch(/unsupported/i);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle fields with special characters', async () => {
      context.availableColumns.add('product name');
      const config: AggregateConfig = {
        groupBy: ['product name'],
        measures: [
          {
            name: 'count',
            function: 'COUNT',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('"product name"');
      expect(sql).toContain('GROUP BY "product name"');
    });

    it('should handle measure names with special characters', async () => {
      const config: AggregateConfig = {
        groupBy: ['category'],
        measures: [
          {
            name: 'total price',
            function: 'SUM',
            field: 'price',
          },
        ],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('AS "total price"');
    });
  });
});
