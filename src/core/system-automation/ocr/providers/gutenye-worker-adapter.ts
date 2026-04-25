import type { Bounds } from '../../../coordinate/types';
import type { DetailedOCRResult, OCRAPI, OCROptions, OCRResult, OCRRuntimeOptions } from '../../types';
import { createLogger } from '../../../logger';
import { applyImagePreprocessPipeline, type ImagePreprocessPipeline } from '../preprocess';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { AIRPA_RUNTIME_CONFIG } from '../../../../constants/runtime-config';

const logger = createLogger('GutenOCRWorkerAdapter');

type OcrDetectResult = Array<{
  text: string;
  mean: number;
  box: [[number, number], [number, number], [number, number], [number, number]];
}>;

type ReadyMessage = { type: 'ready' };

type WorkerErrorPayload = {
  message: string;
  stack?: string;
  code?: number;
  rawType?: string;
  rawValue?: string;
};

type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: WorkerErrorPayload };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

const STABILITY_RETRY_PIPELINE: ImagePreprocessPipeline = {
  name: 'stability/resize960',
  steps: [
    { op: 'flatten', background: '#ffffff' },
    { op: 'resize', width: 960, height: 960, fit: 'inside', withoutEnlargement: true },
  ],
};

export class GutenOCRWorkerAdapter implements OCRAPI {
  private worker: Worker | null = null;
  private workerPath: string;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private reqSeq = 0;
  private disposed = false;

  private initPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private resetPromise: Promise<void> | null = null;
  private lastResetAtMs = 0;
  private serial: Promise<void> = Promise.resolve();

