/**
 * DatasetMerger 单元测试
 *
 * 测试重点：
 * - 数据集合并 (union/union_all)
 * - 列映射
 * - 默认值填充
 * - 配置验证
 * - 临时视图管理
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatasetMerger, UnionConfig } from './dataset-merger';

// Mock DuckDBService
const createMockDuckDBService = () => ({
  execute: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  getDatasetInfo: vi.fn().mockImplementation((datasetId: string) => {
    // 根据 datasetId 返回不同的 schema
    const schemas: Record<string, any> = {
      dataset1: {
        id: 'dataset1',
        schema: [
          { name: 'id', type: 'INTEGER' },
          { name: 'name', type: 'VARCHAR' },
          { name: 'amount', type: 'DOUBLE' },
        ],
      },
      dataset2: {
        id: 'dataset2',
        schema: [
          { name: 'id', type: 'INTEGER' },
          { name: 'customer_name', type: 'VARCHAR' },
          { name: 'revenue', type: 'DOUBLE' },
        ],
      },
      dataset3: {
        id: 'dataset3',
        schema: [
          { name: 'id', type: 'INTEGER' },
          { name: 'name', type: 'VARCHAR' },
          { name: 'amount', type: 'DOUBLE' },
          { name: 'region', type: 'VARCHAR' },
        ],
      },
    };
    return Promise.resolve(schemas[datasetId] || null);
  }),
});

// Mock console
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('DatasetMerger', () => {
  let merger: DatasetMerger;
  let mockDuckDB: ReturnType<typeof createMockDuckDBService>;

  beforeEach(() => {
    mockDuckDB = createMockDuckDBService();
    merger = new DatasetMerger(mockDuckDB as any);
    consoleLogSpy.mockClear();
    consoleWarnSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  // ========== 基本合并 ==========
  describe('基本合并', () => {
    it('应该成功合并两个数据集', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(true);
      expect(result.datasetId).toBeDefined();
      expect(result.sourceCount).toBe(2);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('应该创建临时视图', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
      };

      await merger.mergeDatasets(config);

      expect(mockDuckDB.execute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE OR REPLACE TEMPORARY VIEW')
      );
    });

    it('应该使用 UNION ALL 模式', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
      };

      await merger.mergeDatasets(config);

      expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('UNION ALL'));
    });

    it('应该使用 UNION 模式（去重）', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union',
      };

      await merger.mergeDatasets(config);

      const executeCalls = mockDuckDB.execute.mock.calls;
      const unionCall = executeCalls.find(
        (call: any) => call[0].includes('UNION') && !call[0].includes('UNION ALL')
      );
      expect(unionCall).toBeDefined();
    });

    it('应该返回合并后的列列表', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.columns).toBeDefined();
      expect(result.columns).toContain('id');
      expect(result.columns).toContain('name');
      expect(result.columns).toContain('amount');
    });
  });

  // ========== 列映射 ==========
  describe('列映射', () => {
    it('应该应用列映射', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset2' }],
        mode: 'union_all',
        columnMapping: {
          dataset2: {
            customer_name: 'name',
            revenue: 'amount',
          },
        },
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(true);
      // 映射后的列应该是统一的
      expect(result.columns).toContain('name');
      expect(result.columns).toContain('amount');
    });
  });

  // ========== 默认值填充 ==========
  describe('默认值填充', () => {
    it('应该使用 fillDefaults 填充缺失列', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
        fillDefaults: {
          region: 'Unknown',
        },
      };

      await merger.mergeDatasets(config);

      // dataset1 没有 region 列，应该填充默认值
      expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining("'Unknown'"));
    });

    it('没有默认值时应该填充 NULL', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
      };

      await merger.mergeDatasets(config);

      // dataset1 没有 region 列，应该填充 NULL
      expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('NULL AS'));
    });
  });

  // ========== 自定义视图名称 ==========
  describe('自定义视图名称', () => {
    it('应该使用自定义视图名称', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
        viewName: 'my_custom_view',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.datasetId).toBe('my_custom_view');
      // 视图名可能带引号也可能不带
      expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('my_custom_view'));
    });
  });

  // ========== 配置验证 ==========
  describe('配置验证', () => {
    it('没有数据集应该返回错误', async () => {
      const config: UnionConfig = {
        datasets: [],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one dataset');
    });

    it('只有一个数据集应该警告', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }],
        mode: 'union_all',
      };

      await merger.mergeDatasets(config);

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Only one dataset'));
    });

    it('缺少 datasetId 应该返回错误', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: '' }],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('datasetId is required');
    });

    it('无效的 mode 应该返回错误', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'invalid' as any,
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid union mode');
    });

    it('不存在的数据集应该返回错误', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValueOnce(null);

      const config: UnionConfig = {
        datasets: [{ datasetId: 'nonexistent' }, { datasetId: 'dataset1' }],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('未知数据集的列映射应该警告', async () => {
      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
        columnMapping: {
          unknown_dataset: { col1: 'col2' },
        },
      };

      await merger.mergeDatasets(config);

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown dataset'));
    });
  });

  // ========== 删除视图 ==========
  describe('dropView', () => {
    it('应该删除临时视图', async () => {
      await merger.dropView('test_view');

      expect(mockDuckDB.execute).toHaveBeenCalledWith(
        expect.stringContaining('DROP VIEW IF EXISTS')
      );
      // 视图名可能带引号也可能不带
      expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('test_view'));
    });

    it('删除失败应该抛出错误', async () => {
      mockDuckDB.execute.mockRejectedValueOnce(new Error('Drop failed'));

      await expect(merger.dropView('test_view')).rejects.toThrow('Drop failed');
    });
  });

  // ========== 错误处理 ==========
  describe('错误处理', () => {
    it('getDatasetInfo 错误应该返回失败结果', async () => {
      mockDuckDB.getDatasetInfo.mockRejectedValueOnce(new Error('DB error'));

      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('DB error');
    });

    it('execute 错误应该返回失败结果', async () => {
      mockDuckDB.execute.mockRejectedValueOnce(new Error('Execute error'));

      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }, { datasetId: 'dataset3' }],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Execute error');
    });

    it('错误情况下应该记录执行时间', async () => {
      mockDuckDB.getDatasetInfo.mockRejectedValueOnce(new Error('Error'));

      const config: UnionConfig = {
        datasets: [{ datasetId: 'dataset1' }],
        mode: 'union_all',
      };

      const result = await merger.mergeDatasets(config);

      expect(result.executionTime).toBeDefined();
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  // ========== 边界情况 ==========
  describe('边界情况', () => {
    it('应该正确处理特殊字符的列名', async () => {
      mockDuckDB.getDatasetInfo.mockResolvedValueOnce({
        id: 'special',
        schema: [{ name: 'user name', type: 'VARCHAR' }],
      });

      const config: UnionConfig = {
        datasets: [{ datasetId: 'special' }],
        mode: 'union_all',
      };

      await merger.mergeDatasets(config);

      // 应该转义列名
      expect(mockDuckDB.execute).toHaveBeenCalledWith(expect.stringContaining('"user name"'));
    });
  });
});
