/**
 * Image Search Namespace
 *
 * 提供图像相似度搜索能力的命名空间接口
 * 基于 MobileNetV3-Small + HNSW 实现
 *
 * @example
 * // 初始化（首次使用会自动下载模型）
 * await helpers.imageSearch.initialize();
 *
 * // 添加模板
 * await helpers.imageSearch.addTemplate('button-ok', './templates/ok.png');
 *
 * // 搜索相似图片
 * const results = await helpers.imageSearch.search('./screenshot.png', {
 *   topK: 5,
 *   threshold: 0.8
 * });
 *
 * // 直接比较两张图片
 * const similarity = await helpers.imageSearch.compare('./img1.png', './img2.png');
 */

import { createLogger } from '../../logger';
import {
  ImageSearchService,
  getImageSearchService,
  type SearchOptions,
  type SearchResult,
  type TemplateInfo,
  type BatchAddResult,
  type IndexStats,
  type DownloadProgress,
  type ImageSearchServiceConfig,
} from '../../image-search';

const logger = createLogger('ImageSearchNamespace');

// Re-export types for plugin developers
export type {
  SearchOptions,
  SearchResult,
  TemplateInfo,
  BatchAddResult,
  IndexStats,
  DownloadProgress,
} from '../../image-search';

/**
 * 初始化选项
 */
export interface ImageSearchInitOptions {
  /** 模型目录（可选，默认使用 userData/models） */
  modelsDir?: string;
  /** 索引存储路径（可选） */
  indexPath?: string;
  /** 最大模板数量（默认 100000） */
  maxTemplates?: number;
  /** 执行提供者（默认 cpu） */
  executionProvider?: 'cpu' | 'cuda' | 'directml';
  /** 下载进度回调 */
  onDownloadProgress?: (progress: DownloadProgress) => void;
}

/**
 * 图像搜索命名空间
 *
 * 提供端到端的图像相似度搜索能力：
 * - 自动管理模型下载和加载
 * - 模板添加和管理
 * - 高效的相似度搜索（基于 HNSW）
 * - 索引持久化
 */
export class ImageSearchNamespace {
  private service: ImageSearchService | null = null;
  private initialized = false;

  constructor(private pluginId: string) {}

  /**
   * 初始化图像搜索服务
   *
   * 首次调用会自动下载 MobileNetV3-Small 模型（约 2.5MB）
   *
   * @param options 初始化选项
   *
   * @example
   * await helpers.imageSearch.initialize();
   *
   * @example
   * await helpers.imageSearch.initialize({
   *   maxTemplates: 10000,
   *   executionProvider: 'cuda',
   *   onDownloadProgress: (p) => console.log(`下载进度: ${p.percent}%`)
   * });
   */
  async initialize(options?: ImageSearchInitOptions): Promise<void> {
    if (this.initialized) {
      logger.debug(`[Plugin:${this.pluginId}] Image search already initialized`);
      return;
    }

    const config: Partial<ImageSearchServiceConfig> = {
      modelsDir: options?.modelsDir,
      indexPath: options?.indexPath,
      maxTemplates: options?.maxTemplates,
      executionProvider: options?.executionProvider,
    };

    this.service = getImageSearchService(config);
    await this.service.initialize(options?.onDownloadProgress);

    this.initialized = true;
    logger.info(`[Plugin:${this.pluginId}] Image search initialized`);
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): ImageSearchService {
    if (!this.initialized || !this.service) {
      throw new Error('Image search not initialized. Call initialize() first.');
    }
    return this.service;
  }

  /**
   * 添加模板图像
   *
   * @param templateId 模板唯一 ID
   * @param image 图像路径或 Buffer
   * @param metadata 可选的元数据
   *
   * @example
   * await helpers.imageSearch.addTemplate('login-button', './templates/login.png');
   *
   * @example
   * await helpers.imageSearch.addTemplate('submit-btn', imageBuffer, {
   *   category: 'buttons',
   *   priority: 1
   * });
   */
  async addTemplate(
    templateId: string,
    image: string | Buffer,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const service = this.ensureInitialized();
    await service.addTemplate(templateId, image, metadata);
    logger.debug(`[Plugin:${this.pluginId}] Added template: ${templateId}`);
  }

