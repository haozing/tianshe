/**
 * OCR 模块
 *
 * 提供 OCR 识别能力，基于 PP-OCRv4 (onnxruntime-node)
 */

// 默认使用 Gutenye OCR (PP-OCRv4)
export { GutenOCRAdapter } from './providers/gutenye-adapter';
export { GutenOCRAdapter as DefaultOCRProvider } from './providers/gutenye-adapter';
export { GutenOCRPool } from './pool';
export type { GutenOCRPoolOptions, OCRPoolQueueMode } from './pool';
export { getOcrPool, getOcrPoolConfig, resetOcrPool, setOcrPoolConfig } from './pool-manager';

export type {
  ImagePreprocessOptions,
  ImagePreprocessOutputFormat,
  ImagePreprocessPipeline,
  ImagePreprocessPreset,
  ImagePreprocessStep,
} from './preprocess';
export { applyImagePreprocessPipeline, getDefaultOcrPreprocessPipelines } from './preprocess';

export type {
  OCRPipelineSelectionStrategy,
  OCRPipelineVariant,
  OCRVariantStats,
  RecognizeWithPipelinesOptions,
} from './pipeline';
export {
  computeOcrVariantStats,
  recognizeWithPipelines,
  scoreOcrVariant,
  selectBestOcrVariant,
} from './pipeline';
