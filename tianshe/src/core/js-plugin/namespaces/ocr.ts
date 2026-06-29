/**
 * OCR Namespace
 *
 * 提供 OCR 文字识别能力的命名空间接口
 * 基于 PP-OCRv4 实现，支持中英文混合识别
 *
 * @example
 * // 识别图片中的文字
 * const results = await helpers.ocr.recognize('./screenshot.png');
 * for (const r of results) {
 *   console.log(`${r.text} (${r.confidence}%)`);
 * }
 *
 * @example
 * // 查找特定文字的位置
 * const bounds = await helpers.ocr.findText('./screenshot.png', '登录');
 * if (bounds) {
 *   console.log(`找到文字位置: (${bounds.x}, ${bounds.y})`);
 * }
 */

import { createLogger } from '../../logger';
import { createTaskQueue } from '../../task-manager/queue';
import type { TaskQueue } from '../../task-manager/queue';
import {
  applyImagePreprocessPipeline,
  getDefaultOcrPreprocessPipelines,
  getOcrPool,
  getOcrPoolConfig,
  recognizeWithPipelines as recognizeWithPipelinesInternal,
  resetOcrPool,
  setOcrPoolConfig,
} from '../../system-automation/ocr';
import type { OCROptions, OCRResult, DetailedOCRResult } from '../../system-automation/types';
import type { Bounds } from '../../coordinate/types';
import * as fs from 'fs';
import { normalizeOcrPoolConfig } from '../../../constants/ocr-pool';
import type {
  ImagePreprocessOutputFormat,
  ImagePreprocessPipeline,
  ImagePreprocessPreset,
  OCRPipelineSelectionStrategy,
  OCRPipelineVariant,
  OCRPoolQueueMode,
} from '../../system-automation/ocr';

const logger = createLogger('OCRNamespace');

const GLOBAL_POOL_MESSAGE = 'OCR pool config is global. Use Settings > OCR to configure.';

// Re-export types for plugin developers
export type { OCROptions, OCRResult, DetailedOCRResult } from '../../system-automation/types';
export type { Bounds } from '../../coordinate/types';
export type {
  ImagePreprocessOutputFormat,
  ImagePreprocessPipeline,
  ImagePreprocessPreset,
  OCRPipelineSelectionStrategy,
  OCRPipelineVariant,
  OCRPoolQueueMode,
} from '../../system-automation/ocr';

/**
 * 简化的 OCR 选项（插件 API）
 */
export interface SimpleOCROptions {
  /** 最小置信度阈值 (0-100)，默认 0 */
  minConfidence?: number;
  /** 识别语言（PP-OCR 自动识别中英文，此参数保留用于兼容） */
  language?: string;
}

export interface MultiPassOCROptions extends SimpleOCROptions {
  preset?: ImagePreprocessPreset;
  pipelines?: ImagePreprocessPipeline[];
  selectionStrategy?: OCRPipelineSelectionStrategy;
  onVariant?: (
    variant: OCRPipelineVariant,
    context: { index: number; total: number }
  ) => boolean | void | Promise<boolean | void>;
  preprocessOutputFormat?: ImagePreprocessOutputFormat;
  jpegQuality?: number;
}

export interface MultiPassOCRResult {
  best: OCRResult[];
  bestPipeline: string;
  variants: OCRPipelineVariant[];
}

export interface OCRPoolOptions {
  size?: number;
  maxQueue?: number;
  queueMode?: OCRPoolQueueMode;
}

export interface OCRBatchOptions extends SimpleOCROptions {
  concurrency?: number;
}

export type OCRBatchResult =
  | { index: number; ok: true; results: OCRResult[] }
  | { index: number; ok: false; error: string };

export interface ConfigureOCRPoolOptions extends OCRPoolOptions {
  /**
   * Reset current global pool immediately to apply new config.
   */
  reset?: boolean;
  /** Warm up a new pool immediately (lazy by default). */
  warmup?: boolean;
}

/**
 * 文本查找选项
 */
export interface FindTextOptions extends SimpleOCROptions {
  /** 是否精确匹配，默认 false（包含匹配） */
  exact?: boolean;
  /** 是否忽略大小写，默认 true */
  ignoreCase?: boolean;
}

