/**
 * Vector Index Namespace
 *
 * 提供通用向量索引和搜索能力的命名空间接口
 * 基于 HNSW (Hierarchical Navigable Small World) 算法实现
 *
 * @example
 * // 创建文本 embedding 索引
 * const indexId = await helpers.vectorIndex.create({
 *   dim: 384,
 *   space: 'cosine',
 *   maxElements: 10000
 * });
 *
 * // 添加向量
 * await helpers.vectorIndex.add(indexId, 'doc-1', embedding1, { title: '文档1' });
 * await helpers.vectorIndex.add(indexId, 'doc-2', embedding2, { title: '文档2' });
 *
 * // 搜索相似向量
 * const results = await helpers.vectorIndex.search(indexId, queryEmbedding, { topK: 5 });
 */

import { createLogger } from '../../logger';
import { HNSWIndex, type HNSWIndexConfig, type SpaceType } from '../../image-search';
import type { SearchResult, TemplateInfo, IndexStats } from '../../image-search';
import * as path from 'path';
import * as fs from 'fs';

const logger = createLogger('VectorIndexNamespace');

// Re-export types
export type { SpaceType, IndexStats } from '../../image-search';

/**
 * 向量索引创建选项
 */
export interface CreateIndexOptions {
  /** 向量维度（必须） */
  dim: number;
  /** 距离空间类型，默认 'cosine' */
  space?: SpaceType;
  /** 最大元素数量，默认 100000 */
  maxElements?: number;
  /** HNSW M 参数，默认 16 */
  M?: number;
  /** HNSW efConstruction 参数，默认 200 */
  efConstruction?: number;
}

/**
 * 向量搜索选项
 */
export interface VectorSearchOptions {
  /** 返回前 K 个结果，默认 10 */
  topK?: number;
  /** 最小相似度阈值 (0-1)，默认 0 */
  threshold?: number;
  /** 搜索时的 ef 参数，默认 50 */
  efSearch?: number;
}

/**
 * 向量搜索结果
 */
export interface VectorSearchResult {
  /** 向量 ID */
  id: string;
  /** 相似度分数 (0-1) */
  similarity: number;
  /** 关联的元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 向量条目信息
 */
export interface VectorEntry {
  /** 向量 ID */
  id: string;
  /** 添加时间 */
  addedAt: number;
  /** 关联的元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 批量添加结果
 */
export interface BatchAddResult {
  /** 成功数量 */
  success: number;
  /** 失败数量 */
  failed: number;
  /** 错误详情 */
  errors: Array<{ id: string; error: string }>;
}

/**
 * 向量索引命名空间
 *
 * 提供通用的向量索引和相似度搜索能力：
 * - 支持多个独立索引
 * - 支持 cosine、L2、内积距离
 * - 高效的近似最近邻搜索
 * - 索引持久化
 *
 * 适用场景：
 * - 文本 embedding 搜索
 * - 音频特征匹配
 * - 自定义模型特征向量索引
 * - 推荐系统
 */
export class VectorIndexNamespace {
  /** 插件管理的索引实例 */
  private indexes: Map<string, HNSWIndex> = new Map();
  /** 索引配置 */
  private configs: Map<string, CreateIndexOptions> = new Map();
  /** 索引 ID 计数器 */
  private indexCounter = 0;

  constructor(private pluginId: string) {}

  /**
   * 创建新的向量索引
   *
   * @param options 索引配置
   * @returns 索引 ID
   *
   * @example
   * // 创建 384 维的 cosine 索引（适用于 sentence-transformers）
   * const indexId = await helpers.vectorIndex.create({
   *   dim: 384,
   *   space: 'cosine'
   * });
   *
   * @example
   * // 创建 1536 维的索引（适用于 OpenAI embeddings）
   * const indexId = await helpers.vectorIndex.create({
   *   dim: 1536,
   *   space: 'cosine',
   *   maxElements: 100000
   * });
   */
  async create(options: CreateIndexOptions): Promise<string> {
    const { dim, space = 'cosine', maxElements = 100000, M = 16, efConstruction = 200 } = options;

    if (!dim || dim <= 0) {
      throw new Error('Vector dimension must be a positive number');
    }

    // 生成唯一的索引 ID
    const indexId = `${this.pluginId}-idx-${++this.indexCounter}-${Date.now()}`;

    const config: HNSWIndexConfig = {
      dim,
      spaceType: space,
      maxElements,
      M,
      efConstruction,
    };

    const index = new HNSWIndex(config);
    await index.initialize();

    this.indexes.set(indexId, index);
    this.configs.set(indexId, options);

    logger.info(
      `[Plugin:${this.pluginId}] Created vector index: ${indexId} (dim=${dim}, space=${space})`
    );

    return indexId;
  }

