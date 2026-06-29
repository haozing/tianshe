import type { SiteAdapterProcedureDefinition } from '../../../core/site-adapter-runtime';

export function createOpenLibrarySearchDraftProcedure(
  query = 'database'
): SiteAdapterProcedureDefinition {
  const searchQuery = query.trim() || 'database';
  return {
    id: 'prepare-search-draft',
    adapterId: 'open-library',
    sideEffectLevel: 'low',
    steps: [
      {
        id: 'enter-query',
        action: 'type',
        selector: 'input[name="q"]',
        text: searchQuery,
        clear: true,
        verify: {
          id: 'query-visible',
          action: 'verifyText',
          selector: 'input[name="q"]',
          text: searchQuery,
        },
      },
      {
        id: 'preview-next-results-page',
        action: 'paginate',
        nextSelector: 'a[rel="next"]',
        pageReadySelector: '.search-results',
        maxPages: 1,
        timeout: 2000,
        stopWhenNextMissing: true,
        verify: {
          id: 'results-visible',
          action: 'verifyText',
          selector: '.search-results',
          text: 'Search Results',
        },
      },
    ],
  };
}

export const openLibrarySearchDraftProcedure: SiteAdapterProcedureDefinition =
  createOpenLibrarySearchDraftProcedure();
