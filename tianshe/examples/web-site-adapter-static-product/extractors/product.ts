import type { SiteAdapterExtractor } from '../../../src/core/site-adapter-runtime';

type StaticProductSnapshot = {
  url?: string;
  title?: string;
  fields?: {
    productName?: string;
    price?: string;
    seller?: string;
  };
  elements?: unknown[];
};

export const productExtractor: SiteAdapterExtractor = {
  id: 'product',
  extract(context) {
    const snapshot = context.snapshot as StaticProductSnapshot;
    const fields = {
      productName: snapshot.fields?.productName || '',
      price: snapshot.fields?.price || '',
      seller: snapshot.fields?.seller || '',
    };
    const required = ['productName', 'price', 'seller'] as const;
    const missingFields = required.filter((field) => !fields[field]);
    const confidence = Number(((required.length - missingFields.length) / required.length).toFixed(2));

    return {
      ...fields,
      sourceUrl: snapshot.url || 'https://static-product.example/product',
      confidence,
      missingFields,
      selectorHits: required.map((field) => ({
        field,
        selector: `fields.${field}`,
        count: fields[field] ? 1 : 0,
        sampleText: fields[field],
      })),
      pageFingerprint: {
        url: snapshot.url || '',
        title: snapshot.title || '',
        elementCount: Array.isArray(snapshot.elements) ? snapshot.elements.length : 0,
      },
    };
  },
};
