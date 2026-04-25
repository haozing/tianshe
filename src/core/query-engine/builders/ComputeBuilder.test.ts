/**
 * ComputeBuilder 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ComputeBuilder } from './ComputeBuilder';
import type { ComputeConfig, SQLContext } from '../types';

describe('ComputeBuilder', () => {
  let builder: ComputeBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new ComputeBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'name', 'price', 'quantity', 'sale_price', 'age']),
    };
  });

  describe('Amount Calculation', () => {
    it('should build multiplication', () => {
      const config: ComputeConfig = [
        {
          name: 'total',
          type: 'amount',
          params: {
            priceField: 'price',
            quantityField: 'quantity',
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('(price::DOUBLE * quantity::DOUBLE) AS total');
    });

    it('should throw error if priceField is missing', () => {
      const config: ComputeConfig = [
        {
          name: 'total',
          type: 'amount',
          params: {
            quantityField: 'quantity',
          },
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });

    it('should throw error if quantityField is missing', () => {
      const config: ComputeConfig = [
        {
          name: 'total',
          type: 'amount',
          params: {
            priceField: 'price',
          },
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Discount Calculation', () => {
    it('should build percentage discount', () => {
      const config: ComputeConfig = [
        {
          name: 'discount_pct',
          type: 'discount',
          params: {
            originalPriceField: 'price',
            discountedPriceField: 'sale_price',
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CASE');
      expect(sql).toContain('WHEN price::DOUBLE = 0 THEN 0');
      expect(sql).toContain('((price::DOUBLE - sale_price::DOUBLE) / price::DOUBLE * 100)');
    });

    it('should build amount discount', () => {
      const config: ComputeConfig = [
        {
          name: 'discount_amt',
          type: 'discount',
          params: {
            originalPriceField: 'price',
            discountedPriceField: 'sale_price',
            discountType: 'amount',
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('(price::DOUBLE - sale_price::DOUBLE)');
    });

    it('should throw error if originalPriceField is missing', () => {
      const config: ComputeConfig = [
        {
          name: 'discount',
          type: 'discount',
          params: {
            discountedPriceField: 'sale_price',
          },
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Bucket Calculation', () => {
    it('should build age buckets', () => {
      const config: ComputeConfig = [
        {
          name: 'age_group',
          type: 'bucket',
          params: {
            field: 'age',
            boundaries: [18, 30, 50],
            labels: ['Young', 'Adult', 'Middle', 'Senior'],
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CASE');
      expect(sql).toContain("WHEN age::DOUBLE < 18 THEN 'Young'");
      expect(sql).toContain("WHEN age::DOUBLE >= 18 AND age::DOUBLE < 30 THEN 'Adult'");
      expect(sql).toContain("WHEN age::DOUBLE >= 50 THEN 'Senior'");
      expect(sql).toContain("ELSE 'Unknown'");
    });

    it('should generate default labels if not provided', () => {
      const config: ComputeConfig = [
        {
          name: 'group',
          type: 'bucket',
          params: {
            field: 'age',
            boundaries: [18],
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('Bucket');
    });

    it('should throw error if field is missing', () => {
      const config: ComputeConfig = [
        {
          name: 'group',
          type: 'bucket',
          params: {
            boundaries: [18],
          },
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });

    it('should throw error if boundaries is missing', () => {
      const config: ComputeConfig = [
        {
          name: 'group',
          type: 'bucket',
          params: {
            field: 'age',
          },
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Concat Calculation', () => {
    it('should build concat with separator', () => {
      const config: ComputeConfig = [
        {
          name: 'full_info',
          type: 'concat',
          params: {
            fields: ['id', 'name'],
            separator: ' - ',
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain("CONCAT_WS(' - '");
      expect(sql).toContain('COALESCE(CAST(id AS VARCHAR)');
      expect(sql).toContain('COALESCE(CAST(name AS VARCHAR)');
    });

    it('should use empty separator if not provided', () => {
      const config: ComputeConfig = [
        {
          name: 'combined',
          type: 'concat',
          params: {
            fields: ['id', 'name'],
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain("CONCAT_WS(''");
    });

    it('should throw error if fields is empty', () => {
      const config: ComputeConfig = [
        {
          name: 'result',
          type: 'concat',
          params: {
            fields: [],
          },
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });

    it('should throw error if fields is missing', () => {
      const config: ComputeConfig = [
        {
          name: 'result',
          type: 'concat',
          params: {},
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Custom Expression', () => {
    it('should build safe custom expression', () => {
      const config: ComputeConfig = [
        {
          name: 'custom_calc',
          type: 'custom',
          expression: 'price * 1.1 + 5',
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('price * 1.1 + 5 AS custom_calc');
    });

    it('should reject SQL injection - DROP', () => {
      const config: ComputeConfig = [
        {
          name: 'malicious',
          type: 'custom',
          expression: 'price; DROP TABLE users; --',
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/SQL injection/i);
    });

    it('should reject SQL injection - DELETE', () => {
      const config: ComputeConfig = [
        {
          name: 'malicious',
          type: 'custom',
          expression: 'price WHERE 1=1 DELETE FROM users',
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/dangerous keyword/i);
    });

    it('should reject SQL injection - TRUNCATE', () => {
      const config: ComputeConfig = [
        {
          name: 'malicious',
          type: 'custom',
          expression: 'TRUNCATE TABLE users',
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/dangerous keyword/i);
    });

    it('should reject SQL injection - comments', () => {
      const config: ComputeConfig = [
        {
          name: 'malicious',
          type: 'custom',
          expression: 'price -- DROP TABLE',
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/SQL injection/i);
    });

    it('should reject SQL injection - multiline comments', () => {
      const config: ComputeConfig = [
        {
          name: 'malicious',
          type: 'custom',
          expression: 'price /* DROP TABLE */',
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/SQL injection/i);
    });

    it('should reject overly long expressions', () => {
      const config: ComputeConfig = [
        {
          name: 'long',
          type: 'custom',
          expression: 'a'.repeat(1001),
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/too long/i);
    });

    it('should reject invalid characters', () => {
      const config: ComputeConfig = [
        {
          name: 'invalid',
          type: 'custom',
          expression: 'price $ quantity',
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/invalid characters/i);
    });

    it('should throw error if expression is missing', () => {
      const config: ComputeConfig = [
        {
          name: 'missing',
          type: 'custom',
          expression: '',
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Multiple Compute Columns', () => {
    it('should build multiple compute columns', () => {
      const config: ComputeConfig = [
        {
          name: 'total',
          type: 'amount',
          params: {
            priceField: 'price',
            quantityField: 'quantity',
          },
        },
        {
          name: 'discount_pct',
          type: 'discount',
          params: {
            originalPriceField: 'price',
            discountedPriceField: 'sale_price',
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('total');
      expect(sql).toContain('discount_pct');
      expect(sql).toContain('(price::DOUBLE * quantity::DOUBLE)');
      expect(sql).toContain('((price::DOUBLE - sale_price::DOUBLE) / price::DOUBLE * 100)');
    });
  });

  describe('Edge Cases', () => {
    it('should return SELECT * when config is empty', () => {
      const config: ComputeConfig = [];

      const sql = builder.build(context, config);
      expect(sql).toBe('SELECT * FROM test_table');
    });

    it('should handle fields with special characters', () => {
      context.availableColumns.add('user name');
      const config: ComputeConfig = [
        {
          name: 'combined',
          type: 'concat',
          params: {
            fields: ['user name', 'id'],
          },
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('"user name"');
    });

    it('should throw error for unsupported operation', () => {
      const config: ComputeConfig = [
        {
          name: 'result',
          type: 'unsupported_op' as any,
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('getResultColumns', () => {
    it('should include new computed columns', () => {
      const config: ComputeConfig = [
        {
          name: 'total',
          type: 'amount',
          params: {
            priceField: 'price',
            quantityField: 'quantity',
          },
        },
        {
          name: 'age_group',
          type: 'bucket',
          params: {
            field: 'age',
            boundaries: [18],
          },
        },
      ];

      const resultColumns = builder.getResultColumns(context, config);

      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.has('name')).toBe(true);
      expect(resultColumns.has('total')).toBe(true);
      expect(resultColumns.has('age_group')).toBe(true);
    });
  });
});
