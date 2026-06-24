// @tianshe-test area=browser layer=unit runtime=node
import { describe, expect, it, vi } from 'vitest';
import type { SiteAdapterRepairTaskPayload } from '../../core/site-adapter-repair-studio';
import type { RepairStudioModelProviderConfig } from '../../constants/runtime-config';
import {
  createConfiguredSiteAdapterRepairModelProvider,
  getRepairStudioModelProviderConfigSummary,
  InMemoryRepairStudioModelCredentialStore,
  RepairModelProviderConfigError,
  saveRepairStudioModelProviderCredential,
} from './model-provider-config';

const configuredProvider: RepairStudioModelProviderConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.test/v1/',
  apiKey: 'repair-key',
  model: 'repair-model',
  timeoutMs: 5000,
};

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

describe('Repair Studio model provider config', () => {
  it('returns null until provider, baseUrl, apiKey, and model are configured', () => {
    expect(
      createConfiguredSiteAdapterRepairModelProvider({
        config: { ...configuredProvider, apiKey: '' },
        fetchImpl: vi.fn(),
      })
    ).toBeNull();
    expect(
      createConfiguredSiteAdapterRepairModelProvider({
        config: { ...configuredProvider, model: '' },
        fetchImpl: vi.fn(),
      })
    ).toBeNull();
    expect(
      createConfiguredSiteAdapterRepairModelProvider({
        config: { ...configuredProvider, provider: null },
        fetchImpl: vi.fn(),
      })
    ).toBeNull();
  });

  it('summarizes provider templates and credential-safe config status', () => {
    expect(
      getRepairStudioModelProviderConfigSummary({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: '',
        timeoutMs: 5000,
      })
    ).toMatchObject({
      configured: false,
      provider: 'openai',
      activeTemplateId: 'openai',
      baseUrlConfigured: true,
      apiKeyConfigured: false,
      modelConfigured: false,
      missingEnv: expect.arrayContaining([
        'TIANSHE_REPAIR_MODEL or TIANSHE_REPAIR_MODEL_NAME',
        'TIANSHE_REPAIR_MODEL_API_KEY or OPENAI_API_KEY',
      ]),
      templates: expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          label: 'OpenAI',
          defaultBaseUrl: 'https://api.openai.com/v1',
        }),
        expect.objectContaining({
          id: 'openrouter',
          provider: 'openai-compatible',
        }),
      ]),
    });

    const configured = getRepairStudioModelProviderConfigSummary(configuredProvider);

    expect(configured).toMatchObject({
      configured: true,
      apiKeyConfigured: true,
      modelConfigured: true,
      missingEnv: [],
    });
    expect(JSON.stringify(configured)).not.toContain('repair-key');
  });

  it('stores, rotates, and summarizes provider credentials without exposing key values', () => {
    const store = new InMemoryRepairStudioModelCredentialStore();
    const first = saveRepairStudioModelProviderCredential(
      {
        provider: 'openai',
        baseUrl: 'https://api.openai.test/v1',
        apiKey: 'stored-repair-key',
        model: 'stored-model',
        timeoutMs: 5000,
      },
      store,
      { now: () => new Date('2026-06-23T00:00:00.000Z') }
    );
    const second = saveRepairStudioModelProviderCredential(
      {
        provider: 'openai',
        baseUrl: 'https://api.openai.test/v1',
        apiKey: 'rotated-repair-key',
        model: 'stored-model',
        timeoutMs: 5000,
      },
      store,
      { now: () => new Date('2026-06-23T00:01:00.000Z') }
    );

    const summary = getRepairStudioModelProviderConfigSummary(
      { provider: null, baseUrl: '', apiKey: '', model: '', timeoutMs: 60000 },
      { credentialStore: store }
    );

    expect(first).toMatchObject({ keyVersion: 1, sealedApiKey: '[redacted]' });
    expect(second).toMatchObject({ keyVersion: 2, sealedApiKey: '[redacted]' });
    expect(summary).toMatchObject({
      configured: true,
      credentialSource: 'stored',
      apiKeyConfigured: true,
      storedCredential: {
        configured: true,
        keyVersion: 2,
        updatedAt: '2026-06-23T00:01:00.000Z',
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(/stored-repair-key|rotated-repair-key/);
  });

  it('calls an OpenAI-compatible provider and parses the generated repair diff', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n{"summary":"Repair price selector.","changes":[{"path":"src/site-adapters/books-to-scrape/extractors/product.ts","after":"export const selector = \\".price_color\\";"}]}\n```',
              },
            },
          ],
        }),
        { status: 200, statusText: 'OK' }
      )
    );
    const provider = createConfiguredSiteAdapterRepairModelProvider({
      config: configuredProvider,
      fetchImpl,
    });

    const diff = await provider?.generateRepairDiff({ kind: 'read-only', task });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(provider).toMatchObject({
      providerId: 'repair-studio:openai',
      model: 'repair-model',
    });
    expect(url).toBe('https://api.openai.test/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer repair-key',
      'Content-Type': 'application/json',
    });
    expect(body).toMatchObject({
      model: 'repair-model',
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    expect(body.messages[1].content).toContain('"allowedChangeGlobs"');
    expect(body.messages[1].content).not.toContain('repair-key');
    expect(diff).toEqual({
      summary: 'Repair price selector.',
      generatedBy: null,
      generatedAt: null,
      changes: [
        {
          path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
          before: undefined,
          after: 'export const selector = ".price_color";',
        },
      ],
    });
  });

  it('uses the stored provider credential when env config is incomplete', async () => {
    const store = new InMemoryRepairStudioModelCredentialStore();
    saveRepairStudioModelProviderCredential(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://stored.example.test/v1',
        apiKey: 'stored-provider-key',
        model: 'stored-provider-model',
        timeoutMs: 5000,
      },
      store
    );
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"summary":"Repair stored selector.","changes":[{"path":"src/site-adapters/books-to-scrape/extractors/product.ts","after":"export const selector = \\".price_color\\";"}]}',
              },
            },
          ],
        }),
        { status: 200, statusText: 'OK' }
      )
    );
    const provider = createConfiguredSiteAdapterRepairModelProvider({
      config: { provider: null, baseUrl: '', apiKey: '', model: '', timeoutMs: 60000 },
      credentialStore: store,
      fetchImpl,
    });

    await provider?.generateRepairDiff({ kind: 'read-only', task });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

    expect(provider).toMatchObject({
      providerId: 'repair-studio:openai-compatible',
      model: 'stored-provider-model',
    });
    expect(url).toBe('https://stored.example.test/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer stored-provider-key',
      'Content-Type': 'application/json',
    });
  });

  it('reports provider HTTP failures without exposing credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        [
          'bad request',
          'Authorization: Bearer provider-body-secret',
          'Set-Cookie: sid=provider-cookie-secret; Path=/',
          'token=provider-query-secret',
        ].join('\n'),
        { status: 400, statusText: 'Bad Request' }
      )
    );
    const provider = createConfiguredSiteAdapterRepairModelProvider({
      config: configuredProvider,
      fetchImpl,
    });

    let error: unknown;
    try {
      await provider?.generateRepairDiff({ kind: 'read-only', task });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RepairModelProviderConfigError);
    expect(String(error)).toContain('400 Bad Request');
    expect(String(error)).not.toContain('repair-key');
    expect(String(error)).not.toContain('provider-body-secret');
    expect(String(error)).not.toContain('provider-cookie-secret');
    expect(String(error)).not.toContain('provider-query-secret');
    expect(String(error)).toContain('[REDACTED]');
  });
});
