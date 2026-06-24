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

export const quotesExtractor: SiteAdapterExtractor = {
  id: 'quote-list',
  extract(context: SiteAdapterExtractorContext) {
    const snapshot = asSnapshot(context.snapshot);
    const quoteTexts = elementsMatching(snapshot, ['quote .text', '.quote .text']).map(elementText);
    const authors = elementsMatching(snapshot, ['quote .author', '.author']).map(elementText);
    const tagElements = elementsMatching(snapshot, ['quote .tag', '.tag']).map(elementText);
    const quotes = quoteTexts.map((text, index) => ({
      text,
      author: authors[index] || '',
      tags: tagElements.slice(index * 2, index * 2 + 2),
    }));
    const nextPageUrl = firstText(snapshot, ['li.next a', '.next a']) ? '/page/2/' : '';
    const confidence = confidenceFromRequired([quotes, nextPageUrl]);

    return {
      quotes,
      quoteCount: quotes.length,
      nextPageUrl,
      sourceUrl: snapshot.url,
      pageTitle: snapshot.title,
      confidence,
      selectorHits: [
        selectorHit('quotes', '.quote .text', snapshot, ['quote .text', '.quote .text']),
        selectorHit('authors', '.quote .author', snapshot, ['quote .author', '.author']),
        selectorHit('nextPageUrl', 'li.next a', snapshot, ['li.next a', '.next a']),
      ],
      missingFields: [
        ...(quotes.length ? [] : ['quotes']),
        ...(nextPageUrl ? [] : ['nextPageUrl']),
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
