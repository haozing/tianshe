import {
  clearRepairStudioModelProviderCredential,
  createConfiguredSiteAdapterRepairModelProvider,
  getRepairStudioModelProviderConfigSummary,
  saveRepairStudioModelProviderCredential,
  type RepairStudioModelCredentialInput,
  type RepairStudioModelCredentialCodec,
  type RepairStudioModelCredentialStore,
  type RepairStudioModelProviderConfigSummary,
} from './model-provider-config';
import fs from 'node:fs/promises';
import {
  applyReadOnlyRepairChanges,
  createRepairHistoryRecord,
  createRepairPublishRecord,
  createRepairReviewRecord,
  generateSiteAdapterRepairModelDiff,
  type SiteAdapterRepairApplyResult,
  type SiteAdapterRepairHistoryRecord,
  type SiteAdapterRepairModelDiff,
  type SiteAdapterRepairModelGatewayResult,
  type SiteAdapterRepairModelTask,
  type SiteAdapterRepairModelProvider,
  type SiteAdapterRepairModelRequest,
  type SiteAdapterRepairPublishRecord,
  type SiteAdapterRepairReviewRecord,
} from '../../core/site-adapter-repair-studio';
import { createSiteAdapterRepairScopeOptionsFromManifest } from '../../core/site-adapter-runtime/repair/repair-scope';
import { createLogger } from '../../core/logger';
import { createIpcHandler } from '../ipc-handlers/utils';
import { officialSiteAdapters } from '../../site-adapters';

const logger = createLogger('SiteAdapterRepairStudioIPC');

export type SiteAdapterRepairStudioModelDiffInput = SiteAdapterRepairModelRequest;

export type SiteAdapterRepairStudioProviderConfigSummary =
  RepairStudioModelProviderConfigSummary;

export type SiteAdapterRepairStudioModelDiffResult =
  | {
      status: 'generated';
      result: SiteAdapterRepairModelGatewayResult;
    }
  | {
      status: 'environment_gap';
      message: string;
      remediation: string;
    };

export interface SiteAdapterRepairStudioReviewGates {
  fixtureRegression: boolean;
  targetCanary: boolean;
  humanReview: boolean;
}

export type SiteAdapterRepairStudioReviewApplyPublishInput = SiteAdapterRepairModelTask & {
  modelDiff: SiteAdapterRepairModelDiff;
  reviewGates: SiteAdapterRepairStudioReviewGates;
  approvedBy?: string | null;
  dryRun?: boolean;
};

export interface SiteAdapterRepairStudioReviewApplyPublishResult {
  status: 'blocked' | 'publish_ready' | 'applied';
  applyResult: SiteAdapterRepairApplyResult;
  reviewRecord: SiteAdapterRepairReviewRecord;
  historyRecord: SiteAdapterRepairHistoryRecord;
  publishRecord: SiteAdapterRepairPublishRecord;
}

export interface SiteAdapterRepairStudioHandlerOptions {
  modelProvider?: SiteAdapterRepairModelProvider;
  credentialStore?: RepairStudioModelCredentialStore;
  credentialCodec?: RepairStudioModelCredentialCodec;
  workspaceRoot?: string;
}

export type SiteAdapterRepairStudioSaveProviderCredentialInput =
  RepairStudioModelCredentialInput;

export async function generateRepairModelDiffFromInput(
  input: SiteAdapterRepairStudioModelDiffInput,
  options: SiteAdapterRepairStudioHandlerOptions = {}
): Promise<SiteAdapterRepairStudioModelDiffResult> {
  const modelProvider =
    options.modelProvider ||
    createConfiguredSiteAdapterRepairModelProvider({
      credentialStore: options.credentialStore,
      credentialCodec: options.credentialCodec,
    }) ||
    undefined;
  if (!modelProvider) {
    return {
      status: 'environment_gap',
      message: 'Repair Studio model provider is not configured.',
      remediation:
        'Configure a SiteAdapterRepairModelProvider before generating model diffs.',
    };
  }

  const result = await generateSiteAdapterRepairModelDiff({
    provider: modelProvider,
    request: input,
  });
  return {
    status: 'generated',
    result,
  };
}

function getTaskFixtureName(input: SiteAdapterRepairModelTask): string {
  return input.kind === 'read-only' ? input.task.fixtureName : input.task.procedureId;
}

function getAdapterVersion(adapterId: string): string | null {
  return officialSiteAdapters.find((adapter) => adapter.manifest.id === adapterId)
    ?.manifest.version ?? null;
}

function getRepairScopeForTask(
  input: SiteAdapterRepairModelTask,
  workspaceRoot: string
) {
  const adapter = officialSiteAdapters.find((item) => item.manifest.id === input.task.adapterId);
  if (!adapter) {
    throw new Error(`Unknown official site adapter: ${input.task.adapterId}`);
  }
  return createSiteAdapterRepairScopeOptionsFromManifest(adapter.manifest, workspaceRoot);
}

function getApprovedBy(input: SiteAdapterRepairStudioReviewApplyPublishInput): string | null {
  if (!input.reviewGates.humanReview) {
    return null;
  }
  return input.approvedBy?.trim() || 'renderer-review';
}

