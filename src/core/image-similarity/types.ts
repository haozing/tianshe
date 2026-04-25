import type { Options as SSIMOptions } from 'ssim.js';

export type ImageInput = string | Buffer;

export type HashFormat = 'hex' | 'binary';

export interface PerceptualHashOptions {
  /**
   * Hash grid size (must be multiple of 4).
   *
   * `bits=8` -> 64-bit hash (default).
   * `bits=16` -> 256-bit hash.
   */
  bits?: number;
  /** Output format (default: `hex`). */
  format?: HashFormat;
}

export interface PerceptualHashResult {
  hash: string;
  bits: number;
  format: HashFormat;
}

export interface PerceptualHashCompareResult {
  hash1: string;
  hash2: string;
  bits: number;
  format: HashFormat;
  /** Hamming distance (0..bits*bits). */
  distance: number;
  /** 1 - distance/(bits*bits). */
  similarity: number;
}

export type ResizeMode =
  | 'none'
  | 'toFirst'
  | 'toSecond'
  | {
      width: number;
      height: number;
      fit?: 'fill' | 'contain' | 'cover' | 'inside' | 'outside';
    };

export interface SSIMCompareOptions {
  /**
   * When images have different dimensions, how to make them match for SSIM.
   *
   * - `none`: throw when dimensions mismatch
   * - `toFirst`: resize image2 to image1 dimensions (default)
   * - `toSecond`: resize image1 to image2 dimensions
   * - `{ width, height }`: resize both images to fixed dimensions
   */
  resize?: ResizeMode;
  /** Pass-through options for `ssim.js`. */
  options?: Partial<SSIMOptions>;
}

export interface SSIMCompareResult {
  mssim: number;
  performanceMs: number;
  width: number;
  height: number;
}

export interface ImageSimilarityCompareOptions {
  phash?: PerceptualHashOptions & {
    /**
     * Coarse filter threshold. When `distance > maxDistance`, SSIM will be skipped
     * unless `forceSSIM` is set.
     *
     * Default: 10 (for 64-bit hashes, i.e. `bits=8`).
     */
    maxDistance?: number;
    /** Optional extra threshold based on normalized similarity (0..1). */
    minSimilarity?: number;
  };
  ssim?: SSIMCompareOptions;
  /** Compute SSIM even if pHash coarse filter fails. */
  forceSSIM?: boolean;
}

export interface ImageSimilarityCompareResult {
  phash: PerceptualHashCompareResult;
  passedPhash: boolean;
  ssim?: SSIMCompareResult;
  /** Final similarity (SSIM if computed, otherwise pHash similarity). */
  similarity: number;
}
