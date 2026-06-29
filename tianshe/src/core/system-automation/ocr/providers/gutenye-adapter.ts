/**
 * Gutenye OCR 适配器
 *
 * 基于 @gutenye/ocr-node 的 PP-OCRv4 实现
 * 提供高精度的中英文混合识别
 */

import type { Bounds } from '../../../coordinate/types';
import type { DetailedOCRResult, OCRAPI, OCROptions, OCRResult, OCRRuntimeOptions } from '../../types';
import { createLogger } from '../../../logger';
import { dynamicImport } from '../../../utils/dynamic-import';
import { applyImagePreprocessPipeline, type ImagePreprocessPipeline } from '../preprocess';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AIRPA_RUNTIME_CONFIG,
  resolveAsarExtractBaseDir,
  resolveUserDataDir,
} from '../../../../constants/runtime-config';

const logger = createLogger('GutenOCRAdapter');

// @gutenye/ocr-node 实际返回类型
// box 是四个角点的坐标: [[左上x,左上y], [右上x,右上y], [右下x,右下y], [左下x,左下y]]
type OcrDetectResult = Array<{
  text: string;
  mean: number; // 置信度 0-1
  box: [[number, number], [number, number], [number, number], [number, number]];
}>;

type OcrInstance = {
  detect(image: string | Buffer): Promise<OcrDetectResult>;
};

type OcrCreateOptions = {
  isDebug?: boolean;
  debugOutputDir?: string;
  models?: {
    detectionPath: string;
    recognitionPath: string;
    dictionaryPath: string;
  };
};

let openCvModulePromise: Promise<unknown> | null = null;

async function tryDecodeOpenCvWasmException(
  ptr: number
): Promise<{ message: string; stack?: string } | null> {
  try {
    if (!openCvModulePromise) {
      openCvModulePromise = dynamicImport<unknown>('@techstark/opencv-js');
    }
    const mod = await openCvModulePromise;
    const cv = (mod as { default?: unknown }).default || mod;
    const exceptionFromPtr = (cv as { exceptionFromPtr?: (value: number) => unknown })
      .exceptionFromPtr;
    if (typeof exceptionFromPtr !== 'function') return null;

    const ex = exceptionFromPtr(ptr) as Record<string, unknown> | null | undefined;
    if (!ex || typeof ex !== 'object') return null;

    const rawMessage =
      ex.msg ?? ex.message ?? ex.what ?? ex.error ?? ex.err ?? ex.description ?? undefined;
    const message =
      rawMessage !== undefined && rawMessage !== null ? String(rawMessage).trim() : '';
    const rawStack = ex.stack;
    const stack = rawStack !== undefined && rawStack !== null ? String(rawStack) : undefined;

    if (message) return { message, stack };

    try {
      return { message: JSON.stringify(ex), stack };
    } catch {
      return { message: String(ex), stack };
    }
  } catch {
    return null;
  }
}

const STABILITY_RETRY_PIPELINE: ImagePreprocessPipeline = {
  name: 'stability/resize960',
  steps: [
    { op: 'flatten', background: '#ffffff' },
    { op: 'resize', width: 960, height: 960, fit: 'inside', withoutEnlargement: true },
  ],
};

/**
 * Gutenye OCR 适配器
 *
 * 封装 @gutenye/ocr-node（PP-OCRv4）为系统 OCR 接口
 */
export class GutenOCRAdapter implements OCRAPI {
  private ocr: OcrInstance | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  private consecutiveFailures = 0;
  private resetPromise: Promise<void> | null = null;
  private lastResetAtMs = 0;
  // Native OCR engine is not re-entrant; serialize detect calls per adapter instance.
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

