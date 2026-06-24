// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import { SiteAdapterRunner, runReadOnlySiteAdapterFixture } from '../../core/site-adapter-runtime';
import type { BrowserInterface } from '../../types/browser-interface';
import { githubProfileAdapter } from './adapter';
import fixture from './fixtures/profile-settings.json';
import expected from './expected/profile-settings.json';

describe('github profile site adapter', () => {
  it('extracts logged-in profile summary fields from a fixture', async () => {
    const result = await runReadOnlySiteAdapterFixture(githubProfileAdapter, {
      name: fixture.name,
      snapshot: fixture.snapshot,
      input: fixture.input,
      expected,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject(expected);
    expect(result.result.selectorHits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'displayName', count: 1 }),
      ])
    );
  });

  it('runs the low-risk profile settings Procedure through SiteAdapterRunner', async () => {
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockResolvedValue('Public profile'),
      textExists: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserInterface;

    const result = await SiteAdapterRunner.run({
      runner: 'procedure',
      adapter: githubProfileAdapter,
      procedureId: 'open-profile-settings',
      browser,
    });

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/settings/profile', {
      waitUntil: 'domcontentloaded',
    });
    expect(browser.waitForSelector).toHaveBeenCalledWith('input[name="user[profile_name]"]', {
      timeout: 10000,
    });
    expect(result.runState.values.resumePlan).toBeUndefined();
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'open-profile-settings', action: 'navigate' }),
        expect.objectContaining({ stepId: 'wait-profile-name-field', action: 'waitForSelector' }),
      ])
    );
  });

  it('runs the low-risk GitHub issue draft Procedure without submitting', async () => {
    const textBySelector = new Map<string, string>();
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockImplementation(async (selector: string) => {
        if (selector === 'body') {
          return `New issue ${Array.from(textBySelector.values()).join(' ')}`;
        }
        return textBySelector.get(selector) || '';
      }),
      textExists: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockImplementation(async (selector: string, text: string) => {
        textBySelector.set(selector, text);
      }),
      select: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserInterface;

    const result = await SiteAdapterRunner.run({
      runner: 'procedure',
      adapter: githubProfileAdapter,
      procedureId: 'prepare-issue-draft',
      browser,
    });

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/owner/repo/issues/new', {
      waitUntil: 'domcontentloaded',
    });
    expect(browser.type).toHaveBeenCalledWith('#issue_title', 'Example issue draft', {
      clear: true,
    });
    expect(browser.type).toHaveBeenCalledWith(
      '#issue_body',
      'Prepared by the Tianshe Site Adapter low-risk Procedure canary.',
      { clear: true }
    );
    expect(browser.click).not.toHaveBeenCalledWith('button[type="submit"]');
    expect(result.runState.sideEffectLevel).toBe('low');
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'open-new-issue', action: 'navigate' }),
        expect.objectContaining({ stepId: 'fill-issue-draft', action: 'fillForm' }),
        expect.objectContaining({
          stepId: 'verify-issue-body-drafted',
          action: 'verifyText',
        }),
      ])
    );
  });

  it('requires explicit confirmation for the high-risk issue creation Procedure', async () => {
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockResolvedValue('New issue'),
      textExists: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserInterface;

    await expect(
      SiteAdapterRunner.run({
        runner: 'procedure',
        adapter: githubProfileAdapter,
        procedureId: 'create-issue',
        browser,
      })
    ).rejects.toThrow('confirmRisk=true');
    expect(browser.goto).not.toHaveBeenCalled();
  });

  it('runs the high-risk GitHub issue Procedure after destructive confirmation', async () => {
    const textBySelector = new Map<string, string>();
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn().mockImplementation(async (selector: string) => {
        if (selector === 'body') {
          return `New issue ${Array.from(textBySelector.values()).join(' ')}`;
        }
        return textBySelector.get(selector) || '';
      }),
      textExists: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockImplementation(async (selector: string, text: string) => {
        textBySelector.set(selector, text);
      }),
      select: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserInterface;

    const result = await SiteAdapterRunner.run({
      runner: 'procedure',
      adapter: githubProfileAdapter,
      procedureId: 'create-issue',
      browser,
      options: { confirmRisk: true },
    });

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/owner/repo/issues/new', {
      waitUntil: 'domcontentloaded',
    });
    expect(browser.type).toHaveBeenCalledWith('#issue_title', 'Example issue', {
      clear: true,
    });
    expect(browser.type).toHaveBeenCalledWith(
      '#issue_body',
      'Created by the Tianshe Site Adapter high-risk Procedure canary.',
      { clear: true }
    );
    expect(browser.click).toHaveBeenCalledWith('button[type="submit"]');
    expect(result.runState.sideEffectLevel).toBe('high');
    expect(result.actionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'open-new-issue', action: 'navigate' }),
        expect.objectContaining({ stepId: 'fill-issue-form', action: 'fillForm' }),
        expect.objectContaining({ stepId: 'submit-issue', action: 'click' }),
      ])
    );
  });
});
