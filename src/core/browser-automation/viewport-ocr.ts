/**
 * 视口内 OCR 服务
 *
 * 基于 Electron capturePage + PP-OCRv4 (onnxruntime-node)
 * 所有坐标均为视口坐标，可直接用于 sendInputEvent
 *
 * @example
 * ```typescript
 * const ocrService = new ViewportOCRService(captureAPI, ocrProvider);
 *
 * // 识别视口内的文字
 * const results = await ocrService.recognize();
 *
 * // 查找文本
 * const bounds = await ocrService.findText('登录');
 * if (bounds) {
 *   // bounds 是视口坐标，可直接用于 sendInputEvent
 *   await browser.native.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
 * }
 * ```
 */

import type { Bounds, NormalizedBounds, ViewportConfig } from '../coordinate/types';
import type { BrowserCaptureAPI } from '../browser-core/capture';
import type { OCRAPI } from '../system-automation/types';
import { TextNotFoundError } from '../system-automation/types';
import { sleep } from '../browser-core/utils';

/**
 * 视口 OCR 选项
 */
export interface ViewportOCROptions {
  /** 识别语言，默认 'eng+chi_sim' */
  language?: string;
  /** 最小置信度阈值 (0-100) */
  minConfidence?: number;
  /** 是否精确匹配 */
  exactMatch?: boolean;
  /** 超时时间（用于 OCR provider） */
  timeoutMs?: number;
  /** 取消信号 */
  signal?: AbortSignal;
}

/**
 * 视口 OCR 结果
 */
export interface ViewportOCRResult {
  /** 识别的文本 */
  text: string;
  /** 置信度 (0-100) */
  confidence: number;
  /** 文本位置（视口坐标） */
  bounds: Bounds;
}

/**
 * OCR 提供者接口（支持 terminate 的扩展）
 */
interface OCRProvider extends OCRAPI {
  terminate?: () => Promise<void>;
}

type AbortableCDPScreenshotFn = (signal?: AbortSignal) => Promise<string>;

/**
 * 视口内 OCR 服务
 *
 * 专为 Electron webContents 设计：
 * - 使用 capturePage 截图（视口坐标）
 * - 返回的 bounds 是视口坐标
 * - 可直接与 sendInputEvent 配合使用
 * - 支持 CDP fallback（offscreen 模式）
 */
export class ViewportOCRService {
  private cdpScreenshot?: AbortableCDPScreenshotFn;

  constructor(
    private captureAPI: BrowserCaptureAPI,
    private ocrProvider: OCRProvider
  ) {}

  /**
   * 设置 CDP 截图函数（用于 offscreen 模式 fallback）
   */
  setCDPScreenshot(fn: AbortableCDPScreenshotFn): void {
    this.cdpScreenshot = fn;
  }

  /**
   * 获取截图（支持 CDP fallback）
   *
   * 在 offscreen 模式下，Electron capturePage 会失败，
   * 因此优先使用 CDP 截图（如果已配置）。
   *
   * @param region 可选的区域限制
   * @returns 截图 Buffer
   */
  private async getScreenshot(region?: Bounds, signal?: AbortSignal): Promise<Buffer> {
    // 如果配置了 CDP 截图函数，优先使用（支持 offscreen 模式）
    // 注意：CDP 截图不支持 region 参数，只能截取整个视口
    if (this.cdpScreenshot && !region) {
      try {
        console.log('[ViewportOCRService] Using CDP screenshot');
        const base64 = await this.cdpScreenshot(signal);
        return Buffer.from(base64, 'base64');
      } catch (cdpError) {
        console.log('[ViewportOCRService] CDP screenshot failed, trying capturePage:', cdpError);
        // CDP 失败时尝试 capturePage
      }
    }

    // 使用 Electron capturePage（支持 region 参数）
    try {
      return await this.captureAPI.screenshot({ rect: region });
    } catch (error) {
      // 如果有 CDP 函数但上面没用（因为有 region），这里再尝试 CDP
      if (this.cdpScreenshot) {
        console.log('[ViewportOCRService] capturePage failed, falling back to CDP screenshot');
        const base64 = await this.cdpScreenshot(signal);
        return Buffer.from(base64, 'base64');
      }
      throw error;
    }
  }

