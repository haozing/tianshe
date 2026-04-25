import { describe, expect, it } from 'vitest';
import { classifyNetworkEntry, matchesNetworkFilter, summarizeNetworkEntries } from './network-utils';
import type { NetworkEntry } from '../browser-core/types';

function makeEntry(partial: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: partial.id || '1',
    url: partial.url || 'https://example.com',
    method: partial.method || 'GET',
    resourceType: partial.resourceType || 'mainFrame',
    classification:
      partial.classification ||
      classifyNetworkEntry({
        resourceType: partial.resourceType || 'mainFrame',
        url: partial.url || 'https://example.com',
      }),
    startTime: partial.startTime || 1,
    ...partial,
  };
}

describe('network-utils', () => {
  it('classifies document/api/static/media requests with stable semantics', () => {
    expect(classifyNetworkEntry({ resourceType: 'mainFrame', url: 'https://example.com/' })).toBe(
      'document'
    );
    expect(
      classifyNetworkEntry({ resourceType: 'xhr', url: 'https://example.com/api/orders' })
    ).toBe('api');
    expect(
      classifyNetworkEntry({ resourceType: 'script', url: 'https://example.com/app.js' })
    ).toBe('static');
    expect(
      classifyNetworkEntry({ resourceType: 'image', url: 'https://example.com/logo.png' })
    ).toBe('media');
  });

  it('matches filters without letting document requests leak into api results', () => {
    const documentEntry = makeEntry({
      resourceType: 'mainFrame',
      url: 'https://example.com/',
      classification: 'document',
      status: 200,
    });
    const apiEntry = makeEntry({
      id: '2',
      resourceType: 'xhr',
      url: 'https://example.com/api/orders',
      classification: 'api',
      status: 200,
    });

    expect(matchesNetworkFilter(documentEntry, { type: 'api' })).toBe(false);
    expect(matchesNetworkFilter(apiEntry, { type: 'api' })).toBe(true);
    expect(matchesNetworkFilter(apiEntry, { status: [200, 201] })).toBe(true);
  });

  it('summarizes by classification and method', () => {
    const summary = summarizeNetworkEntries([
      makeEntry({
        resourceType: 'mainFrame',
        classification: 'document',
        method: 'GET',
        status: 200,
      }),
      makeEntry({
        id: '2',
        resourceType: 'xhr',
        classification: 'api',
        method: 'POST',
        status: 500,
        duration: 1450,
        url: 'https://example.com/api/orders',
      }),
    ]);

    expect(summary.total).toBe(2);
    expect(summary.byType).toMatchObject({ document: 1, api: 1 });
    expect(summary.byMethod).toMatchObject({ GET: 1, POST: 1 });
    expect(summary.failed).toHaveLength(1);
    expect(summary.slow).toHaveLength(1);
    expect(summary.apiCalls).toHaveLength(1);
  });
});
