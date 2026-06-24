import { officialSiteAdapters, getOfficialSiteAdapter } from '../../site-adapters';
import {
  captureSiteAdapterFixture,
  runSelectorWorkbench,
  runSiteAdapterLabFixturePanel,
} from '../../core/site-adapter-lab';
import type {
  SiteAdapterLabBrowserRunnerOptions,
  SiteAdapterLabPlaywrightRunnerOptions,
} from '../../core/site-adapter-lab';
import { saveSiteAdapterExpected, type SaveExpectedAndRunInput } from './artifact-service';
import type { PageSnapshot } from '../../types/browser-interface';
import type { SiteAdapterFixture } from '../../core/site-adapter-runtime';
import { createIpcHandler } from '../ipc-handlers/utils';
import { createLogger } from '../../core/logger';

const logger = createLogger('SiteAdapterLabIPC');

export interface SiteAdapterLabBrowserRunnerRequest {
  adapterId: string;
  fixture: SiteAdapterFixture;
  expected: Record<string, unknown>;
  targetUrl?: string;
  profileId?: string;
  runtimeId?: string;
  timeoutMs?: number;
}

export interface SiteAdapterLabRunFixtureInput {
  adapterId: string;
  fixture: SiteAdapterFixture;
  expected: Record<string, unknown>;
  browserRunner?: {
    enabled?: boolean;
    targetUrl?: string;
    profileId?: string;
    runtimeId?: string;
    timeoutMs?: number;
  };
  playwrightLabRunner?: {
    enabled?: boolean;
    targetUrl?: string;
    profileId?: string;
    runtimeId?: string;
    timeoutMs?: number;
  };
}

export interface SiteAdapterLabHandlerOptions {
  createBrowserRunner?: (
    request: SiteAdapterLabBrowserRunnerRequest
  ) => Promise<SiteAdapterLabBrowserRunnerOptions> | SiteAdapterLabBrowserRunnerOptions;
  createPlaywrightLabRunner?: (
    request: SiteAdapterLabBrowserRunnerRequest
  ) => Promise<SiteAdapterLabPlaywrightRunnerOptions> | SiteAdapterLabPlaywrightRunnerOptions;
}

function requireAdapter(adapterId: string) {
  const adapter = getOfficialSiteAdapter(String(adapterId || '').trim());
  if (!adapter) {
    throw new Error(`Site adapter not found: ${adapterId}`);
  }
  return adapter;
}

type OfficialFixtureLoader = () => Promise<{
  fixture: { default: unknown };
  expected: { default: unknown };
}>;

const officialFixtureLoaders: Record<string, Record<string, OfficialFixtureLoader>> = {
  'books-to-scrape': {
    'product-page': async () => ({
      fixture: await import('../../site-adapters/books-to-scrape/fixtures/product-page.json'),
      expected: await import('../../site-adapters/books-to-scrape/expected/product-page.json'),
    }),
  },
  'github-profile': {
    'profile-settings': async () => ({
      fixture: await import('../../site-adapters/github-profile/fixtures/profile-settings.json'),
      expected: await import('../../site-adapters/github-profile/expected/profile-settings.json'),
    }),
  },
  'quotes-to-scrape': {
    'quotes-page-1': async () => ({
      fixture: await import('../../site-adapters/quotes-to-scrape/fixtures/quotes-page-1.json'),
      expected: await import('../../site-adapters/quotes-to-scrape/expected/quotes-page-1.json'),
    }),
  },
  'hacker-news': {
    'front-page': async () => ({
      fixture: await import('../../site-adapters/hacker-news/fixtures/front-page.json'),
      expected: await import('../../site-adapters/hacker-news/expected/front-page.json'),
    }),
  },
  'wikipedia-article': {
    'ada-lovelace': async () => ({
      fixture: await import('../../site-adapters/wikipedia-article/fixtures/ada-lovelace.json'),
      expected: await import('../../site-adapters/wikipedia-article/expected/ada-lovelace.json'),
    }),
  },
  'open-library': {
    'database-search': async () => ({
      fixture: await import('../../site-adapters/open-library/fixtures/database-search.json'),
      expected: await import('../../site-adapters/open-library/expected/database-search.json'),
    }),
  },
  'npm-package': {
    'vite-package': async () => ({
      fixture: await import('../../site-adapters/npm-package/fixtures/vite-package.json'),
      expected: await import('../../site-adapters/npm-package/expected/vite-package.json'),
    }),
  },
};

function getFixtureSnapshotUrl(fixture: SiteAdapterFixture): string | undefined {
  const snapshot = fixture.snapshot as { url?: unknown } | null | undefined;
  const url = typeof snapshot?.url === 'string' ? snapshot.url.trim() : '';
  return url || undefined;
}

