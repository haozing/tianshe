/**
 * HNSW Vector Index
 *
 * 基于 hnswlib-node 的高效向量索引
 * 支持近似最近邻搜索 (ANN)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../logger';
import { dynamicImport } from '../utils/dynamic-import';
import { l2Normalize } from '../onnx-runtime';
import type {
  HNSWIndexConfig,
  SearchOptions,
  TemplateInfo,
  SearchResult,
  IndexStats,
  SpaceType,
} from './types';

const logger = createLogger('HNSWIndex');

// hnswlib-node 类型（动态导入）
type HierarchicalNSW = any;
type HnswlibModule = {
  HierarchicalNSW: new (space: string, dim: number) => HierarchicalNSW;
};

/**
 * 向量索引条目
 */
interface IndexEntry {
  /** 内部索引 ID */
  internalId: number;
  /** 模板信息 */
  template: TemplateInfo;
}

/**
 * HNSW 向量索引服务
 *
 * 提供高效的向量相似度搜索：
 * - 支持 cosine、L2、内积距离
 * - 支持索引持久化
 * - 支持模板元信息管理
 */
export class HNSWIndex {
  private index: HierarchicalNSW | null = null;
  private hnswlib: HnswlibModule | null = null;
  private config: HNSWIndexConfig;
  private entries: Map<string, IndexEntry> = new Map();
  private idToTemplate: Map<number, string> = new Map();
  private nextInternalId = 0;
  private initialized = false;
  /** 当前设置的 ef 值，用于避免重复设置 */
  private currentEf = 0;

  constructor(config: HNSWIndexConfig) {
    this.config = {
      M: 16,
      efConstruction: 200,
      ...config,
    };
  }

