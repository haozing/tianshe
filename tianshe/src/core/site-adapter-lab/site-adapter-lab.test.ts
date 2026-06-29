// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it } from 'vitest';
import {
  createSiteAdapterRepairBundleView,
  captureSiteAdapterFixture,
  runSelectorWorkbench,
  runSiteAdapterLabFixturePanel,
} from './index';
import type { BrowserInterface } from '../../types/browser-interface';
import {
  runReadOnlySiteAdapterFixture,
  type SiteAdapterFixtureRunResult,
} from '../site-adapter-runtime';
import { booksToScrapeAdapter } from '../../site-adapters/books-to-scrape/adapter';
import fixture from '../../site-adapters/books-to-scrape/fixtures/product-page.json';
import expected from '../../site-adapters/books-to-scrape/expected/product-page.json';

describe('site adapter lab core', () => {
  it('captures sanitized fixtures without secret-bearing values', () => {
    const result = captureSiteAdapterFixture({
      name: 'captured-product',
      snapshot: {
        ...fixture.snapshot,
        network: [
          {
            id: 'req-1',
            url: 'https://books.toscrape.com/?token=secret-value',
            method: 'GET',
            resourceType: 'document',
            classification: 'document',
            requestHeaders: {
              authorization: 'Bearer abc123',
              cookie: 'session=abc',
            },
            startTime: 1,
          },
        ],
      },
      screenshotDataUrl: 'data:image/png;base64,abc',
    });

    expect(JSON.stringify(result.fixture)).not.toMatch(/abc123|session=abc|secret-value/);
    expect(result.redactions.length).toBeGreaterThan(0);
    expect(result.screenshotDataUrl).toBe('[REDACTED_SCREENSHOT_STORED_AS_ARTIFACT]');
  });

  it('returns selector hits and fallback selectors from a snapshot', () => {
    const result = runSelectorWorkbench(fixture.snapshot, '.price_color');

    expect(result).toMatchObject({
      selector: '.price_color',
      count: 1,
      hits: [expect.objectContaining({ textPreview: '£51.77' })],
      fallbackSelectors: expect.arrayContaining(['.price_color']),
    });
  });

  it('runs the fixture runner panel and expected diff', async () => {
    const result = await runSiteAdapterLabFixturePanel(
      booksToScrapeAdapter,
      {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected
    );

    expect(result.fixtureRunner.ok).toBe(true);
    expect(result.expectedDiff.every((diagnostic) => diagnostic.ok)).toBe(true);
    expect(result.runnerComparison).toMatchObject({
      fixtureRunnerOk: true,
      driftStatus: 'not_compared',
      runners: {
        browserSnapshot: { status: 'not_configured', ok: null },
        playwrightLab: { status: 'not_configured', ok: null },
      },
    });
  });

  it('compares fixture, browser-snapshot, and Playwright Lab runners when provided', async () => {
    const browser = {
      snapshot: async () => fixture.snapshot,
    } as Pick<BrowserInterface, 'snapshot'>;
    const result = await runSiteAdapterLabFixturePanel(
      booksToScrapeAdapter,
      {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected,
      {
        browserRunner: { browser },
        playwrightLabRunner: {
          run: ({ adapter, fixture: labFixture, expected: labExpected }) =>
            runReadOnlySiteAdapterFixture(adapter, {
              ...labFixture,
              expected: labExpected,
            }),
        },
      }
    );

    expect(result.runnerComparison).toMatchObject({
      browserRunnerOk: true,
      playwrightLabRunnerOk: true,
      driftStatus: 'aligned',
      runners: {
        browserSnapshot: { status: 'passed', ok: true },
        playwrightLab: { status: 'passed', ok: true },
      },
    });
  });

  it('reports runner drift and explicit environment gaps', async () => {
    const result = await runSiteAdapterLabFixturePanel(
      booksToScrapeAdapter,
      {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected,
      {
        browserRunner: { unavailableReason: 'No browser session is attached to the Lab.' },
        playwrightLabRunner: {
          run: async ({ adapter, fixture: labFixture, expected: labExpected }) => {
            const baseline = await runReadOnlySiteAdapterFixture(adapter, {
              ...labFixture,
              expected: labExpected,
            });
            return {
              ...baseline,
              adapterId: booksToScrapeAdapter.manifest.id,
              fixtureName: labFixture.name,
              ok: true,
              result: { ...baseline.result, price: '£0.00' },
              diagnostics: [],
              verifierResults: [],
              artifactRefs: [],
            } satisfies SiteAdapterFixtureRunResult;
          },
        },
      }
    );

    expect(result.runnerComparison.driftStatus).toBe('environment_gap');
    expect(result.runnerComparison.runners.browserSnapshot).toMatchObject({
      status: 'environment_gap',
      ok: null,
      message: expect.stringContaining('No browser session'),
    });
    expect(result.runnerComparison.runners.playwrightLab).toMatchObject({
      status: 'passed',
      ok: true,
      result: expect.objectContaining({ price: '£0.00' }),
    });

    const driftOnly = await runSiteAdapterLabFixturePanel(
      booksToScrapeAdapter,
      {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected,
      {
        playwrightLabRunner: {
          run: async ({ adapter, fixture: labFixture, expected: labExpected }) => {
            const baseline = await runReadOnlySiteAdapterFixture(adapter, {
              ...labFixture,
              expected: labExpected,
            });
            return {
              ...baseline,
              adapterId: booksToScrapeAdapter.manifest.id,
              fixtureName: labFixture.name,
              ok: true,
              result: { ...baseline.result, price: '£0.00' },
              diagnostics: [],
              verifierResults: [],
              artifactRefs: [],
            } satisfies SiteAdapterFixtureRunResult;
          },
        },
      }
    );

    expect(driftOnly.runnerComparison.driftStatus).toBe('drift');
  });

  it('summarizes site adapter repair bundles for the Lab viewer', () => {
    const view = createSiteAdapterRepairBundleView({
      traceId: 'trace-repair',
      recentEvents: [],
      artifactRefs: [],
      siteAdapterRepairBundle: {
        artifactId: 'artifact-repair',
        traceId: 'trace-repair',
        timestamp: 1,
        type: 'site_adapter_repair_bundle',
        component: 'site-capability',
        data: {
          adapterId: 'books-to-scrape',
          fixtureName: 'product-page',
          sideEffectLevel: 'read-only',
          diagnostics: [
            { path: 'price', ok: false, expected: '£51.77', actual: '' },
            { path: 'productName', ok: true, expected: 'present', actual: 'A Light in the Attic' },
          ],
          actionTrace: [{ stepId: 'product' }],
          transitions: [{ stepId: 'product' }],
        },
      },
    });

    expect(view).toMatchObject({
      traceId: 'trace-repair',
      artifactId: 'artifact-repair',
      adapterId: 'books-to-scrape',
      fixtureName: 'product-page',
      sideEffectLevel: 'read-only',
      missingFields: ['price'],
      suggestions: [
        expect.objectContaining({
          kind: 'selector_repair',
          target: 'price',
          evidencePath: 'price',
          expected: '£51.77',
          actual: '',
        }),
      ],
      actionTraceCount: 1,
      transitionCount: 1,
    });
  });
});
