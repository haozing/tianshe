import { createLogger } from '../../logger';
import type { OCRPoolConfig } from '../../../constants/ocr-pool';
import { DEFAULT_OCR_POOL_CONFIG, normalizeOcrPoolConfig } from '../../../constants/ocr-pool';
import { GutenOCRPool } from './pool';

const logger = createLogger('OCRPoolManager');

let pool: GutenOCRPool | null = null;
let initPromise: Promise<GutenOCRPool> | null = null;
let resetPromise: Promise<void> | null = null;
let poolConfig: OCRPoolConfig = DEFAULT_OCR_POOL_CONFIG;

function isSameConfig(next: OCRPoolConfig, current: OCRPoolConfig): boolean {
  return (
    next.size === current.size &&
    next.maxQueue === current.maxQueue &&
    next.queueMode === current.queueMode
  );
}

export function getOcrPoolConfig(): OCRPoolConfig {
  return { ...poolConfig };
}

export async function setOcrPoolConfig(
  input: Partial<OCRPoolConfig> | OCRPoolConfig,
  options?: { reset?: boolean; warmup?: boolean }
): Promise<OCRPoolConfig> {
  const normalized = normalizeOcrPoolConfig(input);
  const changed = !isSameConfig(normalized, poolConfig);
  poolConfig = normalized;

  const shouldReset = options?.reset ?? (changed && Boolean(pool));
  if (shouldReset) {
    await resetOcrPool();
  }

  if (options?.warmup) {
    await getOcrPool();
  }

  return getOcrPoolConfig();
}

export async function getOcrPool(): Promise<GutenOCRPool> {
  if (resetPromise) {
    await resetPromise;
  }

  if (pool) return pool;

  if (!initPromise) {
    initPromise = (async () => {
      const { size, maxQueue, queueMode } = poolConfig;
      logger.info(
        `[OCRPool] Initializing OCR engine pool (size=${size}, maxQueue=${maxQueue}, queueMode=${queueMode})...`
      );
      pool = new GutenOCRPool({ size, maxQueue, queueMode });
      await pool.warmup();
      logger.info('[OCRPool] OCR engine pool initialized');
      return pool;
    })().finally(() => {
      initPromise = null;
    });
  }

  return initPromise;
}

export async function resetOcrPool(options?: { cooldownMs?: number }): Promise<void> {
  if (resetPromise) {
    return resetPromise;
  }

  resetPromise = (async () => {
    const init = initPromise;
    if (init) {
      try {
        await init;
      } catch {
        // ignore init errors, we'll still clear/terminate below
      }
    }

    const current = pool;
    initPromise = null;

    if (current) {
      try {
        await current.terminate();
      } catch (error) {
        logger.debug('[OCRPool] OCR pool terminate failed:', error);
      }
    }

    pool = null;

    const cooldownMs = Number(options?.cooldownMs ?? 0) || 0;
    if (cooldownMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, cooldownMs));
    }

    logger.debug('[OCRPool] OCR engine pool reset');
  })().finally(() => {
    resetPromise = null;
  });

  return resetPromise;
}
