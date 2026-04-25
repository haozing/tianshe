/**
 * Image Search Service
 *
 * 统一的图像搜索服务，整合特征提取和向量索引
 * 提供模板管理、相似度搜索等功能
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createLogger } from '../logger';
import { cosineSimilarity } from '../onnx-runtime';
import { HNSWIndex } from './hnsw-index';
import { MobileNetExtractor, createMobileNetExtractor } from './mobilenet-extractor';
import type {
  ImageSearchServiceConfig,
  SearchOptions,
  SearchResult,
  TemplateInfo,
  BatchAddResult,
  IndexStats,
  DownloadProgress,
} from './types';

const logger = createLogger('ImageSearchService');

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ImageSearchServiceConfig = {
  modelsDir: '',
  autoLoadIndex: true,
  maxTemplates: 100000,
  executionProvider: 'cpu',
};

/**
 * 图像搜索服务
 *
 * 提供端到端的图像相似度搜索能力：
 * - 自动管理模型下载和加载
 * - 模板添加和管理
 * - 高效的相似度搜索
 * - 索引持久化
 */
export class ImageSearchService {
  private static instance: ImageSearchService | null = null;

  private config: ImageSearchServiceConfig;
  private extractor: MobileNetExtractor | null = null;
  private index: HNSWIndex | null = null;
  private initialized = false;
  private initializing = false;

  private constructor(config?: Partial<ImageSearchServiceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 设置默认模型目录
    if (!this.config.modelsDir) {
      this.config.modelsDir = this.getDefaultModelsDir();
    }

    // 设置默认索引路径
    if (!this.config.indexPath) {
      this.config.indexPath = path.join(this.config.modelsDir, 'image-search.index');
    }
  }

  /**
   * 获取单例实例
   *
   * 注意：配置参数仅在首次创建实例时生效。
   * 如果需要使用不同配置，请先调用 resetInstance()。
   */
  static getInstance(config?: Partial<ImageSearchServiceConfig>): ImageSearchService {
    if (!ImageSearchService.instance) {
      ImageSearchService.instance = new ImageSearchService(config);
    } else if (config && Object.keys(config).length > 0) {
      // 警告：后续调用时传入的配置将被忽略
      logger.warn(
        'ImageSearchService is already initialized. ' +
          'Config parameters are ignored. Use resetInstance() first if you need different config.'
      );
    }
    return ImageSearchService.instance;
  }

  /**
   * 重置单例（用于测试）
   */
  static resetInstance(): void {
    if (ImageSearchService.instance) {
      ImageSearchService.instance.dispose();
      ImageSearchService.instance = null;
    }
  }

  /**
   * 获取默认模型目录
   */
  private getDefaultModelsDir(): string {
    try {
      // Electron 环境
      const userDataPath = app.getPath('userData');
      return path.join(userDataPath, 'models');
    } catch {
      // Node.js 环境（开发/测试）
      return path.join(process.cwd(), 'models');
    }
  }

  /**
   * 初始化服务
   *
   * @param onProgress 下载进度回调（如果需要下载模型）
   */
  async initialize(onProgress?: (progress: DownloadProgress) => void): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      // 等待初始化完成
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.initializing = true;

