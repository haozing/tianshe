/**
 * OpenCV Namespace (opencv-js + worker pool)
 *
 * 提供通用 OpenCV 图像处理能力（与 OCR 解耦）。
 * 当前后端为 opencv-js（WASM），通过 worker_threads 并行执行任务以利用多核 CPU。
 *
 * 注意：
 * - API 仅接受 Buffer 或本地路径；不负责下载 URL（应由调用方先下载为 Buffer）。
 * - 返回结果使用 plain data（不暴露 cv.Mat），便于跨线程与未来替换后端。
 */

import { createLogger } from '../../logger';
import { getOpenCVJsPool } from '../../system-automation/cv/opencvjs-pool';
import {
  getOpenCVService,
  type DecodeOptions,
  type EncodeFormat,
  type ExtractCropsBatchOptions,
  type ExtractCropsResult,
} from '../../system-automation/cv';
import type { FindCropsOptions } from '../../system-automation/cv';

const logger = createLogger('CVNamespace');

export type {
  DecodeOptions,
  EncodeFormat,
  FindCropsOptions,
  ExtractCropsResult,
  ExtractCropsBatchOptions,
};

export interface CVInitOptions {
  /** worker 数量（默认 min(4,cpu)），建议 2-6 */
  workers?: number;
  maxQueue?: number;
  queueMode?: 'wait' | 'reject';
  timeoutMs?: number;
  hardTimeoutMs?: number;
}

export class CVNamespace {
  private initialized = false;

  constructor(private pluginId: string) {}

  /**
   * 初始化 OpenCV worker 池（可选）。
   *
   * 如果不调用，首次使用时会按默认并发自动初始化。
   */
  async initialize(options?: CVInitOptions): Promise<void> {
    if (this.initialized) return;
    const pool = getOpenCVJsPool({
      workers: options?.workers,
      maxQueue: options?.maxQueue,
      queueMode: options?.queueMode,
      timeoutMs: options?.timeoutMs,
      hardTimeoutMs: options?.hardTimeoutMs,
    });
    await pool.ping();
    this.initialized = true;
    logger.info(
      `[Plugin:${this.pluginId}] OpenCV initialized (workers=${options?.workers ?? 'default'})`
    );
  }

  /**
   * Worker 健康检查（不触发加载 opencv-js）。
   */
  async ping(): Promise<{ pong: boolean; pid: number }> {
    const service = getOpenCVService();
    return service.ping();
  }

  /**
   * 从图像中提取旋转裁剪块（通用能力，可用于 OCR 行切割等）。
   */
  async extractCrops(
    input: string | Buffer,
    options?: {
      decode?: DecodeOptions;
      opencv?: FindCropsOptions;
      outputFormat?: EncodeFormat;
      jpegQuality?: number;
    }
  ): Promise<ExtractCropsResult> {
    const service = getOpenCVService();
    return service.extractCrops(input, options);
  }

  /**
   * 批量提取裁剪块，支持并发控制（仅控制“解码+opencv 任务”的并发，不包含调用方其它逻辑）。
   */
  async extractCropsBatch(
    inputs: Array<string | Buffer>,
    options?: ExtractCropsBatchOptions
  ): Promise<
    Array<
      | { index: number; ok: true; data: ExtractCropsResult }
      | { index: number; ok: false; error: string }
    >
  > {
    const service = getOpenCVService();
    return service.extractCropsBatch(inputs, options);
  }

  /**
   * 释放资源
   *
   * @internal
   */
  async dispose(): Promise<void> {
    // OpenCV worker pool is global/shared. Don't terminate it on plugin unload.
    this.initialized = false;
    logger.debug(`[Plugin:${this.pluginId}] CV namespace disposed`);
  }
}
