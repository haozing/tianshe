/**
 * Image Similarity Module
 *
 * Implements a 2-stage comparison:
 * - Perceptual hash (coarse filter) via `imghash`
 * - SSIM (fine score) via `ssim.js`
 */

export { ImageSimilarityService, getImageSimilarityService } from './image-similarity-service';
export type {
  ImageInput,
  HashFormat,
  PerceptualHashOptions,
  PerceptualHashResult,
  PerceptualHashCompareResult,
  ResizeMode,
  SSIMCompareOptions,
  SSIMCompareResult,
  ImageSimilarityCompareOptions,
  ImageSimilarityCompareResult,
} from './types';
