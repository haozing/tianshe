// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import { loadOfficialFixture, runSiteAdapterLabFixtureFromInput } from './routes-or-ipc';
import { runReadOnlySiteAdapterFixture } from '../../core/site-adapter-runtime';
import { officialSiteAdapters } from '../../site-adapters';
import fixture from '../../site-adapters/books-to-scrape/fixtures/product-page.json';
import expected from '../../site-adapters/books-to-scrape/expected/product-page.json';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

describe('site adapter lab IPC runner wiring', () => {
  it('loads every fixture declared by official site adapter manifests', async () => {
    const declaredFixtures = officialSiteAdapters.flatMap((adapter) =>
      (adapter.manifest.fixtures || []).map((fixtureName) => ({
        adapterId: adapter.manifest.id,
        fixtureName,
      }))
    );

    expect(declaredFixtures.length).toBeGreaterThanOrEqual(7);

    for (const { adapterId, fixtureName } of declaredFixtures) {
      const result = await loadOfficialFixture(adapterId, fixtureName);
      expect(result.fixture).toMatchObject({
        name: fixtureName,
        expected: result.expected,
      });
      expect(result.fixture.snapshot).toBeTruthy();
      expect(result.expected).toEqual(expect.any(Object));
    }
  });

  it('runs a browser-snapshot provider through the Lab fixture helper', async () => {
    const snapshot = vi.fn().mockResolvedValue(fixture.snapshot);
    const result = await runSiteAdapterLabFixtureFromInput(
      {
        adapterId: 'books-to-scrape',
        fixture,
        expected,
        browserRunner: {
          enabled: true,
          targetUrl: fixture.snapshot.url,
          profileId: 'profile-lab',
          runtimeId: 'electron-webcontents',
        },
      },
      {
        createBrowserRunner: (request) => {
          expect(request).toMatchObject({
            adapterId: 'books-to-scrape',
            targetUrl: fixture.snapshot.url,
            profileId: 'profile-lab',
            runtimeId: 'electron-webcontents',
          });
          return {
            browser: { snapshot },
            fixtureName: 'browser-product-page',
            input: { runner: 'browser-snapshot' },
          };
        },
      }
    );

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(result.runnerComparison).toMatchObject({
      browserRunnerOk: true,
      driftStatus: 'aligned',
      runners: {
        browserSnapshot: { status: 'passed', ok: true },
      },
    });
  });

  it('reports an explicit environment gap when the browser runner is requested without a provider', async () => {
    const result = await runSiteAdapterLabFixtureFromInput({
      adapterId: 'books-to-scrape',
      fixture,
      expected,
      browserRunner: {
        enabled: true,
        targetUrl: fixture.snapshot.url,
      },
    });

    expect(result.runnerComparison).toMatchObject({
      browserRunnerOk: null,
      driftStatus: 'environment_gap',
      runners: {
        browserSnapshot: {
          status: 'environment_gap',
          ok: null,
          message: expect.stringContaining('provider is not configured'),
        },
      },
    });
  });

  it('reports an explicit environment gap when the Playwright Lab runner is requested without a provider', async () => {
    const result = await runSiteAdapterLabFixtureFromInput({
      adapterId: 'books-to-scrape',
      fixture,
      expected,
      playwrightLabRunner: {
        enabled: true,
        targetUrl: fixture.snapshot.url,
      },
    });

    expect(result.runnerComparison).toMatchObject({
      playwrightLabRunnerOk: null,
      driftStatus: 'environment_gap',
      runners: {
        playwrightLab: {
          status: 'environment_gap',
          ok: null,
          message: expect.stringContaining('Playwright Lab runner provider is not configured'),
        },
      },
    });
  });

  it('runs a configured Playwright Lab provider through the Lab fixture helper', async () => {
    const result = await runSiteAdapterLabFixtureFromInput(
      {
        adapterId: 'books-to-scrape',
        fixture,
        expected,
        playwrightLabRunner: {
          enabled: true,
          targetUrl: fixture.snapshot.url,
          profileId: 'profile-lab-playwright',
          runtimeId: 'chromium-cloak-playwright',
          timeoutMs: 5_000,
        },
      },
      {
        createPlaywrightLabRunner: (request) => {
          expect(request).toMatchObject({
            adapterId: 'books-to-scrape',
            targetUrl: fixture.snapshot.url,
            profileId: 'profile-lab-playwright',
            runtimeId: 'chromium-cloak-playwright',
            timeoutMs: 5_000,
          });
          return {
            run: ({ adapter, fixture: labFixture, expected: labExpected }) =>
              runReadOnlySiteAdapterFixture(adapter, {
                ...labFixture,
                expected: labExpected,
              }),
          };
        },
      }
    );

    expect(result.runnerComparison).toMatchObject({
      playwrightLabRunnerOk: true,
      driftStatus: 'aligned',
      runners: {
        playwrightLab: { status: 'passed', ok: true },
      },
    });
  });
});