export async function reviewApplyPublishRepairFromInput(
  input: SiteAdapterRepairStudioReviewApplyPublishInput,
  options: SiteAdapterRepairStudioHandlerOptions = {}
): Promise<SiteAdapterRepairStudioReviewApplyPublishResult> {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const scope = getRepairScopeForTask(input, workspaceRoot);
  const willPublish =
    input.dryRun === false &&
    input.reviewGates.fixtureRegression &&
    input.reviewGates.targetCanary &&
    input.reviewGates.humanReview;
  const applyResult = await applyReadOnlyRepairChanges(input.modelDiff.changes, {
    ...scope,
    dryRun: !willPublish,
    writeFile: async (absolutePath, content) => {
      await fs.writeFile(absolutePath, content, 'utf8');
    },
  });
  const fixtureName = getTaskFixtureName(input);
  const reviewRecord = createRepairReviewRecord({
    adapterId: input.task.adapterId,
    fixtureName,
    changedFiles: applyResult.changedFiles,
    fixtureResult: { ok: input.reviewGates.fixtureRegression },
    targetSmokePassed: input.reviewGates.targetCanary,
    approvedBy: getApprovedBy(input),
  });
  const historyRecord = createRepairHistoryRecord({
    reviewRecord,
    applyResult,
    evidenceCommands: [
      'npm run test:site-adapter-canary -- --suite all',
      'npm run v4:release-gate',
    ],
  });
  const publishRecord = createRepairPublishRecord({
    reviewRecord,
    adapterVersion: getAdapterVersion(input.task.adapterId),
    modelDiffSummary: input.modelDiff.summary,
    evidenceCommands: historyRecord.tests.evidenceCommands,
  });
  const status = publishRecord.publishAllowed
    ? applyResult.dryRun
      ? 'publish_ready'
      : 'applied'
    : 'blocked';

  return {
    status,
    applyResult,
    reviewRecord,
    historyRecord,
    publishRecord,
  };
}

export function getRepairModelProviderConfigSummary(): SiteAdapterRepairStudioProviderConfigSummary {
  return getRepairStudioModelProviderConfigSummary();
}

export function getRepairModelProviderConfigSummaryFromOptions(
  options: SiteAdapterRepairStudioHandlerOptions = {}
): SiteAdapterRepairStudioProviderConfigSummary {
  return getRepairStudioModelProviderConfigSummary(undefined, {
    credentialStore: options.credentialStore,
    credentialCodec: options.credentialCodec,
  });
}

export function saveRepairModelProviderCredentialFromInput(
  input: SiteAdapterRepairStudioSaveProviderCredentialInput,
  options: SiteAdapterRepairStudioHandlerOptions = {}
): SiteAdapterRepairStudioProviderConfigSummary {
  if (!options.credentialStore) {
    throw new Error('Repair Studio credential store is not configured');
  }
  saveRepairStudioModelProviderCredential(input, options.credentialStore, {
    credentialCodec: options.credentialCodec,
  });
  return getRepairModelProviderConfigSummaryFromOptions(options);
}

export function clearRepairModelProviderCredentialFromInput(
  options: SiteAdapterRepairStudioHandlerOptions = {}
): SiteAdapterRepairStudioProviderConfigSummary {
  if (!options.credentialStore) {
    throw new Error('Repair Studio credential store is not configured');
  }
  clearRepairStudioModelProviderCredential(options.credentialStore);
  return getRepairModelProviderConfigSummaryFromOptions(options);
}

export function registerSiteAdapterRepairStudioHandlers(
  options: SiteAdapterRepairStudioHandlerOptions = {}
): void {
  createIpcHandler(
    'site-adapter-repair-studio:get-provider-config-summary',
    async () => getRepairModelProviderConfigSummaryFromOptions(options),
    {
      errorMessage: '读取 Site Adapter repair model provider 配置失败',
      permission: 'trusted-renderer',
    }
  );

  createIpcHandler(
    'site-adapter-repair-studio:generate-model-diff',
    async (input: SiteAdapterRepairStudioModelDiffInput) =>
      generateRepairModelDiffFromInput(input, options),
    { errorMessage: '生成 Site Adapter repair model diff 失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-repair-studio:review-apply-publish',
    async (input: SiteAdapterRepairStudioReviewApplyPublishInput) =>
      reviewApplyPublishRepairFromInput(input, options),
    { errorMessage: '执行 Site Adapter repair review/apply/publish 失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-repair-studio:save-provider-credential',
    async (input: SiteAdapterRepairStudioSaveProviderCredentialInput) =>
      saveRepairModelProviderCredentialFromInput(input, options),
    { errorMessage: '保存 Site Adapter repair model provider 密钥失败', permission: 'trusted-renderer' }
  );

  createIpcHandler(
    'site-adapter-repair-studio:clear-provider-credential',
    async () => clearRepairModelProviderCredentialFromInput(options),
    { errorMessage: '清除 Site Adapter repair model provider 密钥失败', permission: 'trusted-renderer' }
  );

  logger.info('Site Adapter Repair Studio handlers registered');
}
