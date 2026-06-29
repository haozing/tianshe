import { booksToScrapeAdapter } from './books-to-scrape/adapter';
import { githubProfileAdapter } from './github-profile/adapter';
import { hackerNewsAdapter } from './hacker-news/adapter';
import { npmPackageAdapter } from './npm-package/adapter';
import { openLibraryAdapter } from './open-library/adapter';
import { quotesToScrapeAdapter } from './quotes-to-scrape/adapter';
import { wikipediaArticleAdapter } from './wikipedia-article/adapter';
import type { SiteAdapterModule } from '../core/site-adapter-runtime';

export const officialSiteAdapters: SiteAdapterModule[] = [
  booksToScrapeAdapter,
  githubProfileAdapter,
  quotesToScrapeAdapter,
  hackerNewsAdapter,
  wikipediaArticleAdapter,
  openLibraryAdapter,
  npmPackageAdapter,
];

export function getOfficialSiteAdapter(adapterId: string): SiteAdapterModule | null {
  return officialSiteAdapters.find((adapter) => adapter.manifest.id === adapterId) ?? null;
}
