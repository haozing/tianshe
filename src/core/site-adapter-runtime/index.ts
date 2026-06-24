export {
  DEFAULT_SITE_ADAPTER_REPAIR_DENIED_ROOTS,
  DEFAULT_SITE_ADAPTER_REPAIR_ROOT_PATTERN,
  DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS,
  assertSiteAdapterRepairPath,
  evaluateSiteAdapterRepairPath,
  type SiteAdapterRepairScopeDecision,
  type SiteAdapterRepairScopeOptions,
  type SiteAdapterRepairScopeReason,
} from './repair/repair-scope';
export {
  buildSiteAdapterRepairEvidence,
  type SiteAdapterRepairEvidence,
  type SiteAdapterRepairEvidenceInput,
} from './repair/repair-evidence';
export {
  SITE_ADAPTER_REPAIR_BUNDLE_DATA_SCHEMA,
  assertSiteAdapterRepairBundleData,
} from './repair/repair-bundle-schema';
export {
  buildSiteAdapterProcedureRepairEvidence,
  createSiteAdapterProcedureRepairTaskPayload,
  type SiteAdapterProcedureRepairEvidence,
  type SiteAdapterProcedureRepairTaskPayload,
} from './repair/procedure-repair-evidence';
export { createSiteAdapterFieldDiagnostics } from './diagnostics';
export {
  SITE_ADAPTER_REQUIRED_QUALITY_FIELDS,
  validateSiteAdapterManifest,
  validateSiteAdapterModule,
} from './manifest';
export {
  runReadOnlySiteAdapterFixture,
  runReadOnlySiteAdapterRuntimeCanary,
  type ReadOnlySiteAdapterFixtureRunOptions,
  type ReadOnlySiteAdapterRuntimeCanaryOptions,
} from './read-only-runner';
export {
  DEFAULT_BROWSER_EVALUATE_SNAPSHOT_SCRIPT,
  SiteAdapterRunner,
  runSiteAdapter,
  type SiteAdapterBrowserEvaluateRunnerRequest,
  type SiteAdapterBrowserSnapshotRunnerRequest,
  type SiteAdapterFixtureRunnerRequest,
  type SiteAdapterProcedureRunnerRequest,
  type SiteAdapterReadRunnerRunResult,
  type SiteAdapterReadRunnerRunRequest,
  type SiteAdapterRunnerKind,
  type SiteAdapterRunnerRunRequest,
  type SiteAdapterRunnerRunResult,
} from './runner';
export {
  appendInteractorActionTrace,
  appendProcedureTransition,
  createSiteAdapterRunState,
  replaySiteAdapterTransitions,
  sanitizeSiteAdapterStatePayload,
  type InteractorActionTraceEntry,
  type ProcedureTransition,
  type ProcedureTransitionOutcome,
  type SiteAdapterRunPhase,
  type SiteAdapterRunState,
} from './state-machine';
export {
  createProcedureRepairGateRecord,
  createSiteAdapterProcedureResumePlan,
  runSiteAdapterProcedure,
  type SiteAdapterProcedureRepairGateRecord,
  type SiteAdapterProcedureDefinition,
  type SiteAdapterProcedureResumePlan,
  type SiteAdapterProcedureResumeReason,
  type SiteAdapterProcedureRunOptions,
  type SiteAdapterProcedureRunResult,
  type SiteAdapterProcedureSideEffectLevel,
  type SiteAdapterProcedureStep,
  type SiteAdapterProcedureVerifyStep,
} from './procedure';
export {
  SiteAdapterProcedureResumeFileStore,
  createSiteAdapterProcedureResumeKey,
  createSiteAdapterProcedureResumeRecord,
  type SiteAdapterProcedureResumeRecord,
  type SiteAdapterProcedureResumeRecordStatus,
  type SiteAdapterProcedureResumeStoreFilter,
} from './procedure-resume-store';
export {
  evaluateSiteLoginHealth,
  type SiteLoginHealthInput,
  type SiteLoginHealthReason,
  type SiteLoginHealthResult,
  type SiteLoginHealthState,
  type SiteLoginHealthStatus,
} from './login-health';
export { checkSiteAdapterImportBoundary } from './sandbox/import-boundary';
export type {
  SiteAdapterExtractor,
  SiteAdapterExtractorContext,
  SiteAdapterFieldDiagnostic,
  SiteAdapterFixture,
  SiteAdapterFixtureRunResult,
  SiteAdapterManifest,
  SiteAdapterModule,
  SiteAdapterSideEffectLevel,
  SiteAdapterVerifier,
  SiteAdapterVerifierContext,
  SiteAdapterVerifierResult,
} from './types';