  /**
   * 初始化 OCR 实例
   */
  async initialize(options?: OcrCreateOptions): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize(options);
    return this.initPromise;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.serial.then(task, task);
    this.serial = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async doInitialize(options?: OcrCreateOptions): Promise<void> {
    try {
      logger.info('Initializing Gutenye OCR (PP-OCRv4)...');

      // 动态导入 @gutenye/ocr-node
      type OcrFactory = {
        create(options: OcrCreateOptions): Promise<OcrInstance>;
      };
      const OcrModule = await dynamicImport<{ default?: OcrFactory } | OcrFactory>(
        '@gutenye/ocr-node'
      );
      const Ocr = ((OcrModule as { default?: OcrFactory }).default || OcrModule) as OcrFactory;

      // 打包到 asar 后，@gutenye/ocr-models 会用 import.meta.url 解析出 app.asar 路径；
      // 但 ONNX 需要真实文件系统路径（且模型文件被配置为 asarUnpack），因此需要将路径映射到 app.asar.unpacked。
      const models = await this.resolveBundledModelPaths();
      if (models) logger.info('Using bundled OCR models', models);

      // 创建 OCR 实例
      this.ocr = await Ocr.create({
        isDebug: options?.isDebug ?? false,
        debugOutputDir: options?.debugOutputDir,
        ...(models ? { models } : {}),
      });

      this.isInitialized = true;
      logger.info('Gutenye OCR initialized successfully');
    } catch (error) {
      this.initPromise = null;
      logger.error('Failed to initialize Gutenye OCR:', error);

      // 提供更友好的错误信息
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'OCR requires @gutenye/ocr-node package. Please install it: npm install @gutenye/ocr-node'
        );
      }
      throw error;
    }
  }

  private async resolveBundledModelPaths(): Promise<{
    detectionPath: string;
    recognitionPath: string;
    dictionaryPath: string;
  } | null> {
    const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const base = path.join(
        resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@gutenye',
        'ocr-models',
        'assets'
      );
      const det = path.join(base, 'ch_PP-OCRv4_det_infer.onnx');
      const rec = path.join(base, 'ch_PP-OCRv4_rec_infer.onnx');
      const dic = path.join(base, 'ppocr_keys_v1.txt');
      const ok = fs.existsSync(det) && fs.existsSync(rec) && fs.existsSync(dic);
      if (ok) {
        return { detectionPath: det, recognitionPath: rec, dictionaryPath: dic };
      }
    }

    try {
      // Prefer reading @gutenye/ocr-models exported paths, then mapping app.asar -> app.asar.unpacked.
      // This avoids relying on CJS require.resolve behavior across ESM/export conditions in packaged apps.
      const modelsModule = await dynamicImport<{ default?: unknown } | unknown>(
        '@gutenye/ocr-models/node'
      );
      const exported = (modelsModule as { default?: unknown }).default || modelsModule;
      const asAny = exported as Record<string, unknown>;

      const detRaw = String(asAny.detectionPath || '');
      const recRaw = String(asAny.recognitionPath || '');
      const dicRaw = String(asAny.dictionaryPath || '');

      const detectionPath = this.preferUnpackedPath(detRaw) || detRaw;
      const recognitionPath = this.preferUnpackedPath(recRaw) || recRaw;
      const dictionaryPath = this.preferUnpackedPath(dicRaw) || dicRaw;

      const isAsarVirtualPath = (p: string) =>
        /([\\/])app\.asar([\\/])/i.test(p) && !/([\\/])app\.asar\.unpacked([\\/])/i.test(p);
      if (
        isAsarVirtualPath(detectionPath) ||
        isAsarVirtualPath(recognitionPath) ||
        isAsarVirtualPath(dictionaryPath)
      ) {
        return null;
      }

      if (
        !fs.existsSync(detectionPath) ||
        !fs.existsSync(recognitionPath) ||
        !fs.existsSync(dictionaryPath)
      ) {
        logger.warn('Bundled OCR model files not found', {
          detectionPath,
          detectionExists: fs.existsSync(detectionPath),
          recognitionPath,
          recognitionExists: fs.existsSync(recognitionPath),
          dictionaryPath,
          dictionaryExists: fs.existsSync(dictionaryPath),
        });
        return null;
      }

      return { detectionPath, recognitionPath, dictionaryPath };
    } catch {
      return null;
    }
  }

  private preferUnpackedPath(candidatePath: string): string {
    const raw = String(candidatePath || '').trim();
    if (!raw) return '';

    // Electron's asar filesystem can make `fs.existsSync(...app.asar\...\file)` return true even though
    // native libraries (onnxruntime) cannot open that virtual path. Prefer app.asar.unpacked whenever applicable.
    const unpackedPath = raw.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    if (unpackedPath !== raw && fs.existsSync(unpackedPath)) {
      return unpackedPath;
    }

    // If the file only exists inside app.asar, materialize it to a real file path for native libraries.
    if (raw !== unpackedPath && /([\\/])app\.asar([\\/])/i.test(raw)) {
      const extracted = this.extractAsarFileToDisk(raw);
      if (extracted) return extracted;
    }

    if (fs.existsSync(raw)) return raw;
    return raw;
  }

  private extractAsarFileToDisk(asarVirtualPath: string): string | null {
    const raw = String(asarVirtualPath || '').trim();
    if (!raw) return null;
    const m = raw.match(/([\\/])app\.asar([\\/])(.*)$/i);
    if (!m) return null;

    try {
      if (!fs.existsSync(raw)) return null;
    } catch {
      return null;
    }

    const rel = String(m[3] || '').replace(/^[\\/]+/, '');
    if (!rel) return null;

    const configuredBase = resolveAsarExtractBaseDir() ?? resolveUserDataDir('');
    const base = configuredBase.trim() || os.tmpdir();
    const outPath = path.join(base, 'tiansheai-asar-extract', rel);

    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      const srcStat = fs.statSync(raw);
      if (fs.existsSync(outPath)) {
        try {
          const dstStat = fs.statSync(outPath);
          if (dstStat.size === srcStat.size && dstStat.size > 0) {
            return outPath;
          }
        } catch {
          // ignore, rewrite below
        }
      }

      const buf = fs.readFileSync(raw);
      if (!buf || buf.length === 0) return null;
      fs.writeFileSync(outPath, buf);
      return outPath;
    } catch (e) {
      logger.warn('Failed to extract asar file to disk', {
        asarVirtualPath: raw,
        outPath,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * 识别图像中的文字
   *
   * @param image 图像数据（Buffer）或图像文件路径
   * @param options OCR 选项
   */
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

          if (!this.ocr) {
            throw new Error('OCR not initialized');
          }

          const input = attempt === 0 ? image : (retryImage ?? image);
          logger.info(
            `OCR detect starting, image size: ${typeof input === 'string' ? input.length : input.length}`
          );
          const result = await this.ocr.detect(input);
          logger.info(
            `OCR detect completed, result: ${result ? JSON.stringify(result).slice(0, 500) : 'null'}`
          );
          if (!result) {
            logger.debug('OCR detect returned empty result');
            this.consecutiveFailures = 0;
            return [];
          }
          const converted = this.convertResult(result, options?.minConfidence);
          logger.info(`OCR converted results: ${converted.length} items`);
          this.consecutiveFailures = 0;
          return converted;
        } catch (error) {
          this.consecutiveFailures += 1;
          const normalized = this.normalizeOcrError(error);
          const isFatal = this.isFatalOcrError(error);
          const code = this.extractNumericCode(error);
          const openCv = typeof code === 'number' ? await tryDecodeOpenCvWasmException(code) : null;

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
            await this.dumpFatalInputIfEnabled(
              typeof code === 'number' ? code : null,
              openCv,
              image
            );
          }
          const willReset =
            attempt === 0 &&
            (isFatal || this.consecutiveFailures >= 3) &&
            (await this.tryResetEngine({ force: isFatal }));

          logger.error('OCR recognition failed:', {
            message: normalized.message,
            stack: error instanceof Error ? error.stack : undefined,
            rawType: typeof error,
            rawValue: this.safeStringifyUnknown(error),
            openCvMessage: openCv?.message,
            fatal: isFatal,
            consecutiveFailures: this.consecutiveFailures,
            attemptedReset: willReset,
          });

          if (attempt === 0 && (willReset || retryImage) && this.ocr) {
            continue;
          }

          throw normalized;
        }
      }

      // unreachable
      return [];
    }), runtimeOptions);
  }

  /**
   * 识别并返回详细结果
   *
   * 注意：PP-OCR 不提供单词级别的结果，只有行级别
   */
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

          if (!this.ocr) {
            throw new Error('OCR not initialized');
          }

          const input = attempt === 0 ? image : (retryImage ?? image);
          const result = await this.ocr.detect(input);
          if (!result) {
            logger.debug('OCR detect returned empty result');
            this.consecutiveFailures = 0;
            return [];
          }
          this.consecutiveFailures = 0;
          return this.convertDetailedResult(result, options?.minConfidence);
        } catch (error) {
          this.consecutiveFailures += 1;
          const normalized = this.normalizeOcrError(error);
          const isFatal = this.isFatalOcrError(error);
          const code = this.extractNumericCode(error);
          const openCv = typeof code === 'number' ? await tryDecodeOpenCvWasmException(code) : null;

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
            await this.dumpFatalInputIfEnabled(
              typeof code === 'number' ? code : null,
              openCv,
              image
            );
          }
          const willReset =
            attempt === 0 &&
            (isFatal || this.consecutiveFailures >= 3) &&
            (await this.tryResetEngine({ force: isFatal }));

          logger.error('OCR recognition failed:', {
            message: normalized.message,
            stack: error instanceof Error ? error.stack : undefined,
            rawType: typeof error,
            rawValue: this.safeStringifyUnknown(error),
            openCvMessage: openCv?.message,
            fatal: isFatal,
            consecutiveFailures: this.consecutiveFailures,
            attemptedReset: willReset,
          });

          if (attempt === 0 && (willReset || retryImage) && this.ocr) {
            continue;
          }

          throw normalized;
        }
      }

      // unreachable
      return [];
    }), runtimeOptions);
  }

  /**
   * 终止 OCR（释放资源）
   */
  async terminate(): Promise<void> {
    return this.runExclusive(async () => {
      await this.terminateInternal();
    });
  }

  private async terminateInternal(): Promise<void> {
    if (this.ocr) {
      // @gutenye/ocr-node 没有显式的 dispose 方法
      // 依赖 GC 清理
      this.ocr = null;
      this.isInitialized = false;
      this.initPromise = null;
      this.consecutiveFailures = 0;
      logger.info('Gutenye OCR terminated');

      // Best-effort GC for long-running OCR loops; no-op unless node was started with --expose-gc
      try {
        (globalThis as unknown as { gc?: () => void }).gc?.();
      } catch {
        // ignore
      }
    }
  }

  private async dumpFatalInputIfEnabled(
    code: number | null,
    openCv: { message: string; stack?: string } | null,
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
      openCvMessage: openCv?.message,
      openCvStack: openCv?.stack,
      inputType: typeof input,
      inputSize: typeof input === 'string' ? input.length : input.length,
      inputPath: typeof input === 'string' ? input : undefined,
    };

    if (Buffer.isBuffer(input)) {
      const ext = guessImageExtension(input);
      const binPath = path.join(dumpDir, `${base}.${ext}`);
      try {
        fs.writeFileSync(binPath, input);
        (meta as { dumpedFile?: string }).dumpedFile = binPath;
      } catch {
        // ignore
      }
    } else if (typeof input === 'string') {
      try {
        const ext = path.extname(input).replace('.', '') || 'img';
        const copyPath = path.join(dumpDir, `${base}${path.extname(input) || `.${ext}`}`);
        fs.copyFileSync(input, copyPath);
        (meta as { dumpedFile?: string }).dumpedFile = copyPath;
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

  private normalizeOcrError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    const code = this.extractNumericCode(error);
    const codeText = typeof code === 'number' ? ` (code=${code} / 0x${code.toString(16)})` : '';
    return new Error(`OCR engine error${codeText}: ${this.safeStringifyUnknown(error)}`);
  }

  private isFatalOcrError(error: unknown): boolean {
    // @gutenye/ocr-node sometimes throws raw numeric codes (or objects with {data:<number>})
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
    // Avoid reset loops (e.g. multi-pass pipelines calling detect repeatedly).
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
      try {
        await this.terminateInternal();
      } catch {
        // ignore
      }
      await this.initialize();
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

  /**
   * 转换识别结果为统一格式
   *
   * @gutenye/ocr-node 返回数组，每个元素包含 { text, mean, box }
   */
  private convertResult(result: OcrDetectResult, minConfidence?: number): OCRResult[] {
    const threshold = minConfidence ?? 0;
    const results: OCRResult[] = [];

    // 防御性检查：result 应该是数组
    if (!result || !Array.isArray(result)) {
      logger.debug('OCR result is not an array', { result });
      return results;
    }

    for (const item of result) {
      // mean 在 0-1 范围，转换为 0-100
      const confidence = item.mean * 100;

      if (confidence < threshold) {
        continue;
      }

      results.push({
        text: item.text.trim(),
        confidence,
        bounds: this.boxToBounds(item.box),
      });
    }

    return results;
  }

  /**
   * 转换为详细结果
   */
  private convertDetailedResult(
    result: OcrDetectResult,
    minConfidence?: number
  ): DetailedOCRResult[] {
    const threshold = minConfidence ?? 0;
    const results: DetailedOCRResult[] = [];

    // 防御性检查：result 应该是数组
    if (!result || !Array.isArray(result)) {
      logger.debug('OCR result is not an array', { result });
      return results;
    }

    for (const item of result) {
      const confidence = item.mean * 100;

      if (confidence < threshold) {
        continue;
      }

      // PP-OCR 返回的是行级别结果
      // 将每行作为一个结果，lines 数组包含自己
      const bounds = this.boxToBounds(item.box);

      results.push({
        text: item.text.trim(),
        confidence,
        bounds,
        lines: [
          {
            text: item.text.trim(),
            confidence,
            bounds,
          },
        ],
        // PP-OCR 不提供单词级别的分割
        words: undefined,
      });
    }

    return results;
  }

  /**
   * 将四角坐标转换为 Bounds 对象
   *
   * box 格式: [[左上x,左上y], [右上x,右上y], [右下x,右下y], [左下x,左下y]]
   */
  private boxToBounds(
    box: [[number, number], [number, number], [number, number], [number, number]]
  ): Bounds {
    const [topLeft, topRight, bottomRight, bottomLeft] = box;

    // 计算边界框（取最小/最大值以处理倾斜的文本）
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
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
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
    // JPEG signature: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpg';
    }
  }

  return 'bin';
}
