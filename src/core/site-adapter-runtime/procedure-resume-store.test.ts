// @tianshe-test area=browser layer=unit runtime=node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserInterface } from '../../types/browser-interface';
import {
  SiteAdapterProcedureResumeFileStore,
  createSiteAdapterProcedureResumeKey,
  runSiteAdapterProcedure,
  type SiteAdapterProcedureDefinition,
  type SiteAdapterRunState,
} from './index';

function createBrowser(): BrowserInterface {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    getText: vi.fn().mockResolvedValue('Saved search'),
    textExists: vi.fn().mockResolvedValue(true),
  } as unknown as BrowserInterface;
}

const procedure: SiteAdapterProcedureDefinition = {
  id: 'save-search-draft',
  adapterId: 'books-to-scrape',
  sideEffectLevel: 'low',
  steps: [
    { id: 'query', action: 'type', selector: '#search', text: 'poetry', clear: true },
    {
      id: 'save',
      action: 'click',
      selector: '#save',
      verify: { id: 'saved', action: 'verifyText', text: 'Saved search' },
    },
  ],
};

function createFailedRunState(overrides: Partial<SiteAdapterRunState> = {}): SiteAdapterRunState {
  return {
    runId: 'run-previous',
    adapterId: 'books-to-scrape',
    sideEffectLevel: 'low',
    phase: 'failed',
    status: 'failed',
    startedAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:05.000Z',
    transitions: [],
    actionTrace: [
      {
        actionId: 'action-query',
        stepId: 'query',
        action: 'type',
        sideEffectLevel: 'low',
        startedAt: '2026-06-23T00:00:01.000Z',
        finishedAt: '2026-06-23T00:00:02.000Z',
        outcome: 'succeeded',
        input: { selector: '#search' },
        output: { typed: true },
      },
      {
        actionId: 'action-save',
        stepId: 'save',
        action: 'click',
        sideEffectLevel: 'low',
        startedAt: '2026-06-23T00:00:03.000Z',
        finishedAt: '2026-06-23T00:00:04.000Z',
        outcome: 'failed',
        input: { selector: '#save' },
        error: 'transient miss',
      },
    ],
    values: { procedureId: 'save-search-draft' },
    ...overrides,
  };
}

function tempStorePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'site-adapter-procedure-resume-')),
    'resume-state.json'
  );
}

describe('SiteAdapterProcedureResumeFileStore', () => {
  it('persists a failed procedure run for cross-process resume and marks it consumed', async () => {
    const filePath = tempStorePath();
    const firstProcessStore = new SiteAdapterProcedureResumeFileStore(filePath);
    const record = await firstProcessStore.save({
      procedure,
      runState: createFailedRunState(),
      storedAt: '2026-06-23T00:01:00.000Z',
    });
    const expectedKey = createSiteAdapterProcedureResumeKey({
      adapterId: 'books-to-scrape',
      procedureId: 'save-search-draft',
      previousRunId: 'run-previous',
    });

    expect(record).toMatchObject({
      key: expectedKey,
      status: 'available',
      resumePlan: {
        canResume: true,
        previousRunId: 'run-previous',
        resumeFromStepId: 'save',
        skippedStepIds: ['query'],
      },
    });

    const secondProcessStore = new SiteAdapterProcedureResumeFileStore(filePath);
    const loaded = await secondProcessStore.load(record.key);
    expect(loaded).not.toBeNull();
    const browser = createBrowser();
    const result = await runSiteAdapterProcedure(procedure, browser, {
      resumeFromState: loaded!.runState,
    });

    expect(result.ok).toBe(true);
    expect(browser.type).not.toHaveBeenCalled();
    expect(browser.click).toHaveBeenCalledWith('#save');

    const consumed = await secondProcessStore.consume(record.key, '2026-06-23T00:02:00.000Z');

    expect(consumed).toMatchObject({
      status: 'consumed',
      consumedAt: '2026-06-23T00:02:00.000Z',
    });
    expect(await new SiteAdapterProcedureResumeFileStore(filePath).load(record.key)).toBeNull();
    await expect(secondProcessStore.list({ status: 'consumed' })).resolves.toEqual([
      expect.objectContaining({ key: record.key, status: 'consumed' }),
    ]);
  });

  it('redacts secret-like state payloads before writing resume evidence', async () => {
    const filePath = tempStorePath();
    const store = new SiteAdapterProcedureResumeFileStore(filePath);
    await store.save({
      procedure,
      runState: createFailedRunState({
        values: {
          procedureId: 'save-search-draft',
          token: 'hidden-token',
          nested: { password: 'hidden-password', safe: 'kept-value' },
        },
        actionTrace: [
          {
            ...createFailedRunState().actionTrace[0],
            input: { selector: '#search', password: 'hidden-action-password' },
            output: { typed: true, cookie: 'hidden-cookie' },
          },
          createFailedRunState().actionTrace[1],
        ],
      }),
    });

    const raw = fs.readFileSync(filePath, 'utf8');

    expect(raw).toContain('kept-value');
    expect(raw).not.toContain('hidden-token');
    expect(raw).not.toContain('hidden-password');
    expect(raw).not.toContain('hidden-action-password');
    expect(raw).not.toContain('hidden-cookie');
  });

  it('rejects completed or mismatched procedure states', async () => {
    const store = new SiteAdapterProcedureResumeFileStore(tempStorePath());
    await expect(
      store.save({
        procedure,
        runState: createFailedRunState({
          status: 'completed',
          phase: 'completed',
          actionTrace: [
            { ...createFailedRunState().actionTrace[0], outcome: 'succeeded' },
            { ...createFailedRunState().actionTrace[1], outcome: 'succeeded' },
          ],
        }),
      })
    ).rejects.toThrow('already_completed');

    await expect(
      store.save({
        procedure,
        runState: createFailedRunState({
          values: { procedureId: 'other-procedure' },
        }),
      })
    ).rejects.toThrow('run state procedure is other-procedure');
  });
});
