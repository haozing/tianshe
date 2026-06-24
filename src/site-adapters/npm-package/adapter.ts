import type { SiteAdapterModule } from '../../core/site-adapter-runtime';
import { npmPackageSummaryExtractor } from './extractors/package-summary';
import { npmPackageSummaryVerifier } from './verifiers/package-summary';

export const npmPackageAdapter: SiteAdapterModule = {
  manifest: {
    id: 'npm-package',
    name: 'npm Package',
    version: '1.0.0',
    site: 'npmjs.com',
    siteId: 'npm',
    sideEffectLevel: 'read-only',
    capabilities: ['npm.extract_package_summary'],
    supportedRunners: ['fixture', 'browser-snapshot'],
    riskLevel: 'low',
    requiredScopes: ['browser.read'],
    repairScope: {
      roots: ['src/site-adapters/npm-package', 'site-adapters/npm-package'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected'],
    },
    fixtures: ['vite-package'],
    expected: ['vite-package'],
    extractors: [
      {
        id: 'package-summary',
        outputFields: [
          'packageName',
          'description',
          'version',
          'weeklyDownloadCount',
          'license',
          'repositoryUrl',
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
        id: 'npm-package-summary-required-fields',
        description: 'Checks that package summary extraction produced package metadata.',
      },
    ],
  },
  extractors: [npmPackageSummaryExtractor],
  verifiers: [npmPackageSummaryVerifier],
};
