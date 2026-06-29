/**
 * OCR engine pool configuration defaults and limits.
 */

export type OCRPoolQueueMode = 'wait' | 'reject';

export interface OCRPoolConfig {
  size: number;
  maxQueue: number;
  queueMode: OCRPoolQueueMode;
}

export const OCR_POOL_LIMITS = {
  size: { min: 1, max: 8 },
  maxQueue: { min: 0, max: 256 },
} as const;

export const DEFAULT_OCR_POOL_CONFIG: OCRPoolConfig = {
  size: 1,
  maxQueue: 2,
  queueMode: 'wait',
};

export function normalizeOcrPoolConfig(input?: Partial<OCRPoolConfig> | null): OCRPoolConfig {
  const rawSize = input?.size ?? DEFAULT_OCR_POOL_CONFIG.size;
  const size = clampInt(rawSize, OCR_POOL_LIMITS.size.min, OCR_POOL_LIMITS.size.max);

  const rawMaxQueue = input?.maxQueue ?? size * 2;
  const maxQueue = clampInt(
    rawMaxQueue,
    OCR_POOL_LIMITS.maxQueue.min,
    OCR_POOL_LIMITS.maxQueue.max
  );

  const queueMode: OCRPoolQueueMode = input?.queueMode === 'reject' ? 'reject' : 'wait';

  return {
    size,
    maxQueue,
    queueMode,
  };
}

function clampInt(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
