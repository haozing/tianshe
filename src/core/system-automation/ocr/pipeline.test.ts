import { describe, it, expect } from 'vitest';
import { computeOcrVariantStats, selectBestOcrVariant } from './pipeline';
import type { OCRPipelineVariant } from './pipeline';

describe('OCR pipeline selection', () => {
  it('selects variant with most chars by default scoring', () => {
    const v1: OCRPipelineVariant = {
      pipelineName: 'a',
      results: [{ text: 'abc', confidence: 50, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
      stats: computeOcrVariantStats([
        { text: 'abc', confidence: 50, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      ]),
    };
    const v2: OCRPipelineVariant = {
      pipelineName: 'b',
      results: [{ text: 'abcdef', confidence: 40, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
      stats: computeOcrVariantStats([
        { text: 'abcdef', confidence: 40, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      ]),
    };

    const best = selectBestOcrVariant([v1, v2], 'chars');
    expect(best?.pipelineName).toBe('b');
  });

  it('ignores errored variants', () => {
    const ok: OCRPipelineVariant = {
      pipelineName: 'ok',
      results: [{ text: 'x', confidence: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
      stats: computeOcrVariantStats([
        { text: 'x', confidence: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      ]),
    };
    const bad: OCRPipelineVariant = {
      pipelineName: 'bad',
      results: [],
      stats: computeOcrVariantStats([]),
      error: 'boom',
    };

    const best = selectBestOcrVariant([bad, ok], 'combined');
    expect(best?.pipelineName).toBe('ok');
  });
});
