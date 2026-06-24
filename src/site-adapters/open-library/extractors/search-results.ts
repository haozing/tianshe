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

function parseYear(value: string): number | null {
  const match = value.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export const openLibrarySearchResultsExtractor: SiteAdapterExtractor = {
  id: 'search-results',
  extract(context: SiteAdapterExtractorContext) {
    const snapshot = asSnapshot(context.snapshot);
    const titles = elementsMatching(snapshot, ['.searchResultItem .booktitle', '.booktitle']).map(
      elementText
    );
    const authors = elementsMatching(snapshot, ['.searchResultItem .bookauthor', '.bookauthor']).map(
      (element) => elementText(element).replace(/^by\s+/i, '')
    );
    const years = elementsMatching(snapshot, ['.searchResultItem .publishedYear', '.publishedYear']).map(
      (element) => parseYear(elementText(element))
    );
    const results = titles.map((title, index) => ({
      title,
      author: authors[index] || '',
      firstPublishedYear: years[index] || null,
    }));
    const query = firstText(snapshot, ['input[name="q"]', '#search-input']);
    const nextPageUrl = firstText(snapshot, ['a[rel="next"]', '.pagination-next']) ? '/search?q=database&page=2' : '';
    const confidence = confidenceFromRequired([results, query]);

    return {
      query,
      results,
      resultCount: results.length,
      nextPageUrl,
      sourceUrl: snapshot.url,
      pageTitle: snapshot.title,
      confidence,
      selectorHits: [
        selectorHit('results', '.booktitle', snapshot, ['.searchResultItem .booktitle', '.booktitle']),
        selectorHit('authors', '.bookauthor', snapshot, ['.searchResultItem .bookauthor', '.bookauthor']),
        selectorHit('nextPageUrl', 'a[rel="next"]', snapshot, ['a[rel="next"]', '.pagination-next']),
      ],
      missingFields: [
        ...(results.length ? [] : ['results']),
        ...(query ? [] : ['query']),
      ],
      pagination: {
        currentPage: 1,
        hasNextPage: Boolean(nextPageUrl),
        nextPageUrl,
      },
      extractorVersion: '1.0.0',
      runner: String(context.input.runner || 'fixture'),
      pageFingerprint: pageFingerprint(snapshot),
      warnings: [],
    };
  },
};
