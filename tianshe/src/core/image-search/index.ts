/**
 * Image Search Module
 *
 * 基于 MobileNetV3-Small + HNSW 的图像相似度搜索
 *
 * @example
 * ```typescript
 * import { getImageSearchService } from '@/core/image-search';
 *
 * const service = getImageSearchService();
 * await service.initialize();
 *
 * // 添加模板
 * await service.addTemplate('button-ok', './templates/ok-button.png');
 * await service.addTemplate('button-cancel', './templates/cancel-button.png');
 *
 * // 搜索
 * const results = await service.search('./screenshot.png', { topK: 5, threshold: 0.8 });
 * console.log(results);
 * // [{ templateId: 'button-ok', similarity: 0.95, template: {...} }]
 *
 * // 保存索引
 * await service.saveIndex();
 * ```
 */

export { ImageSearchService, getImageSearchService } from './image-search-service';
export { HNSWIndex } from './hnsw-index';
export { MobileNetExtractor, createMobileNetExtractor } from './mobilenet-extractor';

export type {
  // 配置类型
  ImageSearchServiceConfig,
  HNSWIndexConfig,
  FeatureExtractorConfig,
  // 搜索相关
  SearchOptions,
  SearchResult,
  // 模板相关
  TemplateInfo,
  BatchAddResult,
  // 索引统计
  IndexStats,
  SpaceType,
  // 模型相关
  ModelInfo,
  DownloadProgress,
} from './types';

export { PRESET_MODELS } from './types';
