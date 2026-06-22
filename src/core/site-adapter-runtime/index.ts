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
export { createSiteAdapterFieldDiagnostics } from './diagnostics';
export { validateSiteAdapterManifest, validateSiteAdapterModule } from './manifest';
export {
  runReadOnlySiteAdapterFixture,
  runReadOnlySiteAdapterRuntimeCanary,
  type ReadOnlySiteAdapterFixtureRunOptions,
  type ReadOnlySiteAdapterRuntimeCanaryOptions,
} from './read-only-runner';
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
export { checkSiteAdapterImportBoundary } from './sandbox/import-boundary';
export type {
  SiteAdapterFieldDiagnostic,
  SiteAdapterFixture,
  SiteAdapterFixtureRunResult,
  SiteAdapterManifest,
  SiteAdapterModule,
  SiteAdapterSideEffectLevel,
} from './types';
