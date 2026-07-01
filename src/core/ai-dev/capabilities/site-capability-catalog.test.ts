// @tianshe-test area=http-mcp layer=unit runtime=node
import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserInterface, BrowserRuntimeDescriptor } from '../../../types/browser-interface';
import { setObservationSink } from '../../observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../../observability/types';
import {
  createCapabilityConfirmationGrant,
  __resetCapabilityConfirmationGrantsForTests,
} from '../orchestration';
import { createOrchestrationExecutor } from '../orchestration/capability-registry';
import { createUnifiedCapabilityCatalog } from './unified-catalog';
import {
  BOOKS_TO_SCRAPE_CAPABILITY,
  BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
  GITHUB_CREATE_ISSUE_CAPABILITY,
  GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
  GITHUB_PROFILE_CAPABILITY,
  OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
  SITE_CAPABILITY_LIST,
} from './site-capability-catalog';
import fixture from '../../../site-adapters/books-to-scrape/fixtures/product-page.json';
import githubFixture from '../../../site-adapters/github-profile/fixtures/profile-settings.json';
import quotesFixture from '../../../site-adapters/quotes-to-scrape/fixtures/quotes-page-1.json';
import npmPackageFixture from '../../../site-adapters/npm-package/fixtures/vite-package.json';

const QUOTES_CAPABILITY = 'quotes_to_scrape.extract_quote_list';
const HACKER_NEWS_CAPABILITY = 'hacker_news.extract_story_list';
const WIKIPEDIA_CAPABILITY = 'wikipedia.extract_article_summary';
const OPEN_LIBRARY_CAPABILITY = 'open_library.extract_search_results';
const NPM_PACKAGE_CAPABILITY = 'npm.extract_package_summary';

class MemoryObservationSink implements ObservationSink {
  events: RuntimeEvent[] = [];
  artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

const runtimeDescriptor: BrowserRuntimeDescriptor = {
  runtimeId: 'electron-webcontents',
  browserFamily: 'electron',
  controlProtocol: 'webcontents',
  profileMode: 'persistent',
  visibilityMode: 'embedded-view',
  fingerprintBackend: 'electron-stealth',
  source: { type: 'bundled' },
  capabilities: Object.fromEntries(
    [
      'cookies.read',
      'cookies.write',
      'cookies.clear',
      'cookies.filter',
      'storage.dom',
      'userAgent.read',
      'snapshot.page',
      'screenshot.detailed',
      'pdf.print',
      'window.showHide',
      'window.openPolicy',
      'input.native',
      'input.touch',
      'text.dom',
      'text.ocr',
      'network.capture',
      'network.responseBody',
      'console.capture',
      'download.manage',
      'dialog.basic',
      'dialog.promptText',
      'tabs.manage',
      'events.runtime',
      'emulation.identity',
      'emulation.viewport',
      'intercept.observe',
      'intercept.control',
    ].map((name) => [name, { supported: true, stability: 'stable', source: 'static-runtime' }])
  ) as BrowserRuntimeDescriptor['capabilities'],
};

function createMockBrowser(snapshot = fixture.snapshot): BrowserInterface {
  const textBySelector = new Map<string, string>();
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue(snapshot),
    type: vi.fn().mockImplementation(async (selector: string, text: string) => {
      textBySelector.set(selector, text);
    }),
    click: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    getText: vi.fn().mockImplementation(async (selector: string) => {
      if (selector === '#draft-status') {
        return 'Saved search';
      }
      if (selector === '.search-results') {
        return 'Search Results';
      }
      if (selector === 'body') {
        return `New issue ${Array.from(textBySelector.values()).join(' ')}`;
      }
      return textBySelector.get(selector) || '';
    }),
    textExists: vi.fn().mockResolvedValue(false),
    describeRuntime: vi.fn().mockReturnValue(runtimeDescriptor),
    hasCapability: vi.fn().mockReturnValue(true),
  } as unknown as BrowserInterface;
}

function createCompatExecutor(
  deps: Parameters<typeof createOrchestrationExecutor>[0]
): ReturnType<typeof createOrchestrationExecutor> {
  return createOrchestrationExecutor({ enforceScopes: false, ...deps });
}

