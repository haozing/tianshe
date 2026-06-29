// @tianshe-test area=browser layer=unit runtime=node
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyReadOnlyRepairChanges,
  createReadOnlyRepairTaskPayload,
  createRepairHistoryRecord,
  createRepairReviewRecord,
  InMemoryRepairHistoryStore,
  runReadOnlyRepairRegression,
  runReadOnlyRepairWorkflow,
} from './read-only-repair';
import type { BrowserInterface } from '../../types/browser-interface';
import type { SiteAdapterRepairEvidence } from '../site-adapter-runtime';
import { booksToScrapeAdapter } from '../../site-adapters/books-to-scrape/adapter';
import fixture from '../../site-adapters/books-to-scrape/fixtures/product-page.json';
import expected from '../../site-adapters/books-to-scrape/expected/product-page.json';

const workspaceRoot = path.resolve('D:/workspace/tianshe-client-open');

const evidence: SiteAdapterRepairEvidence = {
  adapterId: 'books-to-scrape',
  fixtureName: 'product-page',
  selectorDiagnostics: [
    {
      path: 'price',
      ok: false,
      expected: '£51.77',
      actual: '',
    },
  ],
  fieldDiagnostics: [
    {
      path: 'price',
      ok: false,
      expected: '£51.77',
      actual: '',
    },
  ],
  fixture: {
    name: 'product-page',
    input: {},
    snapshot: { url: 'https://books.toscrape.com', title: 'Book', elements: [] },
  },
  expected: { price: '£51.77' },
  before: { price: '' },
  after: null,
  changedFiles: [],
  repairScopeDecisions: [],
};

