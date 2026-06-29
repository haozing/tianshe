import type { SiteAdapterModule } from '../../core/site-adapter-runtime';
import { wikipediaArticleExtractor } from './extractors/article';
import { wikipediaArticleVerifier } from './verifiers/article';

export const wikipediaArticleAdapter: SiteAdapterModule = {
  manifest: {
    id: 'wikipedia-article',
    name: 'Wikipedia Article',
    version: '1.0.0',
    site: 'en.wikipedia.org',
    siteId: 'wikipedia',
    sideEffectLevel: 'read-only',
    capabilities: ['wikipedia.extract_article_summary'],
    supportedRunners: ['fixture', 'browser-snapshot'],
    riskLevel: 'low',
    requiredScopes: ['browser.read'],
    repairScope: {
      roots: ['src/site-adapters/wikipedia-article', 'site-adapters/wikipedia-article'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected'],
    },
    fixtures: ['ada-lovelace'],
    expected: ['ada-lovelace'],
    extractors: [
      {
        id: 'article-summary',
        outputFields: [
          'title',
          'summary',
          'infoboxTitle',
          'language',
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
        id: 'wikipedia-article-required-fields',
        description: 'Checks that article summary extraction produced title, summary and source URL.',
      },
    ],
  },
  extractors: [wikipediaArticleExtractor],
  verifiers: [wikipediaArticleVerifier],
};
