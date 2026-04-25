import { describe, expect, it, vi } from 'vitest';
import { TextNotFoundError } from '../system-automation/types';
import {
  findTextUsingStrategy,
  isRecoverableTextLookupError,
  toTextMatchNormalizedResult,
  waitForTextUsingStrategy,
} from './text-query-runtime';

describe('text-query-runtime', () => {
  it('skips OCR fallback for short auto wait budgets', async () => {
    const result = await waitForTextUsingStrategy(
      'Example Domain',
      { strategy: 'auto', timeoutMs: 150 },
      {
        findTextInDom: vi.fn().mockResolvedValue(null),
        findTextInOcr: vi.fn(),
        waitForTextInOcr: vi.fn(),
      }
    );

    expect(result).toEqual({
      bounds: null,
      strategy: 'none',
      timedOut: true,
    });
  });

  it('treats recoverable OCR lookup failures as soft misses for auto strategy', async () => {
    const result = await findTextUsingStrategy(
      'Dashboard',
      { strategy: 'auto', timeoutMs: 5000 },
      {
        findTextInDom: vi.fn().mockResolvedValue(null),
        findTextInOcr: vi.fn().mockRejectedValue(new Error('capturePage surface unavailable')),
      }
    );

    expect(result).toEqual({
      bounds: null,
      strategy: 'none',
    });
    expect(isRecoverableTextLookupError(new Error('capturePage surface unavailable'))).toBe(true);
  });

  it('maps viewport bounds into normalized match results', () => {
    const result = toTextMatchNormalizedResult(
      {
        width: 200,
        height: 100,
        aspectRatio: 2,
        devicePixelRatio: 1,
      },
      {
        bounds: { x: 50, y: 25, width: 40, height: 20 },
        strategy: 'ocr',
      }
    );

    expect(result).toEqual({
      normalizedBounds: {
        x: 25,
        y: 25,
        width: 20,
        height: 20,
        space: 'normalized',
      },
      matchSource: 'ocr',
    });
  });

  it('returns OCR timedOut results when waitForText exhausts the remaining budget', async () => {
    const result = await waitForTextUsingStrategy(
      'Checkout',
      { strategy: 'ocr', timeoutMs: 800 },
      {
        findTextInDom: vi.fn(),
        findTextInOcr: vi.fn(),
        waitForTextInOcr: vi
          .fn()
          .mockRejectedValue(new TextNotFoundError('Checkout', 'timed out waiting for OCR')),
      }
    );

    expect(result).toEqual({
      bounds: null,
      strategy: 'ocr',
      timedOut: true,
    });
  });
});
