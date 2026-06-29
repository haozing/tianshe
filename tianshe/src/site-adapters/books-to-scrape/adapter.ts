import type { SiteAdapterModule } from '../../core/site-adapter-runtime';
import { productExtractor } from './extractors/product';
import { saveSearchDraftProcedure } from './procedures/save-search-draft';
import { productVerifier } from './verifiers/product';

export const booksToScrapeAdapter: SiteAdapterModule = {
  manifest: {
    id: 'books-to-scrape',
    name: 'Books to Scrape',
    version: '1.0.0',
    site: 'books.toscrape.com',
    siteId: 'books_to_scrape',
    sideEffectLevel: 'low',
    capabilities: ['books_to_scrape.extract_product', 'books_to_scrape.prepare_search_draft'],
    supportedRunners: ['fixture', 'browser-snapshot', 'procedure'],
    riskLevel: 'low',
    requiredScopes: ['browser.read', 'dataset.write'],
    repairScope: {
      roots: ['src/site-adapters/books-to-scrape', 'site-adapters/books-to-scrape'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected', 'procedures'],
    },
    fixtures: ['product-page'],
    expected: ['product-page'],
    extractors: [
      {
        id: 'product',
        outputFields: [
          'productName',
          'price',
          'availability',
          'rating',
          'upc',
          'productType',
          'sourceUrl',
          'confidence',
          'selectorHits',
          'missingFields',
          'pageFingerprint',
        ],
      },
    ],
    verifiers: [
      {
        id: 'product-required-fields',
        description: 'Checks that product extraction produced required product fields.',
      },
    ],
    procedures: [
      {
        id: saveSearchDraftProcedure.id,
        description: 'Fill a low-risk search draft and verify the saved draft indicator.',
        sideEffectLevel: saveSearchDraftProcedure.sideEffectLevel,
        requiredScopes: ['browser.write'],
        verification: 'Requires visible draft status text before the procedure can complete.',
      },
    ],
  },
  extractors: [productExtractor],
  verifiers: [productVerifier],
  procedures: [saveSearchDraftProcedure],
};