describe('read-only repair studio core', () => {
  it('creates a scoped model repair payload from repair evidence', () => {
    const payload = createReadOnlyRepairTaskPayload(evidence);

    expect(payload).toMatchObject({
      adapterId: 'books-to-scrape',
      fixtureName: 'product-page',
      sideEffectLevel: 'read-only',
      missingFields: ['price'],
      forbiddenScopes: expect.arrayContaining(['src/core/**', 'src/main/**']),
    });
  });

  it('applies only paths allowed by repairScope', async () => {
    const writeFile = vi.fn();
    const result = await applyReadOnlyRepairChanges(
      [
        {
          path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
          before: 'old',
          after: 'new',
        },
      ],
      { workspaceRoot, dryRun: false, writeFile }
    );

    expect(result.dryRun).toBe(false);
    expect(result.changedFiles).toEqual([
      'src/site-adapters/books-to-scrape/extractors/product.ts',
    ]);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('src\\site-adapters\\books-to-scrape\\extractors\\product.ts'),
      'new'
    );
  });

  it('rejects framework core paths before write', async () => {
    const writeFile = vi.fn();

    await expect(
      applyReadOnlyRepairChanges(
        [
          {
            path: 'src/core/site-adapter-runtime/read-only-runner.ts',
            after: 'bad',
          },
        ],
        { workspaceRoot, dryRun: false, writeFile }
      )
    ).rejects.toThrow('denied_framework_path');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('requires fixture, target smoke, and human approval before publish', () => {
    const blocked = createRepairReviewRecord({
      adapterId: 'books-to-scrape',
      fixtureName: 'product-page',
      changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
      fixtureResult: { ok: true },
      targetSmokePassed: false,
      approvedBy: 'reviewer',
    });
    const approved = createRepairReviewRecord({
      adapterId: 'books-to-scrape',
      fixtureName: 'product-page',
      changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
      fixtureResult: { ok: true },
      targetSmokePassed: true,
      approvedBy: 'reviewer',
      now: () => new Date('2026-06-22T00:00:00.000Z'),
    });

    expect(blocked.publishAllowed).toBe(false);
    expect(approved).toMatchObject({
      publishAllowed: true,
      approvedAt: '2026-06-22T00:00:00.000Z',
    });
  });

  it('runs fixture and target smoke regressions before approving repair publish', async () => {
    const browser = {
      snapshot: vi.fn().mockResolvedValue(fixture.snapshot),
    } as Pick<BrowserInterface, 'snapshot'>;

    const result = await runReadOnlyRepairRegression({
      adapter: booksToScrapeAdapter,
      fixture: {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected,
      changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
      targetSmoke: {
        browser,
        input: { runner: 'browser-snapshot' },
        snapshotOptions: { elementsFilter: 'all' },
      },
      approvedBy: 'reviewer',
      now: () => new Date('2026-06-22T00:00:00.000Z'),
    });

    expect(result.fixtureResult.ok).toBe(true);
    expect(result.targetSmokeResult?.ok).toBe(true);
    expect(result.reviewRecord).toMatchObject({
      fixturePassed: true,
      targetSmokePassed: true,
      approvedBy: 'reviewer',
      publishAllowed: true,
    });
    expect(browser.snapshot).toHaveBeenCalledWith({ elementsFilter: 'all' });
  });

  it('blocks repair publish when target smoke is missing', async () => {
    const result = await runReadOnlyRepairRegression({
      adapter: booksToScrapeAdapter,
      fixture: {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected,
      changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
      approvedBy: 'reviewer',
    });

    expect(result.fixtureResult.ok).toBe(true);
    expect(result.targetSmokeResult).toBeNull();
    expect(result.reviewRecord.publishAllowed).toBe(false);
  });

  it('records repair history with diff, tests, and reviewer evidence', () => {
    const store = new InMemoryRepairHistoryStore();
    const reviewRecord = createRepairReviewRecord({
      adapterId: 'books-to-scrape',
      fixtureName: 'product-page',
      changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
      fixtureResult: { ok: true },
      targetSmokePassed: true,
      approvedBy: 'reviewer',
      now: () => new Date('2026-06-22T00:00:00.000Z'),
    });
    const history = createRepairHistoryRecord({
      reviewRecord,
      applyResult: {
        diff: [
          {
            path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
            beforeHash: 'old-hash',
            afterHash: 'new-hash',
          },
        ],
      },
      evidenceCommands: [
        'npx vitest run src/site-adapters/books-to-scrape/books-to-scrape.test.ts',
      ],
      recordedAt: new Date('2026-06-22T00:01:00.000Z'),
    });

    store.add(history);

    expect(store.get(reviewRecord.repairId)).toMatchObject({
      repairId: reviewRecord.repairId,
      approvedBy: 'reviewer',
      publishAllowed: true,
      diff: [
        {
          beforeHash: 'old-hash',
          afterHash: 'new-hash',
        },
      ],
      tests: {
        fixturePassed: true,
        targetSmokePassed: true,
        evidenceCommands: [
          'npx vitest run src/site-adapters/books-to-scrape/books-to-scrape.test.ts',
        ],
      },
    });
    expect(store.list({ adapterId: 'books-to-scrape' })).toHaveLength(1);
  });

  it('runs the read-only repair workflow through model diff, gates, review, history, and publish record', async () => {
    const store = new InMemoryRepairHistoryStore();
    const browser = {
      snapshot: vi.fn().mockResolvedValue(fixture.snapshot),
    } as Pick<BrowserInterface, 'snapshot'>;

    const result = await runReadOnlyRepairWorkflow({
      evidence,
      adapter: booksToScrapeAdapter,
      fixture: {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected,
      modelDiff: {
        summary: 'Update price selector fallback for Books to Scrape.',
        generatedBy: 'model-under-review',
        changes: [
          {
            path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
            before: 'old',
            after: 'new',
          },
        ],
      },
      scope: { workspaceRoot },
      targetSmoke: {
        browser,
        input: { runner: 'browser-snapshot' },
        snapshotOptions: { elementsFilter: 'all' },
      },
      approvedBy: 'reviewer',
      evidenceCommands: [
        'npx vitest run src/site-adapters/books-to-scrape/books-to-scrape.test.ts',
        'npm run test:browser-canary -- --runtime all',
      ],
      historyStore: store,
      now: () => new Date('2026-06-22T00:00:00.000Z'),
    });

    expect(result.task).toMatchObject({
      adapterId: 'books-to-scrape',
      missingFields: ['price'],
    });
    expect(result.applyResult).toMatchObject({
      dryRun: true,
      changedFiles: ['src/site-adapters/books-to-scrape/extractors/product.ts'],
    });
    expect(result.regression.reviewRecord).toMatchObject({
      fixturePassed: true,
      targetSmokePassed: true,
      approvedBy: 'reviewer',
      publishAllowed: true,
    });
    expect(result.publishRecord).toMatchObject({
      adapterId: 'books-to-scrape',
      adapterVersion: booksToScrapeAdapter.manifest.version,
      modelDiffSummary: 'Update price selector fallback for Books to Scrape.',
      publishAllowed: true,
      blockedReasons: [],
      evidenceCommands: [
        'npx vitest run src/site-adapters/books-to-scrape/books-to-scrape.test.ts',
        'npm run test:browser-canary -- --runtime all',
      ],
    });
    expect(store.list({ adapterId: 'books-to-scrape' })).toHaveLength(1);
  });

  it('blocks read-only repair workflow publish without target canary and human review', async () => {
    const result = await runReadOnlyRepairWorkflow({
      evidence,
      adapter: booksToScrapeAdapter,
      fixture: {
        name: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input,
        expected,
      },
      expected,
      modelDiff: {
        summary: 'Update selector without review.',
        changes: [
          {
            path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
            after: 'new',
          },
        ],
      },
      scope: { workspaceRoot },
    });

    expect(result.regression.reviewRecord).toMatchObject({
      fixturePassed: true,
      targetSmokePassed: false,
      approvedBy: null,
      publishAllowed: false,
    });
    expect(result.publishRecord).toMatchObject({
      publishAllowed: false,
      publishedAt: null,
      blockedReasons: ['target_runtime_canary_missing_or_failed', 'human_review_missing'],
    });
  });
});
