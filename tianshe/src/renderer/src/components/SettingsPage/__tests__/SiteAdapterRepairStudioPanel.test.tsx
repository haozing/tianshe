import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { siteAdapterRepairStudioFacade } from '../../../services/siteAdapterRepairStudioFacade';
import { SiteAdapterRepairStudioPanel } from '../SiteAdapterRepairStudioPanel';
import type { SiteAdapterRepairStudioProviderConfigSummary } from '../../../../../main/site-adapter-repair-studio/routes-or-ipc';

vi.mock('../../../services/siteAdapterRepairStudioFacade', () => ({
  siteAdapterRepairStudioFacade: {
    getProviderConfigSummary: vi.fn(),
    generateModelDiff: vi.fn(),
    reviewApplyPublish: vi.fn(),
    saveProviderCredential: vi.fn(),
    clearProviderCredential: vi.fn(),
  },
}));

const getProviderConfigSummary = vi.mocked(siteAdapterRepairStudioFacade.getProviderConfigSummary);
const generateModelDiff = vi.mocked(siteAdapterRepairStudioFacade.generateModelDiff);
const reviewApplyPublish = vi.mocked(siteAdapterRepairStudioFacade.reviewApplyPublish);
const saveProviderCredential = vi.mocked(siteAdapterRepairStudioFacade.saveProviderCredential);
const clearProviderCredential = vi.mocked(siteAdapterRepairStudioFacade.clearProviderCredential);

const providerTemplates = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    env: {
      provider: 'TIANSHE_REPAIR_MODEL_PROVIDER',
      baseUrl: 'TIANSHE_REPAIR_MODEL_BASE_URL',
      apiKey: ['TIANSHE_REPAIR_MODEL_API_KEY', 'OPENAI_API_KEY'],
      model: ['TIANSHE_REPAIR_MODEL', 'TIANSHE_REPAIR_MODEL_NAME'],
      timeoutMs: 'TIANSHE_REPAIR_MODEL_TIMEOUT_MS',
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    env: {
      provider: 'TIANSHE_REPAIR_MODEL_PROVIDER',
      baseUrl: 'TIANSHE_REPAIR_MODEL_BASE_URL',
      apiKey: ['TIANSHE_REPAIR_MODEL_API_KEY'],
      model: ['TIANSHE_REPAIR_MODEL', 'TIANSHE_REPAIR_MODEL_NAME'],
      timeoutMs: 'TIANSHE_REPAIR_MODEL_TIMEOUT_MS',
    },
  },
];

const defaultProviderSummary: SiteAdapterRepairStudioProviderConfigSummary = {
  configured: false,
  provider: 'openai',
  activeTemplateId: 'openai',
  baseUrlConfigured: true,
  modelConfigured: false,
  apiKeyConfigured: false,
  credentialSource: 'missing',
  storedCredential: {
    configured: false,
    keyVersion: null,
    updatedAt: null,
  },
  timeoutMs: 60000,
  missingEnv: [
    'TIANSHE_REPAIR_MODEL or TIANSHE_REPAIR_MODEL_NAME',
    'TIANSHE_REPAIR_MODEL_API_KEY or OPENAI_API_KEY',
  ],
  templates: providerTemplates,
};

const configuredProviderSummary: SiteAdapterRepairStudioProviderConfigSummary = {
  ...defaultProviderSummary,
  configured: true,
  modelConfigured: true,
  apiKeyConfigured: true,
  credentialSource: 'stored',
  storedCredential: {
    configured: true,
    keyVersion: 1,
    updatedAt: '2026-06-23T00:00:00.000Z',
  },
  missingEnv: [],
};

