import type {
  SiteAdapterExtractor,
  SiteAdapterExtractorContext,
} from '../../../core/site-adapter-runtime';
import {
  asSnapshot,
  confidenceFromRequired,
  firstText,
  pageFingerprint,
  selectorHit,
} from '../../shared/snapshot-utils';

export const wikipediaArticleExtractor: SiteAdapterExtractor = {
  id: 'article-summary',
  extract(context: SiteAdapterExtractorContext) {
    const snapshot = asSnapshot(context.snapshot);
    const title = firstText(snapshot, ['h1.firstHeading', '#firstHeading', 'h1']);
    const summary = firstText(snapshot, ['p.lead', 'mw-parser-output p', 'article-summary']);
    const infoboxTitle = firstText(snapshot, ['infobox caption', '.infobox caption']);
    const confidence = confidenceFromRequired([title, summary]);

    return {
      title,
      summary,
      infoboxTitle,
      language: 'en',
      sourceUrl: snapshot.url,
      pageTitle: snapshot.title,
      confidence,
      selectorHits: [
        selectorHit('title', '#firstHeading', snapshot, ['h1.firstHeading', '#firstHeading', 'h1']),
        selectorHit('summary', '.mw-parser-output p', snapshot, ['p.lead', 'mw-parser-output p']),
      ],
      missingFields: [
        ...(title ? [] : ['title']),
        ...(summary ? [] : ['summary']),
      ],
      extractorVersion: '1.0.0',
      runner: String(context.input.runner || 'fixture'),
      pageFingerprint: pageFingerprint(snapshot),
      warnings: [],
    };
  },
};
