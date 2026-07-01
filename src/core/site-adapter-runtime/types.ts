export type SiteAdapterSideEffectLevel = 'read-only' | 'low' | 'high';

export type SiteAdapterSupportedRunner =
  | 'fixture'
  | 'browser-snapshot'
  | 'browser-evaluate'
  | 'procedure'
  | 'playwright-lab';

export type SiteAdapterRiskLevel = 'low' | 'medium' | 'high';

export type SiteAdapterProcedureSideEffectLevel = 'low' | 'high';

export interface SiteAdapterRepairScopeManifest {
  roots?: string[];
  allowedSubpaths?: string[];
  forbiddenFiles?: string[];
}

export interface SiteAdapterManifest {
  id: string;
  name: string;
  version: string;
  site: string;
  siteId?: string;
  sideEffectLevel: SiteAdapterSideEffectLevel;
  capabilities?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredScopes?: string[];
  supportedRunners?: SiteAdapterSupportedRunner[];
  repairScope?: SiteAdapterRepairScopeManifest;
  fixtures?: string[];
  expected?: string[];
  riskLevel?: SiteAdapterRiskLevel;
  extractors: Array<{
    id: string;
    outputFields: string[];
  }>;
  verifiers?: Array<{
    id: string;
    description?: string;
  }>;
  procedures?: Array<{
    id: string;
    description?: string;
    sideEffectLevel: SiteAdapterProcedureSideEffectLevel;
    requiredScopes?: string[];
    verification?: string;
  }>;
}

export interface SiteAdapterFixture {
  name: string;
  snapshot: unknown;
  input?: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface SiteAdapterExtractorContext {
  fixtureName: string;
  snapshot: unknown;
  input: Record<string, unknown>;
}

export interface SiteAdapterExtractor {
  id: string;
  extract(context: SiteAdapterExtractorContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface SiteAdapterVerifierContext {
  fixtureName: string;
  result: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface SiteAdapterVerifierResult {
  ok: boolean;
  diagnostics?: SiteAdapterFieldDiagnostic[];
  message?: string;
}

export interface SiteAdapterVerifier {
  id: string;
  verify(context: SiteAdapterVerifierContext): Promise<SiteAdapterVerifierResult> | SiteAdapterVerifierResult;
}

export interface SiteAdapterModule {
  manifest: SiteAdapterManifest;
  extractors: SiteAdapterExtractor[];
  verifiers?: SiteAdapterVerifier[];
  procedures?: Array<{
    id: string;
    adapterId: string;
    sideEffectLevel: SiteAdapterProcedureSideEffectLevel;
    steps: unknown[];
  }>;
}

export interface SiteAdapterFieldDiagnostic {
  path: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

export interface SiteAdapterFixtureRunResult {
  adapterId: string;
  fixtureName: string;
  ok: boolean;
  result: Record<string, unknown>;
  diagnostics: SiteAdapterFieldDiagnostic[];
  verifierResults: SiteAdapterVerifierResult[];
  artifactRefs: string[];
}

export type SiteAdapterRegistrationSource = 'built-in' | 'plugin';

export interface RegisteredSiteAdapter {
  module: SiteAdapterModule;
  source: SiteAdapterRegistrationSource;
  pluginId?: string;
  packageRoot: string;
  trusted: boolean;
  generation: number;
}
