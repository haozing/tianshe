// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import type { BrowserInterface } from '../../types/browser-interface';
import {
  createProcedureRepairGateRecord,
  createSiteAdapterProcedureResumePlan,
  replaySiteAdapterTransitions,
  runSiteAdapterProcedure,
  type SiteAdapterRunState,
  type SiteAdapterProcedureDefinition,
} from './index';

function createBrowser(): BrowserInterface {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    getText: vi.fn().mockResolvedValue('Saved search'),
    textExists: vi.fn().mockResolvedValue(true),
    native: {
      keyPress: vi.fn().mockResolvedValue(undefined),
      scroll: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as BrowserInterface;
}

describe('site adapter procedure runner', () => {
  it('runs low-risk procedures with traceable actions and replayable transitions', async () => {
    const browser = createBrowser();
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

    const result = await runSiteAdapterProcedure(procedure, browser);
    const replayed = replaySiteAdapterTransitions(
      { ...result.runState, phase: 'created', status: 'running', transitions: [] },
      result.transitions
    );

    expect(result.ok).toBe(true);
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'query', action: 'type', outcome: 'succeeded' }),
        expect.objectContaining({ stepId: 'save', action: 'click', outcome: 'succeeded' }),
      ])
    );
    expect(replayed.status).toBe('completed');
  });

  it('resumes a failed procedure from the first unfinished step', async () => {
    const browser = createBrowser();
    const previousState: SiteAdapterRunState = {
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
    };
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

    const plan = createSiteAdapterProcedureResumePlan(procedure, previousState);
    const result = await runSiteAdapterProcedure(procedure, browser, {
      resumeFromState: previousState,
    });

    expect(plan).toMatchObject({
      canResume: true,
      previousRunId: 'run-previous',
      resumeFromStepId: 'save',
      skippedStepIds: ['query'],
      completedStepIds: ['query'],
      failedStepIds: ['save'],
    });
    expect(result.ok).toBe(true);
    expect(browser.type).not.toHaveBeenCalled();
    expect(browser.click).toHaveBeenCalledWith('#save');
    expect(result.runState.values.resumePlan).toMatchObject({
      previousRunId: 'run-previous',
      resumeFromStepId: 'save',
      skippedStepIds: ['query'],
    });
    expect(result.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'save-search-draft',
          action: 'resume',
          data: expect.objectContaining({
            previousRunId: 'run-previous',
            resumeFromStepId: 'save',
          }),
        }),
      ])
    );
  });

  it('rejects procedures without explicit verification', async () => {
    await expect(
      runSiteAdapterProcedure(
        {
          id: 'unsafe',
          adapterId: 'demo',
          sideEffectLevel: 'low',
          steps: [{ id: 'click', action: 'click', selector: '#save' }],
        },
        createBrowser()
      )
    ).rejects.toThrow('verification');
  });

  it('requires confirmation for high-risk procedures', async () => {
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'dangerous',
      adapterId: 'demo',
      sideEffectLevel: 'high',
      steps: [{ id: 'verify', action: 'verifyText', text: 'Ready' }],
    };

    await expect(runSiteAdapterProcedure(procedure, createBrowser())).rejects.toThrow(
      'confirmRisk=true'
    );
    await expect(
      runSiteAdapterProcedure(procedure, createBrowser(), { confirmRisk: true })
    ).resolves.toMatchObject({ ok: true });
  });

  it('runs expanded form, select, press, and scroll steps with explicit verification policy', async () => {
    const browser = createBrowser();
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'expanded-form',
      adapterId: 'demo',
      sideEffectLevel: 'low',
      steps: [
        {
          id: 'fill',
          action: 'fillForm',
          fields: [
            { selector: '#name', text: 'Ada', clear: true },
            { selector: '#email', text: 'ada@example.test', clear: true },
          ],
          verify: {
            id: 'filled',
            action: 'verifyText',
            selector: '#status',
            text: 'Saved search',
            match: 'exact',
          },
        },
        {
          id: 'select-country',
          action: 'select',
          selector: '#country',
          value: 'uk',
        },
        {
          id: 'press-enter',
          action: 'press',
          key: 'Enter',
          modifiers: ['shift'],
        },
        {
          id: 'scroll-results',
          action: 'scroll',
          x: 10,
          y: 20,
          deltaY: 400,
          verify: {
            id: 'scrolled',
            action: 'verifyText',
            selector: '#status',
            text: 'Saved',
            match: 'contains',
          },
        },
      ],
    };

    const result = await runSiteAdapterProcedure(procedure, browser);

    expect(result.ok).toBe(true);
    expect(browser.type).toHaveBeenCalledWith('#name', 'Ada', { clear: true });
    expect(browser.type).toHaveBeenCalledWith('#email', 'ada@example.test', { clear: true });
    expect(browser.select).toHaveBeenCalledWith('#country', 'uk');
    expect(browser.native.keyPress).toHaveBeenCalledWith('Enter', ['shift']);
    expect(browser.native.scroll).toHaveBeenCalledWith(10, 20, 0, 400);
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'fill', action: 'fillForm' }),
        expect.objectContaining({ stepId: 'select-country', action: 'select' }),
        expect.objectContaining({ stepId: 'press-enter', action: 'press' }),
        expect.objectContaining({ stepId: 'scroll-results', action: 'scroll' }),
      ])
    );
  });

  it('supports low-risk navigation steps with verification', async () => {
    const browser = createBrowser();
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'open-settings',
      adapterId: 'github-profile',
      sideEffectLevel: 'low',
      steps: [
        {
          id: 'open-profile-settings',
          action: 'navigate',
          url: 'https://github.com/settings/profile',
          waitUntil: 'domcontentloaded',
          verify: {
            id: 'settings-visible',
            action: 'verifyText',
            selector: 'body',
            text: 'Saved search',
          },
        },
      ],
    };

    const result = await runSiteAdapterProcedure(procedure, browser);

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/settings/profile', {
      waitUntil: 'domcontentloaded',
    });
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'open-profile-settings',
          action: 'navigate',
          output: expect.objectContaining({
            verified: true,
            text: 'Saved search',
          }),
        }),
      ])
    );
  });

  it('supports retryable steps and conditional text branches', async () => {
    const browser = createBrowser();
    browser.click = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient click miss'))
      .mockResolvedValue(undefined);
    browser.getText = vi.fn().mockResolvedValue('Ready');
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'retry-and-branch',
      adapterId: 'demo',
      sideEffectLevel: 'low',
      steps: [
        {
          id: 'retry-click',
          action: 'click',
          selector: '#save',
          retries: 1,
          verify: { id: 'ready', action: 'verifyText', selector: '#status', text: 'Ready' },
        },
        {
          id: 'branch',
          action: 'branchOnText',
          selector: '#status',
          text: 'Ready',
          whenFound: [
            { id: 'branch-verify', action: 'verifyText', selector: '#status', text: 'Ready' },
          ],
          whenMissing: [
            { id: 'missing-verify', action: 'verifyText', selector: '#status', text: 'Missing' },
          ],
        },
      ],
    };

    const result = await runSiteAdapterProcedure(procedure, browser);

    expect(result.ok).toBe(true);
    expect(browser.click).toHaveBeenCalledTimes(2);
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'retry-click',
          output: expect.objectContaining({ attempts: 2 }),
        }),
        expect.objectContaining({
          stepId: 'branch',
          output: expect.objectContaining({ branch: 'whenFound', stepsRun: ['branch-verify'] }),
        }),
        expect.objectContaining({ stepId: 'branch-verify', action: 'verifyText' }),
      ])
    );
  });

  it('supports pagination steps with traceable page evidence', async () => {
    const browser = createBrowser();
    browser.getText = vi.fn().mockResolvedValue('Results page ready');
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'paginate-results',
      adapterId: 'open-library',
      sideEffectLevel: 'low',
      steps: [
        {
          id: 'next-pages',
          action: 'paginate',
          nextSelector: 'a[rel="next"]',
          pageReadySelector: '.search-results',
          maxPages: 2,
          timeout: 1000,
          verify: {
            id: 'results-ready',
            action: 'verifyText',
            selector: '.search-results',
            text: 'Results page',
          },
        },
      ],
    };

    const result = await runSiteAdapterProcedure(procedure, browser);

    expect(result.ok).toBe(true);
    expect(browser.waitForSelector).toHaveBeenCalledWith('a[rel="next"]', {
      timeout: 1000,
    });
    expect(browser.waitForSelector).toHaveBeenCalledWith('.search-results', {
      timeout: 1000,
    });
    expect(browser.click).toHaveBeenCalledTimes(2);
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'next-pages',
          action: 'paginate',
          output: expect.objectContaining({
            paginated: true,
            pagesVisited: 2,
            maxPages: 2,
            stopReason: 'max_pages',
            pages: expect.arrayContaining([
              expect.objectContaining({
                pageNumber: 1,
                verification: expect.objectContaining({ verified: true }),
              }),
              expect.objectContaining({ pageNumber: 2 }),
            ]),
          }),
        }),
      ])
    );
  });

  it('can stop pagination when the next selector disappears', async () => {
    const browser = createBrowser();
    browser.waitForSelector = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('next missing'));
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'paginate-until-missing',
      adapterId: 'open-library',
      sideEffectLevel: 'low',
      steps: [
        {
          id: 'next-pages',
          action: 'paginate',
          nextSelector: 'a[rel="next"]',
          maxPages: 3,
          stopWhenNextMissing: true,
        },
        { id: 'verify', action: 'verifyText', text: 'Saved search' },
      ],
    };

    const result = await runSiteAdapterProcedure(procedure, browser);

    expect(result.ok).toBe(true);
    expect(browser.click).toHaveBeenCalledTimes(1);
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'next-pages',
          output: expect.objectContaining({
            pagesVisited: 1,
            stopReason: 'next_missing',
          }),
        }),
      ])
    );
  });

  it('aborts without leaving a completed run state', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop procedure'));

    await expect(
      runSiteAdapterProcedure(
        {
          id: 'abortable',
          adapterId: 'demo',
          sideEffectLevel: 'low',
          steps: [{ id: 'verify', action: 'verifyText', text: 'Ready' }],
        },
        createBrowser(),
        { signal: controller.signal }
      )
    ).rejects.toThrow('stop procedure');
  });

  it('requires target canary and human review for procedure repair publish', () => {
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'save-search-draft',
      adapterId: 'books-to-scrape',
      sideEffectLevel: 'low',
      steps: [{ id: 'verify', action: 'verifyText', text: 'Ready' }],
    };

    expect(
      createProcedureRepairGateRecord({
        procedure,
        fixturePassed: true,
        targetCanaryPassed: false,
        approvedBy: 'reviewer',
      })
    ).toMatchObject({
      publishAllowed: false,
      requiredGates: ['fixture_regression', 'target_runtime_canary', 'human_review'],
    });
    expect(
      createProcedureRepairGateRecord({
        procedure,
        fixturePassed: true,
        targetCanaryPassed: true,
        approvedBy: 'reviewer',
      })
    ).toMatchObject({
      publishAllowed: true,
    });
  });

  it('requires destructive confirmation for high-risk procedure repair publish', () => {
    const procedure: SiteAdapterProcedureDefinition = {
      id: 'dangerous',
      adapterId: 'demo',
      sideEffectLevel: 'high',
      steps: [{ id: 'verify', action: 'verifyText', text: 'Ready' }],
    };

    expect(
      createProcedureRepairGateRecord({
        procedure,
        fixturePassed: true,
        targetCanaryPassed: true,
        approvedBy: 'reviewer',
      })
    ).toMatchObject({
      publishAllowed: false,
      requiredGates: [
        'fixture_regression',
        'target_runtime_canary',
        'human_review',
        'destructive_confirmation',
      ],
    });
    expect(
      createProcedureRepairGateRecord({
        procedure,
        fixturePassed: true,
        targetCanaryPassed: true,
        approvedBy: 'reviewer',
        destructiveConfirmation: true,
      })
    ).toMatchObject({
      publishAllowed: true,
    });
  });
});
