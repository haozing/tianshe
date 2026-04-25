import type { NetworkEntry } from '../browser-core/types';
import type { NetworkFilter, NetworkSummary } from '../../types/browser-interface';

const DOCUMENT_RESOURCE_TYPES = new Set([
  'mainframe',
  'subframe',
  'document',
  'iframe',
  'frame',
]);

const API_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'websocket', 'eventsource']);
const STATIC_RESOURCE_TYPES = new Set([
  'script',
  'stylesheet',
  'font',
  'manifest',
  'other-static',
]);
const MEDIA_RESOURCE_TYPES = new Set(['image', 'media']);

const API_URL_PATTERN = /(?:^|[/?#])(api|graphql|rpc)(?:[/?#]|$)/i;
const STATIC_URL_PATTERN = /\.(?:css|js|mjs|woff2?|ttf|otf)(?:[?#].*)?$/i;
const MEDIA_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|mp4|webm|mp3|wav|mov)(?:[?#].*)?$/i;

export function classifyNetworkEntry(entry: Pick<NetworkEntry, 'resourceType' | 'url'>): NetworkEntry['classification'] {
  const resourceType = String(entry.resourceType || '').trim().toLowerCase();
  const url = String(entry.url || '');

  if (DOCUMENT_RESOURCE_TYPES.has(resourceType)) return 'document';
  if (API_RESOURCE_TYPES.has(resourceType) || API_URL_PATTERN.test(url)) return 'api';
  if (MEDIA_RESOURCE_TYPES.has(resourceType) || MEDIA_URL_PATTERN.test(url)) return 'media';
  if (STATIC_RESOURCE_TYPES.has(resourceType) || STATIC_URL_PATTERN.test(url)) return 'static';
  return 'other';
}

export function matchesNetworkFilter(entry: NetworkEntry, filter?: NetworkFilter): boolean {
  if (!filter) return true;

  if (filter.type && filter.type !== 'all' && entry.classification !== filter.type) {
    return false;
  }

  if (filter.method && String(entry.method || '').toUpperCase() !== String(filter.method).toUpperCase()) {
    return false;
  }

  if (filter.urlPattern) {
    const regex = new RegExp(filter.urlPattern);
    if (!regex.test(entry.url)) return false;
  }

  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (typeof entry.status !== 'number' || !statuses.includes(entry.status)) {
      return false;
    }
  }

  if (typeof filter.minDuration === 'number' && (entry.duration || 0) < filter.minDuration) {
    return false;
  }

  return true;
}

export function summarizeNetworkEntries(entries: NetworkEntry[]): NetworkSummary {
  const byType: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  const failed: NetworkSummary['failed'] = [];
  const slow: NetworkSummary['slow'] = [];
  const apiCalls: NetworkEntry[] = [];

  for (const entry of entries) {
    byType[entry.classification] = (byType[entry.classification] || 0) + 1;
    byMethod[entry.method] = (byMethod[entry.method] || 0) + 1;

    if (entry.classification === 'api') {
      apiCalls.push(entry);
    }

    if (typeof entry.status === 'number' && entry.status >= 400) {
      failed.push({
        url: entry.url,
        status: entry.status,
        method: entry.method,
      });
    }

    if (typeof entry.duration === 'number' && entry.duration >= 1000) {
      slow.push({
        url: entry.url,
        duration: entry.duration,
        method: entry.method,
      });
    }
  }

  return {
    total: entries.length,
    byType,
    byMethod,
    failed,
    slow,
    apiCalls,
  };
}
