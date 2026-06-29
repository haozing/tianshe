import * as fs from 'fs';
import { dynamicImport } from '../../utils/dynamic-import';

export type ImagePreprocessPreset = 'none' | 'low-contrast';

export type ImagePreprocessOutputFormat = 'png' | 'jpeg';

export type ImagePreprocessStep =
  | { op: 'grayscale' }
  | { op: 'normalize' }
  | { op: 'clahe'; width?: number; height?: number; maxSlope?: number }
  | { op: 'gamma'; gamma?: number }
  | { op: 'linear'; a?: number; b?: number }
  | { op: 'sharpen'; sigma?: number; m1?: number; m2?: number }
  | { op: 'negate' }
  | { op: 'threshold'; threshold?: number; grayscale?: boolean }
  | { op: 'scale'; factor?: number; fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside' }
  | {
      op: 'resize';
      width?: number;
      height?: number;
      fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
      withoutEnlargement?: boolean;
    }
  | { op: 'flatten'; background?: string };

export interface ImagePreprocessPipeline {
  name: string;
  steps: ImagePreprocessStep[];
}

export interface ImagePreprocessOptions {
  outputFormat?: ImagePreprocessOutputFormat;
  jpegQuality?: number;
}

type SharpInstance = {
  grayscale: () => SharpInstance;
  normalize: () => SharpInstance;
  clahe: (options?: { width?: number; height?: number; maxSlope?: number }) => SharpInstance;
  gamma: (gamma?: number) => SharpInstance;
  linear: (a?: number, b?: number) => SharpInstance;
  sharpen: (sigma?: number, m1?: number, m2?: number) => SharpInstance;
  negate: (options?: { alpha?: boolean }) => SharpInstance;
  threshold: (threshold?: number, options?: { grayscale?: boolean }) => SharpInstance;
  resize: (
    width: number | null,
    height: number | null,
    options?: {
      fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
      withoutEnlargement?: boolean;
    }
  ) => SharpInstance;
  flatten: (options?: { background?: string }) => SharpInstance;
  metadata: () => Promise<{ width?: number; height?: number }>;
  png: () => SharpInstance;
  jpeg: (options?: { quality?: number }) => SharpInstance;
  toBuffer: () => Promise<Buffer>;
};

type SharpFn = (input: Buffer | string) => SharpInstance;

async function getSharp(): Promise<SharpFn> {
  try {
    const sharpModule = await dynamicImport<{ default?: SharpFn } | SharpFn>('sharp');
    return ((sharpModule as { default?: SharpFn }).default || sharpModule) as SharpFn;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'Image preprocessing requires the "sharp" package. Please install it: npm install sharp'
      );
    }
    throw error;
  }
}

export function getDefaultOcrPreprocessPipelines(
  preset: ImagePreprocessPreset
): ImagePreprocessPipeline[] {
  if (preset === 'none') {
    return [{ name: 'original', steps: [] }];
  }

  const baseStableSteps: ImagePreprocessStep[] = [
    { op: 'flatten', background: '#ffffff' },
    // Cap both dimensions to avoid extremely large images causing native OCR failures.
    { op: 'resize', width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true },
  ];

  return [
    // Stability-first: always cap image size before passing to the native OCR engine.
    { name: 'safe/resize1600', steps: [...baseStableSteps] },
    {
      name: 'low-contrast/normalize',
      steps: [...baseStableSteps, { op: 'grayscale' }, { op: 'normalize' }],
    },
    {
      name: 'low-contrast/clahe',
      steps: [
        ...baseStableSteps,
        { op: 'grayscale' },
        { op: 'normalize' },
        { op: 'clahe', width: 32, height: 32, maxSlope: 3 },
        { op: 'sharpen', sigma: 1.2, m1: 1, m2: 2 },
      ],
    },
    {
      name: 'low-contrast/invert+clahe',
      steps: [
        ...baseStableSteps,
        { op: 'grayscale' },
        { op: 'negate' },
        { op: 'normalize' },
        { op: 'clahe', width: 32, height: 32, maxSlope: 3 },
        { op: 'sharpen', sigma: 1.2, m1: 1, m2: 2 },
      ],
    },
  ];
}

export async function applyImagePreprocessPipeline(
  image: string | Buffer,
  pipeline: ImagePreprocessPipeline,
  options?: ImagePreprocessOptions
): Promise<Buffer> {
  if (!pipeline.steps.length) {
    if (Buffer.isBuffer(image)) {
      return image;
    }
    if (!fs.existsSync(image)) {
      throw new Error(`Image file not found: ${image}`);
    }
    return fs.readFileSync(image);
  }

  const sharp = await getSharp();
  let instance = sharp(image);

  for (const step of pipeline.steps) {
    switch (step.op) {
      case 'grayscale':
        instance = instance.grayscale();
        break;
      case 'normalize':
        instance = instance.normalize();
        break;
      case 'clahe':
        instance = instance.clahe({
          width: step.width,
          height: step.height,
          maxSlope: step.maxSlope,
        });
        break;
      case 'gamma':
        instance = instance.gamma(step.gamma);
        break;
      case 'linear':
        instance = instance.linear(step.a, step.b);
        break;
      case 'sharpen':
        instance = instance.sharpen(step.sigma, step.m1, step.m2);
        break;
      case 'negate':
        instance = instance.negate({ alpha: false });
        break;
      case 'threshold':
        instance = instance.threshold(step.threshold, { grayscale: step.grayscale });
        break;
      case 'scale': {
        const factor = step.factor && step.factor > 0 ? step.factor : 2;
        const meta = await instance.metadata();
        const width = meta.width ? Math.max(1, Math.round(meta.width * factor)) : null;
        const height = meta.height ? Math.max(1, Math.round(meta.height * factor)) : null;
        if (!width && !height) {
          throw new Error('scale step requires image metadata (width/height)');
        }
        instance = instance.resize(width, height, { fit: step.fit });
        break;
      }
      case 'resize': {
        const width = step.width && step.width > 0 ? step.width : null;
        const height = step.height && step.height > 0 ? step.height : null;
        if (!width && !height) {
          throw new Error('resize step requires width or height (> 0)');
        }
        instance = instance.resize(width, height, {
          fit: step.fit,
          withoutEnlargement: step.withoutEnlargement,
        });
        break;
      }
      case 'flatten':
        instance = instance.flatten({ background: step.background });
        break;
      default: {
        const neverStep: never = step;
        throw new Error(`Unsupported preprocess step: ${(neverStep as { op: string }).op}`);
      }
    }
  }

  const outputFormat: ImagePreprocessOutputFormat = options?.outputFormat ?? 'png';
  if (outputFormat === 'jpeg') {
    instance = instance.jpeg({ quality: options?.jpegQuality ?? 90 });
  } else {
    instance = instance.png();
  }

  return instance.toBuffer();
}
