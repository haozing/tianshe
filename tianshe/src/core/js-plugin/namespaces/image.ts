/**
 * Image Namespace
 *
 * Lightweight image similarity helpers (pHash -> SSIM).
 *
 * @example
 * const r = await helpers.image.compare('./a.png', './b.png', {
 *   phash: { bits: 8, maxDistance: 10 },
 *   ssim: { options: { maxSize: 256 } }
 * });
 * console.log(r.similarity, r.phash.distance, r.ssim?.mssim);
 */

import {
  getImageSimilarityService,
  type HashFormat,
  type ImageSimilarityCompareOptions,
  type ImageSimilarityCompareResult,
  type PerceptualHashCompareResult,
  type PerceptualHashOptions,
  type PerceptualHashResult,
  type SSIMCompareOptions,
  type SSIMCompareResult,
} from '../../image-similarity';

export type {
  HashFormat,
  ImageSimilarityCompareOptions,
  ImageSimilarityCompareResult,
  PerceptualHashCompareResult,
  PerceptualHashOptions,
  PerceptualHashResult,
  ResizeMode,
  SSIMCompareOptions,
  SSIMCompareResult,
} from '../../image-similarity';

export class ImageNamespace {
  constructor(private pluginId: string) {
    void pluginId;
  }

  async pHash(
    image: string | Buffer,
    options?: PerceptualHashOptions
  ): Promise<PerceptualHashResult> {
    const service = getImageSimilarityService();
    return service.pHash(image, options);
  }

  hammingDistance(hash1: string, hash2: string, format: HashFormat = 'hex'): number {
    const service = getImageSimilarityService();
    return service.hammingDistance(hash1, hash2, format);
  }

  async comparePHash(
    image1: string | Buffer,
    image2: string | Buffer,
    options?: PerceptualHashOptions
  ): Promise<PerceptualHashCompareResult> {
    const service = getImageSimilarityService();
    return service.comparePHash(image1, image2, options);
  }

  async ssim(
    image1: string | Buffer,
    image2: string | Buffer,
    options?: SSIMCompareOptions
  ): Promise<SSIMCompareResult> {
    const service = getImageSimilarityService();
    return service.compareSSIM(image1, image2, options);
  }

  async compare(
    image1: string | Buffer,
    image2: string | Buffer,
    options?: ImageSimilarityCompareOptions
  ): Promise<ImageSimilarityCompareResult> {
    const service = getImageSimilarityService();
    return service.compare(image1, image2, options);
  }

  async similarity(
    image1: string | Buffer,
    image2: string | Buffer,
    options?: ImageSimilarityCompareOptions
  ): Promise<number> {
    const result = await this.compare(image1, image2, options);
    return result.similarity;
  }
}
