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

function parseRank(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function parsePoints(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

export const hackerNewsStoriesExtractor: SiteAdapterExtractor = {
  id: 'story-list',
  extract(context: SiteAdapterExtractorContext) {
    const snapshot = asSnapshot(context.snapshot);
    const titles = elementsMatching(snapshot, ['titleline a', '.storylink']).map((element) => ({
      title: elementText(element),
      url: String(element.attributes?.href || ''),
    }));
    const ranks = elementsMatching(snapshot, ['span.rank', '.rank']).map((element) =>
      parseRank(elementText(element))
    );
    const points = elementsMatching(snapshot, ['span.score', '.score']).map((element) =>
      parsePoints(elementText(element))
    );
    const stories = titles.map((item, index) => ({
      rank: ranks[index] || index + 1,
      title: item.title,
      url: item.url,
      points: points[index] || 0,
    }));
    const nextPageUrl = firstText(snapshot, ['a.morelink', '.morelink']) ? 'news?p=2' : '';
    const confidence = confidenceFromRequired([stories, nextPageUrl]);

    return {
      stories,
      storyCount: stories.length,
      nextPageUrl,
      sourceUrl: snapshot.url,
      pageTitle: snapshot.title,
      confidence,
      selectorHits: [
        selectorHit('stories', '.titleline a', snapshot, ['titleline a', '.storylink']),
        selectorHit('points', '.score', snapshot, ['span.score', '.score']),
        selectorHit('nextPageUrl', '.morelink', snapshot, ['a.morelink', '.morelink']),
      ],
      missingFields: [...(stories.length ? [] : ['stories'])],
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