    try {
      // 确保模型目录存在
      if (!fs.existsSync(this.config.modelsDir)) {
        fs.mkdirSync(this.config.modelsDir, { recursive: true });
      }

      // 初始化特征提取器（自动下载模型）
      this.extractor = await createMobileNetExtractor(this.config.modelsDir, {
        executionProvider: this.config.executionProvider,
        autoDownload: true,
        onDownloadProgress: onProgress,
      });

      // 初始化向量索引
      this.index = new HNSWIndex({
        spaceType: 'cosine',
        dim: this.extractor.getFeatureDim(),
        maxElements: this.config.maxTemplates!,
        M: 16,
        efConstruction: 200,
      });

      await this.index.initialize();

      // 尝试加载已保存的索引
      if (this.config.autoLoadIndex && this.config.indexPath) {
        try {
          if (fs.existsSync(this.config.indexPath)) {
            await this.index.loadIndex(this.config.indexPath);
            logger.info(`Loaded existing index with ${this.index.getStats().count} templates`);
          }
        } catch (error) {
          logger.warn('Failed to load existing index, starting fresh:', error);
        }
      }

      this.initialized = true;
      logger.info('Image search service initialized');
    } finally {
      this.initializing = false;
    }
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.extractor || !this.index) {
      throw new Error('Image search service not initialized. Call initialize() first.');
    }
  }

  /**
   * 添加模板图像
   *
   * @param templateId 模板 ID
   * @param image 图像路径或 Buffer
   * @param metadata 可选的元数据
   */
  async addTemplate(
    templateId: string,
    image: string | Buffer,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.ensureInitialized();

    // 提取特征
    const features = await this.extractor!.extract(image);

    // 准备模板信息
    const templateInfo: Partial<TemplateInfo> = {
      name: templateId,
      metadata,
    };

    if (typeof image === 'string') {
      templateInfo.imagePath = image;
    }

    // 添加到索引
    await this.index!.add(templateId, features, templateInfo);

    logger.debug(`Added template: ${templateId}`);
  }

  /**
   * 批量添加模板
   */
  async addTemplates(
    templates: Array<{
      id: string;
      image: string | Buffer;
      metadata?: Record<string, unknown>;
    }>
  ): Promise<BatchAddResult> {
    this.ensureInitialized();

    let success = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const template of templates) {
      try {
        await this.addTemplate(template.id, template.image, template.metadata);
        success++;
      } catch (error) {
        errors.push({ id: template.id, error: (error as Error).message });
      }
    }

    logger.info(`Batch add completed: ${success} success, ${errors.length} failed`);

    return {
      success,
      failed: errors.length,
      errors,
    };
  }

  /**
   * 搜索相似图像
   *
   * @param image 查询图像（路径或 Buffer）
   * @param options 搜索选项
   * @returns 搜索结果
   */
  async search(image: string | Buffer, options?: SearchOptions): Promise<SearchResult[]> {
    this.ensureInitialized();

    // 提取查询图像特征
    const queryFeatures = await this.extractor!.extract(image);

    // 执行搜索
    const results = await this.index!.search(queryFeatures, options);

    return results;
  }

  /**
   * 计算两张图像的相似度
   */
  async compare(image1: string | Buffer, image2: string | Buffer): Promise<number> {
    this.ensureInitialized();

    const features1 = await this.extractor!.extract(image1);
    const features2 = await this.extractor!.extract(image2);

    // 计算余弦相似度
    return cosineSimilarity(features1, features2);
  }

  /**
   * 移除模板
   */
  async removeTemplate(templateId: string): Promise<boolean> {
    this.ensureInitialized();
    return this.index!.remove(templateId);
  }

  /**
   * 获取模板信息
   */
  getTemplate(templateId: string): TemplateInfo | null {
    this.ensureInitialized();
    return this.index!.getTemplate(templateId);
  }

  /**
   * 检查模板是否存在
   */
  hasTemplate(templateId: string): boolean {
    this.ensureInitialized();
    return this.index!.hasTemplate(templateId);
  }

  /**
   * 获取所有模板 ID
   */
  getTemplateIds(): string[] {
    this.ensureInitialized();
    return this.index!.getTemplateIds();
  }

  /**
   * 获取索引统计
   */
  getStats(): IndexStats {
    this.ensureInitialized();
    return this.index!.getStats();
  }

  /**
   * 保存索引
   */
  async saveIndex(indexPath?: string): Promise<void> {
    this.ensureInitialized();
    const savePath = indexPath || this.config.indexPath!;
    await this.index!.saveIndex(savePath);
  }

  /**
   * 加载索引
   */
  async loadIndex(indexPath?: string): Promise<void> {
    this.ensureInitialized();
    const loadPath = indexPath || this.config.indexPath!;
    await this.index!.loadIndex(loadPath);
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    this.ensureInitialized();
    await this.index!.clear();
    logger.info('Index cleared');
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = null;
    }

    if (this.index) {
      this.index.dispose();
      this.index = null;
    }

    this.initialized = false;
    logger.info('Image search service disposed');
  }

  /**
   * 检查模型是否已下载
   */
  isModelReady(): boolean {
    const modelPath = MobileNetExtractor.getModelPath(this.config.modelsDir, 'mobilenetv3-small');
    return MobileNetExtractor.isModelDownloaded(modelPath);
  }

  /**
   * 获取模型目录
   */
  getModelsDir(): string {
    return this.config.modelsDir;
  }
}

/**
 * 获取图像搜索服务实例
 */
export function getImageSearchService(
  config?: Partial<ImageSearchServiceConfig>
): ImageSearchService {
  return ImageSearchService.getInstance(config);
}