  private async withRuntimeGuards<T>(
    task: () => Promise<T>,
    runtimeOptions?: OCRRuntimeOptions
  ): Promise<T> {
    if (runtimeOptions?.signal?.aborted) {
      throw runtimeOptions.signal.reason ?? new Error('OCR recognition cancelled');
    }

    const taskPromise = task();
    const pending: Array<Promise<T>> = [taskPromise];

    if (typeof runtimeOptions?.timeoutMs === 'number' && runtimeOptions.timeoutMs > 0) {
      pending.push(
        new Promise<T>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(`OCR recognition timed out after ${runtimeOptions.timeoutMs}ms`)
              ),
            runtimeOptions.timeoutMs
          );
        })
      );
    }

    if (runtimeOptions?.signal) {
      pending.push(
        new Promise<T>((_, reject) => {
          const onAbort = () =>
            reject(runtimeOptions.signal?.reason ?? new Error('OCR recognition cancelled'));
          runtimeOptions.signal?.addEventListener('abort', onAbort, { once: true });
        })
      );
    }

    return Promise.race(pending);
  }

  constructor() {
    this.workerPath = this.resolveWorkerEntrypoint();
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.ensureWorker();
      await this.callWorker('init');
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async recognize(
    image: Buffer | string,
    options?: OCROptions,
    runtimeOptions?: OCRRuntimeOptions
  ): Promise<OCRResult[]> {
    return this.withRuntimeGuards(() => this.runExclusive(async () => {
      let retryImage: Buffer | string | null = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.initialize();
          const input = attempt === 0 ? image : (retryImage ?? image);
          const raw = (await this.callWorker('detect', { image: input })) as OcrDetectResult;
          const converted = this.convertResult(raw, options?.minConfidence);
          this.consecutiveFailures = 0;
          return converted;
        } catch (error) {
          this.consecutiveFailures += 1;
          const normalized = this.normalizeOcrError(error);
          const isFatal = this.isFatalOcrError(error);
          const code = this.extractNumericCode(error);

          if (attempt === 0 && isFatal && !retryImage) {
            try {
              retryImage = await applyImagePreprocessPipeline(image, STABILITY_RETRY_PIPELINE, {
                outputFormat: 'png',
              });
            } catch {
              retryImage = null;
            }
          }

          if (attempt === 0 && isFatal) {
            await this.dumpFatalInputIfEnabled(code, image);
          }

          const willReset =
            attempt === 0 &&
            (isFatal || this.consecutiveFailures >= 3) &&
            (await this.tryResetEngine({ force: isFatal }));

          logger.error('OCR recognition failed (worker):', {
            message: normalized.message,
            stack: normalized.stack,
            fatal: isFatal,
            code: typeof code === 'number' ? code : undefined,
            consecutiveFailures: this.consecutiveFailures,
            attemptedReset: willReset,
          });

          if (attempt === 0 && (willReset || retryImage)) {
            continue;
          }

          throw normalized;
        }
      }

      // unreachable
      return [];
    }), runtimeOptions);
  }

  async recognizeDetailed(
    image: Buffer | string,
    options?: OCROptions,
    runtimeOptions?: OCRRuntimeOptions
  ): Promise<DetailedOCRResult[]> {
    return this.withRuntimeGuards(() => this.runExclusive(async () => {
      let retryImage: Buffer | string | null = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.initialize();
          const input = attempt === 0 ? image : (retryImage ?? image);
          const raw = (await this.callWorker('detect', { image: input })) as OcrDetectResult;
          this.consecutiveFailures = 0;
          return this.convertDetailedResult(raw, options?.minConfidence);
        } catch (error) {
          this.consecutiveFailures += 1;
          const normalized = this.normalizeOcrError(error);
          const isFatal = this.isFatalOcrError(error);
          const code = this.extractNumericCode(error);

          if (attempt === 0 && isFatal && !retryImage) {
            try {
              retryImage = await applyImagePreprocessPipeline(image, STABILITY_RETRY_PIPELINE, {
                outputFormat: 'png',
              });
            } catch {
              retryImage = null;
            }
          }

          if (attempt === 0 && isFatal) {
            await this.dumpFatalInputIfEnabled(code, image);
          }

          const willReset =
            attempt === 0 &&
            (isFatal || this.consecutiveFailures >= 3) &&
            (await this.tryResetEngine({ force: isFatal }));

          logger.error('OCR recognitionDetailed failed (worker):', {
            message: normalized.message,
            stack: normalized.stack,
            fatal: isFatal,
            code: typeof code === 'number' ? code : undefined,
            consecutiveFailures: this.consecutiveFailures,
            attemptedReset: willReset,
          });

          if (attempt === 0 && (willReset || retryImage)) {
            continue;
          }

          throw normalized;
        }
      }

      // unreachable
      return [];
    }), runtimeOptions);
  }

  async terminate(): Promise<void> {
    this.disposed = true;
    await this.runExclusive(async () => {
      await this.terminateWorker();
    });
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.serial.then(task, task);
    this.serial = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private resolveWorkerEntrypoint(): string {
    const relative = path.join(__dirname, '..', 'ocr-worker.js');
    const candidates: string[] = [relative];

    if (relative.includes('app.asar')) {
      candidates.push(relative.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1'));
      candidates.push(relative.replace('app.asar', 'app.asar.unpacked'));
    }

    const resourcesPath = (process as any).resourcesPath;
    if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
      candidates.push(
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'dist',
          'core',
          'system-automation',
          'ocr',
          'ocr-worker.js'
        )
      );
    }

    candidates.push(
      path.join(process.cwd(), 'dist', 'core', 'system-automation', 'ocr', 'ocr-worker.js')
    );

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // ignore
      }
    }

    logger.warn(`OCR worker entry not found on disk, using: ${relative}`);
    return relative;
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.ready) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      if (this.worker) {
        await this.terminateWorker();
      }

      this.ready = false;

      const w = new Worker(this.workerPath);
      this.worker = w;

      w.on('message', (m: ReadyMessage | WorkerResponse) => {
        if (m && typeof m === 'object' && (m as ReadyMessage).type === 'ready') {
          this.ready = true;
          return;
        }

        const msg = m as WorkerResponse;
        if (!msg?.id) return;

        const p = this.pending.get(msg.id);
        if (!p || p.settled) return;
        p.settled = true;
        this.pending.delete(msg.id);

        if (msg.ok) {
          p.resolve(msg.result);
        } else {
          const err = new Error(msg.error?.message || 'OCR worker error');
          if (msg.error?.stack) err.stack = msg.error.stack;
          (err as any).code = msg.error?.code;
          (err as any).workerError = msg.error;
          p.reject(err);
        }
      });

      const onWorkerFailure = (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.cleanupWorker(err);
      };

      w.on('error', onWorkerFailure);
      w.on('exit', (code) => onWorkerFailure(new Error(`OCR worker exited code=${code}`)));

      // Wait for ready (best-effort; if missing, still proceed after a short delay)
      const deadline = Date.now() + 15_000;
      while (!this.ready) {
        if (this.disposed) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    })().finally(() => {
      this.readyPromise = null;
    });

    return this.readyPromise;
  }

  private cleanupWorker(error: Error): void {
    if (!this.worker) return;
    const w = this.worker;
    this.worker = null;
    this.ready = false;

    for (const [id, pending] of Array.from(this.pending.entries())) {
      if (pending.settled) continue;
      pending.settled = true;
      pending.reject(error);
      this.pending.delete(id);
    }

    try {
      w.removeAllListeners();
    } catch {
      // ignore
    }
  }

  private async terminateWorker(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.ready = false;

    if (w) {
      try {
        await w.terminate();
      } catch {
        // ignore
      }
    }
  }

  private nextId(): string {
    this.reqSeq += 1;
    return `ocrw_${process.pid}_${Date.now()}_${this.reqSeq}_${Math.random().toString(16).slice(2, 10)}`;
  }

  private async callWorker(
    op: 'ping' | 'init' | 'reset' | 'detect',
    payload?: any
  ): Promise<unknown> {
    await this.ensureWorker();
    if (!this.worker) {
      throw new Error('OCR worker is not available');
    }

    const id = this.nextId();
    const w = this.worker;

    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, settled: false };
      this.pending.set(id, pending);

      try {
        w.postMessage({ id, op, ...(payload ? { payload } : {}) });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private normalizeOcrError(error: unknown): Error {
    if (error instanceof Error) {
      const code = this.extractNumericCode(error);
      if (typeof code === 'number' && !/code=0x/i.test(error.message || '')) {
        const msg = error.message || 'OCR worker error';
        return new Error(`OCR engine error (code=${code} / 0x${code.toString(16)}): ${msg}`);
      }
      return error;
    }

    const code = this.extractNumericCode(error);
    const codeText = typeof code === 'number' ? ` (code=${code} / 0x${code.toString(16)})` : '';
    return new Error(`OCR engine error${codeText}: ${this.safeStringifyUnknown(error)}`);
  }

  private isFatalOcrError(error: unknown): boolean {
    if (typeof this.extractNumericCode(error) === 'number') return true;

    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : (error as { message?: unknown } | null)?.message;

    return typeof message === 'string' && /invalid array length/i.test(message);
  }

  private extractNumericCode(error: unknown): number | null {
    if (typeof error === 'number' && Number.isFinite(error)) return error;
    if (typeof error === 'string' && /^\d+$/.test(error)) return Number.parseInt(error, 10);

    if (error && typeof error === 'object') {
      const asAny = error as Record<string, unknown>;
      const code = asAny.code;
      if (typeof code === 'number' && Number.isFinite(code)) return code;
      const data = asAny.data;
      if (typeof data === 'number' && Number.isFinite(data)) return data;
      const message = asAny.message;
      if (typeof message === 'string' && /^\d+$/.test(message)) return Number.parseInt(message, 10);
    }

    return null;
  }

  private safeStringifyUnknown(value: unknown): string {
    try {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
      }
      if (value === null || value === undefined) return String(value);
      if (value instanceof Error) return value.message || String(value);
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private async tryResetEngine(options?: { force?: boolean }): Promise<boolean> {
    const now = Date.now();
    if (!options?.force && now - this.lastResetAtMs < 15_000) {
      return false;
    }
    this.lastResetAtMs = now;

    if (this.resetPromise) {
      try {
        await this.resetPromise;
        return true;
      } catch {
        return false;
      }
    }

    this.resetPromise = (async () => {
      // Terminate the worker to ensure native/WASM memory is released, then spawn a new one.
      await this.terminateWorker();
      await this.ensureWorker();
      await this.callWorker('init');
    })().finally(() => {
      this.resetPromise = null;
    });

    try {
      await this.resetPromise;
      return true;
    } catch {
      return false;
    }
  }

  private async dumpFatalInputIfEnabled(
    code: number | null,
    input: Buffer | string
  ): Promise<void> {
    const dumpDir = AIRPA_RUNTIME_CONFIG.ocr.dumpDir.trim();
    if (!dumpDir) return;

    try {
      fs.mkdirSync(dumpDir, { recursive: true });
    } catch {
      return;
    }

    const timestamp = Date.now();
    const base = `ocr-fatal-${timestamp}-${Math.random().toString(16).slice(2, 10)}`;
    const metaPath = path.join(dumpDir, `${base}.json`);

    const meta = {
      at: new Date(timestamp).toISOString(),
      code: code ?? undefined,
      inputType: typeof input,
      inputSize: typeof input === 'string' ? input.length : input.length,
      inputPath: typeof input === 'string' ? input : undefined,
    };

    if (Buffer.isBuffer(input)) {
      const ext = guessImageExtension(input);
      const binPath = path.join(dumpDir, `${base}.${ext}`);
      try {
        fs.writeFileSync(binPath, input);
        (meta as any).dumpedFile = binPath;
      } catch {
        // ignore
      }
    } else if (typeof input === 'string') {
      try {
        const ext = path.extname(input).replace('.', '') || 'img';
        const copyPath = path.join(dumpDir, `${base}${path.extname(input) || `.${ext}`}`);
        fs.copyFileSync(input, copyPath);
        (meta as any).dumpedFile = copyPath;
      } catch {
        // ignore
      }
    }

    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  private convertResult(result: OcrDetectResult, minConfidence?: number): OCRResult[] {
    const threshold = minConfidence ?? 0;
    const results: OCRResult[] = [];

    if (!result || !Array.isArray(result)) {
      logger.debug('OCR result is not an array', { resultType: typeof result });
      return results;
    }

    for (const item of result) {
      const confidence = Number(item?.mean ?? 0) * 100;
      if (confidence < threshold) continue;

      results.push({
        text: String(item?.text ?? '').trim(),
        confidence,
        bounds: this.boxToBounds(item.box as any),
      });
    }

    return results;
  }

  private convertDetailedResult(
    result: OcrDetectResult,
    minConfidence?: number
  ): DetailedOCRResult[] {
    const threshold = minConfidence ?? 0;
    const results: DetailedOCRResult[] = [];

    if (!result || !Array.isArray(result)) {
      logger.debug('OCR result is not an array', { resultType: typeof result });
      return results;
    }

    for (const item of result) {
      const confidence = Number(item?.mean ?? 0) * 100;
      if (confidence < threshold) continue;

      const bounds = this.boxToBounds(item.box as any);
      const text = String(item?.text ?? '').trim();

      results.push({
        text,
        confidence,
        bounds,
        lines: [
          {
            text,
            confidence,
            bounds,
          },
        ],
        words: undefined,
      });
    }

    return results;
  }

  private boxToBounds(
    box: [[number, number], [number, number], [number, number], [number, number]]
  ): Bounds {
    const [topLeft, topRight, bottomRight, bottomLeft] = box;
    const minX = Math.min(topLeft[0], bottomLeft[0]);
    const maxX = Math.max(topRight[0], bottomRight[0]);
    const minY = Math.min(topLeft[1], topRight[1]);
    const maxY = Math.max(bottomLeft[1], bottomRight[1]);

    return {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
    };
  }
}

function guessImageExtension(buffer: Buffer): string {
  if (buffer.length >= 8) {
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return 'png';
    }
  }

  if (buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpg';
    }
  }

  return 'bin';
}