  /**
   * 获取索引实例
   */
  private getIndex(indexId: string): HNSWIndex {
    const index = this.indexes.get(indexId);
    if (!index) {
      throw new Error(`Vector index not found: ${indexId}`);
    }
    return index;
  }

  /**
   * 添加向量到索引
   *
   * @param indexId 索引 ID
   * @param vectorId 向量唯一 ID
   * @param vector 向量数据
   * @param metadata 可选的元数据
   *
   * @example
   * await helpers.vectorIndex.add(indexId, 'doc-1', embedding, {
   *   title: '文档标题',
   *   category: 'tech'
   * });
   */
  async add(
    indexId: string,
    vectorId: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const index = this.getIndex(indexId);
    await index.add(vectorId, vector, { metadata } as Partial<TemplateInfo>);
    logger.debug(`[Plugin:${this.pluginId}] Added vector: ${vectorId} to ${indexId}`);
  }

  /**
   * 批量添加向量
   *
   * @param indexId 索引 ID
   * @param items 向量数组
   * @returns 批量添加结果
   *
   * @example
   * const result = await helpers.vectorIndex.addBatch(indexId, [
   *   { id: 'doc-1', vector: embedding1, metadata: { title: 'Doc 1' } },
   *   { id: 'doc-2', vector: embedding2, metadata: { title: 'Doc 2' } }
   * ]);
   * console.log(`成功: ${result.success}, 失败: ${result.failed}`);
   */
  async addBatch(
    indexId: string,
    items: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>
  ): Promise<BatchAddResult> {
    const index = this.getIndex(indexId);

    const hnswItems = items.map((item) => ({
      id: item.id,
      vector: item.vector,
      template: { metadata: item.metadata } as Partial<TemplateInfo>,
    }));

    const result = await index.addBatch(hnswItems);

    logger.info(
      `[Plugin:${this.pluginId}] Batch add to ${indexId}: ${result.success} success, ${result.failed} failed`
    );

    return result;
  }

  /**
   * 搜索相似向量
   *
   * @param indexId 索引 ID
   * @param queryVector 查询向量
   * @param options 搜索选项
   * @returns 搜索结果（按相似度降序）
   *
   * @example
   * const results = await helpers.vectorIndex.search(indexId, queryEmbedding, {
   *   topK: 10,
   *   threshold: 0.7
   * });
   *
   * for (const r of results) {
   *   console.log(`${r.id}: ${(r.similarity * 100).toFixed(1)}%`);
   *   console.log('  metadata:', r.metadata);
   * }
   */
  async search(
    indexId: string,
    queryVector: number[],
    options?: VectorSearchOptions
  ): Promise<VectorSearchResult[]> {
    const index = this.getIndex(indexId);

    const searchOptions = {
      topK: options?.topK ?? 10,
      threshold: options?.threshold ?? 0,
      efSearch: options?.efSearch ?? 50,
    };

    const results = await index.search(queryVector, searchOptions);

    return results.map((r: SearchResult) => ({
      id: r.templateId,
      similarity: r.similarity,
      metadata: (r.template as TemplateInfo & { metadata?: Record<string, unknown> })?.metadata,
    }));
  }

  /**
   * 移除向量
   *
   * @param indexId 索引 ID
   * @param vectorId 向量 ID
   * @returns 是否成功移除
   *
   * @note HNSW 不支持真正删除，只是从映射中移除。
   * 如果删除比例较高，建议调用 rebuild() 重建索引。
   */
  async remove(indexId: string, vectorId: string): Promise<boolean> {
    const index = this.getIndex(indexId);
    return index.remove(vectorId);
  }

  /**
   * 获取向量条目信息
   *
   * @param indexId 索引 ID
   * @param vectorId 向量 ID
   * @returns 条目信息，如果不存在则返回 null
   */
  getEntry(indexId: string, vectorId: string): VectorEntry | null {
    const index = this.getIndex(indexId);
    const template = index.getTemplate(vectorId);

    if (!template) {
      return null;
    }

    return {
      id: template.id,
      addedAt: template.addedAt,
      metadata: (template as TemplateInfo & { metadata?: Record<string, unknown> }).metadata,
    };
  }

  /**
   * 检查向量是否存在
   */
  has(indexId: string, vectorId: string): boolean {
    const index = this.getIndex(indexId);
    return index.hasTemplate(vectorId);
  }