/**
 * OCR 命名空间
 *
 * 提供端到端的 OCR 文字识别能力：
 * - 自动管理 OCR 引擎初始化
 * - 支持图片路径或 Buffer 输入
 * - 提供便捷的文字查找方法
 * - 基于 PP-OCRv4，支持中英文混合识别
 */
export class OCRNamespace {
  constructor(private pluginId: string) {}

  /**
   * 确保 OCR 引擎已初始化
   */
  private async ensureInitialized() {
    return getOcrPool();
  }

  /**
   * Configure global OCR engine pool.
   *
   * @example
   * await helpers.ocr.configurePool({ size: 2, queueMode: 'wait' });
   */
  async configurePool(options?: ConfigureOCRPoolOptions): Promise<void> {
    if (!options) return;
    logger.warn(`[Plugin:${this.pluginId}] ${GLOBAL_POOL_MESSAGE}`);

    const base = getOcrPoolConfig();
    const merged: OCRPoolOptions = { ...base };
    if (options.size !== undefined && options.size !== null) merged.size = options.size;
    if (options.maxQueue !== undefined && options.maxQueue !== null)
      merged.maxQueue = options.maxQueue;
    if (options.queueMode) merged.queueMode = options.queueMode;

    const normalized = normalizeOcrPoolConfig(merged);
    await setOcrPoolConfig(normalized, {
      reset: options.reset,
      warmup: options.warmup,
    });
  }

  /**
   * Get current OCR pool config (normalized).
   */
  getPoolOptions(): OCRPoolOptions {
    return { ...getOcrPoolConfig() };
  }

  /**
   * 重置 OCR 引擎（释放 native 资源 / 缓解长时间运行的内存压力）
   *
   * 调用后，下次识别会自动重新初始化 OCR 引擎。
   */
  async reset(options?: { cooldownMs?: number }): Promise<void> {
    await resetOcrPool(options);
    logger.debug(`[Plugin:${this.pluginId}] OCR engine pool reset`);
  }

  /**
   * 识别图像中的文字
   *
   * @param image 图像路径或 Buffer
   * @param options OCR 选项
   * @returns 识别结果数组（包含文字、置信度和位置）
   *
   * @example
   * const results = await helpers.ocr.recognize('./screenshot.png');
   * for (const r of results) {
   *   console.log(`文字: ${r.text}`);
   *   console.log(`置信度: ${r.confidence}%`);
   *   console.log(`位置: (${r.bounds.x}, ${r.bounds.y})`);
   * }
   *
   * @example
   * // 只获取高置信度结果
   * const results = await helpers.ocr.recognize(imageBuffer, {
   *   minConfidence: 80
   * });
   */
  async recognize(image: string | Buffer, options?: SimpleOCROptions): Promise<OCRResult[]> {
    const pool = await this.ensureInitialized();

    // 验证文件存在（如果是路径）
    if (typeof image === 'string' && !fs.existsSync(image)) {
      throw new Error(`Image file not found: ${image}`);
    }

    const ocrOptions: OCROptions = {
      minConfidence: options?.minConfidence,
      language: options?.language,
    };

    return pool.recognize(image, ocrOptions);
  }