function createConfirmationGrant(
  capabilityName: string,
  args: Record<string, unknown>,
  options: {
    scopes?: string[];
    sessionId?: string;
    principal?: string;
    grantId?: string;
    invocationId?: string;
  } = {}
) {
  const definition = createUnifiedCapabilityCatalog()[capabilityName]?.definition;
  if (!definition) {
    throw new Error(`Missing definition for ${capabilityName}`);
  }
  return createCapabilityConfirmationGrant({
    definition,
    arguments: args,
    grantId: options.grantId || `grant-${capabilityName}`,
    invocationId: options.invocationId || `invoke-${capabilityName}`,
    principal: options.principal || 'test-principal',
    source: 'agent-ui',
    sessionId: options.sessionId || 'test-session',
    scopes: options.scopes || [],
    now: Date.now,
  });
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

function expectCapabilitySchemaMatch(capabilityName: string, structuredContent: unknown): void {
  const capability = createUnifiedCapabilityCatalog()[capabilityName];
  const validator = ajv.compile(capability.definition.outputSchema);
  const valid = validator(structuredContent);
  expect(valid, JSON.stringify(validator.errors, null, 2)).toBe(true);
}

describe('site capability catalog', () => {
  afterEach(() => {
    setObservationSink(null);
    __resetCapabilityConfirmationGrantsForTests();
  });

  it('registers the first real read-only site capability in the unified catalog', () => {
    const catalog = createUnifiedCapabilityCatalog();

    expect(catalog[BOOKS_TO_SCRAPE_CAPABILITY]).toBeDefined();
    expect(catalog[BOOKS_TO_SCRAPE_CAPABILITY].definition).toMatchObject({
      name: BOOKS_TO_SCRAPE_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      requiredScopes: ['browser.read', 'dataset.write'],
    });
    expect(catalog[BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY].definition).toMatchObject({
      name: BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      sideEffectLevel: 'low',
      requiredScopes: ['browser.write'],
    });
    expect(catalog[OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY].definition).toMatchObject({
      name: OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      sideEffectLevel: 'low',
      requiredScopes: ['browser.write'],
    });
    expect(catalog[GITHUB_PROFILE_CAPABILITY].definition).toMatchObject({
      name: GITHUB_PROFILE_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      requiredScopes: ['browser.read', 'profile.read'],
    });
    expect(catalog[GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY].definition).toMatchObject({
      name: GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      sideEffectLevel: 'low',
      requiredScopes: ['browser.write', 'profile.read'],
    });
    expect(catalog[GITHUB_CREATE_ISSUE_CAPABILITY].definition).toMatchObject({
      name: GITHUB_CREATE_ISSUE_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      sideEffectLevel: 'high',
      requiredScopes: ['browser.write', 'profile.read'],
    });
    expect(catalog[SITE_CAPABILITY_LIST].definition).toMatchObject({
      name: SITE_CAPABILITY_LIST,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      requiredScopes: ['system.read'],
    });
    expect(catalog[QUOTES_CAPABILITY].definition).toMatchObject({
      name: QUOTES_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      requiredScopes: ['browser.read'],
    });
    expect(catalog[NPM_PACKAGE_CAPABILITY].definition).toMatchObject({
      name: NPM_PACKAGE_CAPABILITY,
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'canonical',
      },
      requiredScopes: ['browser.read'],
    });
  });

  it('lists official business site capabilities for agent discovery', async () => {
    const executor = createCompatExecutor({});

    const result = await executor.invokeApi({
      name: SITE_CAPABILITY_LIST,
      arguments: { action: 'extract' },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        total: 7,
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            name: BOOKS_TO_SCRAPE_CAPABILITY,
            siteId: 'books_to_scrape',
            action: 'extract_product',
            adapter: {
              id: 'books-to-scrape',
              version: '1.0.0',
            },
            requiresLogin: false,
          }),
          expect.objectContaining({
            name: GITHUB_PROFILE_CAPABILITY,
            siteId: 'github',
            action: 'extract_profile_summary',
            requiresLogin: true,
          }),
          expect.objectContaining({
            name: QUOTES_CAPABILITY,
            siteId: 'quotes_to_scrape',
            action: 'extract_quote_list',
            requiresLogin: false,
          }),
          expect.objectContaining({
            name: HACKER_NEWS_CAPABILITY,
            siteId: 'hacker_news',
            action: 'extract_story_list',
          }),
          expect.objectContaining({
            name: WIKIPEDIA_CAPABILITY,
            siteId: 'wikipedia',
            action: 'extract_article_summary',
          }),
          expect.objectContaining({
            name: OPEN_LIBRARY_CAPABILITY,
            siteId: 'open_library',
            action: 'extract_search_results',
          }),
          expect.objectContaining({
            name: NPM_PACKAGE_CAPABILITY,
            siteId: 'npm',
            action: 'extract_package_summary',
          }),
        ]),
      },
      recommendedNextTools: expect.arrayContaining([
        BOOKS_TO_SCRAPE_CAPABILITY,
        GITHUB_PROFILE_CAPABILITY,
        QUOTES_CAPABILITY,
      ]),
    });
  });

  it('discovers low-risk write site capabilities without generic browser fallback', async () => {
    const executor = createCompatExecutor({});

    const result = await executor.invokeApi({
      name: SITE_CAPABILITY_LIST,
      arguments: { action: 'prepare_search_draft' },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        total: 2,
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            name: BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
            siteId: 'books_to_scrape',
            action: 'prepare_search_draft',
            sideEffectLevel: 'low',
            requiredScopes: ['browser.write'],
            supportedRunners: expect.arrayContaining(['procedure']),
          }),
          expect.objectContaining({
            name: OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
            siteId: 'open_library',
            action: 'prepare_search_draft',
            sideEffectLevel: 'low',
            requiredScopes: ['browser.write'],
            supportedRunners: expect.arrayContaining(['procedure']),
          }),
        ]),
      },
      recommendedNextTools: expect.arrayContaining([
        BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
        OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
      ]),
    });
  });

  it('discovers the low-risk GitHub issue draft capability with login scope', async () => {
    const executor = createCompatExecutor({});

    const result = await executor.invokeApi({
      name: SITE_CAPABILITY_LIST,
      arguments: { action: 'prepare_issue_draft' },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        total: 1,
        capabilities: [
          expect.objectContaining({
            name: GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
            siteId: 'github',
            action: 'prepare_issue_draft',
            sideEffectLevel: 'low',
            requiresLogin: true,
            requiredScopes: ['browser.write', 'profile.read'],
            supportedRunners: expect.arrayContaining(['procedure']),
          }),
        ],
      },
      recommendedNextTools: [GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY],
    });
  });

  it('discovers the high-risk GitHub issue capability with confirmation policy', async () => {
    const executor = createCompatExecutor({});

    const result = await executor.invokeApi({
      name: SITE_CAPABILITY_LIST,
      arguments: { action: 'create_issue' },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        total: 1,
        capabilities: [
          expect.objectContaining({
            name: GITHUB_CREATE_ISSUE_CAPABILITY,
            siteId: 'github',
            action: 'create_issue',
            sideEffectLevel: 'high',
            riskLevel: 'high',
            requiresLogin: true,
            requiredScopes: ['browser.write', 'profile.read'],
            supportedRunners: expect.arrayContaining(['procedure']),
          }),
        ],
      },
      recommendedNextTools: [GITHUB_CREATE_ISSUE_CAPABILITY],
    });
  });

  it('runs a generic official read-only site capability through SiteAdapterRunner', async () => {
    const browser = createMockBrowser(quotesFixture.snapshot);
    const executor = createCompatExecutor({ browser });

    const result = await executor.invokeApi(
      {
        name: QUOTES_CAPABILITY,
        arguments: {
          url: quotesFixture.snapshot.url,
        },
      },
      { traceId: 'trace-quotes-list' }
    );

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith(quotesFixture.snapshot.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(browser.snapshot).toHaveBeenCalledWith({ elementsFilter: 'all' });
    expect(result.output.structuredContent).toMatchObject({
      data: {
        site: 'quotes.toscrape.com',
        capability: QUOTES_CAPABILITY,
        adapter: {
          id: 'quotes-to-scrape',
          version: '1.0.0',
        },
        fields: {
          quoteCount: 2,
          confidence: 1,
        },
      },
    });
    expectCapabilitySchemaMatch(QUOTES_CAPABILITY, result.output.structuredContent);
  });

  it('runs a real package metadata site capability through the generic official handler', async () => {
    const browser = createMockBrowser(npmPackageFixture.snapshot);
    const executor = createCompatExecutor({ browser });

    const result = await executor.invokeApi(
      {
        name: NPM_PACKAGE_CAPABILITY,
        arguments: {
          url: npmPackageFixture.snapshot.url,
        },
      },
      { traceId: 'trace-npm-package-summary' }
    );

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith(npmPackageFixture.snapshot.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(browser.snapshot).toHaveBeenCalledWith({ elementsFilter: 'all' });
    expect(result.output.structuredContent).toMatchObject({
      data: {
        site: 'npmjs.com',
        capability: NPM_PACKAGE_CAPABILITY,
        adapter: {
          id: 'npm-package',
          version: '1.0.0',
        },
        fields: {
          packageName: 'vite',
          version: '7.2.4',
          weeklyDownloadCount: 39281430,
          license: 'MIT',
          confidence: 1,
        },
      },
    });
    expectCapabilitySchemaMatch(NPM_PACKAGE_CAPABILITY, result.output.structuredContent);
  });

  it('extracts a public product page and commits dataset provenance when requested', async () => {
    const browser = createMockBrowser();
    const stagedPlan = {
      planId: 'plan-books-1',
      datasetId: 'dataset-books',
      createdAt: '2026-06-22T00:00:00.000Z',
      operations: [{ type: 'insert' as const, record: { productName: 'A Light in the Attic' } }],
      rowCount: 1,
      requiresConfirmation: true as const,
    };
    const stageWritePlan = vi.fn().mockResolvedValue(stagedPlan);
    const commitWritePlan = vi.fn().mockResolvedValue({
      planId: stagedPlan.planId,
      runId: 'run-books-1',
      datasetId: stagedPlan.datasetId,
      insertedRowIds: [1],
      updatedRowIds: [],
      deletedRowIds: [],
      affectedRowCount: 1,
      provenanceRecorded: true,
    });
    const executor = createCompatExecutor({
      browser,
      datasetGateway: {
        listDatasets: async () => [],
        getDatasetInfo: async () => null,
        queryDataset: async () => ({ columns: [], rows: [], rowCount: 0 }),
        createEmptyDataset: async () => 'dataset-new',
        importDatasetFile: async () => 'dataset-import',
        stageWritePlan,
        commitWritePlan,
        listRecordProvenance: async () => [],
        renameDataset: async () => undefined,
        deleteDataset: async () => undefined,
      },
    });

    const args = {
      url: fixture.snapshot.url,
      datasetId: 'dataset-books',
      commitDatasetWrite: true,
    };
    const result = await executor.invokeApi(
      {
        name: BOOKS_TO_SCRAPE_CAPABILITY,
        arguments: args,
        auth: {
          principal: 'test-principal',
          sessionId: 'test-session',
          scopes: ['browser.read', 'dataset.write'],
          confirmationGrant: createConfirmationGrant(BOOKS_TO_SCRAPE_CAPABILITY, args, {
            scopes: ['browser.read', 'dataset.write'],
          }),
        },
      },
      { traceId: 'trace-books-product' }
    );

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith(fixture.snapshot.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(browser.snapshot).toHaveBeenCalledWith({ elementsFilter: 'all' });
    expect(stageWritePlan).toHaveBeenCalledWith(
      'dataset-books',
      [
        expect.objectContaining({
          type: 'insert',
          record: expect.objectContaining({
            productName: 'A Light in the Attic',
            sourceUrl: fixture.snapshot.url,
          }),
        }),
      ],
      expect.objectContaining({
        traceId: 'trace-books-product',
        adapterId: 'books-to-scrape',
        adapterVersion: '1.0.0',
        runtimeId: 'electron-webcontents',
        sourceUrl: fixture.snapshot.url,
      })
    );
    expect(commitWritePlan).toHaveBeenCalledWith(
      stagedPlan,
      expect.objectContaining({
        confirmRisk: true,
        traceId: 'trace-books-product',
        adapterId: 'books-to-scrape',
      })
    );
    expect(result.output.structuredContent).toMatchObject({
      data: {
        fields: {
          productName: 'A Light in the Attic',
          confidence: 1,
        },
        runner: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ path: 'productName', ok: true }),
            expect.objectContaining({ path: 'price', ok: true }),
            expect.objectContaining({ path: 'confidence', ok: true }),
          ]),
        },
        datasetWrite: {
          status: 'committed',
          commit: {
            provenanceRecorded: true,
          },
        },
      },
    });
    expectCapabilitySchemaMatch(BOOKS_TO_SCRAPE_CAPABILITY, result.output.structuredContent);
  });

  it('prepares the requested session before public product extraction', async () => {
    const browser = createMockBrowser();
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-books',
      prepared: true,
      idempotent: false,
      profileId: 'profile-books',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: ['browser.read', 'dataset.write'],
      browserAcquired: true,
      changed: ['profile', 'runtimeId', 'visible', 'scopes'],
      phase: 'bound_browser',
      bindingLocked: true,
    });
    const executor = createCompatExecutor({
      browser,
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-books',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const result = await executor.invokeApi({
      name: BOOKS_TO_SCRAPE_CAPABILITY,
      arguments: {
        url: fixture.snapshot.url,
        profileId: 'profile-books',
        runtimeId: 'electron-webcontents',
        visible: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-books',
      runtimeId: 'electron-webcontents',
      visible: true,
      scopes: ['browser.read', 'dataset.write'],
    });
    expect(result.output.structuredContent).toMatchObject({
      data: {
        sessionPrepare: {
          sessionId: 'session-books',
          profileId: 'profile-books',
          runtimeId: 'electron-webcontents',
        },
      },
    });
  });

  it('acquires the site capability browser from browserFactory after session preparation', async () => {
    const browser = createMockBrowser();
    const browserFactory = vi.fn().mockResolvedValue(browser);
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-books',
      prepared: true,
      idempotent: false,
      profileId: 'profile-books',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: ['browser.read', 'dataset.write'],
      browserAcquired: false,
      changed: ['profile', 'runtimeId', 'visible', 'scopes'],
      phase: 'prepared_unacquired',
      bindingLocked: false,
    });
    const executor = createCompatExecutor({
      browserFactory,
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-books',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const result = await executor.invokeApi({
      name: BOOKS_TO_SCRAPE_CAPABILITY,
      arguments: {
        url: fixture.snapshot.url,
        profileId: 'profile-books',
        runtimeId: 'electron-webcontents',
        visible: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-books',
      runtimeId: 'electron-webcontents',
      visible: true,
      scopes: ['browser.read', 'dataset.write'],
    });
    expect(browserFactory).toHaveBeenCalledWith({});
    expect(prepareCurrentSession.mock.invocationCallOrder[0]).toBeLessThan(
      browserFactory.mock.invocationCallOrder[0]
    );
    expect(browser.goto).toHaveBeenCalledWith(fixture.snapshot.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  });

  it('runs the low-risk Books search draft Procedure through a public site capability', async () => {
    const browser = createMockBrowser();
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-books-draft',
      prepared: true,
      idempotent: false,
      profileId: 'profile-books',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: ['browser.write'],
      browserAcquired: true,
      changed: ['profile', 'runtimeId', 'visible', 'scopes'],
      phase: 'bound_browser',
      bindingLocked: true,
    });
    const executor = createCompatExecutor({
      browser,
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-books-draft',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const result = await executor.invokeApi(
      {
        name: BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
        arguments: {
          query: 'science fiction',
          profileId: 'profile-books',
          runtimeId: 'electron-webcontents',
          visible: true,
        },
      },
      { traceId: 'trace-books-search-draft' }
    );

    expect(result.ok).toBe(true);
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-books',
      runtimeId: 'electron-webcontents',
      visible: true,
      scopes: ['browser.write'],
    });
    expect(browser.type).toHaveBeenCalledWith('#search-query', 'science fiction', {
      clear: true,
    });
    expect(browser.click).toHaveBeenCalledWith('#save-search-draft');
    expect(result.output.structuredContent).toMatchObject({
      data: {
        capability: BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
        query: 'science fiction',
        procedure: {
          id: 'save-search-draft',
          sideEffectLevel: 'low',
        },
        runner: {
          runner: 'procedure',
          status: 'completed',
          actionTrace: expect.arrayContaining([
            expect.objectContaining({
              stepId: 'enter-query',
              action: 'type',
              outcome: 'succeeded',
            }),
            expect.objectContaining({
              stepId: 'save-draft',
              action: 'click',
              outcome: 'succeeded',
            }),
          ]),
        },
      },
    });
    expectCapabilitySchemaMatch(
      BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
      result.output.structuredContent
    );
  });

  it('runs the low-risk Open Library search draft Procedure through a public site capability', async () => {
    const browser = createMockBrowser();
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-open-library-draft',
      prepared: true,
      idempotent: false,
      profileId: 'profile-open-library',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: ['browser.write'],
      browserAcquired: true,
      changed: ['profile', 'runtimeId', 'visible', 'scopes'],
      phase: 'bound_browser',
      bindingLocked: true,
    });
    const executor = createCompatExecutor({
      browser,
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-open-library-draft',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const result = await executor.invokeApi(
      {
        name: OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
        arguments: {
          query: 'database systems',
          profileId: 'profile-open-library',
          runtimeId: 'electron-webcontents',
          visible: true,
        },
      },
      { traceId: 'trace-open-library-search-draft' }
    );

    expect(result.ok).toBe(true);
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-open-library',
      runtimeId: 'electron-webcontents',
      visible: true,
      scopes: ['browser.write'],
    });
    expect(browser.type).toHaveBeenCalledWith('input[name="q"]', 'database systems', {
      clear: true,
    });
    expect(result.output.structuredContent).toMatchObject({
      data: {
        capability: OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
        query: 'database systems',
        procedure: {
          id: 'prepare-search-draft',
          sideEffectLevel: 'low',
        },
        runner: {
          runner: 'procedure',
          status: 'completed',
          actionTrace: expect.arrayContaining([
            expect.objectContaining({
              stepId: 'enter-query',
              action: 'type',
              outcome: 'succeeded',
            }),
            expect.objectContaining({
              stepId: 'preview-next-results-page',
              action: 'paginate',
              outcome: 'succeeded',
              output: expect.objectContaining({
                pagesVisited: 1,
                stopReason: 'max_pages',
              }),
            }),
          ]),
        },
      },
    });
    expectCapabilitySchemaMatch(
      OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
      result.output.structuredContent
    );
  });

  it('runs the low-risk GitHub issue draft Procedure through a public site capability', async () => {
    const browser = createMockBrowser(githubFixture.snapshot);
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-github-issue-draft',
      prepared: true,
      idempotent: true,
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: false,
      effectiveScopes: ['browser.write', 'profile.read'],
      browserAcquired: true,
      changed: [],
      phase: 'bound_browser',
      bindingLocked: true,
    });
    const executor = createCompatExecutor({
      browser,
      profileLoginStateGateway: {
        getLoginState: async () => ({
          id: 'login-github-draft',
          profileId: 'profile-github',
          site: 'github.com',
          runtimeId: 'electron-webcontents',
          status: 'logged_in',
          verified: true,
          lastCheckedAt: '2026-06-22T00:00:00.000Z',
          verifiedAt: '2026-06-22T00:00:00.000Z',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
        }),
        upsertLoginState: async () => {
          throw new Error('ready issue draft should not update login state');
        },
      },
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-github-issue-draft',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const result = await executor.invokeApi(
      {
        name: GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
        arguments: {
          profileId: 'profile-github',
          owner: 'tiansheai',
          repo: 'tianshe',
          title: 'Bug: draft procedure coverage',
          body: 'Draft steps to reproduce the issue procedure coverage.',
        },
      },
      { traceId: 'trace-github-issue-draft' }
    );

    expect(result.ok).toBe(true);
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: false,
      scopes: ['browser.write', 'profile.read'],
    });
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/tiansheai/tianshe/issues/new', {
      waitUntil: 'domcontentloaded',
    });
    expect(browser.type).toHaveBeenCalledWith('#issue_title', 'Bug: draft procedure coverage', {
      clear: true,
    });
    expect(browser.type).toHaveBeenCalledWith(
      '#issue_body',
      'Draft steps to reproduce the issue procedure coverage.',
      { clear: true }
    );
    expect(browser.click).not.toHaveBeenCalledWith('button[type="submit"]');
    expect(result.output.structuredContent).toMatchObject({
      data: {
        capability: GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
        repository: {
          owner: 'tiansheai',
          repo: 'tianshe',
        },
        issue: {
          title: 'Bug: draft procedure coverage',
          preparedOnly: true,
        },
        procedure: {
          id: 'prepare-issue-draft',
          sideEffectLevel: 'low',
        },
        runner: {
          runner: 'procedure',
          status: 'completed',
          actionTrace: expect.arrayContaining([
            expect.objectContaining({
              stepId: 'fill-issue-draft',
              action: 'fillForm',
              outcome: 'succeeded',
            }),
            expect.objectContaining({
              stepId: 'verify-issue-body-drafted',
              action: 'verifyText',
              outcome: 'succeeded',
            }),
          ]),
        },
        evidence: {
          submitted: false,
          destructiveConfirmation: false,
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        },
      },
    });
    expectCapabilitySchemaMatch(
      GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
      result.output.structuredContent
    );
  });

  it('rejects high-risk GitHub issue creation without a confirmation grant before browser actions', async () => {
    const browser = createMockBrowser(githubFixture.snapshot);
    const executor = createCompatExecutor({ browser });

    const result = await executor.invokeApi({
      name: GITHUB_CREATE_ISSUE_CAPABILITY,
      arguments: {
        profileId: 'profile-github',
        owner: 'tiansheai',
        repo: 'tianshe',
        title: 'Bug: confirmation gate',
        body: 'This should not be submitted without confirmation.',
      },
      auth: {
        principal: 'test-principal',
        sessionId: 'test-session',
        scopes: ['browser.write', 'profile.read'],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.reasonCode).toBe('capability_confirmation_required');
    expect(browser.goto).not.toHaveBeenCalled();
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('runs the high-risk GitHub issue creation Procedure through a public site capability', async () => {
    const browser = createMockBrowser(githubFixture.snapshot);
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-github-create-issue',
      prepared: true,
      idempotent: true,
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: false,
      effectiveScopes: ['browser.write', 'profile.read'],
      browserAcquired: true,
      changed: [],
      phase: 'bound_browser',
      bindingLocked: true,
    });
    const executor = createCompatExecutor({
      browser,
      profileLoginStateGateway: {
        getLoginState: async () => ({
          id: 'login-github-issue',
          profileId: 'profile-github',
          site: 'github.com',
          runtimeId: 'electron-webcontents',
          status: 'logged_in',
          verified: true,
          lastCheckedAt: '2026-06-22T00:00:00.000Z',
          verifiedAt: '2026-06-22T00:00:00.000Z',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
        }),
        upsertLoginState: async () => {
          throw new Error('ready issue creation should not update login state');
        },
      },
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-github-create-issue',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const args = {
      profileId: 'profile-github',
      owner: 'tiansheai',
      repo: 'tianshe',
      title: 'Bug: issue procedure coverage',
      body: 'Steps to reproduce the issue procedure coverage.',
    };
    const result = await executor.invokeApi(
      {
        name: GITHUB_CREATE_ISSUE_CAPABILITY,
        arguments: args,
        auth: {
          principal: 'test-principal',
          sessionId: 'test-session',
          scopes: ['browser.write', 'profile.read'],
          confirmationGrant: createConfirmationGrant(GITHUB_CREATE_ISSUE_CAPABILITY, args, {
            scopes: ['browser.write', 'profile.read'],
          }),
        },
      },
      { traceId: 'trace-github-create-issue' }
    );

    expect(result.ok).toBe(true);
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: false,
      scopes: ['browser.write', 'profile.read'],
    });
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/tiansheai/tianshe/issues/new', {
      waitUntil: 'domcontentloaded',
    });
    expect(browser.type).toHaveBeenCalledWith('#issue_title', 'Bug: issue procedure coverage', {
      clear: true,
    });
    expect(browser.type).toHaveBeenCalledWith(
      '#issue_body',
      'Steps to reproduce the issue procedure coverage.',
      { clear: true }
    );
    expect(browser.click).toHaveBeenCalledWith('button[type="submit"]');
    expect(result.output.structuredContent).toMatchObject({
      data: {
        capability: GITHUB_CREATE_ISSUE_CAPABILITY,
        repository: {
          owner: 'tiansheai',
          repo: 'tianshe',
        },
        issue: {
          title: 'Bug: issue procedure coverage',
        },
        procedure: {
          id: 'create-issue',
          sideEffectLevel: 'high',
        },
        runner: {
          runner: 'procedure',
          status: 'completed',
          actionTrace: expect.arrayContaining([
            expect.objectContaining({
              stepId: 'submit-issue',
              action: 'click',
              outcome: 'succeeded',
            }),
          ]),
        },
        evidence: {
          destructiveConfirmation: true,
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        },
      },
    });
    expectCapabilitySchemaMatch(GITHUB_CREATE_ISSUE_CAPABILITY, result.output.structuredContent);
  });

  it('returns repair evidence when the site adapter verifier fails', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const brokenSnapshot = {
      ...fixture.snapshot,
      elements: fixture.snapshot.elements.filter(
        (element) => element.attributes?.class !== 'price_color'
      ),
    };
    const executor = createCompatExecutor({
      browser: createMockBrowser(brokenSnapshot),
    });

    const result = await executor.invokeApi(
      {
        name: BOOKS_TO_SCRAPE_CAPABILITY,
        arguments: { url: fixture.snapshot.url },
      },
      { traceId: 'trace-books-product-failure' }
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('extraction failed verification');
    expect(
      sink.artifacts.every((artifact) => artifact.traceId === 'trace-books-product-failure')
    ).toBe(true);
    expect(sink.artifacts.map((artifact) => artifact.type).slice(0, 6)).toEqual([
      'site_adapter_result',
      'procedure_state_transition',
      'interactor_action_trace',
      'site_adapter_failure',
      'site_adapter_repair_evidence',
      'site_adapter_repair_bundle',
    ]);
    expect(sink.artifacts.map((artifact) => artifact.type)).toContain('error_context');
    const errorContext = (
      result.output.structuredContent.error as {
        context?: { artifactRefs?: string[] };
      }
    ).context;
    expect(errorContext).toMatchObject({
      capability: BOOKS_TO_SCRAPE_CAPABILITY,
      adapterId: 'books-to-scrape',
      adapterVersion: '1.0.0',
    });
    const referencedArtifacts = (errorContext?.artifactRefs || []).map((artifactId) =>
      sink.artifacts.find((artifact) => artifact.artifactId === artifactId)
    );
    expect(referencedArtifacts.map((artifact) => artifact?.type)).toEqual([
      'site_adapter_result',
      'procedure_state_transition',
      'interactor_action_trace',
      'site_adapter_failure',
      'site_adapter_repair_evidence',
      'site_adapter_repair_bundle',
    ]);
  });

  it('returns manual handoff for logged-in site capability when GitHub is not verified', async () => {
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-github',
      prepared: true,
      idempotent: false,
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: true,
      effectiveScopes: [],
      browserAcquired: false,
      changed: ['visible'],
      phase: 'prepared_unacquired',
      bindingLocked: false,
    });
    const upsertLoginState = vi.fn().mockImplementation(async (params) => ({
      id: 'login-github',
      profileId: params.profileId,
      site: params.site,
      runtimeId: params.runtimeId ?? null,
      status: params.status,
      verified: params.verified,
      lastCheckedAt: '2026-06-22T00:00:00.000Z',
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
    }));
    const executor = createCompatExecutor({
      profileLoginStateGateway: {
        getLoginState: async () => null,
        upsertLoginState,
      },
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-github',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const result = await executor.invokeApi({
      name: GITHUB_PROFILE_CAPABILITY,
      arguments: { profileId: 'profile-github', runtimeId: 'electron-webcontents' },
    });

    expect(result.ok).toBe(true);
    expect(result.output.structuredContent).toMatchObject({
      data: {
        site: 'github.com',
        status: 'needs_manual_login',
        verified: false,
        manualHandoffRequired: true,
        loginHealth: {
          ok: false,
          reasonCode: 'missing_login_state',
          manualHandoffRequired: true,
        },
        evidence: {
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        },
      },
      recommendedNextTools: ['profile_ensure_logged_in', 'session_prepare'],
    });
    expectCapabilitySchemaMatch(GITHUB_PROFILE_CAPABILITY, result.output.structuredContent);
    expect(JSON.stringify(result.output.structuredContent)).not.toMatch(
      /password|cookie_value|authorization|token_value/i
    );
    expect(prepareCurrentSession).toHaveBeenCalledWith({
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: true,
    });
    expect(upsertLoginState).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'missing_login_state',
        evidence: expect.objectContaining({
          manualHandoffRequired: true,
          loginHealth: expect.objectContaining({ reasonCode: 'missing_login_state' }),
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        }),
      })
    );
  });

  it('resumes GitHub extraction after manual login handoff is marked verified', async () => {
    const browser = createMockBrowser(githubFixture.snapshot);
    let loginState: Record<string, unknown> | null = null;
    const prepareCurrentSession = vi
      .fn()
      .mockImplementation(
        async (request: { profileId?: string; runtimeId?: string; visible?: boolean }) => ({
          sessionId: request.visible ? 'session-github-handoff' : 'session-github-resume',
          prepared: true,
          idempotent: request.visible !== true,
          profileId: request.profileId,
          runtimeId: request.runtimeId,
          visible: request.visible ?? false,
          effectiveScopes: [],
          browserAcquired: request.visible !== true,
          changed: request.visible ? ['visible'] : [],
          phase: request.visible ? 'prepared_unacquired' : 'bound_browser',
          bindingLocked: request.visible !== true,
        })
      );
    const upsertLoginState = vi
      .fn()
      .mockImplementation(
        async (params: {
          profileId: string;
          site: string;
          runtimeId?: string;
          status: string;
          verified: boolean;
          verifiedAt?: Date;
          evidence?: Record<string, unknown>;
          reason?: string;
        }) => {
          loginState = {
            id: 'login-github-resume',
            profileId: params.profileId,
            site: params.site,
            runtimeId: params.runtimeId ?? null,
            status: params.status,
            verified: params.verified,
            verifiedAt: params.verifiedAt?.toISOString?.() ?? null,
            evidence: params.evidence,
            reason: params.reason,
            lastCheckedAt: '2026-06-22T00:00:00.000Z',
            createdAt: '2026-06-22T00:00:00.000Z',
            updatedAt: '2026-06-22T00:00:00.000Z',
          };
          return loginState;
        }
      );
    const executor = createCompatExecutor({
      browser,
      profileLoginStateGateway: {
        getLoginState: async () => loginState,
        upsertLoginState,
      },
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-github-resume',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const handoff = await executor.invokeApi({
      name: GITHUB_PROFILE_CAPABILITY,
      arguments: { profileId: 'profile-github', runtimeId: 'electron-webcontents' },
    });

    expect(handoff.ok).toBe(true);
    expect(handoff.output.structuredContent).toMatchObject({
      data: {
        manualHandoffRequired: true,
        status: 'needs_manual_login',
        verified: false,
        loginHealth: {
          reasonCode: 'missing_login_state',
        },
      },
    });
    expect(browser.goto).not.toHaveBeenCalled();

    loginState = {
      ...(loginState || {}),
      status: 'logged_in',
      verified: true,
      runtimeId: 'electron-webcontents',
      verifiedAt: '2026-06-22T00:01:00.000Z',
    };

    const resumed = await executor.invokeApi({
      name: GITHUB_PROFILE_CAPABILITY,
      arguments: { profileId: 'profile-github' },
    });

    expect(resumed.ok).toBe(true);
    expect(prepareCurrentSession).toHaveBeenNthCalledWith(1, {
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: true,
    });
    expect(prepareCurrentSession).toHaveBeenNthCalledWith(2, {
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: false,
    });
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/settings/profile', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(resumed.output.structuredContent).toMatchObject({
      data: {
        fields: {
          displayName: 'Ada Lovelace',
        },
        loginState: {
          status: 'logged_in',
          verified: true,
          evidence: {
            verifier: 'github-profile-settings',
            credentialValuesReturned: false,
            cookieValuesReturned: false,
            tokenValuesReturned: false,
          },
        },
      },
    });
    expectCapabilitySchemaMatch(GITHUB_PROFILE_CAPABILITY, handoff.output.structuredContent);
    expectCapabilitySchemaMatch(GITHUB_PROFILE_CAPABILITY, resumed.output.structuredContent);
  });

  it('continues logged-in GitHub extraction with the same prepared profile', async () => {
    const browser = createMockBrowser(githubFixture.snapshot);
    const prepareCurrentSession = vi.fn().mockResolvedValue({
      sessionId: 'session-github-ready',
      prepared: true,
      idempotent: true,
      profileId: 'profile-github',
      runtimeId: 'electron-webcontents',
      visible: false,
      effectiveScopes: [],
      browserAcquired: true,
      changed: [],
      phase: 'bound_browser',
      bindingLocked: true,
    });
    const upsertLoginState = vi.fn().mockImplementation(async (params) => ({
      id: 'login-github-ready',
      profileId: params.profileId,
      site: params.site,
      runtimeId: params.runtimeId ?? null,
      status: params.status,
      verified: params.verified,
      lastCheckedAt: '2026-06-22T00:00:00.000Z',
      verifiedAt:
        params.verifiedAt instanceof Date
          ? params.verifiedAt.toISOString()
          : '2026-06-22T00:00:00.000Z',
      evidence: params.evidence,
      reason: params.reason,
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
    }));
    const executor = createCompatExecutor({
      browser,
      profileLoginStateGateway: {
        getLoginState: async () => ({
          id: 'login-github-ready',
          profileId: 'profile-github',
          site: 'github.com',
          runtimeId: 'electron-webcontents',
          status: 'logged_in',
          verified: true,
          lastCheckedAt: '2026-06-22T00:00:00.000Z',
          verifiedAt: '2026-06-22T00:00:00.000Z',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z',
        }),
        upsertLoginState,
      },
      mcpSessionGateway: {
        getCurrentSessionId: () => 'session-github-ready',
        listSessions: async () => [],
        prepareCurrentSession,
        closeSession: async () => ({ closed: true }),
      },
    });

    const result = await executor.invokeApi({
      name: GITHUB_PROFILE_CAPABILITY,
      arguments: { profileId: 'profile-github' },
    });

    expect(result.ok).toBe(true);
    expect(browser.goto).toHaveBeenCalledWith('https://github.com/settings/profile', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(result.output.structuredContent).toMatchObject({
      data: {
        fields: {
          displayName: 'Ada Lovelace',
          confidence: 1,
        },
        runner: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ path: 'displayName', ok: true }),
            expect.objectContaining({ path: 'confidence', ok: true }),
          ]),
        },
        loginState: {
          status: 'logged_in',
          verified: true,
          evidence: {
            verifier: 'github-profile-settings',
            displayNamePresent: true,
            credentialValuesReturned: false,
            cookieValuesReturned: false,
            tokenValuesReturned: false,
          },
        },
        evidence: {
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        },
      },
    });
    expectCapabilitySchemaMatch(GITHUB_PROFILE_CAPABILITY, result.output.structuredContent);
    expect(upsertLoginState).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-github',
        site: 'github.com',
        runtimeId: 'electron-webcontents',
        status: 'logged_in',
        verified: true,
        verifiedAt: expect.any(Date),
        evidence: expect.objectContaining({
          verifier: 'github-profile-settings',
          displayNamePresent: true,
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        }),
        reason: 'profile_settings_extracted',
      })
    );
  });
});