describe('SiteAdapterRepairStudioPanel', () => {
  beforeEach(() => {
    getProviderConfigSummary.mockReset();
    getProviderConfigSummary.mockResolvedValue({
      success: true,
      data: defaultProviderSummary,
    });
    generateModelDiff.mockReset();
    reviewApplyPublish.mockReset();
    saveProviderCredential.mockReset();
    clearProviderCredential.mockReset();
  });

  it('renders provider templates and credential status without key values', async () => {
    render(<SiteAdapterRepairStudioPanel />);

    await waitFor(() => {
      expect(screen.getByText('模型 Provider')).toBeInTheDocument();
    });
    expect(screen.getByText('待配置')).toBeInTheDocument();
    expect(screen.getByText(/先配置模型 Provider/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /生成 diff/i })).toBeDisabled();
    expect(screen.getByText('TIANSHE_REPAIR_MODEL_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument();
    expect(screen.getAllByText('missing').length).toBeGreaterThan(0);
    expect(screen.queryByText(/repair-key|sk-/i)).not.toBeInTheDocument();
  });

  it('saves and rotates provider credentials without rendering key values', async () => {
    saveProviderCredential.mockResolvedValueOnce({
      success: true,
      data: {
        configured: true,
        provider: 'openai',
        activeTemplateId: 'openai',
        baseUrlConfigured: true,
        modelConfigured: true,
        apiKeyConfigured: true,
        credentialSource: 'stored',
        storedCredential: {
          configured: true,
          keyVersion: 1,
          updatedAt: '2026-06-23T00:00:00.000Z',
        },
        timeoutMs: 60000,
        missingEnv: [],
        templates: [
          {
            id: 'openai',
            label: 'OpenAI',
            provider: 'openai',
            defaultBaseUrl: 'https://api.openai.com/v1',
            requiresApiKey: true,
            env: {
              provider: 'TIANSHE_REPAIR_MODEL_PROVIDER',
              baseUrl: 'TIANSHE_REPAIR_MODEL_BASE_URL',
              apiKey: ['TIANSHE_REPAIR_MODEL_API_KEY', 'OPENAI_API_KEY'],
              model: ['TIANSHE_REPAIR_MODEL', 'TIANSHE_REPAIR_MODEL_NAME'],
              timeoutMs: 'TIANSHE_REPAIR_MODEL_TIMEOUT_MS',
            },
          },
        ],
      },
    });

    render(<SiteAdapterRepairStudioPanel />);

    await waitFor(() => {
      expect(screen.getByText('模型 Provider')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('Provider model'), {
      target: { value: 'repair-model' },
    });
    fireEvent.change(screen.getByLabelText('Provider API key'), {
      target: { value: 'repair-secret-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => {
      expect(screen.getByText('stored')).toBeInTheDocument();
    });
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(saveProviderCredential).toHaveBeenCalledWith({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'repair-model',
      apiKey: 'repair-secret-key',
      timeoutMs: 60000,
    });
    expect(screen.queryByDisplayValue('repair-secret-key')).not.toBeInTheDocument();
    expect(screen.queryByText('repair-secret-key')).not.toBeInTheDocument();
  });

  it('surfaces model provider environment gaps from the IPC facade after setup is ready', async () => {
    getProviderConfigSummary.mockResolvedValueOnce({
      success: true,
      data: configuredProviderSummary,
    });
    generateModelDiff.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'environment_gap',
        message: 'Repair Studio model provider is not configured.',
        remediation: 'Configure a SiteAdapterRepairModelProvider before generating model diffs.',
      },
    });

    render(<SiteAdapterRepairStudioPanel />);
    await waitFor(() => {
      expect(screen.getByText('已就绪')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /生成 diff/i }));

    await waitFor(() => {
      expect(
        screen.getByText('Repair Studio model provider is not configured.')
      ).toBeInTheDocument();
    });
    expect(generateModelDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'read-only',
        task: expect.objectContaining({
          adapterId: 'books-to-scrape',
          allowedChangeGlobs: expect.arrayContaining(['src/site-adapters/<site-id>/extractors/**']),
        }),
      })
    );
  });

  it('renders generated provider metadata and scoped diff changes', async () => {
    getProviderConfigSummary.mockResolvedValueOnce({
      success: true,
      data: configuredProviderSummary,
    });
    generateModelDiff.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'generated',
        result: {
          taskKind: 'procedure',
          taskId: 'github-profile:open-profile-settings:open-profile-settings:low',
          providerId: 'test-provider',
          model: 'repair-procedure-model',
          requestedAt: '2026-06-23T00:00:00.000Z',
          completedAt: '2026-06-23T00:00:00.050Z',
          latencyMs: 50,
          modelDiff: {
            summary: 'Update profile settings verification text.',
            generatedBy: 'test-provider:repair-procedure-model',
            generatedAt: '2026-06-23T00:00:00.050Z',
            changes: [
              {
                path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
                after: 'export const selector = "Public profile";',
              },
            ],
          },
        },
      },
    });
    reviewApplyPublish.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'publish_ready',
        applyResult: {
          dryRun: true,
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          diff: [
            {
              path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
              beforeHash: null,
              afterHash: 'after-hash',
            },
          ],
        },
        reviewRecord: {
          repairId: 'repair-id',
          adapterId: 'github-profile',
          fixtureName: 'open-profile-settings',
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          fixturePassed: true,
          targetSmokePassed: true,
          approvedBy: 'renderer-review',
          approvedAt: '2026-06-23T00:00:00.000Z',
          publishAllowed: true,
        },
        historyRecord: {
          repairId: 'repair-id',
          adapterId: 'github-profile',
          fixtureName: 'open-profile-settings',
          recordedAt: '2026-06-23T00:00:00.000Z',
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          diff: [
            {
              path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
              beforeHash: null,
              afterHash: 'after-hash',
            },
          ],
          tests: {
            fixturePassed: true,
            targetSmokePassed: true,
            evidenceCommands: ['npm run test:site-adapter-canary -- --suite all'],
          },
          approvedBy: 'renderer-review',
          approvedAt: '2026-06-23T00:00:00.000Z',
          publishAllowed: true,
        },
        publishRecord: {
          repairId: 'repair-id',
          adapterId: 'github-profile',
          adapterVersion: '1.0.0',
          fixtureName: 'open-profile-settings',
          modelDiffSummary: 'Update profile settings verification text.',
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          fixturePassed: true,
          targetSmokePassed: true,
          approvedBy: 'renderer-review',
          approvedAt: '2026-06-23T00:00:00.000Z',
          publishAllowed: true,
          publishedAt: '2026-06-23T00:00:00.000Z',
          blockedReasons: [],
          evidenceCommands: ['npm run test:site-adapter-canary -- --suite all'],
        },
      },
    });

    render(<SiteAdapterRepairStudioPanel />);
    await waitFor(() => {
      expect(screen.getByText('模型 Provider')).toBeInTheDocument();
    });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'procedure' } });
    fireEvent.click(screen.getByRole('button', { name: /生成 diff/i }));

    await waitFor(() => {
      expect(screen.getByText('Update profile settings verification text.')).toBeInTheDocument();
    });
    expect(screen.getByText('test-provider')).toBeInTheDocument();
    expect(screen.getByText('repair-procedure-model')).toBeInTheDocument();
    expect(
      screen.getAllByText('src/site-adapters/github-profile/procedures/open-profile-settings.ts')
        .length
    ).toBeGreaterThan(0);
    expect(screen.getByText('发布门禁')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Fixture regression'));
    fireEvent.click(screen.getByLabelText('Target canary'));
    fireEvent.click(screen.getByLabelText('Human review'));

    expect(screen.getByText('publish ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /review preview/i }));

    await waitFor(() => {
      expect(screen.getByText('publish_ready')).toBeInTheDocument();
    });
    expect(screen.getByText('dry run')).toBeInTheDocument();
    expect(screen.getByText('allowed')).toBeInTheDocument();
    expect(reviewApplyPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'procedure',
        modelDiff: expect.objectContaining({
          summary: 'Update profile settings verification text.',
        }),
        reviewGates: {
          fixtureRegression: true,
          targetCanary: true,
          humanReview: true,
        },
        approvedBy: 'renderer-review',
        dryRun: true,
      })
    );

    reviewApplyPublish.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'applied',
        applyResult: {
          dryRun: false,
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          diff: [
            {
              path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
              beforeHash: null,
              afterHash: 'after-hash',
            },
          ],
        },
        reviewRecord: {
          repairId: 'repair-id',
          adapterId: 'github-profile',
          fixtureName: 'open-profile-settings',
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          fixturePassed: true,
          targetSmokePassed: true,
          approvedBy: 'renderer-review',
          approvedAt: '2026-06-23T00:00:00.000Z',
          publishAllowed: true,
        },
        historyRecord: {
          repairId: 'repair-id',
          adapterId: 'github-profile',
          fixtureName: 'open-profile-settings',
          recordedAt: '2026-06-23T00:00:00.000Z',
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          diff: [
            {
              path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
              beforeHash: null,
              afterHash: 'after-hash',
            },
          ],
          tests: {
            fixturePassed: true,
            targetSmokePassed: true,
            evidenceCommands: ['npm run test:site-adapter-canary -- --suite all'],
          },
          approvedBy: 'renderer-review',
          approvedAt: '2026-06-23T00:00:00.000Z',
          publishAllowed: true,
        },
        publishRecord: {
          repairId: 'repair-id',
          adapterId: 'github-profile',
          adapterVersion: '1.0.0',
          fixtureName: 'open-profile-settings',
          modelDiffSummary: 'Update profile settings verification text.',
          changedFiles: ['src/site-adapters/github-profile/procedures/open-profile-settings.ts'],
          fixturePassed: true,
          targetSmokePassed: true,
          approvedBy: 'renderer-review',
          approvedAt: '2026-06-23T00:00:00.000Z',
          publishAllowed: true,
          publishedAt: '2026-06-23T00:00:00.000Z',
          blockedReasons: [],
          evidenceCommands: ['npm run test:site-adapter-canary -- --suite all'],
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /apply & publish/i }));

    await waitFor(() => {
      expect(screen.getByText('applied')).toBeInTheDocument();
    });
    expect(screen.getByText('written')).toBeInTheDocument();
    expect(reviewApplyPublish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'procedure',
        reviewGates: {
          fixtureRegression: true,
          targetCanary: true,
          humanReview: true,
        },
        approvedBy: 'renderer-review',
        dryRun: false,
      })
    );
  });
});
