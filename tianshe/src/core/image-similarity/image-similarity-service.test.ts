import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { getImageSimilarityService } from './image-similarity-service';

async function makePatternPng(x: number, size = 64): Promise<Buffer> {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="white"/>
  <rect x="${x}" y="0" width="${Math.floor(size / 2)}" height="${Math.floor(size / 2)}" fill="black"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('ImageSimilarityService', () => {
  it('computes perceptual hash and Hamming distance', async () => {
    const service = getImageSimilarityService();
    const img = await makePatternPng(0);

    const h = await service.pHash(img);
    expect(h.bits).toBe(8);
    expect(h.format).toBe('hex');
    expect(h.hash).toHaveLength(16);

    const r = await service.comparePHash(img, img);
    expect(r.distance).toBe(0);
    expect(r.similarity).toBe(1);
  });

  it('computes SSIM for identical images', async () => {
    const service = getImageSimilarityService();
    const img = await makePatternPng(0);

    const r = await service.compareSSIM(img, img);
    expect(r.mssim).toBeGreaterThan(0.99);
    expect(r.width).toBe(64);
    expect(r.height).toBe(64);
  });

  it('runs pHash coarse filter before SSIM', async () => {
    const service = getImageSimilarityService();
    const img1 = await makePatternPng(0);
    const img2 = await makePatternPng(32);

    const coarseOnly = await service.compare(img1, img2, { phash: { maxDistance: 10 } });
    expect(coarseOnly.passedPhash).toBe(false);
    expect(coarseOnly.ssim).toBeUndefined();
    expect(coarseOnly.phash.distance).toBeGreaterThan(10);
    expect(coarseOnly.similarity).toBeCloseTo(coarseOnly.phash.similarity, 12);

    const forced = await service.compare(img1, img2, {
      phash: { maxDistance: 10 },
      forceSSIM: true,
    });
    expect(forced.ssim).toBeDefined();
    expect(forced.similarity).toBeCloseTo(forced.ssim!.mssim, 12);
    expect(forced.similarity).toBeLessThan(0.8);
  });
});
