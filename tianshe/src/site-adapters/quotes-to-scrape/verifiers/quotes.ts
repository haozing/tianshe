import { createRequiredFieldsVerifier } from '../../shared/snapshot-utils';

export const quotesVerifier = createRequiredFieldsVerifier('quotes-required-fields', [
  'quotes',
  'quoteCount',
  'sourceUrl',
]);
