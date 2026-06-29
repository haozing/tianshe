import { describe, expect, it } from 'vitest';
import type { SnapshotElement } from '../browser-core/types';
import {
  createElementRef,
  decodeElementRef,
  decorateSearchResultsWithRefs,
  decorateSnapshotElementWithRef,
  getElementRefSelectors,
} from './element-ref';

const exampleElement: SnapshotElement = {
  tag: 'input',
  role: 'textbox',
  name: 'Search catalog',
  text: '',
  placeholder: 'Search products',
  attributes: {
    id: 'search',
    name: 'q',
    'aria-label': 'Search catalog',
  },
  preferredSelector: '#search',
  selectorCandidates: ['#search', 'input[name="q"]'],
};

describe('element-ref', () => {
  it('round-trips element metadata and selector hints', () => {
    const ref = createElementRef(exampleElement);

    expect(ref).toMatch(/^airpa_el:/);
    expect(decodeElementRef(ref)).toMatchObject({
      v: 1,
      kind: 'snapshot-element',
      tag: 'input',
      role: 'textbox',
      name: 'Search catalog',
      placeholder: 'Search products',
      preferredSelector: '#search',
      selectorCandidates: ['#search', 'input[name="q"]'],
    });

    expect(getElementRefSelectors(ref)).toEqual(
      expect.arrayContaining([
        '#search',
        'input[name="q"]',
        '[id="search"]',
        'input[aria-label="Search catalog"]',
        'input[placeholder="Search products"]',
      ])
    );
  });

  it('decorates snapshot elements and search results with elementRef', () => {
    const decoratedElement = decorateSnapshotElementWithRef(exampleElement);
    const decoratedResults = decorateSearchResultsWithRefs([
      {
        score: 0.91,
        matchedFields: ['name'],
        element: exampleElement,
      },
    ]);

    expect(decoratedElement.elementRef).toMatch(/^airpa_el:/);
    expect(decoratedResults[0]?.element.elementRef).toMatch(/^airpa_el:/);
  });
});
