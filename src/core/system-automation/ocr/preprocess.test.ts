import { describe, it, expect, vi } from 'vitest';
import { applyImagePreprocessPipeline, getDefaultOcrPreprocessPipelines } from './preprocess';

vi.mock('../../utils/dynamic-import', () => ({
  dynamicImport: async (modulePath: string) => import(modulePath),
}));

async function renderSvgToPngBuffer(svg: string): Promise<Buffer> {
  const sharpModule = await import('sharp');
  const sharp =
    (sharpModule as unknown as { default?: any }).default || (sharpModule as unknown as any);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('OCR preprocess pipeline', () => {
  it('getDefaultOcrPreprocessPipelines(low-contrast) is stability-first', () => {
    const pipelines = getDefaultOcrPreprocessPipelines('low-contrast');
    expect(pipelines.length).toBeGreaterThan(1);
    expect(pipelines[0].name).toBe('safe/resize1600');
  });

  it('applyImagePreprocessPipeline returns a Buffer', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="140">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="20" y="90" font-family="Arial" font-size="48" fill="#e6e6e6">TEST 123</text>
</svg>`;
    const input = await renderSvgToPngBuffer(svg);
    const pipelines = getDefaultOcrPreprocessPipelines('low-contrast');
    const enhanced = pipelines.find((p) => p.name.includes('clahe')) ?? pipelines[0];

    const output = await applyImagePreprocessPipeline(input, enhanced);

    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.length).toBeGreaterThan(0);
    expect(output.equals(input)).toBe(false);
  });
});