export async function loadOfficialFixture(adapterId: string, fixtureName: string) {
  const normalizedAdapterId = String(adapterId || '').trim();
  const normalizedFixtureName = String(fixtureName || '').trim();
  const adapter = requireAdapter(normalizedAdapterId);
  if (!adapter.manifest.fixtures?.includes(normalizedFixtureName)) {
    throw new Error(`Fixture is not declared by ${normalizedAdapterId}: ${normalizedFixtureName}`);
  }

  const loader = officialFixtureLoaders[normalizedAdapterId]?.[normalizedFixtureName];
  if (!loader) {
    throw new Error(
      `Official fixture loader is not configured: ${normalizedAdapterId}/${normalizedFixtureName}`
    );
  }

  const { fixture, expected } = await loader();
  const expectedData = expected.default as Record<string, unknown>;
  return {
    fixture: {
      ...(fixture.default as Omit<SiteAdapterFixture, 'expected'>),
      expected: expectedData,
    },
    expected: expectedData,
  };
}

async function resolveBrowserRunnerOptions(
  input: SiteAdapterLabRunFixtureInput,
  options: SiteAdapterLabHandlerOptions
): Promise<SiteAdapterLabBrowserRunnerOptions | undefined> {
  if (input.browserRunner?.enabled !== true) {
    return undefined;
  }
  if (!options.createBrowserRunner) {
    return {
      unavailableReason: 'Browser snapshot runner provider is not configured for this Lab.',
    };
  }

  return options.createBrowserRunner({
    adapterId: input.adapterId,
    fixture: input.fixture,
    expected: input.expected,
    targetUrl: input.browserRunner.targetUrl || getFixtureSnapshotUrl(input.fixture),
    profileId: input.browserRunner.profileId,
    runtimeId: input.browserRunner.runtimeId,
    timeoutMs: input.browserRunner.timeoutMs,
  });
}

async function resolvePlaywrightLabRunnerOptions(
  input: SiteAdapterLabRunFixtureInput,
  options: SiteAdapterLabHandlerOptions
): Promise<SiteAdapterLabPlaywrightRunnerOptions | undefined> {
  if (input.playwrightLabRunner?.enabled !== true) {
    return undefined;
  }
  if (!options.createPlaywrightLabRunner) {
    return {
      unavailableReason: 'Playwright Lab runner provider is not configured for this Lab.',
    };
  }

  return options.createPlaywrightLabRunner({
    adapterId: input.adapterId,
    fixture: input.fixture,
    expected: input.expected,
    targetUrl:
      input.playwrightLabRunner.targetUrl ||
      input.browserRunner?.targetUrl ||
      getFixtureSnapshotUrl(input.fixture),
    profileId: input.playwrightLabRunner.profileId || input.browserRunner?.profileId,
    runtimeId: input.playwrightLabRunner.runtimeId || input.browserRunner?.runtimeId,
    timeoutMs: input.playwrightLabRunner.timeoutMs || input.browserRunner?.timeoutMs,
  });
}

export async function runSiteAdapterLabFixtureFromInput(
  input: SiteAdapterLabRunFixtureInput,
  options: SiteAdapterLabHandlerOptions = {}
) {
  const adapter = requireAdapter(input.adapterId);
  const [browserRunner, playwrightLabRunner] = await Promise.all([
    resolveBrowserRunnerOptions(input, options),
    resolvePlaywrightLabRunnerOptions(input, options),
  ]);

  return runSiteAdapterLabFixturePanel(adapter, input.fixture, input.expected, {
    browserRunner,
    playwrightLabRunner,
  });
}

export function registerSiteAdapterLabHandlers(options: SiteAdapterLabHandlerOptions = {}): void {
  createIpcHandler(
    'site-adapter-lab:list-adapters',
    async () =>
      officialSiteAdapters.map((adapter) => ({
        manifest: adapter.manifest,
      })),
    { errorMessage: '获取 Site Adapter 列表失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-lab:load-fixture',
    async (input: { adapterId: string; fixtureName: string }) =>
      loadOfficialFixture(input.adapterId, input.fixtureName),
    { errorMessage: '加载 Site Adapter fixture 失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-lab:capture-fixture',
    async (input: {
      name: string;
      snapshot: PageSnapshot;
      input?: Record<string, unknown>;
      screenshotDataUrl?: string | null;
    }) => captureSiteAdapterFixture(input),
    { errorMessage: '生成 Site Adapter fixture 失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-lab:validate-selector',
    async (input: { snapshot: PageSnapshot; selector: string; limit?: number }) =>
      runSelectorWorkbench(input.snapshot, input.selector, { limit: input.limit }),
    { errorMessage: '验证 selector 失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-lab:run-fixture',
    async (input: SiteAdapterLabRunFixtureInput) =>
      runSiteAdapterLabFixtureFromInput(input, options),
    { errorMessage: '运行 Site Adapter fixture 失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-lab:save-expected',
    async (input: SaveExpectedAndRunInput) => {
      const adapter = requireAdapter(input.adapterId);
      const save = await saveSiteAdapterExpected(input);
      const runner = await runSiteAdapterLabFixturePanel(adapter, input.fixture, input.expected);
      return { save, runner };
    },
    { errorMessage: '保存 Site Adapter expected 失败', permission: 'trusted-renderer' }
  );

  logger.info('Site Adapter Lab handlers registered');
}
