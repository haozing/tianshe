import type { OCRAPI, OCROptions, OCRResult } from '../types';
import type { ImagePreprocessPipeline, ImagePreprocessPreset } from './preprocess';
import { applyImagePreprocessPipeline, getDefaultOcrPreprocessPipelines } from './preprocess';

export type OCRPipelineSelectionStrategy = 'combined' | 'chars' | 'confidence';

export interface OCRVariantStats {
  lineCount: number;
  charCount: number;
  nonWhitespaceCharCount: number;
  avgConfidence: number;
}

export interface OCRPipelineVariant {
  pipelineName: string;
  results: OCRResult[];
  stats: OCRVariantStats;
  error?: string;
}

export interface RecognizeWithPipelinesOptions {
  pipelines?: ImagePreprocessPipeline[] | ImagePreprocessPreset;
  selectionStrategy?: OCRPipelineSelectionStrategy;
  preprocessOutputFormat?: 'png' | 'jpeg';
  jpegQuality?: number;
  ocr?: OCROptions;
  /**
   * Optional hook called after each pipeline variant is recognized.
   * Return `true` to stop processing remaining pipelines early.
   */
  onVariant?: (
    variant: OCRPipelineVariant,
    context: { index: number; total: number }
  ) => boolean | void | Promise<boolean | void>;
}

export function computeOcrVariantStats(results: OCRResult[]): OCRVariantStats {
  const lineCount = results.length;
  const charCount = results.reduce((sum, r) => sum + r.text.length, 0);
  const nonWhitespaceCharCount = results.reduce(
    (sum, r) => sum + r.text.replace(/\s+/g, '').length,
    0
  );
  const avgConfidence =
    lineCount === 0 ? 0 : results.reduce((sum, r) => sum + r.confidence, 0) / lineCount;

  return { lineCount, charCount, nonWhitespaceCharCount, avgConfidence };
}

export function scoreOcrVariant(
  stats: OCRVariantStats,
  strategy: OCRPipelineSelectionStrategy
): number {
  switch (strategy) {
    case 'chars':
      return stats.nonWhitespaceCharCount;
    case 'confidence':
      return stats.avgConfidence;
    case 'combined':
    default:
      return stats.nonWhitespaceCharCount + stats.avgConfidence * 0.5 + stats.lineCount * 2;
  }
}

export function selectBestOcrVariant(
  variants: OCRPipelineVariant[],
  strategy: OCRPipelineSelectionStrategy
): OCRPipelineVariant | null {
  let best: OCRPipelineVariant | null = null;
  let bestScore = -Infinity;

  for (const variant of variants) {
    if (variant.error) {
      continue;
    }
    const score = scoreOcrVariant(variant.stats, strategy);
    if (score > bestScore) {
      bestScore = score;
      best = variant;
    }
  }

  return best;
}

export async function recognizeWithPipelines(
  adapter: OCRAPI,
  image: string | Buffer,
  options?: RecognizeWithPipelinesOptions
): Promise<{
  best: OCRResult[];
  bestPipeline: string;
  variants: OCRPipelineVariant[];
}> {
  const pipelinesInput = options?.pipelines ?? 'none';
  const pipelines =
    typeof pipelinesInput === 'string'
      ? getDefaultOcrPreprocessPipelines(pipelinesInput)
      : pipelinesInput;

  const variants: OCRPipelineVariant[] = [];
  for (let i = 0; i < pipelines.length; i++) {
    const pipeline = pipelines[i];
    try {
      const input =
        pipeline.steps.length === 0
          ? image
          : await applyImagePreprocessPipeline(image, pipeline, {
              outputFormat: options?.preprocessOutputFormat,
              jpegQuality: options?.jpegQuality,
            });
      const results = await adapter.recognize(input, options?.ocr);
      variants.push({
        pipelineName: pipeline.name,
        results,
        stats: computeOcrVariantStats(results),
      });
    } catch (error) {
      variants.push({
        pipelineName: pipeline.name,
        results: [],
        stats: computeOcrVariantStats([]),
        error: (error as Error).message || String(error),
      });
    }

    if (typeof options?.onVariant === 'function') {
      try {
        const shouldStop = await options.onVariant(variants[variants.length - 1]!, {
          index: i,
          total: pipelines.length,
        });
        if (shouldStop) break;
      } catch {
        // ignore hook errors, continue processing
      }
    }

    // If the OCR engine itself is failing (e.g. native error codes), continuing to run more pipelines
    // just spams errors and increases memory pressure. Bail out early for this image.
    const last = variants[variants.length - 1];
    if (last?.error && isLikelyFatalOcrEngineError(last.error)) {
      break;
    }
  }

  const strategy = options?.selectionStrategy ?? 'combined';
  const bestVariant = selectBestOcrVariant(variants, strategy) ?? variants[0] ?? null;
  return {
    best: bestVariant?.results ?? [],
    bestPipeline: bestVariant?.pipelineName ?? 'none',
    variants,
  };
}

function isLikelyFatalOcrEngineError(message: string): boolean {
  const msg = String(message || '').trim();
  if (!msg) return false;

  // @gutenye/ocr-node sometimes throws raw numeric codes; our adapter may wrap them but still includes codes.
  if (/^\d{8,}$/.test(msg)) return true;
  if (/ocr engine error/i.test(msg)) return true;
  if (/\bcode=0x[0-9a-f]+\b/i.test(msg)) return true;
  return false;
}
