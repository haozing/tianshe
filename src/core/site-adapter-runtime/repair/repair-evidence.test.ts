import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSiteAdapterRepairEvidence } from './repair-evidence';
import {
  SITE_ADAPTER_REPAIR_BUNDLE_DATA_SCHEMA,
  assertSiteAdapterRepairBundleData,
} from './repair-bundle-schema';

const workspaceRoot = path.resolve('D:/workspace/tianshe-client-open');

const baseEvidenceInput = {
  adapterId: 'static-product.example',
  fixtureName: 'product-page',
  selectorDiagnostics: [
    {
      path: 'price',
      ok: false,
      expected: '99.99',
      actual: '12.50',
    },
  ],
  fixture: {
    name: 'product-page',
    input: {},
    snapshot: {
      title: 'Product',
    },
  },
  expected: {
    price: '99.99',
  },
  before: {
    price: '12.50',
  },
  after: {
    price: '99.99',
  },
};

describe('site adapter repair evidence gate', () => {
  it('accepts scoped adapter repair files with before and after evidence', () => {
    const evidence = buildSiteAdapterRepairEvidence(
      {
        ...baseEvidenceInput,
        changedFiles: ['examples/web-site-adapter-demo/extractors/product.ts'],
      },
      { workspaceRoot }
    );

    expect(evidence).toMatchObject({
      adapterId: 'static-product.example',
      fixtureName: 'product-page',
      selectorDiagnostics: [
        {
          path: 'price',
          ok: false,
        },
      ],
      fieldDiagnostics: [
        {
          path: 'price',
          ok: false,
        },
      ],
      before: {
        price: '12.50',
      },
      after: {
        price: '99.99',
      },
      changedFiles: ['examples/web-site-adapter-demo/extractors/product.ts'],
      repairScopeDecisions: [
        expect.objectContaining({
          allowed: true,
          reason: 'allowed',
        }),
      ],
    });
  });

  it('rejects repair evidence that points at framework core', () => {
    expect(() =>
      buildSiteAdapterRepairEvidence(
        {
          ...baseEvidenceInput,
          changedFiles: ['src/core/site-adapter-runtime/read-only-runner.ts'],
        },
        { workspaceRoot }
      )
    ).toThrow('denied_framework_path');
  });

  it('requires selector diagnostics before a repair can be recorded', () => {
    expect(() =>
      buildSiteAdapterRepairEvidence(
        {
          ...baseEvidenceInput,
          selectorDiagnostics: [],
        },
        { workspaceRoot }
      )
    ).toThrow('selectorDiagnostics are required');
  });

  it('validates repair bundle artifact data against the authoritative schema', () => {
    const evidence = buildSiteAdapterRepairEvidence(baseEvidenceInput, { workspaceRoot });
    const bundleData = {
      adapterId: 'static-product.example',
      fixtureName: 'product-page',
      sideEffectLevel: 'read-only',
      repairEvidence: evidence,
      diagnostics: evidence.fieldDiagnostics,
      verifierResults: [],
      actionTrace: [{ stepId: 'product', action: 'extract' }],
      transitions: [{ stepId: 'product', to: 'failed' }],
    };

    expect(SITE_ADAPTER_REPAIR_BUNDLE_DATA_SCHEMA).toMatchObject({
      required: expect.arrayContaining(['adapterId', 'fixtureName', 'repairEvidence']),
    });
    expect(() => assertSiteAdapterRepairBundleData(bundleData)).not.toThrow();
    expect(() =>
      assertSiteAdapterRepairBundleData({
        ...bundleData,
        repairEvidence: {
          ...evidence,
          selectorDiagnostics: [],
        },
      })
    ).toThrow('failed schema validation');
  });
});
