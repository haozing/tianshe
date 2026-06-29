import { describe, expect, it } from 'vitest';

import { getMergedHiddenColumnNames } from '../../../../utils/dataset-column-capabilities';

describe('dataset-column-capabilities', () => {
  it('merges dataset defaults and query hidden columns', () => {
    const hidden = getMergedHiddenColumnNames(
      [{ name: 'notes', displayConfig: { hidden: true } }, { name: 'email' }],
      ['email']
    );

    expect(hidden).toEqual(['notes', 'email']);
  });

  it('lets query show override dataset default hidden columns', () => {
    const hidden = getMergedHiddenColumnNames(
      [{ name: 'notes', displayConfig: { hidden: true } }, { name: 'email' }],
      ['email'],
      ['notes']
    );

    expect(hidden).toEqual(['email']);
  });

  it('lets explicit selection override dataset default hidden columns', () => {
    const hidden = getMergedHiddenColumnNames(
      [{ name: 'notes', displayConfig: { hidden: true } }, { name: 'email' }],
      ['email'],
      undefined,
      ['notes']
    );

    expect(hidden).toEqual(['email']);
  });
});