  /**
   * Recognize multiple images with limited concurrency.
   */
  async recognizeBatch(
    images: Array<string | Buffer>,
    options?: OCRBatchOptions
  ): Promise<OCRBatchResult[]> {
    const list = Array.isArray(images) ? images : [];
    if (list.length === 0) return [];

    const poolConfig = getOcrPoolConfig();
    const desired = Number(options?.concurrency ?? poolConfig.size);
    const concurrency = Math.max(1, Math.min(8, Math.floor(desired || 1)));
    const queue: TaskQueue = createTaskQueue({ name: 'OCRRecognizeBatch', concurrency });

    try {
      const tasks = list.map((image, index) =>
        queue
          .add(async () => {
            const results = await this.recognize(image, options);
            return { index, ok: true as const, results };
          })
          .catch((error) => ({
            index,
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }))
      );

      return await Promise.all(tasks);
    } finally {
      try {
        await queue.stop();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Multi-pass OCR (with optional preprocessing pipelines).
   *
   * When `preset: 'low-contrast'`, this runs multiple enhanced passes and selects the best result.
   */
  async recognizeMultiPass(
    image: string | Buffer,
    options?: MultiPassOCROptions
  ): Promise<MultiPassOCRResult> {
    const pool = await this.ensureInitialized();

    if (typeof image === 'string' && !fs.existsSync(image)) {
      throw new Error(`Image file not found: ${image}`);
    }

    const ocrOptions: OCROptions = {
      minConfidence: options?.minConfidence,
      language: options?.language,
    };

    const pipelines: ImagePreprocessPipeline[] | ImagePreprocessPreset =
      options?.pipelines ?? options?.preset ?? 'none';

    const result = await recognizeWithPipelinesInternal(pool, image, {
      pipelines,
      selectionStrategy: options?.selectionStrategy,
      preprocessOutputFormat: options?.preprocessOutputFormat,
      jpegQuality: options?.jpegQuality,
      ocr: ocrOptions,
      onVariant: options?.onVariant,
    });

    return {
      best: result.best,
      bestPipeline: result.bestPipeline,
      variants: result.variants,
    };
  }

  /**
   * Preprocess image without running OCR (useful for debugging).
   */
  async preprocessImage(
    image: string | Buffer,
    options?: {
      preset?: ImagePreprocessPreset;
      pipelineName?: string;
      pipeline?: ImagePreprocessPipeline;
      outputFormat?: ImagePreprocessOutputFormat;
      jpegQuality?: number;
    }
  ): Promise<{ pipelineName: string; buffer: Buffer }> {
    if (typeof image === 'string' && !fs.existsSync(image)) {
      throw new Error(`Image file not found: ${image}`);
    }

    let pipeline: ImagePreprocessPipeline | undefined = options?.pipeline;

    if (!pipeline) {
      const preset = options?.preset ?? 'low-contrast';
      const presets = getDefaultOcrPreprocessPipelines(preset);
      pipeline =
        (options?.pipelineName
          ? presets.find((p) => p.name === options.pipelineName)
          : presets.find((p) => p.name.includes('clahe'))) ?? presets[0];
    }

    const buffer = await applyImagePreprocessPipeline(image, pipeline, {
      outputFormat: options?.outputFormat,
      jpegQuality: options?.jpegQuality,
    });

    return { pipelineName: pipeline.name, buffer };
  }

  /**
   * 识别并返回详细结果
   *
   * 包含行级别的分割信息
   *
   * @param image 图像路径或 Buffer
   * @param options OCR 选项
   * @returns 详细识别结果
   *
   * @example
   * const results = await helpers.ocr.recognizeDetailed('./document.png');
   * for (const block of results) {
   *   console.log(`区块: ${block.text}`);
   *   if (block.lines) {
   *     for (const line of block.lines) {
   *       console.log(`  行: ${line.text}`);
   *     }
   *   }
   * }
   */
  async recognizeDetailed(
    image: string | Buffer,
    options?: SimpleOCROptions
  ): Promise<DetailedOCRResult[]> {
    const pool = await this.ensureInitialized();

    if (typeof image === 'string' && !fs.existsSync(image)) {
      throw new Error(`Image file not found: ${image}`);
    }

    const ocrOptions: OCROptions = {
      minConfidence: options?.minConfidence,
      language: options?.language,
    };

    return pool.recognizeDetailed(image, ocrOptions);
  }

  /**
   * 提取图像中的所有文字（拼接为字符串）
   *
   * @param image 图像路径或 Buffer
   * @param options OCR 选项
   * @returns 拼接后的文字字符串
   *
   * @example
   * const text = await helpers.ocr.extractText('./screenshot.png');
   * console.log('页面文字:', text);
   */
  async extractText(image: string | Buffer, options?: SimpleOCROptions): Promise<string> {
    const results = await this.recognize(image, options);
    return results.map((r) => r.text).join('\n');
  }

  /**
   * 在图像中查找特定文字的位置
   *
   * @param image 图像路径或 Buffer
   * @param text 要查找的文字
   * @param options 查找选项
   * @returns 文字位置，如果未找到则返回 null
   *
   * @example
   * // 查找"登录"按钮的位置
   * const bounds = await helpers.ocr.findText('./screenshot.png', '登录');
   * if (bounds) {
   *   // 计算中心点进行点击
   *   const centerX = bounds.x + bounds.width / 2;
   *   const centerY = bounds.y + bounds.height / 2;
   *   await helpers.window.click(centerX, centerY);
   * }
   *
   * @example
   * // 精确匹配
   * const bounds = await helpers.ocr.findText('./screenshot.png', '确定', {
   *   exact: true,
   *   minConfidence: 90
   * });
   */
  async findText(
    image: string | Buffer,
    text: string,
    options?: FindTextOptions
  ): Promise<Bounds | null> {
    const { exact = false, ignoreCase = true, ...ocrOptions } = options || {};

    const results = await this.recognize(image, ocrOptions);

    const searchText = ignoreCase ? text.toLowerCase() : text;

    for (const result of results) {
      const resultText = ignoreCase ? result.text.toLowerCase() : result.text;

      if (exact) {
        if (resultText === searchText) {
          return result.bounds;
        }
      } else {
        if (resultText.includes(searchText)) {
          return result.bounds;
        }
      }
    }

    return null;
  }

  /**
   * 查找所有匹配文字的位置
   *
   * @param image 图像路径或 Buffer
   * @param text 要查找的文字
   * @param options 查找选项
   * @returns 所有匹配的位置数组
   *
   * @example
   * // 查找所有"删除"按钮
   * const allBounds = await helpers.ocr.findAllText('./screenshot.png', '删除');
   * console.log(`找到 ${allBounds.length} 个匹配`);
   */
  async findAllText(
    image: string | Buffer,
    text: string,
    options?: FindTextOptions
  ): Promise<Array<{ bounds: Bounds; text: string; confidence: number }>> {
    const { exact = false, ignoreCase = true, ...ocrOptions } = options || {};

    const results = await this.recognize(image, ocrOptions);

    const searchText = ignoreCase ? text.toLowerCase() : text;
    const matches: Array<{ bounds: Bounds; text: string; confidence: number }> = [];

    for (const result of results) {
      const resultText = ignoreCase ? result.text.toLowerCase() : result.text;

      const isMatch = exact ? resultText === searchText : resultText.includes(searchText);

      if (isMatch) {
        matches.push({
          bounds: result.bounds,
          text: result.text,
          confidence: result.confidence,
        });
      }
    }

    return matches;
  }

  /**
   * 检查图像中是否包含特定文字
   *
   * @param image 图像路径或 Buffer
   * @param text 要查找的文字
   * @param options 查找选项
   * @returns 是否包含该文字
   *
   * @example
   * // 检查页面是否加载完成
   * const isLoaded = await helpers.ocr.hasText('./screenshot.png', '欢迎');
   * if (isLoaded) {
   *   console.log('页面已加载');
   * }
   */
  async hasText(image: string | Buffer, text: string, options?: FindTextOptions): Promise<boolean> {
    const bounds = await this.findText(image, text, options);
    return bounds !== null;
  }

  /**
   * 等待文字出现
   *
   * @param imageProvider 图像提供函数（每次检查时调用）
   * @param text 要等待的文字
   * @param options 等待选项
   * @returns 文字位置，如果超时则返回 null
   *
   * @example
   * // 等待"加载完成"出现
   * const bounds = await helpers.ocr.waitForText(
   *   () => helpers.window.captureScreen(),
   *   '加载完成',
   *   { timeout: 10000, interval: 500 }
   * );
   */
  async waitForText(
    imageProvider: () => Promise<Buffer | string> | Buffer | string,
    text: string,
    options?: FindTextOptions & { timeout?: number; interval?: number }
  ): Promise<Bounds | null> {
    const { timeout = 30000, interval = 1000, ...findOptions } = options || {};

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const image = await imageProvider();
        const bounds = await this.findText(image, text, findOptions);

        if (bounds) {
          return bounds;
        }
      } catch (error) {
        logger.debug(`[Plugin:${this.pluginId}] waitForText check failed:`, error);
      }

      // 等待下一次检查
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return null;
  }

  /**
   * 释放 OCR 资源
   *
   * @internal
   */
  async dispose(): Promise<void> {
    logger.debug(`[Plugin:${this.pluginId}] OCR namespace disposed`);
  }
}
