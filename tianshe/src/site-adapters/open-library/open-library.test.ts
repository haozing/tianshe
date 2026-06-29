// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import type { BrowserInterface } from '../../types/browser-interface';
import {
  replaySiteAdapterTransitions,
  runSiteAdapterProcedure,
} from '../../core/site-adapter-runtime';
import { openLibraryAdapter } from './adapter';
import { createOpenLibrarySearchDraftProcedure } from './procedures/prepare-search-draft';

describe('open library site adapter', () => {
  it('declares the low-risk search draft capability and Procedure repair surface', () => {
    expect(openLibraryAdapter.manifest.capabilities).toEqual(
      expect.arrayContaining([
        'open_library.extract_search_results',
        'open_library.prepare_search_draft',
      ])
    );
    expect(openLibraryAdapter.manifest.supportedRunners).toEqual(
      expect.arrayContaining(['fixture', 'browser-snapshot', 'procedure'])
    );
    expect(openLibraryAdapter.manifest.repairScope?.allowedSubpaths).toEqual(
      expect.arrayContaining(['procedures'])
    );
    expect(openLibraryAdapter.manifest.procedures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'prepare-search-draft',
          sideEffectLevel: 'low',
          requiredScopes: ['browser.write'],
          verification: expect.stringContaining('pagination'),
        }),
      ])
    );
  });

  it('runs the official low-risk search draft procedure with traceable actions', async () => {
    const procedure = openLibraryAdapter.procedures?.find(
      (item) => item.id === 'prepare-search-draft'
    );
    expect(procedure).toBeDefined();
    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockImplementation(async (selector: string) =>
        selector === 'input[name="q"]'
          ? 'database'
          : selector === '.search-results'
            ? 'Search Results for database'
            : ''
      ),
      textExists: vi.fn().mockResolvedValue(false),
    } as unknown as BrowserInterface;

    const result = await runSiteAdapterProcedure(procedure!, browser);
    const replayed = replaySiteAdapterTransitions(
      { ...result.runState, phase: 'created', status: 'running', transitions: [] },
      result.transitions
    );

    expect(result.ok).toBe(true);
    expect(browser.type).toHaveBeenCalledWith('input[name="q"]', 'database', {
      clear: true,
    });
    expect(browser.click).toHaveBeenCalledWith('a[rel="next"]');
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'enter-query',
          action: 'type',
          outcome: 'succeeded',
        }),
        expect.objectContaining({
          stepId: 'preview-next-results-page',
          action: 'paginate',
          output: expect.objectContaining({
            pagesVisited: 1,
            stopReason: 'max_pages',
          }),
        }),
      ])
    );
    expect(replayed.status).toBe('completed');
  });

  it('creates parameterized low-risk Open Library search draft procedures', async () => {
    const procedure = createOpenLibrarySearchDraftProcedure('database systems');
    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockRejectedValue(new Error('next missing')),
      click: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockImplementation(async (selector: string) =>
        selector === 'input[name="q"]' ? 'database systems' : ''
      ),
      textExists: vi.fn().mockResolvedValue(false),
    } as unknown as BrowserInterface;

    const result = await runSiteAdapterProcedure(procedure, browser);

    expect(result.ok).toBe(true);
    expect(browser.type).toHaveBeenCalledWith('input[name="q"]', 'database systems', {
      clear: true,
    });
    expect(browser.click).not.toHaveBeenCalled();
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'preview-next-results-page',
          output: expect.objectContaining({
            pagesVisited: 0,
            stopReason: 'next_missing',
          }),
        }),
      ])
    );
  });
});
