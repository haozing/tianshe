// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import type { BrowserInterface } from '../../types/browser-interface';
import {
  checkSiteAdapterImportBoundary,
  replaySiteAdapterTransitions,
  runReadOnlySiteAdapterFixture,
  runReadOnlySiteAdapterRuntimeCanary,
  runSiteAdapterProcedure,
} from '../../core/site-adapter-runtime';
import { booksToScrapeAdapter } from './adapter';
import { createSaveSearchDraftProcedure } from './procedures/save-search-draft';
import fixture from './fixtures/product-page.json';
import expected from './expected/product-page.json';

describe('books to scrape site adapter', () => {
  it('extracts product fields from the fixture snapshot', async () => {
    const result = await runReadOnlySiteAdapterFixture(booksToScrapeAdapter, {
      name: fixture.name,
      snapshot: fixture.snapshot,
      input: fixture.input,
      expected,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject(expected);
    expect(result.result).toMatchObject({
      selectorHits: expect.arrayContaining([
        expect.objectContaining({ field: 'price', count: 1 }),
        expect.objectContaining({ field: 'availability', count: 1 }),
      ]),
      missingFields: [],
      pageFingerprint: {
        url: fixture.snapshot.url,
        title: fixture.snapshot.title,
        elementCount: fixture.snapshot.elements.length,
      },
    });
  });

  it('runs through the BrowserInterface snapshot canary path', async () => {
    const browser = {
      snapshot: vi.fn().mockResolvedValue(fixture.snapshot),
    } as Pick<BrowserInterface, 'snapshot'>;

    const result = await runReadOnlySiteAdapterRuntimeCanary(booksToScrapeAdapter, {
      browser,
      fixtureName: fixture.name,
      expected,
      input: { runner: 'browser-snapshot' },
      snapshotOptions: { elementsFilter: 'all' },
    });

    expect(result.ok).toBe(true);
    expect(browser.snapshot).toHaveBeenCalledWith({ elementsFilter: 'all' });
  });

  it('keeps the official adapter inside the import boundary', () => {
    expect(
      checkSiteAdapterImportBoundary({
        adapterRoot: 'src/site-adapters/books-to-scrape',
      })
    ).toEqual([]);
  });

  it('declares the low-risk search draft capability and Procedure repair surface', () => {
    expect(booksToScrapeAdapter.manifest.capabilities).toEqual(
      expect.arrayContaining([
        'books_to_scrape.extract_product',
        'books_to_scrape.prepare_search_draft',
      ])
    );
    expect(booksToScrapeAdapter.manifest.repairScope?.allowedSubpaths).toEqual(
      expect.arrayContaining(['procedures'])
    );
  });

  it('runs the official low-risk procedure sample with traceable and replayable actions', async () => {
    const procedure = booksToScrapeAdapter.procedures?.find(
      (item) => item.id === 'save-search-draft'
    );
    expect(procedure).toBeDefined();
    expect(booksToScrapeAdapter.manifest.procedures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'save-search-draft',
          sideEffectLevel: 'low',
          requiredScopes: ['browser.write'],
        }),
      ])
    );

    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockImplementation(async (selector: string) => {
        if (selector === '#search-query') {
          return 'poetry';
        }
        if (selector === '#draft-status') {
          return 'Saved search';
        }
        return '';
      }),
      textExists: vi.fn().mockResolvedValue(false),
    } as unknown as BrowserInterface;

    const result = await runSiteAdapterProcedure(procedure!, browser);
    const replayed = replaySiteAdapterTransitions(
      { ...result.runState, phase: 'created', status: 'running', transitions: [] },
      result.transitions
    );

    expect(result.ok).toBe(true);
    expect(browser.type).toHaveBeenCalledWith('#search-query', 'poetry', { clear: true });
    expect(browser.click).toHaveBeenCalledWith('#save-search-draft');
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'enter-query', action: 'type', outcome: 'succeeded' }),
        expect.objectContaining({ stepId: 'save-draft', action: 'click', outcome: 'succeeded' }),
      ])
    );
    expect(replayed.status).toBe('completed');
  });

  it('creates parameterized low-risk search draft procedures', async () => {
    const procedure = createSaveSearchDraftProcedure('science fiction');
    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockImplementation(async (selector: string) => {
        if (selector === '#search-query') {
          return 'science fiction';
        }
        if (selector === '#draft-status') {
          return 'Saved search';
        }
        return '';
      }),
      textExists: vi.fn().mockResolvedValue(false),
    } as unknown as BrowserInterface;

    const result = await runSiteAdapterProcedure(procedure, browser);

    expect(result.ok).toBe(true);
    expect(browser.type).toHaveBeenCalledWith('#search-query', 'science fiction', {
      clear: true,
    });
  });
});
