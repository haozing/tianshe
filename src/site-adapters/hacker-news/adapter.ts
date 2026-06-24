import type { SiteAdapterModule } from '../../core/site-adapter-runtime';
import { hackerNewsStoriesExtractor } from './extractors/stories';
import { hackerNewsStoriesVerifier } from './verifiers/stories';

export const hackerNewsAdapter: SiteAdapterModule = {
  manifest: {
    id: 'hacker-news',
    name: 'Hacker News',
    version: '1.0.0',
    site: 'news.ycombinator.com',
    siteId: 'hacker_news',
    sideEffectLevel: 'read-only',
    capabilities: ['hacker_news.extract_story_list'],
    supportedRunners: ['fixture', 'browser-snapshot'],
    riskLevel: 'low',
    requiredScopes: ['browser.read'],
    repairScope: {
      roots: ['src/site-adapters/hacker-news', 'site-adapters/hacker-news'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected'],
    },
    fixtures: ['front-page'],
    expected: ['front-page'],
    extractors: [
      {
        id: 'story-list',
        outputFields: [
          'stories',
          'storyCount',
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
        id: 'hn-story-required-fields',
        description: 'Checks that story list extraction produced stories and source URL.',
      },
    ],
  },
  extractors: [hackerNewsStoriesExtractor],
  verifiers: [hackerNewsStoriesVerifier],
};
