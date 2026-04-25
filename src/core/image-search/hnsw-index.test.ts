/**
 * HNSWIndex 单元测试
 *
 * 测试 HNSW 向量索引的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HNSWIndex } from './hnsw-index';

// Mock hnswlib-node
const mockAddPoint = vi.fn();
const mockSearchKnn = vi.fn();
const mockSetEf = vi.fn();
const mockInitIndex = vi.fn();
const mockWriteIndexSync = vi.fn();
const mockReadIndexSync = vi.fn();
const mockGetPoint = vi.fn();

class MockHierarchicalNSW {
  addPoint = mockAddPoint;
  searchKnn = mockSearchKnn;
  setEf = mockSetEf;
  initIndex = mockInitIndex;
  writeIndexSync = mockWriteIndexSync;
  readIndexSync = mockReadIndexSync;
  getPoint = mockGetPoint;
}

vi.mock('../utils/dynamic-import', () => ({
  dynamicImport: vi.fn().mockImplementation(async (moduleName: string) => {
    if (moduleName === 'hnswlib-node') {
      return {
        HierarchicalNSW: MockHierarchicalNSW,
      };
    }
    throw new Error(`Unexpected module: ${moduleName}`);
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(
      JSON.stringify({
        config: { spaceType: 'cosine', dim: 128, maxElements: 1000, M: 16, efConstruction: 200 },
        nextInternalId: 2,
        entries: [
          { templateId: 'template1', internalId: 0, template: { id: 'template1', addedAt: 1000 } },
          { templateId: 'template2', internalId: 1, template: { id: 'template2', addedAt: 2000 } },
        ],
      })
    ),
  };
});

// Mock l2Normalize
vi.mock('../onnx-runtime', () => ({
  l2Normalize: vi.fn((vec: number[]) => {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map((v) => v / norm);
  }),
}));

describe('HNSWIndex', () => {
  let index: HNSWIndex;

  beforeEach(() => {
    vi.clearAllMocks();
    index = new HNSWIndex({
      spaceType: 'cosine',
      dim: 128,
      maxElements: 1000,
    });

    // 默认搜索返回空结果
    mockSearchKnn.mockReturnValue({ neighbors: [], distances: [] });
  });

  afterEach(() => {
    index.dispose();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await index.initialize();

      expect(mockInitIndex).toHaveBeenCalledWith(1000, 16, 200, 100);
    });

    it('should only initialize once', async () => {
      await index.initialize();
      await index.initialize();

      expect(mockInitIndex).toHaveBeenCalledTimes(1);
    });

    it('should use custom M and efConstruction', async () => {
      const customIndex = new HNSWIndex({
        spaceType: 'l2',
        dim: 256,
        maxElements: 5000,
        M: 32,
        efConstruction: 400,
      });

      await customIndex.initialize();

      expect(mockInitIndex).toHaveBeenCalledWith(5000, 32, 400, 100);
      customIndex.dispose();
    });

    it('should throw error if module not found', async () => {
      const { dynamicImport } = await import('../utils/dynamic-import');
      vi.mocked(dynamicImport).mockRejectedValueOnce(
        Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })
      );

      const newIndex = new HNSWIndex({ spaceType: 'cosine', dim: 128, maxElements: 100 });
      await expect(newIndex.initialize()).rejects.toThrow('hnswlib-node is required');
    });
  });

  describe('add', () => {
    beforeEach(async () => {
      await index.initialize();
    });

    it('should add vector successfully', async () => {
      const vector = new Array(128).fill(0.1);

      await index.add('template1', vector);

      expect(mockAddPoint).toHaveBeenCalled();
      expect(index.hasTemplate('template1')).toBe(true);
    });

    it('should store template info', async () => {
      const vector = new Array(128).fill(0.1);

      await index.add('template1', vector, {
        name: 'Test Template',
        metadata: { category: 'button' },
      });

      const template = index.getTemplate('template1');
      expect(template).toBeDefined();
      expect(template!.name).toBe('Test Template');
      expect(template!.metadata).toEqual({ category: 'button' });
      expect(template!.addedAt).toBeDefined();
    });

    it('should update existing template', async () => {
      const vector1 = new Array(128).fill(0.1);
      const vector2 = new Array(128).fill(0.2);

      await index.add('template1', vector1, { name: 'Version 1' });
      await index.add('template1', vector2, { name: 'Version 2' });

      const template = index.getTemplate('template1');
      expect(template!.name).toBe('Version 2');
    });

    it('should throw error for dimension mismatch', async () => {
      const wrongVector = new Array(64).fill(0.1);

      await expect(index.add('template1', wrongVector)).rejects.toThrow(
        'Vector dimension mismatch'
      );
    });

    it('should throw error if not initialized', async () => {
      const newIndex = new HNSWIndex({ spaceType: 'cosine', dim: 128, maxElements: 100 });
      const vector = new Array(128).fill(0.1);

      await expect(newIndex.add('template1', vector)).rejects.toThrow('not initialized');
    });
  });

  describe('addBatch', () => {
    beforeEach(async () => {
      await index.initialize();
    });

    it('should add multiple vectors', async () => {
      const items = [
        { id: 'template1', vector: new Array(128).fill(0.1) },
        { id: 'template2', vector: new Array(128).fill(0.2) },
        { id: 'template3', vector: new Array(128).fill(0.3) },
      ];

      const result = await index.addBatch(items);

      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle partial failures', async () => {
      const items = [
        { id: 'template1', vector: new Array(128).fill(0.1) },
        { id: 'template2', vector: new Array(64).fill(0.2) }, // Wrong dimension
        { id: 'template3', vector: new Array(128).fill(0.3) },
      ];

      const result = await index.addBatch(items);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors[0].id).toBe('template2');
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await index.initialize();

      // 添加测试数据
      await index.add('template1', new Array(128).fill(0.1));
      await index.add('template2', new Array(128).fill(0.2));
      await index.add('template3', new Array(128).fill(0.3));
    });

    it('should search and return results', async () => {
      mockSearchKnn.mockReturnValue({
        neighbors: [0, 1, 2],
        distances: [0.1, 0.2, 0.3], // cosine distance
      });

      const query = new Array(128).fill(0.15);
      const results = await index.search(query, { topK: 3 });

      expect(mockSetEf).toHaveBeenCalled();
      expect(mockSearchKnn).toHaveBeenCalled();
      expect(results).toHaveLength(3);
      expect(results[0].templateId).toBe('template1');
      expect(results[0].similarity).toBeCloseTo(0.9); // 1 - 0.1
    });

    it('should respect topK option', async () => {
      mockSearchKnn.mockReturnValue({
        neighbors: [0, 1],
        distances: [0.1, 0.2],
      });

      const query = new Array(128).fill(0.15);
      const results = await index.search(query, { topK: 2 });

      expect(results).toHaveLength(2);
    });

    it('should filter by threshold', async () => {
      mockSearchKnn.mockReturnValue({
        neighbors: [0, 1, 2],
        distances: [0.1, 0.4, 0.8],
      });

      const query = new Array(128).fill(0.15);
      const results = await index.search(query, { topK: 3, threshold: 0.5 });

      expect(results).toHaveLength(2); // Only first two pass threshold
    });

    it('should set efSearch parameter', async () => {
      mockSearchKnn.mockReturnValue({ neighbors: [], distances: [] });

      const query = new Array(128).fill(0.15);
      await index.search(query, { efSearch: 100 });

      expect(mockSetEf).toHaveBeenCalledWith(100);
    });

    it('should throw error for wrong query dimension', async () => {
      const wrongQuery = new Array(64).fill(0.15);

      await expect(index.search(wrongQuery)).rejects.toThrow('dimension mismatch');
    });

    it('should skip removed templates', async () => {
      await index.remove('template2');

      mockSearchKnn.mockReturnValue({
        neighbors: [0, 1, 2], // internal IDs, template2 (id=1) is removed
        distances: [0.1, 0.2, 0.3],
      });

      const query = new Array(128).fill(0.15);
      const results = await index.search(query, { topK: 3 });

      expect(results.some((r) => r.templateId === 'template2')).toBe(false);
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await index.initialize();
      await index.add('template1', new Array(128).fill(0.1));
    });

    it('should remove template from mapping', async () => {
      const result = await index.remove('template1');

      expect(result).toBe(true);
      expect(index.hasTemplate('template1')).toBe(false);
    });

    it('should return false for non-existent template', async () => {
      const result = await index.remove('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await index.initialize();
    });

    it('should return correct stats', async () => {
      await index.add('template1', new Array(128).fill(0.1));
      await index.add('template2', new Array(128).fill(0.2));

      const stats = index.getStats();

      expect(stats.count).toBe(2);
      expect(stats.maxElements).toBe(1000);
      expect(stats.dim).toBe(128);
      expect(stats.spaceType).toBe('cosine');
    });
  });

  describe('getTemplateIds', () => {
    beforeEach(async () => {
      await index.initialize();
    });

    it('should return all template IDs', async () => {
      await index.add('template1', new Array(128).fill(0.1));
      await index.add('template2', new Array(128).fill(0.2));

      const ids = index.getTemplateIds();

      expect(ids).toContain('template1');
      expect(ids).toContain('template2');
      expect(ids).toHaveLength(2);
    });
  });

  describe('clear', () => {
    beforeEach(async () => {
      await index.initialize();
      await index.add('template1', new Array(128).fill(0.1));
      await index.add('template2', new Array(128).fill(0.2));
    });

    it('should clear all templates', async () => {
      await index.clear();

      expect(index.getStats().count).toBe(0);
      expect(index.getTemplateIds()).toHaveLength(0);
    });

    it('should reinitialize the index', async () => {
      await index.clear();

      // 应该能够重新添加
      await index.add('newTemplate', new Array(128).fill(0.5));
      expect(index.hasTemplate('newTemplate')).toBe(true);
    });
  });

  describe('getDeletionRatio', () => {
    beforeEach(async () => {
      await index.initialize();
    });

    it('should return 0 for empty index', () => {
      expect(index.getDeletionRatio()).toBe(0);
    });

    it('should calculate deletion ratio correctly', async () => {
      await index.add('template1', new Array(128).fill(0.1));
      await index.add('template2', new Array(128).fill(0.2));
      await index.add('template3', new Array(128).fill(0.3));

      await index.remove('template2');

      const ratio = index.getDeletionRatio();
      expect(ratio).toBeCloseTo(1 / 3); // 1 deleted out of 3 allocated
    });
  });

  describe('dispose', () => {
    it('should dispose successfully', async () => {
      await index.initialize();
      await index.add('template1', new Array(128).fill(0.1));

      index.dispose();

      expect(index.getStats().count).toBe(0);
    });
  });

  describe('distance to similarity conversion', () => {
    beforeEach(async () => {
      await index.initialize();
      await index.add('template1', new Array(128).fill(0.1));
    });

    it('should convert cosine distance correctly', async () => {
      mockSearchKnn.mockReturnValue({
        neighbors: [0],
        distances: [0.2], // cosine distance
      });

      const results = await index.search(new Array(128).fill(0.15));

      expect(results[0].similarity).toBeCloseTo(0.8); // 1 - 0.2
    });

    it('should clamp similarity to [0, 1]', async () => {
      mockSearchKnn.mockReturnValue({
        neighbors: [0],
        distances: [-0.1], // Invalid negative distance
      });

      const results = await index.search(new Array(128).fill(0.15));

      expect(results[0].similarity).toBeLessThanOrEqual(1);
      expect(results[0].similarity).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('HNSWIndex with L2 space', () => {
  let index: HNSWIndex;

  beforeEach(async () => {
    vi.clearAllMocks();
    index = new HNSWIndex({
      spaceType: 'l2',
      dim: 128,
      maxElements: 1000,
    });
    await index.initialize();
  });

  afterEach(() => {
    index.dispose();
  });

  it('should not normalize vectors for L2 space', async () => {
    const { l2Normalize } = await import('../onnx-runtime');
    vi.mocked(l2Normalize).mockClear();

    const vector = new Array(128).fill(0.1);
    await index.add('template1', vector);

    // L2 空间不应该调用 l2Normalize
    expect(l2Normalize).not.toHaveBeenCalled();
  });
});

describe('HNSWIndex with IP space', () => {
  let index: HNSWIndex;

  beforeEach(async () => {
    vi.clearAllMocks();
    index = new HNSWIndex({
      spaceType: 'ip',
      dim: 128,
      maxElements: 1000,
    });
    await index.initialize();
    await index.add('template1', new Array(128).fill(0.1));

    mockSearchKnn.mockReturnValue({
      neighbors: [0],
      distances: [0.5], // inner product
    });
  });

  afterEach(() => {
    index.dispose();
  });

  it('should convert inner product to similarity', async () => {
    const results = await index.search(new Array(128).fill(0.15));

    // IP similarity: (distance + 1) / 2
    expect(results[0].similarity).toBeCloseTo(0.75);
  });
});
