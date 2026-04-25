/**
 * QueryEngine 综合测试
 * 测试各个Builder和完整查询流程
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryEngine } from './QueryEngine';
import type { QueryConfig } from './types';

// Mock DuckDBService
const mockDuckDBService = {
  getDatasetInfo: async (datasetId: string) => ({
    id: datasetId,
    name: 'Test Dataset',
    filePath: `/data/${datasetId}.db`,
    rowCount: 1000,
    columnCount: 5,
    sizeBytes: 10000,
    createdAt: Date.now(),
    schema: [
      { name: 'id', type: 'INTEGER' },
      { name: 'name', type: 'VARCHAR' },
      { name: 'email', type: 'VARCHAR' },
      { name: 'age', type: 'INTEGER' },
      { name: 'price', type: 'DOUBLE' },
      { name: 'quantity', type: 'INTEGER' },
      { name: 'deleted_at', type: 'TIMESTAMP' },
      { name: 'created_at', type: 'TIMESTAMP' },
    ],
  }),
  queryDataset: async (_datasetId: string, _sql: string) => ({
    columns: ['id', 'name', 'email'],
    rows: [
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
    ],
    rowCount: 2,
  }),
} as any;

describe('QueryEngine', () => {
  let queryEngine: QueryEngine;

  beforeEach(() => {
    queryEngine = new QueryEngine(mockDuckDBService);
  });

  describe('Filter Builder', () => {
    it('should build simple equal filter', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [{ type: 'equal', field: 'name', value: 'Alice' }],
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain("WHERE name = 'Alice'");
    });

    it('should build multiple filters with AND', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [
            { type: 'equal', field: 'name', value: 'Alice' },
            { type: 'greater_than', field: 'age', value: 25 },
          ],
          combinator: 'AND',
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain("name = 'Alice' AND age > 25");
    });

    it('should build regex filter with length limit', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [
            {
              type: 'regex',
              field: 'email',
              value: '^[a-z]+@example\\.com$',
              options: { regexMaxLength: 100, regexTimeout: 5000 },
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('regexp_matches');
      expect(sql).toContain('LENGTH(email) > 100');
    });

    it('should build soft delete filter', async () => {
      // 软删除现在是视图级配置，不是 filter 条件类型
      // 使用 softDelete 配置来过滤软删除的记录
      const config: QueryConfig = {
        softDelete: {
          field: 'deleted_at',
          show: 'active', // 只显示活跃记录（未删除）
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      // 软删除配置会生成 WHERE "deleted_at" IS NULL 条件（字段名会被转义）
      expect(sql).toContain('"deleted_at" IS NULL');
    });

    it('should build relative time filter', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [
            {
              type: 'relative_time',
              field: 'created_at',
              options: {
                relativeTimeUnit: 'day',
                relativeTimeValue: 7,
                relativeTimeDirection: 'past',
              },
            },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain("INTERVAL '7 day'");
      expect(sql).toContain('CURRENT_TIMESTAMP');
    });
  });

  describe('Column Builder', () => {
    it('should select specific columns', async () => {
      const config: QueryConfig = {
        columns: {
          select: ['id', 'name', 'email'],
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('SELECT id, name, email');
    });

    it('should rename columns', async () => {
      const config: QueryConfig = {
        columns: {
          select: ['id', 'name'],
          rename: { name: 'full_name' },
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('name AS full_name');
    });

    it('should hide columns', async () => {
      const config: QueryConfig = {
        columns: {
          hide: ['email'],
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).not.toContain('email');
    });
  });

  describe('Sort Builder', () => {
    it('should build single column sort', async () => {
      const config: QueryConfig = {
        sort: {
          columns: [{ field: 'name', direction: 'ASC' }],
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('ORDER BY name ASC');
    });

    it('should build multi-column sort', async () => {
      const config: QueryConfig = {
        sort: {
          columns: [
            { field: 'age', direction: 'DESC' },
            { field: 'name', direction: 'ASC' },
          ],
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('ORDER BY age DESC');
      expect(sql).toContain('name ASC');
    });

    it('should build TopK query', async () => {
      const config: QueryConfig = {
        sort: {
          columns: [{ field: 'age', direction: 'DESC' }],
          topK: 10,
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('LIMIT 10');
    });

    it('should build pagination query', async () => {
      const config: QueryConfig = {
        sort: {
          columns: [{ field: 'id', direction: 'ASC' }],
          pagination: { page: 2, pageSize: 20 },
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('LIMIT 20 OFFSET 20');
    });
  });

  describe('Clean Builder', () => {
    // 注意：CleanBuilder 会自动添加 CAST(field AS VARCHAR) 确保类型安全
    it('should build trim operation', async () => {
      const config: QueryConfig = {
        clean: [
          {
            field: 'name',
            operations: [{ type: 'trim' }],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      // CleanBuilder 会自动添加 CAST 确保类型安全
      expect(sql).toContain('TRIM(CAST(name AS VARCHAR))');
    });

    it('should build case conversion', async () => {
      const config: QueryConfig = {
        clean: [
          {
            field: 'email',
            operations: [{ type: 'lower' }],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      // CleanBuilder 会自动添加 CAST 确保类型安全
      expect(sql).toContain('LOWER(CAST(email AS VARCHAR))');
    });

    it('should build replace operation', async () => {
      const config: QueryConfig = {
        clean: [
          {
            field: 'name',
            operations: [
              {
                type: 'replace',
                params: { search: 'Mr.', replaceWith: 'Mr' },
              },
            ],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      // CleanBuilder 会自动添加 CAST 确保类型安全
      expect(sql).toContain("REPLACE(CAST(name AS VARCHAR), 'Mr.', 'Mr')");
    });

    it('should chain multiple clean operations', async () => {
      const config: QueryConfig = {
        clean: [
          {
            field: 'name',
            operations: [{ type: 'trim' }, { type: 'upper' }],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      // 链式操作：外层 UPPER(内层 TRIM(原始值转 VARCHAR))
      expect(sql).toContain('UPPER(CAST(TRIM(CAST(name AS VARCHAR)) AS VARCHAR))');
    });
  });

  describe('Compute Builder', () => {
    it('should build amount calculation', async () => {
      const config: QueryConfig = {
        compute: [
          {
            name: 'total',
            type: 'amount',
            params: { priceField: 'price', quantityField: 'quantity' },
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('price::DOUBLE * quantity::DOUBLE');
      expect(sql).toContain('AS total');
    });

    it('should build discount calculation', async () => {
      const config: QueryConfig = {
        compute: [
          {
            name: 'discount_pct',
            type: 'discount',
            params: {
              originalPriceField: 'price',
              discountedPriceField: 'sale_price',
              discountType: 'percentage',
            },
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('discount_pct');
    });

    it('should build bucket calculation', async () => {
      const config: QueryConfig = {
        compute: [
          {
            name: 'age_group',
            type: 'bucket',
            params: {
              field: 'age',
              boundaries: [18, 30, 50],
              labels: ['Young', 'Adult', 'Middle', 'Senior'],
            },
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('CASE');
      expect(sql).toContain('age_group');
    });

    it('should build concat calculation', async () => {
      const config: QueryConfig = {
        compute: [
          {
            name: 'full_info',
            type: 'concat',
            params: {
              fields: ['id', 'name', 'email'],
              separator: ' - ',
            },
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('CONCAT_WS');
      expect(sql).toContain('full_info');
    });

    it('should build custom expression', async () => {
      const config: QueryConfig = {
        compute: [
          {
            name: 'custom_calc',
            type: 'custom',
            expression: 'price * 1.1 + 5',
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('price * 1.1 + 5');
      expect(sql).toContain('AS custom_calc');
    });
  });

  describe('Dedupe Builder', () => {
    it('should build ROW_NUMBER dedupe', async () => {
      const config: QueryConfig = {
        dedupe: {
          type: 'row_number',
          partitionBy: ['email'],
          orderBy: [{ field: 'created_at', direction: 'ASC' }],
          keepStrategy: 'first',
        },
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('ROW_NUMBER()');
      expect(sql).toContain('PARTITION BY email');
      expect(sql).toContain('WHERE _rn = 1');
    });
  });

  describe('Validation Builder', () => {
    it('should build is_numeric validation', async () => {
      const config: QueryConfig = {
        validation: [
          {
            field: 'age',
            rules: [
              {
                type: 'is_numeric',
                action: 'filter',
              },
            ],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('TRY_CAST(age AS DOUBLE) IS NOT NULL');
    });

    it('should build enum validation', async () => {
      const config: QueryConfig = {
        validation: [
          {
            field: 'status',
            rules: [
              {
                type: 'enum',
                params: { allowedValues: ['active', 'inactive', 'pending'] },
                action: 'filter',
              },
            ],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain("'active', 'inactive', 'pending'");
    });

    it('should build range validation', async () => {
      const config: QueryConfig = {
        validation: [
          {
            field: 'age',
            rules: [
              {
                type: 'range',
                params: { min: 18, max: 65 },
                action: 'filter',
              },
            ],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('age::DOUBLE >= 18');
      expect(sql).toContain('age::DOUBLE <= 65');
    });

    it('should build mark validation', async () => {
      const config: QueryConfig = {
        validation: [
          {
            field: 'email',
            rules: [
              {
                type: 'is_email',
                action: 'mark',
                markColumn: 'email_valid',
              },
            ],
          },
        ],
      };

      const sql = await queryEngine.buildSQL('test', config);
      expect(sql).toContain('email_valid');
    });
  });

  describe('Comprehensive Query', () => {
    it('should build complex query with multiple operations', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [
            { type: 'greater_than', field: 'age', value: 18 },
            { type: 'not_null', field: 'email' },
          ],
          combinator: 'AND',
        },
        clean: [
          {
            field: 'name',
            operations: [{ type: 'trim' }, { type: 'upper' }],
          },
        ],
        compute: [
          {
            name: 'total',
            type: 'amount',
            params: { priceField: 'price', quantityField: 'quantity' },
          },
        ],
        columns: {
          select: ['id', 'name', 'email', 'total'],
        },
        sort: {
          columns: [{ field: 'total', direction: 'DESC' }],
          topK: 10,
        },
      };

      const sql = await queryEngine.buildSQL('test', config);

      // 验证包含所有操作
      expect(sql).toContain('WITH');
      expect(sql).toContain('filtered AS');
      expect(sql).toContain('cleaned AS');
      expect(sql).toContain('computed AS');
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('LIMIT 10');
    });
  });

  describe('Config Validation', () => {
    it('should validate correct config', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [{ type: 'equal', field: 'name', value: 'Test' }],
        },
      };

      const result = await queryEngine.validateConfig('test', config);
      expect(result.success).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should detect non-existent fields', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [{ type: 'equal', field: 'nonexistent_field', value: 'Test' }],
        },
      };

      const result = await queryEngine.validateConfig('test', config);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('does not exist');
    });
  });

  describe('SQL Preview', () => {
    it('should preview SQL without executing', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [{ type: 'equal', field: 'name', value: 'Alice' }],
        },
      };

      const result = await queryEngine.previewSQL('test', config);
      expect(result.success).toBe(true);
      expect(result.sql).toBeDefined();
      expect(result.sql).toContain("name = 'Alice'");
    });
  });

  describe('Execute Query', () => {
    it('should execute query and return results', async () => {
      const config: QueryConfig = {
        filter: {
          conditions: [{ type: 'equal', field: 'name', value: 'Alice' }],
        },
      };

      const result = await queryEngine.execute('test', config);
      expect(result.success).toBe(true);
      expect(result.rows).toBeDefined();
      expect(result.rowCount).toBe(2);
      expect(result.generatedSQL).toBeDefined();
    });
  });
});
