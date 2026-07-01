import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteAdapterLabPanel } from '../SiteAdapterLabPanel';
import { siteAdapterRepairStudioFacade } from '../../../services/siteAdapterRepairStudioFacade';

vi.mock('../../../services/siteAdapterRepairStudioFacade', () => ({
  siteAdapterRepairStudioFacade: {
    generateModelDiff: vi.fn(),
  },
}));

const originalElectronAPI = window.electronAPI;

function installElectronApiMock() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      siteAdapterLab: {
        listAdapters: vi.fn().mockResolvedValue({
          success: true,
          data: {
            adapters: [
              {
                manifest: {
                  id: 'books-to-scrape',
                  fixtures: ['product-page'],
                  expected: ['product-page'],
                },
              },
            ],
            providerErrors: [],
            generation: 1,
          },
        }),
        loadFixture: vi.fn().mockResolvedValue({
          success: true,
          data: {
            fixture: {
              name: 'product-page',
              input: {},
              snapshot: {
                url: 'https://books.toscrape.com/catalogue/book_1/index.html',
              },
            },
            expected: { price: '$51.77' },
          },
        }),
        validateSelector: vi.fn(),
        runFixture: vi.fn(),
        saveExpected: vi.fn(),
        captureFixture: vi.fn(),
      },
      observation: {
        getTraceSummary: vi.fn().mockResolvedValue({
          success: true,
          data: {
            traceId: 'trace-lab',
            finalStatus: 'failed',
            entities: {},
            recentArtifacts: [],
          },
        }),
        getTraceTimeline: vi.fn().mockResolvedValue({
          success: true,
          data: {
            traceId: 'trace-lab',
            finalStatus: 'failed',
            events: [],
          },
        }),
        getFailureBundle: vi.fn().mockResolvedValue({
          success: true,
          data: {
            traceId: 'trace-lab',
            recentEvents: [],
            artifactRefs: [],
            siteAdapterRepairBundle: {
              artifactId: 'artifact-repair',
              traceId: 'trace-lab',
              timestamp: 1,
              type: 'site_adapter_repair_bundle',
              component: 'site-capability',
              data: {
                adapterId: 'books-to-scrape',
                fixtureName: 'product-page',
                sideEffectLevel: 'read-only',
                repairEvidence: {
                  adapterId: 'books-to-scrape',
                  fixtureName: 'product-page',
                  selectorDiagnostics: [
                    {
                      path: 'price',
                      ok: false,
                      expected: '$51.77',
                      actual: '',
                    },
                  ],
                  fieldDiagnostics: [
                    {
                      path: 'price',
                      ok: false,
                      expected: '$51.77',
                      actual: '',
                    },
                  ],
                  fixture: {
                    name: 'product-page',
                    input: {},
                    snapshot: {
                      url: 'https://books.toscrape.com/catalogue/book_1/index.html',
                    },
                  },
                  expected: { price: '$51.77' },
                  before: { price: '' },
                  after: null,
                  changedFiles: [],
                  repairScopeDecisions: [],
                },
                diagnostics: [
                  {
                    path: 'price',
                    ok: false,
                    expected: '$51.77',
                    actual: '',
                  },
                ],
                verifierResults: [],
                actionTrace: [],
                transitions: [],
              },
            },
          },
        }),
      },
    },
  });
}

describe('SiteAdapterLabPanel Repair Studio handoff', () => {
  beforeEach(() => {
    installElectronApiMock();
    vi.mocked(siteAdapterRepairStudioFacade.generateModelDiff).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: originalElectronAPI,
    });
  });

  it('generates a scoped Repair Studio model diff from a loaded repair bundle', async () => {
    vi.mocked(siteAdapterRepairStudioFacade.generateModelDiff).mockResolvedValue({
      success: true,
      data: {
        status: 'generated',
        result: {
          taskKind: 'read-only',
          taskId: 'lab-repair:trace-lab:books-to-scrape:product-page',
          providerId: 'repair-studio:openai',
          model: 'repair-model',
          requestedAt: '2026-06-23T00:00:00.000Z',
          completedAt: '2026-06-23T00:00:00.010Z',
          latencyMs: 10,
          modelDiff: {
            summary: 'Repair price selector.',
            generatedBy: 'repair-studio:openai',
            generatedAt: '2026-06-23T00:00:00.010Z',
            changes: [
              {
                path: 'src/site-adapters/books-to-scrape/extractors/product.ts',
                after: 'export const priceSelector = ".price_color";',
              },
            ],
          },
        },
      },
    });

    render(<SiteAdapterLabPanel />);

    await screen.findByDisplayValue(/\$51\.77/);
    fireEvent.change(screen.getByPlaceholderText('traceId'), {
      target: { value: 'trace-lab' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText('Repair suggestions');

    fireEvent.click(screen.getByRole('button', { name: 'Generate diff' }));

    await waitFor(() => {
      expect(siteAdapterRepairStudioFacade.generateModelDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'read-only',
          task: expect.objectContaining({
            taskId: 'lab-repair:trace-lab:books-to-scrape:product-page',
            adapterId: 'books-to-scrape',
            fixtureName: 'product-page',
            missingFields: ['price'],
            allowedChangeGlobs: expect.arrayContaining([
              'src/site-adapters/<site-id>/extractors/**',
            ]),
          }),
        })
      );
    });
    expect(await screen.findByText('Repair price selector.')).toBeInTheDocument();
    expect(screen.getByText('src/site-adapters/books-to-scrape/extractors/product.ts')).toBeInTheDocument();
  });
});
