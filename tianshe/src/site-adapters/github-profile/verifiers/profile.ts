import type { SiteAdapterVerifier } from '../../../core/site-adapter-runtime';

export const githubProfileVerifier: SiteAdapterVerifier = {
  id: 'profile-required-fields',
  verify(context) {
    const ok = typeof context.result.displayName === 'string' && context.result.displayName.length > 0;
    return {
      ok,
      diagnostics: [
        {
          path: 'displayName',
          ok,
          expected: 'present',
          actual: context.result.displayName || '',
        },
      ],
      ...(ok ? {} : { message: 'Missing GitHub display name' }),
    };
  },
};