  /**
   * 识别视口内的文本
   *
   * @param region 可选的区域限制（视口坐标）
   * @param options OCR 选项
   * @returns OCR 结果数组，bounds 为视口坐标
   */
  async recognize(region?: Bounds, options?: ViewportOCROptions): Promise<ViewportOCRResult[]> {
    // 使用 capturePage 截图（支持 CDP fallback）
    const screenshot = await this.getScreenshot(region, options?.signal);
    console.log('[ViewportOCRService] Screenshot obtained, size:', screenshot.length, 'bytes');

    // OCR 识别
    const results = await this.ocrProvider.recognize(screenshot, {
      language: options?.language ?? 'eng+chi_sim',
      minConfidence: options?.minConfidence,
    }, {
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    console.log('[ViewportOCRService] OCR results:', results.length, 'items');

    // 如果有区域限制，调整坐标偏移
    if (region) {
      return results.map((r) => ({
        text: r.text,
        confidence: r.confidence,
        bounds: {
          x: r.bounds.x + region.x,
          y: r.bounds.y + region.y,
          width: r.bounds.width,
          height: r.bounds.height,
        },
      }));
    }

    return results.map((r) => ({
      text: r.text,
      confidence: r.confidence,
      bounds: r.bounds,
    }));
  }

  /**
   * 查找文本，返回视口坐标
   *
   * @param text 要查找的文本
   * @param region 可选的区域限制
   * @returns 文本位置（视口坐标），未找到返回 null
   */
  async findText(
    text: string,
    options?: { region?: Bounds; exactMatch?: boolean; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Bounds | null> {
    const results = await this.recognize(options?.region, {
      exactMatch: options?.exactMatch,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });

    for (const result of results) {
      if (options?.exactMatch ? result.text.trim() === text.trim() : result.text.includes(text)) {
        return result.bounds;
      }
    }

    return null;
  }

  /**
   * 查找所有匹配的文本
   *
   * @param text 要查找的文本
   * @param region 可选的区域限制
   * @returns 所有匹配位置的数组
   */
  async findAllText(
    text: string,
    options?: { region?: Bounds; exactMatch?: boolean; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Bounds[]> {
    const results = await this.recognize(options?.region, {
      exactMatch: options?.exactMatch,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    const matches: Bounds[] = [];

    for (const result of results) {
      if (options?.exactMatch ? result.text.trim() === text.trim() : result.text.includes(text)) {
        matches.push(result.bounds);
      }
    }

    return matches;
  }

  /**
   * 查找文本，返回归一化坐标
   *
   * @param text 要查找的文本
   * @param viewport 视口配置
   * @param region 可选的区域限制
   * @returns 归一化边界 (0-100)，未找到返回 null
   */
  async findTextNormalized(
    text: string,
    viewport: ViewportConfig,
    options?: { region?: Bounds; exactMatch?: boolean; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<NormalizedBounds | null> {
    const bounds = await this.findText(text, options);
    if (!bounds) return null;

    return {
      x: (bounds.x / viewport.width) * 100,
      y: (bounds.y / viewport.height) * 100,
      width: (bounds.width / viewport.width) * 100,
      height: (bounds.height / viewport.height) * 100,
      space: 'normalized',
    };
  }

  /**
   * 等待文本出现
   *
   * @param text 要等待的文本
   * @param options 等待选项
   * @returns 文本位置（视口坐标）
   * @throws TextNotFoundError 如果超时
   */
  async waitForText(
    text: string,
    options?: {
      region?: Bounds;
      timeout?: number;
      interval?: number;
      exactMatch?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<Bounds> {
    const timeout = options?.timeout ?? 30000;
    const interval = options?.interval ?? 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const bounds = await this.findText(text, {
        region: options?.region,
        exactMatch: options?.exactMatch,
        timeoutMs: Math.max(250, Math.min(2000, timeout - (Date.now() - startTime))),
        signal: options?.signal,
      });
      if (bounds) return bounds;
      await sleep(interval);
    }

    throw new TextNotFoundError(text, `Text "${text}" not found after ${timeout}ms`);
  }

  /**
   * 等待文本消失
   *
   * @param text 要等待消失的文本
   * @param options 等待选项
   * @throws TextNotFoundError 如果超时后文本仍存在
   */
  async waitForTextGone(
    text: string,
    options?: {
      region?: Bounds;
      timeout?: number;
      interval?: number;
      exactMatch?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const interval = options?.interval ?? 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const bounds = await this.findText(text, {
        region: options?.region,
        exactMatch: options?.exactMatch,
        timeoutMs: Math.max(250, Math.min(2000, timeout - (Date.now() - startTime))),
        signal: options?.signal,
      });
      if (!bounds) return;
      await sleep(interval);
    }

    throw new TextNotFoundError(text, `Text "${text}" still visible after ${timeout}ms`);
  }

  /**
   * 获取文本中心点（视口坐标）
   *
   * @param text 要查找的文本
   * @param region 可选的区域限制
   * @returns 中心点坐标，未找到返回 null
   */
  async getTextCenter(
    text: string,
    options?: { region?: Bounds; exactMatch?: boolean; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ x: number; y: number } | null> {
    const bounds = await this.findText(text, options);
    if (!bounds) return null;

    return {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    };
  }

  /**
   * 检查文本是否存在
   *
   * @param text 要检查的文本
   * @param region 可选的区域限制
   */
  async textExists(
    text: string,
    options?: { region?: Bounds; exactMatch?: boolean; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<boolean> {
    const bounds = await this.findText(text, options);
    return bounds !== null;
  }

  /**
   * 终止 OCR 服务（清理资源）
   */
  async terminate(): Promise<void> {
    if (this.ocrProvider.terminate) {
      await this.ocrProvider.terminate();
    }
  }
}
