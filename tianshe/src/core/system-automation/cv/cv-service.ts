import { createLogger } from '../../logger';
import { dynamicImport } from '../../utils/dynamic-import';
import { createTaskQueue } from '../../task-manager/queue';
import type { TaskQueue } from '../../task-manager/queue';
import { getOpenCVJsPool } from './opencvjs-pool';
import type { CropResult, FindCropsOptions, RGBAImage } from './types';

const logger = createLogger('OpenCVService');

type SharpModule = typeof import('sharp');

export type EncodeFormat = 'png' | 'jpeg';

export type DecodeOptions = {
  maxSide?: number;
};

export type ExtractCropsInput = string | Buffer;

export type ExtractCropsResult = Array<{
  box: CropResult['box'];
  rotatedRect: CropResult['rotatedRect'];
  image: {
    width: number;
    height: number;
    buffer: Buffer;
    format: EncodeFormat;
  };
}>;

export type ExtractCropsBatchOptions = {
  concurrency?: number;
  decode?: DecodeOptions;
  opencv?: FindCropsOptions;
  outputFormat?: EncodeFormat;
  jpegQuality?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  hardTimeoutMs?: number;
};

async function loadSharp(): Promise<SharpModule> {
  const m = await dynamicImport<{ default?: SharpModule } | SharpModule>('sharp');
  return (m as { default?: SharpModule }).default || (m as SharpModule);
}

async function decodeToRGBA(input: ExtractCropsInput, options?: DecodeOptions): Promise<RGBAImage> {
  const sharp = await loadSharp();
  const maxSide =
    typeof options?.maxSide === 'number' && Number.isFinite(options.maxSide) ? options.maxSide : 0;

  let s = sharp(input).ensureAlpha();
  if (maxSide > 0) {
    s = s.resize({
      width: maxSide,
      height: maxSide,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const raw = await s.raw().toBuffer({ resolveWithObject: true });
  return {
    width: raw.info.width,
    height: raw.info.height,
    data: new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
  };
}

async function encodeRGBA(
  rgba: RGBAImage,
  format: EncodeFormat,
  jpegQuality?: number
): Promise<Buffer> {
  const sharp = await loadSharp();
  const s = sharp(rgba.data, {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  });

  if (format === 'jpeg') {
    return s.jpeg({ quality: typeof jpegQuality === 'number' ? jpegQuality : 85 }).toBuffer();
  }
  return s.png().toBuffer();
}

export class OpenCVService {
  async ping(options?: { signal?: AbortSignal }): Promise<{ pong: boolean; pid: number }> {
    const pool = getOpenCVJsPool();
    return pool.ping(options?.signal);
  }

  async extractCrops(
    input: ExtractCropsInput,
    options?: {
      decode?: DecodeOptions;
      opencv?: FindCropsOptions;
      outputFormat?: EncodeFormat;
      jpegQuality?: number;
      signal?: AbortSignal;
      timeoutMs?: number;
      hardTimeoutMs?: number;
    }
  ): Promise<ExtractCropsResult> {
    const pool = getOpenCVJsPool();
    const rgba = await decodeToRGBA(input, options?.decode);
    const crops = await pool.findCrops(rgba, options?.opencv, {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
      hardTimeoutMs: options?.hardTimeoutMs,
    });

    const outFormat: EncodeFormat = options?.outputFormat ?? 'png';
    const result: ExtractCropsResult = [];

    for (const c of crops) {
      const buffer = await encodeRGBA(c.image, outFormat, options?.jpegQuality);
      result.push({
        box: c.box,
        rotatedRect: c.rotatedRect,
        image: {
          width: c.image.width,
          height: c.image.height,
          buffer,
          format: outFormat,
        },
      });
    }

    return result;
  }

  async extractCropsBatch(
    inputs: ExtractCropsInput[],
    options?: ExtractCropsBatchOptions
  ): Promise<
    Array<
      | { index: number; ok: true; data: ExtractCropsResult }
      | { index: number; ok: false; error: string }
    >
  > {
    const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 4) || 4));
    const queue: TaskQueue = createTaskQueue({ name: 'OpenCVExtractBatch', concurrency });
    const signal = options?.signal;

    try {
      const tasks = inputs.map((input, index) =>
        queue
          .add(
            async ({ signal: taskSignal }) => {
              const combinedSignal = taskSignal;
              const data = await this.extractCrops(input, {
                decode: options?.decode,
                opencv: options?.opencv,
                outputFormat: options?.outputFormat,
                jpegQuality: options?.jpegQuality,
                signal: combinedSignal,
                timeoutMs: options?.timeoutMs,
                hardTimeoutMs: options?.hardTimeoutMs,
              });
              return { index, ok: true as const, data };
            },
            { signal, timeout: options?.timeoutMs }
          )
          .catch((e) => ({ index, ok: false as const, error: e?.message || String(e) }))
      );

      return await Promise.all(tasks);
    } finally {
      try {
        await queue.stop();
      } catch {
        // ignore
      }
    }
  }
}

let _service: OpenCVService | null = null;
export function getOpenCVService(): OpenCVService {
  if (_service) return _service;
  _service = new OpenCVService();
  logger.info('OpenCVService initialized');
  return _service;
}
