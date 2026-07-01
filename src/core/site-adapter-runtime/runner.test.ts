// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import type { BrowserInterface } from '../../types/browser-interface';
import { staticProductAdapter } from '../../../examples/web-site-adapter-static-product/adapter';
import fixture from '../../../examples/web-site-adapter-static-product/fixtures/product-page.json';
import expected from '../../../examples/web-site-adapter-static-product/expected/product-page.json';
import { booksToScrapeAdapter } from '../../site-adapters/books-to-scrape/adapter';
import { SiteAdapterRunner, validateSiteAdapterManifest } from './index';
import type { SiteAdapterModule } from './types';

function createProcedureBrowser(): BrowserInterface {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    getText: vi.fn().mockImplementation(async (selector: string) => {
      if (selector === '#search-query') {
        return 'poetry';
      }
      if (selector === '#draft-status') {
        return 'Saved search';
      }
      return 'Ready';
    }),
    textExists: vi.fn().mockResolvedValue(true),
  } as unknown as BrowserInterface;
}

describe('SiteAdapterRunner', () => {
  it('runs fixture adapters through the unified runner entrypoint', async () => {
    const result = await SiteAdapterRunner.run({
      runner: 'fixture',
      adapter: staticProductAdapter,
      fixture: {
        name: fixture.name,
        snapshot: fixture.snapshot,
        expected,
      },
    });

    expect(result).toMatchObject({
      runner: 'fixture',
      adapterId: 'static-product.example',
      fixtureName: 'product-page',
      ok: true,
      result: expected,
    });
  });

  it('runs BrowserInterface snapshot adapters through the unified runner entrypoint', async () => {
    const browser = {
      snapshot: vi.fn().mockResolvedValue(fixture.snapshot),
    } as Pick<BrowserInterface, 'snapshot'>;

    const result = await SiteAdapterRunner.run({
      runner: 'browser-snapshot',
      adapter: staticProductAdapter,
      browser,
      fixtureName: fixture.name,
      expected,
      snapshotOptions: { elementsFilter: 'all' },
    });

    expect(browser.snapshot).toHaveBeenCalledWith({ elementsFilter: 'all' });
    expect(result).toMatchObject({
      runner: 'browser-snapshot',
      ok: true,
      result: expected,
    });
  });

  it('runs browser-evaluate adapters through the unified runner entrypoint', async () => {
    const browser = {
      evaluate: vi.fn().mockResolvedValue(fixture.snapshot),
    };

    const result = await SiteAdapterRunner.run({
      runner: 'browser-evaluate',
      adapter: staticProductAdapter,
      browser,
      fixtureName: fixture.name,
      expected,
      evaluateScript: 'return window.__snapshot',
    });

    expect(browser.evaluate).toHaveBeenCalledWith('return window.__snapshot');
    expect(result).toMatchObject({
      runner: 'browser-evaluate',
      ok: true,
      result: expected,
    });
  });

  it('runs declared procedures through the unified runner entrypoint', async () => {
    const browser = createProcedureBrowser();

    const result = await SiteAdapterRunner.run({
      runner: 'procedure',
      adapter: booksToScrapeAdapter,
      procedureId: 'save-search-draft',
      browser,
    });

    expect(result).toMatchObject({
      runner: 'procedure',
      adapterId: 'books-to-scrape',
      procedureId: 'save-search-draft',
      ok: true,
    });
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'enter-query', action: 'type' }),
        expect.objectContaining({ stepId: 'save-draft', action: 'click' }),
      ])
    );
  });

  it('accepts read-only, low, and high adapter side effect levels in manifests', () => {
    for (const sideEffectLevel of ['read-only', 'low', 'high'] as const) {
      expect(() =>
        validateSiteAdapterManifest({
          ...staticProductAdapter.manifest,
          sideEffectLevel,
        })
      ).not.toThrow();
    }

    expect(() =>
      validateSiteAdapterManifest({
        ...staticProductAdapter.manifest,
        sideEffectLevel: 'dangerous' as never,
      })
    ).toThrow('sideEffectLevel is invalid');
  });

  it('keeps high-risk procedure execution behind explicit confirmation', async () => {
    const highRiskAdapter: SiteAdapterModule = {
      manifest: {
        ...staticProductAdapter.manifest,
        id: 'high-risk.example',
        sideEffectLevel: 'high',
        supportedRunners: ['procedure'],
        procedures: [
          {
            id: 'dangerous',
            sideEffectLevel: 'high',
          },
        ],
      },
      extractors: staticProductAdapter.extractors,
      procedures: [
        {
          id: 'dangerous',
          adapterId: 'high-risk.example',
          sideEffectLevel: 'high',
          steps: [{ id: 'verify', action: 'verifyText', text: 'Ready' }],
        },
      ],
    };

    await expect(
      SiteAdapterRunner.run({
        runner: 'procedure',
        adapter: highRiskAdapter,
        procedureId: 'dangerous',
        browser: createProcedureBrowser(),
      })
    ).rejects.toThrow('confirmationGranted=true');

    await expect(
      SiteAdapterRunner.run({
        runner: 'procedure',
        adapter: highRiskAdapter,
        procedureId: 'dangerous',
        browser: createProcedureBrowser(),
        options: { confirmationGranted: true },
      })
    ).resolves.toMatchObject({
      runner: 'procedure',
      ok: true,
    });
  });
});
