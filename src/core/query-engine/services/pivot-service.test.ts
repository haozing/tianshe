/**
 * PivotService 单元测试
 *
 * 测试重点：
 * - Pivot 操作（行转列）
 * - Unpivot 操作（列转行）
 * - 配置验证
 * - 临时视图管理
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PivotService, PivotConfig, UnpivotConfig } from './pivot-service';

// Mock DuckDBService
const createMockDuckDBService = () => ({
  execute: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockImplementation((sql: string) => {
    // 模拟返回透视列的唯一值
    if (sql.includes('SELECT DISTINCT')) {
      return Promise.resolve([{ month: 'Jan' }, { month: 'Feb' }, { month: 'Mar' }]);
    }
    return Promise.resolve([]);
  }),
  getDatasetInfo: vi.fn().mockResolvedValue({
    id: 'test_dataset',
    schema: [
      { name: 'product_id', type: 'INTEGER' },
      { name: 'product_name', type: 'VARCHAR' },
      { name: 'month', type: 'VARCHAR' },
      { name: 'revenue', type: 'DOUBLE' },
      { name: 'quantity', type: 'INTEGER' },
      { name: 'Q1_sales', type: 'DOUBLE' },
      { name: 'Q2_sales', type: 'DOUBLE' },
      { name: 'Q3_sales', type: 'DOUBLE' },
      { name: 'Q4_sales', type: 'DOUBLE' },
    ],
  }),
});

// Mock console
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('PivotService', () => {
  let pivotService: PivotService;
  let mockDuckDB: ReturnType<typeof createMockDuckDBService>;

  beforeEach(() => {
    mockDuckDB = createMockDuckDBService();
    pivotService = new PivotService(mockDuckDB as any);
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  // ========== Pivot 操作 ==========
  describe('pivot', () => {
    describe('基本功能', () => {
      it('应该成功执行 pivot 操作', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id', 'product_name'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.success).toBe(true);
        expect(result.datasetId).toBeDefined();
        expect(result.executionTime).toBeGreaterThanOrEqual(0);
      });

      it('应该创建临时视图', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        await pivotService.pivot('test_dataset', config);

        expect(mockDuckDB.execute).toHaveBeenCalledWith(
          expect.stringContaining('CREATE OR REPLACE TEMPORARY VIEW')
        );
      });

      it('应该使用自定义视图名称', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
          viewName: 'my_pivot_view',
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.datasetId).toBe('my_pivot_view');
      });

      it('应该返回正确的结果列', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id', 'product_name'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.columns).toBeDefined();
        expect(result.columns).toContain('product_id');
        expect(result.columns).toContain('product_name');
        // 透视后的列：revenue_jan, revenue_feb, revenue_mar
        expect(result.columns).toContain('revenue_jan');
        expect(result.columns).toContain('revenue_feb');
        expect(result.columns).toContain('revenue_mar');
      });

      it('应该支持多个值列', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: 'month',
          valueColumns: ['revenue', 'quantity'],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.columns).toContain('revenue_jan');
        expect(result.columns).toContain('quantity_jan');
      });

      it('应该使用指定的聚合函数', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
          aggregateFunction: 'SUM',
        };

        await pivotService.pivot('test_dataset', config);

        expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('SUM('));
      });

      it('默认使用 FIRST 聚合函数', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        await pivotService.pivot('test_dataset', config);

        expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('FIRST('));
      });
    });

    describe('配置验证', () => {
      it('没有 indexColumns 应该返回错误', async () => {
        const config: PivotConfig = {
          indexColumns: [],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('at least one index column');
      });

      it('没有 pivotColumn 应该返回错误', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: '',
          valueColumns: ['revenue'],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('pivot column');
      });

      it('没有 valueColumns 应该返回错误', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: 'month',
          valueColumns: [],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('at least one value column');
      });

      it('列名重复应该返回错误', async () => {
        const config: PivotConfig = {
          indexColumns: ['product_id', 'month'], // month 重复
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('unique');
      });

      it('列不存在应该返回错误', async () => {
        const config: PivotConfig = {
          indexColumns: ['nonexistent_col'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        const result = await pivotService.pivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('数据集不存在应该返回错误', async () => {
        mockDuckDB.getDatasetInfo.mockResolvedValueOnce(null);

        const config: PivotConfig = {
          indexColumns: ['product_id'],
          pivotColumn: 'month',
          valueColumns: ['revenue'],
        };

        const result = await pivotService.pivot('nonexistent', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });
    });
  });

  // ========== Unpivot 操作 ==========
  describe('unpivot', () => {
    describe('基本功能', () => {
      it('应该成功执行 unpivot 操作', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id'],
          unpivotColumns: ['Q1_sales', 'Q2_sales', 'Q3_sales', 'Q4_sales'],
          variableColumnName: 'quarter',
          valueColumnName: 'sales',
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.success).toBe(true);
        expect(result.datasetId).toBeDefined();
      });

      it('应该创建临时视图', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id'],
          unpivotColumns: ['Q1_sales', 'Q2_sales'],
        };

        await pivotService.unpivot('test_dataset', config);

        expect(mockDuckDB.execute).toHaveBeenCalledWith(
          expect.stringContaining('CREATE OR REPLACE TEMPORARY VIEW')
        );
      });

      it('应该使用 UNION ALL 实现 unpivot', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id'],
          unpivotColumns: ['Q1_sales', 'Q2_sales'],
        };

        await pivotService.unpivot('test_dataset', config);

        expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('UNION ALL'));
      });

      it('应该返回正确的结果列', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id', 'product_name'],
          unpivotColumns: ['Q1_sales', 'Q2_sales'],
          variableColumnName: 'quarter',
          valueColumnName: 'sales',
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.columns).toContain('product_id');
        expect(result.columns).toContain('product_name');
        expect(result.columns).toContain('quarter');
        expect(result.columns).toContain('sales');
      });

      it('应该使用默认的变量列和值列名称', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id'],
          unpivotColumns: ['Q1_sales', 'Q2_sales'],
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.columns).toContain('variable');
        expect(result.columns).toContain('value');
      });

      it('应该使用自定义视图名称', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id'],
          unpivotColumns: ['Q1_sales'],
          viewName: 'my_unpivot_view',
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.datasetId).toBe('my_unpivot_view');
      });
    });

    describe('配置验证', () => {
      it('没有 keepColumns 应该返回错误', async () => {
        const config: UnpivotConfig = {
          keepColumns: [],
          unpivotColumns: ['Q1_sales'],
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('at least one keep column');
      });

      it('没有 unpivotColumns 应该返回错误', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id'],
          unpivotColumns: [],
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('at least one unpivot column');
      });

      it('keepColumns 和 unpivotColumns 重叠应该返回错误', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['product_id', 'Q1_sales'],
          unpivotColumns: ['Q1_sales', 'Q2_sales'],
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('unique');
      });

      it('列不存在应该返回错误', async () => {
        const config: UnpivotConfig = {
          keepColumns: ['nonexistent'],
          unpivotColumns: ['Q1_sales'],
        };

        const result = await pivotService.unpivot('test_dataset', config);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });
    });
  });

  // ========== 删除视图 ==========
  describe('dropView', () => {
    it('应该删除临时视图', async () => {
      await pivotService.dropView('test_view');

      expect(mockDuckDB.execute).toHaveBeenCalledWith(
        expect.stringContaining('DROP VIEW IF EXISTS')
      );
    });

    it('删除失败应该抛出错误', async () => {
      mockDuckDB.execute.mockRejectedValueOnce(new Error('Drop failed'));

      await expect(pivotService.dropView('test_view')).rejects.toThrow('Drop failed');
    });
  });

  // ========== 错误处理 ==========
  describe('错误处理', () => {
    it('pivot 执行错误应该返回失败结果', async () => {
      mockDuckDB.execute.mockRejectedValueOnce(new Error('Execute error'));

      const config: PivotConfig = {
        indexColumns: ['product_id'],
        pivotColumn: 'month',
        valueColumns: ['revenue'],
      };

      const result = await pivotService.pivot('test_dataset', config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Execute error');
    });

    it('unpivot 执行错误应该返回失败结果', async () => {
      mockDuckDB.execute.mockRejectedValueOnce(new Error('Execute error'));

      const config: UnpivotConfig = {
        keepColumns: ['product_id'],
        unpivotColumns: ['Q1_sales'],
      };

      const result = await pivotService.unpivot('test_dataset', config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Execute error');
    });

    it('错误情况下应该记录执行时间', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValueOnce(null);

      const config: PivotConfig = {
        indexColumns: ['product_id'],
        pivotColumn: 'month',
        valueColumns: ['revenue'],
      };

      const result = await pivotService.pivot('test_dataset', config);

      expect(result.executionTime).toBeDefined();
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  // ========== 列名清理 ==========
  describe('列名清理', () => {
    it('应该清理透视值中的特殊字符', async () => {
      // 模拟返回包含特殊字符的透视值
      mockDuckDB.query.mockResolvedValueOnce([
        { month: 'Jan 2024' },
        { month: 'Feb-2024' },
        { month: 'Mar/2024' },
      ]);

      const config: PivotConfig = {
        indexColumns: ['product_id'],
        pivotColumn: 'month',
        valueColumns: ['revenue'],
      };

      const result = await pivotService.pivot('test_dataset', config);

      // 特殊字符应该被替换为下划线
      expect(result.columns).toContain('revenue_jan_2024');
      expect(result.columns).toContain('revenue_feb_2024');
      expect(result.columns).toContain('revenue_mar_2024');
    });
  });
});
