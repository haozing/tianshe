// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import type { SiteAdapterProcedureRepairTaskPayload } from '../site-adapter-runtime';
import type { SiteAdapterRepairTaskPayload } from './read-only-repair';
import {
  generateSiteAdapterRepairModelDiff,
  type SiteAdapterRepairModelProvider,
} from './model-gateway';

const readOnlyTask: SiteAdapterRepairTaskPayload = {
  taskId: 'repair-readonly-books',
  adapterId: 'books-to-scrape',
  fixtureName: 'product-page',
  sideEffectLevel: 'read-only',
  missingFields: ['price'],
  selectorDiagnostics: [],
  fixture: {
    name: 'product-page',
    input: {},
    snapshot: { url: 'https://books.toscrape.com/catalogue/book_1/index.html' },
  },
  expected: { price: '$51.77' },
  before: { price: '' },
  allowedChangeGlobs: [
    'src/site-adapters/<site-id>/extractors/**',
    'src/site-adapters/<site-id>/verifiers/**',
    'src/site-adapters/<site-id>/fixtures/**',
    'src/site-adapters/<site-id>/expected/**',
  ],
  forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
  prompt: {
    objective: 'Repair only the read-only site adapter.',
    constraints: ['Do not modify framework core.'],
  },
};

const procedureTask = {
  taskId: 'github-profile:open-profile-settings:open-profile-settings:low',
  adapterId: 'github-profile',
  procedureId: 'open-profile-settings',
  sideEffectLevel: 'low',
  failedStepIds: ['open-profile-settings'],
  allowedChangeGlobs: [
    'src/site-adapters/<site-id>/procedures/**',
    'src/site-adapters/<site-id>/fixtures/**',
    'src/site-adapters/<site-id>/expected/**',
  ],
  forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
  prompt: {
    objective: 'Repair only the declared Site Adapter Procedure.',
    constraints: ['Run target canary before approval.'],
  },
  evidence: {},
} as SiteAdapterProcedureRepairTaskPayload;

function queuedNow(...dates: string[]): () => Date {
  const queue = dates.map((date) => new Date(date));
  return () => queue.shift() || new Date(dates[dates.length - 1]);
}

describe('site adapter repair model gateway', () => {
  it('calls a model provider for read-only repair and records provider metadata', async () => {
    const provider: SiteAdapterRepairModelProvider = {
      providerId: 'test-provider',
      model: 'repair-model-small',
      generateRepairDiff: vi.fn().mockResolvedValue({
        summary: 'Update price selector fallback.',
        changes: [
          {
            path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
            after: 'export const selector = ".price_color";',
          },
        ],
      }),
    };

    const result = await generateSiteAdapterRepairModelDiff({
      provider,
      request: { kind: 'read-only', task: readOnlyTask },
      now: queuedNow('2026-06-23T00:00:00.000Z', '2026-06-23T00:00:01.250Z'),
    });

    expect(provider.generateRepairDiff).toHaveBeenCalledWith({
      kind: 'read-only',
      task: readOnlyTask,
    });
    expect(result).toMatchObject({
      taskKind: 'read-only',
      taskId: 'repair-readonly-books',
      providerId: 'test-provider',
      model: 'repair-model-small',
      requestedAt: '2026-06-23T00:00:00.000Z',
      completedAt: '2026-06-23T00:00:01.250Z',
      latencyMs: 1250,
      modelDiff: {
        generatedBy: 'test-provider:repair-model-small',
        generatedAt: '2026-06-23T00:00:01.250Z',
      },
    });
  });

  it('supports Procedure repair model diffs within the Procedure repair scope', async () => {
    const provider: SiteAdapterRepairModelProvider = {
      providerId: 'test-provider',
      model: 'repair-procedure-model',
      generateRepairDiff: vi.fn().mockResolvedValue({
        summary: 'Update GitHub profile settings verification text.',
        generatedBy: 'custom-model-label',
        changes: [
          {
            path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
            before: 'text: "Public profile"',
            after: 'text: "Public profile"',
          },
        ],
      }),
    };

    const result = await generateSiteAdapterRepairModelDiff({
      provider,
      request: { kind: 'procedure', task: procedureTask },
      now: queuedNow('2026-06-23T00:00:00.000Z', '2026-06-23T00:00:00.050Z'),
    });

    expect(result).toMatchObject({
      taskKind: 'procedure',
      taskId: procedureTask.taskId,
      modelDiff: {
        generatedBy: 'custom-model-label',
        changes: [
          expect.objectContaining({
            path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
          }),
        ],
      },
    });
  });

  it('rejects model diffs that touch framework core paths', async () => {
    const provider: SiteAdapterRepairModelProvider = {
      providerId: 'test-provider',
      model: 'repair-model-small',
      generateRepairDiff: vi.fn().mockResolvedValue({
        summary: 'Patch runner directly.',
        changes: [
          {
            path: 'src/core/site-adapter-runtime/procedure.ts',
            after: 'bad',
          },
        ],
      }),
    };

    await expect(
      generateSiteAdapterRepairModelDiff({
        provider,
        request: { kind: 'procedure', task: procedureTask },
      })
    ).rejects.toThrow('forbidden path');
  });

  it('rejects empty model diffs before review/apply', async () => {
    const provider: SiteAdapterRepairModelProvider = {
      providerId: 'test-provider',
      model: 'repair-model-small',
      generateRepairDiff: vi.fn().mockResolvedValue({
        summary: '',
        changes: [],
      }),
    };

    await expect(
      generateSiteAdapterRepairModelDiff({
        provider,
        request: { kind: 'read-only', task: readOnlyTask },
      })
    ).rejects.toThrow('non-empty summary');
  });
});
