// @tianshe-test area=browser layer=unit runtime=node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SiteAdapterRepairTaskPayload } from '../../core/site-adapter-repair-studio';
import type { SiteAdapterRepairModelProvider } from '../../core/site-adapter-repair-studio';
import { InMemoryRepairStudioModelCredentialStore } from './model-provider-config';
import {
  clearRepairModelProviderCredentialFromInput,
  generateRepairModelDiffFromInput,
  getRepairModelProviderConfigSummary,
  reviewApplyPublishRepairFromInput,
  saveRepairModelProviderCredentialFromInput,
} from './routes-or-ipc';

const task: SiteAdapterRepairTaskPayload = {
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
  allowedChangeGlobs: ['src/site-adapters/<site-id>/extractors/**'],
  forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
  prompt: {
    objective: 'Repair only the read-only site adapter.',
    constraints: ['Do not modify framework core.'],
  },
};

describe('site adapter repair studio IPC helpers', () => {
  it('returns credential-safe provider template configuration status', () => {
    const summary = getRepairModelProviderConfigSummary();

    expect(summary.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          env: expect.objectContaining({
            apiKey: expect.arrayContaining(['OPENAI_API_KEY']),
          }),
        }),
        expect.objectContaining({ id: 'openrouter' }),
      ])
    );
    expect(JSON.stringify(summary)).not.toMatch(/sk-|repair-key|api_key_value/i);
  });

  it('saves and clears built-in provider credentials through safe summaries', () => {
    const credentialStore = new InMemoryRepairStudioModelCredentialStore();
    const saved = saveRepairModelProviderCredentialFromInput(
      {
        provider: 'openai',
        baseUrl: 'https://api.openai.test/v1',
        apiKey: 'stored-ipc-key',
        model: 'repair-model',
        timeoutMs: 5000,
      },
      { credentialStore }
    );
    const cleared = clearRepairModelProviderCredentialFromInput({ credentialStore });

    expect(saved).toMatchObject({
      configured: true,
      credentialSource: 'stored',
      storedCredential: {
        configured: true,
        keyVersion: 1,
      },
    });
    expect(cleared).toMatchObject({
      configured: false,
      credentialSource: 'missing',
      storedCredential: {
        configured: false,
        keyVersion: null,
      },
    });
    expect(JSON.stringify(saved)).not.toContain('stored-ipc-key');
  });

  it('returns an environment gap when no repair model provider is configured', async () => {
    await expect(
      generateRepairModelDiffFromInput({ kind: 'read-only', task })
    ).resolves.toMatchObject({
      status: 'environment_gap',
      message: expect.stringContaining('not configured'),
    });
  });

  it('runs a configured repair model provider through the gateway', async () => {
    const provider: SiteAdapterRepairModelProvider = {
      providerId: 'test-provider',
      model: 'repair-model',
      generateRepairDiff: vi.fn().mockResolvedValue({
        summary: 'Repair price selector.',
        changes: [
          {
            path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
            after: 'export const selector = ".price_color";',
          },
        ],
      }),
    };

    const result = await generateRepairModelDiffFromInput(
      { kind: 'read-only', task },
      { modelProvider: provider }
    );

    expect(result).toMatchObject({
      status: 'generated',
      result: {
        taskKind: 'read-only',
        taskId: 'repair-readonly-books',
        providerId: 'test-provider',
        model: 'repair-model',
        modelDiff: {
          summary: 'Repair price selector.',
        },
      },
    });
    expect(provider.generateRepairDiff).toHaveBeenCalledWith({ kind: 'read-only', task });
  });

  it('creates a dry-run apply and publish record through review gates', async () => {
    const result = await reviewApplyPublishRepairFromInput({
      kind: 'read-only',
      task,
      modelDiff: {
        summary: 'Repair price selector.',
        changes: [
          {
            path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
            after: 'export const selector = ".price_color";',
          },
        ],
      },
      reviewGates: {
        fixtureRegression: true,
        targetCanary: true,
        humanReview: true,
      },
      approvedBy: 'reviewer',
      dryRun: true,
    });

    expect(result).toMatchObject({
      status: 'publish_ready',
      applyResult: {
        dryRun: true,
        changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
      },
      reviewRecord: {
        adapterId: 'books-to-scrape',
        fixtureName: 'product-page',
        approvedBy: 'reviewer',
        publishAllowed: true,
      },
      publishRecord: {
        publishAllowed: true,
        blockedReasons: [],
        evidenceCommands: expect.arrayContaining([
          'npm run test:site-adapter-canary -- --suite all',
        ]),
      },
    });
  });

  it('writes adapter changes when review gates request real apply and publish', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-studio-apply-'));
    const targetPath = path.join(
      tempRoot,
      'src',
      'site-adapters',
      'books-to-scrape',
      'extractors',
      'product.ts'
    );
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, 'export const selector = ".old";', 'utf8');

    const result = await reviewApplyPublishRepairFromInput(
      {
        kind: 'read-only',
        task,
        modelDiff: {
          summary: 'Repair price selector.',
          changes: [
            {
              path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
              after: 'export const selector = ".price_color";',
            },
          ],
        },
        reviewGates: {
          fixtureRegression: true,
          targetCanary: true,
          humanReview: true,
        },
        approvedBy: 'reviewer',
        dryRun: false,
      },
      { workspaceRoot: tempRoot }
    );

    expect(result).toMatchObject({
      status: 'applied',
      applyResult: {
        dryRun: false,
        changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
      },
      publishRecord: {
        publishAllowed: true,
        blockedReasons: [],
      },
    });
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(
      'export const selector = ".price_color";'
    );
  });

  it('keeps publish blocked when review gates are incomplete', async () => {
    const result = await reviewApplyPublishRepairFromInput({
      kind: 'read-only',
      task,
      modelDiff: {
        summary: 'Repair price selector.',
        changes: [
          {
            path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
            after: 'export const selector = ".price_color";',
          },
        ],
      },
      reviewGates: {
        fixtureRegression: true,
        targetCanary: false,
        humanReview: true,
      },
      approvedBy: 'reviewer',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      applyResult: { dryRun: true },
      publishRecord: {
        publishAllowed: false,
        blockedReasons: ['target_runtime_canary_missing_or_failed'],
      },
    });
  });

  it('rejects model diffs outside the adapter repair scope before publish', async () => {
    await expect(
      reviewApplyPublishRepairFromInput({
        kind: 'read-only',
        task,
        modelDiff: {
          summary: 'Try to modify core.',
          changes: [
            {
              path: 'src/core/site-adapter-runtime/read-only-runner.ts',
              after: 'export const bad = true;',
            },
          ],
        },
        reviewGates: {
          fixtureRegression: true,
          targetCanary: true,
          humanReview: true,
        },
      })
    ).rejects.toThrow(/Site adapter repair path is not allowed/);
  });
});
