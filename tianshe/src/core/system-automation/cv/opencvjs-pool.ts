import path from 'path';
import fs from 'fs';
import { Worker } from 'worker_threads';
import os from 'os';
import { createLogger } from '../../logger';
import { createTaskQueue, type TaskQueue } from '../../task-manager/queue';
import type { CropResult, FindCropsOptions, RGBAImage } from './types';

const logger = createLogger('OpenCVJsPool');

type Pending = {
  worker: Worker;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
};

type ReadyMessage = { type: 'ready' };

type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { message: string; stack?: string } };

export interface OpenCVJsPoolOptions {
  workers?: number;
  timeoutMs?: number;
  hardTimeoutMs?: number;
  maxQueue?: number;
  queueMode?: 'wait' | 'reject';
}

type OpenCVTaskOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  hardTimeoutMs?: number;
};

export class OpenCVJsPool {
  private workers: Worker[] = [];
  private ready = new Set<Worker>();
  private pending = new Map<string, Pending>();
  private queue: TaskQueue;

  private freeWorkers: Worker[] = [];
  private waiters: Array<{ resolve: (w: Worker) => void; reject: (err: unknown) => void }> = [];
  private busyWorkers = new Set<Worker>();
  private stoppedWorkers = new Set<Worker>();
  private queueWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private inFlight = 0;
  private maxQueue = 0;
  private queueMode: 'wait' | 'reject' = 'wait';

  private workerPath: string;
  private disposed = false;
  private failed = false;
  private defaultTimeoutMs?: number;
  private defaultHardTimeoutMs?: number;

  constructor(options?: OpenCVJsPoolOptions) {
    const cpuCount = Math.max(1, os.cpus()?.length || 1);
    const desired = options?.workers ?? Math.min(4, cpuCount);
    const workerCount = Math.max(1, Math.min(8, desired));

    this.workerPath = this.resolveWorkerEntrypoint();
    this.defaultTimeoutMs = options?.timeoutMs;
    this.defaultHardTimeoutMs = options?.hardTimeoutMs;
    this.maxQueue = typeof options?.maxQueue === 'number' ? options.maxQueue : workerCount * 2;
    this.queueMode = options?.queueMode ?? 'wait';
    this.queue = createTaskQueue({ name: 'OpenCVJsPool', concurrency: workerCount });
    this.spawn(workerCount);
  }

