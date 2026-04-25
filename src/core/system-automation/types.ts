/**
 * OCR 类型定义
 *
 * 提供 OCR 识别相关的类型定义
 */

import type { Bounds } from '../coordinate/types';

// ============================================================================
// OCR 识别
// ============================================================================

/**
 * OCR 选项
 */
export interface OCROptions {
  /** 识别语言，默认 'eng' */
  language?: string;
  /** 字符白名单（只识别这些字符） */
  whitelist?: string;
  /** 页面分割模式 (Tesseract PSM) */
  psm?: number;
  /** 最小置信度阈值 (0-100) */
  minConfidence?: number;
}

export interface OCRRuntimeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * OCR 识别结果
 */
export interface OCRResult {
  /** 识别的文本 */
  text: string;
  /** 置信度 (0-100) */
  confidence: number;
  /** 文本位置 */
  bounds: Bounds;
}

/**
 * 详细 OCR 结果（包含单词级别）
 */
export interface DetailedOCRResult extends OCRResult {
  /** 单词级别结果 */
  words?: Array<{
    text: string;
    confidence: number;
    bounds: Bounds;
  }>;
  /** 行级别结果 */
  lines?: Array<{
    text: string;
    confidence: number;
    bounds: Bounds;
  }>;
}

/**
 * OCR API 接口
 */
export interface OCRAPI {
  /**
   * 识别图像中的文字
   * @param image 图像数据（Buffer）或图像文件路径
   * @param options OCR 选项
   */
  recognize(
    image: Buffer | string,
    options?: OCROptions,
    runtimeOptions?: OCRRuntimeOptions
  ): Promise<OCRResult[]>;
}

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 系统自动化错误基类
 */
export class SystemAutomationError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'SystemAutomationError';
  }
}

/**
 * 文本未找到错误
 */
export class TextNotFoundError extends SystemAutomationError {
  constructor(
    public readonly searchText: string,
    message?: string
  ) {
    super(message ?? `Text "${searchText}" not found`, 'TEXT_NOT_FOUND');
    this.name = 'TextNotFoundError';
  }
}
