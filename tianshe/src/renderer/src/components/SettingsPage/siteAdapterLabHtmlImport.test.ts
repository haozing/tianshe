/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { captureSiteAdapterFixture, runSiteAdapterLabFixturePanel } from '../../../../core/site-adapter-lab';
import { booksToScrapeAdapter } from '../../../../site-adapters/books-to-scrape/adapter';
import { createPageSnapshotFromHtml } from './siteAdapterLabHtmlImport';

describe('site adapter lab HTML import', () => {
  it('turns imported HTML into a sanitized fixture that the runner can consume', async () => {
    const snapshot = createPageSnapshotFromHtml(
      `
        <html>
          <head><title>A Light in the Attic | Books to Scrape</title></head>
          <body>
            <h1>A Light in the Attic</h1>
            <p class="price_color">£51.77</p>
            <p class="instock availability">In stock (22 available)</p>
            <p class="star-rating Three"></p>
            <a href="/cart?token=secret-value">cart</a>
          </body>
        </html>
      `,
      'file://product.html'
    );
    const capture = captureSiteAdapterFixture({
      name: 'product-html',
      snapshot,
      input: { runner: 'imported-html' },
    });

    expect(JSON.stringify(capture.fixture)).not.toContain('secret-value');
    expect(snapshot.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'h1', text: 'A Light in the Attic' }),
        expect.objectContaining({
          attributes: expect.objectContaining({ class: 'price_color' }),
        }),
      ])
    );

    const result = await runSiteAdapterLabFixturePanel(
      booksToScrapeAdapter,
      capture.fixture,
      {
        productName: 'A Light in the Attic',
        price: '£51.77',
        availability: 'In stock (22 available)',
        rating: '3',
      }
    );

    expect(result.fixtureRunner.ok).toBe(true);
    expect(result.runnerComparison.fixtureRunnerOk).toBe(true);
  });
});
