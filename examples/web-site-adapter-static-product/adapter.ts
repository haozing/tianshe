import type { SiteAdapterModule } from '../../src/core/site-adapter-runtime';
import { productExtractor } from './extractors/product';
import { productVerifier } from './verifiers/product';

export const staticProductAdapter: SiteAdapterModule = {
  manifest: {
    id: 'static-product.example',
    name: 'Static Product Example',
    version: '1.0.0',
    site: 'static-product.example',
    sideEffectLevel: 'read-only',
    extractors: [
      {
        id: 'product',
        outputFields: ['productName', 'price', 'seller'],
      },
    ],
    verifiers: [
      {
        id: 'product-required-fields',
        description: 'Checks that the fixture produced the required product fields.',
      },
    ],
  },
  extractors: [productExtractor],
  verifiers: [productVerifier],
};
