// @tianshe-test area=browser layer=unit runtime=node
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveOfficialExpectedRelativePath,
  saveSiteAdapterExpected,
} from './artifact-service';

const workspaceRoot = path.resolve('D:/workspace/tianshe-client-open');

describe('site adapter lab artifact service', () => {
  it('resolves official expected JSON paths through the adapter manifest', () => {
    expect(resolveOfficialExpectedRelativePath('books-to-scrape', 'product-page')).toBe(
      'src/site-adapters/books-to-scrape/expected/product-page.json'
    );
  });

  it('saves expected JSON through repairScope guarded paths', async () => {
    const writeFile = vi.fn();
    const result = await saveSiteAdapterExpected(
      {
        adapterId: 'books-to-scrape',
        fixtureName: 'product-page',
        expected: { productName: 'A Light in the Attic' },
      },
      { workspaceRoot, writeFile }
    );

    expect(result).toEqual({
      adapterId: 'books-to-scrape',
      fixtureName: 'product-page',
      expectedPath: 'src/site-adapters/books-to-scrape/expected/product-page.json',
      saved: true,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('src\\site-adapters\\books-to-scrape\\expected\\product-page.json'),
      '{\n  "productName": "A Light in the Attic"\n}\n'
    );
  });

  it('rejects undeclared expected fixtures before writing', async () => {
    const writeFile = vi.fn();

    await expect(
      saveSiteAdapterExpected(
        {
          adapterId: 'books-to-scrape',
          fixtureName: '../core',
          expected: {},
        },
        { workspaceRoot, writeFile }
      )
    ).rejects.toThrow('not declared');
    expect(writeFile).not.toHaveBeenCalled();
  });
});
