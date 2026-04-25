import * as fs from 'fs';
import imghash from 'imghash';
import sharp from 'sharp';
import ssim from 'ssim.js';
import { createLogger } from '../logger';
import type {
  HashFormat,
  ImageInput,
  ImageSimilarityCompareOptions,
  ImageSimilarityCompareResult,
  PerceptualHashCompareResult,
  PerceptualHashOptions,
  PerceptualHashResult,
  SSIMCompareOptions,
  SSIMCompareResult,
} from './types';

const logger = createLogger('ImageSimilarityService');

function assertFileExistsIfPath(input: ImageInput): void {
  if (typeof input !== 'string') return;
  if (!fs.existsSync(input)) {
    throw new Error(`Image file not found: ${input}`);
  }
}

const POPCOUNT_4BIT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

function hammingDistanceHex(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) {
    throw new Error(`Hash length mismatch: ${hash1.length} vs ${hash2.length}`);
  }
  let distance = 0;
  for (let i = 0; i < hash1.length; i += 1) {
    const a = Number.parseInt(hash1[i]!, 16);
    const b = Number.parseInt(hash2[i]!, 16);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      throw new Error('Invalid hex hash');
    }
    distance += POPCOUNT_4BIT[(a ^ b) & 0xf]!;
  }
  return distance;
}

function hammingDistanceBinary(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) {
    throw new Error(`Hash length mismatch: ${hash1.length} vs ${hash2.length}`);
  }
  let distance = 0;
  for (let i = 0; i < hash1.length; i += 1) {
    if (hash1.charCodeAt(i) !== hash2.charCodeAt(i)) distance += 1;
  }
  return distance;
}

function computeSimilarityFromDistance(distance: number, totalBits: number): number {
  if (totalBits <= 0) return 0;
  const s = 1 - distance / totalBits;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

async function decodeToSSIMImageData(
  input: ImageInput,
  resize?: {
    width: number;
    height: number;
    fit?: 'fill' | 'contain' | 'cover' | 'inside' | 'outside';
  }
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  assertFileExistsIfPath(input);
  let pipeline = sharp(input).ensureAlpha();
  if (resize) {
    pipeline = pipeline.resize(resize.width, resize.height, { fit: resize.fit ?? 'fill' });
  }

  const raw = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return {
    width: raw.info.width,
    height: raw.info.height,
    data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
  };
}

export class ImageSimilarityService {
  /**
   * Perceptual hash (coarse filter).
   *
   * Note: backed by `imghash` (bmvbhash). It behaves like a perceptual hash suitable
   * for fast coarse filtering.
   */
  async pHash(input: ImageInput, options?: PerceptualHashOptions): Promise<PerceptualHashResult> {
    assertFileExistsIfPath(input);
    const bits = options?.bits ?? 8;
    const format: HashFormat = options?.format ?? 'hex';
    const hash = await imghash.hash(input, bits, format);
    return { hash, bits, format };
  }

  /**
   * Hamming distance between two hashes (hex or binary).
   */
  hammingDistance(hash1: string, hash2: string, format: HashFormat = 'hex'): number {
    return format === 'binary'
      ? hammingDistanceBinary(hash1, hash2)
      : hammingDistanceHex(hash1, hash2);
  }

  async comparePHash(
    image1: ImageInput,
    image2: ImageInput,
    options?: PerceptualHashOptions
  ): Promise<PerceptualHashCompareResult> {
    const [h1, h2] = await Promise.all([this.pHash(image1, options), this.pHash(image2, options)]);
    if (h1.bits !== h2.bits || h1.format !== h2.format) {
      throw new Error('Internal error: hash options mismatch');
    }

    const totalBits = h1.format === 'binary' ? h1.hash.length : h1.bits * h1.bits;
    const distance = this.hammingDistance(h1.hash, h2.hash, h1.format);
    return {
      hash1: h1.hash,
      hash2: h2.hash,
      bits: h1.bits,
      format: h1.format,
      distance,
      similarity: computeSimilarityFromDistance(distance, totalBits),
    };
  }

  async compareSSIM(
    image1: ImageInput,
    image2: ImageInput,
    options?: SSIMCompareOptions
  ): Promise<SSIMCompareResult> {
    assertFileExistsIfPath(image1);
    assertFileExistsIfPath(image2);

    const resizeMode = options?.resize ?? 'toFirst';
    let img1: { width: number; height: number; data: Uint8ClampedArray };
    let img2: { width: number; height: number; data: Uint8ClampedArray };

    if (resizeMode === 'none') {
      [img1, img2] = await Promise.all([
        decodeToSSIMImageData(image1),
        decodeToSSIMImageData(image2),
      ]);
      if (img1.width !== img2.width || img1.height !== img2.height) {
        throw new Error('Image dimensions do not match (set ssim.resize to resize automatically)');
      }
    } else if (resizeMode === 'toFirst') {
      img1 = await decodeToSSIMImageData(image1);
      img2 = await decodeToSSIMImageData(image2, { width: img1.width, height: img1.height });
    } else if (resizeMode === 'toSecond') {
      img2 = await decodeToSSIMImageData(image2);
      img1 = await decodeToSSIMImageData(image1, { width: img2.width, height: img2.height });
    } else {
      const target = resizeMode;
      [img1, img2] = await Promise.all([
        decodeToSSIMImageData(image1, target),
        decodeToSSIMImageData(image2, target),
      ]);
    }

    const result = ssim(img1, img2, options?.options);
    return {
      mssim: result.mssim,
      performanceMs: result.performance,
      width: img1.width,
      height: img1.height,
    };
  }

  async compare(
    image1: ImageInput,
    image2: ImageInput,
    options?: ImageSimilarityCompareOptions
  ): Promise<ImageSimilarityCompareResult> {
    const phash = await this.comparePHash(image1, image2, options?.phash);
    const maxDistance = options?.phash?.maxDistance ?? 10;
    const minSimilarity = options?.phash?.minSimilarity;

    let passed = true;
    if (typeof maxDistance === 'number' && Number.isFinite(maxDistance)) {
      passed = passed && phash.distance <= maxDistance;
    }
    if (typeof minSimilarity === 'number' && Number.isFinite(minSimilarity)) {
      passed = passed && phash.similarity >= minSimilarity;
    }

    if (!passed && !options?.forceSSIM) {
      return { phash, passedPhash: false, similarity: phash.similarity };
    }

    const ssimResult = await this.compareSSIM(image1, image2, options?.ssim);
    return { phash, passedPhash: passed, ssim: ssimResult, similarity: ssimResult.mssim };
  }
}

let _service: ImageSimilarityService | null = null;
export function getImageSimilarityService(): ImageSimilarityService {
  if (_service) return _service;
  _service = new ImageSimilarityService();
  logger.info('ImageSimilarityService initialized');
  return _service;
}
