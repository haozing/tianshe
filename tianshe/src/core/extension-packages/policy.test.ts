import { describe, expect, it } from 'vitest';
import {
  normalizeExtensionPackageIdList,
  normalizeExtensionPackagesGlobalConfig,
  resolveExtensionPackagesPolicy,
} from './policy';

describe('extension packages policy', () => {
  it('normalizes extension ids with lowercase + dedupe', () => {
    const ids = normalizeExtensionPackageIdList(
      ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      'requiredExtensionIds'
    );
    expect(ids).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  });

  it('throws when extension id is invalid', () => {
    expect(() =>
      normalizeExtensionPackageIdList(['not-an-extension-id'], 'requiredExtensionIds')
    ).toThrow('invalid extension id');
  });

  it('resolves policy directly from global config', () => {
    const policy = resolveExtensionPackagesPolicy({
      enabled: true,
      requiredExtensionIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      onMissing: 'warn',
    });

    expect(policy.requiredExtensionIds).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(policy.onMissing).toBe('warn');
  });

  it('validates global onMissing', () => {
    expect(() =>
      normalizeExtensionPackagesGlobalConfig({
        onMissing: 'invalid' as any,
      })
    ).toThrow('Invalid onMissing value');
  });
});
