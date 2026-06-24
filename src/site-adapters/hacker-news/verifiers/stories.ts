import { createRequiredFieldsVerifier } from '../../shared/snapshot-utils';

export const hackerNewsStoriesVerifier = createRequiredFieldsVerifier('hn-story-required-fields', [
  'stories',
  'storyCount',
  'sourceUrl',
]);
