import type { SiteAdapterModule } from '../../core/site-adapter-runtime';
import { quotesExtractor } from './extractors/quotes';
import { quotesVerifier } from './verifiers/quotes';

export const quotesToScrapeAdapter: SiteAdapterModule = {
  manifest: {
    id: 'quotes-to-scrape',
    name: 'Quotes to Scrape',
    version: '1.0.0',
    site: 'quotes.toscrape.com',
    siteId: 'quotes_to_scrape',
    sideEffectLevel: 'read-only',
    capabilities: ['quotes_to_scrape.extract_quote_list'],
    supportedRunners: ['fixture', 'browser-snapshot'],
    riskLevel: 'low',
    requiredScopes: ['browser.read'],
    repairScope: {
      roots: ['src/site-adapters/quotes-to-scrape', 'site-adapters/quotes-to-scrape'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected'],
    },
    fixtures: ['quotes-page-1'],
    expected: ['quotes-page-1'],
    extractors: [
      {
        id: 'quote-list',
        outputFields: [
          'quotes',
          'quoteCount',
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
        id: 'quotes-required-fields',
        description: 'Checks that quote list extraction produced quote rows and source URL.',
      },
    ],
  },
  extractors: [quotesExtractor],
  verifiers: [quotesVerifier],
};
