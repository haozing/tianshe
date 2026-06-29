// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it } from 'vitest';
import {
  runReadOnlySiteAdapterFixture,
  SITE_ADAPTER_REQUIRED_QUALITY_FIELDS,
} from '../core/site-adapter-runtime';
import { officialSiteAdapters } from './index';
import quotesFixture from './quotes-to-scrape/fixtures/quotes-page-1.json';
import quotesExpected from './quotes-to-scrape/expected/quotes-page-1.json';
import hackerNewsFixture from './hacker-news/fixtures/front-page.json';
import hackerNewsExpected from './hacker-news/expected/front-page.json';
import wikipediaFixture from './wikipedia-article/fixtures/ada-lovelace.json';
import wikipediaExpected from './wikipedia-article/expected/ada-lovelace.json';
import openLibraryFixture from './open-library/fixtures/database-search.json';
import openLibraryExpected from './open-library/expected/database-search.json';
import npmPackageFixture from './npm-package/fixtures/vite-package.json';
import npmPackageExpected from './npm-package/expected/vite-package.json';

const cases = [
  {
    adapterId: 'quotes-to-scrape',
    fixture: quotesFixture,
    expected: quotesExpected,
    requiredField: 'quotes',
  },
  {
    adapterId: 'hacker-news',
    fixture: hackerNewsFixture,
    expected: hackerNewsExpected,
    requiredField: 'stories',
  },
  {
    adapterId: 'wikipedia-article',
    fixture: wikipediaFixture,
    expected: wikipediaExpected,
    requiredField: 'title',
  },
  {
    adapterId: 'open-library',
    fixture: openLibraryFixture,
    expected: openLibraryExpected,
    requiredField: 'results',
  },
  {
    adapterId: 'npm-package',
    fixture: npmPackageFixture,
    expected: npmPackageExpected,
    requiredField: 'packageName',
  },
] as const;

describe('additional official read-only site adapters', () => {
  it('registers at least seven official adapters for discovery and Lab selection', () => {
    expect(officialSiteAdapters.map((adapter) => adapter.manifest.id)).toEqual(
      expect.arrayContaining([
        'books-to-scrape',
        'github-profile',
        'quotes-to-scrape',
        'hacker-news',
        'wikipedia-article',
        'open-library',
        'npm-package',
      ])
    );
    expect(officialSiteAdapters.length).toBeGreaterThanOrEqual(7);
  });

  it('declares the shared site adapter quality fields in every official extractor manifest', () => {
    for (const adapter of officialSiteAdapters) {
      for (const extractor of adapter.manifest.extractors) {
        expect(extractor.outputFields, `${adapter.manifest.id}/${extractor.id}`).toEqual(
          expect.arrayContaining([...SITE_ADAPTER_REQUIRED_QUALITY_FIELDS])
        );
      }
    }
  });

  it.each(cases)('runs %s fixture through the official runner', async ({ adapterId, fixture, expected, requiredField }) => {
    const adapter = officialSiteAdapters.find((item) => item.manifest.id === adapterId);
    expect(adapter).toBeDefined();

    const result = await runReadOnlySiteAdapterFixture(adapter!, {
      name: fixture.name,
      snapshot: fixture.snapshot,
      input: fixture.input,
      expected,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject(expected);
    expect(result.result[requiredField]).toBeTruthy();
    expect(result.result.selectorHits).toEqual(expect.any(Array));
    expect(result.result.pageFingerprint).toMatchObject({
      url: fixture.snapshot.url,
      title: fixture.snapshot.title,
      elementCount: fixture.snapshot.elements.length,
    });
  });
});
