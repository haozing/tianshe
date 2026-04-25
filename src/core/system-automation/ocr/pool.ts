import type { DetailedOCRResult, OCRAPI, OCROptions, OCRResult, OCRRuntimeOptions } from '../types';
import { GutenOCRAdapter } from './providers/gutenye-adapter';
import { GutenOCRWorkerAdapter } from './providers/gutenye-worker-adapter';
import { AIRPA_RUNTIME_CONFIG } from '../../../constants/runtime-config';

export type OCRPoolQueueMode = 'wait' | 'reject';

export interface GutenOCRPoolOptions {
  size?: number;
  maxQueue?: number;
  queueMode?: OCRPoolQueueMode;
}

type Waiter = {
  resolve: (adapter: OcrAdapter) => void;
  reject: (error: unknown) => void;
  cleanup?: () => void;
};

type OcrAdapter = GutenOCRAdapter | GutenOCRWorkerAdapter;

export class GutenOCRPool implements OCRAPI {
  private size: number;
  private maxQueue: number;
  private queueMode: OCRPoolQueueMode;
  private adapters: OcrAdapter[] = [];
  private free: OcrAdapter[] = [];
  private waiters: Waiter[] = [];
  private disposed = false;
  private warmupPromise: Promise<void> | null = null;

  constructor(options?: GutenOCRPoolOptions) {
    const size = Number(options?.size ?? 1);
    this.size = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1;
    this.maxQueue =
      typeof options?.maxQueue === 'number' && options.maxQueue >= 0
        ? Math.floor(options.maxQueue)
        : this.size * 2;
    this.queueMode = options?.queueMode ?? 'wait';
  }

  async warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      const adapter = this.createAdapter();
      if (!adapter) return;
      await adapter.initialize();
      this.release(adapter);
    })().finally(() => {
      this.warmupPromise = null;
    });
    return this.warmupPromise;
  }

  async recognize(
    image: Buffer | string,
    options?: OCROptions,
    runtimeOptions?: OCRRuntimeOptions
  ): Promise<OCRResult[]> {
    const adapter = await this.acquire(runtimeOptions?.signal);
    try {
      return await adapter.recognize(image, options, runtimeOptions);
    } finally {
      this.release(adapter);
    }
  }

  async recognizeDetailed(
    image: Buffer | string,
    options?: OCROptions,
    runtimeOptions?: OCRRuntimeOptions
  ): Promise<DetailedOCRResult[]> {
    const adapter = await this.acquire(runtimeOptions?.signal);
    try {
      return await adapter.recognizeDetailed(image, options, runtimeOptions);
    } finally {
      this.release(adapter);
    }
  }

  async terminate(): Promise<void> {
    this.disposed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup?.();
      waiter.reject(new Error('OCR pool disposed'));
    }

    const adapters = this.adapters.slice();
    this.adapters = [];
    this.free = [];
    this.waiters = [];

    await Promise.allSettled(adapters.map((adapter) => adapter.terminate()));
  }

  private createAdapter(): OcrAdapter | null {
    if (this.adapters.length >= this.size) {
      return null;
    }

    const forceInProcess = AIRPA_RUNTIME_CONFIG.ocr.adapter === 'inprocess';
    const adapter: OcrAdapter = forceInProcess
      ? new GutenOCRAdapter()
      : new GutenOCRWorkerAdapter();
    this.adapters.push(adapter);
    return adapter;
  }

  private async acquire(signal?: AbortSignal): Promise<OcrAdapter> {
    if (this.disposed) {
      throw new Error('OCR pool disposed');
    }

    if (signal?.aborted) {
      throw signal.reason ?? new Error('OCR pool cancelled');
    }

    const adapter = this.free.pop();
    if (adapter) return adapter;

    const created = this.createAdapter();
    if (created) return created;

    if (this.queueMode === 'reject' && this.waiters.length >= this.maxQueue) {
      throw new Error('OCR pool queue is full');
    }

    return new Promise((resolve, reject) => {
      let cleanup: (() => void) | undefined;
      const waiter: Waiter = {
        resolve: (value) => {
          cleanup?.();
          resolve(value);
        },
        reject: (error) => {
          cleanup?.();
          reject(error);
        },
      };

      this.waiters.push(waiter);

      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.reject(signal.reason ?? new Error('OCR pool cancelled'));
        };
        signal.addEventListener('abort', onAbort);
        cleanup = () => signal.removeEventListener('abort', onAbort);
        waiter.cleanup = cleanup;
      }
    });
  }

  private release(adapter: OcrAdapter): void {
    if (this.disposed) {
      void adapter.terminate();
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.cleanup?.();
      waiter.resolve(adapter);
      return;
    }

    this.free.push(adapter);
  }
}
