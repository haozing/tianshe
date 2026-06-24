import { createHash } from 'node:crypto';
import {
  assertSiteAdapterRepairPath,
  runReadOnlySiteAdapterFixture,
  runReadOnlySiteAdapterRuntimeCanary,
  type ReadOnlySiteAdapterRuntimeCanaryOptions,
  type SiteAdapterFixture,
  type SiteAdapterFixtureRunResult,
  type SiteAdapterModule,
  type SiteAdapterRepairEvidence,
  type SiteAdapterRepairScopeOptions,
} from '../site-adapter-runtime';

export interface SiteAdapterRepairTaskPayload {
  taskId: string;
  adapterId: string;
  fixtureName: string;
  sideEffectLevel: 'read-only';
  missingFields: string[];
  selectorDiagnostics: SiteAdapterRepairEvidence['selectorDiagnostics'];
  fixture: SiteAdapterRepairEvidence['fixture'];
  expected: Record<string, unknown>;
  before: Record<string, unknown>;
  allowedChangeGlobs: string[];
  forbiddenScopes: string[];
  prompt: {
    objective: string;
    constraints: string[];
  };
}

export interface SiteAdapterRepairChange {
  path: string;
  before?: string;
  after: string;
}

export interface SiteAdapterRepairApplyResult {
  dryRun: boolean;
  changedFiles: string[];
  diff: Array<{
    path: string;
    beforeHash: string | null;
    afterHash: string;
  }>;
}

export interface SiteAdapterRepairReviewRecord {
  repairId: string;
  adapterId: string;
  fixtureName: string;
  changedFiles: string[];
  fixturePassed: boolean;
  targetSmokePassed: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  publishAllowed: boolean;
}

export interface SiteAdapterRepairRegressionResult {
  fixtureResult: SiteAdapterFixtureRunResult;
  targetSmokeResult: SiteAdapterFixtureRunResult | null;
  targetSmokeRequired: boolean;
  reviewRecord: SiteAdapterRepairReviewRecord;
}

export interface SiteAdapterRepairHistoryRecord {
  repairId: string;
  adapterId: string;
  fixtureName: string;
  recordedAt: string;
  changedFiles: string[];
  diff: SiteAdapterRepairApplyResult['diff'];
  tests: {
    fixturePassed: boolean;
    targetSmokePassed: boolean;
    evidenceCommands: string[];
  };
  approvedBy: string | null;
  approvedAt: string | null;
  publishAllowed: boolean;
}

export interface SiteAdapterRepairHistoryStore {
  add(record: SiteAdapterRepairHistoryRecord): SiteAdapterRepairHistoryRecord;
  list(filter?: { adapterId?: string; fixtureName?: string }): SiteAdapterRepairHistoryRecord[];
  get(repairId: string): SiteAdapterRepairHistoryRecord | null;
}

export interface SiteAdapterRepairModelDiff {
  summary: string;
  generatedBy?: string | null;
  generatedAt?: string | null;
  changes: SiteAdapterRepairChange[];
}

export interface SiteAdapterRepairPublishRecord {
  repairId: string;
  adapterId: string;
  adapterVersion: string | null;
  fixtureName: string;
  modelDiffSummary: string;
  changedFiles: string[];
  fixturePassed: boolean;
  targetSmokePassed: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  publishAllowed: boolean;
  publishedAt: string | null;
  blockedReasons: string[];
  evidenceCommands: string[];
}

