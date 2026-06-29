import type {
  SiteAdapterExtractor,
  SiteAdapterExtractorContext,
} from '../../../core/site-adapter-runtime';
import {
  asSnapshot,
  confidenceFromRequired,
  elementText,
  elementsMatching,
  firstText,
  pageFingerprint,
  selectorHit,
} from '../../shared/snapshot-utils';

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstHref(snapshot: ReturnType<typeof asSnapshot>, selectorParts: readonly string[]): string {
  const element = elementsMatching(snapshot, selectorParts).find(
    (item) => typeof item.attributes?.href === 'string' && item.attributes.href
  );
  return element ? String(element.attributes?.href || '') : '';
}

export const npmPackageSummaryExtractor: SiteAdapterExtractor = {
  id: 'package-summary',
  extract(context: SiteAdapterExtractorContext) {
    const snapshot = asSnapshot(context.snapshot);
    const packageName = firstText(snapshot, ['package-name', 'h1']);
    const description = firstText(snapshot, ['package-description', 'description']);
    const version = firstText(snapshot, ['package-version', 'version']).replace(/^version\s+/i, '');
    const weeklyDownloadText = firstText(snapshot, [
      'weekly-downloads',
      'weekly downloads',
      'downloads',
    ]);
    const license = firstText(snapshot, ['license']);
    const repositoryUrl = firstHref(snapshot, ['repository', 'github.com']);
    const weeklyDownloadCount = parseInteger(weeklyDownloadText);
    const confidence = confidenceFromRequired([
      packageName,
      description,
      version,
      weeklyDownloadCount,
      license,
    ]);

    return {
      packageName,
      description,
      version,
      weeklyDownloadCount,
      license,
      repositoryUrl,
      sourceUrl: snapshot.url,
      pageTitle: snapshot.title,
      confidence,
      selectorHits: [
        selectorHit('packageName', '[data-testid="package-name"]', snapshot, [
          'package-name',
          'h1',
        ]),
        selectorHit('description', '[data-testid="package-description"]', snapshot, [
          'package-description',
          'description',
        ]),
        selectorHit('version', '[data-testid="package-version"]', snapshot, [
          'package-version',
          'version',
        ]),
        selectorHit('weeklyDownloadCount', '[data-testid="weekly-downloads"]', snapshot, [
          'weekly-downloads',
          'weekly downloads',
          'downloads',
        ]),
        selectorHit('license', '[data-testid="license"]', snapshot, ['license']),
        selectorHit('repositoryUrl', 'a[aria-label="Repository"]', snapshot, [
          'repository',
          'github.com',
        ]),
      ],
      missingFields: [
        ...(packageName ? [] : ['packageName']),
        ...(description ? [] : ['description']),
        ...(version ? [] : ['version']),
        ...(weeklyDownloadCount ? [] : ['weeklyDownloadCount']),
        ...(license ? [] : ['license']),
        ...(repositoryUrl ? [] : ['repositoryUrl']),
      ],
      extractorVersion: '1.0.0',
      runner: String(context.input.runner || 'fixture'),
      pageFingerprint: pageFingerprint(snapshot),
      warnings: [],
    };
  },
};
