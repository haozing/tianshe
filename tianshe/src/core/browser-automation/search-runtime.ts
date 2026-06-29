import type { SnapshotElement } from '../browser-core/types';
import { decorateSearchResultsWithRefs } from './element-ref';
import { ElementSearchEngine, type SearchOptions, type SearchResult } from './element-search';

export function searchSnapshotElements(
  query: string,
  elements: SnapshotElement[],
  options?: SearchOptions
): SearchResult[] {
  return decorateSearchResultsWithRefs(ElementSearchEngine.search(query, elements, options));
}