  /**
   * 批量添加模板
   *
   * @param templates 模板数组
   * @returns 批量添加结果
   *
   * @example
   * const result = await helpers.imageSearch.addTemplates([
   *   { id: 'btn-1', image: './btn1.png' },
   *   { id: 'btn-2', image: './btn2.png', metadata: { type: 'submit' } }
   * ]);
   * console.log(`成功: ${result.success}, 失败: ${result.failed}`);
   */
  async addTemplates(
    templates: Array<{
      id: string;
      image: string | Buffer;
      metadata?: Record<string, unknown>;
    }>
  ): Promise<BatchAddResult> {
    const service = this.ensureInitialized();
    const result = await service.addTemplates(templates);
    logger.info(
      `[Plugin:${this.pluginId}] Batch add: ${result.success} success, ${result.failed} failed`
    );
    return result;
  }

  /**
   * 搜索相似图像
   *
   * @param image 查询图像（路径或 Buffer）
   * @param options 搜索选项
   * @returns 搜索结果（按相似度降序排列）
   *
   * @example
   * const results = await helpers.imageSearch.search('./screenshot.png');
   * for (const r of results) {
   *   console.log(`${r.templateId}: ${(r.similarity * 100).toFixed(1)}%`);
   * }
   *
   * @example
   * const results = await helpers.imageSearch.search(screenshotBuffer, {
   *   topK: 3,
   *   threshold: 0.85  // 只返回相似度 > 85% 的结果
   * });
   */
  async search(image: string | Buffer, options?: SearchOptions): Promise<SearchResult[]> {
    const service = this.ensureInitialized();
    return service.search(image, options);
  }

  /**
   * 比较两张图像的相似度
   *
   * @param image1 第一张图像
   * @param image2 第二张图像
   * @returns 相似度分数 (0-1)
   *
   * @example
   * const similarity = await helpers.imageSearch.compare('./img1.png', './img2.png');
   * if (similarity > 0.9) {
   *   console.log('图像非常相似');
   * }
   */
  async compare(image1: string | Buffer, image2: string | Buffer): Promise<number> {
    const service = this.ensureInitialized();
    return service.compare(image1, image2);
  }

  /**
   * 移除模板
   *
   * @param templateId 模板 ID
   * @returns 是否成功移除
   */
  async removeTemplate(templateId: string): Promise<boolean> {
    const service = this.ensureInitialized();
    return service.removeTemplate(templateId);
  }

  /**
   * 获取模板信息
   *
   * @param templateId 模板 ID
   * @returns 模板信息，如果不存在则返回 null
   */
  getTemplate(templateId: string): TemplateInfo | null {
    const service = this.ensureInitialized();
    return service.getTemplate(templateId);
  }

  /**
   * 检查模板是否存在
   */
  hasTemplate(templateId: string): boolean {
    const service = this.ensureInitialized();
    return service.hasTemplate(templateId);
  }

  /**
   * 获取所有模板 ID
   */
  getTemplateIds(): string[] {
    const service = this.ensureInitialized();
    return service.getTemplateIds();
  }

  /**
   * 获取索引统计信息
   *
   * @example
   * const stats = helpers.imageSearch.getStats();
   * console.log(`已添加 ${stats.count} 个模板，最大容量 ${stats.maxElements}`);
   */
  getStats(): IndexStats {
    const service = this.ensureInitialized();
    return service.getStats();
  }

  /**
   * 保存索引到文件
   *
   * @param indexPath 索引文件路径（可选，使用默认路径）
   *
   * @example
   * await helpers.imageSearch.saveIndex();
   */
  async saveIndex(indexPath?: string): Promise<void> {
    const service = this.ensureInitialized();
    await service.saveIndex(indexPath);
    logger.info(`[Plugin:${this.pluginId}] Index saved`);
  }

  /**
   * 从文件加载索引
   *
   * @param indexPath 索引文件路径（可选，使用默认路径）
   */
  async loadIndex(indexPath?: string): Promise<void> {
    const service = this.ensureInitialized();
    await service.loadIndex(indexPath);
    logger.info(`[Plugin:${this.pluginId}] Index loaded`);
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    const service = this.ensureInitialized();
    await service.clear();
    logger.info(`[Plugin:${this.pluginId}] Index cleared`);
  }

  /**
   * 检查模型是否已下载
   */
  isModelReady(): boolean {
    if (!this.service) {
      return false;
    }
    return this.service.isModelReady();
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 释放资源
   *
   * @internal
   */
  async dispose(): Promise<void> {
    // ImageSearchService 是单例，不在插件卸载时释放
    // 只重置本地状态
    this.initialized = false;
    this.service = null;
    logger.debug(`[Plugin:${this.pluginId}] Image search namespace disposed`);
  }
}
