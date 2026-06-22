import type { SiteAdapterVerifier } from '../../../src/core/site-adapter-runtime';

export const productVerifier: SiteAdapterVerifier = {
  id: 'product-required-fields',
  verify(context) {
    const missing = ['productName', 'price', 'seller'].filter((field) => !context.result[field]);
    return {
      ok: missing.length === 0,
      ...(missing.length ? { message: `Missing required field(s): ${missing.join(', ')}` } : {}),
    };
  },
};
