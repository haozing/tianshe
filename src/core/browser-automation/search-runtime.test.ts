import { describe, expect, it } from 'vitest';
import type { SnapshotElement } from '../browser-core/types';
import { searchSnapshotElements } from './search-runtime';

function createElements(): SnapshotElement[] {
  return [
    {
      tag: 'input',
      role: 'textbox',
      name: 'Search catalog',
      text: '',
      value: '',
      preferredSelector: '#search',
      selectorCandidates: ['#search', 'input[name="q"]'],
      inViewport: true,
      bounds: { x: 24, y: 16, width: 180, height: 28 },
    },
    {
      tag: 'button',
      role: 'button',
      name: 'Search',
      text: 'Search',
      preferredSelector: '#submit',
      selectorCandidates: ['#submit', 'button[type="submit"]'],
      inViewport: true,
      bounds: { x: 220, y: 16, width: 90, height: 28 },
    },
    {
      tag: 'button',
      role: 'button',
      name: 'Open Search Drawer',
      text: 'Open',
      preferredSelector: '#open-search',
      selectorCandidates: ['#open-search'],
      inViewport: true,
      bounds: { x: 320, y: 16, width: 120, height: 28 },
    },
  ];
}

describe('search-runtime', () => {
  it('returns decorated element refs for matching search results', () => {
    const results = searchSnapshotElements('search', createElements());

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.element.elementRef).toMatch(/^airpa_el:/);
    expect(results[0]?.element.preferredSelector).toBeTruthy();
  });

  it('respects roleFilter and exactMatch while preserving selector hints', () => {
    const results = searchSnapshotElements('Search', createElements(), {
      roleFilter: 'button',
      exactMatch: true,
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      element: {
        role: 'button',
        preferredSelector: '#submit',
        elementRef: expect.stringMatching(/^airpa_el:/),
      },
      matchedFields: ['name', 'text'],
    });
  });
});