  private resolveWorkerEntrypoint(): string {
    const relative = path.join(__dirname, 'opencvjs-worker.js');

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
          'cv',
          'opencvjs-worker.js'
        )
      );
    }

    candidates.push(
      path.join(process.cwd(), 'dist', 'core', 'system-automation', 'cv', 'opencvjs-worker.js')
    );

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // ignore
      }
    }

    logger.warn(`OpenCV worker entry not found on disk, using: ${relative}`);
    return relative;
  }

  private spawn(count: number): void {
    for (let i = 0; i < count; i++) {
      this.spawnOne();
    }
  }

  private spawnOne(): void {
    let w: Worker;
    try {
      w = new Worker(this.workerPath);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to spawn OpenCV worker:', err);
      if (this.workers.length === 0) {
        this.failed = true;
        this.rejectWaiters(err);
        this.rejectQueueWaiters(err);
      }
      return;
    }

    this.workers.push(w);

    w.on('message', (m: ReadyMessage | WorkerResponse) => {
      if (m && typeof m === 'object' && (m as ReadyMessage).type === 'ready') {
        this.markWorkerReady(w);
        return;
      }

      const msg = m as WorkerResponse;
      if (!msg?.id) return;

      try {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok) {
            p.resolve(msg.result);
          } else {
            const err = new Error(msg.error?.message || 'OpenCV worker error');
            if (msg.error?.stack) err.stack = msg.error.stack;
            p.reject(err);
          }
        }
      } finally {
        this.releaseWorker(w);
      }
    });

    w.on('error', (err) => {
      logger.error('Worker error:', err);
      this.cleanupWorker(w, err instanceof Error ? err : new Error(String(err)));
    });

    w.on('exit', (code) => {
      const err = new Error(`Worker exited code=${code}`);
      logger.warn(`Worker exited code=${code}`);
      this.cleanupWorker(w, err);
    });
  }

  private cleanupWorker(w: Worker, error: Error): void {
    if (this.stoppedWorkers.has(w)) return;
    this.stoppedWorkers.add(w);

    const wasReady = this.ready.has(w);
    this.ready.delete(w);
    this.busyWorkers.delete(w);
    this.freeWorkers = this.freeWorkers.filter((x) => x !== w);
    this.workers = this.workers.filter((x) => x !== w);

    for (const [id, pending] of Array.from(this.pending.entries())) {
      if (pending.worker !== w) continue;
      pending.reject(error);
      this.pending.delete(id);
    }

    if (!this.disposed && wasReady) {
      this.spawnOne();
    }

    if (!this.disposed && this.workers.length === 0) {
      this.failed = true;
      this.rejectWaiters(error);
      this.rejectQueueWaiters(error);
    }
  }

  private acquireWorker(signal?: AbortSignal): Promise<Worker> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Cancelled'));
    }

    const w = this.freeWorkers.pop();
    if (w) {
      this.busyWorkers.add(w);
      return Promise.resolve(w);
    }

    if (this.disposed || this.failed || this.workers.length === 0) {
      return Promise.reject(new Error('OpenCV worker pool is not available'));
    }

    return new Promise((resolve, reject) => {
      let cleanup: (() => void) | undefined;
      const cleanupOnce = () => {
        if (!cleanup) return;
        const fn = cleanup;
        cleanup = undefined;
        fn();
      };

      const waiter = {
        resolve: (worker: Worker) => {
          cleanupOnce();
          this.busyWorkers.add(worker);
          resolve(worker);
        },
        reject: (err: unknown) => {
          cleanupOnce();
          reject(err);
        },
      };

      this.waiters.push(waiter);

      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          waiter.reject(signal.reason ?? new Error('Cancelled'));
        };
        signal.addEventListener('abort', onAbort);
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    });
  }

  private markWorkerReady(w: Worker): void {
    this.ready.add(w);
    this.dispatchWorker(w);
  }

  private releaseWorker(w: Worker): void {
    if (!this.ready.has(w)) return;
    if (!this.busyWorkers.has(w)) return;
    this.busyWorkers.delete(w);
    this.dispatchWorker(w);
  }

  private dispatchWorker(w: Worker): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      this.busyWorkers.add(w);
      waiter.resolve(w);
      return;
    }
    this.freeWorkers.push(w);
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private rejectQueueWaiters(error: Error): void {
    const waiters = this.queueWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  async ping(signal?: AbortSignal): Promise<{ pong: boolean; pid: number }> {
    return this.queue.add(
      async ({ signal: taskSignal }) => {
        const w = await this.acquireWorker(taskSignal);
        return (await this.callWorker(w, { op: 'ping' }, taskSignal)) as {
          pong: boolean;
          pid: number;
        };
      },
      { signal }
    );
  }

  private normalizeTaskOptions(
    signalOrOptions?: AbortSignal | OpenCVTaskOptions
  ): OpenCVTaskOptions {
    if (!signalOrOptions) return {};
    if (typeof (signalOrOptions as AbortSignal).aborted === 'boolean') {
      return { signal: signalOrOptions as AbortSignal };
    }
    return signalOrOptions as OpenCVTaskOptions;
  }

  async findCrops(
    image: RGBAImage,
    options?: FindCropsOptions,
    signalOrOptions?: AbortSignal | OpenCVTaskOptions
  ): Promise<CropResult[]> {
    const taskOptions = this.normalizeTaskOptions(signalOrOptions);
    const timeoutMs = taskOptions.timeoutMs ?? this.defaultTimeoutMs;
    const hardTimeoutMs = taskOptions.hardTimeoutMs ?? this.defaultHardTimeoutMs;

    await this.reserveQueueSlot(taskOptions.signal);

    try {
      const taskPromise = this.queue.add(
        async ({ signal: taskSignal }) => {
          const w = await this.acquireWorker(taskSignal);
          const data = new Uint8Array(image.data);
          const buffer = data.buffer;
          const payload = {
            image: {
              width: image.width,
              height: image.height,
              data: buffer,
              byteOffset: 0,
              byteLength: data.byteLength,
            },
            options,
          };
          return (await this.callWorker(
            w,
            { op: 'findCrops', payload },
            taskSignal,
            [buffer],
            hardTimeoutMs
          )) as CropResult[];
        },
        { signal: taskOptions.signal, timeout: timeoutMs }
      );
      taskPromise.finally(() => this.releaseQueueSlot());
      return taskPromise;
    } catch (error) {
      this.releaseQueueSlot();
      throw error;
    }
  }

  private callWorker(
    w: Worker,
    message: Record<string, unknown>,
    signal?: AbortSignal,
    transfer?: ArrayBuffer[],
    hardTimeoutMs?: number
  ): Promise<unknown> {
    const id = `cv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const msg = { id, ...message };

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Cancelled'));
        this.releaseWorker(w);
        return;
      }

      let cleanup: (() => void) | undefined;
      let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const clearHardTimeout = () => {
        if (!hardTimeoutId) return;
        clearTimeout(hardTimeoutId);
        hardTimeoutId = undefined;
      };

      const cleanupOnce = () => {
        if (!cleanup) return;
        const fn = cleanup;
        cleanup = undefined;
        fn();
        clearHardTimeout();
      };

      const entry: Pending = {
        worker: w,
        settled: false,
        resolve: (value) => {
          if (entry.settled) return;
          entry.settled = true;
          cleanupOnce();
          resolve(value);
        },
        reject: (reason) => {
          if (entry.settled) return;
          entry.settled = true;
          cleanupOnce();
          reject(reason);
        },
      };

      // Ensure we always detach AbortSignal listeners when the task settles.
      this.pending.set(id, entry);

      if (signal) {
        const onAbort = () => {
          // Keep the pending entry so the worker is released when it finishes.
          entry.reject(signal.reason ?? new Error('Cancelled'));
        };
        signal.addEventListener('abort', onAbort);
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }

      if (typeof hardTimeoutMs === 'number' && hardTimeoutMs > 0) {
        hardTimeoutId = setTimeout(() => {
          if (entry.settled) return;
          const err = new Error(`OpenCV worker hard timeout after ${hardTimeoutMs}ms`);
          this.pending.delete(id);
          entry.reject(err);
          this.hardTerminateWorker(w, err);
        }, hardTimeoutMs);
      }

      try {
        if (transfer?.length) {
          w.postMessage(msg, transfer);
        } else {
          w.postMessage(msg);
        }
      } catch (e) {
        cleanupOnce();
        this.pending.delete(id);
        this.releaseWorker(w);
        reject(e);
      }
    });
  }

  private hardTerminateWorker(w: Worker, error: Error): void {
    this.cleanupWorker(w, error);
    try {
      void w.terminate();
    } catch {
      // ignore
    }
  }

  private async reserveQueueSlot(signal?: AbortSignal): Promise<void> {
    if (this.maxQueue <= 0) {
      this.inFlight += 1;
      return;
    }

    if (signal?.aborted) {
      throw signal.reason ?? new Error('Cancelled');
    }

    if (this.disposed || this.failed || this.workers.length === 0) {
      throw new Error('OpenCV worker pool is not available');
    }

    if (this.inFlight < this.maxQueue) {
      this.inFlight += 1;
      return;
    }

    if (this.queueMode === 'reject') {
      throw new Error('OpenCV worker queue is full');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let cleanup: (() => void) | undefined;
      const cleanupOnce = () => {
        if (!cleanup) return;
        const fn = cleanup;
        cleanup = undefined;
        fn();
      };

      const waiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanupOnce();
          resolve();
        },
        reject: (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanupOnce();
          reject(err);
        },
      };

      this.queueWaiters.push(waiter);

      if (signal) {
        const onAbort = () => {
          const index = this.queueWaiters.indexOf(waiter);
          if (index >= 0) {
            this.queueWaiters.splice(index, 1);
          }
          waiter.reject(signal.reason ?? new Error('Cancelled'));
        };
        signal.addEventListener('abort', onAbort);
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    });
  }

  private releaseQueueSlot(): void {
    if (this.maxQueue <= 0) return;

    this.inFlight = Math.max(0, this.inFlight - 1);
    const waiter = this.queueWaiters.shift();
    if (!waiter) return;
    this.inFlight += 1;
    waiter.resolve();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const disposeError = new Error('OpenCV worker pool disposed');
    try {
      this.queue.stop();
    } catch {
      // ignore
    }

    this.rejectWaiters(disposeError);
    this.rejectQueueWaiters(disposeError);
    for (const [id, pending] of Array.from(this.pending.entries())) {
      pending.reject(disposeError);
      this.pending.delete(id);
    }

    for (const w of this.workers) {
      try {
        await w.terminate();
      } catch {
        // ignore
      }
    }
    this.workers = [];
    this.ready.clear();
    this.busyWorkers.clear();
    this.stoppedWorkers.clear();
    this.freeWorkers = [];
    this.waiters = [];
    this.queueWaiters = [];
    this.inFlight = 0;
    this.pending.clear();
  }
}

let _pool: OpenCVJsPool | null = null;

export function getOpenCVJsPool(options?: OpenCVJsPoolOptions): OpenCVJsPool {
  if (_pool) return _pool;
  _pool = new OpenCVJsPool(options);
  return _pool;
}
