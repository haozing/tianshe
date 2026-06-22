import type { SiteAdapterExtractor } from '../../../src/core/site-adapter-runtime';

type StaticProductSnapshot = {
  fields?: {
    productName?: string;
    price?: string;
    seller?: string;
  };
};

export const productExtractor: SiteAdapterExtractor = {
  id: 'product',
  extract(context) {
    const snapshot = context.snapshot as StaticProductSnapshot;
    return {
      productName: snapshot.fields?.productName || '',
      price: snapshot.fields?.price || '',
      seller: snapshot.fields?.seller || '',
    };
  },
};