  /**
   * 获取所有向量 ID
   */
  getIds(indexId: string): string[] {
    const index = this.getIndex(indexId);
    return index.getTemplateIds();
  }

  /**
   * 获取索引统计信息
   *
   * @example
   * const stats = helpers.vectorIndex.getStats(indexId);
   * console.log(`向量数量: ${stats.count}`);
   * console.log(`最大容量: ${stats.maxElements}`);
   * console.log(`维度: ${stats.dim}`);
   */
  getStats(indexId: string): IndexStats {
    const index = this.getIndex(indexId);
    return index.getStats();
  }

  /**
   * 获取删除比例
   *
   * 当此值较高时（如 > 0.3），建议调用 rebuild() 重建索引
   */
  getDeletionRatio(indexId: string): number {
    const index = this.getIndex(indexId);
    return index.getDeletionRatio();
  }

  /**
   * 重建索引
   *
   * 清理已删除的向量，优化索引性能
   *
   * @param indexId 索引 ID
   * @param vectorProvider 向量提供函数（用于重新获取向量数据）
   * @returns 重建结果
   *
   * @example
   * // 当删除比例较高时重建索引
   * if (helpers.vectorIndex.getDeletionRatio(indexId) > 0.3) {
   *   await helpers.vectorIndex.rebuild(indexId, async (id) => {
   *     // 从原始数据源重新计算向量
   *     return await computeEmbedding(documents[id]);
   *   });
   * }
   */
  async rebuild(
    indexId: string,
    vectorProvider?: (vectorId: string) => Promise<number[]> | number[]
  ): Promise<{ success: number; failed: number }> {
    const index = this.getIndex(indexId);
    const result = await index.rebuild(vectorProvider);
    logger.info(
      `[Plugin:${this.pluginId}] Rebuilt index ${indexId}: ${result.success} migrated, ${result.failed} failed`
    );
    return result;
  }

  /**
   * 清空索引
   */
  async clear(indexId: string): Promise<void> {
    const index = this.getIndex(indexId);
    await index.clear();
    logger.info(`[Plugin:${this.pluginId}] Cleared index: ${indexId}`);
  }

  /**
   * 保存索引到文件
   *
   * @param indexId 索引 ID
   * @param filePath 保存路径
   *
   * @example
   * await helpers.vectorIndex.save(indexId, './data/my-index.hnsw');
   */
  async save(indexId: string, filePath: string): Promise<void> {
    const index = this.getIndex(indexId);

    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await index.saveIndex(filePath);
    logger.info(`[Plugin:${this.pluginId}] Saved index ${indexId} to ${filePath}`);
  }

  /**
   * 从文件加载索引
   *
   * @param filePath 索引文件路径
   * @returns 加载后的索引 ID
   *
   * @example
   * const indexId = await helpers.vectorIndex.load('./data/my-index.hnsw');
   */
  async load(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Index file not found: ${filePath}`);
    }

    // 创建一个临时索引来加载
    const index = new HNSWIndex({
      dim: 1, // 会被加载的配置覆盖
      spaceType: 'cosine',
      maxElements: 1,
    });

    await index.loadIndex(filePath);

    // 生成新的索引 ID
    const indexId = `${this.pluginId}-idx-${++this.indexCounter}-${Date.now()}`;

    this.indexes.set(indexId, index);

    const stats = index.getStats();
    logger.info(
      `[Plugin:${this.pluginId}] Loaded index from ${filePath} as ${indexId} (${stats.count} vectors)`
    );

    return indexId;
  }

  /**
   * 删除索引
   */
  async delete(indexId: string): Promise<void> {
    const index = this.indexes.get(indexId);
    if (index) {
      index.dispose();
      this.indexes.delete(indexId);
      this.configs.delete(indexId);
      logger.info(`[Plugin:${this.pluginId}] Deleted index: ${indexId}`);
    }
  }

  /**
   * 列出此插件创建的所有索引
   */
  listIndexes(): Array<{ indexId: string; stats: IndexStats }> {
    const result: Array<{ indexId: string; stats: IndexStats }> = [];

    for (const [indexId, index] of this.indexes) {
      result.push({
        indexId,
        stats: index.getStats(),
      });
    }

    return result;
  }

  /**
   * 释放所有索引资源
   *
   * @internal
   */
  async dispose(): Promise<void> {
    for (const [indexId, index] of this.indexes) {
      try {
        index.dispose();
      } catch (error) {
        logger.error(`Failed to dispose index ${indexId}:`, error);
      }
    }
    this.indexes.clear();
    this.configs.clear();
    logger.debug(`[Plugin:${this.pluginId}] Vector index namespace disposed`);
  }
}
