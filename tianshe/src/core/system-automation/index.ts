/**
 * System Automation 模块
 *
 * 提供系统自动化能力：
 * - OCR 识别（基于 PP-OCRv4）
 *
 * @example
 * ```typescript
 * import { getOcrPool } from './system-automation/ocr';
 *
 * const pool = await getOcrPool();
 * const results = await pool.recognize(imageBuffer, { language: 'chi_sim' });
 *
 * for (const result of results) {
 *   console.log(result.text, result.bounds);
 * }
 * ```
 */

// OCR 服务（PP-OCRv4）
export { GutenOCRAdapter } from './ocr/providers/gutenye-adapter';
export { GutenOCRAdapter as DefaultOCRProvider } from './ocr/providers/gutenye-adapter';

// 类型导出
export type { OCROptions, OCRResult, DetailedOCRResult, OCRAPI } from './types';

// 错误类型
export { SystemAutomationError, TextNotFoundError } from './types';
