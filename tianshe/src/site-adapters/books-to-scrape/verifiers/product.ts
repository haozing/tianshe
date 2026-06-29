import type { SiteAdapterVerifier } from '../../../core/site-adapter-runtime';

const REQUIRED_FIELDS = ['productName', 'price', 'availability', 'rating'] as const;

export const productVerifier: SiteAdapterVerifier = {
  id: 'product-required-fields',
  verify(context) {
    const missing = REQUIRED_FIELDS.filter((field) => !context.result[field]);
    const confidence =
      typeof context.result.confidence === 'number' ? context.result.confidence : 0;

    return {
      ok: missing.length === 0 && confidence >= 0.75,
      diagnostics: REQUIRED_FIELDS.map((field) => ({
        path: field,
        ok: Boolean(context.result[field]),
        expected: 'present',
        actual: context.result[field] || '',
      })),
      ...(missing.length
        ? { message: `Missing required field(s): ${missing.join(', ')}` }
        : confidence < 0.75
          ? { message: `Extractor confidence too low: ${confidence}` }
          : {}),
    };
  },
};
