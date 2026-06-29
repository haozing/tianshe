import type { SiteAdapterModule } from '../../core/site-adapter-runtime';
import { openLibrarySearchResultsExtractor } from './extractors/search-results';
import { openLibrarySearchDraftProcedure } from './procedures/prepare-search-draft';
import { openLibrarySearchResultsVerifier } from './verifiers/search-results';

export const openLibraryAdapter: SiteAdapterModule = {
  manifest: {
    id: 'open-library',
    name: 'Open Library',
    version: '1.0.0',
    site: 'openlibrary.org',
    siteId: 'open_library',
    sideEffectLevel: 'low',
    capabilities: [
      'open_library.extract_search_results',
      'open_library.prepare_search_draft',
    ],
    supportedRunners: ['fixture', 'browser-snapshot', 'procedure'],
    riskLevel: 'low',
    requiredScopes: ['browser.read'],
    repairScope: {
      roots: ['src/site-adapters/open-library', 'site-adapters/open-library'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected', 'procedures'],
    },
    fixtures: ['database-search'],
    expected: ['database-search'],
    extractors: [
      {
        id: 'search-results',
        outputFields: [
          'query',
          'results',
          'resultCount',
          'nextPageUrl',
          'sourceUrl',
          'confidence',
          'selectorHits',
          'missingFields',
          'pagination',
          'pageFingerprint',
        ],
      },
    ],
    verifiers: [
      {
        id: 'open-library-search-required-fields',
        description: 'Checks that search result extraction produced query, result rows and source URL.',
      },
    ],
    procedures: [
      {
        id: openLibrarySearchDraftProcedure.id,
        description:
          'Fill a low-risk Open Library search draft and preview the next result page when pagination is available.',
        sideEffectLevel: openLibrarySearchDraftProcedure.sideEffectLevel,
        requiredScopes: ['browser.write'],
        verification:
          'Requires the typed query to be visible and records pagination preview evidence or a next_missing stop reason.',
      },
    ],
  },
  extractors: [openLibrarySearchResultsExtractor],
  verifiers: [openLibrarySearchResultsVerifier],
  procedures: [openLibrarySearchDraftProcedure],
};