  /**
   * 初始化索引
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // 动态导入 hnswlib-node
      this.hnswlib = await dynamicImport<HnswlibModule>('hnswlib-node');

      // 创建索引
      const spaceMap: Record<SpaceType, string> = {
        cosine: 'cosine',
        l2: 'l2',
        ip: 'ip',
      };

      this.index = new this.hnswlib.HierarchicalNSW(
        spaceMap[this.config.spaceType],
        this.config.dim
      );

      // 初始化索引
      this.index.initIndex(
        this.config.maxElements,
        this.config.M,
        this.config.efConstruction,
        100 // random seed
      );

      this.initialized = true;
      logger.info(
        `HNSW index initialized: dim=${this.config.dim}, space=${this.config.spaceType}, maxElements=${this.config.maxElements}`
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'hnswlib-node is required for image search. Please install it: npm install hnswlib-node'
        );
      }
      throw error;
    }
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.index) {
      throw new Error('HNSW index not initialized. Call initialize() first.');
    }
  }

  /**
   * 添加向量
   *
   * @param templateId 模板 ID
   * @param vector 特征向量
   * @param template 模板信息
   */
  async add(templateId: string, vector: number[], template?: Partial<TemplateInfo>): Promise<void> {
    this.ensureInitialized();

    // 检查是否已存在
    if (this.entries.has(templateId)) {
      logger.warn(`Template "${templateId}" already exists, updating...`);
      await this.remove(templateId);
    }

    // 验证向量维度
    if (vector.length !== this.config.dim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.dim}, got ${vector.length}`
      );
    }

    // L2 归一化（对于 cosine 和 ip 空间）
    const normalizedVector = this.config.spaceType === 'l2' ? vector : l2Normalize(vector);

    // 分配内部 ID
    const internalId = this.nextInternalId++;

    // 添加到 HNSW 索引
    this.index!.addPoint(normalizedVector, internalId);

    // 保存模板信息
    const fullTemplate: TemplateInfo = {
      id: templateId,
      addedAt: Date.now(),
      ...template,
    };

    this.entries.set(templateId, { internalId, template: fullTemplate });
    this.idToTemplate.set(internalId, templateId);

    logger.debug(`Added template "${templateId}" with internal ID ${internalId}`);
  }

  /**
   * 批量添加向量
   */
  async addBatch(
    items: Array<{ id: string; vector: number[]; template?: Partial<TemplateInfo> }>
  ): Promise<{ success: number; failed: number; errors: Array<{ id: string; error: string }> }> {
    this.ensureInitialized();

    let success = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const item of items) {
      try {
        await this.add(item.id, item.vector, item.template);
        success++;
      } catch (error) {
        errors.push({ id: item.id, error: (error as Error).message });
      }
    }

    return { success, failed: errors.length, errors };
  }

  /**
   * 移除向量
   */
  async remove(templateId: string): Promise<boolean> {
    this.ensureInitialized();

    const entry = this.entries.get(templateId);
    if (!entry) {
      return false;
    }

    // hnswlib-node 不支持真正的删除，但可以标记为删除
    // 这里我们只从映射中移除
    this.entries.delete(templateId);
    this.idToTemplate.delete(entry.internalId);

    // 注意：向量仍在索引中，需要重建索引才能真正删除
    logger.debug(`Removed template "${templateId}" from mapping`);
    return true;
  }

  /**
   * 搜索最相似的向量
   *
   * @param queryVector 查询向量
   * @param options 搜索选项
   * @returns 搜索结果
   *
   * @note efSearch 是全局索引参数。在高并发场景下，不同的 efSearch 值可能相互影响。
   * 建议在整个应用中使用统一的 efSearch 值，或在非并发场景下使用。
   */
  async search(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    this.ensureInitialized();

    const { topK = 5, threshold = 0, efSearch = 50 } = options;

    // 验证向量维度
    if (queryVector.length !== this.config.dim) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.config.dim}, got ${queryVector.length}`
      );
    }

    // L2 归一化
    const normalizedVector =
      this.config.spaceType === 'l2' ? queryVector : l2Normalize(queryVector);

    // 设置搜索参数（仅在值变化时设置，减少开销）
    // 注意：ef 是全局设置，高并发下可能相互影响
    if (this.currentEf !== efSearch) {
      this.index!.setEf(efSearch);
      this.currentEf = efSearch;
    }

    // 执行搜索（同步操作，不会被中断）
    const result = this.index!.searchKnn(normalizedVector, Math.min(topK * 2, this.entries.size));

    // 转换结果
    const searchResults: SearchResult[] = [];

    for (let i = 0; i < result.neighbors.length; i++) {
      const internalId = result.neighbors[i];
      const distance = result.distances[i];

      // 获取模板 ID
      const templateId = this.idToTemplate.get(internalId);
      if (!templateId) continue;

      const entry = this.entries.get(templateId);
      if (!entry) continue;

      // 转换距离为相似度
      const similarity = this.distanceToSimilarity(distance);

      // 应用阈值过滤
      if (similarity < threshold) continue;

      searchResults.push({
        templateId,
        similarity,
        template: entry.template,
      });

      if (searchResults.length >= topK) break;
    }

    return searchResults;
  }

  /**
   * 获取模板信息
   */
  getTemplate(templateId: string): TemplateInfo | null {
    const entry = this.entries.get(templateId);
    return entry?.template ?? null;
  }

  /**
   * 检查模板是否存在
   */
  hasTemplate(templateId: string): boolean {
    return this.entries.has(templateId);
  }

  /**
   * 获取所有模板 ID
   */
  getTemplateIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * 获取索引统计信息
   */
  getStats(): IndexStats {
    return {
      count: this.entries.size,
      maxElements: this.config.maxElements,
      dim: this.config.dim,
      spaceType: this.config.spaceType,
    };
  }

  /**
   * 保存索引到文件
   */
  async saveIndex(indexPath: string): Promise<void> {
    this.ensureInitialized();

    const dir = path.dirname(indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 保存 HNSW 索引
    this.index!.writeIndexSync(indexPath);

    // 保存模板映射
    const metaPath = indexPath + '.meta.json';
    const metadata = {
      config: this.config,
      nextInternalId: this.nextInternalId,
      entries: Array.from(this.entries.entries()).map(([id, entry]) => ({
        templateId: id,
        internalId: entry.internalId,
        template: entry.template,
      })),
    };
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

    logger.info(`Index saved to ${indexPath} (${this.entries.size} templates)`);
  }

  /**
   * 从文件加载索引
   */
  async loadIndex(indexPath: string): Promise<void> {
    if (!fs.existsSync(indexPath)) {
      throw new Error(`Index file not found: ${indexPath}`);
    }

    const metaPath = indexPath + '.meta.json';
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Index metadata not found: ${metaPath}`);
    }

    // 加载元数据
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

    // 更新配置
    this.config = metadata.config;
    this.nextInternalId = metadata.nextInternalId;

    // 确保 hnswlib 已加载
    if (!this.hnswlib) {
      this.hnswlib = await dynamicImport<HnswlibModule>('hnswlib-node');
    }

    // 创建新索引并加载
    const spaceMap: Record<SpaceType, string> = {
      cosine: 'cosine',
      l2: 'l2',
      ip: 'ip',
    };

    this.index = new this.hnswlib.HierarchicalNSW(spaceMap[this.config.spaceType], this.config.dim);
    this.index.readIndexSync(indexPath);

    // 恢复模板映射
    this.entries.clear();
    this.idToTemplate.clear();

    for (const entry of metadata.entries) {
      this.entries.set(entry.templateId, {
        internalId: entry.internalId,
        template: entry.template,
      });
      this.idToTemplate.set(entry.internalId, entry.templateId);
    }

    this.initialized = true;
    logger.info(`Index loaded from ${indexPath} (${this.entries.size} templates)`);
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    this.entries.clear();
    this.idToTemplate.clear();
    this.nextInternalId = 0;

    // 重新创建索引
    if (this.hnswlib && this.index) {
      const spaceMap: Record<SpaceType, string> = {
        cosine: 'cosine',
        l2: 'l2',
        ip: 'ip',
      };

      this.index = new this.hnswlib.HierarchicalNSW(
        spaceMap[this.config.spaceType],
        this.config.dim
      );

      this.index.initIndex(this.config.maxElements, this.config.M, this.config.efConstruction, 100);
    }

    logger.info('Index cleared');
  }

  /**
   * 重建索引
   *
   * 由于 HNSW 不支持真正的删除操作，长期使用后索引可能会膨胀。
   * 此方法会重建索引，真正移除已删除的向量。
   *
   * 注意：此方法需要能够从索引中读取向量，依赖于 hnswlib-node 的 getPoint 方法。
   * 如果该方法不可用，则需要外部提供向量数据。
   *
   * @param vectorProvider 可选的向量提供函数，用于在无法从索引读取向量时获取向量
   */
  async rebuild(
    vectorProvider?: (templateId: string) => Promise<number[]> | number[]
  ): Promise<{ success: number; failed: number }> {
    this.ensureInitialized();

    // 收集当前有效的模板和向量
    const items: Array<{ id: string; vector: number[]; template: TemplateInfo }> = [];
    let failed = 0;

    for (const [templateId, entry] of this.entries) {
      try {
        let vector: number[];

        // 尝试从索引读取向量
        if (this.index!.getPoint) {
          vector = Array.from(this.index!.getPoint(entry.internalId));
        } else if (vectorProvider) {
          // 使用外部提供的向量
          vector = await vectorProvider(templateId);
        } else {
          throw new Error(
            'Cannot read vector from index and no vectorProvider supplied. ' +
              'Please provide a vectorProvider function.'
          );
        }

        items.push({ id: templateId, vector, template: entry.template });
      } catch (error) {
        logger.error(`Failed to get vector for template "${templateId}":`, error);
        failed++;
      }
    }

    // 清空并重建
    await this.clear();

    // 重新添加所有向量
    for (const item of items) {
      await this.add(item.id, item.vector, item.template);
    }

    logger.info(`Index rebuilt: ${items.length} templates migrated, ${failed} failed`);

    return { success: items.length, failed };
  }

  /**
   * 获取删除比例
   *
   * 返回已删除但仍在索引中的向量占比。
   * 当此值较高时（如 > 0.3），建议调用 rebuild() 方法。
   */
  getDeletionRatio(): number {
    if (!this.initialized || !this.index) {
      return 0;
    }

    // nextInternalId 是已分配的总数（包括已删除的）
    // entries.size 是当前有效的数量
    const totalAllocated = this.nextInternalId;
    const currentActive = this.entries.size;

    if (totalAllocated === 0) return 0;

    return (totalAllocated - currentActive) / totalAllocated;
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.index = null;
    this.entries.clear();
    this.idToTemplate.clear();
    this.initialized = false;
    logger.info('HNSW index disposed');
  }

  /**
   * 将距离转换为相似度
   */
  private distanceToSimilarity(distance: number): number {
    switch (this.config.spaceType) {
      case 'cosine':
        // cosine distance: 1 - cosine_similarity
        // 所以 similarity = 1 - distance
        return Math.max(0, Math.min(1, 1 - distance));
      case 'ip':
        // 内积：值越大越相似
        // 对于归一化向量，内积范围是 [-1, 1]
        return Math.max(0, Math.min(1, (distance + 1) / 2));
      case 'l2':
        // L2 距离：值越小越相似
        // 使用指数衰减转换
        return Math.exp(-distance);
      default:
        return 1 - distance;
    }
  }
}
