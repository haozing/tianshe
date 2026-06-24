import { createRequiredFieldsVerifier } from '../../shared/snapshot-utils';

export const openLibrarySearchResultsVerifier = createRequiredFieldsVerifier(
  'open-library-search-required-fields',
  ['query', 'results', 'resultCount', 'sourceUrl']
);
