import type { SiteAdapterProcedureDefinition } from '../../../core/site-adapter-runtime';

export function createSaveSearchDraftProcedure(query = 'poetry'): SiteAdapterProcedureDefinition {
  const searchQuery = query.trim() || 'poetry';
  return {
  id: 'save-search-draft',
  adapterId: 'books-to-scrape',
  sideEffectLevel: 'low',
  steps: [
    {
      id: 'enter-query',
      action: 'type',
      selector: '#search-query',
      text: searchQuery,
      clear: true,
      verify: {
        id: 'query-visible',
        action: 'verifyText',
        selector: '#search-query',
        text: searchQuery,
      },
    },
    {
      id: 'save-draft',
      action: 'click',
      selector: '#save-search-draft',
      verify: {
        id: 'draft-saved',
        action: 'verifyText',
        selector: '#draft-status',
        text: 'Saved search',
      },
    },
  ],
};
}

export const saveSearchDraftProcedure: SiteAdapterProcedureDefinition =
  createSaveSearchDraftProcedure();