export interface SiteAdapterRepairWorkflowResult {
  task: SiteAdapterRepairTaskPayload;
  applyResult: SiteAdapterRepairApplyResult;
  regression: SiteAdapterRepairRegressionResult;
  historyRecord: SiteAdapterRepairHistoryRecord;
  publishRecord: SiteAdapterRepairPublishRecord;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createReadOnlyRepairTaskPayload(
  evidence: SiteAdapterRepairEvidence
): SiteAdapterRepairTaskPayload {
  const missingFields = evidence.selectorDiagnostics
    .filter((diagnostic) => !diagnostic.ok)
    .map((diagnostic) => diagnostic.path);
  const taskId = sha256(
    JSON.stringify({
      adapterId: evidence.adapterId,
      fixtureName: evidence.fixtureName,
      missingFields,
      before: evidence.before,
      expected: evidence.expected,
    })
  ).slice(0, 16);

  return {
    taskId,
    adapterId: evidence.adapterId,
    fixtureName: evidence.fixtureName,
    sideEffectLevel: 'read-only',
    missingFields,
    selectorDiagnostics: evidence.selectorDiagnostics,
    fixture: evidence.fixture,
    expected: evidence.expected,
    before: evidence.before,
    allowedChangeGlobs: [
      'site-adapters/<site-id>/extractors/**',
      'site-adapters/<site-id>/verifiers/**',
      'site-adapters/<site-id>/fixtures/**',
      'site-adapters/<site-id>/expected/**',
      'src/site-adapters/<site-id>/extractors/**',
      'src/site-adapters/<site-id>/verifiers/**',
      'src/site-adapters/<site-id>/fixtures/**',
      'src/site-adapters/<site-id>/expected/**',
    ],
    forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
    prompt: {
      objective:
        'Repair only the read-only site adapter so the fixture output matches expected fields.',
      constraints: [
        'Do not modify framework core, main process, schema authority, credentials, or secrets.',
        'Do not add Playwright, Electron, DuckDB, or Node runtime imports to adapter code.',
        'Run fixture regression and target runtime smoke before requesting approval.',
      ],
    },
  };
}

export async function applyReadOnlyRepairChanges(
  changes: SiteAdapterRepairChange[],
  options: SiteAdapterRepairScopeOptions & {
    dryRun?: boolean;
    writeFile?: (absolutePath: string, content: string) => Promise<void> | void;
  }
): Promise<SiteAdapterRepairApplyResult> {
  const dryRun = options.dryRun !== false;
  const changedFiles: string[] = [];
  const diff: SiteAdapterRepairApplyResult['diff'] = [];

  for (const change of changes) {
    const decision = assertSiteAdapterRepairPath(change.path, options);
    changedFiles.push(decision.relativePath);
    diff.push({
      path: decision.relativePath,
      beforeHash: change.before === undefined ? null : sha256(change.before),
      afterHash: sha256(change.after),
    });
    if (!dryRun) {
      if (!options.writeFile) {
        throw new Error('writeFile callback is required when dryRun=false');
      }
      await options.writeFile(decision.absolutePath, change.after);
    }
  }

  return {
    dryRun,
    changedFiles,
    diff,
  };
}

export function createRepairReviewRecord(input: {
  adapterId: string;
  fixtureName: string;
  changedFiles: string[];
  fixtureResult: Pick<SiteAdapterFixtureRunResult, 'ok'>;
  targetSmokePassed: boolean;
  approvedBy?: string | null;
  now?: () => Date;
}): SiteAdapterRepairReviewRecord {
  const approvedBy = input.approvedBy?.trim() || null;
  const fixturePassed = input.fixtureResult.ok === true;
  const targetSmokePassed = input.targetSmokePassed === true;
  const publishAllowed = Boolean(approvedBy && fixturePassed && targetSmokePassed);
  return {
    repairId: sha256(
      JSON.stringify({
        adapterId: input.adapterId,
        fixtureName: input.fixtureName,
        changedFiles: input.changedFiles,
      })
    ).slice(0, 16),
    adapterId: input.adapterId,
    fixtureName: input.fixtureName,
    changedFiles: [...input.changedFiles],
    fixturePassed,
    targetSmokePassed,
    approvedBy,
    approvedAt: publishAllowed ? (input.now?.() ?? new Date()).toISOString() : null,
    publishAllowed,
  };
}

export async function runReadOnlyRepairRegression(input: {
  adapter: SiteAdapterModule;
  fixture: SiteAdapterFixture;
  expected: Record<string, unknown>;
  changedFiles: string[];
  targetSmoke?: Pick<
    ReadOnlySiteAdapterRuntimeCanaryOptions,
    'browser' | 'snapshotOptions' | 'input'
  >;
  approvedBy?: string | null;
  now?: () => Date;
}): Promise<SiteAdapterRepairRegressionResult> {
  const fixtureResult = await runReadOnlySiteAdapterFixture(input.adapter, {
    ...input.fixture,
    expected: input.expected,
  });
  const targetSmokeResult = input.targetSmoke
    ? await runReadOnlySiteAdapterRuntimeCanary(input.adapter, {
        browser: input.targetSmoke.browser,
        fixtureName: input.fixture.name,
        expected: input.expected,
        input: input.targetSmoke.input ?? input.fixture.input,
        snapshotOptions: input.targetSmoke.snapshotOptions,
      })
    : null;
  const reviewRecord = createRepairReviewRecord({
    adapterId: input.adapter.manifest.id,
    fixtureName: input.fixture.name,
    changedFiles: input.changedFiles,
    fixtureResult,
    targetSmokePassed: targetSmokeResult?.ok === true,
    approvedBy: input.approvedBy,
    now: input.now,
  });

  return {
    fixtureResult,
    targetSmokeResult,
    targetSmokeRequired: true,
    reviewRecord,
  };
}

export function createRepairHistoryRecord(input: {
  reviewRecord: SiteAdapterRepairReviewRecord;
  applyResult: Pick<SiteAdapterRepairApplyResult, 'diff'>;
  evidenceCommands?: string[];
  recordedAt?: Date;
}): SiteAdapterRepairHistoryRecord {
  return {
    repairId: input.reviewRecord.repairId,
    adapterId: input.reviewRecord.adapterId,
    fixtureName: input.reviewRecord.fixtureName,
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
    changedFiles: [...input.reviewRecord.changedFiles],
    diff: input.applyResult.diff.map((item) => ({ ...item })),
    tests: {
      fixturePassed: input.reviewRecord.fixturePassed,
      targetSmokePassed: input.reviewRecord.targetSmokePassed,
      evidenceCommands: [...(input.evidenceCommands || [])],
    },
    approvedBy: input.reviewRecord.approvedBy,
    approvedAt: input.reviewRecord.approvedAt,
    publishAllowed: input.reviewRecord.publishAllowed,
  };
}

export function createRepairPublishRecord(input: {
  reviewRecord: SiteAdapterRepairReviewRecord;
  adapterVersion?: string | null;
  modelDiffSummary: string;
  evidenceCommands?: string[];
}): SiteAdapterRepairPublishRecord {
  const blockedReasons = [
    ...(input.reviewRecord.fixturePassed ? [] : ['fixture_regression_failed']),
    ...(input.reviewRecord.targetSmokePassed ? [] : ['target_runtime_canary_missing_or_failed']),
    ...(input.reviewRecord.approvedBy ? [] : ['human_review_missing']),
  ];
  return {
    repairId: input.reviewRecord.repairId,
    adapterId: input.reviewRecord.adapterId,
    adapterVersion: input.adapterVersion ?? null,
    fixtureName: input.reviewRecord.fixtureName,
    modelDiffSummary: input.modelDiffSummary,
    changedFiles: [...input.reviewRecord.changedFiles],
    fixturePassed: input.reviewRecord.fixturePassed,
    targetSmokePassed: input.reviewRecord.targetSmokePassed,
    approvedBy: input.reviewRecord.approvedBy,
    approvedAt: input.reviewRecord.approvedAt,
    publishAllowed: input.reviewRecord.publishAllowed,
    publishedAt: input.reviewRecord.publishAllowed ? input.reviewRecord.approvedAt : null,
    blockedReasons,
    evidenceCommands: [...(input.evidenceCommands || [])],
  };
}

export async function runReadOnlyRepairWorkflow(input: {
  evidence: SiteAdapterRepairEvidence;
  adapter: SiteAdapterModule;
  fixture: SiteAdapterFixture;
  expected: Record<string, unknown>;
  modelDiff: SiteAdapterRepairModelDiff;
  scope: SiteAdapterRepairScopeOptions;
  dryRun?: boolean;
  writeFile?: (absolutePath: string, content: string) => Promise<void> | void;
  targetSmoke?: Pick<
    ReadOnlySiteAdapterRuntimeCanaryOptions,
    'browser' | 'snapshotOptions' | 'input'
  >;
  approvedBy?: string | null;
  evidenceCommands?: string[];
  historyStore?: SiteAdapterRepairHistoryStore;
  now?: () => Date;
}): Promise<SiteAdapterRepairWorkflowResult> {
  const task = createReadOnlyRepairTaskPayload(input.evidence);
  const applyResult = await applyReadOnlyRepairChanges(input.modelDiff.changes, {
    ...input.scope,
    dryRun: input.dryRun,
    writeFile: input.writeFile,
  });
  const regression = await runReadOnlyRepairRegression({
    adapter: input.adapter,
    fixture: input.fixture,
    expected: input.expected,
    changedFiles: applyResult.changedFiles,
    ...(input.targetSmoke ? { targetSmoke: input.targetSmoke } : {}),
    approvedBy: input.approvedBy,
    now: input.now,
  });
  const historyRecord = createRepairHistoryRecord({
    reviewRecord: regression.reviewRecord,
    applyResult,
    evidenceCommands: input.evidenceCommands,
    recordedAt: input.now?.(),
  });
  const storedHistoryRecord = input.historyStore?.add(historyRecord) ?? historyRecord;
  const publishRecord = createRepairPublishRecord({
    reviewRecord: regression.reviewRecord,
    adapterVersion: input.adapter.manifest.version,
    modelDiffSummary: input.modelDiff.summary,
    evidenceCommands: input.evidenceCommands,
  });

  return {
    task,
    applyResult,
    regression,
    historyRecord: storedHistoryRecord,
    publishRecord,
  };
}

export class InMemoryRepairHistoryStore implements SiteAdapterRepairHistoryStore {
  private records = new Map<string, SiteAdapterRepairHistoryRecord>();

  add(record: SiteAdapterRepairHistoryRecord): SiteAdapterRepairHistoryRecord {
    const copy = {
      ...record,
      changedFiles: [...record.changedFiles],
      diff: record.diff.map((item) => ({ ...item })),
      tests: {
        ...record.tests,
        evidenceCommands: [...record.tests.evidenceCommands],
      },
    };
    this.records.set(copy.repairId, copy);
    return copy;
  }

  list(filter: { adapterId?: string; fixtureName?: string } = {}): SiteAdapterRepairHistoryRecord[] {
    return Array.from(this.records.values()).filter(
      (record) =>
        (!filter.adapterId || record.adapterId === filter.adapterId) &&
        (!filter.fixtureName || record.fixtureName === filter.fixtureName)
    );
  }

  get(repairId: string): SiteAdapterRepairHistoryRecord | null {
    return this.records.get(repairId) ?? null;
  }
}
