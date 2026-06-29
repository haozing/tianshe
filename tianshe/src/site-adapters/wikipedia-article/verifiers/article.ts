import { createRequiredFieldsVerifier } from '../../shared/snapshot-utils';

export const wikipediaArticleVerifier = createRequiredFieldsVerifier('wikipedia-article-required-fields', [
  'title',
  'summary',
  'sourceUrl',
]);
