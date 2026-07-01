import { booksToScrapeAdapter } from './books-to-scrape/adapter';
import { githubProfileAdapter } from './github-profile/adapter';
import { hackerNewsAdapter } from './hacker-news/adapter';
import { npmPackageAdapter } from './npm-package/adapter';
import { openLibraryAdapter } from './open-library/adapter';
import { quotesToScrapeAdapter } from './quotes-to-scrape/adapter';
import { wikipediaArticleAdapter } from './wikipedia-article/adapter';
import {
  createSiteAdapterRegistry,
  type SiteAdapterModule,
  type SiteAdapterProvider,
} from '../core/site-adapter-runtime';
import { getPluginRegistry } from '../core/js-plugin/registry';
import { createPluginSiteAdapterProvider } from '../core/js-plugin/site-adapter-provider';

const builtInSiteAdapters: SiteAdapterModule[] = [
  booksToScrapeAdapter,
  githubProfileAdapter,
  quotesToScrapeAdapter,
  hackerNewsAdapter,
  wikipediaArticleAdapter,
  openLibraryAdapter,
  npmPackageAdapter,
];

export const builtInSiteAdapterProvider: SiteAdapterProvider = {
  id: 'built-in-site-adapters',
  listAdapters() {
    return builtInSiteAdapters.map((module) => ({
      module,
      source: 'built-in' as const,
      packageRoot: `src/site-adapters/${module.manifest.id}`,
      trusted: true,
    }));
  },
};

export const trustedPluginSiteAdapterProvider = createPluginSiteAdapterProvider(
  getPluginRegistry()
);

export const siteAdapterRegistry = createSiteAdapterRegistry([
  builtInSiteAdapterProvider,
  trustedPluginSiteAdapterProvider,
]);

export const officialSiteAdapters: SiteAdapterModule[] = [...builtInSiteAdapters];

export function getOfficialSiteAdapter(adapterId: string): SiteAdapterModule | null {
  return builtInSiteAdapters.find((adapter) => adapter.manifest.id === adapterId) ?? null;
}

export const listRegisteredSiteAdapters = () => siteAdapterRegistry.listRegisteredAdapters();
